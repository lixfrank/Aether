# Layer 0: Core Security Enhancement

> 基线版本: v0.6.0 (commit c79260d6a)
> 本文档是 5 层重构计划的第一层。必须在 Layer 1-4 之前完成。
> 完成后，所有用户（包括不使用 research agent 的用户）获得子代理权限安全修复。

---

## 上下文

| Layer       | 状态            | 简介                                                                                                       |
| ----------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Layer 0** | **本文档**      | 核心安全增强：Permission.intersection、Discipline.compile、task 参数扩展、Agent.Info 扩展、skill_refs 注入 |
| Layer 1     | 在 Layer 0 之后 | Agent 基础设施：mode-switch、fallback_models、prompt 模式切换、background 执行、category routing           |
| Layer 2     | 在 Layer 1 之后 | Research 配置层：agent md 定义、skill md 定义（零核心源文件改动）                                          |
| Layer 3     | 在 Layer 2 之后 | Research 基础设施：MCP 服务器（convention lock、verification、errors）、参考文档                           |
| Layer 4     | 在 Layer 3 之后 | Publication 管线：write-paper、peer-review、respond-to-referees（完全独立）                                |

---

## 设计原则

- **增量添加**：在已有文件中只添加新函数/新字段，不改已有函数的行为
- **零副作用**：不使用新功能时，行为与 v0.6.0 完全一致
- **deny-before-allow**：Permission Ruleset 中 deny 规则排在 allow 规则之前（`findLast` 最后匹配胜，allow 覆盖 blanket deny）

---

## 改动 0.1: Permission.intersection()

### 问题

v0.6.0 的 `Permission.merge()` = `rulesets.flat()` — 子代理的 allow 规则可以覆盖父代理的 deny 规则，这是一个**安全漏洞**。

### 文件

`packages/opencode/src/permission/index.ts`（增量添加，不修改 `merge()`、`evaluate()`、`fromConfig()`、`disabled()`）

### 新增代码

```ts
export function intersection(parent: Ruleset, child: Ruleset, override?: Ruleset): Ruleset {
  const childEffective = merge(child, override ?? [])
  const result: Ruleset = []
  for (const rule of childEffective) {
    const parentRule = evaluate(rule.permission, rule.pattern, parent)
    if (parentRule.action === "deny") {
      result.push({ permission: rule.permission, pattern: rule.pattern, action: "deny" })
    } else if (rule.action === "deny") {
      result.push(rule)
    } else if (rule.action === "allow" && parentRule.action === "allow") {
      result.push(rule)
    } else if (rule.action === "ask" && parentRule.action === "allow") {
      result.push(rule)
    } else {
      result.push({ permission: rule.permission, pattern: rule.pattern, action: parentRule.action })
    }
  }
  for (const parentRule of parent) {
    const alreadyCovered = result.some(
      (r) => Wildcard.match(r.permission, parentRule.permission) && Wildcard.match(r.pattern, parentRule.pattern),
    )
    if (!alreadyCovered && parentRule.action === "deny") {
      result.push(parentRule)
    }
  }
  return result
}
```

### 使用点

仅在 `tool/task.ts` 子代理 session 创建中使用 `intersection`，**不改变** `agent.ts` 中 build/plan/general/explore 的 `merge` 逻辑。

### 验收测试

```
T0.1: intersection(parent=[{edit,"*",deny}], child=[{edit,"src/**",allow}]) → [{edit,"*",deny}]
T0.2: intersection(parent=[{edit,"*",allow}], child=[{edit,"secret/**",deny}]) → [{edit,"secret/**",deny}]
T0.3: intersection(parent=[{bash,"*",allow}], child=[{bash,"alpha*",allow},{bash,"*",deny}], override=[]) → bash 只有 alpha* allow + blanket deny
T0.4: 不使用 intersection 时，所有已有 Permission 路径（merge、evaluate、ask）行为不变
T0.5: bun typecheck 在 packages/opencode 通过
```

---

## 改动 0.2: Discipline.compile()

### 问题

需要将任务级约束快捷方式（permission_override、env_scope.allowed_commands、file_scope、delegation_depth）编译为 Permission Ruleset，以便 `intersection()` 消费。v0.6.0 没有任何约束快捷方式机制。

### 文件

`packages/opencode/src/session/discipline.ts`（**新增**独立模块）

### 关键设计

编译产物是普通 `Permission.Ruleset`，不引入新的运行时路径。**deny-before-allow 顺序**：deny 规则排在 allow 规则之前，保证 `findLast` 语义下特定 allow 覆盖 blanket deny。

### 代码

