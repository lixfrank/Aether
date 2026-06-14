# Layer 0: Core Security Enhancement

> 基线版本: v0.6.0 (commit c79260d6a)
> 本文档是 5 层重构计划的第一层。必须在 Layer 1-4 之前完成。
> 完成后，所有用户（包括不使用 research agent 的用户）获得子代理权限安全修复。

---

## 上下文

| Layer       | 状态            | 简介                                                                                                       |
| ----------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Layer 0** | **本文档**      | 核心安全增强：Permission.intersection、Discipline.compile、task 参数扩展、Agent.Info 扩展、skill_refs 注入 |
| Layer 1     | 在 Layer 0 之后 | Agent 基础设施：mode-switch、fallback_models、prompt 模式切换、background 执行                             |
| Layer 2     | 在 Layer 1 之后 | Research 配置层：agent md 定义、skill md 定义（零核心源文件改动）                                          |
| Layer 3     | 在 Layer 2 之后 | Research 基础设施：MCP 服务器（convention lock、verification、errors）、参考文档                           |
| Layer 4     | 在 Layer 3 之后 | Publication 管线：write-paper、peer-review、respond-to-referees（完全独立）                                |

---

## 设计原则

- **增量添加**：在已有文件中只添加新函数/新字段，不改已有函数的行为
- **零副作用**：不使用新功能时，行为与 v0.6.0 完全一致（permission 语义安全修复除外）
- **deny-before-allow**：Permission Ruleset 中 deny 规则排在 allow 规则之前（`findLast` 最后匹配胜，allow 覆盖 blanket deny）
- **可选默认值 = undefined**：所有新增字段的默认值为 undefined（不设 z.default），确保缺失时不产生任何规则、不改变任何行为。显式传值才生效。内嵌对象的子字段同样不设 z.default，fallback 默认值在消费函数中用 `?? default` 实现。
- **zod schema 的实际用途**：`Agent.Info` 的 zod schema 有两个实际用途——（1）通过 `resolver(Agent.Info.array())` 为 `/api/agents` 端点生成 OpenAPI 文档；（2）通过 `z.infer<typeof Info>` 为整个代码库提供 TypeScript 类型。**Agent.Info 不经过 zod parse**（native agent 在 agent.ts 中手工构建，custom agent 在 merge 循环中逐字段赋值），因此 `z.default()` 不在运行时生效。如果在 Agent.Info 上使用 `z.default()`，会导致 OpenAPI 文档和 TypeScript 类型暗示一个运行时不存在的默认值，造成误导。正确做法：使用 `.optional()` 让 schema 准确反映运行时行为（字段可为 undefined），默认值语义在 `Discipline.compile()` 或消费函数中实现。

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

### intersection 的 override 参数语义

`intersection(parent, child, override)` 的计算过程：

1. `childEffective = Permission.merge(child, override)` — override 是 child 的扩展，merge 后 override 中的规则排在 child 之后，findLast 使 override 胜
2. `intersection(parent, childEffective)` — parent deny 总是生效，child deny 总是生效，child allow 只在 parent allow 时生效

| parent 规则         | child 规则                 | override (discipline) 规则                       | childEffective = merge(child, override)            | intersection 结果                                                                | 说明                                                       |
| ------------------- | -------------------------- | ------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| bash, \*, **allow** | bash, \*, **allow**        | bash, "uv*", **allow** + bash, *, **deny**       | bash, _, allow → bash, uv_, allow → bash, \*, deny | findLast → **deny**                                                              | discipline deny-before-allow：特定 allow 覆盖 blanket deny |
| bash, \*, **deny**  | bash, "uv\*", **allow**    | 无 override                                      | bash, uv\*, allow                                  | **deny**                                                                         | parent deny 覆盖 child allow（安全修复）                   |
| bash, \*, **allow** | bash, "secret\*", **deny** | 无 override                                      | bash, secret\*, deny                               | **deny**                                                                         | child deny 不被 parent allow 覆盖                          |
| edit, \*, **allow** | 无 edit 规则               | edit, \*, **deny** + edit, "src/**", **allow\*\* | edit, \*, deny → edit, src/\*\*, allow             | evaluate("edit","src/foo") → **allow**; evaluate("edit","secret/foo") → **deny** | file_scope 限制写操作（读工具不受限制）                    |
| task, \*, **allow** | 无 task 规则               | task, \*, **deny**                               | task, \*, deny                                     | **deny**                                                                         | delegation_depth=0                                         |
| _, _, **allow**     | _, _, **allow**            | todowrite, \*, **deny**                          | todowrite, \*, deny                                | **deny**                                                                         | 禁止子代理 todowrite                                       |
| _, _, **allow**     | _, _, **allow**            | 无 override                                      | \*, allow                                          | **allow**                                                                        | 无限制                                                     |

