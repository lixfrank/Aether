# Layer 1: Agent Infrastructure

> 前置依赖: Layer 0（Permission.intersection、Discipline.compile、Agent.Info 扩展、skill_refs 注入）
> 本文档是 6 层重构计划的第二层。在 Layer 0 完成后开始。
> 完成后，用户可以通过 UI dropdown 切换到新的 primary agent（如 research），所有 permission/skill_refs/env_scope/MCP/promptAppend 自动生效——**不需要改动 insertReminders()**。
> Background 执行功能已分离至 Layer 5（`layer-5-background-execution.md`），本层不再包含。

---

## 上下文

| Layer       | 状态            | 简介                                                                                              |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------- |
| Layer 0     | **已完成**      | 核心安全增强：intersection、compile、task 参数扩展、Info 扩展、skill_refs                         |
| **Layer 1** | **本文档**      | Agent 基础设施：output_dir、fallback_models、MCP per-agent、denied tools 优化                     |
| Layer 2     | 在 Layer 1 之后 | Research 配置层：agent/skill md 定义（零核心改动）                                                |
| Layer 3     | 在 Layer 2 之后 | MCP 服务器（convention lock、verification）、参考文档                                             |
| Layer 4     | 在 Layer 3 之后 | Publication 管线（write-paper、peer-review、respond-to-referees）                                 |
| Layer 5     | 在 Layer 4 之后 | Background 执行：异步 spawn + 信号注入 + 结果取回（独立层，见 `layer-5-background-execution.md`） |

---

## 改动 1.1: output_dir 配置与 SystemPrompt 注入

### 问题

每个 agent 需要知道自己的输出目录路径。硬编码路径不可接受（每个类似 agent 都要各自硬编码），需要基础设施层面的配置和注入。

### 为什么不需要改动 insertReminders()

当用户通过 UI dropdown 切换到 research agent 时，已有流程自动处理一切:

| 功能                    | 由谁处理                           | 需要 insertReminders()? |
| ----------------------- | ---------------------------------- | ----------------------- |
| permission intersection | resolveTools()（Layer 0）          | 不需要                  |
| promptAppend            | system prompt 组装                 | 不需要                  |
| skill_refs whitelist    | SystemPrompt.skills()（Layer 0）   | 不需要                  |
| scale_decision          | prompt_append 内文本（Layer 2）    | 不需要                  |
| MCP 工具过滤            | resolveTools()（改动 1.3）         | 不需要                  |
| denied tools 过滤       | resolveTools()（改动 1.4）         | 不需要                  |
| output_dir 路径         | SystemPrompt.outputDir()（本改动） | 不需要                  |

因此，**不改动 insertReminders()**。build→plan 和 plan→build 的已有逻辑保持不变。

### 文件

`packages/opencode/src/config/config.ts`（Config.Agent 新增 `output_dir` 字段）
`packages/opencode/src/agent/agent.ts`（Agent.Info 新增 `outputDir` 字段 + merge 循环处理）
`packages/opencode/src/session/system.ts`（新增 `SystemPrompt.outputDir()` 函数定义）
`packages/opencode/src/session/prompt.ts`（loop 中 system prompt 组装区域调用 `SystemPrompt.outputDir()`）

### Config.Agent 新增

```ts
output_dir: z.string().optional().describe("Output directory for agent artifacts, relative to project .aether/ root")
```

### Agent.Info 新增

```ts
outputDir: z.string().optional()
```

### Merge 循环新增

```ts
item.outputDir = value.output_dir ?? item.outputDir
```

### SystemPrompt.outputDir() 注入

在 `session/system.ts` 中新增（与 `skills` 同模块、同模式）:

```ts
export function outputDir(agent: Agent.Info): string | undefined {
  if (!agent.outputDir) return undefined
  return `Your output directory is at ${normalizeOutputDir(agent.outputDir)}. Write findings to this directory.`
}
```

在 prompt.ts loop 的 system prompt 组装区域调用（与 `SystemPrompt.skills(agent)` 并列）:

```ts
const outputDirInfo = SystemPrompt.outputDir(agent)
if (outputDirInfo) system.push(outputDirInfo)
```

### normalizeOutputDir

防止 `.aether/.aether/` 双重嵌套。`Instance.worktree`（已验证 `project/instance.ts:128-129`）返回 git worktree root（项目根路径）:

```ts
function normalizeOutputDir(dir: string): string {
  const projectDir = Instance.worktree
  const clean = dir.replace(/^\.aether\/+/, "")
  return path.join(projectDir, ".aether", clean)
}
```

无论用户写 `output_dir: "research"` 还是 `output_dir: ".aether/research"`，最终路径均为 `<projectDir>/.aether/research/`。notepad 子目录结构（sources.md/findings.md/gaps.md/learnings.md/report.md）由 agent 自身通过 bash/write 工具创建，不由基础设施自动创建。

### 验收测试

```
T1.1: 从 UI dropdown 选择 research 后，system prompt 中包含 output_dir 提醒（路径指向 .aether/research/）
T1.2: normalizeOutputDir("research") → .aether/research（不嵌套）
T1.3: normalizeOutputDir(".aether/research") → .aether/research（防止双重嵌套）
T1.4: agent 无 outputDir 时，system prompt 无 output_dir 提醒（backward compatible）
T1.5: build→plan 切换仍走 v0.6.0 BUILD_SWITCH 逻辑，不受影响
T1.6: bun typecheck 通过
```

---

## 改动 1.2: Subagent Fallback Models

### 问题

Subagent 使用的模型 API 可能失败（429/503/529/401/403），需要自动尝试 `fallback_models` 中的下一个模型。Primary agent 由用户手动选择模型，不自动 fallback。

### 文件

`packages/opencode/src/tool/task.ts`（定义 `promptWithFallback()` helper + serial 执行路径调用，不改 processor.ts）

### 设计

Fallback 逻辑在 task.ts 中，**不在 processor.ts 的 retry 循环中**。两者是不同层次的逻辑:

- processor.ts retry: **同一模型重试**（429 后等几秒再试同一模型）
- task.ts fallback: **切换不同模型**（同一模型重试耗尽后，尝试下一个 fallback 模型）

提取 `promptWithFallback()` 为 task.ts 内部 helper，serial 模式（Layer 1）和 background 模式（Layer 5）共用：

```ts
// tool/task.ts 内部 helper（不 export，仅本文件使用）
async function promptWithFallback(input: {
  sessionID: SessionID
  messageID: MessageID
  model: { modelID: string; providerID: string }
  agent: Agent.Info
  promptParts: SessionPrompt.PromptPart[]
  fallbackModels: Agent.Info["fallbackModels"]
}): Promise<unknown> {
  const modelsToTry = [input.model, ...(input.fallbackModels ?? [])].slice(0, 4)

  for (const model of modelsToTry) {
    try {
      return await SessionPrompt.prompt({
        messageID: input.messageID,
        sessionID: input.sessionID,
        model: { modelID: model.modelID, providerID: model.providerID },
        agent: input.agent.name,
        parts: input.promptParts,
      })
    } catch (e) {
      // 复用 AI SDK 的 APICallError.isRetryable 属性（覆盖 408/409/429/≥500）
      const isRetryable = (e as APICallError)?.isRetryable ?? false
      if (!isRetryable || model === modelsToTry[modelsToTry.length - 1]) throw e
    }
  }
  throw new Error("Unreachable")
}
```

Serial 执行路径调用：

```ts
const result = await promptWithFallback({
  sessionID: session.id,
  messageID,
  model,
  agent,
  promptParts,
  fallbackModels: agent.fallbackModels ?? [],
})
```

- `APICallError.isRetryable`：AI SDK 自动标记 408/409/429/≥500 为 retryable（`provider/error.ts` 中 `ProviderError.parseAPICallError()` 进一步解析 statusCode）。无需新建 `isRetryableApiError` 函数。
- `APICallError` 从 `@ai-sdk/provider` import
- Primary agent 不走此逻辑（用户手动选模型，失败报错）
- Fallback models 的 temperature/topP 等设置仅在当前 subagent 请求生效，不持久覆盖
- 所有 fallback 耗尽后: 报错，将错误信息返回给主 agent
- **Layer 5 background 模式复用此 helper**（改动 5.7 不再单独定义，直接调用）

### fallback_models 配置方式

**现阶段: 只通过 agent .md 文件配置，不在 UI 界面提供调整。**

- 内置 subagent（explorer、general）不设 `fallback_models`，使用 primary agent 用户手动选的模型
- 用户通过创建自定义 agent .md 文件指定 `fallback_models`（如 research.md 的 `fallback_models: [anthropic/claude-sonnet-4-5]`）
- 此字段通过 merge 循环 (`item.fallbackModels = value.fallback_models ?? item.fallbackModels`) 合入 Agent.Info
- UI 配置界面是独立功能，可在后续迭代添加

