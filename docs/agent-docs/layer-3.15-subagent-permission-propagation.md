# Layer 3.15: Subagent Permission Request Propagation — 子代理权限请求向主会话传递

> 前置依赖: Layer 0-3.14（所有已完成层）
> 本文档解决 subagent 权限请求在 TUI 中不可见的问题——当 subagent 需要 `ask` 级别权限时，权限请求仅在 subagent 的 session 中发出 Bus 事件，但用户可能正在查看 primary agent 的 session，导致权限请求被错过。嵌套 subagent 的权限请求更不可能被收集到 primary session 的 permissions() 中。
> 修改范围：`packages/opencode/src/` 的 TUI sync + session view 逻辑，以及 Permission Service 的 Bus 事件扩展。核心源文件改动约 4 处。

---

## 目录

1. [问题分析](#1-问题分析)
2. [当前实现追踪](#2-当前实现追踪)
3. [设计决策汇总](#3-设计决策汇总)
4. [修复方案](#4-修复方案)
5. [文件改动清单](#5-文件改动清单)
6. [对 research.md 的影响](#6-对-researchmd-的影响)
7. [验收清单](#7-验收清单)

---

## 1. 问题分析

### 1.1 核心问题

当 subagent（如 research-worker）需要 `ask` 级别权限时，Permission Service 通过 Bus 发布 `permission.asked` 事件，携带 subagent session 的 `sessionID`。TUI 的 sync.tsx 将此请求存储在 `store.permission[subagentSessionID]` 下。

问题在于：用户通常在 **primary agent session** 视图中观察交互。主 session 的 `permissions()` memo 仅从**直接子 session**（`children()`）收集权限请求，而 `children()` 的过滤条件是 `x.parentID === parentID || x.id === parentID`，只包含主 session 及其一级子 session。

这意味着：

| 场景                                                                       | 权限请求可见性                                                                                          | 问题       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------- |
| 一级 subagent 需权限，用户在主 session 视图                                | ✅ 可见（`children()` 包含一级子 session）                                                              | 无         |
| 一级 subagent 需权限，用户在 subagent session 视图                         | ❌ 不可见（`if (session()?.parentID) return []` 强制返回空）                                            | **问题 A** |
| 嵌套 subagent（如 research-worker → explore）需权限，用户在主 session 视图 | ❌ 不可见（嵌套子 session 的 `parentID` 是 research-worker session，不在主 session 的 `children()` 中） | **问题 B** |
| 嵌套 subagent 需权限，用户在 research-worker session 视图                  | ❌ 不可见（同样受 `parentID` 检查阻挡）                                                                 | **问题 C** |

**问题 D（toast 监控缺失）**：即使权限请求出现在正确的 session 视图中，TUI 也仅在用户当前正在查看该 session 时显示 `PermissionPrompt`。若用户切换到其他 session 或查看 home 页面，权限请求只存储在内存中，没有任何 toast 或通知机制提醒用户。MCP 认证需求使用了 toast 通知（`TuiEvent.ToastShow`），但 permission.asked 事件没有类似机制。

### 1.2 实际影响

research agent 的 Path 3 状态机大量使用 subagent dispatch：

- **一级 dispatch**：coordinator → research-worker（10 个 phase 各 dispatch 一次）
- **二级 dispatch**：research-worker → explore / general / local-executor 等（worker 在执行中可能进一步 dispatch）
- **三级 dispatch**：被 dispatch 的 subagent 可能再 dispatch（如 explore → research-explorer）

research agent 的 permission 配置中 `external_directory: ask`，这是最常见的需要用户批准的权限。其他需要 `ask` 的场景包括 MCP 工具调用（所有 MCP 工具需要 `ctx.ask({permission: key})`）和 doom_loop 检测。

当权限请求在 subagent session 中发出但用户看不到时：

- subagent 被 ** indefinitely blocked**（等待 deferred resolve/reject）
- coordinator 的 task 工具调用也被阻塞（task.execute 等待 subagent prompt loop 完成）
- 用户回到主 session 时看到的是 "agent is busy" 状态，但不知道原因
- 可能导致整个 research 流程卡住

### 1.3 现有的部分缓解

主 session 视图中的一级 subagent 权限请求确实能被收集（通过 `children().flatMap`），但这只解决了**一级 subagent** 的部分场景。嵌套 subagent 和用户在非主 session 视图时的场景完全没有覆盖。

---

## 2. 当前实现追踪

### 2.1 权限请求生命周期

```
subagent tool execution → ctx.ask({permission, patterns, ...})
     │
     ▼
Permission.ask(input)  (packages/opencode/src/permission/index.ts:164)
     │
     ├─ evaluate rules → action="allow" → 直接通过（无用户交互）
     ├─ evaluate rules → action="deny" → return DeniedError（无用户交互）
     └─ evaluate rules → action="ask" → 创建 deferred，发布 Bus 事件
          │
          ▼
Bus.publish(Permission.Event.Asked, info)
     │  info = { id, sessionID: subagentSessionID, permission, patterns, metadata, always, tool }
     │
     ▼
TUI sync.tsx  (packages/opencode/src/cli/cmd/tui/context/sync.tsx:137)
     │
     ├─ store.permission[request.sessionID] → [request]  (按 sessionID 分组存储)
     │
     ▼
TUI session view  (packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:137-139)
     │
     ├─ permissions() = children().flatMap(x => sync.data.permission[x.id])
     │  children() = sessions.filter(x => x.parentID === parentID || x.id === parentID)
     │  只包含主 session + 一级子 session
     │
     ├─ if (session()?.parentID) → return []  (子 session 视图不显示任何权限)
     │
     ▼
PermissionPrompt  (packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx:129)
     │
     ├─ 用户选择 Allow once / Allow always / Reject
     │
     ▼
sdk.client.permission.reply({reply, requestID})  → Permission.reply()
     │
     ▼
Bus.publish(Permission.Event.Replied, ...)  → Deferred resolve/fail
     │
     ▼
subagent tool execution 继续（allow）或终止（deny/reject）
```

### 2.2 关键代码位置

| 文件                                   | 行号      | 作用                                        | 问题                                                                        |
| -------------------------------------- | --------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `permission/index.ts`                  | 72        | `Permission.Event.Asked` 定义               | 事件只携带 `sessionID`，不携带 `parentSessionID` 或层级信息                 |
| `permission/index.ts`                  | 164-199   | `Permission.ask()` 函数                     | 发布 Bus 事件时只带发起 session 的 ID                                       |
| `cli/cmd/tui/context/sync.tsx`         | 137-157   | TUI sync 处理 `permission.asked`            | 按 `request.sessionID` 存储到对应 session 分组，不做任何传播                |
| `cli/cmd/tui/routes/session/index.tsx` | 125-130   | `children()` memo                           | 只包含一级子 session，不递归嵌套                                            |
| `cli/cmd/tui/routes/session/index.tsx` | 137-139   | `permissions()` memo                        | `children().flatMap` 只收集一级子 session 的权限；子 session 视图强制返回空 |
| `cli/cmd/tui/routes/session/index.tsx` | 1181-1182 | PermissionPrompt 显示条件                   | 只显示 `permissions()[0]`，需要用户当前正在查看该 session                   |
| `tool/task.ts`                         | 159       | `Session.create({parentID: ctx.sessionID})` | 子 session 的 `parentID` 指向直接调用者，非 root session                    |

### 2.3 Session 层级关系

```
Primary session (root, parentID = null)
  │
  ├─→ Subagent session A (parentID = primary.id)
  │     │
  │     ├─→ Nested subagent session B (parentID = A.id)
  │     │     │
  │     │     ├─→ Further nested session C (parentID = B.id)
  │
  ├─→ Subagent session D (parentID = primary.id)
```

当前 `children()` 只找到 A 和 D。B 和 C 的 `parentID` 是 A.id 或 B.id，不在 `parentID === primary.id` 的过滤范围内。

---

## 3. 设计决策汇总

| 决策                | 选择                                                                             | 原因                                                                                            |
| ------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 权限请求传播方向    | 从 subagent session 向 root session 传播                                         | 用户始终在 root session 视图，root session 是所有 subagent 的最终观察点                         |
| 传播方式            | Permission Bus 事件增加 `rootSessionID` 字段 + TUI sync 向 root session 镜像存储 | 不修改 Permission Service 核心逻辑（ask/reply仍按原始 sessionID 运作），只在 Bus 层增加传播信息 |
| 嵌套 subagent 权限  | 递归查找 root session                                                            | 嵌套 subagent 的权限请求需要穿越多层 parentID 才能到达 root                                     |
| 子 session 视图权限 | 移除 `if (session()?.parentID) return []` 限制，改为从 root session 收集         | 子 session 视图也应显示其自身的权限请求（包括从 root 传播来的）                                 |
| Toast 通知          | 在 `permission.asked` 事件处理时，若当前查看的 session 不匹配，发布 toast        | toast 仅作补充提醒，PermissionPrompt 仍为主要交互方式                                           |
| Reply 路由          | 不修改，仍按原始 `requestID` + `sessionID` reply                                 | Permission Service 的 deferred 按 `requestID` 存储，reply 不需要路由变更                        |

---

## 4. 修复方案

### 4.1 方案 A: Permission Bus 事件增加 rootSessionID（推荐）

#### 4.1.1 设计原理

核心思路：在 `permission.asked` Bus 事件中附带 `rootSessionID`，让 TUI sync 能够将 subagent 的权限请求**镜像存储**到 root session 的分组中。这样：

1. 用户在 root session 视图时，能看到所有 subagent（包括嵌套）的权限请求
2. 用户在 subagent session 视图时，也能看到该 subagent 的权限请求
3. Reply 路由不变——用户 reply 时 SDK 仍按原始 `requestID` 发送，Permission Service 按原始 sessionID 找到 deferred 并 resolve/fail
4. `permission.replied` 事件处理不变——按 `sessionID` 从对应分组中移除请求，但需要额外从 root session 的镜像分组中也移除

#### 4.1.2 数据流（修复后）

```
subagent tool → ctx.ask({permission, patterns})
     │
     ▼
Permission.ask(input)
     │
     ├─ evaluate → action="ask"
     │
     ▼
查找 rootSessionID:
     │  从 Session.parentID 链递归向上，直到 parentID 为 null
     │  rootSessionID = primary session 的 ID
     │
     ▼
Bus.publish(Permission.Event.Asked, { ...info, rootSessionID })
     │
     ▼
TUI sync.tsx:
     │
     ├─ store.permission[request.sessionID].push(request)  ← 原始存储（不变）
     │
     ├─ if (request.rootSessionID !== request.sessionID)
     │     store.permission[request.rootSessionID].push(request)  ← 镜像存储（新增）
     │
     ▼
TUI session view:
     │
     ├─ permissions() = children().flatMap(x => sync.data.permission[x.id])
     │     ← 现在 root session 的 permission 分组已包含所有 subagent 的镜像请求
     │     ← 嵌套 subagent 的请求也被包含（因为镜像到 root）
     │
     ├─ 子 session 视图: permissions() 不再返回空
     │     ← 移除 `if (session()?.parentID) return []` 限制
     │     ← 或改为从 root session 的镜像分组中收集
     │
     ▼
PermissionPrompt 显示 → 用户交互 → reply
     │
     ▼
Permission.Event.Replied 处理:
     │
     ├─ 从 store.permission[sessionID] 移除 request  ← 原始移除（不变）
     │
     ├─ 从 store.permission[rootSessionID] 移除 mirror  ← 镜像移除（新增）
     │     ← 需要在 request 对象上标记 rootSessionID 以便双向移除
     │
     ▼
Permission Service → Deferred resolve/fail → subagent 继续或终止
```

#### 4.1.3 详细改动

**A. Permission.Request Schema — 增加 rootSessionID 字段**

`packages/opencode/src/permission/index.ts`:

```ts
export const Request = z.object({
  id: PermissionID.zod,
  sessionID: SessionID.zod,
  rootSessionID: SessionID.zod.optional(), // 新增
  permission: z.string(),
  patterns: z.string().array(),
  metadata: z.record(z.string(), z.any()),
  always: z.string().array(),
  tool: z
    .object({
      messageID: MessageID.zod,
      callID: z.string(),
    })
    .optional(),
})
```

**B. Permission.ask() — 查找 rootSessionID 并附加**

`packages/opencode/src/permission/index.ts` ask 函数中，在创建 `info` 对象时，递归查找 root session：

```ts
// 在 info 创建后，添加 rootSessionID
const rootSessionID = await findRootSession(request.sessionID)
const info: Request = {
  id,
  ...request,
  rootSessionID, // 新增
}
```

新增 helper 函数：

```ts
async function findRootSession(sessionID: SessionID): SessionID | undefined {
  let current = await Session.get(sessionID)
  if (!current) return undefined
  while (current.parentID) {
    const parent = await Session.get(current.parentID)
    if (!parent) break
    current = parent
  }
  return current.id
}
```

**C. TUI sync.tsx — 镜像存储 permission.asked 事件**

`packages/opencode/src/cli/cmd/tui/context/sync.tsx`:

在 `permission.asked` case 中，增加镜像存储逻辑：

```ts
case "permission.asked": {
  const request = event.properties

  // 原始存储（不变）
  const requests = store.permission[request.sessionID]
  if (!requests) {
    setStore("permission", request.sessionID, [request])
  } else {
    const match = Binary.search(requests, request.id, (r) => r.id)
    if (match.found) {
      setStore("permission", request.sessionID, match.index, reconcile(request))
    } else {
      setStore("permission", request.sessionID, produce((draft) => {
        draft.splice(match.index, 0, request)
      }))
    }
  }

  // 镜像存储到 root session（新增）
  if (request.rootSessionID && request.rootSessionID !== request.sessionID) {
    const rootRequests = store.permission[request.rootSessionID]
    if (!rootRequests) {
      setStore("permission", request.rootSessionID, [request])
    } else {
      const rootMatch = Binary.search(rootRequests, request.id, (r) => r.id)
      if (!rootMatch.found) {
        setStore("permission", request.rootSessionID, produce((draft) => {
          draft.splice(rootMatch.index, 0, request)
        }))
      }
    }
  }
  break
}
```

**D. TUI sync.tsx — 镜像移除 permission.replied 事件**

`packages/opencode/src/cli/cmd/tui/context/sync.tsx`:

在 `permission.replied` case 中，增加从 root session 镜像分组移除的逻辑：

```ts
case "permission.replied": {
  const requests = store.permission[event.properties.sessionID]
  if (!requests) break
  const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
  if (!match.found) break

  // 获取被移除的 request，以便从 root session 镜像中也移除
  const removedRequest = requests[match.index]

  // 原始移除（不变）
  setStore("permission", event.properties.sessionID, produce((draft) => {
    draft.splice(match.index, 1)
  }))

  // 镜像移除（新增）
  if (removedRequest?.rootSessionID && removedRequest.rootSessionID !== event.properties.sessionID) {
    const rootRequests = store.permission[removedRequest.rootSessionID]
    if (rootRequests) {
      const rootMatch = Binary.search(rootRequests, event.properties.requestID, (r) => r.id)
      if (rootMatch.found) {
        setStore("permission", removedRequest.rootSessionID, produce((draft) => {
          draft.splice(rootMatch.index, 1)
        }))
      }
    }
  }
  break
}
```

**E. TUI session view — 移除子 session 权限显示限制**

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:137-139`:

```ts
// 旧:
const permissions = createMemo(() => {
  if (session()?.parentID) return []
  return children().flatMap((x) => sync.data.permission[x.id] ?? [])
})

// 新:
const permissions = createMemo(() => {
  // 主 session 视图: 从所有子 session (含嵌套镜像) 收集
  // 子 session 视图: 从自身 session + root session 镜像收集
  if (session()?.parentID) {
    // 子 session 视图: 显示自身权限 + root session 中属于本 session 子树的镜像
    const own = sync.data.permission[route.sessionID] ?? []
    return own
  }
  return children().flatMap((x) => sync.data.permission[x.id] ?? [])
})
```

**F. TUI — Toast 通知**

当 `permission.asked` 事件到达 TUI sync 时，如果当前查看的 session 与 `request.sessionID` 不匹配，发布 toast 提醒用户：

`packages/opencode/src/cli/cmd/tui/context/sync.tsx`:

在 `permission.asked` case 的镜像存储之后，增加 toast 逻辑：

```ts
// 检查当前查看的 session 是否包含此权限请求
const currentViewSessionID = route.sessionID // 需从 route context 获取
const isVisibleInCurrentView =
  currentViewSessionID === request.sessionID || currentViewSessionID === request.rootSessionID

if (!isVisibleInCurrentView && request.rootSessionID) {
  Bus.publish(TuiEvent.ToastShow, {
    title: "Permission Required",
    message: `Subagent "${request.metadata?.description ?? request.permission}" needs permission in session ${request.sessionID.slice(-6)}. Switch to the main session to approve.`,
    variant: "warning",
    duration: 10000,
  })
}
```

> 注意：sync.tsx 目前不直接访问 route context。toast 发布需要通过 Bus 机制（与 MCP auth toast 一致）。可在 sync 处理中直接 `Bus.publish(TuiEvent.ToastShow, ...)`——sync.tsx 已 import Bus。

**G. PermissionPrompt — 标注 subagent 来源**

当权限请求来自 subagent session 时，PermissionPrompt 应标注来源，帮助用户理解这是哪个 subagent 的请求：

`packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx:129`:

在 PermissionPrompt 的 header 区域增加 subagent 来源标注：

```tsx
// 在 header 中，若 request.sessionID !== 当前 sessionID 且 request.rootSessionID 存在
// 则标注来源 subagent
<Show when={request.sessionID !== route.sessionID && request.rootSessionID}>
  <text fg={theme.textMuted} fontSize="sm">
    (from subagent session {request.sessionID.slice(-6)})
  </text>
</Show>
```

### 4.2 方案 B: 在 session view 中递归收集嵌套子 session（被否决）

在 `children()` 中递归查找所有嵌套子 session（parentID 指向子 session 的 session），使 `permissions().flatMap` 能覆盖嵌套权限。

否决原因：

1. `sync.data.session` 可能不包含嵌套子 session——sync 只订阅当前查看的 session 和其直接子 session，嵌套子 session 可能不在 store 中
2. 即使 session 在 store 中，permission 数据也可能不在——sync 只订阅当前 session 及其直接子 session 的 permission 事件
3. 递归查找的性能开销（每帧重新计算所有嵌套子 session）

### 4.3 方案 C: 修改 Permission Service 使 ask/reply 在 root session 中操作（被否决）

让 Permission Service 将 `sessionID` 自动替换为 root session 的 ID，使 deferred 和 reply 全部在 root session 上下文中运行。

否决原因：

1. 破坏了 Permission Service 的 session 级别语义——approved ruleset 是 per-session 的，不同 subagent 的权限不应互相继承
2. Permission Service 的 `reply` 函数按 `sessionID` 批量 reject 同一 session 的所有 pending 请求——若改为 root session，reject 一个 subagent 的权限会连带 reject 同一 root session 下其他 subagent 的所有权限
3. 修改核心 Permission Service 逻辑的风险过高

---

## 5. 文件改动清单

| 文件                                                              | 操作     | 核心变更                                                                                                           |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/permission/index.ts`                       | **小改** | Request Schema 增加 `rootSessionID` 字段；`ask()` 函数中增加 `findRootSession()` 调用并附加 `rootSessionID`        |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx`              | **中改** | `permission.asked` 事件处理增加镜像存储到 root session；`permission.replied` 事件处理增加镜像移除；增加 toast 通知 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`      | **小改** | `permissions()` memo 移除子 session 强制返回空的限制，改为允许子 session 显示自身权限                              |
| `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx` | **小改** | PermissionPrompt header 增加 subagent 来源标注                                                                     |
| `packages/opencode/src/permission/schema.ts`                      | **小改** | 如果 PermissionID schema 在此文件，无需改动（rootSessionID 是 SessionID 类型）                                     |

SDK 层面：

| 文件                                | 操作     | 核心变更                                                 |
| ----------------------------------- | -------- | -------------------------------------------------------- |
| `packages/sdk/js/src/v2/session.ts` | **小改** | PermissionRequest 类型增加 `rootSessionID` 字段          |
| `packages/sdk/js/src/v2/event.ts`   | **小改** | `permission.asked` 事件 payload 类型增加 `rootSessionID` |

> 注意：SDK 类型变更需要同步生成。按 AGENTS.md 指示运行 `./packages/sdk/js/script/build.ts`。

核心源文件改动：**~5 处**。均为小改或中改，无大改。不涉及 DB schema 变更，不涉及 Permission Service 核心逻辑（ask/reply 的 deferred 机制不变），不涉及 session.sql.ts。

---

## 6. 对 research.md 的影响

### 6.1 无需修改 research.md

权限请求传播是 opencode 核心层的行为改进，不涉及 research agent 的指令、skill、MCP 配置或 dispatch 模板。所有改动在 opencode 源码层面自动生效。

### 6.2 研究流程受益场景

修复后，以下场景将自动改善：

| 场景                                                                     | 修复前                                                        | 修复后                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------- |
| research-worker 需要 `external_directory` 权限（如访问 `/tmp` 下载论文） | 权限请求仅在 worker session 中可见，用户在主 session 可能错过 | 权限请求镜像到主 session，toast 提醒用户 |
| worker dispatch 的 explore subagent 需要 `external_directory` 权限       | 权限请求不可见（嵌套 session）                                | 权限请求镜像到主 session                 |
| MCP 工具需要权限（research-conventions、research-state）                 | 权限请求仅在 worker session 可见                              | 镜像到主 session，toast 提醒             |
| 用户在 worker session 视图时遇到权限请求                                 | 强制返回空，无法看到                                          | 显示自身权限请求                         |

---

## 7. 验收清单

### 7.1 权限请求传播

1. 一级 subagent 需要 `ask` 权限 → 权限请求同时存储在 subagent session 和 root session 分组中
2. 嵌套 subagent（二级/三级）需要 `ask` 权限 → 权限请求同时存储在嵌套 session 和 root session 分组中
3. 用户在 root session 视图 → `permissions()` 包含所有 subagent（含嵌套）的权限请求
4. 用户在 subagent session 视图 → `permissions()` 包含该 subagent 自身的权限请求

### 7.2 权限回复

5. 用户在 root session 视图中批准/拒绝 subagent 权限 → Permission Service 按原始 `requestID` 处理 → subagent 继续/终止
6. 权限被批准后 → `permission.replied` 事件 → 从原始 session 分组移除 → 从 root session 镜像分组移除
7. 权限被拒绝后 → 同上（双向移除）
8. 批量 reject（Permission Service reject 一个 session 的所有 pending）→ 仅影响该 session 的请求，不影响其他 subagent

### 7.3 Toast 通知

9. 权限请求来自非当前查看的 session → toast 提醒用户切换到主 session
10. 权限请求来自当前查看的 session → 不发布 toast（PermissionPrompt 已直接可见）
11. Toast 内容包含 subagent 描述和权限类型

### 7.4 PermissionPrompt 标注

12. 权限请求来自 subagent session → PermissionPrompt header 标注 subagent 来源
13. 权限请求来自当前 session → 无额外标注

### 7.5 边界情况

14. root session 本身需要权限 → `rootSessionID` 等于 `sessionID`，不镜像存储（行为不变）
15. 非 task 来源的 session（cron、mobile）无 parentID → `rootSessionID` 等于自身，不镜像存储
16. session parentID 链中间断裂（parent session 不存在）→ `findRootSession()` 返回链顶端可达的 session ID，尽可能向上传播
17. PermissionPrompt 的 Allow always → 只影响发起 session 的 approved ruleset，不影响 root session 的规则（保持 per-session 语义）

### 7.6 性能

18. `findRootSession()` 查询 → 单次调用，最多 3 层递归（delegation_depth 限制为 3）→ 性能可接受
19. 镜像存储/移除 → 每次事件增加 1 次 Binary.search + 1 次 setStore → O(log n) 增量
20. `permissions()` memo → 不变（已从 store 直接读取，镜像存储使其自然包含更多数据）