**关键语义：**

- parent deny **总是**生效（安全底线）
- child deny **总是**生效（子代理主动限制）
- override (discipline) 是 child 的扩展：先 merge(child, override)，再 intersection(parent, childEffective)
- discipline 的 deny-before-allow 顺序保证特定 allow 覆盖 blanket deny

### 验收测试

```
T0.1: intersection(parent=[{edit,"*",deny}], child=[{edit,"src/**",allow}]) → [{edit,"*",deny}]
T0.2: intersection(parent=[{edit,"*",allow}], child=[{edit,"secret/**",deny}]) → [{edit,"secret/**",deny}]
T0.3: intersection(parent=[{bash,"*",allow}], child=[{bash,"uv*",allow},{bash,"*",deny}], override=[]) → bash 只有 uv* allow + blanket deny
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

**默认值策略**：`delegation_depth`、`max_steps`、`timeout_seconds` 等字段的默认值为 **undefined**（不设 `z.default()`），仅在显式传值时编译规则。`undefined` = "不限制"（不产生规则），`0` = "显式禁止"。这确保不传新参数时行为与 v0.6.0 一致。

> **注意**：`Agent.Info` 的 zod schema 有两个实际用途——OpenAPI 文档生成和 TypeScript 类型推断——但 Agent.Info 不经过 zod parse。native agent 在 `agent.ts` 中手工构建，custom agent 在 merge 循环中逐字段赋值。`z.default()` 不在运行时生效，且会误导 OpenAPI 文档和 TypeScript 类型。因此所有新增字段使用 `.optional()`（无 default），默认值语义在 `compile()` 中实现：`undefined` = "不限制"（不产生规则），显式传值才生效。

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
    delegation_depth: z.number().int().min(0).max(3).optional(),
    max_steps: z.number().int().min(1).max(50).optional(),
    timeout_seconds: z.number().int().min(30).max(600).optional(),
    return_format: z.enum(["text", "structured", "raw"]).optional(),
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
      const WRITE_TOOLS = ["edit", "write", "apply_patch", "multiedit"]
      // deny-before-allow: blanket deny first, scope-specific allows after
      for (const tool of WRITE_TOOLS) {
        rules.push({ permission: tool, pattern: "*", action: "deny" })
      }
      for (const scopePattern of d.file_scope) {
        for (const tool of WRITE_TOOLS) {
          rules.push({ permission: tool, pattern: scopePattern, action: "allow" })
        }
      }
    }

    if (d.delegation_depth === 0) {
      rules.push({ permission: "task", pattern: "*", action: "deny" })
    }
    // delegation_depth undefined 或 > 0 → 不产生规则，task 权限取决于 agent 自身

    return rules
  }
}
```

### Agent 级 env_scope/file_scope 编译（统一入口）

env_scope 和 file_scope 的编译**只在 `agent.ts` 中进行**，不在 `task.ts` 的 discipline 参数中重复编译。编译后的规则作为 agent.permission 的一部分，在 task.ts 的 `intersection()` 中自然参与权限计算。

```ts
// agent.ts merge 循环中新增（在 value.permission 处理之后）
const compileInput: z.infer<typeof Discipline.Schema> = {}
if (value.env_scope?.allowed_commands) compileInput.env_scope = value.env_scope
if (value.file_scope) compileInput.file_scope = value.file_scope
if (Object.keys(compileInput).length > 0) {
  const compiled = Discipline.compile(compileInput)
  item.permission = Permission.merge(item.permission, compiled)
}
```

