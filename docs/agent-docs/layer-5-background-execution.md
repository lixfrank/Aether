# Layer 5: Background Execution

> 前置依赖: Layer 0 + Layer 1（Permission/Discipline/Agent.Info 扩展 + output_dir/fallback/MCP per-agent/denied tools）
> 本文档从原 Layer 1 改动 1.3 分离而来，作为独立层进行设计与实现。
> 不依赖 Layer 2-4。Layer 2-4 的功能在 background 不可用时退回 serial/concurrent 模式运行。
> 完成后，primary agent 可以以 background 模式派发 subagent，不等待结果继续工作，subagent 完成后自动注入信号，primary agent 通过 background_output 工具取回结果。

---

## 上下文

| Layer       | 状态       | 简介                                                     |
| ----------- | ---------- | -------------------------------------------------------- |
| Layer 0     | 已完成     | Permission/Discipline/Info 扩展、skill_refs              |
| Layer 1     | 已完成     | output_dir、fallback_models、MCP per-agent、denied tools |
| Layer 2     | 已完成     | Research 配置层（agent/skill md，零核心源改动）          |
| Layer 3     | 已完成     | MCP 服务器 + Skills/Scripts 计算层                       |
| Layer 4     | 已完成     | Publication 管线                                         |
| **Layer 5** | **本文档** | Background 执行：异步 spawn + 信号注入 + 结果取回        |

---

## 核心动机

当前 primary agent 与 subagent 的交互是串行的：primary 把任务交给 subagent → 等待执行完毕 → 取回结构化结果。Background 模式在此基础上增加非阻塞选项：

**primary 以 background 模式派发 subagent → 不等待 → primary 继续工作 → subagent 完成后自动注入信号 → primary 通过 background_output 取回结果**

这是对现有串行工作流的**额外不强**扩展，不改变 serial/concurrent 的已有行为。

---

## 改动 5.1: BackgroundTask 事件定义与 SQLite 持久化

### 文件

| 文件                                              | 类型 | 说明                                                   |
| ------------------------------------------------- | ---- | ------------------------------------------------------ |
| `packages/opencode/src/session/background.ts`     | 新增 | BackgroundTask namespace + 事件定义 + spawn + 信号注入 |
| `packages/opencode/src/session/background.sql.ts` | 新增 | background_task Drizzle 表定义                         |

### 事件定义

在 `background.ts` 中，必须在 `SyncEvent.init()` 调用之前加载（通过 `session/projectors.ts` import 触发）：

```ts
export namespace BackgroundTask {
  export const Event = {
    Created: SyncEvent.define({
      type: "background_task.created",
      version: 1,
      aggregate: "taskID",
      schema: z.object({
        taskID: z.string(),
        projectID: z.string(),
        info: z.object({
          id: z.string(),
          session_id: z.string(),
          parent_session_id: z.string(),
          status: z.string(),
          model_provider_id: z.string(),
          model_id: z.string(),
          agent: z.string(),
          description: z.string().optional(),
        }),
      }),
    }),
    StatusUpdated: SyncEvent.define({
      type: "background_task.status_updated",
      version: 1,
      aggregate: "taskID",
      schema: z.object({
        taskID: z.string(),
        projectID: z.string(),
        status: z.string(),
        resultSummary: z.string().optional(),
        errorMessage: z.string().optional(),
      }),
    }),
  }
}
```

### SQLite 表结构

遵循 codebase 的 Drizzle 表定义模式（snake_case、`...Timestamps`、索引在回调中定义）：

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import { SessionID } from "./schema"

export const BackgroundTaskTable = sqliteTable(
  "background_task",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull(),
    parent_session_id: text().$type<SessionID>().notNull(),
    status: text().notNull(),
    model_provider_id: text().notNull(),
    model_id: text().notNull(),
    agent: text().notNull(),
    description: text(),
    result_summary: text(),
    error_message: text(),
    ...Timestamps,
  },
  (table) => [
    index("background_task_parent_idx").on(table.parent_session_id),
    index("background_task_status_idx").on(table.status),
  ],
)
```

### Projector 注册

在 `session/projectors.ts` 中追加 2 条 projector 到默认导出数组：

```ts
import { BackgroundTask, BackgroundTaskTable } from "./background"

// ...existing projectors...

SyncEvent.project(BackgroundTask.Event.Created, (db, data) => {
  Database.useProject(data.projectID, (pdb) => {
    pdb.insert(BackgroundTaskTable).values(data.info).run()
  })
}),

