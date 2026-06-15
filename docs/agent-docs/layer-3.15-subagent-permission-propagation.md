# Layer 3.15: Subagent Permission Request Propagation — Web UI Task 卡片权限阻塞提示

> 前置依赖: Layer 0-3.14（所有已完成层）
> 本文档解决 Web UI 中 subagent 权限请求和问题请求在 Task 卡片上无视觉提示的问题。Web UI 已有完善的 toast 通知机制（layout.tsx 中监听 `permission.asked` / `question.asked` 事件弹 persistent toast + "Go to session" 按钮），但 Task 卡片本身没有阻塞状态提示——当 subagent 正在等待权限批准或用户回答问题时，Task 卡片只显示 agent title + description 链接，没有任何视觉线索表明 subagent 正在被阻塞。
> 修改范围：Web UI 层改动——data.tsx DataProvider 扩展 permission/question getters + ui 包 utils/session-pending.ts 新增 BFS 工具函数 + message-part.tsx 渲染逻辑 + 17 个 i18n locale 文件新增 key。不改 Permission Service、不改 Question Service、不改 SSE 事件 schema、不改 SDK 类型、不改 DB schema、不改 toast/通知机制、不改 Data 类型定义。

---

## 1. 问题分析

### 1.1 核心问题

当 subagent（如 research-worker）需要 `ask` 级别权限时，后端发送 `permission.asked` SSE 事件。当 subagent 使用 `question` 工具向用户提问时，后端发送 `question.asked` SSE 事件。Web UI 的 event-reducer 按 `sessionID` 分别存入 `store.permission[subagentSessionID]` 和 `store.question[subagentSessionID]`。

Web UI 的权限/问题显示模型是 **per-session** 的：每个 session 视图的 composer state 只处理当前 session 的请求（`sessionCurrentPermissionRequest` 和 `sessionCurrentQuestionRequest` 只查 `request[sessionID]`）。这意味着：

- **在 subagent session 视图中**：PermissionDock / QuestionDock 正常显示并可操作 ✅
- **在 root session 视图中**：composer state 只查当前 session 的请求 → 不包含 subagent 的请求 → PermissionDock / QuestionDock 不显示

> **注**：`packages/app/src/pages/session/composer/session-request-tree.ts` 已实现了 BFS 遍历子 session tree 的 `sessionPermissionRequest` / `sessionQuestionRequest` 函数，可从当前 session 向下遍历所有子 session 查找第一个 pending request。但 `packages/app/src/pages/session/composer/session-composer-state.ts:14` 使用的是 `sessionCurrentPermissionRequest` / `sessionCurrentQuestionRequest`（仅查当前 session），而非 tree 遍历版本。这是一个已有但未使用的功能——本方案不改 composer state 的 per-session 逻辑（因为 PermissionDock/QuestionDock 的操作语义是"当前 session 的请求"，跨层级聚合操作会引入复杂度），而是在 Task 卡片层面提供持续性视觉提示。

用户在 root session 视图时的体验缺口：

**缺口 A：Task 卡片无阻塞提示**

root session 视图中，subagent 以 Task 工具卡片的形式展示。当 subagent 正在等待权限批准或问题回答时，Task 卡片只显示 spinner + agent title + description 链接，**没有任何视觉线索表明 subagent 正在被阻塞**。用户必须依赖 toast 弹窗才知道需要跳转处理。

**缺口 B：多层 subagent 的阻塞请求无提示**

当 subagent 再次 dispatch 子 subagent（如 research-worker → explore），子 subagent 的 permission/question 请求按子 subagent 的 sessionID 存储在 `store.permission[childSessionID]` / `store.question[childSessionID]` 中。一级 Task 卡片只检查一级 subagent session 的请求，**不会检测嵌套子 subagent 的阻塞请求**。

**Toast 通知已存在且运行正确**

`packages/app/src/pages/layout.tsx` 监听 `permission.asked` 和 `question.asked` 事件，当 `shouldNotify()` 判断请求不是来自当前正在查看的 session 时，弹 persistent toast（placement: top-center, guarded: true）+ 系统通知 + 声音提示。toast 包含 "Go to session" 按钮，点击跳转到发出请求的 session。`permission.replied` / `question.replied` / `question.rejected` 事件到达时自动 dismiss toast。此机制**不需要修改**。

### 1.2 实际影响

research agent 的 Path 3 状态机大量使用 subagent dispatch：

- **一级 dispatch**：coordinator → research-worker（10 个 phase 各 dispatch 一次）
- **二级 dispatch**：research-worker → explore / general / local-executor 等

权限配置中 `external_directory: ask` 是最常见的需要用户批准的权限。MCP 工具调用也需要 `ctx.ask({permission: key})`。`question` 工具被多个 skill 使用（如 brainstorming、arxiv-search 等），subagent 通过 `ctx.ask()` 或 `question` 工具向用户提问时同样会产生阻塞。

当用户错过 toast 时：

- subagent indefinitely blocked（等待 deferred resolve/reject）
- coordinator 的 task 工具调用也被阻塞
- 用户在 root session 看到 Task 卡片 spinner 但不知道原因
- 可能导致整个 research 流程卡住

Task 卡片的阻塞提示是**持续性的视觉信号**——不像 toast 是短暂的弹窗——用户任何时候回头看对话都能看到阻塞提示。

### 1.3 不修改的部分

以下机制**运行正确，不需要修改**：