### 验收测试

```
T0.6: compile({env_scope:{allowed_commands:["uv","docker"]}}) 生成 [{bash,"*",deny}, {bash,"uv*",allow}, {bash,"docker*",allow}]
T0.7: compile({file_scope:["src/**","test/**"]}) 生成 每个 WRITE_TOOL 一条 blanket deny + 每个 scope 一条 allow（read/glob/grep 不受限）
T0.8: compile({delegation_depth:0}) 包含 [{task,"*",deny}]
T0.9: compile({delegation_depth:undefined}) 不产生任何 task 规则（与 v0.6.0 一致）
T0.10: compile({permission_override:{edit:["allow"],bash:["allow","docker*"]}}) 生成正确的 allow/pattern 规则
T0.11: deny-before-allow 顺序：Permission.evaluate("bash","uv run ...", ruleset) = allow；Permission.evaluate("bash","rm -rf...", ruleset) = deny
T0.12: bun typecheck 通过
```

---

## 改动 0.3: Task Tool 参数扩展与权限重构

### 问题

v0.6.0 的 task.ts 只有 5 个参数（description, prompt, subagent_type, task_id, command），无法控制子代理的权限、行为边界、执行模式。

### 文件

`packages/opencode/src/tool/task.ts`（在已有 parameters 上添加 optional 字段 + 新增 2 个 import + 在 execute 中重构权限计算 + 移除已有手工拼接代码块）

### 新增参数

```ts
const parameters = z.object({
  // v0.6.0 已有（保持不变）
  description: z.string(),
  prompt: z.string(),
  subagent_type: z.string(),
  task_id: z.string().optional(),
  command: z.string().optional(),
  // 新增（全部 optional，默认值 undefined = 不产生规则 = v0.6.0 行为）
  mode: z.enum(["serial", "concurrent", "background"]).optional(),
  permission_override: z.record(z.string(), z.string().array().optional()).optional(),
  file_scope: z.string().array().optional(),
  delegation_depth: z.number().int().min(0).max(3).optional(),
  max_steps: z.number().int().min(1).max(50).optional(),
  timeout_seconds: z.number().int().min(30).max(600).optional(),
})
```

### execute 中权限计算（统一 permission 流程）

v0.6.0 中 task.ts 使用两套并行机制：

1. **permission 数组**：手工拼接 `{todowrite, *, deny}` / `{task, *, deny}` / `{primary_tool, *, allow}` → 传给 `Session.create({permission: [...]})`
2. **tools dict**：`{todowrite: false, task: false}` → 传给 `SessionPrompt.prompt({tools: {...}})` → 在 `resolveTools` 中硬删除工具

新方案将两套机制统一为一套：所有约束通过 `Discipline.compile()` 编译为 `Ruleset`，再通过 `intersection()` 计算出完整的 `sessionPermission`，传给 `Session.create`。运行时 `Permission.disabled()` 检测 `{tool, *, deny}` 规则并硬删除工具——与 `tools dict` 效果等价。

```ts
// 注意：Tool.Context.agent 是 string（agent name），不是 Agent.Info。
// 需要通过 Agent.get() 获取 caller 的 Agent.Info
const callerAgent = await Agent.get(ctx.agent)
const targetAgent = await Agent.get(params.subagent_type)

// discipline 只包含 task 级参数（env_scope 不在此处，已在 agent.permission 中）
const discipline = {
  permission_override: params.permission_override,
  file_scope: params.file_scope,
  delegation_depth: params.delegation_depth,
  max_steps: params.max_steps,
  timeout_seconds: params.timeout_seconds,
}
const disciplineRules = Discipline.compile(discipline)

// intersection 计算完整的 effective permission
// targetAgent.permission 已包含 env_scope 编译的规则（来自改动 0.4 的 agent.ts merge）
const sessionPermission = Permission.intersection(callerAgent.permission, targetAgent.permission, disciplineRules)

// primary_tools 语义：v0.6.0 中 primary_tools 在子代理 session permission 中添加 allow，
// 在 tools dict 中设为 false（硬删除）。新方案中，primary_tools 的 allow 不需要额外添加
// （caller defaults 已有 * allow），但需要将 primary_tools deny 规则加入 sessionPermission，
// 保留"子代理不可用 primary_tools"的行为。
const cfg = await Config.get()
const primaryToolsDeny = (cfg.experimental?.primary_tools ?? []).map((t) => ({
  permission: t,
  pattern: "*",
  action: "deny" as const,
}))
const finalPermission = [...sessionPermission, ...primaryToolsDeny]

// 创建 session 时传入完整的 permission
const session = await Session.create({
  parentID: ctx.sessionID,
  title: params.description + ` (@${targetAgent.name} subagent)`,
  permission: finalPermission,
})

// 不再需要 v0.6.0 的 tools dict（Permission.disabled 在运行时自动硬删除 denied 工具）
const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
const model = targetAgent.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }

const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)
const result = await SessionPrompt.prompt({
  messageID: MessageID.ascending(),
  sessionID: session.id,
  model,
  agent: targetAgent.name,
  parts: promptParts,
})
```

