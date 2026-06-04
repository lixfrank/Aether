# Layer 1: Agent Infrastructure

> 前置依赖: Layer 0（Permission.intersection、Discipline.compile、Agent.Info 扩展、skill_refs 注入）
> 本文档是 5 层重构计划的第二层。在 Layer 0 完成后开始。
> 完成后，用户可以通过配置文件创建新的 primary agent mode（如 research）和 subagent（如 research-explorer）。

---

## 上下文

| Layer       | 状态            | 简介                                                                                    |
| ----------- | --------------- | --------------------------------------------------------------------------------------- |
| Layer 0     | **已完成**      | 核心安全增强：intersection、compile、task 参数扩展、Info 扩展、skill_refs               |
| **Layer 1** | **本文档**      | Agent 基础设施：mode-switch、fallback_models、prompt 模式切换、background 执行、notepad |
| Layer 2     | 在 Layer 1 之后 | Research 配置层：agent/skill md 定义（零核心改动）                                      |
| Layer 3     | 在 Layer 2 之后 | MCP 服务器（convention lock、verification）、参考文档                                   |
| Layer 4     | 在 Layer 3 之后 | Publication 管线（write-paper、peer-review、respond-to-referees）                       |

---

## 改动 1.1: Mode-Switch 工具工厂

### 问题

v0.6.0 只有硬编码的 `plan_enter`/`plan_exit`。用户创建的新 primary agent（如 research）需要对应的 `xxx_enter`/`xxx_exit` 工具。

### 文件

`packages/opencode/src/tool/mode-switch.ts`（**新增**独立模块）

### 设计

为所有 `mode: primary` 的 agent 动态生成 enter/exit 工具。已有 `plan_enter`/`plan_exit` 保持不变（它们是硬编码的，不会被替换）。

```ts
import { Tool } from "./tool"
import { Agent } from "../agent/agent"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Permission } from "@/permission"
import z from "zod"

export namespace ModeSwitch {
  export function createEnterTool(agent: Agent.Info) {
    const name = agent.name
    return Tool.define(`${name}_enter`, async (ctx) => ({
      description: agent.options?.enter_description ?? `Switch to ${name} mode`,
      parameters: z.object({}),
      async execute(_params, ctx) {
        // MCP activation if agent has mcp config
        if (agent.options?.mcp) {
          for (const [serverId, enabled] of Object.entries(agent.options.mcp)) {
            if (enabled) await MCP.connect(serverId)
          }
        }
        // Notepad creation if agent has output_dir
        if (agent.options?.output_dir) {
          const notepadDir = normalizeOutputDir(agent.options.output_dir)
          await createNotepad(notepadDir)
        }
        // Ask user to confirm
        const answers = await ctx.ask({
          permission: `${name}_enter`,
          patterns: ["*"],
          always: ["*"],
          metadata: { description: `Switch to ${name} mode` },
        })
        // Create synthetic user message targeting new agent
        const model = await getLastModel(ctx.sessionID)
        const userMsg = {
          id: MessageID.ascending(),
          sessionID: ctx.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: name,
          model,
        }
        await Session.updateMessage(userMsg)
        await Session.updatePart(...)
        return { title: `Switching to ${name}`, output: "Wait for further instructions." }
      },
    }))
  }

  export function createExitTool(agent: Agent.Info) {
    const name = agent.name
    return Tool.define(`${name}_exit`, async (ctx) => ({
      description: agent.options?.exit_description ?? `Exit ${name} mode`,
      parameters: z.object({}),
      async execute(_params, ctx) {
        // MCP deactivation
        if (agent.options?.mcp) {
          for (const [serverId, enabled] of Object.entries(agent.options.mcp)) {
            if (enabled) await MCP.disconnect(serverId)
          }
        }
        // Offer exit destinations
        const exitOptions = agent.options?.exit_options ?? [
          { label: "Build", agent: "build", description: "Switch to build agent" },
        ]
        // Ask user where to go next
        const answers = await ctx.ask(...)
        // Create synthetic message targeting chosen agent
        return { title: `Exiting ${name}`, output: "Wait for further instructions." }
      },
    }))
  }
}
```

### 注册点

`packages/opencode/src/tool/registry.ts` — 在动态工具注册区域添加:

```ts
// 在动态工具注册区域（不影响已有工具注册）
const allAgents = await Agent.list()
for (const agent of allAgents) {
  if (agent.mode === "primary" || agent.mode === "all") {
    const { enterTool, exitTool } = ModeSwitch.createTools(agent)
    // register enterTool and exitTool
  }
}
```

### Notepad 结构

当 agent 有 `output_dir` 配置时，enter 工具创建:

```ts
async function createNotepad(dir: string) {
  await fs.mkdir(path.join(dir, "notepads"), { recursive: true })
  const slug = /* timestamp-based */
  const notepadDir = path.join(dir, "notepads", slug)
  await fs.mkdir(notepadDir, { recursive: true })
  // Create 5 structured files
  await fs.writeFile(path.join(notepadDir, "sources.md"), "# Sources\n| Source | URL | Quality | Key Takeaway |\n")
  await fs.writeFile(path.join(notepadDir, "findings.md"), "# Findings\n")
  await fs.writeFile(path.join(notepadDir, "gaps.md"), "# Gaps\n")
  await fs.writeFile(path.join(notepadDir, "learnings.md"), "# Learnings\n")
  await fs.writeFile(path.join(notepadDir, "report.md"), "# Report\n")
  return notepadDir
}
```

normalizeOutputDir 防止 `.aether/.aether/` 双重嵌套:

```ts
function normalizeOutputDir(dir: string): string {
  const projectDir = Instance.worktree
  // Strip any leading .aether/ prefix to prevent double-nesting
  const clean = dir.replace(/^\.aether\/+/, "")
  return path.join(projectDir, ".aether", clean)
}
```

### 验收测试

```
T1.1: build/plan 切换仍走 v0.6.0 的 plan_enter/plan_exit 逻辑，不受影响
T1.2: research_enter 工具出现在工具列表中（当 research.md 存在时）
T1.3: research_enter execute 后，session 的 agent 字段变为 "research"
T1.4: research_exit execute 后，MCP 服务器被正确 disconnect
T1.5: normalizeOutputDir("research") → .aether/research（不嵌套）
T1.6: normalizeOutputDir(".aether/research") → .aether/research（防止双重嵌套）
T1.7: bun typecheck 通过
```

---

## 改动 1.2: Prompt 模式切换注入

### 问题

v0.6.0 的 prompt.ts 只处理 build→plan 切换。需要处理任意 primary agent 之间的切换。

### 文件

`packages/opencode/src/session/prompt.ts`（在 loop 中添加 agent 检测分支，**不改**已有 build→plan 切换逻辑）

### 设计

当检测到 message 的 `agent` 字段变化（非 build/plan）时:

1. `Permission.intersection(session.permission, newAgent.permission)` 作为有效权限
2. 注入 `newAgent.prompt`（替换）或 `newAgent.promptAppend`（追加，来自 `prompt_append` 配置）
3. 注入 notepad 结构信息（如果有 output_dir）
4. 注入 scale_decision 指导（如果有）
5. `SystemPrompt.skills()` 已经会走 skill_refs whitelist 分支（Layer 0.5）

### file:// URI 解析

`prompt_append` 和 `prompt` 支持 `file://` URI:

```ts
function resolvePromptContent(content: string): Promise<string> {
  if (content.startsWith("file://")) {
    const filePath = fileURLToPath(content)
    return fs.readFile(filePath, "utf-8")
  }
  return Promise.resolve(content)
}
```

### 验收测试

```
T1.8: build→plan 切换仍走 v0.6.0 BUILD_SWITCH/plan_enter 逻辑
T1.9: build→research 切换注入 research 的 permission + prompt_append + notepad info
T1.10: prompt_append 中 file://./aether/prompts/research.txt 被解析为文件内容
T1.11: research→build 切换恢复 build 的权限 + 注入 notepad report 引用
T1.12: bun typecheck 通过
```

---

## 改动 1.3: Fallback Models 降级

### 问题

当 primary model API 失败时（429/503/529/401/403），需要自动尝试 fallback model chain。

### 文件

`packages/opencode/src/session/processor.ts`（增量添加 fallback 逻辑，不改已有 retry 机制）

### 设计

- 触发条件: 429/503/529（速率限制）+ 401/403（认证错误）
- UI 选定模型（用户手动选择）**不被 fallback 覆盖**（优先级最高）
- Fallback entry 的 settings（temperature、topP）仅在当前请求生效，不持久覆盖
- 最多尝试 3 个 fallback 模型

### 验收测试

```
T1.13: 不设 fallbackModels 时，API 失败行为与 v0.6.0 一致
T1.14: 设 fallbackModels 时，429 错误触发自动降级到下一个模型
T1.15: 用户手动选择的模型不会被 fallback 覆盖
T1.16: fallback 成功后，下一次请求恢复 primary model 设置
T1.17: bun typecheck 通过
```

---

## 改动 1.4: Background 执行基础设施

### 问题

Layer 0 的 task.ts 参数扩展添加了 `mode: background`，但需要基础设施来支持异步执行和结果取回。

### 文件

| 文件                                              | 类型 | 说明                                           |
| ------------------------------------------------- | ---- | ---------------------------------------------- |
| `packages/opencode/src/session/background.ts`     | 新增 | BackgroundTask namespace (spawn/output/status) |
| `packages/opencode/src/session/concurrency.ts`    | 新增 | 全局并发控制                                   |
| `packages/opencode/src/tool/background-output.ts` | 新增 | background_output 工具                         |

### BackgroundTask 设计