SyncEvent.project(BackgroundTask.Event.StatusUpdated, (db, data) => {
  Database.useProject(data.projectID, (pdb) => {
    pdb
      .update(BackgroundTaskTable)
      .set({ status: data.status, result_summary: data.resultSummary, error_message: data.errorMessage })
      .where(eq(BackgroundTaskTable.id, data.taskID))
      .run()
  })
}),
```

`background.ts` 通过 `session/projectors.ts` 的 import 在 `SyncEvent.init()` 之前加载，无需修改 `server/projectors.ts`。

---

## 改动 5.2: BackgroundTask 内存层与 spawn

### 内存 Registry

```ts
namespace BackgroundTask {
  const tasks = new Map<
    string,
    {
      sessionID: SessionID
      parentSessionID: SessionID
      promise: Promise<unknown>
      status: "running" | "completed" | "failed" | "cancelled"
      result?: unknown
      error?: Error
    }
  >()

  export function get(taskID: string) {
    return tasks.get(taskID)
  }

  export function activeCount() {
    return [...tasks.values()].filter((t) => t.status === "running").length
  }
}
```

### spawn()

在 task.ts 中 `mode: background` 时调用。**在 session 创建和 permission 计算之后、prompt 执行之前分叉**：

```ts
export async function spawn(input: {
  sessionID: SessionID
  parentSessionID: SessionID
  agent: Agent.Info
  model: { modelID: string; providerID: string }
  promptParts: SessionPrompt.PromptPart[]
  description: string
}): string {
  const maxConcurrent = 5
  if (activeCount() >= maxConcurrent) throw new Error("Too many concurrent background tasks (max 5)")

  const taskID = ID.ascending("bgt_")
  const messageID = MessageID.ascending()

  const entry = {
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    promise: promptWithFallback({
      sessionID: input.sessionID,
      messageID,
      model: input.model,
      agent: input.agent,
      promptParts: input.promptParts,
      fallbackModels: input.agent.fallbackModels ?? [],
    }),
    status: "running" as const,
  }
  tasks.set(taskID, entry)

  SyncEvent.run(BackgroundTask.Event.Created, {
    taskID,
    projectID: Instance.project.id,
    info: {
      id: taskID,
      session_id: input.sessionID,
      parent_session_id: input.parentSessionID,
      status: "running",
      model_provider_id: input.model.providerID,
      model_id: input.model.modelID,
      agent: input.agent.name,
      description: input.description,
    },
  })

  entry.promise
    .then(async (result) => {
      entry.status = "completed"
      entry.result = result
      const summary = extractSummary(result)
      SyncEvent.run(BackgroundTask.Event.StatusUpdated, {
        taskID,
        projectID: Instance.project.id,
        status: "completed",
        resultSummary: summary,
      })
      await injectCompletionSignal(input.parentSessionID, taskID, input.description)
    })
    .catch(async (error) => {
      entry.status = "failed"
      entry.error = error
      SyncEvent.run(BackgroundTask.Event.StatusUpdated, {
        taskID,
        projectID: Instance.project.id,
        status: "failed",
        errorMessage: error.message,
      })
      await injectFailureSignal(input.parentSessionID, taskID, input.description, error)
    })

  return taskID
}
```

**关键设计决策**：

- background task 的 detached promise **不监听 primary session 的 step abort**（`ctx.abort`）。Background task 有自己的生命周期。
- **fallback_models 复用 Layer 1 的逻辑**：`promptWithFallback()` 是从 task.ts 的改动 1.2 提取的公共 helper，serial 和 background 模式共用。
- `extractSummary()` 截取 result 的最后 text part 至 2000 字符，用于 SQLite 持久化。

---

## 改动 5.3: 信号注入机制

### 问题

LLM agent 是消息驱动的，不会主动 poll。如果 background task 完成后不向 primary session 注入任何内容，primary agent 不知道 task 已完成，永远不会调用 background_output。

### 设计

Background task 完成后，向 primary session 注入一条**合成用户消息**，与 codebase 已有模式一致（`prompt.ts:516-538` 的 `task.command` 合成消息）：

```ts
async function injectCompletionSignal(parentSessionID: SessionID, taskID: string, description: string) {
  const msg: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: parentSessionID,
    role: "user",
    time: { created: Date.now() },
    agent: await lastAgent(parentSessionID),
    model: await lastModel(parentSessionID),
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: parentSessionID,
    type: "text",
    text: `Background task "${description}" (task_id: ${taskID}) has completed. Use background_output with this task_id to retrieve results.`,
    synthetic: true,
  } satisfies MessageV2.TextPart)
}

