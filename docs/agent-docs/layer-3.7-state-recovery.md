# Layer 3.7: Research State Machine Recovery — Git-Backed Rollback + Consistency Fix

> 前置依赖: Layer 0-3.6（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Health Check）
> 本文档定义 research agent 状态机的恢复机制改进，解决当前 SESSION RECOVERY 设计中的 7 个缺陷，引入 git-backed rollback 作为核心回滚机制。

---

## 目录

1. [问题清单](#1-问题清单)
2. [设计决策汇总](#2-设计决策汇总)
3. [Git-Backed Rollback Protocol](#3-git-backed-rollback-protocol)
4. [Phase Commit Protocol](#4-phase-commit-protocol)
5. [MCP 层修复](#5-mcp-层修复)
6. [Research Agent Prompt 修改](#6-research-agent-prompt-修改)
7. [验收清单](#7-验收清单)

---

## 1. 问题清单

### P0-1: `_default_state()` 默认阶段名不合法

**现状**: `server.py:50-57` `_default_state()` 返回 `phase: "exploration"`，但 research.md Phase ↔ state.json Mapping 表中合法阶段名为 `gate, phase_analysis, phase_landscape, phase_framing, phase_checkpoint, phase_execution, completed`。`"exploration"` 不在其中。

**后果**: 恢复时读到 `"exploration"` 无法匹配任何阶段，路由逻辑将无法确定当前进度。当前 state.json 文件实际存储 `phase: null`（手动初始化），与 `_default_state()` 也不一致 — MCP `_read_state_safe` 的 fill-missing-keys 逻辑会用 `"exploration"` 覆盖 `null` phase 字段。

**修复**: `_default_state()` 改为 `phase: "gate"`, `plan_number: "0"`。见 §5.1。

### P0-2: `advance_plan` 无回滚能力

**现状**: research.md:303-309 规定 phase_checkpoint 拒绝时需回滚 state.json 到修正阶段，但 `advance_plan` 只做正向推进 — 将旧阶段追加到 `completed_plans` 后写入新阶段。回滚操作会把被回滚的阶段错误记录为"已完成"。

**后果**: checkpoint 拒绝后的回滚无法正确执行。State Consistency Check（research.md:281-289）依赖 "state.json 超前则回滚"，同样无法实现。

**修复**: 引入 git-backed rollback，不依赖 MCP rollback 工具。见 §3。

### P1-1: STATE.md 与 state.json 双写一致性无保障

**现状**: 恢复流程要求同时读 STATE.md 和 state.json 确认一致（research.md:430-431），但两者由不同机制更新 — STATE.md 由 agent 手动编辑，state.json 由 MCP `advance_plan` 原子写入。Worker 可能写 STATE.md 但没调 advance_plan，或反之。

**后果**: 两文件不一致时，恢复逻辑无法确定真实进度。State Consistency Check 依赖 MCP 回滚能力（不可用）。

**修复**: Phase Commit Protocol 将两者放入同一 git commit，保证原子一致性。见 §4。回滚时 git checkout 同时恢复两者。

### P1-2: Digest Fallback 过于宽松

**现状**: research.md:409-412 规定：如果 digest YAML 解析失败但文件存在，推断阶段完成并继续路由。

**后果**: Worker 可能写了部分输出后崩溃 — 文件存在不代表阶段完成。跳过未完成的工作会导致后续阶段在残缺输入上运行。

**修复**: 改为三档判定：completed / incomplete / missing。incomplete 和 missing 都不自动继续，需用户决策。见 §6.2。

### P2-1: `advance_plan` 自动推进依赖 ROADMAP.md 格式

**现状**: `server.py:234-244` 空 phase/plan_number 时从 ROADMAP.md 解析阶段名。`_parse_roadmap_phases` 用正则 `^#+\s*Phase\s+(\d+)\s*:\s*(.+)` 匹配标题。但 ROADMAP.md 由 deep-research skill 生成，格式不一定匹配。

**后果**: 自动推进在 ROADMAP.md 不存在或格式不匹配时，静默使用 `phase-{N}` 占位名，与映射表合法阶段名不一致。

**修复**: 增加硬编码合法阶段列表作为 fallback。同时：agent 应始终显式传 phase/plan_number，不再依赖自动推进。见 §5.2。

### P2-2: phase_execution cycle 计数依赖 digest 质量

**现状**: 恢复 phase_execution 时需从 DIGESTS.md 确定当前 cycle 号和状态（research.md:436）。DIGESTS.md 是自由格式 YAML 附录，无结构化 cycle 计数器。

**后果**: Digest 格式不规范时无法准确判断 cycle 号，可能重复执行已完成的 cycle 或跳过未完成的。

**修复**: state.json 增加 `execution_cycle` 字段，由 `advance_plan` 在 execution 子阶段管理。见 §5.3。

### P2-3: plan_number 类型不一致

**现状**: Mapping 表用整数（0-6），但 `advance_plan` 参数类型为 `str`。`_default_state` 返回 `"0"`（字符串），当前 state.json 存储 `null`。`_read_state_safe` 的 fill-missing-keys 逻辑会用 `"0"` 覆盖 `null`，但 agent 可能传整数。

**后果**: 比较逻辑需处理字符串 vs 整数 vs null 三种情况，容易出错。`int(current_state.get("plan_number", "0"))` 在 `"0"` 和 `0` 两种输入下行为不同。

**修复**: state.json schema 规范化：phase 和 plan_number 统一为字符串类型。MCP 工具强制类型转换。见 §5.4。

---

## 2. 设计决策汇总

| #   | 决策                                              | 理由                                                                                                                       |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | Git commit 作为回滚基础，不新增 MCP rollback 工具 | Git 提供原子回滚能力（checkout + clean），scope 限定 `.aether/research/` 不影响项目其他文件；避免在 MCP 层增加复杂状态管理 |
| D2  | 策略 A：完全恢复到目标版本，不保留失败改动历史    | 回滚意味着根本性错误（而非仅走错流程），失败历史价值存疑；完全恢复更干净，避免部分残留文件干扰重 dispatch                  |
| D3  | 每个 phase 完成后提交 git commit                  | commit 包含 STATE.md + state.json + 输出文件，保证双写一致性；commit SHA 记入 state.json 便于回滚定位                      |
| D4  | 回滚后重新 dispatch worker，不从失败版本上修补    | 完全恢复 + 重新执行比增量修补更可靠，避免错误状态的残留影响                                                                |
| D5  | Digest Fallback 改为三档判定                      | 文件存在 ≠ 阶段完成；incomplete 和 missing 需用户决策而非自动跳过                                                          |
| D6  | `_default_state()` phase 改为 `"gate"`            | `"gate"` 是映射表第一个合法阶段名，与 Entry Gate 流程对齐                                                                  |

---

## 3. Git-Backed Rollback Protocol

### 3.1 前提条件

- Research agent 有 `bash: allow` 权限，可执行 git 命令
- file_scope 限制编辑工具，但 bash 不受限 — git 操作通过 bash 执行
- Self-enforcement: git add/commit 范围限定 `.aether/research/`，不提交项目其他文件
- AGENTS.md 禁止 `git reset --hard`、`push --force` 等破坏性命令 — 本 protocol 不使用任何破坏性 git 命令

### 3.2 Rollback 流程

当 phase_checkpoint 被拒绝，或 State Consistency Check 发现 state.json 超前时：

```
步骤 1: 确定回滚目标
  - checkpoint 拒绝 → 根据用户指出的错误类型确定目标阶段:
    · 研究问题错误 → phase_framing
    · 整体方向错误 → phase_analysis
    · 文献覆盖不足 → phase_landscape
  - consistency check → 回滚到 DIGESTS.md 最后一条 digest 对应的阶段

步骤 2: 定位目标 commit SHA
  - 从 state.json 的 phase_commits 字段读取目标阶段的 commit_sha
  - Fallback: git log --oneline --grep="research: phase_[target]" -10

步骤 3: 完全恢复到目标版本
  git checkout <target_sha> -- .aether/research/

步骤 4: 清除失败阶段产生的 untracked 文件
  git clean -fd .aether/research/
  注意: 此命令仅删除 .aether/research/ 下的 untracked 文件，
  不影响项目其他位置。.venv/ 目录可能需要特殊处理（见 §3.4）

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

### 3.3 回滚范围限制

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

### 3.4 .venv 处理策略

`git clean -fd .aether/research/` 会删除 `.aether/research/.venv/`（untracked directory）。策略：

- **选项 A（推荐）**: 在 `.aether/research/.gitignore` 中忽略 `.venv/`，使 `git clean` 不删除它。venv 依赖由 ENVIRONMENT.md 记录，回滚后 ENVIRONMENT.md 恢复到目标版本，但 venv 包列表可能不匹配 — 下一个 execution_cycle 的环境探测会检测并补装缺失包。
- **选项 B**: 不忽略 `.venv/`，回滚时重建。代价是增加下一个 execution_cycle 的环境准备时间。

### 3.5 安全约束

| 禁止操作                                 | 理由                                              |
| ---------------------------------------- | ------------------------------------------------- |
| `git reset --hard`                       | AGENTS.md 禁止破坏性命令；且影响整个 repo         |
| `git push --force`                       | AGENTS.md 禁止                                    |
| `git checkout <sha> -- .` (不带路径限制) | 会恢复项目所有文件到目标版本，超出 research scope |
| `git clean -fd` (不带路径限制)           | 会删除项目所有 untracked 文件                     |
| `git rebase -i`                          | AGENTS.md 禁止交互式 git 命令                     |

所有 git 命令必须带路径限定 `.aether/research/`。

---

## 4. Phase Commit Protocol

### 4.1 Commit 触发时机

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

### 4.2 Commit 流程

```bash
# 1. 添加所有 research 文件
git add .aether/research/

# 2. 提交
git commit -m "research: phase_[phase_name] (plan [plan_number])"

# 3. Clean check
git status .aether/research/
# 预期: "nothing to commit, working tree clean"

# 4. 如果不干净 — 说明有遗漏文件
git add .aether/research/
git commit --amend --no-edit
# 再次 clean check
```

### 4.3 Commit Message 格式

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

### 4.4 Commit SHA 记录

每次 phase commit 后，将 SHA 写入 state.json 的 `phase_commits` 字段：

```json
{
  "phase_commits": {
    "phase_analysis": "a1b2c3d",
    "phase_landscape": "e4f5g6h",
    "phase_framing": "i7j8k9l"
  }
}
```

此字段由 coordinator 在 commit 后通过 MCP `advance_plan` 的扩展参数写入（见 §5.3），或通过 bash 直接修改 state.json 后再 git add + commit --amend。

回滚时从 `phase_commits[目标阶段]` 直接获取 commit SHA，无需 `git log --grep`。

### 4.5 Entry Gate Commit

Gate classification 完成后也提交一次：

```bash
git add .aether/research/
git commit -m "research: gate → path_[N] (plan 0)"
```

这确保回滚可以恢复到 gate 之前的状态。

### 4.6 Path 1 / Path 2 的 Commit

Path 1 (Quick lookup): 不提交 — 无持久状态修改。

Path 2 (Literature review): 每个内部状态转换完成后提交，格式 `research: review_[state_name]`。

---

## 5. MCP 层修复

### 5.1 修复 `_default_state()` 默认阶段名

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

### 5.2 修复 `advance_plan` 自动推进

**文件**: `.aether/mcp/research-state/server.py:228-259`

**改动**: 增加硬编码合法阶段列表作为 fallback，不再依赖 ROADMAP.md 格式匹配：

```python
VALID_PHASES = [
    "gate", "phase_analysis", "phase_landscape", "phase_landscape_skipped",
    "phase_framing", "phase_checkpoint", "phase_execution", "completed",
]
```

自动推进 fallback 链:

1. ROADMAP.md 解析（现有逻辑）
2. 硬编码 VALID_PHASES 列表 — 按 plan_number 索引
3. 如果都不匹配 — 返回错误，要求 agent 显式传 phase/plan_number

### 5.3 扩展 `advance_plan` — 记录 commit SHA 和 execution_cycle

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

### 5.4 plan_number 类型规范化

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

## 6. Research Agent Prompt 修改

### 6.1 SESSION RECOVERY 节 — 增加 git 恢复

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

### 6.2 Digest Fallback — 三档判定

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

### 6.3 Phase Transition Rules — 增加 commit 步骤

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

### 6.4 phase_checkpoint — 增加回滚协议

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

### 6.5 State Consistency Check — 简化

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

## 7. 验收清单

### P0 修复验收

- [ ] `_default_state()` phase = `"gate"`，不是 `"exploration"`
- [ ] state.json 初始化后 phase = `"gate"`（不是 `null`）
- [ ] 回滚 protocol 可完整执行：checkpoint 拒绝 → git checkout → git clean → git commit → clean check → re-dispatch
- [ ] 回滚后 state.json.phase 与 STATE.md Current Phase 一致（原子恢复验证）

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

- [ ] 所有 git 命令带 `.aether/research/` 路径限定
- [ ] 无 `git reset --hard`、`push --force`、`rebase -i` 使用
- [ ] `git clean -fd .aether/research/` 不删除 `.venv/`（如果 .gitignore 配置了）
- [ ] git commit 不包含项目 `.aether/research/` 以外的文件
