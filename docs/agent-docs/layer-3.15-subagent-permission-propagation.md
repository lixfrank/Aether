# Layer 3.15: Subagent Permission Request Propagation — Task 卡片权限提示 + Toast 通知

> 前置依赖: Layer 0-3.14（所有已完成层）
> 本文档解决 subagent 权限请求在 TUI 中用户注意力不足的问题——当 subagent 需要 `ask` 级别权限时，权限请求在 subagent session 中发出 Bus 事件并正确存储，但用户若正在查看 primary session，可能错过 toast 弹窗，也不知道 subagent 正在被阻塞。
> 修改范围：仅 TUI 层 3 处改动约 20 行代码。不改 Permission Service、不改 Bus 事件 schema、不改 SDK 类型、不改 DB schema。

---

## 1. 问题分析

### 1.1 核心问题

当 subagent（如 research-worker）需要 `ask` 级别权限时，Permission Service 通过 Bus 发布 `permission.asked` 事件，TUI sync 按 `sessionID` 存储到 `store.permission[subagentSessionID]`。主 session 视图的 `permissions()` memo 通过 `children().flatMap` 收集一级子 session 的权限请求，一级 subagent 的权限请求**理论上**能出现在主 session 的 PermissionPrompt 中。

但实际体验中有两个关键缺口：

**缺口 A：Task 卡片无权限状态提示**

主 session 视图中，subagent 以 Task 工具卡片（`InlineTool`）的形式展示。当 subagent 正在等待权限批准时，Task 卡片只显示 spinner + "Delegating..." 或正常的工具调用进度，**没有任何视觉线索表明 subagent 正在被权限请求阻塞**。用户必须点击跳转到 subagent session 才能看到 PermissionPrompt，但没有任何提示引导他们这样做。

**缺口 B：Toast 弹窗容易被错过**

`permission.asked` 事件到达 TUI sync 时，没有任何 toast 通知。MCP 认证需求使用了 `TuiEvent.ToastShow` 进行 toast 通知（持续 8 秒），但 permission 事件没有类似机制。toast 弹窗本身也是短暂的，用户可能因为注意力在其他地方而错过。

### 1.2 实际影响

research agent 的 Path 3 状态机大量使用 subagent dispatch：

- **一级 dispatch**：coordinator → research-worker（10 个 phase 各 dispatch 一次）
- **二级 dispatch**：research-worker → explore / general / local-executor 等

权限配置中 `external_directory: ask` 是最常见的需要用户批准的权限。MCP 工具调用也需要 `ctx.ask({permission: key})`。

当权限请求被错过时：

- subagent indefinitely blocked（等待 deferred resolve/reject）
- coordinator 的 task 工具调用也被阻塞
- 用户在主 session 看到 "agent is busy" 状态，但不知道原因
- 可能导致整个 research 流程卡住

### 1.3 不修改的部分

以下机制**运行正确，不需要修改**：

| 机制                                     | 状态    | 原因                                            |
| ---------------------------------------- | ------- | ----------------------------------------------- |
| Permission Service 的 ask/reply/deferred | ✅ 正确 | 核心逻辑无误                                    |
| Bus 事件的 sessionID 携带                | ✅ 正确 | 按原始 sessionID 存储和 reply 是正确设计        |
| `permissions()` 收集一级子 session       | ✅ 正确 | `children().flatMap` 能收集一级 subagent 的权限 |
| PermissionPrompt 在正确 session 中的显示 | ✅ 正确 | 当用户跳转到 subagent session 后能正常显示      |

**唯一需要改善的是：让用户更容易注意到 subagent 正在请求权限，并引导他们跳转处理。**

---

## 2. 当前实现追踪