| 机制                                             | 状态    | 原因                                                             |
| ------------------------------------------------ | ------- | ---------------------------------------------------------------- |
| Permission Service 的 ask/reply/deferred         | ✅ 正确 | 核心逻辑无误                                                     |
| Question Service 的 ask/reply/reject/deferred    | ✅ 正确 | 与 Permission Service 同构的 deferred 模式                       |
| SSE 事件的 sessionID 携带                        | ✅ 正确 | 按原始 sessionID 存储和 reply 是正确设计                         |
| event-reducer.ts 的 permission/question 存储     | ✅ 正确 | 按原始 sessionID 存储，不需要传播                                |
| layout.tsx 的 toast 通知                         | ✅ 正确 | persistent + guarded + "Go to session" 按钮 + cooldown + dismiss |
| shouldNotify() 跨 session 通知判断               | ✅ 正确 | 不在请求 session 时才通知                                        |
| platform.notify() 系统通知                       | ✅ 正确 | 有 settings 开关                                                 |
| sounds 权限声音提示                              | ✅ 正确 | 有 settings 开关                                                 |
| sessionCurrentPermissionRequest per-session 逻辑 | ✅ 正确 | 每个 session 视图只处理自己的权限是正确设计                      |
| sessionCurrentQuestionRequest per-session 逻辑   | ✅ 正确 | 每个 session 视图只处理自己的问题是正确设计                      |
| PermissionDock 在 subagent session 视图中的显示  | ✅ 正确 | 跳转后能正常显示并可操作                                         |
| QuestionDock 在 subagent session 视图中的显示    | ✅ 正确 | 跳转后能正常显示并可操作                                         |
| permission.tsx 的 auto-respond 过滤              | ✅ 正确 | 自动批准不弹 toast，不需要修改                                   |

**需要改善的是：在 Task 卡片上添加持续的视觉提示，让用户在错过 toast 后仍然能看到 subagent 正在被权限或问题请求阻塞，并覆盖多层 subagent 的嵌套阻塞检测。**

---

## 2. 当前实现追踪

### 2.1 Web UI Task 工具卡片渲染

`packages/ui/src/components/message-part.tsx:1706-1759`（当前实际代码）：

Task 工具注册的 render 函数使用 `BasicTool` 组件，通过 `trigger` prop 渲染卡片标题区：

```tsx
ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const location = useLocation()
    const childSessionId = () => props.metadata.sessionId as string | undefined
    const type = createMemo(() => {
      const raw = props.input.subagent_type
      if (typeof raw !== "string" || !raw) return undefined
      return raw[0]!.toUpperCase() + raw.slice(1)
    })
    const title = createMemo(() => agentTitle(i18n, type()))
    const subtitle = createMemo(() => {
      const value = props.input.description
      if (typeof value === "string" && value) return value
      return childSessionId()
    })
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
          <Show when={subtitle()}>
            <Switch>
              <Match when={href()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={href()!}
                  onClick={(e) => e.stopPropagation()}
                >
                  {subtitle()}
                </a>
              </Match>
              <Match when={true}>
                <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
              </Match>
            </Switch>
          </Show>
        </div>
      </div>
    )

    return <BasicTool icon="task" status={props.status} trigger={trigger()} hideDetails />
  },
})
```

关键信息：

- `props.metadata.sessionId` 是 subagent session 的 ID
- `subtitle` 是 `createMemo`：当 `props.input.description` 为非空字符串时返回 description，否则返回 `childSessionId()`
- subtitle 有 `href` 时渲染为 `<a>` 标签（带 `onClick={(e) => e.stopPropagation()}`），无 `href` 时渲染为 `<span>`
- `<a>` 链接点击可跳转到 subagent session
- **没有任何对 `data.store.permission` 或 `data.store.question` 的检查**——不检测 subagent 是否有 pending request
- `hideDetails` 使卡片不展开详情区
- `titleContent` 是单独的 memo 函数（不是内联 JSX），引用 `{titleContent()}`

### 2.2 Web UI Data context 的 permission 和 question 数据

`packages/ui/src/context/data.tsx`（当前实际代码）：

```tsx
import type { Message, Session, Part, FileDiff, SessionStatus, ProviderListResponse } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

type Data = {
  provider?: ProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
    }
  },
})
```

**关键设计决策：为什么不在 `Data` 类型中添加 `permission` / `question` 字段**

`Data` 类型是 UI 包（`packages/ui`）的**抽象层接口**，职责是描述 UI 渲染所需的**通用数据结构**。`permission` 和 `question` 属于 **app 层（`packages/app`）的业务数据**——它们是 session 请求状态，与 Permission Service 和 Question Service 的运行时 deferred 模型绑定。

`Data` 类型刻意不含这些字段，是合理的分层设计：

1. `Data` 描述的是**任何 DataProvider 都应提供的基础数据**（session、message、part、diff 等是与 UI 渲染直接绑定的核心数据）
2. `permission` / `question` 只有 `global-sync` DataProvider 才提供——它们来自 `packages/app/src/context/global-sync/types.ts` 的 `State` 类型，是 app 层的完整运行时状态
3. 如果在 `Data` 类型中添加 `permission?` / `question?`，可选字段 `?` 会掩盖运行时差异——UI 包的组件可能假设这些字段总是存在（因为 global-sync 总是提供），但未来非 global-sync DataProvider 不提供时，组件行为会不可预测

**运行时数据流**：`DataProvider` 传入 `sync.data`（`State` 类型，包含 `permission` 和 `question`），`data.store` getter 返回整个 `State` 对象。运行时 `data.store.permission[sid]` 和 `data.store.question[sid]` 实际存在且可访问，只是 TypeScript 类型 `Data` 未声明这些字段。

**本方案的策略**：不改 `Data` 类型，而是在 `DataProvider` 的 init 函数中增加 `permission` 和 `question` getter，将 app 层业务数据**显式暴露**给 UI 包组件，保持 `Data` 抽象层的纯净性。

`packages/app/src/pages/directory-layout.tsx:26`：

```tsx
<DataProvider data={sync.data} directory={props.directory} ...>
```

`sync.data` 的类型是 `Store<State>`，包含 `permission` 和 `question` 字段。运行时通过 `data.store.permission[sid]` 和 `data.store.question[sid]` 可以访问 subagent session 的权限和问题数据。