- `spawn()`: 创建子 session，在 Effect fiber 中执行，立即返回 taskID
- `output()`: 从缓冲池取回结果（阻塞等待完成）
- `status()`: 查询运行状态
- 主 session abort 时取消所有后台子 session
- 结果持久化到 SQLite

### Concurrency 控制

```ts
namespace Concurrency {
  const maxConcurrent = 5 // 全局上限
  const active = new Map<SessionID, { model: string; startedAt: number }>()

  export async function awaitSlot(model: string): Promise<void> {
    while (active.size >= maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}
```

### 验收测试

```
T1.18: 不使用 background mode 时，task tool 行为与 v0.6.0 一致（serial）
T1.19: mode=background 的 task 立即返回 taskID，主代理继续工作
T1.20: background_output 工具可以取回后台 task 的结果
T1.21: 主 session abort 时，后台子 session 被取消
T1.22: 并发超过 5 时排队等待
T1.23: bun typecheck 通过
```

---

## 改动 1.5: Skill-Embedded MCP Per-Agent

### 问题

某些 agent（如 research）需要特定的 MCP 服务器（如 gpd-verification），但这些 MCP 不应污染其他 agent 的 context window。

### 文件

`packages/opencode/src/config/config.ts`（Config.Agent 新增 `mcp` 字段）
`packages/opencode/src/agent/agent.ts`（Agent.Info 新增 `mcp` 字段 + merge 循环处理）

### Config.Agent 新增

```ts
mcp: z.record(z.string(), z.boolean())
  .optional()
  .describe("MCP servers to activate on mode enter, deactivate on mode exit")
```

### Agent.Info 新增

```ts
mcp: z.record(z.string(), z.boolean()).optional()
```

### Merge 循环新增

```ts
item.mcp = value.mcp ?? item.mcp
```

### Mode-Switch 中的 MCP 处理

在 `mode-switch.ts` 的 enter/exit 工具中:

- Enter: `MCP.connect(serverId)` for each enabled MCP
- Exit: `MCP.disconnect(serverId)` for each enabled MCP

在 `prompt.ts` 的 mode-switch 检测中:

- 当检测到 UI-dropdown 切换（而非 enter 工具触发）时，也需要 activate/deactivate MCP

### 验收测试

```
T1.24: agent 无 mcp 配置时，MCP 行为与 v0.6.0 一致
T1.25: research agent mcp={"gpd-verification":true} 时，enter 后 gpd-verification MCP 可用
T1.26: research_exit 后 gpd-verification MCP 被 disconnect
T1.27: UI dropdown 切换到 research 时，MCP 也被 activate
T1.28: bun typecheck 通过
```

---

## 改动 1.6: Denied Tools 显示优化

### 问题

v0.6.0 向所有代理展示全部工具描述，包括被 deny 的工具。浪费 context window，且让代理"看到工具却被拒绝"。

### 设计

**选项 A（推荐，最简单）**: 在 `resolveTools()` 中过滤掉被 deny 的工具描述:

```ts
const tools = allTools.filter((tool) => {
  const permKey = EDIT_TOOLS.includes(tool.id) ? "edit" : tool.id
  const rule = Permission.evaluate(permKey, "*", effectivePermission)
  return rule.action !== "deny"
})
```

**选项 B（UX 更好）**: 保留被 deny 的工具描述，但标注 `[Currently unavailable: use research_enter to switch to a mode with bash access]`:

```ts
for (const tool of allTools) {
  const permKey = EDIT_TOOLS.includes(tool.id) ? "edit" : tool.id
  const rule = Permission.evaluate(permKey, "*", effectivePermission)
  if (rule.action === "deny") {
    tool.description += `\n[Currently unavailable in this mode: ${rule.permission} is denied]`
  }
}
```

### 验收测试

```
T1.29: build agent（全权限）看到所有工具描述（不变）
T1.30: plan agent（edit deny）不看到 edit 工具描述（选项 A）或看到标注（选项 B）
T1.31: research agent（bash restricted）看到 alpha/docker 的 bash 工具，不看到 rm 的 bash 工具
```

---

## 完整验收清单

```
所有 Layer 1 改动完成后的验收步骤:

1. 在 Layer 0 已完成的基础上应用所有 Layer 1 改动
2. bun typecheck 在 packages/opencode 通过
3. 运行已有测试套件（无回归）
4. 创建 .opencode/agents/research.md (最小化测试版)
5. 验证:
   a. /research_enter 工具可用
   b. 切换到 research 后，permission 被 intersection 约束
   c. 切换到 research 后，skill_refs 生效（只看到指定 skills）
   d. 切换到 research 后，env_scope.allowed_commands 生效（bash 限制）
   e. research_exit 后恢复正常
   f. 不设 mcp 时 MCP 不受影响
   g. 不设 fallbackModels 时 API 失败行为不变
   h. background mode 正确 spawn + 取回结果
```