### 2.1 Task 卡片渲染

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1986-2052`：

Task 组件是一个 `InlineTool`，显示 subagent 的运行状态：

```tsx
function Task(props: ToolProps<typeof TaskTool>) {
  const content = createMemo(() => {
    let content = [`Task ${props.input.description}`]
    if (isRunning() && tools().length > 0) {
      if (current()) content.push(`↳ ${Locale.titlecase(current()!.tool)} ${(current()!.state as any).title}`)
      else content.push(`↳ ${tools().length} toolcalls`)
    }
    if (props.part.state.status === "completed") {
      content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }
    return content.join("\n")
  })

  return (
    <InlineTool
      icon="│"
      spinner={isRunning()}
      complete={props.input.description}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (props.metadata.sessionId) {
          navigate({ type: "session", sessionID: props.metadata.sessionId })
        }
      }}
    >
      {content()}
    </InlineTool>
  )
}
```

关键信息：

- `props.metadata.sessionId` 是 subagent session 的 ID
- `onClick` 已有跳转逻辑：点击 Task 卡片可跳转到 subagent session
- `InlineTool` 有 `permission` memo（行 1667-1671），但只检查**当前 session** 的权限，不检查 subagent session
- `InlineTool` 的颜色会因 `permission()` 而变为 `theme.warning`（黄色）

### 2.2 InlineTool 的 permission 检查

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1667-1678`：

```tsx
const permission = createMemo(() => {
  const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
  if (!callID) return false
  return callID === props.part.callID
})

const fg = createMemo(() => {
  if (permission()) return theme.warning // 黄色高亮
  if (hover() && props.onClick) return theme.text
  if (props.complete) return theme.textMuted
  return theme.text
})
```

`permission` 只检查 `ctx.sessionID`（当前查看的 session），不检查 subagent session 的权限请求。当 subagent 有 pending permission 时，Task 卡片不会变黄色。

### 2.3 sync.tsx 的 permission.asked 处理

`packages/opencode/src/cli/cmd/tui/context/sync.tsx:137-157`：

按 `request.sessionID` 存储到对应分组，没有任何传播或通知逻辑。

---

## 3. 修复方案

### 改动 1: Task 组件 — 检测 subagent session 的权限请求

在 Task 组件中增加 `subagentPermission` memo，检测 `sync.data.permission[props.metadata.sessionId]` 是否有 pending request。如果有，在 `content()` 中追加一行提示文字。

```tsx
function Task(props: ToolProps<typeof TaskTool>) {
  // ... existing code ...

  const subagentPermission = createMemo(() => {
    const sid = props.metadata.sessionId ?? ""
    const pending = sync.data.permission[sid]
    return pending?.length > 0 ? pending[0] : undefined
  })

  const content = createMemo(() => {
    let content = [`Task ${props.input.description}`]

    if (isRunning() && subagentPermission()) {
      content.push(`△ Permission required — click to approve`) // 新增
    } else if (isRunning() && tools().length > 0) {
      if (current()) content.push(`↳ ${Locale.titlecase(current()!.tool)} ${(current()!.state as any).title}`)
      else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon="│"
      spinner={isRunning()}
      complete={props.input.description}
      pending="Delegating..."
      part={props.part}
      // 增加 subagentPermission 参数，让 InlineTool 也检查 subagent session 的权限
      subagentSessionID={props.metadata.sessionId}
      onClick={() => {
        if (props.metadata.sessionId) {
          navigate({ type: "session", sessionID: props.metadata.sessionId })
        }
      }}
    >
      {content()}
    </InlineTool>
  )
}
```

**效果**：

- subagent 有 pending permission 时，Task 卡片显示 `△ Permission required — click to approve`
- 用户看到黄色（warning 色）提示，知道 subagent 正在被阻塞
- 点击卡片跳转到 subagent session，看到完整的 PermissionPrompt 进行操作

### 改动 2: InlineTool — 扩展 permission 检查范围

`InlineTool` 的 props 增加 `subagentSessionID` 可选参数。`permission` memo 同时检查当前 session 和 subagent session 的权限请求，使 Task 卡片在 subagent 有 pending permission 时变为黄色。

```tsx
function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  spinner?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
  subagentSessionID?: string // 新增
}) {
  // ... existing code ...

  const permission = createMemo(() => {
    // 当前 session 的权限检查（不变）
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (callID && callID === props.part.callID) return true

    // subagent session 的权限检查（新增）
    if (props.subagentSessionID) {
      const subPending = sync.data.permission[props.subagentSessionID]
      return subPending?.length > 0
    }
    return false
  })

  // ... rest unchanged ...
}
```

**效果**：当 subagent 有 pending permission 时，Task 卡片的文字颜色变为 `theme.warning`（黄色），视觉上醒目提示用户。

### 改动 3: sync.tsx — Toast 通知

在 `permission.asked` 事件处理中，增加 toast 通知。当权限请求来自 subagent session（`sessionID` 不等于当前查看的 session）时，发布 `TuiEvent.ToastShow` 提醒用户。