### 2.3 响应性链（SolidJS reactivity）

Task 卡片使用 `data.permission(sid)` 和 `data.question(sid)` 的响应性依赖：

1. `sync.data` 是 `Store<State>`，由 `packages/app/src/context/global-sync/child-store.ts:166-190` 的 `createStore<State>({ permission: {}, question: {}, ... })` 创建
2. `event-reducer.ts:310-382` 通过 `setStore("permission", sessionID, ...)` 和 `setStore("question", sessionID, ...)` 更新 store
3. SolidJS `createStore` 对嵌套属性路径的 `setStore` 操作触发细粒度响应式更新
4. `data.tsx` 的 `get store() { return props.data }` 暴露 `Store<State>` 对象
5. 新增的 `permission: (sid) => props.data.permission?.[sid]` 和 `question: (sid) => props.data.question?.[sid]` getter 通过 `props.data.permission[sid]` 和 `props.data.question[sid]` 读取——SolidJS 会自动跟踪这些嵌套属性的变更

**getter 函数的 SolidJS 响应性验证**：

`createSimpleContext`（`packages/ui/src/context/helper.tsx:3-37`）的 provider 函数调用 `const init = input.init(props)` 生成一个普通 JavaScript 对象，然后将其作为 `<ctx.Provider value={init}>` 的 context value。`init` 对象本身**不是** reactive proxy——它的 getter 属性（`permission(sid)`、`question(sid)`）是普通函数。

关键在于：SolidJS 的响应性追踪发生在**调用侧**，而非**定义侧**。当 `permission(sid)` getter 在 `createMemo` 的跟踪作用域（tracking scope）内被调用时，SolidJS 会追踪 getter 函数体内访问的所有响应式数据源。具体追踪链：

1. `pending = createMemo(() => hasPendingRequest(..., (id) => data.permission(id), ...))` — `createMemo` 创建跟踪作用域
2. `(id) => data.permission(id)` 在 memo 内被 `hasPendingRequest` BFS 循环调用
3. `data.permission(id)` 执行 getter 函数体 `props.data.permission?.[id]`
4. `props.data` 是 `Store<State>` — SolidJS 的 `createStore` 返回的 reactive proxy
5. 访问 `Store<State>` 的 `permission[id]` 属性触发 SolidJS 的细粒度响应式追踪

**这条追踪链的正确性已被项目现有代码验证**：`data.store.message?.[props.sessionID]`（`session-turn.tsx:183`）、`data.store.session_status[props.sessionID]`（`session-turn.tsx:333`）等模式都在 `createMemo` 内访问 `Store<State>` 的嵌套属性，并正确实现响应式更新。新增的 `data.permission(sid)` / `data.question(sid)` getter 使用完全相同的模式。

因此，当 `permission.asked` / `permission.replied` / `question.asked` / `question.replied` / `question.rejected` SSE 事件到达并触发 `setStore` 操作时，`pending` memo 会自动重算，Task 卡片的视觉提示会自动更新——**无需手动订阅事件，SolidJS 的细粒度响应式系统保证数据到视图的自动同步**。

### 2.4 Session tree 结构与多层 subagent

`State` 中的 `session: Session[]` 包含所有 session（包括子 subagent 的 session）。每个 `Session` 对象有 `parentID` 字段，指向其父 session。

`packages/app/src/pages/session/composer/session-request-tree.ts:3-34` 已实现了基于 `parentID` 的 BFS 遍历逻辑（`sessionTreeRequest`）：从当前 session 向下遍历所有子 session，查找第一个有 pending request 的 session。该函数被 `sessionPermissionRequest` 和 `sessionQuestionRequest` 使用。

但 `session-request-tree.ts` 位于 **app 包**（`packages/app`），不在 **UI 包**（`packages/ui`）。UI 包的组件无法直接 import app 包的模块（依赖方向是 `app → ui`，不能反向）。因此本方案在 **UI 包**的 `packages/ui/src/utils/` 中新增 `session-pending.ts` 工具函数，实现等效的 BFS 遍历逻辑，使 Task 卡片能检测子 session tree 中是否存在 pending permission 或 question。

> **放置位置选择**：`packages/ui/src/utils/` 目录当前不存在，需要新建。考虑了两个候选位置：
>
> - **`packages/app/src/utils/`**：已有 40+ 个工具文件，是 app 包的既定 utils 目录。但 `message-part.tsx`（`hasPendingRequest` 的唯一消费者）位于 **UI 包**，无法 import app 包模块。此选项不可行。
> - **`packages/ui/src/utils/`**（本方案选择）：`hasPendingRequest` 是纯逻辑函数（无 UI 渲染依赖、无 SolidJS 依赖），放置在 UI 包的独立 `utils/` 子目录中。UI 包的 `package.json` exports 映射不包含 `./utils/*`，但 `message-part.tsx` 通过相对路径 `"../utils/session-pending"` import 即可——与现有 `"../context"` 等相对 import 模式一致。新增 `utils/` 目录是合理的扩展——未来其他纯逻辑工具函数（如数据转换、格式化等）也可放置于此。

Task 卡片可以利用 session tree 数据（`data.store.session` + 通过新增 getter 获取的 `data.permission(sid)` / `data.question(sid)`）构建子 session tree，BFS 遍历检测所有子 session（包括嵌套子 subagent）是否有 pending permission 或 question。

### 2.5 Web UI 权限/问题通知机制（不需要修改）

`packages/app/src/pages/layout.tsx`：

监听 `globalSDK.event`，当收到 `permission.asked` 或 `question.asked` 事件时：

1. 检查 `shouldAutoRespond` → 如果可自动批准则跳过通知（仅 permission.asked）
2. `shouldNotify()` → 当 `dir !== current_dir || session_id !== current_session` 时才通知（即不在发出请求的 session 视图时）
3. 弹 persistent toast：placement: top-center, guarded: true, actions: ["Go to session", "Dismiss"]
4. 可选：`platform.notify()` 系统通知 + `playSoundById()` 声音提示
5. `cooldownMs` 防止同一 session 重复弹 toast
6. `permission.replied` / `question.replied` / `question.rejected` 到达时 → `dismissSessionAlert()`

