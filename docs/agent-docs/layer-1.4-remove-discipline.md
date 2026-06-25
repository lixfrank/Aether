# Layer 1.4: 删除 Discipline —— 权限策略回归 agent 声明式定义

> 前置依赖: Layer 0（`Discipline.compile`、`Permission.intersection`、`Agent.Info` 扩展字段）、Layer 1.1（`owner`/`owns` 域可见性——保留不动）、Layer 1.2（`skillRefs`/`outputDir` 删除——正交，不影响本文）
> 本文档删除 `session/discipline.ts` 全文 + `task` 工具 6 个新参数 + `Agent.Info` 4 个扩展字段 + `agent.ts` 的 Discipline 编译调用块。所有 `file_scope`/`env_scope`/`permission_override`/`delegation_depth` 能力回归 agent frontmatter 的 `permission` 字段（原生 `PermissionObject` 多 pattern 写法），运行时语义不变或更优。
> deny-filter 组装期过滤的简化（`evaluate` → `disabled`）由 **Layer 1.3** 承接，本文仅声明依赖关系，不重复其方案。
> 完成后：权限策略从"调用点指令式注入"回归"agent 定义声明式表达"——agent 在 `.md` frontmatter 一次声明 `permission`，不再在每次 `task` 调用时重复指定；`task.ts` 接近 upstream 简洁度，同时保留 `promptWithFallback`（韧性）与 `owner`/`owns`（域隔离）两个有价值的能力。

---

## 上下文

| Layer         | 状态       | 简介                                                                        |
| ------------- | ---------- | --------------------------------------------------------------------------- |
| Layer 0       | 已完成     | `Discipline.compile`、`Permission.intersection`、task 6 参数、Info 扩展字段 |
| Layer 1.1     | 已完成     | `owner`/`owns` 跨域可见性闸门（**保留不动**，与本文正交）                   |
| Layer 1.2     | 已完成     | `skillRefs`/`outputDir` 删除（**正交**，不冲突）                            |
| **Layer 1.4** | **本文档** | 删除 Discipline + task 6 参数 + Info 4 字段，回归 `permission` 声明式       |
| Layer 1.3     | 已完成     | deny-filter 改用 `disabled` + `approved`（本文 deny-filter 部分依赖此层）   |

---

## 1. 问题分析

### 1.1 Discipline 是"施工流程化"的根源

`Discipline.compile`（`session/discipline.ts`）把 `task` 工具调用参数（`permission_override`/`file_scope`/`env_scope`/`delegation_depth`）编译成 `Permission.Ruleset`。它引入一套**并行的权限表达表面**：本应在 agent 定义中静态声明的东西，被搬到每次 `task` 调用的参数里动态注入。

这与"适合各种问题的 agent 系统"的目标冲突——agent 不再是可灵活配置的通用组件，而是被调用者按工序临时装配的执行器。权限策略碎片化在两个地方（agent `.md` 的 `permission` + task 调用的 discipline 参数），维护成本与认知负担双倍。

### 1.2 6 个 task 参数中过半是死代码

| 参数                  | schema 声明 | `Discipline.compile` 是否消费 | `execute` 是否使用      | 状态               |
| --------------------- | ----------- | ----------------------------- | ----------------------- | ------------------ |
| `mode`                | ✅          | ❌                            | ❌ 完全未读             | **死代码**         |
| `permission_override` | ✅          | ✅ 生成规则                   | 间接（经 intersection） | 冗余               |
| `file_scope`          | ✅          | ✅ 生成规则                   | 间接                    | 冗余               |
| `delegation_depth`    | ✅ 0-3      | ✅ 仅 `===0` 时 deny task     | 间接                    | 冗余（1/2/3 无效） |
| `max_steps`           | ✅ 1-50     | ❌ compile 不读               | ❌                      | **死代码**         |
| `timeout_seconds`     | ✅ 30-600   | ❌ compile 不读               | ❌                      | **死代码**         |

6 个参数中：2 个完全死代码（`max_steps`/`timeout_seconds`），1 个纯声明未实现（`mode`），3 个功能冗余（`permission_override`/`file_scope`/`delegation_depth` 均能用 agent.permission 替代）。

> **`Discipline.Schema` 的另外 2 个字段**：上表只列 task 工具暴露的 6 个参数。`Discipline.Schema`（`discipline.ts:5-18`）实有 **7 个字段**，另两个不经过 task 工具：
>
> - `env_scope`（含 `allowed_commands`/`denied_commands`）——仅由 `agent.ts:297-305` 的 compile 块消费 frontmatter，编译成 bash 规则。本文 §4.3 删 compile 块、§4.5 把 `research.md` 的 `env_scope.denied_commands` 转写为 `permission.bash`。
> - `return_format`（`discipline.ts:17`，enum `text/structured/raw`）——**`compile()` 从不读取**，纯死 schema。随 `discipline.ts` 整文件删除一并消失，无迁移对象。
>
> 注意 `mode` 是 task 参数但**不在** `Discipline.Schema` 内（`discipline.ts` 无 `mode` 字段）——它只存在于 task 工具 schema，故 §4.2 单独删除。

### 1.3 关键发现：file_scope 的实际行为与文档承诺不符

`agent.ts` 的 Discipline.compile 调用块（行 297-305）在加载 agent 定义时，把 frontmatter 的 `file_scope` 编译成规则 `[{edit, *, deny}, {edit, .aether/research/**, allow}]`，然后 `Permission.merge` 进 `item.permission`。

随后 `prompt.ts` 的 deny-filter（行 1005-1009）用 `evaluate("edit", "*", rules)` 求值。`evaluate`（`evaluate.ts:11` 的 `findLast`）要求 `Wildcard.match("*", rule.pattern)` 为真——`{edit, .aether/research/**, allow}` 的 pattern 是 `.aether/research/**`，`Wildcard.match("*", ".aether/research/**")` = **false**，不匹配。故 `findLast` 命中 `{edit, *, deny}` → action=deny → **edit 工具被整个删除**。

所以 `research-worker.md` 写了 `edit: allow` + `file_scope: [.aether/research/**]`，实际结果是 **edit 工具根本不出现**。agent 正文里"edit/write within .aether/research (enforced by file_scope)"是**从未实现的期望行为**——模型连写工具都看不到，更不可能"在 .aether/research 内写"。