**被替换的已有代码块**（执行时必须移除）：

- 第 66-67 行：`hasTaskPermission` / `hasTodoWritePermission` 检查（被 intersection + Discipline.compile 替代）
- 第 78-102 行：手工拼接的 permission 数组（被 `finalPermission` 替代）
- 第 108-111 行：手工 model 选择逻辑（被 fallback 链替代）
- 第 138-143 行：tools dict（被 Permission.disabled 运行时硬删除替代）

**新增 import**：

```ts
import { Discipline } from "@/session/discipline" // 新增
```

**primary_tools 行为保留**：v0.6.0 中 `primary_tools` 的语义是"仅 primary agent 可用"。当前 task.ts 通过 permission allow + tools dict false 双重机制实现。新方案中 permission allow 不需要（caller defaults 已有 `* allow`），但需要在 sessionPermission 末尾追加 `{primary_tool, *, deny}` 规则，保留"子代理不可用"的行为。`Permission.disabled()` 在运行时检测这些规则并硬删除工具。

**关于 prompt.ts 的交互**：运行时 `Permission.merge(agent.permission, session.permission)` 中的 `session.permission` 已经是 `intersection()` 的完整结果（包含 parent deny 传播 + discipline 扩展）。`merge` 后 `agent.permission` 的规则出现在 `session.permission` 之前，findLast 使得 `session.permission` 中的规则胜出。冗余的 `agent.permission` 规则不影响 evaluate 结果，**不需要改动 prompt.ts**。

### 逐场景验证（v0.6.0 vs 新方案）

| 场景                            | v0.6.0 行为                                                                                           | 新方案行为                                                                                                      | 是否一致                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **A: general agent 正常调用**   | session 添加 `{todowrite, *, deny}`；merge(general.permission, session.permission) → todowrite denied | general.permission 已含 `{todowrite, *, deny}`；intersection(caller, general, discipline={}) → todowrite denied | ✓                                                                   |
| **B: explore agent 正常调用**   | session 添加 `{todowrite, *, deny}` + `{task, *, deny}`；merge 后 denied                              | explore permission 中 `{*, deny}` 使 todowrite/task 在 explore 侧就 denied，intersection 正确传播               | ✓                                                                   |
| **C: parent deny, child allow** | merge → child allow 覆盖 parent deny（安全漏洞）                                                      | intersection → parent deny 覆盖 child allow                                                                     | 预期改变（安全修复）                                                |
| **D: primary_tools deny**       | session 添加 `{primary_tool, *, allow}` + tools dict `{primary_tool: false}` → 子代理不可用           | finalPermission 末尾追加 `{primary_tool, *, deny}` → Permission.disabled 硬删除 → 子代理不可用                  | ✓                                                                   |
| **E: 不传新参数**               | 手工拼接 deny todowrite/task（if agent lacks permission）                                             | discipline={} → compile 不产生规则 → intersection(caller, agent, []) → 行为取决于 caller+agent 权限             | ✓（与 v0.6.0 一致，task/todowrite deny 来自 agent 自身 permission） |

**场景 E 是关键一致性保证**：`delegation_depth` 默认 undefined（不传时不产生 `{task, *, deny}`），task 的 deny/allow 完全取决于 agent 自身权限——与 v0.6.0 中 `hasTaskPermission` 逻辑等价。