### 2.6 跨 agent 阻塞场景审计

除 `permission.asked` 和 `question.asked` 外，后端没有其他需要跨 agent 请求用户交互的阻塞机制。所有阻塞 subagent 的用户交互请求都通过以下两个 channel：

| 请求类型 | SSE 事件                                                    | Store 字段   | 阻塞机制                    |
| -------- | ----------------------------------------------------------- | ------------ | --------------------------- |
| 权限请求 | `permission.asked` / `permission.replied`                   | `permission` | Permission Service deferred |
| 问题请求 | `question.asked` / `question.replied` / `question.rejected` | `question`   | Question Service deferred   |

无其他跨 agent 阻塞类型。Task 工具自身的 `ctx.ask({ permission: "task" })` 也会产生 `permission.asked` 事件，已被 permission 覆盖。

---

## 3. 修复方案

### 改动 1: `packages/ui/src/context/data.tsx` — DataProvider 增加 permission 和 question getter

不在 `Data` 类型中添加 `permission` / `question` 字段（原因见 2.2 节）。而是在 `DataProvider` 的 init 函数中增加 `permission` 和 `question` getter，将 app 层的 `permission` / `question` 数据**显式暴露**给 UI 包组件。

**设计理由**：

- `Data` 类型是 UI 包抽象层，描述的是任何 DataProvider 都应提供的通用数据。`permission` / `question` 是 app 层业务数据，不应侵入 UI 抽象层
- 新增 getter 将 app 层数据的访问**限定在显式接口**上——组件通过 `data.permission(sid)` / `data.question(sid)` 访问，TypeScript 类型安全。注意：`data.store` getter 仍然暴露完整的 `Store<State>` 对象，组件仍可通过 `data.store.permission[sid]` 非类型安全访问——新增 getter 提供的是更好的类型安全替代路径，而非强制隔离（`Data` 类型不含这些字段，TypeScript 在 `data.store.permission[sid]` 上不会报错，但 IDE 类型提示不会显示这些属性）
- getter 直接读取 `props.data.permission[sid]` / `props.data.question[sid]`，SolidJS 的细粒度响应式会自动跟踪这些嵌套属性的变更

> **import 路径**：`PermissionRequest` 和 `QuestionRequest` 从 `@opencode-ai/sdk/v2/client` 导入。虽然 `@opencode-ai/sdk/v2` 通过 re-export 链（`index.ts → client.ts → gen/types.gen.ts`）也能到达这些类型，但 app 包的所有相关文件（`global-sync/types.ts:19`、`event-reducer.ts:13`、`session-request-tree.ts:1`、`permission.tsx:4`、`child-store.ts:4` 等）统一使用 `@opencode-ai/sdk/v2/client` 导入。为保持与 app 包约定的一致性，本方案也使用 `@opencode-ai/sdk/v2/client`。`data.tsx` 现有的其他 import（如 `Message`、`Session` 等）仍从 `@opencode-ai/sdk/v2` 导入——这两个路径分别导出不同子集的类型，在同一文件中混用是项目既定模式（`session-turn.tsx` 即同时从两个路径导入）。

```tsx
import type { Message, Session, Part, FileDiff, SessionStatus, ProviderListResponse } from "@opencode-ai/sdk/v2"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "./helper"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

type Data = {
  provider?: ProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data & {
      permission?: { [sessionID: string]: PermissionRequest[] }
      question?: { [sessionID: string]: QuestionRequest[] }
    }
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      permission: (sid: string) => props.data.permission?.[sid],
      question: (sid: string) => props.data.question?.[sid],
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
    }
  },
})
```

**效果**：

- `Data` 类型定义**不变**——保持 UI 包抽象层的纯净性
- `DataProvider` init 的 `props.data` 类型扩展为 `Data & { permission?, question? }`——交叉类型（intersection type）明确表达"Data 是基础数据，permission/question 是可选附加数据"
- 新增 `permission(sid)` 和 `question(sid)` getter——UI 包组件通过 `data.permission(sid)` / `data.question(sid)` 访问，返回 `PermissionRequest[] | undefined` / `QuestionRequest[] | undefined`
- 非全球同步 DataProvider 不提供 `permission` / `question` → getter 返回 `undefined` → 组件行为不变
- app 包的 `directory-layout.tsx` 传入 `sync.data`（`Store<State>` 类型，`State` 包含 `permission` 和 `question`）→ `props.data` 的交叉类型完全兼容

**`Store<State>` 与 `Data & { permission?; question? }` 的类型兼容性验证**：

当前 `directory-layout.tsx:26` 已将 `sync.data`（`Store<State>` 类型）传入 `DataProvider` 的 `data: Data` prop。`State` 比 `Data` 多出 `status`、`agent`、`command`、`project` 等 17 个额外字段，但 TypeScript 结构化类型系统允许源类型拥有目标类型未声明的额外属性——当前代码已正常运行，证明 `Store<State>` 可赋值给 `Data`。

新增的交叉类型 `Data & { permission?: { [sessionID: string]: PermissionRequest[] }; question?: { [sessionID: string]: QuestionRequest[] } }` 在 `Data` 之上增加了两个 optional 字段。TypeScript 兼容性分析：

- `State` 的 `permission: { [sessionID: string]: PermissionRequest[] }` 是**必需字段** → 满足交叉类型的 `permission?: ...`（必需字段满足 optional 约束 ✅）
- `State` 的 `question: { [sessionID: string]: QuestionRequest[] }` 是**必需字段** → 满足交叉类型的 `question?: ...`（同上 ✅）
- `Data` 的所有必需字段（`session`、`session_status`、`session_diff`、`message`、`part`）在 `State` 中均存在且类型匹配 ✅
- `Data` 的 optional 字段 `provider?` 和 `session_diff_preload?`：`State` 有 `provider`（必需，满足 optional ✅），`State` 没有 `session_diff_preload`（缺少 optional 字段也满足 optional 约束 ✅）