```ts
import { Permission } from "@/permission"
import z from "zod"
import { Wildcard } from "@/util/wildcard"

export namespace Discipline {
  export const Schema = z.object({
    permission_override: z.record(z.string(), z.string().array().optional()).optional(),
    env_scope: z
      .object({
        allowed_commands: z.string().array().optional(),
      })
      .optional(),
    file_scope: z.string().array().optional(),
    delegation_depth: z.number().int().min(0).max(3).default(0),
    max_steps: z.number().int().min(1).max(50).optional(),
    timeout_seconds: z.number().int().min(30).max(600).default(300),
    return_format: z.enum(["text", "structured", "raw"]).default("text"),
  })

  export function compile(d: z.infer<typeof Schema>): Permission.Ruleset {
    const rules: Permission.Ruleset = []

    if (d.permission_override) {
      for (const [perm, actions] of Object.entries(d.permission_override)) {
        if (!actions) continue
        for (const action of actions) {
          if (action === "allow" || action === "deny" || action === "ask") {
            rules.push({ permission: perm, pattern: "*", action })
          } else {
            rules.push({ permission: perm, pattern: action, action: "allow" })
          }
        }
      }
    }

    if (d.env_scope?.allowed_commands) {
      // deny-before-allow: blanket deny first, specific allows after
      rules.push({ permission: "bash", pattern: "*", action: "deny" })
      for (const cmd of d.env_scope.allowed_commands) {
        rules.push({ permission: "bash", pattern: cmd + "*", action: "allow" })
      }
    }

    if (d.file_scope) {
      const FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]
      // deny-before-allow: blanket deny first, scope-specific allows after
      for (const tool of FILE_TOOLS) {
        rules.push({ permission: tool, pattern: "*", action: "deny" })
      }
      for (const scopePattern of d.file_scope) {
        for (const tool of FILE_TOOLS) {
          rules.push({ permission: tool, pattern: scopePattern, action: "allow" })
        }
      }
    }

    if (d.delegation_depth === 0) {
      rules.push({ permission: "task", pattern: "*", action: "deny" })
    }

    return rules
  }
}
```

### Agent 级 env_scope

当 agent md 文件中声明 `env_scope.allowed_commands`（如 research agent 的 bash 限制），这部分在 `agent.ts` 的 merge 循环中通过 `Discipline.compile()` 编译为 Ruleset 并合并到 agent.permission 中。

```ts
// agent.ts merge 循环中新增（在 value.permission 处理之后）
if (value.env_scope?.allowed_commands) {
  const envRules = Discipline.compile({ env_scope: value.env_scope })
  item.permission = Permission.merge(item.permission, envRules)
}
```

### 验收测试

```
T0.6: compile({env_scope:{allowed_commands:["alpha","docker"]}}) 生成 [{bash,"*",deny}, {bash,"alpha*",allow}, {bash,"docker*",allow}]
T0.7: compile({file_scope:["src/**","test/**"]}) 生成 每个 FILE_TOOL 一条 blanket deny + 每个 scope 一条 allow
T0.8: compile({delegation_depth:0}) 包含 [{task,"*",deny}]
T0.9: compile({permission_override:{edit:["allow"],bash:["allow","docker*"]}}) 生成正确的 allow/pattern 规则
T0.10: deny-before-allow 顺序：Permission.evaluate("bash","alpha run...", ruleset) = allow；Permission.evaluate("bash","rm -rf...", ruleset) = deny
T0.11: bun typecheck 通过
```

---

## 改动 0.3: Task Tool 参数扩展

### 问题

v0.6.0 的 task.ts 只有 5 个参数（description, prompt, subagent_type, task_id, command），无法控制子代理的权限、行为边界、执行模式。

### 文件

`packages/opencode/src/tool/task.ts`（在已有 parameters 上添加 optional 字段 + 在 execute 中增量处理）

### 新增参数

```ts
const parameters = z.object({
  // v0.6.0 已有（保持不变）
  description: z.string(),
  prompt: z.string(),
  subagent_type: z.string(),
  task_id: z.string().optional(),
  command: z.string().optional(),
  // 新增（全部 optional，默认值 = v0.6.0 行为）
  mode: z.enum(["serial", "concurrent", "background"]).default("serial").optional(),
  permission_override: z.record(z.string(), z.string().array().optional()).optional(),
  file_scope: z.string().array().optional(),
  delegation_depth: z.number().int().min(0).max(3).default(0).optional(),
  max_steps: z.number().int().min(1).max(50).optional(),
  timeout_seconds: z.number().int().min(30).max(600).default(300).optional(),
  category: z.string().optional(),
})
```

### execute 中权限计算改为