### 验收测试

```
T0.13: 不传任何新参数时，task tool 行为与 v0.6.0 一致（permission 语义安全修复除外）
T0.14: 传 permission_override: {bash:["allow","docker*"]} 时，子代理只有 docker* bash 权限
T0.15: 传 delegation_depth:0 时，子代理的 task 工具被 deny
T0.16: 传 delegation_depth:undefined（或不传）时，task 权限取决于 agent 自身（与 v0.6.0 一致）
T0.17: 传 file_scope:["src/**"] 时，子代理的写操作工具被限制在 src/** 范围（read/glob/grep 不受限）
T0.20: sessionPermission 通过 Session.create({permission}) 传递后，运行时 Permission.disabled 正确硬删除 denied 工具
T0.21: bun typecheck 通过
```

---

## 改动 0.4: Agent.Info 扩展字段（不含 base_agent）

### 问题

v0.6.0 的 Agent.Info 缺少 skill_refs（技能白名单）、env_scope（环境隔离）等字段。

### 设计决策：去掉 base_agent 继承

原方案包含 `base_agent` 字段用于 agent 间继承（如 research 继承 explore 的 permission/model/prompt）。经分析后决定去掉，原因：

1. 只涉及 4 个 research 系 agent，手动声明 permission 的成本很低
2. explore 的 permission 不太会频繁变动，手动复制不会造成维护负担
3. 去掉后 agent.ts 的改动从"带继承和编译的复杂合并"降为"逐字段赋值"，侵入性显著降低
4. 如果未来需要继承，可作为独立改动单独引入，不在 Layer 0 中

Layer 2 的 research 系 agent 需要手动声明 permission，参考 explore 的 permission 规则。

### 文件

`packages/opencode/src/agent/agent.ts`（在 Info schema 末尾添加 optional 字段 + 在 state merge 循环中逐字段赋值 + 新增 Discipline import）
`packages/opencode/src/config/config.ts`（在 Agent schema 中添加 optional 字段 + 更新 knownKeys 白名单）

### 新增字段（Agent.Info）

```ts
// Info schema 末尾添加
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

```

> 所有新增字段使用 `.optional()`（无 `z.default()`），包括内嵌对象的子字段。`Agent.Info` 的 zod schema 有两个实际用途：OpenAPI 文档生成（`resolver(Agent.Info.array())`）和 TypeScript 类型推断（`z.infer<typeof Info>`）。但 Agent.Info 不经过 zod parse——native agent 在 agent.ts 中手工构建，custom agent 在 merge 循环中逐字段赋值。`z.default()` 不在运行时生效，且会误导 OpenAPI 文档和 TypeScript 类型（让它们暗示字段总有值，但实际可为 undefined）。因此所有新增字段（含内嵌子字段）使用 `.optional()`，默认值语义在消费函数中通过 `?? fallback` 实现。

### Config.Agent 对应字段

在 `config.ts` 的 Agent schema 中添加（在 `permission: Permission.optional()` 之后）：

```ts
skill_refs: z.array(z.string()).optional(),
delegation_depth: z.number().int().min(0).max(3).optional(),
file_scope: z.string().array().optional(),
max_steps: z.number().int().positive().optional(),
fallback_models: z.array(z.union([z.string(), z.object({...})])).optional(),
env_scope: z.object({ allowed_commands: z.string().array().optional() }).optional(),

```

**实现注意**：`Config.Agent` 有 `.catchall(z.any()).transform(...)` 结构，transform 中 `knownKeys` 白名单硬编码了已有字段名。新增字段必须加入 `knownKeys`，否则会被静默扫入 `options`。建议在实现时添加 assertion/zod refine，确保 `skill_refs`/`env_scope` 等字段不会意外出现在 `options` 中。

### 新增 import（agent.ts）

```ts
import { Discipline } from "@/session/discipline" // 新增（env_scope 编译需要）
```

### Merge 循环新增处理