async function injectFailureSignal(parentSessionID: SessionID, taskID: string, description: string, error: Error) {
  const msg: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: parentSessionID,
    role: "user",
    time: { created: Date.now() },
    agent: await lastAgent(parentSessionID),
    model: await lastModel(parentSessionID),
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: parentSessionID,
    type: "text",
    text: `Background task "${description}" (task_id: ${taskID}) has failed: ${error.message}. Use background_output with this task_id for details.`,
    synthetic: true,
  } satisfies MessageV2.TextPart)
}
```

`lastAgent()` 和 `lastModel()` 从 primary session 的消息流中获取最近的 agent/model 信息，确保合成消息与 session 上下文一致。

这条消息进入 primary session 的 `MessageV2.stream()` 后，loop 的下一次 iteration 自然拾取，primary agent 看到通知并调用 `background_output`。

**不改动 `loop()` 函数本身**——信号注入完全通过 `Session.updateMessage` + `Session.updatePart` 在消息流中插入内容，loop 的现有逻辑自动处理。

---

## 改动 5.4: task.ts 中的 background 分支

### 文件

`packages/opencode/src/tool/task.ts`（在 execute() 函数中追加 background 分支）

### 设计

Background 分支在 **session 创建之后、prompt 执行之前**分叉。步骤 1-5（权限、agent、permission、session、model）完全共用——background task 仍需完整的权限隔离和子 session。

在 `execute()` 函数中，在 `SessionPrompt.resolvePromptParts()` 之后、serial `SessionPrompt.prompt()` 调用之前插入 background 分支：

```ts
const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

// Background mode: spawn detached, return taskID immediately
if (params.mode === "background") {
  const taskID = await BackgroundTask.spawn({
    sessionID: session.id,
    parentSessionID: ctx.sessionID,
    agent,
    model,
    promptParts,
    description: params.description,
  })
  return {
    title: params.description,
    metadata: { sessionId: session.id, model, backgroundTaskID: taskID },
    output: `task_id: ${taskID}\nBackground task started. You will be notified when it completes. Use background_output with this task_id to retrieve results.`,
  }
}

// Serial/concurrent mode: existing behavior (await prompt)
const result = await SessionPrompt.prompt({
  messageID,
  sessionID: session.id,
  model: { modelID: model.modelID, providerID: model.providerID },
  agent: agent.name,
  parts: promptParts,
})
// ...existing result formatting...
```

**关键**：background 分支不监听 `ctx.abort`（step abort）。Background task 的 abort 传播通过改动 5.6 处理。

### Task tool description 更新

需要更新 `task.txt`，告知 LLM background 模式的用法。在现有 description 基础上追加：

```
The `mode` parameter controls how subagent tasks run:
- "serial" (default): Wait for the subagent to finish and return results inline.
- "concurrent": Same as serial, but signals intent for parallel execution when multiple tasks are dispatched.
- "background": Return immediately with a task_id. The subagent runs asynchronously. When it completes, a notification message will appear in your conversation. Use the `background_output` tool with the task_id to retrieve results.
```

---

## 改动 5.5: background_output 工具

### 文件

`packages/opencode/src/tool/background-output.ts`（新增）
`packages/opencode/src/tool/registry.ts`（`all()` 列表追加）

### 工具可用性

`background_output` 对**所有 agent 始终可用**（轻量查询工具，无副作用，不消耗 context window）。仅 spawn 了 background task 的 agent 会实际调用它。

### 工具定义

```ts
import { Tool } from "./tool"
import z from "zod"
import { BackgroundTask } from "../session/background"

const parameters = z.object({
  task_id: z.string().describe("The background task ID to retrieve results for"),
})