因此 `Store<State>` 完全兼容 `Data & { permission?; question? }`，`directory-layout.tsx` 不需要任何改动。

### 改动 2: `packages/ui/src/utils/session-pending.ts` — 新增 BFS 工具函数

新增 `session-pending.ts` 文件，实现 `hasPendingRequest` BFS 遍历函数。该函数从给定 sessionID 开始，遍历所有子 session（基于 `parentID` 构建子 tree），检测子 tree 中是否存在任何 pending permission 或 question。

**为什么在 UI 包中新增而不是在 app 包复用 `session-request-tree.ts`**：

`packages/app/src/pages/session/composer/session-request-tree.ts` 的 `sessionTreeRequest` 函数实现了类似逻辑，但它：

1. 位于 **app 包**（`packages/app`），UI 包组件无法 import app 包模块（包依赖关系是 `app → ui`，不是 `ui → app`）
2. 返回**第一个** pending request（`find` 语义），而 Task 卡片只需知道**有无阻塞**（`some` 语义），逻辑更简单
3. `sessionTreeRequest` 接收 `Record<string, T[] | undefined>` 格式的整个 store 作为参数，而本方案通过 `data.permission(sid)` / `data.question(sid)` getter 按需查单个 session——**核心优势是 SolidJS 细粒度响应式追踪**：getter 函数在 `createMemo` 的跟踪作用域内被调用时，SolidJS 只追踪实际被访问的 `permission[sid]` / `question[sid]` 属性，而非整个 store 对象。这意味着 `pending` memo 只在子 tree 中被访问的 session 的 permission/question 发生变更时重算，避免了因无关 session 的 permission/question 变更触发不必要的重算

提取为独立工具函数而非在 message-part.tsx 中内联，是因为 BFS 遍历是可复用逻辑——未来其他组件可能也需要检测子 session tree 的阻塞状态（如 sidebar 中的 session 列表、session switcher 等）。放置在 `packages/ui/src/utils/`（需新建此目录），与 UI 包现有的目录结构（`context/`、`hooks/`、`pierre/` 等）平行，形成清晰的职责分层：`components/` 放渲染组件、`context/` 放 context provider、`hooks/` 放 SolidJS hooks、`utils/` 放纯逻辑函数。

```ts
import type { Session } from "@opencode-ai/sdk/v2"

export function hasPendingRequest(
  sessions: Session[],
  rootID: string,
  permission: (sid: string) => unknown[] | undefined,
  question: (sid: string) => unknown[] | undefined,
): boolean {
  const childMap = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s.parentID) continue
    const list = childMap.get(s.parentID)
    if (list) list.push(s.id)
    else childMap.set(s.parentID, [s.id])
  }

  const visited = new Set<string>() // 防御性措施：session tree 基于 parentID 构建，正常数据无循环；visited 防止数据异常时无限循环
  const queue = [rootID]
  visited.add(rootID)
  while (queue.length > 0) {
    const current = queue.shift()!
    if ((permission(current)?.length ?? 0) > 0 || (question(current)?.length ?? 0) > 0) return true
    const children = childMap.get(current)
    if (children) {
      for (const c of children) {
        if (!visited.has(c)) {
          visited.add(c)
          queue.push(c)
        }
      }
    }
  }
  return false
}
```

**设计要点**：

- `permission` 和 `question` 参数是 getter 函数而非 store 对象——与改动 1 的 `data.permission(sid)` / `data.question(sid)` getter 对齐，调用时按需查单个 session，SolidJS 会自动跟踪 `permission[sid]` / `question[sid]` 的响应式
- 类型使用 `unknown[] | undefined` 而非 `PermissionRequest[] | undefined` / `QuestionRequest[] | undefined`——函数只关心"数组有无元素"，不需要知道具体类型，减少 import 依赖。注意：`unknown[]` 是有意选择以保持函数与业务类型解耦——函数仅判断"是否存在阻塞请求"，不区分 permission vs question 类型。如果未来需要扩展为区分阻塞类型（如返回 `"permission" | "question"` 而非布尔值），需重新评估类型约束并改为泛型或具体类型
- `rootID` 为空字符串时外部调用者应直接返回 false（不在函数内部处理，保持函数签名简洁）

### 改动 3: `packages/ui/src/components/message-part.tsx` — Task 卡片增加阻塞提示

在 Task 工具注册的 render 函数中，增加 `hasPendingRequest` memo。该 memo 调用 `session-pending.ts` 的 `hasPendingRequest` 函数，通过 `data.store.session` 构建子 session tree（基于 `parentID`），BFS 遍历检测所有子 session（包括嵌套子 subagent）是否有 pending permission 或 question。当检测到阻塞请求时，在 subtitle 后追加 warning icon + i18n 提示文字，整体变为警告色样式。**阻塞提示状态下保持 `<a>` 链接可点击跳转**，确保用户仍能通过 Task 卡片直接导航到 subagent session。

> **CSS 类名**：项目的 Tailwind v4 theme 通过 `@theme` 注册 `--color-text-on-warning-*` 系列 CSS 自定义属性。根据项目的实际使用模式（如 `text-text-on-critical-base`、`text-text-strong` 等），Tailwind 文本色 utility 的命名规则是 `text-{color-name}`，其中 `{color-name}` 对应 `--color-*` 中的后缀路径。因此 `--color-text-on-warning-strong` 对应的 Tailwind utility class 为 `text-text-on-warning-strong`。注意：文档先前版本使用 `text-on-warning-strong`，这是**不正确**的——缺少了 `text-` 前缀层。项目中已有使用 `text-text-on-critical-base` 的实际代码（`dialog-select-server.tsx:607`），验证了 `text-text-on-*` 的命名模式。