```ts
const discipline = {
  mode: params.mode ?? "serial",
  permission_override: params.permission_override,
  env_scope: undefined, // env_scope comes from agent config, not task params
  file_scope: params.file_scope,
  delegation_depth: params.delegation_depth ?? 0,
  max_steps: params.max_steps,
  timeout_seconds: params.timeout_seconds ?? 300,
}
const disciplineRules = Discipline.compile(discipline)
const effectivePermission = Permission.intersection(caller.permission, agent.permission, disciplineRules)
```

### Category routing

`category` 参数用于语义化模型路由。在 `config.ts` 中添加顶层 `category` 字段:

```ts
category: z.record(
  z.string(),
  z.object({
    model: z.string().optional(),
    variant: z.string().optional(),
    temperature: z.number().optional(),
    description: z.string().optional(),
  }),
).optional()
```

在 `task.ts` execute 中:

```ts
const cfg = await Config.get()
const categoryConfig = params.category ? cfg.category?.[params.category] : undefined
const categoryModel = categoryConfig?.model ? Provider.parseModel(categoryConfig.model) : undefined
const model = categoryModel ?? agent.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }
```

### 验收测试

```
T0.12: 不传任何新参数时，task tool 行为与 v0.6.0 一致（除了权限用 intersection 替代 merge 的安全修复）
T0.13: 传 permission_override: {bash:["allow","docker*"]} 时，子代理只有 docker* bash 权限
T0.14: 传 delegation_depth:0 时，子代理的 task 工具被 deny
T0.15: 传 file_scope:["src/**"] 时，子代理的文件操作工具被限制在 src/** 范围
T0.16: 传 category:"quick" 且 config.category.quick.model 设为 claude-haiku-4-5 时，子代理使用指定模型
T0.17: bun typecheck 通过
```

---

## 改动 0.4: Agent.Info 扩展字段

### 问题

v0.6.0 的 Agent.Info 缺少 base_agent（继承）、skill_refs（技能白名单）、env_scope（环境隔离）、scale_decision（规模决策）等字段。

### 文件

`packages/opencode/src/agent/agent.ts`（在 Info schema 末尾添加 optional 字段 + 在 state merge 循环中增量处理）

### 新增字段

```ts
// Info schema 末尾添加
baseAgent: z.string().optional(),
skillRefs: z.array(z.string()).optional(),
delegationDepth: z.number().int().min(0).optional(),
fileScope: z.string().array().optional(),
maxSteps: z.number().int().positive().optional(),
fallbackModels: z.array(z.union([z.string(), z.object({
  model: z.string(),
  variant: z.string().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
})])).optional(),
envScope: z.object({
  allowed_commands: z.string().array().optional(),
}).optional(),
scaleDecision: z.object({
  direct_threshold: z.number().default(10),
  never_spawn_for: z.string().array().default([]),
  rules: z.array(z.object({
    condition: z.string(),
    subagent_count: z.number(),
    subagent_type: z.string(),
    mode: z.enum(["serial", "concurrent", "background"]),
  })).default([]),
}).optional(),
```

### Config.Agent 对应字段

在 `config.ts` 的 Agent schema 中添加:

```ts
base_agent: z.string().optional(),
skill_refs: z.array(z.string()).optional(),
delegation_depth: z.number().int().min(0).max(3).default(0).optional(),
file_scope: z.string().array().optional(),
max_steps: z.number().int().positive().optional(),
fallback_models: z.array(z.union([z.string(), z.object({...})])).optional(),
env_scope: z.object({ allowed_commands: z.string().array().optional() }).optional(),
scale_decision: z.object({ ... }).optional(),
```

### Merge 循环新增处理

```ts
// base_agent inheritance
if (value.base_agent && agents[value.base_agent]) {
  const base = agents[value.base_agent]
  if (!value.model && !item.model) item.model = base.model
  if (item.temperature === undefined && base.temperature !== undefined) item.temperature = base.temperature
  if (item.topP === undefined && base.topP !== undefined) item.topP = base.topP
  if (!value.permission && !item.permission) item.permission = base.permission
  if (item.steps === undefined && base.steps !== undefined) item.steps = base.steps
  if (!value.prompt && !item.prompt && base.prompt) item.prompt = base.prompt
  if (item.color === undefined && base.color !== undefined) item.color = base.color
}
// scalar fields
item.skillRefs = value.skill_refs ?? item.skillRefs
item.delegationDepth = value.delegation_depth ?? item.delegationDepth ?? 0
item.fileScope = value.file_scope ?? item.fileScope
item.maxSteps = value.max_steps ?? item.maxSteps ?? item.steps
item.fallbackModels = value.fallback_models ?? item.fallbackModels
item.envScope = value.env_scope ?? item.envScope
item.scaleDecision = value.scale_decision ?? item.scaleDecision
// env_scope compilation into permission
if (value.env_scope?.allowed_commands) {
  const envRules = Discipline.compile({ env_scope: value.env_scope })
  item.permission = Permission.merge(item.permission, envRules)
}
```