export const BackgroundOutputTool = Tool.define("background_output", {
  description:
    "Retrieve the results of a background task. Returns status and output if completed, or current status if still running.",
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const task = BackgroundTask.get(params.task_id)
    if (!task) {
      // 内存无记录，查 SQLite
      const row = Database.useProject(Instance.project.id, (db) =>
        db.select().from(BackgroundTaskTable).where(eq(BackgroundTaskTable.id, params.task_id)).get(),
      )
      if (!row) {
        return { title: "Not found", metadata: {}, output: `No background task found with id: ${params.task_id}` }
      }
      if (row.status === "running") {
        return {
          title: "Still running",
          metadata: { status: row.status },
          output: `Background task ${params.task_id} is still running.`,
        }
      }
      if (row.status === "completed") {
        return {
          title: "Task completed",
          metadata: { status: row.status },
          output: row.result_summary ?? "Task completed but no summary available. Check the subagent session directly.",
        }
      }
      if (row.status === "failed") {
        return {
          title: "Task failed",
          metadata: { status: row.status },
          output: `Background task failed: ${row.error_message ?? "unknown error"}`,
        }
      }
      return {
        title: `Task ${row.status}`,
        metadata: { status: row.status },
        output: `Background task status: ${row.status}`,
      }
    }

    if (task.status === "running") {
      return {
        title: "Still running",
        metadata: { status: task.status },
        output: `Background task ${params.task_id} is still running.`,
      }
    }
    if (task.status === "completed") {
      const text = (task.result as any)?.parts?.findLast((x: any) => x.type === "text")?.text ?? ""
      return { title: "Task completed", metadata: { status: task.status, sessionId: task.sessionID }, output: text }
    }
    if (task.status === "failed") {
      return {
        title: "Task failed",
        metadata: { status: task.status },
        output: `Background task failed: ${task.error?.message ?? "unknown error"}`,
      }
    }
    if (task.status === "cancelled") {
      return { title: "Task cancelled", metadata: { status: task.status }, output: `Background task was cancelled.` }
    }
    return {
      title: `Task ${task.status}`,
      metadata: { status: task.status },
      output: `Background task status: ${task.status}`,
    }
  },
})
```

**设计决策**：

- **不阻塞等待**：running task 直接返回状态，不设 60s timeout。LLM 应在收到完成信号后调用，不需要阻塞等待。
- **双层取回**：先查内存 Map（实时完整结果），内存无记录时查 SQLite（持久化摘要）。完整结果取自内存 Map 的 `result.parts`；SQLite 的 `result_summary` 是截断备份。
- **primary session 关闭后的取回**：内存 Map 被清理后，SQLite 的 `result_summary` 只有 2000 字符。如需完整结果，可从子 session 的 `MessageV2.stream()` 取最后 assistant message 的 text part（子 session 消息已通过现有 projector 持久化）。
- **始终对所有 agent 可用**：`background_output` 是轻量查询工具（无副作用、不修改状态），注册在 `ToolRegistry.all()` 中对所有 agent 可见。只有实际 spawn 了 background task 的 agent 才会调用它。未 spawn background task 时调用仅返回 "Not found"。

### Registry 注册

```ts
// registry.ts 的 all() 函数中
import { BackgroundOutputTool } from "./background-output"