> **Icon size 设计**：subtitle 字体大小为 `14px`（`basic_tool.css` 的 `[data-slot="basic-tool-tool-subtitle"] { font-size: 14px }`）。Icon 组件的 `size` prop 支持 `"small" | "normal" | "medium" | "large"` 四档（`icon.tsx:118`），`size="small"` 对应 `16px`（`icon.css` 的 `[data-size="small"] { width: 16px; height: 16px }`），与 14px 文字更协调，使用 `<Icon name="warning" size="small" />`。

```tsx
import { hasPendingRequest } from "../utils/session-pending"

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const location = useLocation()
    const childSessionId = () => props.metadata.sessionId as string | undefined
    const type = createMemo(() => {
      const raw = props.input.subagent_type
      if (typeof raw !== "string" || !raw) return undefined
      return raw[0]!.toUpperCase() + raw.slice(1)
    })
    const title = createMemo(() => agentTitle(i18n, type()))
    const subtitle = createMemo(() => {
      const value = props.input.description
      if (typeof value === "string" && value) return value
      return childSessionId()
    })

    const pending = createMemo(() => {
      const sid = childSessionId()
      if (!sid) return false
      return hasPendingRequest(
        data.store.session,
        sid,
        (id) => data.permission(id),
        (id) => data.question(id),
      )
    })

    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const warningSuffix = () => (
      <>
        {" — "}
        {i18n.t("ui.tool.task.inputRequired")}
        <Icon name="warning" size="small" />
      </>
    )

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
          <Show when={subtitle()}>
            <Switch>
              <Match when={href()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  classList={{
                    "clickable subagent-link": true,
                    "text-text-on-warning-strong": pending(),
                  }}
                  href={href()!}
                  onClick={(e) => e.stopPropagation()}
                >
                  {subtitle()}
                  <Show when={pending()}>{warningSuffix()}</Show>
                </a>
              </Match>
              <Match when={true}>
                <span data-slot="basic-tool-tool-subtitle" classList={{ "text-text-on-warning-strong": pending() }}>
                  {subtitle()}
                  <Show when={pending()}>{warningSuffix()}</Show>
                </span>
              </Match>
            </Switch>
          </Show>
        </div>
      </div>
    )

    return <BasicTool icon="task" status={props.status} trigger={trigger()} hideDetails />
  },
})
```

**设计要点**：

- **单一 `<Show>+<Switch>` 结构**：subtitle 区域始终渲染，通过 `classList` 条件添加警告色、`<Show when={pending()}>` 条件追加警告后缀
- **权限提示状态下仍使用 `<a>` 标签**：保持点击跳转能力
- `<a>` 标签保留原有 `onClick={(e) => e.stopPropagation()}`，防止事件冒泡
- `warningSuffix` 提取为独立函数，避免内联 JSX 重复
- i18n key 使用 `"ui.tool.task.inputRequired"`（见改动 4），统一命名空间
- `pending` memo 调用 `hasPendingRequest` 函数，通过 getter 参数与 `data.permission(sid)` / `data.question(sid)` 对齐，SolidJS 自动跟踪响应式
- 无 `href` 时仍用 `<span>`，但添加警告色和后缀——用户无法通过 `<span>` 跳转，但 toast 仍可提供跳转
- memo 变量名从原方案的 `hasPendingRequest` 改为 `pending`——更短的单词名（符合 AGENTS.md naming 规则），与 `running` 保持命名风格一致

**`data.store.session` 的响应性**：`session` 是 `State` 的直接字段（`session: Session[]`），通过 `setStore` 更新时 SolidJS 会触发响应式。`permission` 和 `question` 的 `setStore` 更新同样触发响应式。因此 `pending` 会在以下场景自动重算：新 session 创建（subagent dispatch）、permission/question 请求到达、permission/question 请求被处理。

**效果**：

| 状态                                           | Task 卡片 subtitle 显示                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| 运行中无请求                                   | `description`（正常 `<a>` 链接，默认色）                                          |
| 一级 subagent 有 pending permission/question   | `description — Input required ⚠`（`<a>` 链接，`text-text-on-warning-strong` 色） |
| 嵌套子 subagent 有 pending permission/question | `description — Input required ⚠`（同上，BFS 遍历检测到嵌套子 session 的请求）    |
| 请求处理后                                     | 回到 `description`（`<a>` 链接，默认色）                                          |
| subagent 完成                                  | 正常 completed 状态                                                               |

用户在 root session 视图中看到的效果：

- Task 卡片标题：`Explore agent`（TextShimmer）
- subtitle 链接：`description — Input required ⚠`（`text-text-on-warning-strong` 色，可点击跳转）
- 顶部 toast：`Permission required — Explore agent in ProjectName needs permission`（persistent，"Go to session" 按钮）
- 底部 composer：Prompt 输入框（正常，root session 无自己的请求）

点击 Task 卡片的 subtitle `<a>` 链接 → 跳转到一级 subagent session → 如果是嵌套子 subagent 的请求，跳转后一级 subagent session 的 Task 卡片同样会显示阻塞提示 → 用户可继续逐级跳转到有 pending request 的子 session → PermissionDock / QuestionDock 显示 → 可操作。

### 改动 4: i18n locale 文件 — 新增 `ui.tool.task.inputRequired` key

当前 i18n 系统（`packages/ui/src/i18n/`）有 17 个 locale 文件，每个文件需要新增一个 key。`en.ts` 是 source of truth，`UiI18nKey` 类型从 `en.ts` 的 `dict` 推导。

`en.ts` 中现有 task 相关 key 为 `"ui.tool.task": "Task"`。新增 key 使用 `"ui.tool.task.inputRequired"` 命名空间，与现有 `ui.tool.task` 保持一致。