### 验收测试

```
T0.18: 不设新字段时，所有 native agent (build/plan/general/explore/compaction/title/summary) 行为不变
T0.19: 设 base_agent:"explore" 的 agent 继承 explore 的 permission/model/prompt
T0.20: 设 skill_refs:["alpha-research","arxiv-search"] 的 agent 只看到这两个 skill
T0.21: 设 env_scope.allowed_commands:["alpha","docker"] 的 agent 生成正确的 bash deny+allow 规则
T0.22: 设 scale_decision 的 agent 不影响无 scale_decision 的 agent
T0.23: bun typecheck 通过
```

---

## 改动 0.5: skill_refs 注入机制

### 问题

v0.6.0 的 skill 注入是广播式（列出所有 skill），对有明确 skill_refs 的 agent 来说 signal-to-noise 低。

### 文件

`packages/opencode/src/session/system.ts`（在 `skills()` 函数中添加 whitelist 分支，不改广播逻辑）

### 代码

```ts
export async function skills(agent: Agent.Info) {
  if (Permission.disabled(["skill"], agent.permission).has("skill")) return

  if (agent.skillRefs?.length) {
    const loaded = await Promise.all(agent.skillRefs.map((name) => Skill.get(name)))
    const found = loaded.filter((s): s is Skill.Info => s !== undefined)
    const missing = agent.skillRefs.filter((name) => !loaded.find((s) => s?.name === name))
    return [
      "## Skills (mandatory)",
      "You MUST follow these skills' instructions for every task they cover.",
      ...found.map((s) => [`### Skill: ${s.name}`, s.content].join("\n")),
      ...(missing.length ? [`Note: skills ${missing.join(", ")} referenced but not found.`] : []),
    ].join("\n")
  }

  // v0.6.0 broadcast behavior (unchanged)
  const list = await Skill.available(agent)
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    Skill.fmt(list, { verbose: true }),
  ].join("\n")
}
```

### 验收测试

```
T0.24: agent 无 skillRefs 时，skills() 输出与 v0.6.0 完全一致
T0.25: agent skillRefs=["alpha-research"] 时，输出只包含 alpha-research 的完整内容
T0.26: agent skillRefs=["nonexistent"] 时，输出包含 "referenced but not found" 提示
T0.27: bun typecheck 通过
```

---

## 改动 0.6: scale_decision 注入

### 问题

scale_decision 定义了 research agent 在何种条件下使用多少子代理。这是纯 prompt 层的信息，不需要运行时强制。

### 文件

`packages/opencode/src/session/system.ts` 或 `packages/opencode/src/session/prompt.ts`（增量添加 scale_decision 注入函数）

### 设计

scale_decision 不作为运行时强制机制（不像 Permission 那样拦截工具调用），而是作为**system prompt 中的行为指导**：

```ts
export async function scaleDecision(agent: Agent.Info): Promise<string | undefined> {
  if (!agent.scaleDecision || agent.scaleDecision.rules.length === 0) return
  const lines = [
    "## Scale Decision",
    `Direct research threshold: ${agent.scaleDecision.direct_threshold} words`,
    `Never spawn subagents for: ${agent.scaleDecision.never_spawn_for.join(", ")}`,
    "Rules:",
  ]
  for (const rule of agent.scaleDecision.rules) {
    lines.push(`- ${rule.condition}: ${rule.subagent_count} ${rule.subagent_type} subagents (${rule.mode})`)
  }
  return lines.join("\n")
}
```

在 prompt assembly 中调用 `scaleDecision(agent)` 并注入到 system prompt。

### 验收测试

```
T0.28: agent 无 scaleDecision 时，无额外 prompt 注入
T0.29: agent 有 scaleDecision.rules 时，system prompt 包含 "Scale Decision" section
T0.30: bun typecheck 通过
```

---

## 完整验收清单

```
所有 Layer 0 改动完成后的验收步骤:

1. git checkout c79260d6a (v0.6.0 干净基线)
2. 应用所有 Layer 0 改动
3. bun typecheck 在 packages/opencode 通过
4. 运行已有测试套件（无回归）
5. 验证以下场景:
   a. 不设任何新字段/参数 → 所有 native agent 行为与 v0.6.0 完全一致
   b. 设 base_agent:explore 的 agent → 继承 explore 权限
   c. 设 skill_refs 的 agent → skills() 走 whitelist 分支
   d. task tool 传 discipline 参数 → 子代理权限被 intersection 正确约束
   e. Permission.intersection(parent deny, child allow) → deny（安全修复）
   f. compileDiscipline deny-before-allow 顺序正确
   g. env_scope.allowed_commands 编译为 bash deny + specific allow
```