这证明 file_scope 当前既未实现"限写"，又制造了"工具消失"的副作用。删除它不会损失任何已生效的能力。

### 1.4 Discipline 的所有能力都能用 agent.permission 表达

`Config.Permission`（`config.ts:740-771`）的 `PermissionObject` 写法支持多 pattern：

```jsonc
{ "edit": { "*": "deny", ".aether/research/**": "allow" } }
```

`Permission.fromConfig`（`permission/index.ts:276-288`）将其转为 Ruleset `[{edit, *, deny}, {edit, .aether/research/**, allow}]`——与 `Discipline.compile` 对 `file_scope` 生成的规则**逐条相同**。

逐项对照：

| Discipline 参数                           | Discipline.compile 产出                                          | agent.permission 直接写法                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `permission_override: {bash: [allow]}`    | `{bash, *, allow}`                                               | `"bash": "allow"`                                                                                        |
| `permission_override: {bash: ["/usr/*"]}` | `{bash, /usr/*, allow}`                                          | `"bash": { "/usr/*": "allow", "*": "deny" }`                                                             |
| `env_scope.allowed_commands: [ls, git]`   | `{bash, *, deny}` + `{bash, ls*, allow}` + `{bash, git*, allow}` | `"bash": { "*": "deny", "ls*": "allow", "git*": "allow" }`                                               |
| `env_scope.denied_commands: [rm]`         | `{bash, rm, deny}`                                               | `"bash": { "rm": "deny" }`                                                                               |
| `file_scope: [.aether/research/**]`       | 4 写工具 `{*, deny}` + `{.aether/research/**, allow}`            | `"edit": {"*":"deny", ".aether/research/**":"allow"}`（写工具统一走 `edit`，无需 `write` 规则，见 §4.5） |
| `delegation_depth: 0`                     | `{task, *, deny}`                                                | `"task": "deny"`                                                                                         |

### 1.5 删除后的路径限写语义

删除 discipline 后，agent 的 `edit: {"*":"deny", ".aether/research/**":"allow"}` 规则如何生效：

- **组装期**（deny-filter，Layer 1.3 改用 `disabled` 后）：`disabled` 用 `findLast(Wildcard.match("edit", rule.permission))` 匹配所有 edit 规则，最后匹配的是 `{edit, .aether/research/**, allow}`，其 `pattern !== "*"` → **不删 edit 工具**。模型看得到 edit。
- **执行期**（`ctx.ask` → `Permission.ask` → `evaluate("edit", actualPath, rules)`）：当模型尝试写 `.aether/research/foo.md` 时，`Wildcard.match(".aether/research/foo.md", ".aether/research/**")` = true → 命中 allow → 放行；尝试写 `/etc/passwd` 时，`Wildcard.match("/etc/passwd", ".aether/research/**")` = false → 命中 `{edit, *, deny}` → 拒绝。

这正是 file_scope 文档**承诺但从未实现**的"限写"语义——删除 discipline + 依赖 Layer 1.3 的 `disabled` 改造后，它才真正生效。

> **对 Layer 1.3 的依赖**：本文删除 discipline 后，agent.permission 会包含 `{"*":"deny", "path":"allow"}` 这类路径级规则。若 deny-filter 仍用 `evaluate(perm, "*")`（1.3 改造前实现），会因 `Wildcard.match("*", "path")` = false 而命中 `*:deny` → 误删工具。Layer 1.3 已改用 `disabled`（前置依赖，见上下文表），路径级规则不被误删，故本文 agent `.md` 一律采用路径限写多 pattern 写法。

---

## 2. 当前实现追踪

### 2.1 Discipline 的两个消费点

| 消费点                 | 文件:行                  | 作用                                                                     |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------ |
| **agent.ts 静态加载**  | `agent/agent.ts:297-305` | 加载 agent 定义时编译 `file_scope`/`env_scope` 进 `item.permission`      |
| **task.ts 运行时调用** | `tool/task.ts:123-135`   | 把 task 调用参数编译成 `disciplineRules`，喂给 `Permission.intersection` |

### 2.2 涉及文件全清单