key 名称 `inputRequired` 覆盖 permission 和 question 两种阻塞场景，避免使用 `permissionRequired` 导致 question 阻塞时显示"Permission required"的语义不匹配。

新增 key 及各 locale 翻译：

| Locale   | Key                          | Value                    |
| -------- | ---------------------------- | ------------------------ |
| `en.ts`  | `ui.tool.task.inputRequired` | `"Input required"`       |
| `zh.ts`  | `ui.tool.task.inputRequired` | `"需要输入"`             |
| `zht.ts` | `ui.tool.task.inputRequired` | `"需要輸入"`             |
| `ja.ts`  | `ui.tool.task.inputRequired` | `"入力が必要"`           |
| `ko.ts`  | `ui.tool.task.inputRequired` | `"입력 필요"`            |
| `de.ts`  | `ui.tool.task.inputRequired` | `"Eingabe erforderlich"` |
| `fr.ts`  | `ui.tool.task.inputRequired` | `"Entrée requise"`       |
| `es.ts`  | `ui.tool.task.inputRequired` | `"Entrada requerida"`    |
| `br.ts`  | `ui.tool.task.inputRequired` | `"Entrada necessária"`   |
| `ru.ts`  | `ui.tool.task.inputRequired` | `"Требуется ввод"`       |
| `ar.ts`  | `ui.tool.task.inputRequired` | `"إدخال مطلوب"`          |
| `pl.ts`  | `ui.tool.task.inputRequired` | `"Wymagane dane"`        |
| `tr.ts`  | `ui.tool.task.inputRequired` | `"Girdi gerekli"`        |
| `th.ts`  | `ui.tool.task.inputRequired` | `"ต้องการข้อมูลเข้า"`    |
| `no.ts`  | `ui.tool.task.inputRequired` | `"Inndata kreves"`       |
| `da.ts`  | `ui.tool.task.inputRequired` | `"Input kræves"`         |
| `bs.ts`  | `ui.tool.task.inputRequired` | `"Unos potrebna"`        |

> **插入位置**：各 locale 文件中，在 `"ui.tool.task"` key 之后插入，保持 `ui.tool.*` 语义分组。

---

## 4. 文件改动清单

| 文件                                          | 操作     | 核心变更                                                                                                                                                    |
| --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/context/data.tsx`            | **小改** | `DataProvider` init 的 `props.data` 类型扩展为 `Data & { permission?, question? }` 交叉类型 + 新增 `permission(sid)` / `question(sid)` getter + 2 个 import |
| `packages/ui/src/utils/session-pending.ts`    | **新增** | `hasPendingRequest` 函数——BFS 遍历子 session tree 检测 permission + question pending 状态（需新建 `utils/` 目录）                                           |
| `packages/ui/src/components/message-part.tsx` | **小改** | Task 工具注册增加 `pending` memo（调用 `hasPendingRequest`）+ import `session-pending` + 条件渲染警告色和后缀                                               |
| `packages/ui/src/i18n/en.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Input required"`                                                                                                       |
| `packages/ui/src/i18n/zh.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "需要输入"`                                                                                                             |
| `packages/ui/src/i18n/zht.ts`                 | **小改** | 新增 `"ui.tool.task.inputRequired": "需要輸入"`                                                                                                             |
| `packages/ui/src/i18n/ja.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "入力が必要"`                                                                                                           |
| `packages/ui/src/i18n/ko.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "입력 필요"`                                                                                                            |
| `packages/ui/src/i18n/de.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Eingabe erforderlich"`                                                                                                 |
| `packages/ui/src/i18n/fr.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Entrée requise"`                                                                                                       |
| `packages/ui/src/i18n/es.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Entrada requerida"`                                                                                                    |
| `packages/ui/src/i18n/br.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Entrada necessária"`                                                                                                   |
| `packages/ui/src/i18n/ru.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Требуется ввод"`                                                                                                       |
| `packages/ui/src/i18n/ar.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "إدخال مطلوب"`                                                                                                          |
| `packages/ui/src/i18n/pl.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Wymagane dane"`                                                                                                        |
| `packages/ui/src/i18n/tr.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Girdi gerekli"`                                                                                                        |
| `packages/ui/src/i18n/th.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "ต้องการข้อมูลเข้า"`                                                                                                    |
| `packages/ui/src/i18n/no.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Inndata kreves"`                                                                                                       |
| `packages/ui/src/i18n/da.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Input kræves"`                                                                                                         |
| `packages/ui/src/i18n/bs.ts`                  | **小改** | 新增 `"ui.tool.task.inputRequired": "Unos potrebna"`                                                                                                        |

总计：**20 个文件**（1 新增 + 19 修改）。新增代码量：data.tsx 约 6 行（2 getter + 交叉类型扩展 + 2 import）+ session-pending.ts 约 20 行 + message-part.tsx 约 4 行（import + `pending` memo 调用）+ i18n 17×1 行。

**不改的东西**：

- `Data` 类型定义（不改，保持 UI 包抽象层纯净）
- Permission Service（`packages/opencode/src/permission/index.ts`）
- Question Service（`packages/opencode/src/question/index.ts`）
- SSE 事件 schema（Permission.Request / Permission.Event / Question.Request / Question.Event）
- SDK 类型（`packages/sdk/js/`）
- DB schema（`session.sql.ts`）
- event-reducer.ts 的 permission/question 存储
- sessionCurrentPermissionRequest / sessionCurrentQuestionRequest per-session 逻辑
- session-request-tree.ts（不改，UI 包无法 import app 包模块）
- layout.tsx 的 toast 通知机制
- permission.tsx 的 auto-respond 过滤
- SessionPermissionDock / SessionQuestionDock 组件
- BasicTool 组件
- CSS / theme 变量（`text-text-on-warning-strong` 已在 `colors.css` 中注册为 `--color-text-on-warning-strong`）

---