```ts
// 逐字段赋值（无继承逻辑）
item.skillRefs = value.skill_refs ?? item.skillRefs
item.delegationDepth = value.delegation_depth ?? item.delegationDepth
item.fileScope = value.file_scope ?? item.fileScope
item.maxSteps = value.max_steps ?? item.maxSteps ?? item.steps
item.fallbackModels = value.fallback_models ?? item.fallbackModels
item.envScope = value.env_scope ?? item.envScope

// env_scope 编译为 permission（统一入口，不重复编译）
if (value.env_scope?.allowed_commands) {
  const envRules = Discipline.compile({ env_scope: value.env_scope })
  item.permission = Permission.merge(item.permission, envRules)
}
```

### 验收测试

```
T0.22: 不设新字段时，所有 native agent (build/plan/general/explore/compaction/title/summary) 行为不变
T0.23: 设 skill_refs:["paper-search"] 的 agent 在 skills() 中看到 paper-search 的完整注入
T0.24: 设 env_scope.allowed_commands:["uv","docker"] 的 agent 生成正确的 bash deny+allow 规则
T0.25: env_scope 编译只在 agent.ts 中发生一次，不在 task.ts 中重复编译
T0.26: Config.Agent 新字段被 knownKeys 白名单正确识别，不落入 options
T0.27: bun typecheck 通过
```

---

## 改动 0.5: skill_refs 注入机制（替换广播）

### 问题

v0.6.0 的 skill 注入是广播式（列出所有 skill），对有明确 skill_refs 的 agent 来说 signal-to-noise 低。

### 文件

`packages/opencode/src/session/system.ts`（在 `skills()` 函数中，有 skillRefs 时只返回 skillRefs 注入内容，不返回广播）

### 设计

skill_refs 为**替换**而非追加广播。有 skillRefs 时，只注入 skillRefs 指定的 skill 完整内容，不再注入广播列表。原因：指定 skill_refs 的 agent 需要精确控制可见 skill 范围，广播列表会引入噪声并稀释 skillRefs 的信号强度。

**关键改动**：skill_refs 注入现在**包含 skill 目录路径**（`file://` URL），使 agent 能解析 SKILL.md 中的相对路径引用（如 `references/error_catalog.json`），用 Read 工具读取 skill 的 bundled 数据文件。这是 Layer 3 的前置条件——没有 skill 目录路径，agent 无法访问 skill 的 references/ 和 scripts/ 文件。