### 验收测试

```
T1.7: 不设 fallbackModels 时，subagent API 失败行为与 v0.6.0 一致
T1.8: 设 fallbackModels 时，subagent 429 错误触发自动降级到下一个模型
T1.9: primary agent 不走 fallback（用户手动选模型，失败报错）
T1.10: fallback 成功后，下一次 subagent 调用恢复 primary model 设置
T1.11: 所有 fallback 耗尽后，错误信息返回给主 agent
T1.12: bun typecheck 通过
```

---

## 改动 1.3: MCP Per-Agent 工具过滤

### 问题

v0.6.0 的 MCP 是全局的——所有 MCP 服务器对所有 agent 可见，无任何 per-agent 过滤。`MCP.tools()` 返回所有已连接 MCP 的全部工具，每个 agent 都看到它们。某些 agent（如 research）需要特定的 MCP 服务器（如 research-conventions），但这些 MCP 不应污染其他 agent 的 context window。

### 当前 MCP 与 Per-Agent 的差别

|                    | v0.6.0 当前                  | Per-Agent（本改动）                               |
| ------------------ | ---------------------------- | ------------------------------------------------- |
| MCP 服务器连接     | 全局，所有服务器始终连接     | **不变**——所有服务器始终连接（避免冷启动延迟）    |
| MCP 工具可见性     | 所有 agent 看到所有 MCP 工具 | 按 `agent.mcp` 配置过滤，只显示指定 server 的工具 |
| 过滤机制           | 无                           | `resolveTools()` 中根据 `agent.mcp` 过滤          |
| connect/disconnect | 无                           | **不需要**——过滤代替 connect/disconnect           |

### 文件

`packages/opencode/src/config/config.ts`（Config.Agent 新增 `mcp` 字段）
`packages/opencode/src/agent/agent.ts`（Agent.Info 新增 `mcp` 字段 + merge 循环处理）
`packages/opencode/src/session/prompt.ts`（`resolveTools()` 中添加 MCP 工具过滤）

### Config.Agent 新增

```ts
mcp: z.record(z.string(), z.boolean())
  .optional()
  .describe(
    "MCP servers whose tools should be visible to this agent. Keys are MCP server names; true = visible, false/absent = hidden. false is semantically equivalent to not listing the server — use it only for explicit documentation intent, not for distinct behavior.",
  )
```

### Agent.Info 新增

```ts
mcp: z.record(z.string(), z.boolean())
  .optional()
  .describe(
    "MCP servers whose tools should be visible to this agent. Keys are server names, values must be true to allow. False values have no distinct meaning (equivalent to omitting the key). Consider simplifying to z.array(z.string()) if only allow-list semantics are needed.",
  )
```

### Merge 循环新增

```ts
item.mcp = value.mcp ?? item.mcp
```

### resolveTools() 中的 MCP 过滤

所有 MCP 服务器始终连接（不做 connect/disconnect），在 `resolveTools()` 中根据 `agent.mcp` 过滤 MCP 工具。

**MCP tool ID 格式**（已验证 `mcp/index.ts:641-644`）：

MCP 工具 ID 格式为 `{sanitizedClientName}_{sanitizedToolName}`（单下划线分隔，**不是** `mcp__serverId__toolId`）。`sanitizedClientName` 由配置的 MCP server name 经 `replace(/[^a-zA-Z0-9_-]/g, "_")` 得出。例如 server `research-conventions` 的 tool `convention_lock_status` → ID `research_conventions_convention_lock_status`。

最可靠的过滤方式是在 MCP 工具迭代循环中直接过滤（而非事后按 ID 前缀猜测）：

```ts
// resolveTools() 中，MCP 工具迭代部分
const mcpEntries = Object.entries(await MCP.tools())

const filteredMcpEntries =
  agent.mcp !== undefined
    ? mcpEntries.filter(([key]) => {
        const allowedPrefixes = Object.entries(agent.mcp)
          .filter(([_, enabled]) => enabled)
          .map(([serverId]) => serverId.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
        return allowedPrefixes.some((prefix) => key.startsWith(prefix))
      })
    : mcpEntries

for (const [key, item] of filteredMcpEntries) {
  // ...existing MCP tool wrapping logic...
}
```