| 文件                                                 | 涉及内容                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/discipline.ts`                          | 整个文件（76 行，`Discipline` namespace，含 7 个 schema 字段）                                                                   |
| `src/tool/task.ts`                                   | import + 6 参数 + discipline 对象 + compile 调用 + intersection 调用                                                             |
| `src/agent/agent.ts`                                 | import + 4 个 Info schema 字段 + 4 行 merge 赋值 + compile 调用块                                                                |
| `src/config/config.ts`                               | **4 个 discipline schema 键 + knownKeys 白名单 4 项**（见 §4.4）                                                                 |
| `src/session/prompt.ts`                              | deny-filter 循环（**由 Layer 1.3 处理，本文不改**）                                                                              |
| `src/permission/index.ts`                            | `Permission.intersection`（**保留，见 §5.1**）                                                                                   |
| `.aether/agent/*.md`（8 个）                         | `file_scope` frontmatter 字段 + 正文引用；`research.md` 另有 `env_scope`（见 §4.5）                                              |
| `~/.aether/agent/*.md`（8 个）                       | 同上（由 `seedDefaultAssets` 同步，改源即可）                                                                                    |
| `test/layer-0/discipline-compile.test.ts`            | 整文件删除（测试 Discipline.compile）                                                                                            |
| `test/layer-0/discipline-schema-edges.test.ts`       | 整文件删除（测试 Discipline.Schema，含 `return_format`）                                                                         |
| `test/layer-0/permission-intersection.test.ts`       | 删 Discipline import + 2 个 discipline-override 用例；保留 5 个 intersection 用例（原 `intersection(...,[])` 收敛为两参）        |
| `test/layer-0/permission-intersection-edges.test.ts` | 删 Discipline import + 3 个 `Discipline.compile` 用例；保留 7 个 intersection 用例                                               |
| `test/layer-0/subagent-permission-flow.test.ts`      | 删 Discipline import + 2 个 `Discipline.compile` 用例；保留 2 个 intersection+disabled 用例（`intersection(...,[])` 收敛为两参） |
| `test/layer-0/agent-info-extensions.test.ts`         | 删 delegation_depth/env_scope/file_scope/leak 用例 + 改 undefined 用例（Layer 1.2 已先删 skill_refs 用例）                       |
| `test/layer-1/prompt-with-fallback.test.ts`          | 删 `Discipline.compile for task.ts params` 块（行 89-102）                                                                       |
| `test/layer-1/denied-tools.test.ts`                  | 测 `EDIT_TOOLS` export（Layer 1.3 改用 `disabled`）；另将 `:69` 用例标题的 stale `env_scope` 措辞改为 declarative                |
| `test/layer-2/fixture.ts`                            | `makeResearchConfig` 的 `env_scope.allowed_commands` 转写为 `permission.bash` 路径限写（deny-default allowlist）                 |
| `test/layer-2/research-primary.test.ts`              | T2.4 标题去 `env_scope`（断言不变，靠 fixture 声明式 bash 规则）；T2.24 改测 `permission.bash` 为对象 + `env_scope` 已 undefined |
| `test/layer-2/skills-and-file-loading.test.ts`       | `research.md` 加载用例的 `env_scope`+`bash:allow` 改为声明式 `permission.bash` 路径规则（deny-default allowlist）                |

### 2.3 Agent.Info 待删字段

`agent.ts:50-70`（`Agent.Info` schema 的 discipline 相关区段）：

```ts
delegationDepth: z.number().int().min(0).optional(), // ← 本文删
fileScope: z.string().array().optional(),            // ← 本文删
maxSteps: z.number().int().positive().optional(),    // ← 本文删
fallbackModels: z.array(...).optional(),             // ← 保留（韧性，与 discipline 无关）
envScope: z.object({                                 // ← 本文删
  allowed_commands: z.string().array().optional(),
}).optional(),
mcp: z.record(z.string(), z.boolean()).optional(),   // ← 保留
owner: z.string().optional(),                        // ← 保留（Layer 1.1）
owns: z.string().array().optional(),                 // ← 保留（Layer 1.1）
```

> `skillRefs`/`outputDir` 已由 Layer 1.2 删除，当前 schema 不含这两项，本文不再涉及。

本文删 4 个：`delegationDepth`、`fileScope`、`maxSteps`、`envScope`。保留 `fallbackModels`/`mcp`/`owner`/`owns`。

> **`maxSteps` 易误读，特此区分三处同名物**（删前务必认清）：
>
> | 位置                                        | 形态           | 用途                                                                                                                                | 本文处理                   |
> | ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
> | `Agent.Info.maxSteps`（`agent.ts:52`）      | camelCase 字段 | 由 `agent.ts:290` 从 config `max_steps` 赋值；**运行时无人读取**（`prompt.ts:594` 读的是 `agent.steps`，非 `maxSteps`）             | **删**（本文 §4.3）        |
> | `Config.Agent.max_steps`（`config.ts:876`） | snake_case 键  | discipline 参数，喂给 `Discipline.compile`                                                                                          | **删**（本文 §4.4）        |
> | `Config.Agent.maxSteps`（`config.ts:872`）  | camelCase 键   | **`steps` 的 deprecated 别名**，经 `config.ts:964`（`const steps = agent.steps ?? agent.maxSteps`）转成 `steps`；与 discipline 无关 | **保留**（非本文，勿误删） |
>
> 即：删的是 `Agent.Info.maxSteps` 字段 + `Config.Agent.max_steps`(snake) 键；`Config.Agent.maxSteps`(camel，steps 别名) 留着。同理 `Config.Agent.maxSteps` 仍在 `config.ts:929` 的 knownKeys 白名单内，保留。

---

## 3. 修复方案：删除 + 回归 permission 声明式

### 设计哲学

- **权限策略单一来源**：agent 的 `permission` frontmatter 字段是权限的唯一声明处。不再在 task 调用点重复注入。
- **声明式而非指令式**：agent 定义即权限边界，调用者无需也无法在每次 dispatch 时临时收紧/放宽。
- **复用原生机制**：`Permission.fromConfig` + `PermissionObject` 多 pattern 写法已是 opencode 原生能力，被 config 系统、UI、测试全链路支持。Discipline 是对其的冗余封装。
- **保留有价值的能力**：`promptWithFallback`（模型韧性）、`owner`/`owns`（域隔离）与 discipline 无关，保留不动。

### agent 文件改写原则

把 `file_scope` + 现有 `permission` 合并为纯 `permission`，删除 `file_scope` 字段，采用路径限写多 pattern 写法（依赖 Layer 1.3 已落地的 `disabled`，路径级 `{"*":"deny","path":"allow"}` 规则不会被误删）。

---

## 4. 改动清单

### 4.1 删除文件

**`src/session/discipline.ts`** —— 整个文件删除（76 行）。

### 4.2 `src/tool/task.ts`

**(a) 删除 import**（行 14）：

```ts
// 删除
import { Discipline } from "@/session/discipline"
```

**(b) 删除 6 个参数**（行 30-35）：

```ts
// 删除
mode: z.enum(["serial", "concurrent", "background"]).optional(),
permission_override: z.record(z.string(), z.string().array().optional()).optional(),
file_scope: z.string().array().optional(),
delegation_depth: z.number().int().min(0).max(3).optional(),
max_steps: z.number().int().min(1).max(50).optional(),
timeout_seconds: z.number().int().min(30).max(600).optional(),
```

**(c) 删除 discipline 对象 + compile 调用**（行 123-130）：

```ts
// 删除
const discipline = {
  permission_override: params.permission_override,
  file_scope: params.file_scope,
  delegation_depth: params.delegation_depth,
  max_steps: params.max_steps,
  timeout_seconds: params.timeout_seconds,
}
const disciplineRules = Discipline.compile(discipline)
```

**(d) intersection 调用：删除第三参 `override`（discipline 遗物），保留 2-arg 形态**（行 132-136）：

当前：

```ts
const sessionPermission = Permission.intersection(callerAgent?.permission ?? [], agent.permission, disciplineRules)
```

`intersection(parent, child, override)` 的第三参 `override` 是为合并 `disciplineRules` 而设——删 discipline 后 `disciplineRules` 不复存在，第三参恒为空。但 **`intersection` 函数本体与 2-arg 调用有独立语义**：它实现"子 agent 权限 ≤ 父 caller"的收紧（遍历 child 规则按 parent 求值、补齐 parent 未覆盖的 deny），服务本分支的跨域 dispatch（`owner`/`owns`，Layer 1.1）与路径限写场景，与 discipline 无关。故**只删第三参**，保留函数与 2-arg 调用（裁决见 §5.1）：

```ts
const sessionPermission = Permission.intersection(callerAgent?.permission ?? [], agent.permission)
```

**(e) 保留 `promptWithFallback`**（行 38-71）—— 与 discipline 无关，不动。

### 4.3 `src/agent/agent.ts`

**(a) 删除 import**（行 17）：

```ts
// 删除
import { Discipline } from "@/session/discipline"
```

**(b) 删除 4 个 Info schema 字段**（行 50-52, 66-70）：

```ts
// 删除
delegationDepth: z.number().int().min(0).optional(),
fileScope: z.string().array().optional(),
maxSteps: z.number().int().positive().optional(),
envScope: z
  .object({
    allowed_commands: z.string().array().optional(),
  })
  .optional(),
```

**(c) 删除 4 行 merge 赋值**（行 288-290, 292）：

```ts
// 删除
item.delegationDepth = value.delegation_depth ?? item.delegationDepth
item.fileScope = value.file_scope ?? item.fileScope
item.maxSteps = value.max_steps ?? item.maxSteps ?? item.steps
item.envScope = value.env_scope ?? item.envScope
```

**(d) 删除 Discipline.compile 调用块**（行 297-305）：

```ts
// 删除
const compileInput: z.infer<typeof Discipline.Schema> = {}
if (value.env_scope?.allowed_commands || value.env_scope?.denied_commands) {
  compileInput.env_scope = value.env_scope
}
if (value.file_scope) compileInput.file_scope = value.file_scope
if (Object.keys(compileInput).length > 0) {
  const compiled = Discipline.compile(compileInput)
  item.permission = Permission.merge(item.permission, compiled)
}
```

删除后，agent 的 `permission` 完全由 frontmatter 的 `permission` 字段经 `Permission.fromConfig` 生成，不再有运行时编译注入。

### 4.4 `src/config/config.ts`

config schema 是 discipline 字段的**上游声明处**——task 参数与 agent frontmatter 的 discipline 键都先经此 schema 解析。若只删 `agent.ts`/`task.ts` 而留着 config schema，这些键会变成"被接受但无人消费"的死配置，造成残留。故须同步清理。

**(a) 删除 4 个 discipline schema 键**（`config.ts:874-876`、`config.ts:890-895`）：

```ts
// 删除（config.ts:874-876）
delegation_depth: z.number().int().min(0).max(3).optional(),
file_scope: z.string().array().optional(),
max_steps: z.number().int().positive().optional(),

// 删除（config.ts:890-895）
env_scope: z
  .object({
    allowed_commands: z.string().array().optional(),
    denied_commands: z.string().array().optional(),
  })
  .optional(),
```

**(b) 从 knownKeys 白名单移除同名 4 项**（`config.ts:934-938`）：

```ts
// 从 knownKeys Set 中删除这 4 项
"delegation_depth",
"file_scope",
"max_steps",
"env_scope",
```

> **保留** `maxSteps`（camelCase，`config.ts:872`）及其 knownKeys 项（`config.ts:929`）——它是 `steps` 的 deprecated 别名（`config.ts:964` 转换），与 discipline 无关。三处 maxSteps 区分见 §2.3。
>
> `skill_refs`/`output_dir` 已由 Layer 1.2 删除，config schema 不再含这两项，本文无须处理。

**(c) 行为后果**：清理后用户 opencode.json/frontmatter 里残留的 `file_scope`/`env_scope`/`delegation_depth`/`max_steps` 不再被识别为已知键，因 schema 用 `.catchall(z.any())`（`config.ts:915`）不会报错，而是经 `config.ts:947` 的 unknown-key 分流落入 `options`（无害、不再被读取）。`agent.ts` 的对应读取行已由 §4.3 删除，无悬空引用。

### 4.5 agent .md 文件（8 个）

涉及：`research.md`、`research-worker.md`、`research-explorer.md`、`research-verifier.md`、`judgment-worker.md`、`local-executor.md`、`gpd-reviewer.md`、`gpd-verifier.md`。

> **写工具的 permission 只需 `edit` 一条**。`discipline.ts:50` 的 `WRITE_TOOLS` 列了 4 个（`edit`/`write`/`apply_patch`/`multiedit`），compile 时为每个生成独立 permission 规则。但运行时四者**全部用 permission 串 `"edit"`** 求值：
>
> - 组装期 deny-filter（`prompt.ts:1007`，`EDIT_TOOLS.includes(key) ? "edit" : key`）把 4 个工具名统一映射到 `"edit"` 再查规则；
> - 执行期 `ctx.ask` 中 `edit.ts:66/101`、`write.ts:36`、`apply_patch.ts:178` 均声明 `permission: "edit"`；`multiedit.ts:27` 直接复用 `EditTool.execute`。
>
> 故 `Wildcard.match("edit", "write")` = false——discipline 给 `write`/`apply_patch`/`multiedit` 生成的规则**从不命中**，是冗余。改写时**只需 `edit: {"*":"deny", "<path>":"allow"}` 一条**即可覆盖全部 4 个写工具；不要再写 `write:` 路径规则（死配置）。同理现状里的 `write: allow` 也直接删除（write 工具走 `edit` 权限，`write: allow` 从不命中）。

**改写示例（research-worker.md）**：

```yaml
# 现状
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  external_directory: ask
  research_conventions_*: allow
  research_state_*: allow
file_scope:
  - ".aether/research/**"

# 改为（路径限写）
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit:
    "*": deny
    ".aether/research/**": allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  external_directory: ask
  research_conventions_*: allow
  research_state_*: allow
# file_scope 字段删除；write 规则删除（写工具统一走 edit 权限，见上文）
```

`write` 规则一律删除（写工具统一走 `edit` 权限，`write:` 规则从不命中，是死配置，见上文）。

**逐 agent 分桶**（按 frontmatter 现状，已核对）：

| 桶                    | agent                                                                | 现状                                                    | 改写动作                                                 |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| A（edit+write allow） | `research`、`research-worker`、`research-explorer`、`local-executor` | `edit: allow` + `write: allow` + `file_scope`           | `edit` 转路径规则；删 `write`（死配置）；删 `file_scope` |
| B（仅 edit allow）    | `research-verifier`、`gpd-verifier`                                  | `edit: allow` + `file_scope`（无 `write`）              | `edit` 转路径规则；删 `file_scope`                       |
| C（只读 leaf）        | `judgment-worker`、`gpd-reviewer`                                    | 无 `edit`/`write` allow（`*: deny` 兜底）+ `file_scope` | 仅删 `file_scope`，无需路径规则                          |

`judgment-worker.md` 正文已说"READ-ONLY，不写任何文件"，`permission` 里本就无 `edit`/`write` allow（`*: deny` 兜底），删 `file_scope` 即可。

**`research.md` 的 `env_scope.denied_commands` 必须转写为 `permission.bash`**（其余 7 个 agent 无 `env_scope`，已逐一核对，不涉及）。`research.md:29-36` 现有：

```yaml
env_scope:
  denied_commands:
    - "git push --force*"
    - "git push -f*"
    - "git reset --hard*"
    - "git rebase -i*"
    - "git clean -fd"
    - "git checkout * -- ."
```

当前经 `agent.ts` compile 块（行 297-305）→ `discipline.ts:43-47` 编译成可用的 bash deny 规则（运行时 `evaluate("bash", <cmd>, rules)` 命中 deny）。**删 compile 块后若不转写，破坏性 git 命令防线直接消失**——这是本文唯一的"已生效能力迁移点"，不可遗漏。转写为：

```yaml
bash:
  "*": allow
  "git push --force*": deny
  "git push -f*": deny
  "git reset --hard*": deny
  "git rebase -i*": deny
  "git clean -fd": deny
  "git checkout * -- .": deny
```

`"*": allow` 保留 research 原本的 `bash: allow`（全放行）语义；deny 条目排在其后，`evaluate` 的 `findLast` 使 deny 对匹配命令生效、其余放行——与 compile 产出逐条等价。`research.md` 同时落入桶 A，`edit`/`file_scope` 按 A 处理。

**正文引用清理**：各 agent 正文里"enforced by file_scope"、"delegation_depth=0"等措辞需相应调整——`file_scope` 改为"enforced by permission rules"或直接删除（权限系统已是既定事实，无需在 prompt 里解释机制）；`delegation_depth=0` 改为"you have no task permission"（因 `task: deny` 已在 permission 里声明）。

### 4.6 测试文件

**整文件删除**（被测对象 `discipline.ts` 不存在）：

- `test/layer-0/discipline-compile.test.ts`
- `test/layer-0/discipline-schema-edges.test.ts`（含 `return_format` 用例，随文件消失）

**改写（删 Discipline 依赖，保留 intersection 链路）**：

| 测试文件                                             | 删除                                                                                                   | 保留                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/layer-0/permission-intersection.test.ts`       | Discipline import（行 3）+ 2 个 discipline-override 用例（env_scope whitelist、delegation_depth=0）    | 5 个 intersection-only 用例（行 9-59，统一为两参 `intersection(parent, child)`；原 `intersection(parent, child, [])` 已收敛为两参）               |
| `test/layer-0/permission-intersection-edges.test.ts` | Discipline import（行 3）+ 3 个 `Discipline.compile` 用例                                              | 7 个 intersection-only 用例（行 7-54，均为两参）                                                                                                  |
| `test/layer-0/subagent-permission-flow.test.ts`      | Discipline import（行 3）+ 2 个 `Discipline.compile` 用例（research-explorer、research-verifier 场景） | 2 个用例（行 7-48：`primary_tools deny` + `general subagent sessionDenyRules`，用两参 `intersection(parent, child)` + `disabled`，无 Discipline） |

> 注意：上表"保留"的用例原本调用 `Permission.intersection(parent, child, [])`（三参、空 override）或两参形式。由于 §5.1 删除了 `intersection` 的第三参（签名收敛为 `intersection(parent, child)`），原三参 `intersection(parent, child, [])` 调用现在是 TS 过参错误，**必须改写为两参 `intersection(parent, child)`**；原本就是两参的用例不动。**"intersection 函数保留" ≠ "测试文件原样保留"**：凡是 `import { Discipline }` 的文件，删 discipline.ts 后导入即断，必须删掉 import 与 compile 用例；同时把残留的 `intersection(..., [])` 三参调用收敛为两参。

**改写（删 Info 字段断言）** — `test/layer-0/agent-info-extensions.test.ts`（Layer 1.2 已先删 `skill_refs` 用例，当前 114 行）：

- 删 4 个用例（全部断言 discipline 字段/compile，被测对象已删）：
  - `delegation_depth from config...`（行 14-31）
  - `env_scope...compiles bash`（行 33-54）
  - `file_scope...populates fileScope`（行 56-73）
  - `new fields do not leak into options`（行 75-97）——§4.4 把这 3 键移出 knownKeys 后它们会落入 `options`，"不泄漏"断言反转失效，整例删除。
- 改 `undefined new fields = v0.6.0 behavior`（行 99-113）：删 `build?.delegationDepth`/`fileScope`/`envScope` 三行 `.toBeUndefined()`（字段已从 schema 删，访问即 TS 报错）；**保留**末两行 `Permission.evaluate("edit","*",build.permission)===allow` 与 `Permission.evaluate("todowrite","*",general.permission)===deny`（v0.6.0 基线，仍有效）。
- `skill_refs` 用例已由 Layer 1.2 删除，本文件不再含，无须处理。

**改写** — `test/layer-1/prompt-with-fallback.test.ts`：

- 删 `Discipline.compile for task.ts params` 测试块（行 89-102）；保留全部 `promptWithFallback` 重试逻辑测试（行 8-87）。该块用 `require("../../src/session/discipline")`，文件删除后 require 抛错，必须整块删除。

**改写（layer-2：env_scope 编译依赖迁移为声明式 bash）** — 以下测试原本依赖 `agent.ts` 的 `env_scope` compile 块（本文 §4.3 删除）。删 compile 后 `bash: allow` 不再被 `env_scope.allowed_commands` 收紧，`rm -rf /` 等会误放行，必须把 fixture/用例的 `env_scope.allowed_commands` 转写为 `permission.bash` 路径限写（deny-default allowlist，与 compile 产出逐条等价）：

- `test/layer-2/fixture.ts`：`makeResearchConfig` 删 `env_scope: { allowed_commands: [uv, curl, rg, grep, git] }`，`bash` 从 `"allow"` 改为 `{ "*": "deny", "uv*": "allow", "curl*": "allow", "rg*": "allow", "grep*": "allow", "git*": "allow" }`（与原 compile 产出等价）。
- `test/layer-2/research-primary.test.ts`：T2.4 标题去 `env_scope`（断言不变，靠 fixture 声明式 bash 规则通过）；T2.24 由"bash controlled by env_scope"改为"bash declaratively declared as deny-default allowlist"——断言 `permission.bash` 为对象 + `cfg.env_scope` 为 undefined。
- `test/layer-2/skills-and-file-loading.test.ts`：`research.md` 加载用例的 `bash: allow` + `env_scope.allowed_commands` 改为声明式 `permission.bash` 路径规则；断言（uv/curl allow、rm deny）不变。
- `test/layer-1/denied-tools.test.ts`：`:69` 用例标题的 stale `env_scope` 措辞改为 declarative（用例体本就手写声明式 bash 规则，仅标题过期）。

---

## 5. 设计决策与权衡

### 5.1 `Permission.intersection`：第三参是 discipline 遗物，函数本体保留（Layer 1.5 §5.5 已裁决）

`intersection(parent, child, override?)`（`permission/index.ts:299-325`）有两个层面：

- **第三参 `override`**：`merge(child, override ?? [])` 把 override 合进 child 再求值——这是为 `disciplineRules` 而设的。删 discipline 后 override 恒为空，此参是 discipline 遗物，本文删除。
- **函数本体（2-arg 语义）**：遍历 child 规则按 parent 求值（parent deny 则子 deny、子 allow 须 parent allow 才放行、否则降级），并补齐 parent 中未被 child 覆盖的 deny——实现"子 agent 权限 ≤ 父 caller"的收紧。**这套逻辑不依赖 discipline**，服务本分支跨域 dispatch（`owner`/`owns`，Layer 1.1）与路径限写（Layer 1.3/1.4）场景，防止 permission 较宽的子 agent（如 `general` `*:allow`）被较窄 caller dispatch 时权限提升。

故本文**仅移除第三参**，保留 `intersection` 函数与 2-arg 调用。`intersection` 的去留已由 **Layer 1.5 §5.5 裁决为保留**（作为子≤父安全收紧，是有意偏离 upstream——upstream `task.ts` 从不调用 `intersection`）。本层删除第三参后保留 2-arg 形态：

```ts
const sessionPermission = Permission.intersection(callerAgent?.permission ?? [], agent.permission)
```

详见 Layer 1.5 §5.5。

### 5.2 为何不回归 upstream 的 `tools:{x:false}` —— `finalPermission` 非冗余

一个看似更小的改动：删掉 `finalPermission` 中间层与 deny-filter，让 task.ts 重新传 `tools:{task:false, todowrite:false, primary_tools:false}`，回归 upstream 的工具隐藏路径。但这与 §5.1 保留 `intersection` 冲突，不可行：

**upstream 的 `tools:{x:false}` 会覆盖 session.permission**（`prompt.ts:186-188`）：task.ts 传 `tools:{x:false}` → prompt.ts 把它转成 permission 规则后 `session.permission = permissions`（**赋值覆盖**，非 merge）。这会冲掉 `Session.create` 里设的 `finalPermission`（含 `intersection` 结果）——intersection 的子≤父收紧全部丢失。该覆盖陷阱经 Layer 1.5 §5.1 评估后**保留不改**（对 upstream 最小侵入），由 `task.ts` 单轨规避（Layer 1.5 §3）。

因此只要保留 `intersection`（§5.1），就必须：

1. **不传 `tools:{x:false}`**（否则覆盖 intersection 结果）——改由 deny-filter（Layer 1.3）隐藏工具；
2. **在 permission 里写 deny 规则**供 deny-filter 识别——即 `sessionDenyRules`（task/todowrite deny，与 upstream `hasTaskPermission?[]:{task,*:deny}` 等价，仅提取成变量）+ `primary_tools deny`（upstream 用 `tools:false` 隐藏 + permission allow；当前无 `tools:false`，故须 permission deny 才被 filter 删）；
3. **用 `finalPermission` 拼合** `intersection` 结果 + 上述 deny 规则，作为 `Session.create` 的 permission。

这条链每一步由前一步决定，无冗余。`finalPermission` 是承载 intersection 结果的必要载体——只要 intersection 保留，它就不是冗余中间层。唯一能更小的是"放弃 intersection、整条链回归 upstream"，但那是推翻 §5.1 裁决，超出本文 scope。

> `promptWithFallback`（task.ts:38-71）封装 prompt 调用、不传 `tools` 参数——重新加回 `tools:{x:false}` 还涉及 Layer 1.5 的传递机制，进一步印证不应在此回归。

故 deny-filter + `finalPermission` 保留，本文不碰 prompt.ts 的覆盖陷阱。

### 5.3 deny-filter 方案由 Layer 1.3 定案

组装期 deny-filter 改用 `Permission.disabled`（替代当前 `evaluate`）的方案选型属 Layer 1.3 范畴，本文不重复。本文仅声明依赖：agent `.md` 路径限写改写（§4.5）依赖 Layer 1.3 已落地的 `disabled`（前置依赖，见上下文表），否则路径级 `{"*":"deny","path":"allow"}` 规则会被误删。

### 5.4 `mode`/`max_steps`/`timeout_seconds` 死代码直接删

`mode`（serial/concurrent/background）从未被 `execute` 读取，`promptWithFallback` 是纯同步 await。`max_steps`/`timeout_seconds` 连 `Discipline.compile` 都不消费。三者纯声明未实现，删除零行为影响。

---

## 6. 影响面核对

| 场景                                 | 预期                                             | 依据                                   |
| ------------------------------------ | ------------------------------------------------ | -------------------------------------- |
| research-worker dispatch             | permission 由 frontmatter 声明，不再有运行时编译 | agent.ts compile 块删除                |
| research-worker edit 工具可见性      | **可见**（Layer 1.3 后 `disabled` 不误删）       | `disabled` 粒度修正                    |
| research-worker 写 .aether/research/ | **放行**（路径 allow 命中）                      | 执行期 `evaluate("edit", path, rules)` |
| research-worker 写 /etc/             | **拒绝**（`*:deny` 命中）                        | 同上                                   |
| judgment-worker（只读 leaf）         | 无 edit/write 工具（`*:deny` 兜底）              | `disabled` 删 `*:deny` 工具            |
| build/plan dispatch general          | 无变化（general 无 file_scope）                  | 不涉及 discipline                      |
| `promptWithFallback` 重试            | 不变                                             | 与 discipline 无关，保留               |
| `owner`/`owns` 域隔离                | 不变                                             | Layer 1.1，正交保留                    |
| `intersection` 子≤父收紧             | 不变（2-arg 保留，仅第三参删除）                 | §5.1，第三参是 discipline 遗物         |
| `bun typecheck`                      | 通过                                             | 删除的字段/参数无残余引用              |

---

## 7. 验收清单

**删除完整性（无残留）：**

1. `src/session/discipline.ts` 文件不存在
2. `task.ts` parameters 不含 `mode`/`permission_override`/`file_scope`/`delegation_depth`/`max_steps`/`timeout_seconds`
3. `task.ts` 不 import `Discipline`，不含 `disciplineRules` 变量；`intersection` 调用为 2-arg 形态（无第三参 `override`/`disciplineRules`）
4. `agent.ts` `Agent.Info` schema 不含 `delegationDepth`/`fileScope`/`maxSteps`/`envScope`
5. `agent.ts` merge 循环不含上述 4 字段赋值，不含 `Discipline.compile` 调用块
6. `config.ts` `Config.Agent` schema 不含 `delegation_depth`/`file_scope`/`max_steps`/`env_scope`；knownKeys 白名单不含这 4 项；**保留** `maxSteps`（camelCase，steps 别名）
7. **全仓无残留**：`grep -rn "Discipline" packages/opencode/src packages/opencode/test` 无匹配（src+test 无任何 Discipline import/引用）
8. 8 个 agent `.md` frontmatter 不含 `file_scope`/`env_scope`/`delegation_depth`/`max_steps`/`permission_override`（不止 `file_scope`）
9. `research.md` 的破坏性 git 命令 deny 已迁入 `permission.bash`（A2）：`Permission.evaluate("bash", "git push --force origin", rules).action === "deny"`

**行为正确性：**

10. research-worker 的 edit 工具**可见**（Layer 1.3 `disabled` 不误删）
11. research-worker 写 `.aether/research/**` 放行、写外部路径被拒（执行期 `evaluate` 命中路径 allow / `*:deny`）
12. `promptWithFallback` 行为不变（fallback 重试仍生效）

**构建/测试：**

13. `bun typecheck` 在 `packages/opencode` 通过
14. `test/layer-0/discipline-*.test.ts` 不存在；`permission-intersection*.test.ts`/`subagent-permission-flow.test.ts`/`agent-info-extensions.test.ts`/`prompt-with-fallback.test.ts` 已按 §4.6 改写且无 `Discipline` import
15. `bun test test/layer-0 test/layer-1 test/layer-2` 通过（更新后的测试；layer-2 含 `env_scope`→声明式 bash 迁移用例）

---

## 8. 测试策略

### 8.1 删除的测试

- `test/layer-0/discipline-compile.test.ts`（整文件）
- `test/layer-0/discipline-schema-edges.test.ts`（整文件）
- `test/layer-1/prompt-with-fallback.test.ts` 中 `Discipline.compile for task.ts params` 块（**行 89-102**）
- 各 intersection/subagent 测试文件内依赖 `Discipline.compile` 的用例（详见 §4.6，非整文件删）

### 8.2 更新的测试

逐文件改动见 §4.6。要点：

| 测试文件                                             | 改动                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test/layer-0/permission-intersection.test.ts`       | 删 Discipline import + 2 个 override 用例；保留 5 个 intersection-only 用例（原 `intersection(..., [])` 收敛为两参）                   |
| `test/layer-0/permission-intersection-edges.test.ts` | 删 Discipline import + 3 个 `Discipline.compile` 用例；保留 7 个 intersection-only 用例                                                |
| `test/layer-0/subagent-permission-flow.test.ts`      | 删 Discipline import + 2 个 `Discipline.compile` 用例；保留 2 个两参 `intersection(parent, child)`+`disabled` 用例                     |
| `test/layer-0/agent-info-extensions.test.ts`         | 删 delegation_depth/env_scope/file_scope/leak 用例；改"undefined fields"用例去 discipline 字段断言（Layer 1.2 已先删 skill_refs 用例） |
| `test/layer-1/denied-tools.test.ts`                  | 由 Layer 1.3 处理（改用 `disabled` 语义）；`:69` 标题 stale `env_scope` 措辞改为 declarative                                           |
| `test/layer-2/fixture.ts`                            | `makeResearchConfig` 的 `env_scope.allowed_commands` 转写为 `permission.bash` deny-default allowlist                                   |
| `test/layer-2/research-primary.test.ts`              | T2.4 标题去 `env_scope`（断言不变）；T2.24 改测 `permission.bash` 为对象 + `env_scope` undefined                                       |
| `test/layer-2/skills-and-file-loading.test.ts`       | `research.md` 加载用例 `env_scope`+`bash:allow` 改为声明式 `permission.bash` 路径规则                                                  |

### 8.3 新增测试点

- **permission 声明式路径限写**：构造 agent `permission: {edit: {"*":"deny", ".aether/research/**":"allow"}}`，断言 `disabled(["edit","write","apply_patch","multiedit"], rules)` 返回空集（edit 及其余写工具不隐藏），且 `evaluate("edit", ".aether/research/x", rules)` = allow、`evaluate("edit", "/etc/x", rules)` = deny。落地于 `test/layer-1/declarative-permission.test.ts`。
- **task 参数精简**：断言 `TaskTool` 的 parameters schema 不含 6 个删除字段（防回归）。落地于同文件。
- **agent 加载无 compile**：断言加载带 `file_scope` 的 agent `.md` 时 `item.permission` 不含由 compile 生成的规则，且该未知键落入 `options`。落地于同文件（用 `general` + `file_scope` config）。
- **env_scope 迁移不丢约束**：声明式 bash 规则的 deny/allow 语义由 `test/layer-1/declarative-permission.test.ts` 用与 `research.md` 等价的 `permission.bash` 规则断言（`git push --force*`/`git reset --hard*`/`git clean -fd` → deny，`ls`/`git status` → allow）；agent 实际加载链路另由 `test/layer-2/research-primary.test.ts`（T2.4，fixture 声明式 bash）与 `test/layer-2/skills-and-file-loading.test.ts`（加载 `research.md` 临时副本）覆盖。

### 8.4 手动验证

1. research-worker 能看到 edit 工具（对比当前：看不到；write 工具同理，二者走 `edit` 权限）
2. research-worker 能在 `.aether/research/` 内写文件（对比当前：不能）
3. research-worker 写 `.aether/research/` 外的路径被权限拦截
4. judgment-worker 无 edit/write/task 工具
5. `research` agent 拒绝执行 `git push --force` / `git reset --hard`（A2 迁移生效），允许 `git status` / `ls`
6. `bun typecheck` 通过

---

## 9. 落地顺序

```
Layer 1.3（deny-filter 改 disabled + approved）
    ↓ （前提：路径级 permission 规则不被误删）
Layer 1.4（本文：删 discipline + task 6 参数 + Info 4 字段 + agent .md 改写）
    ↓
Layer 1.5（已裁决：保留 intersection §5.5；task.ts 单轨契约注释固化 §3；覆盖陷阱保留为已知残余限制 §5.1）
```

Layer 1.3（deny-filter 改 disabled + approved）先于 Layer 1.4 落地，确保路径级 permission 规则不被误删；本文 agent `.md` 路径限写改写以此为基础。

---

## 10. 跨层观察与实施指引

### 10.1 Layer 1.2 已落地确认

Layer 1.2（`skillRefs`/`outputDir` 删除）经核对当前代码**确已落地**：

- `agent.ts` 的 `Agent.Info` 与 `config.ts` 的 `Config.Agent` schema 均不含 `skillRefs`/`skill_refs`/`outputDir`/`output_dir`；
- `system.ts`、`prompt.ts` 亦无 `agent.skillRefs`/`agent.outputDir`/`SystemPrompt.outputDir` 读取点（grep 全空）。

故本层无须、也不会触碰这两项——它们已不存在。本文 §2.3 代码块、§4.4、§4.6 均不再列出。

### 10.2 §1.4 表格"4 写工具"的措辞

§1.4 `file_scope` 行的"4 写工具"准确描述 `discipline.compile` 的产出（为 edit/write/apply_patch/multiedit 各生成规则）。但如 §4.5 所证，其中 write/apply_patch/multiedit 三套规则运行时从不命中（四者统一走 `edit` 权限），属冗余。故改写时只需 `edit` 一条，勿据"4 写工具"误以为要写 4 条路径规则。

### 10.3 行号定位指南

本文 `file:line` 引用已核对为当前代码行号。但代码库仍在活跃重构，行号可能再次漂移——**以 §4 的代码块内容 + 下表 grep 锚点为准**，行号仅作导航：

- discipline.ts 整文件 — `rg -l "namespace Discipline" src/session/discipline.ts`
- task.ts 6 参数 — `rg "permission_override|file_scope|delegation_depth|max_steps|timeout_seconds|mode: z.enum" src/tool/task.ts`
- task.ts discipline 对象+compile — `rg "Discipline.compile" src/tool/task.ts`
- agent.ts Info 4 字段 — `rg "delegationDepth:|fileScope:|maxSteps:|envScope:" src/agent/agent.ts`
- agent.ts merge 4 赋值 — `rg "item\.(delegationDepth|fileScope|maxSteps|envScope) =" src/agent/agent.ts`
- agent.ts compile 块 — `rg "Discipline.compile" src/agent/agent.ts`
- config.ts discipline schema 键 — `rg "delegation_depth:|file_scope:|max_steps:|env_scope:" src/config/config.ts`
- config.ts knownKeys 4 项 — `rg '"delegation_depth"|"file_scope"|"max_steps"|"env_scope"' src/config/config.ts`
- config.ts maxSteps（steps 别名，**保留**） — `rg "maxSteps:.*deprecated" src/config/config.ts`
- prompt.ts deny-filter — `rg "EDIT_TOOLS.includes\(key\)" src/session/prompt.ts`
- 全仓 Discipline 残留（验收项 7） — `rg "Discipline" src test`

实施时先跑上表 grep 定位，再按 §4 代码块删改。若 grep 命中数与本文预期不符，说明代码已漂移，须重新核对本文各节后再动手。

### 10.4 跨文档 Discipline 残留（仅记录，不在本文处理）

`layer-3.4-subagent-runtime-limits.md`、`layer-3.7-state-recovery.md` 等历史设计文档仍把 `Discipline.compile` 当作可扩展的存在物（3.7 §5.1 提议为其加 `denied_commands`）。这些层的运行时代码经 §7 验收项 7 的 grep 确认**不 import Discipline**（src 中仅 discipline.ts/task.ts/agent.ts 三处引用），故删除 discipline 不会破坏 3.x 运行时；仅文档层面留有 stale 引用，按用户指示不在本文处理。`layer-5-background-execution.md` 设计已被判定不合适，**已删除**——但其余约 10 个文档（`layer-0`/`layer-1`/`layer-1.2`/`layer-2`/`layer-3`/`layer-3.1`/`layer-3.13`/`layer-4`/`research-agent-v2-overview` 等）仍在其依赖表/层列表里引用"Layer 5"，属遗留清理项，需另行统一处理（不在本文 scope）。