```tsx
case "permission.asked": {
  const request = event.properties
  // ... existing storage logic unchanged ...

  // Toast 通知（新增）
  // 检查请求是否来自当前查看的 session 的子 session
  const currentSession = store.session.find((s) => !s.parentID) // root session
  const isFromSubagent = currentSession && request.sessionID !== currentSession.id
  if (isFromSubagent) {
    Bus.publish(TuiEvent.ToastShow, {
      title: "Permission Required",
      message: `Subagent needs ${request.permission} permission. Click the task card to approve.`,
      variant: "warning",
      duration: 10000,
    })
  }
  break
}
```

> 注意：sync.tsx 的 store 结构中 `store.session` 是所有已知 session 的数组。`TuiEvent` 已在 sync.tsx 的 import 旁边可引用（从 `../../event` 或通过 Bus 直接 publish）。具体实现时需确认 `Bus` 和 `TuiEvent` 在 sync.tsx 中是否可访问——若不可，可通过另一种方式：在 session/index.tsx 中监听 permission.asked 并发 toast。MCP auth toast 的实现是在 `mcp/index.ts` 中直接 `Bus.publish(TuiEvent.ToastShow, ...)`，所以 Bus + TuiEvent 是全局可用的。

**效果**：subagent 权限请求到达时，toast 持续 10 秒提醒用户，指引他们点击 Task 卡片跳转处理。

---

## 4. 文件改动清单

| 文件                                                         | 操作     | 核心变更                                                                                                                                                                            |
| ------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | **小改** | Task 组件增加 `subagentPermission` memo + `content()` 追加权限提示行 + 传 `subagentSessionID` 给 InlineTool；InlineTool props 增加 `subagentSessionID` + `permission` memo 扩展检查 |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx`         | **小改** | `permission.asked` 事件处理增加 toast 通知                                                                                                                                          |

总计：**2 个文件，约 20 行新增代码**。

**不改的东西**：

- Permission Service（`packages/opencode/src/permission/index.ts`）
- Bus 事件 schema（Permission.Request / Permission.Event）
- SDK 类型（`packages/sdk/js/`）
- DB schema（`session.sql.ts`）
- `permissions()` memo 的收集逻辑
- PermissionPrompt 组件

---

## 5. 对 research.md 的影响

无需修改。权限提示是 opencode TUI 层的 UI 改进，自动对所有 subagent dispatch 生效。

---

## 6. 验收清单

### 6.1 Task 卡片权限提示

1. subagent 有 pending `ask` 权限 → Task 卡片显示 `△ Permission required — click to approve`
2. 权限被批准/拒绝后 → 提示行消失，恢复正常进度显示
3. subagent 运行中无权限请求 → 正常显示 `↳ Tool Title` 或 `↳ N toolcalls`
4. subagent 完成 → 正常显示 `└ N toolcalls · duration`
5. 多个 Task 卡片同时运行 → 仅有 pending permission 的卡片显示提示

### 6.2 InlineTool 颜色变化

6. subagent 有 pending permission → Task 卡片文字变为黄色（`theme.warning`）
7. 权限处理后 → 颜色恢复正常
8. 无 subagentSessionID 的 InlineTool → 行为不变（仅检查当前 session 权限）

### 6.3 Toast 通知

9. subagent 权限请求到达 → toast 持续 10 秒，内容包含权限类型
10. root session 自身的权限请求 → 不发 toast（PermissionPrompt 已直接可见）
11. 权限处理后 → toast 自然消失（不影响已显示的 toast）

### 6.4 跳转交互

12. 点击有权限提示的 Task 卡片 → 跳转到 subagent session → 看到 PermissionPrompt → 可操作
13. 操作完成后 → subagent 继续运行 → Task 卡片提示消失
14. 拒绝权限 → subagent 终止 → Task 卡片显示错误信息

### 6.5 边界情况

15. `props.metadata.sessionId` 为空 → `subagentPermission` 返回 undefined，无提示（行为不变）
16. 嵌套 subagent（二级/三级）的权限请求 → Task 卡片只检查**一级** subagent session，嵌套 subagent 的权限不直接在一级 Task 卡片中显示（嵌套 subagent 的权限在嵌套 session 的子 Task 卡片中显示）
17. 用户在 subagent session 视图 → 该 session 的 Task 卡片同样能检测其子 subagent 的权限