- `mcp` 未定义 → 显示所有 MCP 工具（与 v0.6.0 一致，backward compatible）
- `mcp` 已定义 → 只显示指定 server 的 MCP 工具，其余隐藏
- MCP 服务器始终连接，不因 agent 切换而 connect/disconnect（避免冷启动延迟）

### 验收测试

```
T1.22: agent 无 mcp 配置时，MCP 工具列表与 v0.6.0 一致（全部可见）
T1.23: research agent mcp={"research-conventions":true,"research-state":true} 时，只看到 research-conventions 和 research-state 的 MCP 工具
T1.24: build agent（无 mcp 配置）仍看到所有 MCP 工具
T1.25: bun typecheck 通过
```

---

## 改动 1.4: Denied Tools 显示优化

### 问题

v0.6.0 向所有代理展示全部工具描述，包括被 deny 的工具。浪费 context window，且让代理"看到工具却被拒绝"。

### 设计

**选定选项 A（过滤掉 denied 工具描述）**：在 `resolveTools()` 中过滤掉被 deny 的工具，不让 LLM 看到它们。

### 文件

`packages/opencode/src/permission/index.ts`（export `EDIT_TOOLS` 常量）
`packages/opencode/src/session/prompt.ts`（`resolveTools()` 中添加 denied tools 过滤）

### EDIT_TOOLS export

`EDIT_TOOLS` 已存在于 `permission/index.ts:322`（`["edit", "write", "apply_patch", "multiedit"]`），但未 export。需 export 以便 `resolveTools()` 使用：

```ts
// permission/index.ts
export const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]
```

### resolveTools() 中的 denied tools 过滤

在 `resolveTools()` 返回最终 tools dict 之前，过滤掉被 deny 的工具：

```ts
// resolveTools() 末尾，return tools 之前
const effectivePermission = Permission.merge(agent.permission, session.permission ?? [])
for (const key of Object.keys(tools)) {
  const permKey = EDIT_TOOLS.includes(key) ? "edit" : key
  const rule = Permission.evaluate(permKey, "*", effectivePermission)
  if (rule.action === "deny") delete tools[key]
}
```

改动 1.3 的 MCP 过滤和改动 1.4 的 denied tools 过滤在同一函数 `resolveTools()` 中，前者在 MCP 工具迭代中过滤（基于 `agent.mcp`），后者在最终返回前过滤（基于 `Permission.evaluate`）。两者互不干扰。

**resolveTools() 覆盖范围**（已验证）：`resolveTools()` 在 normal processing path 中被调用（prompt.ts:629），覆盖所有 LLM 能看到工具的场景。Subtask path（prompt.ts:358-542）不调用 `resolveTools()`，也不向任何 LLM 展示工具列表——它直接调用 `TaskTool.execute()` 创建子 session。子 session 的 loop 调用自己的 `resolveTools()`，过滤逻辑自动生效。因此 `resolveTools()` 中的过滤覆盖所有需要处理的路径。

### 验收测试

```
T1.26: build agent（全权限）看到所有工具描述（不变）
T1.27: plan agent（edit deny）不看到 edit/write/apply_patch/multiedit 工具描述
T1.28: research agent（bash restricted）看到 alpha/docker 的 bash 工具，不看到 rm 的 bash 工具
T1.29: EDIT_TOOLS export 后 prompt.ts 可正常 import 使用
```

---

## 完整验收清单

```
所有 Layer 1 改动完成后的验收步骤:

1. 在 Layer 0 已完成的基础上应用所有 Layer 1 改动
2. bun typecheck 在 packages/opencode 通过
3. 运行已有测试套件（无回归）
4. 创建 .aether/agent/research.md (最小化测试版)
5. 验证:
   a. 从 UI dropdown 选择 research 后，permission 被 intersection 约束
   b. 切换到 research 后，skill_refs 生效（只看到指定 skills）
   c. 切换到 research 后，env_scope.allowed_commands 生效（bash 限制）
   d. 切换到 research 后，system prompt 包含 output_dir 提醒（路径指向 .aether/research/）
   e. 切换到 research 后，只看到 mcp 配置指定的 MCP 工具
   f. 切换回 build 后，所有 MCP 工具重新可见（mcp 未定义）
   g. 不设 fallbackModels 时 subagent API 失败行为不变
   h. 设 fallbackModels 时 subagent 429 自动降级
   i. primary agent 不走 fallback
```