## 5. 对 research.md 的影响

无需修改。阻塞提示是 Web UI 层的 UI 改进，自动对所有 subagent dispatch 生效。

---

## 6. 验收清单

### 6.1 Task 卡片阻塞提示

1. 一级 subagent 有 pending permission → Task 卡片 subtitle 显示 `description — Input required ⚠`，`text-text-on-warning-strong` 色，`<a>` 链接可点击跳转
2. 一级 subagent 有 pending question → 同上
3. 嵌套子 subagent 有 pending permission/question → 一级 Task 卡片同样显示 `description — Input required ⚠`（BFS 遍历检测到嵌套子 session 的请求）
4. 权限批准/拒绝后 → subtitle 恢复为 `description`（`<a>` 链接，默认色）
5. question 回答/拒绝后 → 同上
6. subagent 运行中无任何请求 → 正常显示 `description` `<a>` 链接（默认色）
7. subagent 完成 → 正常显示 completed 状态
8. 多个 Task 卡片同时运行 → 仅有子 tree 中存在 pending request 的卡片显示提示和警告色
9. description 为空 → subtitle 显示 `childSessionId — Input required ⚠`

### 6.2 Toast 通知（已有机制，不改）

10. subagent permission/question 请求到达且用户不在该 session 视图 → toast 弹窗（persistent + guarded + "Go to session" 按钮）
11. 当前 session 自身请求 → 不弹 toast（Dock 已直接可见）
12. 请求处理后 → toast 自动 dismiss
13. auto-respond 的权限请求 → `permission.asked` 和 `permission.replied` 几乎同时到达，Task 卡片提示可能短暂闪烁后立即消失；toast 不弹出

### 6.3 跳转交互

14. 点击 Task 卡片 subtitle `<a>` 链接 → 跳转到一级 subagent session → 如果是嵌套请求，一级 subagent 的 Task 卡片也显示阻塞提示 → 用户可逐级跳转
15. 点击 toast "Go to session" → 直接跳转到有 pending request 的子 session → Dock 显示 → 可操作
16. 操作完成后 → subagent 继续运行 → Task 卡片提示消失
17. Deny 权限 → subagent 终止 → Task 卡片显示错误状态
18. Reject question → subagent 终止（QuestionRejectedError）→ Task 卡片显示错误状态

### 6.4 边界情况

19. `props.metadata.sessionId` 为空 → `pending` memo 中 `sid` 为空 → 直接返回 false，无提示（行为不变）；`href()` 为空 → subtitle 渲染为 `<span>`（有警告色和后缀但无跳转，用户依赖 toast 跳转）
20. `data.permission(sid)` / `data.question(sid)` 返回 `undefined`（非 global-sync DataProvider）→ `hasPendingRequest` 中 `(undefined?.length ?? 0) > 0` 为 false → BFS 遍历无结果 → `pending` 返回 false → 行为不变
21. 用户在 subagent session 视图 → PermissionDock / QuestionDock 正常显示该 session 的请求
22. 用户在另一个 session 视图 → toast 弹窗提醒跳转，但该 session 的 Task 卡片不涉及被阻塞的 subagent
23. `DataProvider` init 类型扩展不影响现有代码 → `Data` 类型不变；`props.data` 交叉类型 `Data & { permission?, question? }` 允许 app 包传入 `Store<State>`（`State` 包含 `permission` 和 `question`）；新增 getter 是可选接口
24. i18n key `ui.tool.task.inputRequired` 在所有 17 个 locale 文件中注册 → `UiI18nKey` 类型自动推导，无 TypeScript 报错
25. BFS 遍历性能 → `session` 数量通常 < 100（受 `MAX_DIR_STORES=30` 和 `limit` 限制），遍历开销可忽略

---

## 7. 测试策略

### 7.1 单元测试：`packages/ui/src/utils/session-pending.test.ts`

新增 `hasPendingRequest` 函数的单元测试文件，覆盖以下场景：

| 测试场景                                         | 输入                                                                                                      | 期望输出 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------- |
| 无子 session、rootID 无请求                      | `sessions=[root]`, `rootID=root.id`, `permission=()=>undefined`                                           | `false`  |
| 一级子 session 有 pending permission             | `sessions=[root, child]`, `child.parentID=root.id`, `permission(child.id)=[{...}]`                        | `true`   |
| 一级子 session 有 pending question               | 同上，`question(child.id)=[{...}]`                                                                        | `true`   |
| 嵌套二级子 session 有 pending request            | `sessions=[root, child, grandchild]`, `grandchild.parentID=child.id`, `permission(grandchild.id)=[{...}]` | `true`   |
| 子 session 请求已处理（数组为空）                | `permission(child.id)=[]`                                                                                 | `false`  |
| rootID 为空字符串                                | `rootID=""`                                                                                               | `false`  |
| 非全球同步 DataProvider（getter 返回 undefined） | `permission=()=>undefined`, `question=()=>undefined`                                                      | `false`  |
| 多个子 session，仅其中一个有请求                 | `sessions=[root, childA, childB]`, `permission(childB.id)=[{...}]`                                        | `true`   |
| rootID 自身有请求                                | `permission(rootID)=[{...}]`                                                                              | `true`   |

测试文件放置在 `packages/ui/src/utils/session-pending.test.ts`，与 `packages/ui/src/components/` 下其他测试文件（`message-file.test.ts`、`file-tree.vitest.tsx` 等）的命名模式一致。运行命令：`bun run test:unit`（从 `packages/ui` 目录）。

### 7.2 类型检查验证

- 运行 `bun typecheck`（从 `packages/ui` 和 `packages/app` 目录分别运行），确保交叉类型 `Data & { permission?, question? }` 和新增 getter 的类型定义无 TypeScript 报错
- 验证 i18n key 新增后 `UiI18nKey` 类型自动推导正确，所有 17 个 locale 文件无类型缺失报错