```ts
export async function skills(agent: Agent.Info) {
  if (Permission.disabled(["skill"], agent.permission).has("skill")) return

  // 如果有 skillRefs whitelist，只返回注入内容（替换广播）
  if (agent.skillRefs?.length) {
    const loaded = await Promise.all(agent.skillRefs.map((name) => Skill.get(name)))
    const found = loaded.filter((s): s is Skill.Info => s !== undefined)
    const missing = agent.skillRefs.filter((name) => !loaded.find((s) => s?.name === name))
    return [
      "## Skills (mandatory)",
      "You MUST follow these skills' instructions for every task they cover.",
      "The following skills have been fully injected — do NOT use the skill tool to load them again.",
      ...found.map((s) =>
        [`### Skill: ${s.name}`, `Skill directory: ${pathToFileURL(path.dirname(s.location)).href}`, s.content].join(
          "\n",
        ),
      ),
      ...(missing.length ? [`Note: skills ${missing.join(", ")} referenced but not found.`] : []),
    ].join("\n")
  }

  // 无 skillRefs 时，返回广播（与 v0.6.0 完全一致）
  const list = await Skill.available(agent)
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    Skill.fmt(list, { verbose: true }),
  ].join("\n")
}
```

**优势**：

- `Permission.disabled` 检查位置不变
- 无 skillRefs 时输出与 v0.6.0 完全一致（广播路径不变）
- 有 skillRefs 时输出只包含指定的 skill 内容，无广播噪声
- skill 目录路径使 agent 能读取 skill 的 bundled references 和 scripts 文件
- 减少 context window 占用

### 验收测试

```
T0.29: agent 无 skillRefs 时，skills() 输出与 v0.6.0 完全一致（广播列表）
T0.30: agent skillRefs=["paper-search"] 时，输出仅包含 paper-search 的完整内容（无广播列表）
T0.31: agent skillRefs=["nonexistent"] 时，输出仅包含 "referenced but not found" 提示（无广播列表）
T0.32: agent skillRefs 有值时，广播部分（Skill.fmt）不存在，只有注入内容
T0.33: skill_refs 注入包含 Skill directory URL（file:// 格式），agent 可拼接 base_dir + relative_path 读取 references 文件
T0.34: bun typecheck 通过
```

---

## 改动 0.6: findOrInstallUv() — Python/uv 运行时自动安装

### 问题

Layer 3 的 Python scripts 和 MCP 服务器使用 `uv run` + PEP 723 执行。如果用户环境没有 `uv`，脚本和 MCP 服务器无法启动。

### 文件

`packages/opencode/src/util/python.ts`（**新增**独立模块）

### 设计

Aether 自动检测并安装 `uv` 单二进制到 `~/.aether/bin/uv`。uv 是 Astral 出品的 Python 包管理器（~10MB 单文件），可自动安装 Python、创建 venv、执行带 PEP 723 inline deps 的脚本。

```ts
export async function findOrInstallUv(): Promise<string | null> {
  // 1. 检查 ~/.aether/bin/uv 是否存在
  const homeUv = path.join(os.homedir(), ".aether", "bin", "uv")
  if (await executable(homeUv)) return homeUv

  // 2. 检查 PATH 中是否有 uv
  const pathUv = which("uv")
  if (pathUv) return pathUv

  // 3. 下载 uv 到 ~/.aether/bin/uv
  // 从 https://github.com/astral-sh/uv/releases 下载平台对应的单二进制
  // macOS: uv-macos-latest.tar.gz → 解压 → ~/.aether/bin/uv
  // Linux: uv-linux-latest.tar.gz → 解压 → ~/.aether/bin/uv
  const downloaded = await downloadUv(homeUv)
  return downloaded ? homeUv : null
}
```

### 前置条件

- `mkdir -p ~/.aether/bin` 在首次运行时创建
- 下载失败（无网络）时返回 `null`，agent/MCP 退化为 `python3 -m` 方式
- 与现有 LSP binary 安装模式类似（`Global.Path.bin` 已有类似逻辑）

### 使用点

- Layer 3 MCP 服务器启动前检测 uv
- Layer 3 Python scripts 执行前检测 uv
- 未来 Layer 5 background execution 也可使用

### 验收测试

```
T0.35: PATH 中有 uv 时，findOrInstallUv() 返回 PATH 中的 uv 路径
T0.36: PATH 中无 uv 但 ~/.aether/bin/uv 存在时，返回 ~/.aether/bin/uv
T0.37: PATH 中无 uv 且 ~/.aether/bin/uv 不存在时，自动下载到 ~/.aether/bin/uv 并返回路径
T0.38: 下载失败时返回 null（不抛异常）
T0.39: uv run script.py 正常执行 PEP 723 声明依赖的 Python 脚本
T0.40: bun typecheck 通过
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
   b. 设 skill_refs 的 agent → skills() 只返回 skillRefs 指定的 skill（替换广播）
   c. task tool 传 discipline 参数 → 子代理权限被 intersection 正确约束
   d. Permission.intersection(parent deny, child allow) → deny（安全修复）
   e. compileDiscipline deny-before-allow 顺序正确
   f. env_scope.allowed_commands 编译为 bash deny + specific allow（只在 agent.ts 中编译一次）
g. delegation_depth undefined → 不产生 task 规则（v0.6.0 一致）；delegation_depth 0 → task denied
    i. Config.Agent 新字段在 knownKeys 白名单中，不落入 options
   k. sessionPermission + primary_tools deny 通过 Session.create({permission}) 传递后，Permission.disabled 正确硬删除 denied 工具
   l. primary_tools 子代理不可用（与 v0.6.0 行为一致）
   m. Tool.Context.agent 是 string，execute 中通过 Agent.get(ctx.agent) 获取 caller Agent.Info
   n. skill_refs 注入包含 Skill directory URL，agent 可读取 skill bundled 文件
   o. findOrInstallUv() 可自动安装 uv 到 ~/.aether/bin/uv
```
