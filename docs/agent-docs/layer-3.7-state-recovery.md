# Layer 3.7: Research State Machine Recovery — Git-Backed Rollback + Consistency Fix

> 前置依赖: Layer 0-3.6（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Health Check — 其中 Layer 1 git 可用性检测必须通过，否则本方案的 Phase Commit 和 rollback 不可用）
> 本文档定义 research agent 状态机的恢复机制改进，解决当前 SESSION RECOVERY 设计中的 8 个缺陷，引入 git-backed rollback + Permission.denied_commands 作为核心回滚与安全机制。

---

## 目录

1. [问题清单](#1-问题清单)
2. [工具限制基础设施分析](#2-工具限制基础设施分析)
3. [设计决策汇总](#3-设计决策汇总)
4. [Git-Backed Rollback Protocol](#4-git-backed-rollback-protocol)
5. [Permission denied_commands 执行层设计](#5-permission-denied_commands-执行层设计)
6. [Phase Commit Protocol](#6-phase-commit-protocol)
7. [MCP 层修复](#7-mcp-层修复)
8. [Research Agent Prompt 修改](#8-research-agent-prompt-修改)
9. [验收清单](#9-验收清单)

---

## 1. 问题清单

### P0-1: `_default_state()` 默认阶段名不合法

**现状**: `server.py:50-57` `_default_state()` 返回 `phase: "exploration"`，但 research.md Phase ↔ state.json Mapping 表中合法阶段名为 `gate, phase_analysis, phase_landscape, phase_framing, phase_checkpoint, phase_execution, completed`。`"exploration"` 不在其中。

**后果**: 恢复时读到 `"exploration"` 无法匹配任何阶段，路由逻辑将无法确定当前进度。当前 state.json 文件实际存储 `phase: null`（手动初始化），与 `_default_state()` 也不一致 — MCP `_read_state_safe` 的 fill-missing-keys 逻辑会用 `"exploration"` 覆盖 `null` phase 字段。

**修复**: `_default_state()` 改为 `phase: "gate"`, `plan_number: "0"`。见 §7.1。

### P0-2: `advance_plan` 无回滚能力

**现状**: research.md:303-309 规定 phase_checkpoint 拒绝时需回滚 state.json 到修正阶段，但 `advance_plan` 只做正向推进 — 将旧阶段追加到 `completed_plans` 后写入新阶段。回滚操作会把被回滚的阶段错误记录为"已完成"。

**后果**: checkpoint 拒绝后的回滚无法正确执行。State Consistency Check（research.md:281-289）依赖 "state.json 超前则回滚"，同样无法实现。

**修复**: 引入 git-backed rollback，不依赖 MCP rollback 工具。见 §4。

### P1-1: STATE.md 与 state.json 双写一致性无保障

**现状**: 恢复流程要求同时读 STATE.md 和 state.json 确认一致（research.md:430-431），但两者由不同机制更新 — STATE.md 由 agent 手动编辑，state.json 由 MCP `advance_plan` 原子写入。Worker 可能写 STATE.md 但没调 advance_plan，或反之。

**后果**: 两文件不一致时，恢复逻辑无法确定真实进度。State Consistency Check 依赖 MCP 回滚能力（不可用）。

**修复**: Phase Commit Protocol 将两者放入同一 git commit，保证原子一致性。见 §6。回滚时 git checkout 同时恢复两者。

### P1-2: Digest Fallback 过于宽松

**现状**: research.md:409-412 规定：如果 digest YAML 解析失败但文件存在，推断阶段完成并继续路由。

**后果**: Worker 可能写了部分输出后崩溃 — 文件存在不代表阶段完成。跳过未完成的工作会导致后续阶段在残缺输入上运行。

**修复**: 改为三档判定：completed / incomplete / missing。incomplete 和 missing 都不自动继续，需用户决策。见 §8.2。

### P2-1: `advance_plan` 自动推进依赖 ROADMAP.md 格式

**现状**: `server.py:234-244` 空 phase/plan_number 时从 ROADMAP.md 解析阶段名。`_parse_roadmap_phases` 用正则 `^#+\s*Phase\s+(\d+)\s*:\s*(.+)` 匹配标题。但 ROADMAP.md 由 deep-research skill 生成，格式不一定匹配。

**后果**: 自动推进在 ROADMAP.md 不存在或格式不匹配时，静默使用 `phase-{N}` 占位名，与映射表合法阶段名不一致。

**修复**: 增加硬编码合法阶段列表作为 fallback。同时：agent 应始终显式传 phase/plan_number，不再依赖自动推进。见 §7.2。

### P2-2: phase_execution cycle 计数依赖 digest 质量

**现状**: 恢复 phase_execution 时需从 DIGESTS.md 确定当前 cycle 号和状态（research.md:436）。DIGESTS.md 是自由格式 YAML 附录，无结构化 cycle 计数器。

**后果**: Digest 格式不规范时无法准确判断 cycle 号，可能重复执行已完成的 cycle 或跳过未完成的。

**修复**: state.json 增加 `execution_cycle` 字段，由 `advance_plan` 在 execution 子阶段管理。见 §7.3。

### P2-3: plan_number 类型不一致

**现状**: Mapping 表用整数（0-6），但 `advance_plan` 参数类型为 `str`。`_default_state` 返回 `"0"`（字符串），当前 state.json 存储 `null`。`_read_state_safe` 的 fill-missing-keys 逻辑会用 `"0"` 覆盖 `null`，但 agent 可能传整数。

**后果**: 比较逻辑需处理字符串 vs 整数 vs null 三种情况，容易出错。`int(current_state.get("plan_number", "0"))` 在 `"0"` 和 `0` 两种输入下行为不同。

**修复**: state.json schema 规范化：phase 和 plan_number 统一为字符串类型。MCP 工具强制类型转换。见 §7.4。

### P0-3: Git 破坏性命令约束依赖 prompt 自律，无代码层保障

**现状**: research.md 状态机需要 agent 执行 git checkout/clean/add/commit 等操作用于 phase commit 和 rollback。当前对这些操作的"安全约束"完全依赖 AGENTS.md 中的 prompt 指令（"NEVER run destructive/irreversible git commands"）和 bash.txt 工具描述中的引导文本。这些不是代码层约束 — LLM 可以直接执行 `git push --force`、`git reset --hard` 等命令，bash 工具不会拦截。

**后果**: rollback protocol 的可靠性无法保障。如果 agent（或 subagent）执行了破坏性 git 命令，整个回滚机制失效 — git 历史被改写后无法 checkout 到目标版本。Subagent（research-worker）同样有 `bash: allow` 权限，不受 coordinator 的 prompt 约束。

**修复**: 在 Discipline.compile() 增加 `env_scope.denied_commands` 字段，编译为 Permission deny 规则。bash 工具的 tree-sitter 解析 + ctx.ask() 管线会在代码层拦截被 deny 的命令模式（抛出 DeniedError）。Permission.intersection() 自动将 deny 传播给 subagent。见 §5。

---

## 2. 工具限制基础设施分析

### 2.1 代码层 vs Prompt 层约束现状

| 机制                       | 代码层执行 | Prompt 层引导 | 说明                                                                                                     |
| -------------------------- | :--------: | :-----------: | -------------------------------------------------------------------------------------------------------- |
| Tool 可用性                |     ✅     |      ❌       | deny + `pattern: "*"` → 从 LLM tool set 删除，LLM 根本看不到该工具                                       |
| Bash 命令权限              |     ✅     |      ❌       | tree-sitter 解析 → ctx.ask(permission: "bash", patterns: [...]) → Permission.evaluate() → allow/deny/ask |
| env_scope.allowed_commands |     ✅     |      ❌       | Discipline.compile() → deny-all bash + allow-list → 代码层硬约束                                         |
| file_scope                 |     ✅     |      ❌       | 3 层：tool 删除 + per-path 评估 + external_directory guard                                               |
| delegation_depth=0         |     ✅     |      ❌       | task tool deny → 代码层硬约束                                                                            |
| MCP tool 访问              |     ✅     |      ❌       | prefix 过滤 + ctx.ask()                                                                                  |
| **Git 破坏性命令**         |     ❌     |      ✅       | 仅 bash.txt prompt 文本引导，无代码拦截                                                                  |
| **Bash 自律约束**          |     ❌     |      ✅       | 仅 research.md "MUST NOT use bash to write outside .aether/research"，无代码拦截                         |

**核心结论**：当前所有可靠的约束都是代码层执行的（Permission + Discipline）。依赖 prompt 自律的约束（git 破坏性命令、bash 写文件范围）在 LLM 和 subagent 上均无保障。

### 2.2 Bash 工具权限评估管线

bash 工具执行命令时经过以下管线：

```
LLM 输出 bash tool call
  → tool/bash.ts
    → tree-sitter-bash 解析命令
    → 提取每个 command node 的文本
    → 构造 patterns（完整命令文本）和 always（BashArity.prefix + " *"）
    → ctx.ask(permission: "bash", patterns: [...], always: [...])
      → Permission.ask()
        → 遍历 merged ruleset（agent.permission + session.permission + Discipline.compile）
        → findLast 匹配 → 返回 allow/deny/ask
        → deny → 抛 DeniedError（硬阻断，不提示用户）
        → ask → 创建 Deferred → 等待用户审批
        → allow → 静默继续
    → spawn(command, { shell, cwd, env })
```

关键：**DeniedError 是代码层硬阻断**，LLM 无法绕过。`Permission.intersection()` 在 subagent 派发时自动将父 agent 的 deny 规则传播给子 agent — research-worker 也无法执行被 deny 的命令。

### 2.3 Discipline.compile() 已有基础设施

`env_scope.allowed_commands` 的实现（`discipline.ts:35-39`）：

```ts
if (d.env_scope?.allowed_commands) {
  rules.push({ permission: "bash", pattern: "*", action: "deny" })
  for (const cmd of d.env_scope.allowed_commands) {
    rules.push({ permission: "bash", pattern: cmd + "*", action: "allow" })
  }
}
```

这是 deny-all + allow-list 模式。我们需要的是对称的 deny-specific 模式 — `env_scope.denied_commands`，追加特定 deny 规则而不影响全局 bash 权限。

### 2.4 三种方案对比

| 维度                  | 方案 1: Git script                | 方案 2: Git MCP 服务           | 方案 3: Permission denied_commands             |
| --------------------- | --------------------------------- | ------------------------------ | ---------------------------------------------- |
| **LLM 可绕过?**       | 能 — 直接用 bash 执行 git 命令    | 能 — MCP 和 bash 是并行通道    | **不能** — DeniedError 硬阻断                  |
| **Subagent 生效?**    | ❌ — subagent 有独立 bash 权限    | ❌ — subagent 可能不配置此 MCP | ✅ — `Permission.intersection()` 自动传播 deny |
| **实现量**            | Shell script + agent 配置         | 新 MCP 进程 + Python           | Discipline 1 行 + agent 配置                   |
| **新增依赖**          | 0                                 | 1 MCP 进程                     | 0（复用现有管线）                              |
| **代码改动**          | `.aether/` 配置层                 | `.aether/mcp/git/`             | `packages/opencode/src/session/discipline.ts`  |
| **灵活性**            | 低 — 只能调用预定义操作           | 中 — 可定义任意 tool           | 高 — deny/allow 模式任意组合                   |
| **对其他 agent 影响** | 无 — 只影响配置了 script 的 agent | 无 — 只影响配置了 MCP 的 agent | 无 — 只影响配置了 denied_commands 的 agent     |

**方案 3 是唯一可靠方案**。方案 1 和 2 的致命缺陷：它们和 bash 是并行通道，LLM 和 subagent 可以绕过 script/MCP 直接执行破坏性 git 命令。只有 Permission 规则能在代码层拦截所有 bash 命令（包括 subagent 的）。

---

## 3. 设计决策汇总

| #   | 决策                                              | 理由                                                                                                                       |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | Git commit 作为回滚基础，不新增 MCP rollback 工具 | Git 提供原子回滚能力（checkout + clean），scope 限定 `.aether/research/` 不影响项目其他文件；避免在 MCP 层增加复杂状态管理 |
| D2  | 策略 A：完全恢复到目标版本，不保留失败改动历史    | 回滚意味着根本性错误（而非仅走错流程），失败历史价值存疑；完全恢复更干净，避免部分残留文件干扰重 dispatch                  |
| D3  | 每个 phase 完成后提交 git commit                  | commit 包含 STATE.md + state.json + 输出文件，保证双写一致性；commit SHA 记入 state.json 便于回滚定位                      |
| D4  | 回滚后重新 dispatch worker，不从失败版本上修补    | 完全恢复 + 重新执行比增量修补更可靠，避免错误状态的残留影响                                                                |
| D5  | Digest Fallback 改为三档判定                      | 文件存在 ≠ 阶段完成；incomplete 和 missing 需用户决策而非自动跳过                                                          |
| D6  | `_default_state()` phase 改为 `"gate"`            | `"gate"` 是映射表第一个合法阶段名，与 Entry Gate 流程对齐                                                                  |
| D7  | Git 安全约束通过 Permission denied_commands 实现  | 代码层硬阻断（DeniedError），LLM 和 subagent 均无法绕过；方案 1/2（script/MCP）是并行通道，可被绕过                        |

---

## 4. Git-Backed Rollback Protocol

### 4.1 前提条件

- Research agent 有 `bash: allow` 权限，可执行 git 命令
- file_scope 限制编辑工具，但 bash 不受限 — git 操作通过 bash 执行
- Git 安全约束通过 `env_scope.denied_commands` 代码层保障（见 §5），不依赖 prompt 自律
- **Layer 3.6 Health Check Layer 1 git 检测必须通过**：`git --version` 和 `git rev-parse --git-dir` 返回成功。git 不可用或非 git 仓库时，Phase Commit 和 rollback 机制不可用，agent 应在启动自检阶段告知用户并降级
- 允许的 git 命令仅限：`git add .aether/research/`、`git commit`、`git checkout <sha> -- .aether/research/`、`git status .aether/research/`、`git log`、`git rev-parse`、`git clean -fd .aether/research/`

### 4.2 Rollback 流程

当 phase_checkpoint 被拒绝，或 State Consistency Check 发现 state.json 超前时：

```
步骤 1: 确定回滚目标
  - checkpoint 拒绝 → 根据用户指出的错误类型确定目标阶段:
    · 研究问题错误 → phase_framing
    · 整体方向错误 → phase_analysis
    · 文献覆盖不足 → phase_landscape
  - consistency check → 回滚到 DIGESTS.md 最后一条 digest 对应的阶段

步骤 2: 定位目标 commit SHA
  - 首选: 从 state.json 的 phase_commits 字段读取目标阶段的 SHA
    注意: phase_commits 中的 SHA 遵循自引用不变量（§6.3），
    checkout 该 SHA 恢复的 state.json 中 phase_commits 值与 SHA 一致
  - Fallback: git log --oneline --grep="research: phase_[target]" -10
    注意: --grep 只返回 SHA_final（amend 后），不返回 reflog 中孤立的 SHA_pre

步骤 3: 完全恢复到目标版本
  git checkout <target_sha> -- .aether/research/

步骤 4: 清除失败阶段产生的 untracked 文件
  git clean -fd .aether/research/
  注意: 此命令仅删除 .aether/research/ 下的 untracked 文件，
  不影响项目其他位置。.venv/ 目录可能需要特殊处理（见 §4.4）

步骤 5: 提交回滚状态
  git add .aether/research/
  git commit -m "research: rollback to phase_[target] (plan [N])"

步骤 6: Clean check — 确认工作区干净
  git status .aether/research/
  预期结果: "nothing to commit, working tree clean"
  如果不干净 → 说明有遗漏，补充 git add + commit --amend

步骤 7: 验证 MCP 状态一致性
  调 get_state → 确认 state.json.phase 匹配 STATE.md Current Phase
  如果不匹配 → git checkout 已恢复两文件到同一版本，理论上必须匹配
  如果仍不匹配 → 说明 git checkout 未正确恢复，人工介入

步骤 8: 重新 dispatch worker 到目标阶段
  根据 research.md Coordinator Routing Protocol 正常 dispatch
```

### 4.3 回滚范围限制

回滚仅影响 `.aether/research/` 目录：

| 路径                                      | 回滚行为                    | 说明                                  |
| ----------------------------------------- | --------------------------- | ------------------------------------- |
| `.aether/research/persistence/STATE.md`   | ✅ 恢复到目标版本           | 人类可读状态                          |
| `.aether/research/persistence/state.json` | ✅ 恢复到目标版本           | 机器状态                              |
| `.aether/research/persistence/DIGESTS.md` | ✅ 恢复到目标版本           | 失败阶段的 digest 被移除              |
| `.aether/research/persistence/ROADMAP.md` | ✅ 恢复到目标版本           | 仅保留目标阶段及之前的输出            |
| `.aether/research/persistence/PLAN.md`    | ✅ 恢复到目标版本（如存在） | framing 产物回滚                      |
| `.aether/research/notepads/`              | ✅ 恢复到目标版本           | 失败阶段新增的 notepad 被清除         |
| `.aether/research/.venv/`                 | ❌ 不回滚                   | venv 是环境层，回滚无意义且耗时       |
| 项目其他文件                              | ❌ 不受影响                 | git checkout 仅限定 .aether/research/ |

### 4.4 .venv 处理策略

`git clean -fd .aether/research/` 会删除 `.aether/research/.venv/`（untracked directory）。策略：

- **选项 A（推荐）**: 在 `.aether/research/.gitignore` 中忽略 `.venv/`，使 `git clean` 不删除它。venv 依赖由 ENVIRONMENT.md 记录，回滚后 ENVIRONMENT.md 恢复到目标版本，但 venv 包列表可能不匹配 — 下一个 execution_cycle 的环境探测会检测并补装缺失包。
- **选项 B**: 不忽略 `.venv/`，回滚时重建。代价是增加下一个 execution_cycle 的环境准备时间。

### 4.5 安全约束

破坏性 git 命令通过 `env_scope.denied_commands`（§5）在代码层硬阻断 — LLM 和 subagent 执行这些命令时直接收到 DeniedError，无需提示用户审批。

以下命令模式被 deny（按 §5 配置）：

| 被阻断的命令模式                                          | 阻断理由                    |
| --------------------------------------------------------- | --------------------------- |
| `git push --force*`                                       | 改写远程历史                |
| `git push -f*`                                            | 同上                        |
| `git reset --hard*`                                       | 破坏性重置整个 repo 工作区  |
| `git clean -fd` (不带路径限定)                            | 删除项目所有 untracked 文件 |
| `git rebase -i*`                                          | 交互式命令，需要用户输入    |
| `git checkout <sha> -- .` (不带 `.aether/research/` 限定) | 恢复项目所有文件到目标版本  |

未被 deny 的 git 命令（`git add`、`git commit`、`git status`、`git log`、`git rev-parse`、限定路径的 `git checkout` 和 `git clean`）允许正常执行。

所有 git 命令仍需遵守 prompt 层约束：`git add` 范围限定 `.aether/research/`，`git checkout` 和 `git clean` 带路径限定 `.aether/research/`。Prompt 层约束不替代代码层约束，但提供额外的操作规范。

---

## 5. Permission denied_commands 执行层设计

### 5.1 Discipline.compile() 扩展

**文件**: `packages/opencode/src/session/discipline.ts`

**改动**: 在 Schema 中增加 `env_scope.denied_commands` 字段，与 `allowed_commands` 对称：

```ts
export namespace Discipline {
  export const Schema = z.object({
    permission_override: z.record(z.string(), z.string().array().optional()).optional(),
    env_scope: z
      .object({
        allowed_commands: z.string().array().optional(),
        denied_commands: z.string().array().optional(),  // ← 新增
      })
      .optional(),
    file_scope: z.string().array().optional(),
    delegation_depth: z.number().int().min(0).max(3).optional(),
    max_steps: z.number().int().min(1).max(50).optional(),
    timeout_seconds: z.number().int().min(30).max(600).optional(),
    return_format: z.enum(["text", "structured", "raw"]).optional(),
  })
```

**compile() 新增逻辑**（在 allowed_commands 逻辑之后）：

```ts
if (d.env_scope?.denied_commands) {
  for (const cmd of d.env_scope?.denied_commands) {
    rules.push({ permission: "bash", pattern: cmd, action: "deny" })
  }
}
```

与 `allowed_commands` 的关键区别：

- `allowed_commands`: deny-all(`bash: "*"` → deny) + allow-list → 只有白名单内的命令可执行
- `denied_commands`: 只追加 deny 规则 → 全局 bash 权限不变，但特定命令模式被阻断

两种模式可同时使用。`findLast` 规则匹配确保 deny 规则优先于 allow（只要 deny 的 pattern 更具体）。

### 5.2 Research Agent 配置

**文件**: `.aether/agent/research.md` frontmatter

**改动**: 增加 `env_scope.denied_commands`：

```yaml
---
description: Research mode — deep search, analysis, and verification
color: "#7C3AED"
mode: primary
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
mcp:
  research-conventions: true
  research-state: true
env_scope:
  denied_commands:
    - "git push --force*"
    - "git push -f*"
    - "git reset --hard*"
    - "git rebase -i*"
    - "git clean -fd"
    - "git checkout * -- ."
output_dir: ".aether/research"
file_scope:
  - ".aether/research/**"
---
```

注意：

- `git clean -fd` 不带通配符后缀 — 只阻断不带路径限定的 `git clean -fd`。`git clean -fd .aether/research/` 不匹配此 pattern，允许执行。
- `git checkout * -- .` 阻断不带 `.aether/research/` 路径限定的 checkout — `git checkout <sha> -- .` 会恢复整个 repo 工作区到目标版本，违反 rollback 范围限定。`git checkout <sha> -- .aether/research/` 不匹配此 pattern（以 `.aether/research/` 结尾而非 `.`），允许执行。Wildcard 匹配原理：pattern `"git checkout * -- ."` 转换为正则 `^git checkout .* -- \.$`，仅匹配以 `.` 结尾的 checkout 命令。

### 5.3 Subagent 传播

当 coordinator 通过 `task` tool 派发 research-worker 时，`Permission.intersection()` 自动合并父 agent 和子 agent 的权限规则。父 agent 的 denied_commands deny 规则会被传播给子 agent：

```
Parent rules: [..., { bash, "git push --force*", deny }, ...]
Child rules:  [bash: allow, ...]

intersection 结果: [..., { bash, "git push --force*", deny }, { bash, "*", allow }, ...]
→ findLast 匹配 "git push --force main" → deny（deny 规则更具体，排在 allow 之后）
```

research-worker 同样无法执行被 deny 的 git 命令。

### 5.4 Bash 工具拦截流程

当 LLM（coordinator 或 worker）尝试执行 `git push --force origin main` 时：

```
bash tool call: "git push --force origin main"
  → tree-sitter-bash 解析 → command: "git push --force origin main"
  → ctx.ask(permission: "bash", patterns: ["git push --force origin main"], always: ["git push *"])
  → Permission.ask()
    → evaluate("bash", "git push --force origin main", mergedRuleset)
    → findLast: matches "git push --force*" → action: deny
    → return { action: "deny" }
  → 抛出 DeniedError
  → processor.ts 捕获 → blocked = true → 停止当前 loop
```

LLM 收到工具错误消息，无法继续执行该命令。用户不会被提示审批（deny ≠ ask）。

### 5.6 编译链完整性 — config.ts + agent.ts 同步修改

§5.1 仅修改了 `Discipline.Schema` 和 `compile()`，但 `denied_commands` 要真正生效还需更新编译链上游的两个文件：

**文件 1**: `packages/opencode/src/config/config.ts:831`

**改动**: 扩展 `env_scope` schema 以包含 `denied_commands`：

```ts
// 当前（仅 allowed_commands）
env_scope: z.object({ allowed_commands: z.string().array().optional() }).optional(),

// 修改后
env_scope: z.object({
  allowed_commands: z.string().array().optional(),
  denied_commands: z.string().array().optional(),
}).optional(),
```

同时在已知 key 集合中确认 `"env_scope"` 已存在（config.ts:845-870），无需新增 key。

**文件 2**: `packages/opencode/src/agent/agent.ts:298`

**改动**: 修复 env_scope 编译条件 — 当前仅在 `allowed_commands` 存在时编译：

```ts
// 当前（有 bug：denied_commands 独立存在时不编译）
if (value.env_scope?.allowed_commands) compileInput.env_scope = value.env_scope

// 修改后（allowed_commands 或 denied_commands 任一存在即编译）
if (value.env_scope?.allowed_commands || value.env_scope?.denied_commands) {
  compileInput.env_scope = value.env_scope
}
```

**原 bug 分析**：如果 agent frontmatter 只配置 `env_scope.denied_commands`（无 `allowed_commands`），旧条件 `value.env_scope?.allowed_commands` 为 undefined/false → `compileInput.env_scope` 不被设置 → `Discipline.compile()` 不处理 env_scope → deny 规则不生成 → `denied_commands` 完全无效。

**修复影响**：research agent 配置同时有 `file_scope` 和 `env_scope.denied_commands`（无 `allowed_commands`），修复后两者都会被正确编译。编译后的 discipline rules 通过 `Permission.merge(item.permission, compiled)` 追加到 agent 的 permission ruleset（agent.ts:301-303），保证 `findLast` 匹配时 deny 规则排在 allow 规则之后，正确阻断破坏性命令。

### 5.5 对 git commit --amend 的特殊处理

Phase Commit Protocol 的 clean check 步骤需要 `git commit --amend --no-edit`。这与一般性禁止 amend 的需求冲突。

**决策**: `git commit --amend*` **不加入** denied_commands 列表。理由：

1. `--amend` 在 Phase Commit Protocol 中是必需的（clean check 修正遗漏文件）
2. `--amend` 只修改最近的 commit（不改写历史深处），对 rollback 的影响可控
3. 如果误用 amend，rollback 可通过 `git checkout <previous_sha>` 恢复
4. 过度限制会阻碍正常 workflow

Prompt 层约束补充：`git commit --amend` 仅在 clean check 步骤中使用，其他场景不应使用。

---

## 6. Phase Commit Protocol

### 6.1 Commit 触发时机

在每个 phase 完成后（worker 返回 digest 且 coordinator 处理完毕）：

```
触发序列:
  1. Worker 返回 PhaseResultDigest
  2. Coordinator 处理 digest →  validate_file_locations
  3. Coordinator 调 advance_plan → 更新 state.json
  4. Coordinator 更新 STATE.md（写入 current_phase, key decisions, next_action）
  5. Coordinator 将 digest append 到 DIGESTS.md
  6. → 此时触发 git commit ←
```

### 6.2 Commit 流程

Phase commit 包含 SHA 记录，因此需要三步序列而非简单的 commit + amend：

```bash
# 1. 添加所有 research 文件
git add .aether/research/

# 2. 提交（state.json 中 phase_commits 尚无本阶段 SHA）
git commit -m "research: phase_[phase_name] (plan [plan_number])"

# 3. 获取 SHA 并写入 state.json
SHA=$(git rev-parse HEAD)
# 写入 state.json.phase_commits[phase_name] = SHA
# 通过 MCP advance_plan(commit_sha=SHA) 或 bash 直接修改 state.json

# 4. Amend 将 SHA 记录纳入同一 commit
git add .aether/research/persistence/state.json
git commit --amend --no-edit

# 5. Clean check
git status .aether/research/
# 预期: "nothing to commit, working tree clean"

# 6. 如果不干净 — 说明有遗漏文件（非 state.json 的遗漏）
git add .aether/research/
git commit --amend --no-edit
# 再次 clean check
```

### 6.3 SHA 记录的时序分析与自引用不变量

上述流程存在一个时序特性：amend 步骤（第 4 步）将 SHA 写入 state.json 后 amend 同一 commit，导致 commit SHA 发生变化（从 SHA_pre → SHA_final）。最终 state.json 中记录的 `phase_commits[phase_name] = SHA_final`，而 SHA_final 就是当前 commit 的 SHA — **这是一个自引用**。

**时序分解**：

```
步骤 2: git commit → SHA_pre
  state.json 内容: phase_commits.phase_analysis = null（或空）
  SHA_pre commit 的 tree 中不包含本阶段的 SHA 记录

步骤 3: 获取 SHA_pre → 写入 state.json.phase_commits

步骤 4: git commit --amend → SHA_final
  state.json 内容: phase_commits.phase_analysis = SHA_final（不是 SHA_pre）
  SHA_final commit 的 tree 中包含 phase_commits.phase_analysis = SHA_final
```

SHA_pre 成为 reflog 中的孤儿 commit — 不在 git log 可见历史中，但可通过 reflog 访问。

**自引用不变量**：每个 phase commit 的 `phase_commits[本阶段]` 值等于该 commit 自身的 SHA。此不变量保证：

- `git checkout SHA_final -- .aether/research/` 恢复的 state.json 包含 `phase_commits.phase_analysis = SHA_final`
- checkout 后的 state.json 与磁盘内容一致（SHA_final 对应磁盘上恢复的内容）
- 回滚时无需额外步骤修正 SHA 记录

**审计影响**：

| 场景                           | 影响                                                                             | 严重度                                     |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------ |
| 正常 `git log` 检查            | 只看到 SHA_final，state.json 中 SHA_final 自引用正确                             | 无影响                                     |
| reflog 检查 SHA_pre            | state.json 中无本阶段 SHA 记录，看起来像"阶段未完成"但 commit message 显示已完成 | 低 — reflog 是高级调试工具，正常审计不涉及 |
| `git log --grep` 回滚 fallback | 搜索 `research: phase_analysis` 返回 SHA_final（正确）                           | 无影响                                     |

**孤儿 SHA_pre 的处理**：不主动清理 reflog。SHA_pre 是无害的：

- 不会被 phase_commits 引用
- 不会被 `git log --grep` 找到
- checkout SHA_pre 虽然缺少 SHA 记录但内容与 SHA_final 减去 SHA 记录部分完全相同

**结论**：自引用不变量在功能上完全正确，对回滚无影响。唯一的审计混淆来自 reflog 中的孤儿 commit，这是 git amend 的固有特性，不影响正常操作。

### 6.4 Commit Message 格式

```
research: phase_[phase_name] (plan [plan_number])
```

示例：

- `research: phase_analysis (plan 1)`
- `research: phase_landscape (plan 2)`
- `research: phase_framing (plan 3)`
- `research: phase_checkpoint (plan 4)`
- `research: phase_execution_cycle_1 (plan 5)`
- `research: phase_execution_verification_1 (plan 5)`
- `research: phase_execution_cycle_2 (plan 5)`
- `research: completed (plan 6)`

### 6.5 Commit SHA 记录

每次 phase commit 后，将 SHA 写入 state.json 的 `phase_commits` 字段。此记录遵循自引用不变量（见 §6.3）：

```json
{
  "phase_commits": {
    "phase_analysis": "SHA_final",
    "phase_landscape": "SHA_final_2",
    "phase_framing": "SHA_final_3"
  }
}
```

**自引用不变量**：`phase_commits[phase_name]` 的值等于该 phase commit 的自身 SHA（SHA_final，而非 amend 前的 SHA_pre）。这意味着 checkout 任意 phase_commits 中记录的 SHA 恢复的 state.json 中，该 SHA 值与恢复后的 commit 一致。

此字段通过 §6.2 的三步序列写入：commit → 获取 SHA → amend。回滚时从 `phase_commits[目标阶段]` 直接获取 SHA，无需 `git log --grep`。

### 6.6 Entry Gate Commit

Gate classification 完成后也提交一次：

```bash
git add .aether/research/
git commit -m "research: gate → path_[N] (plan 0)"
```

这确保回滚可以恢复到 gate 之前的状态。

### 6.7 Path 1 / Path 2 的 Commit

Path 1 (Quick lookup): 不提交 — 无持久状态修改。

Path 2 (Literature review): 每个内部状态转换完成后提交，格式 `research: review_[state_name]`。

### 6.8 Phase Commit 崩溃恢复

§6.2 的三步序列（commit → 获取 SHA → amend）在步骤 2 和步骤 4 之间存在脆弱窗口：agent 崩溃后，commit 存在但 state.json 无本阶段 SHA 记录。

**检测**：SESSION RECOVERY 的 git consistency check（§8.1）会发现 `git log --oneline -1` 的 commit message 标明阶段完成，但 `state.json.phase_commits[current_phase]` 无值 — 这是不一致状态。

**诊断逻辑**：

```
1. 读取 git log 最新 commit message
2. 如果 message 匹配 "research: phase_[phase_name] (plan [plan_number])":
   a. 读取 state.json.phase_commits[phase_name]
   b. 如果值为空/null → 中间崩溃状态
   c. 如果值存在且与 git rev-parse HEAD 一致 → 正常状态
   d. 如果值存在但不一致 → 未知异常，人工介入
3. 中间崩溃状态处理:
   a. SHA = git rev-parse HEAD（获取 SHA_final，注意 amend 可能未执行）
   b. 检查 git status .aether/research/ — 是否有未 amend 的 state.json 变更
   c. 如果有变更（state.json 比 commit 中的版本新）→ SHA_final 尚未生成
     · 手动完成 amend 序列:
       git add .aether/research/persistence/state.json
       SHA=$(git rev-parse HEAD)
       # 写入 state.json.phase_commits[phase_name] = SHA（通过 MCP 或 bash）
       git add .aether/research/persistence/state.json
       git commit --amend --no-edit
       SHA_final=$(git rev-parse HEAD)
       # 更新 state.json.phase_commits[phase_name] = SHA_final
       git add .aether/research/persistence/state.json
       git commit --amend --no-edit
     · 完成后 clean check
   d. 如果无变更 → commit 后崩溃（SHA_pre 存在，无 SHA 记录）
     · 检查是否是 SHA_pre（reflog 中）
     · 从 commit tree 中恢复 state.json → 此版本不含 SHA 记录
     · 手动写入 SHA: 获取当前 HEAD SHA，写入 state.json.phase_commits，
       然后 amend（同上步骤）
```

**关键原则**：崩溃恢复选择 **补写 SHA** 而非 **rollback**，因为 commit message 标明阶段已完成 — rollback 会丢失已完成的工作。只有当 commit 内容本身有错误（不是 SHA 记录缺失）时才 rollback。

---

## 7. MCP 层修复

### 7.1 修复 `_default_state()` 默认阶段名

**文件**: `.aether/mcp/research-state/server.py:50-57`

**改动**:

```python
def _default_state() -> dict:
    return {
        "phase": "gate",
        "plan_number": "0",
        "conventions": {},
        "project_contract": {},
        "progress": {"completed_plans": [], "total_plans": 0},
        "phase_commits": {},
        "execution_cycle": 0,
    }
```

变更点:

- `phase`: `"exploration"` → `"gate"`（映射表合法阶段名）
- 新增 `phase_commits`: 字典，记录每个 phase 的 git commit SHA
- 新增 `execution_cycle`: 整数，记录 execution 子阶段 cycle 号

`_read_state_safe` 的 fill-missing-keys 逻辑会自动补齐新字段。

**同步修改**: `server.py:372-374` `run_health_check` 中 `"exploration"` 硬编码需改为 `"gate"`：

```python
# 当前
checks["state_phase_in_roadmap"] = current_phase in phase_names or current_phase == "exploration"
if current_phase not in phase_names and current_phase != "exploration":
    issues.append(...)

# 修改后
checks["state_phase_in_roadmap"] = current_phase in phase_names or current_phase == "gate"
if current_phase not in phase_names and current_phase != "gate":
    issues.append(...)
```

同样，`get_phase_info`（server.py:394）中 `current = state.get("phase", "exploration")` 改为 `current = state.get("phase", "gate")`。

### 7.2 修复 `advance_plan` 自动推进

**文件**: `.aether/mcp/research-state/server.py:228-259`

**改动**: 增加硬编码合法阶段列表作为 fallback，不再依赖 ROADMAP.md 格式匹配：

```python
VALID_PHASES = [
    "gate", "phase_analysis", "phase_landscape",
    "phase_framing", "phase_checkpoint", "phase_execution", "completed",
]
```

注意：`"phase_landscape_skipped"` 不在列表中 — 这是条件分支而非主线阶段。跳过 landscape 时 agent 必须显式传 `phase="phase_landscape_skipped"`，不依赖自动推进 fallback。

自动推进 fallback 链:

1. ROADMAP.md 解析（现有逻辑）
2. 硬编码 VALID_PHASES 列表 — 按 plan_number 索引
3. 如果都不匹配 — 返回错误，要求 agent 显式传 phase/plan_number

### 7.3 扩展 `advance_plan` — 记录 commit SHA 和 execution_cycle

**文件**: `.aether/mcp/research-state/server.py:228-259`

**改动**: 增加可选参数 `commit_sha` 和 `execution_cycle`:

```python
@mcp.tool(annotations=MUTATING_NON_DESTRUCTIVE)
def advance_plan(
    phase: str,
    plan_number: str,
    project_dir: str,
    commit_sha: str = "",
    execution_cycle: int = 0,
) -> dict[str, Any]:
```

- `commit_sha`: 如果非空，写入 `state.phase_commits[phase] = commit_sha`
- `execution_cycle`: 如果 phase == "phase_execution"，写入 `state.execution_cycle = execution_cycle`

### 7.4 plan_number 类型规范化

**文件**: `.aether/mcp/research-state/server.py`

**改动**: `_write_state` 写入前强制类型转换:

```python
state["plan_number"] = str(state["plan_number"]) if state["plan_number"] is not None else "0"
state["phase"] = str(state["phase"]) if state["phase"] is not None else "gate"
```

`advance_plan` 入口处也做转换:

```python
plan_number = str(plan_number)
```

---

## 8. Research Agent Prompt 修改

### 8.1 SESSION RECOVERY 节 — 增加 git 恢复

替换 research.md 中的 SESSION RECOVERY 节（当前 L422-441）为：

```
On session start:

1. Read .aether/research/persistence/STATE.md, state.json (via MCP get_state), DIGESTS.md, ENVIRONMENT.md
2. If an active project exists (phase ≠ "gate" or "not yet started"):
   - Resume from the current phase
   - Do NOT re-run the gate
   - Read DIGESTS.md for completed phase summaries
   - If ENVIRONMENT.md exists: note venv_state
   - If current phase is phase_execution: check state.json.execution_cycle + DIGESTS.md for cycle status
   - Git consistency check: git log --oneline -5 → verify last commit matches state.json.phase_commits[current_phase]
   - If git commit SHA mismatch: git checkout state.json.phase_commits[current_phase] -- .aether/research/ → git add + commit
   - Dispatch research-worker for current phase
3. If no active project (phase = "gate" or "not yet started" and DIGESTS.md empty):
   - Run Entry Gate for first user prompt
```

### 8.2 Digest Fallback — 三档判定

替换 research.md Digest Parsing Fallback 节（当前 L406-413）为：

```
If digest YAML parsing fails or worker didn't output a digest:

1. Check STATE.md Current Phase — confirm worker wrote files
2. Check worker's expected output files:
   - All expected files exist and non-empty → INCOMPLETE (文件存在但无 digest，阶段可能未完成)
   - All expected files exist and non-empty + STATE.md shows phase advanced → COMPLETED_FALLBACK (推断完成)
   - Some/none files exist → MISSING (阶段未完成)

3. INCOMPLETE or MISSING:
   - Report to user: "Phase [name] did not produce a valid digest."
   - Present: files found, STATE.md phase, last DIGESTS.md entry
   - Ask: retry / rollback / skip (only for landscape)?

4. COMPLETED_FALLBACK:
   - Construct fallback digest from file evidence
   - Append to DIGESTS.md with flag: `status: completed_fallback`
   - Proceed to next phase with caution
```

### 8.3 Phase Transition Rules — 增加 commit 步骤

在 After completing a phase 节中，现有步骤 1-4 之后增加：

```
5. Git commit:
   git add .aether/research/
   git commit -m "research: phase_[phase_name] (plan [plan_number])"
6. Clean check:
   git status .aether/research/ → must be clean
   If not clean → git add + commit --amend
7. Record commit SHA:
   Obtain SHA via: git rev-parse HEAD
   Call advance_plan with commit_sha parameter, or
   Directly update state.json.phase_commits[phase] via bash
```

### 8.4 phase_checkpoint — 增加回滚协议

在 phase_checkpoint 的 "If user rejects" 节（当前 L303-309）替换为：

```
If user rejects:
  1. Determine rollback target phase from user feedback
  2. Read state.json.phase_commits[target_phase] → get commit SHA
     Fallback: git log --oneline --grep="research: phase_[target]" -5
  3. Git rollback:
     git checkout <target_sha> -- .aether/research/
     git clean -fd .aether/research/
     git add .aether/research/
     git commit -m "research: rollback to phase_[target] (plan [N])"
  4. Clean check: git status .aether/research/ must be clean
  5. Verify MCP state consistency: get_state → phase must match STATE.md
  6. Re-dispatch worker to target phase with revised scope
```

### 8.5 State Consistency Check — 简化

替换 State Consistency Check 节（当前 L281-289）为：

```
After processing each worker digest:

1. Read state.json via MCP get_state
2. Read DIGESTS.md — get last digest's phase
3. If state.json.phase does not match DIGESTS.md last phase:
   - Read state.json.phase_commits for DIGESTS.md last phase → get commit SHA
   - Git rollback to that commit (per §3.2 protocol)
   - This restores both state.json and STATE.md atomically
   - Re-dispatch worker for the restored phase
```

Git rollback 统一处理不一致情况，不再需要 advance_plan 的假想 rollback 能力。

---

## 9. 验收清单

### P0 修复验收

- [ ] `_default_state()` phase = `"gate"`，不是 `"exploration"`
- [ ] state.json 初始化后 phase = `"gate"`（不是 `null`）
- [ ] 回滚 protocol 可完整执行：checkpoint 拒绝 → git checkout → git clean → git commit → clean check → re-dispatch
- [ ] 回滚后 state.json.phase 与 STATE.md Current Phase 一致（原子恢复验证）
- [ ] `env_scope.denied_commands` 在代码层阻断 `git push --force*` 等破坏性命令（DeniedError）
- [ ] `Permission.intersection()` 将 denied_commands deny 规则传播给 research-worker subagent

### P1 修复验收

- [ ] 每个 phase 完成后存在对应的 git commit
- [ ] commit 后 `git status .aether/research/` 显示干净
- [ ] state.json.phase_commits 记录了每个 phase 的 commit SHA
- [ ] Digest fallback 不再将"文件存在"直接判定为完成 — incomplete/missing 需用户决策

### P2 修复验收

- [ ] `advance_plan` 自动推进 fallback 使用硬编码 VALID_PHASES 列表
- [ ] state.json 包含 `execution_cycle` 字段
- [ ] plan_number 在 state.json 中统一为字符串类型
- [ ] recovery 时 phase_execution 子阶段从 state.json.execution_cycle 读取 cycle 号，不依赖 DIGESTS.md 解析

### 安全验收

- [ ] 所有 git 命令带 `.aether/research/` 路径限定（prompt 层约束）
- [ ] `git push --force*` 执行时抛 DeniedError（代码层验证）
- [ ] `git reset --hard*` 执行时抛 DeniedError（代码层验证）
- [ ] `git rebase -i*` 执行时抛 DeniedError（代码层验证）
- [ ] `git clean -fd`（无路径限定）执行时抛 DeniedError
- [ ] `git clean -fd .aether/research/` 正常执行（不匹配 deny pattern）
- [ ] `git checkout <sha> -- .` 执行时抛 DeniedError（恢复整个 repo）
- [ ] `git checkout <sha> -- .aether/research/` 正常执行（只恢复 research 目录）
- [ ] `git commit --amend` 正常执行（不在 deny 列表中）
- [ ] `git commit --amend --no-edit` 正常执行
- [ ] research-worker subagent 执行 `git push --force*` 时同样抛 DeniedError
- [ ] git commit 不包含项目 `.aether/research/` 以外的文件

### 编译链验收

- [ ] `config.ts` env_scope schema 包含 `denied_commands` 字段
- [ ] `agent.ts` 编译条件改为 `allowed_commands || denied_commands`
- [ ] 仅配置 `env_scope.denied_commands`（无 `allowed_commands`）的 agent 正确编译 deny 规则
- [ ] `run_health_check` 和 `get_phase_info` 中 `"exploration"` 引用改为 `"gate"`

### 崩溃恢复验收

- [ ] Phase commit 三步序列崩溃后，SESSION RECOVERY 能检测中间状态（commit message 标明完成但 state.json 无 SHA）
- [ ] 崩溃恢复选择补写 SHA 而非 rollback（不丢失已完成工作）
- [ ] 补写 SHA 后自引用不变量恢复（phase_commits[phase] == SHA_final）