return [
  InvalidTool,
  // ...existing tools...
  BackgroundOutputTool,
  ...custom,
]
```

---

## 改动 5.6: Abort 传播与内存清理

### Step abort vs Session close

两种 abort 的语义不同：

| 场景                        | 触发                      | 对 background task 的影响                                  |
| --------------------------- | ------------------------- | ---------------------------------------------------------- |
| 用户取消当前 assistant 回复 | `ctx.abort`（step abort） | **不传播**——background task 继续运行                       |
| 用户关闭/删除 session       | `Session.Event.Deleted`   | **标记 cancelled**——停止所有关联的 running background task |

### Session delete 时的取消

**注意**：`SyncEvent.init()` 用 `new Map(input.projectors)` 构建 projector Map，同一事件只能有一个 projector——新增第二条会覆盖第一条。因此清理逻辑必须追加到 `session/projectors.ts` 中**现有的** `Session.Event.Deleted` projector 函数内部，而非新增一个 projector 条目。

```ts
// session/projectors.ts 中，修改现有的 Session.Event.Deleted projector 函数体
SyncEvent.project(Session.Event.Deleted, (db, data) => {
  Database.useProject(Instance.project.id, (pdb) => {
    pdb.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  })

  // ↓ Layer 5 追加：Cancel all background tasks whose parent_session_id matches
  for (const [taskID, entry] of BackgroundTask.tasks.entries()) {
    if (entry.parentSessionID === data.sessionID && entry.status === "running") {
      entry.status = "cancelled"
      SessionPrompt.cancel(entry.sessionID)
      SyncEvent.run(BackgroundTask.Event.StatusUpdated, {
        taskID,
        projectID: Instance.project.id,
        status: "cancelled",
      })
    }
  }
})
```

### 内存清理

**触发时机**：`Session.Event.Deleted` 时清理内存 Map 中关联条目（与取消逻辑同处）。

```ts
// 在 Session.Event.Deleted projector 中
for (const [taskID, entry] of BackgroundTask.tasks.entries()) {
  if (entry.parentSessionID === data.sessionID) {
    BackgroundTask.tasks.delete(taskID)
  }
}
```

**不清理的时机**：session 只是"不再活跃"（用户切到别的 session）——background task 可能还在运行，内存 Map 保留。

---

## 改动 5.7: promptWithFallback 复用

### 背景

`promptWithFallback()` 已在 Layer 1 改动 1.2 中定义为 task.ts 内部 helper（serial 模式已使用）。Background 模式的 detached promise 直接复用此 helper，无需重新定义。

### 使用方式

background spawn 的 `promptWithFallback` 调用与 serial 模式相同：

```ts
// 改动 5.2 spawn() 中已有的调用（无需新增代码）
promise: promptWithFallback({
  sessionID: input.sessionID,
  messageID,
  model: input.model,
  agent: input.agent,
  promptParts: input.promptParts,
  fallbackModels: input.agent.fallbackModels ?? [],
})
```

**无需额外改动 task.ts**——helper 在 Layer 1 已定义，Layer 5 直接调用即可。

---

## 完整文件改动清单

| 文件                                              | 类型 | 说明                                                                                                                  |
| ------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/session/background.ts`     | 新增 | BackgroundTask namespace + Event 定义 + spawn + 信号注入                                                              |
| `packages/opencode/src/session/background.sql.ts` | 新增 | BackgroundTaskTable Drizzle 表定义                                                                                    |
| `packages/opencode/src/tool/background-output.ts` | 新增 | background_output 工具                                                                                                |
| `packages/opencode/src/tool/task.ts`              | 修改 | background 分支（promptWithFallback 已在 Layer 1 定义，直接调用）                                                     |
| `packages/opencode/src/tool/task.txt`             | 修改 | 追加 mode 参数说明                                                                                                    |
| `packages/opencode/src/tool/registry.ts`          | 修改 | all() 列表追加 BackgroundOutputTool                                                                                   |
| `packages/opencode/src/session/projectors.ts`     | 修改 | 修改现有 Session.Event.Deleted projector 函数体（追加 background task 取消+清理），追加 BackgroundTask 2 条 projector |

---

## 验收测试

```
T5.1: 不使用 background mode 时，task tool 行为与 v0.6.0 一致（serial）
T5.2: mode=background 的 task 立即返回 taskID，primary agent 不等待
T5.3: background task 完成后，primary session 消息流中出现合成通知消息
T5.4: primary agent 收到通知后调用 background_output，取回完整结果
T5.5: background_output 对 running task 返回 "still running"（不阻塞等待）
T5.6: background_output 对 completed task 返回完整 text 结果（从内存 Map）
T5.7: background_output 对 failed task 返回错误信息
T5.8: background_output 在内存 Map 被清理后，从 SQLite 取回截断摘要
T5.9: promptWithFallback 在 background task 中也生效（429 自动降级）
T5.10: primary agent 的 step abort（ctx.abort）不传播到 background task
T5.11: session 删除时，关联的 running background task 被标记 cancelled
T5.12: session 删除时，内存 Map 中关联条目被清理，SQLite 记录保留
T5.13: 并发超过 5 时返回错误（不排队）
T5.14: background_task SQLite 表正确记录 status/model/agent/timestamps
T5.15: BackgroundTask Event.Created 和 StatusUpdated 正确通过 SyncEvent 投影写入 SQLite
T5.16: fallback_models 逻辑在 serial 和 background 模式共用 promptWithFallback()
T5.17: bun typecheck 通过
T5.18: 删除 background 相关代码后，task tool 退回 v0.6.0 serial 行为
```

---

## 回退安全

- 删除 `background.ts`、`background.sql.ts`、`background-output.ts` + 移除 task.ts 的 background 分支 + 移除 registry.ts 的 BackgroundOutputTool 后，task tool 退回 v0.6.0 的 serial/concurrent 行为。
- Layer 2-4 的 `scale_decision` 中 `mode: background` 规则退回 `mode: concurrent`（在 Layer 2 适配改动中已暂改）。
- Background task 的 SQLite 数据不影响其他功能（独立表，独立 projector）。
