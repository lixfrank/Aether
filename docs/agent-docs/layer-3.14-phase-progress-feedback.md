# Layer 3.14: Primary Agent Phase Progress Feedback — 阶段性进度向用户输出

> 前置依赖: Layer 0-3.13（所有已完成层）
> 本文档包含两个 deliverable：(A) Turn Termination 框架修正——前提修复；(B) Phase Progress Notice 机制——主功能，建立在修正后的框架上。
> 修改范围：仅 `.aether/agent/research.md` 的 coordinator 指令文本，零核心源文件改动，零 MCP/skill 改动。

---

## 目录

1. [问题分析](#1-问题分析)
2. [Sub-Deliverable A: Turn Termination 框架修正](#2-sub-deliverable-a-turn-termination-框架修正)
3. [Sub-Deliverable B: Phase Progress Notice 机制](#3-sub-deliverable-b-phase-progress-notice-机制)
4. [research.md 具体修改清单](#4-researchmd-具体修改清单)
5. [不修改的部分](#5-不修改的部分)
6. [验收清单](#6-验收清单)
7. [示例输出](#7-示例输出)

---

## 1. 问题分析

### 1.1 核心问题

当前 research agent 的 coordinator 在 Path 3 状态机中，每个 phase 完成后的行为序列是：

```
worker 返回 → 提取 PhaseResultDigest → 写入 DIGESTS.md → 写入 STATE.md → 调用 advance_plan → git commit → 路由到下一 phase → dispatch 下一个 worker
```

整个过程**没有一步向用户输出任何信息**。用户的 CLI 界面在漫长的 phase 间完全静默——只有 worker dispatch 和 digest 处理的内部操作，用户看不到：

- 当前执行到了哪个 phase
- 这个 phase 的关键发现或产出是什么
- 下一步将做什么
- 整体进度百分比

### 1.2 现有的用户交互点

目前只有 3 个 phase 有面向用户的输出：

| Phase                       | 用户交互方式  | 交互内容                | 交互性质                     |
| --------------------------- | ------------- | ----------------------- | ---------------------------- |
| `phase_analysis_checkpoint` | question tool | 分析结果摘要 + 是否继续 | **决策性**（必须等用户回复） |
| `phase_checkpoint`          | question tool | 研究计划摘要 + 是否执行 | **决策性**（必须等用户回复） |
| `completed`                 | 直接文本输出  | 最终结果                | **通知性**                   |

其余 10+ 个 phase/sub_phase 完成后，coordinator 零输出。

### 1.3 影响范围

以一个典型的 4-question physics 研究项目为例，用户可能经历：

```
[静默] phase_analysis (5-15 min)
  ↓ question tool → 用户确认
[静默] phase_audit_1 (3-8 min)
[静默] phase_landscape (5-15 min, 或 skip)
[静默] phase_audit_2 (3-8 min)
[静默] phase_framing (3-10 min)
[静默] phase_audit_3 (3-8 min, 可能有 repair 循环)
[静默] phase_debate round 1: 5 个 sub_phase (3-5 min each)
[静默] phase_debate round 2-3 (如有)
  ↓ question tool → 用户确认
[静默] phase_execution (10-30 min, per-question 推进)
  ↓ 最终结果
```

总静默时间可达 30-90 分钟，用户在这期间看到的是空白 CLI——没有任何进度指示。

### 1.4 根因分析

根因有两层：

**第一层（直接原因）**：coordinator 在 digest 处理流程中没有"向用户输出进度通知"这一步骤。每个 phase 完成后的行为序列全是内部操作（写文件、调 MCP、git commit、dispatch），没有一步产生面向用户的输出。

**第二层（结构性原因）**：coordinator 的 Turn Termination 规则存在范畴混淆——把 Intermediate Step（如 Processing digest、Calling advance_plan）当作合法的 turn 结束方式，与真正的 Terminal Action（如 Dispatching worker、Asking the user）并列。这导致 coordinator 可以在中间环节"合法地"结束 turn，而不需要确保每个 turn 都有一个面向用户或推进状态的 Terminal Action 作为终点。Notice 输出作为 Required Intermediate Step，在旧框架中无法被正确归类——它不是 turn 的终点，但必须在 turn 内执行。

---

## 2. Sub-Deliverable A: Turn Termination 框架修正

### 2A.1 原规则的缺陷

原规则（research.md:1613-1622）：

```
Your turn MUST end with one of:
- Dispatching research-worker subagent (to execute a phase)
- Processing a PhaseResultDigest (extracting and appending to DIGESTS.md)
- Handling paused digest from phase_execution (using question tool to ask user, then re-dispatch)
- Calling advance_plan via MCP (ONLY when phase_execution completes)
- Asking the user (ONLY in phase_checkpoint or when phase_execution pauses for user decision)

FORBIDDEN: Ending a turn with raw analysis output without having entered a workflow phase.
```

**缺陷 1：Intermediate Step 与 Terminal Action 混列**

- "Processing a PhaseResultDigest"是 Intermediate Step——处理完 digest 后 coordinator 必须继续（advance_plan、route、dispatch 或 ask user），不是 turn 的终点。
- "Calling advance_plan via MCP"也是 Intermediate Step——几乎每个 phase transition 都调用 advance_plan，之后还有 route / dispatch / present results，不是 turn 的终点。

把它们列为合法 turn 结束方式，等于授权 coordinator 在中间环节停下，产生不完整的 turn。

**缺陷 2：Intermediate Step 被误归类为 Terminal Action，授权 coordinator 在中间环节停下**

一个标准 digest 处理 turn 的内部时序是：process digest → advance_plan → route → dispatch。规则 2（process digest）和规则 4（advance_plan）是中间步骤——执行后 coordinator 必须继续，不是 turn 的终点。把它们与真正的 Terminal Action（dispatch / ask user）并列，等于授权 coordinator 在中间环节合法停下，产生不完整的 turn。

**缺陷 3：规则 3 跨 turn 混合**

"Handling paused digest (using question tool to ask user, then re-dispatch)" 把两个 turn 的行为合并为一条规则。当前 turn 以 ask user 结束；用户回复后的下一个 turn 以 re-dispatch 结束。这是两条不同的 Terminal Action 应用场景。

**缺陷 4：规则 4 的限制错误**

advance_plan 被限制为"ONLY when phase_execution completes"，但其他 10+ 个场景也调用 advance_plan（每个 phase transition 都调用）。这个限制与实际 workflow 不一致。

**缺陷 5：规则 5 限制过窄，遗漏合法 ask user 场景**

规则 5 只允许在 phase_checkpoint 和 phase_execution paused 时 ask user，但合法场景还包括：

- phase_analysis_checkpoint（遗漏）
- Any phase status=failed（research.md:426-428 规定了 ask user）
- Digest Parsing Fallback（research.md:1362 规定了 ask user）
- Audit_3 LOW confidence decision（research.md:668-673 规定了 ask user）

**缺陷 6：缺少 "Present results to user" Terminal Action**

phase_execution → completed/partial、Path 1/2/0 结果输出都以直接文本输出结束 turn，但当前规则没有覆盖这种 Terminal Action。

### 2A.2 修正方案

**核心原则**：Turn Termination 规则只列出 Terminal Action——turn 的最后一个动作，执行后 coordinator 在本 turn 内无后续操作。Intermediate Steps 不在 Turn Termination 中规定，而是在各 phase 的 workflow 指令中规定。

#### 3 类 Terminal Action

coordinator 的每个 turn **必须**以以下三种 Terminal Action 之一结束：

1. **Dispatching research-worker subagent** — 执行下一个 phase/sub_phase。coordinator 输出 dispatch 指令后，本 turn 结束，等待 worker 返回。

2. **Asking the user via question tool** — 任何需要用户决策的场景。coordinator 输出 question tool 调用后，本 turn 结束，等待用户回复。无 phase 限制——只要 coordinator 需要用户决策（checkpoint、failed、paused、fallback、LOW confidence decision 等），就可以 ask user。

3. **Presenting results to user** — 项目完成（completed/partial）、Path 1/2/0 结果输出、不可恢复的错误终止。coordinator 输出最终文本后，本 turn 结束。纯文本输出，不等待用户回复。

这三类之间**零重叠**：

- Dispatch ≠ Ask user：dispatch 不等用户，ask user 等用户回复
- Ask user ≠ Present results：ask user 等用户回复，present results 不等
- Dispatch ≠ Present results：dispatch 委托 worker，present results 直接输出文本

#### FORBIDDEN 规则

```
FORBIDDEN: Ending a turn without a Terminal Action (dispatch, ask user, or present results).
  - Processing a digest without reaching a Terminal Action is an incomplete turn.
  - Calling advance_plan without reaching a Terminal Action is an incomplete turn.
  - Outputting a Phase Progress Notice without reaching a Terminal Action is an incomplete turn.

FORBIDDEN: Producing free-form analysis output as a Terminal Action.
  All user-facing output must be part of a state machine workflow phase:
  - Phase Progress Notice (required intermediate step within digest processing)
  - Checkpoint summary (ask user terminal action)
  - Final results (present results terminal action)
  - Error summary (ask user or present results terminal action)
```

#### 与原规则对比

| 原规则                                     | 新规则对应                                        | 变化                                                                       |
| ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Dispatching worker                      | Terminal Action 1                                 | 不变                                                                       |
| 2. Processing digest                       | **移除** — 降级为 workflow 中的 intermediate step | 不再作为 turn 结束方式                                                     |
| 3. Handling paused digest                  | Terminal Action 2 (ask user) — 当前 turn          | 拆解：当前 turn 以 ask user 结束；用户回复后的下一个 turn 以 dispatch 结束 |
| 4. advance_plan (ONLY execution)           | **移除** — 降级为 workflow 中的 intermediate step | 解除错误限制                                                               |
| 5. Asking user (ONLY checkpoint/execution) | Terminal Action 2 (ask user, any decision point)  | 解除限制，覆盖所有 ask 场景                                                |
| 无                                         | Terminal Action 3 (present results)               | **新增** — 覆盖 completed/Path 1/2/0                                       |

#### 每个 workflow turn 的 Terminal Action 对照

| Turn 类型                                             | Terminal Action                | 新规则覆盖 |
| ----------------------------------------------------- | ------------------------------ | ---------- |
| Initial dispatch (session recovery / gate→Path3)      | Dispatch worker                | ✅ TA1     |
| Standard phase digest (analysis/landscape/framing 等) | Dispatch next worker           | ✅ TA1     |
| phase_analysis_checkpoint                             | Ask user                       | ✅ TA2     |
| phase_checkpoint                                      | Ask user                       | ✅ TA2     |
| Audit-repair: audit→repair dispatch                   | Dispatch repair worker         | ✅ TA1     |
| Audit-repair: repair→re-audit dispatch                | Dispatch audit worker          | ✅ TA1     |
| Audit-repair loop 结束 (issues=0)                     | Dispatch next phase worker     | ✅ TA1     |
| Audit-repair loop 结束 (LOW confidence)               | Ask user                       | ✅ TA2     |
| Debate sub_phase routing (advocacy→critique→...)      | Dispatch next sub_phase worker | ✅ TA1     |
| Debate repair→next round                              | Dispatch next round worker     | ✅ TA1     |
| Debate repair→checkpoint                              | Ask user                       | ✅ TA2     |
| phase_execution → completed/partial                   | Present results                | ✅ TA3     |
| phase_execution paused                                | Ask user                       | ✅ TA2     |
| Any phase status=failed                               | Ask user                       | ✅ TA2     |
| Digest Parsing Fallback                               | Ask user                       | ✅ TA2     |
| Phase skip (landscape skip)                           | Dispatch next phase worker     | ✅ TA1     |
| Path 1 quick lookup                                   | Present results                | ✅ TA3     |
| Path 2 literature review                              | Present results                | ✅ TA3     |
| Path 0 non-research                                   | Present results                | ✅ TA3     |

所有 turn 类型均被 3 类 Terminal Action 覆盖，无遗漏、无重叠。

---

## 3. Sub-Deliverable B: Phase Progress Notice 机制

### 3B.1 输出时机：每个 phase/sub_phase 完成后

**选择**：在每个 phase/sub_phase 的 digest 处理完成后、advance_plan + git commit 执行完毕后（或 debate next-round 等不调用 advance_plan 的场景中、digest 处理完毕后）、Terminal Action 执行之前，coordinator 输出一条简短的 Phase Progress Notice。

**定位**：Notice 是 **Required Intermediate Step**，不是 Terminal Action。它在 digest 处理 workflow 中必须执行，但不定义 turn 如何结束——turn 的终点由后面的 Terminal Action 决定。

**理由**：

1. Phase 是用户理解研究进展的自然单位（"分析完成了"、"审计通过了"、"辩论结束了"），比中间步骤更适合作为进度通知的单位
2. Digest 处理完成后 coordinator 已经掌握了该 phase 的关键信息，此时输出信息最准确
3. Notice 放在 advance_plan + git commit 之后、Terminal Action 之前，不打断 coordinator 的工作流，只是插入一条输出。例外：debate next-round 场景不调用 advance_plan（phase 不变），Notice 在 digest 处理 + update_debate_state 后直接输出

### 3B.2 输出内容：结构化但简短

**选择**：Phase Progress Notice 使用固定的 4 行模板，不超过 4 行，每行不超过 40 中文字符。

**理由**：

1. 固定模板让用户形成阅读习惯
2. 行数 + 每行字数限制确保不干扰 CLI 可读性
3. 4 行结构覆盖用户最关心的 4 个问题：做了什么？发现了什么？进度如何？下一步做什么？

### 3B.3 输出方式：直接文本输出（不用 question tool）

**选择**：Notice 是纯文本输出（assistant message），**不使用 question tool**，**不等待用户回复**，coordinator 输出 Notice 后立即执行 Terminal Action。

**理由**：

1. Notice 是通知性输出，不是决策性交互——用户不需要在每个 phase 结束后做决定
2. 使用 question tool 会强制等待用户回复，打断自动化流程
3. 直接文本输出是非阻塞的——用户可以阅读或忽略，coordinator 不受影响

### 3B.4 Notice 输出时机表（合并原 §2.6 + §7）

| Phase / Sub-phase                                                  | Notice 类型      | 输出时机                                                                   | 原因                                                                 |
| ------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `phase_analysis`                                                   | 标准 Notice      | digest 处理 → advance_plan → git commit 后                                 | 首个实质性 phase，用户最关心                                         |
| `phase_analysis_checkpoint`                                        | ❌ 不输出        | —                                                                          | 已有 question tool 交互，重复输出浪费                                |
| `phase_audit_1` (循环结束)                                         | 合并 Notice      | advance_plan → git commit 后                                               | 用户关心审计最终结论，逐轮输出产生重复信息                           |
| `phase_audit_1` (repair sub_phase)                                 | ❌ 不输出        | —                                                                          | 循环内部迭代                                                         |
| `phase_landscape`                                                  | 标准 Notice      | digest 处理 → advance_plan → git commit 后                                 | 用户需知道景观扫描结果                                               |
| `phase_landscape` (skip)                                           | Skip Notice      | skip 决策写入 → advance_plan → git commit 后                               | 用户需知道跳过决策和理由                                             |
| `phase_audit_2` (循环结束)                                         | 合并 Notice      | 同 audit_1                                                                 | 同 audit_1                                                           |
| `phase_audit_2` (repair sub_phase)                                 | ❌ 不输出        | —                                                                          | 同 audit_1                                                           |
| `phase_framing`                                                    | 标准 Notice      | digest 处理 → advance_plan → git commit 后                                 | 用户需知道问题构建结果                                               |
| `phase_audit_3` (循环结束)                                         | 合并 Notice      | 同 audit_1                                                                 | 同 audit_1                                                           |
| `phase_audit_3` (repair sub_phase)                                 | ❌ 不输出        | —                                                                          | 同 audit_1                                                           |
| `phase_audit_3` (framing retry)                                    | 标准 Notice      | framing re-dispatch → advance_plan(phase=phase_audit_3) → git commit 后    | 用户需知道推理链重建是否完成；next_phase = phase_audit_3（重新审计） |
| `phase_debate` Round [N] (→ next round)                            | Round Notice     | repair digest → update_debate_state → git commit 后（不调用 advance_plan） | 用户关心每轮辩论结论；plan_number 从 state.json 获取                 |
| `phase_debate` Round [N] (→ checkpoint)                            | Round Notice     | repair digest → advance_plan → git commit 后                               | debate loop-end，plan_number 从 advance_plan 返回值获取              |
| `phase_debate` sub_phase (advocacy/critique/rebuttal/adjudication) | ❌ 不输出        | —                                                                          | sub_phase 在 3-5 min 内连续完成，逐个输出产生噪声                    |
| `phase_checkpoint`                                                 | ❌ 不输出        | —                                                                          | 已有 question tool 交互                                              |
| `phase_execution`                                                  | Execution Notice | final digest → advance_plan → git commit 后                                | 用户需知道最终执行结果                                               |
| `completed`                                                        | ❌ 不输出        | —                                                                          | 已有最终结果输出（Terminal Action 3: Present results）               |
| 任何 phase (status=failed)                                         | ❌ 不输出        | —                                                                          | 已有 error summary + ask user 交互                                   |
| 任何 phase (status=skipped)                                        | Skip Notice      | skip 决策写入 → advance_plan → git commit 后                               | 用户需知道跳过决策和理由                                             |

### 3B.5 Debate sub_phase：合并为 round-level 通知

debate phase 的 5 个 sub_phase 不逐个输出通知，只在每个 round 完成后（repair digest 处理完成后）输出一条 round-level 通知。

理由：5 个 sub_phase 在 3-5 分钟内连续完成，逐个输出产生信息噪声；用户关心的是"这一轮达成了什么结论"。

### 3B.6 Audit-repair 循环：只在循环结束时输出

audit phase 的 repair sub_phase 不单独输出通知。只在循环结束（issues_found=0 或 repair_count=3）时输出一条合并通知。

理由：循环是同一 phase 内的内部迭代，逐轮输出产生重复信息；合并通知简洁说明共修复了多少问题、是否仍有 unresolved gaps。

---

## 4. research.md 具体修改清单

### 4.1 修改点 1：§GENERAL RULES §Turn Termination — 框架重构

**位置**：research.md line 1611-1622

**修改**：将 Turn Termination 规则替换为以下内容（直接写入 research.md 的最终文本）：

```
## Turn Termination

Your turn MUST end with one of these three Terminal Actions:

1. **Dispatching research-worker subagent** — to execute a phase/sub_phase. After dispatch, your turn ends; wait for the worker to return.

2. **Asking the user via question tool** — for any decision point: checkpoint phases, failed phases, paused execution, digest parsing fallback, LOW confidence decisions, or any other scenario requiring user input. After calling question tool, your turn ends; wait for the user's reply.

3. **Presenting results to user** — for project completion (completed/partial), Path 1 quick lookup, Path 2 literature review, Path 0 non-research rejection, or irrecoverable error termination. Output final text, then your turn ends. No user reply expected.

These three categories have ZERO overlap: dispatch delegates to a worker (no wait), ask user waits for a reply, present results outputs text (no wait, no delegation). Every coordinator turn must reach exactly one of these.

FORBIDDEN: Ending a turn without a Terminal Action (dispatch, ask user, or present results).
  - Processing a digest without reaching a Terminal Action is an incomplete turn.
  - Calling advance_plan without reaching a Terminal Action is an incomplete turn.
  - Outputting a Phase Progress Notice without reaching a Terminal Action is an incomplete turn.
  - These are Required Intermediate Steps, not Terminal Actions — they must be performed within a turn, but the turn must continue until a Terminal Action is reached.

FORBIDDEN: Producing free-form analysis output as a Terminal Action.
  All user-facing output must be part of a state machine workflow phase:
  - Phase Progress Notice (required intermediate step within digest processing)
  - Checkpoint summary (ask user terminal action)
  - Final results (present results terminal action)
  - Error summary (ask user or present results terminal action)
```

### 4.2 修改点 2：§GENERAL RULES — 新增 §Phase Progress Notice subsection

**位置**：research.md §GENERAL RULES 部分，在 §Turn Termination 之前新增 subsection

**修改**：插入以下内容（直接写入 research.md 的最终文本）：

```
## Phase Progress Notice

After each phase/sub_phase completes, coordinator MUST output a Phase Progress Notice before executing the Terminal Action for that turn. Notice is a **Required Intermediate Step** — it must be performed, but the turn does not end with it. The turn continues until a Terminal Action (dispatch / ask user / present results).

Notice timing: output AFTER advance_plan + git commit, BEFORE Terminal Action. This ensures next_phase and plan_number are available from advance_plan return value. Exception: for debate next-round scenarios where advance_plan is NOT called, use state.json for plan_number and next_phase = phase_debate.

Notice is direct text output (assistant message), NOT question tool. Non-blocking — coordinator proceeds immediately after output.

### When NOT to output Notice

Skip Notice for phases that already have their own user-facing Terminal Action:
- phase_analysis_checkpoint → ask user (checkpoint summary)
- phase_checkpoint → ask user (checkpoint summary)
- completed → present results (final output)
- Any phase with status=failed → ask user (error summary + decision)
- Debate sub_phases (advocacy/critique/rebuttal/adjudication) → output at round level only
- Audit repair sub_phases → output at loop end only

### Standard Notice template (4 lines, ≤40 chars per line)

    ✓ [phase_display_name] 完成
      产出: [output_summary]
      进度: [current_phase] → [next_phase] (plan [N]/11)
      下一步: [next_action]

Template parameters:
- `[phase_display_name]`: from mapping table below + dynamic parameters
- `[output_summary]`: 1-2 sentence summary, **must be relevant to the current phase's work content** (e.g. analysis findings, audit conclusions, debate rulings). **Extraction rule: prefer digest fields; if digest lacks useful summary info, read the phase's output file for a brief key-point extraction.** No per-phase extraction specification — coordinator extracts naturally available info.
- `[current_phase]` and `[next_phase]`: from advance_plan return value (`current.phase`). For skip scenarios, `current_phase` is the skipped phase name, `next_phase` is advance_plan return value. For debate next-round (no advance_plan), `next_phase` = phase_debate.
- `[N]`: from advance_plan return value (`current.plan`) when advance_plan is called; from state.json.plan_number when advance_plan is NOT called (e.g. debate next-round). NOT hardcoded.
- `[next_action]`: brief description of what the next phase will do.

### phase_display_name mapping

| state.json phase          | phase_display_name         | Dynamic parameter                                |
| ------------------------- | -------------------------- | ------------------------------------------------ |
| phase_analysis            | 分析                       | —                                                |
| phase_audit_1             | 审计（轻量）               | —                                                |
| phase_landscape           | 文献景观扫描               | —                                                |
| phase_audit_2             | 审计（全量）               | —                                                |
| phase_framing             | 研究问题构建               | —                                                |
| phase_audit_3             | 推理链审计                 | —                                                |
| phase_debate              | 多方辩论 Round [N]         | N = state.json.debate.rounds_completed            |
| phase_execution           | 逐问题执行                 | —                                                |

For phase_debate, display name = base name + dynamic parameter: `多方辩论 Round [N]`.
Note: debate round Notice is output AFTER update_debate_state MCP has set rounds_completed to N (the current completed round). So rounds_completed = N, display name shows Round N.

### Skip Notice template (any phase with status=skipped)

    ✓ [phase_display_name] 已跳过
      产出: [skip_reason from STATE.md skip justification]
      进度: [current_phase] → [next_phase] (plan [N]/11)
      下一步: [next_action]

`current_phase` = name of the skipped phase. `next_phase` = advance_plan return value.

### Audit-repair merged Notice template (loop end)

When audit-repair loop ends (issues_found=0 or repair_count=3):

    ✓ [audit_phase_display_name] 完成（共 [R] 轮审计）
      修复: [issues_resolved] 个问题已修复, [issues_unresolved] 个未解决
      进度: [current_phase] → [next_phase] (plan [N]/11)
      下一步: [next_action]

- R = audit_round value from state.json at loop end (total audit dispatches within this loop, including the initial audit and all re-audits after repairs)
- issues_resolved / issues_unresolved: from last audit report or STATE.md Blockers
- plan [N]: from advance_plan return value (the plan_number AFTER advancing)

### Debate round Notice template

After repair digest processing per round. Two paths:

**Path A — next round (FURTHER_ROUNDS_NEEDED + round < 3):** advance_plan NOT called (phase stays phase_debate). next_phase and plan_number from state.json.

    ✓ 多方辩论 Round [N] 完成
      结论: [ruling summary from DEBATE.md adjudicator section]
      进度: phase_debate → phase_debate (plan [current_plan_number]/11)
      下一步: Round [N+1] 聚焦 ESCALATE 话题

**Path B — loop end (ALL_RESOLVED or round >= 3):** advance_plan called → phase_checkpoint. next_phase and plan_number from advance_plan return value.

    ✓ 多方辩论 Round [N] 完成
      结论: [ruling summary from DEBATE.md adjudicator section]
      进度: phase_debate → phase_checkpoint (plan [N_from_advance]/11)
      下一步: 进入研究计划确认

- ruling summary: from DEBATE.md adjudicator ruling (UPHELD/REVISE/ESCALATE/CONCEDED counts)

### Execution Notice template

After autoresearch final digest:

    ✓ 逐问题执行 完成
      结果: [resolved/failed/blocked counts from digest]
      进度: phase_execution → completed (plan [N_from_advance]/11)
      下一步: 研究项目已完成

If autoresearch returns status=paused → coordinator uses ask user Terminal Action, NOT Notice.
```

### 4.3 修改点 3：§Digest Processing — 新增 Notice 输出步骤

**位置**：research.md §Digest Processing 部分（约 line 399-431）

**修改**：在 digest processing 的步骤 3（If status=completed）中，在 advance_plan + git commit 之后、Terminal Action 之前，新增 Notice 输出步骤：

```
3. If status=completed:
   - Call validate_file_locations via research-state MCP
   - If compliant=false: relocate violating files, re-call validate_file_locations
   - Append digest YAML text to DIGESTS.md
   - Call advance_plan via research-state MCP → get return value (next_phase, plan_number)
   - Git commit
   - Output Phase Progress Notice (per §Phase Progress Notice in GENERAL RULES)
     * Standard Notice for all phases EXCEPT phase_analysis_checkpoint, phase_checkpoint, completed, and failed
       (these phases have their own Terminal Action user output — no additional Notice needed).
     * Debate and audit-repair sub_phases are identified by digest phase/sub_phase fields;
       they have their own Notice output rules (see §4.4/§4.5), not this step.
   - Route to next phase per routing rules → execute Terminal Action (dispatch / ask user / present results)

5. If status=skipped:
   - Write skip justification to STATE.md
   - Call advance_plan via research-state MCP → get return value (next_phase, plan_number)
   - Git commit
   - Output Skip Notice (per §Phase Progress Notice §Skip Notice template)
   - Route to next phase per skip rules → execute Terminal Action (dispatch next phase worker)
```

### 4.4 修改点 4：§Audit-Repair Loop Mechanism — 合并 Notice

**位置**：research.md §Audit-Repair Loop Mechanism（约 line 589-606）

**修改**：在循环结束的步骤 2（issues_found=0 → advance_plan）和步骤 6（repair_count=3 + issues_found>0 → mark unresolved → advance_plan）之后，新增合并 Notice 输出步骤：

```
After advance_plan in loop-end scenarios (issues_found=0 or repair_count=3):
1. Git commit
2. Output audit-repair merged Notice (per §Phase Progress Notice §Audit-repair merged Notice template)
   — Notice timing: advance_plan → git commit → Notice → Terminal Action (dispatch next phase worker)
3. Route to next phase → execute Terminal Action

This applies to all three audit phases (audit_1, audit_2, audit_3) uniformly.
For audit_3 structural incompleteness → framing retry: use standard Notice template instead.
  In this case, next_phase = phase_audit_3 (re-audit after framing retry), not the next major phase.
```

### 4.5 修改点 5：§Debate Loop §Repair Digest Processing — Round Notice

**位置**：research.md §Debate Loop §Repair Digest Processing

**修改**：在 repair digest processing 完成后、Terminal Action 之前，输出 round-level Notice。注意：advance_plan 仅在 debate loop-end 场景（ALL_RESOLVED 或 round >= 3）调用，next round 场景不调用 advance_plan（phase 不变，仍是 phase_debate）。

```
After repair digest processing:
1. Append repair digest to DIGESTS.md
2. Read DEBATE.md adjudicator ruling → extract ESCALATE topic names
3. Call update_debate_state via MCP
4. Clean up backup
5. Read repair digest fields for routing

Two routing paths:

Path A — FURTHER_ROUNDS_NEEDED + round < 3 (next round):
  6a. No advance_plan call (phase stays phase_debate)
  7a. Git commit (state update, not phase transition):
      git add .aether/research/
      git commit -m "research: phase_debate round [N] state updated (plan [plan_number])"
  8a. Output debate round Notice:
      - next_phase = phase_debate (next round)
      - plan_number = current state.json.plan_number (unchanged, typically 8)
      - plan_number source: state.json (NOT advance_plan return value)
  9a. Dispatch next round worker (Terminal Action 1)

Path B — ALL_RESOLVED or round >= 3 (loop end → checkpoint):
  6b. Call advance_plan(phase=phase_checkpoint, plan_number=9) → get return value
  7b. Git commit
  8b. Output debate round Notice:
      - next_phase = phase_checkpoint (from advance_plan return value)
      - plan_number = 9 (from advance_plan return value current.plan)
  9b. Proceed to phase_checkpoint (Terminal Action 2: ask user)
```

### 4.6 修改点 6：§phase_execution → completed — Notice

**位置**：research.md §phase_execution → completed

**修改**：在 advance_plan + STATE.md 更新后，输出 execution 完成通知：

```
After advance_plan(phase=completed, plan_number=11):
1. Update STATE.md: phase=completed
2. Output execution Notice (per §Phase Progress Notice §Execution Notice template)
3. Present results summary to user (Terminal Action 3: Present results)
```

---

## 5. 不修改的部分

| 组件                                                           | 是否修改 | 原因                                             |
| -------------------------------------------------------------- | -------- | ------------------------------------------------ |
| MCP 服务器（research-state, research-conventions）             | ❌       | Notice 是纯文本输出，不涉及 MCP 状态变更         |
| Skills（deep-research, autoresearch, debate-_, audit-_, etc.） | ❌       | Notice 是 coordinator 层行为，skills 不参与      |
| Subagents（research-worker, research-verifier, gpd-verifier）  | ❌       | Worker 不输出 Notice，Notice 由 coordinator 输出 |
| question tool 交互逻辑                                         | ❌       | checkpoint phase 的 question tool 交互不变       |
| state.json / STATE.md schema                                   | ❌       | Notice 不写入持久化文件，是一次性 CLI 输出       |
| PhaseResultDigest schema                                       | ❌       | Digest schema 不变                               |
| 核心源文件（packages/opencode/src/）                           | ❌       | 零核心源改动                                     |

---

## 6. 验收清单

### Sub-Deliverable A: Turn Termination 框架修正

1. Turn Termination 规则仅包含 3 类 Terminal Action（dispatch / ask user / present results），无 Intermediate Step 混列
2. 3 类 Terminal Action 之间零重叠
3. "Processing a PhaseResultDigest"不再作为合法 turn 结束方式
4. "Calling advance_plan via MCP"不再作为合法 turn 结束方式
5. "Asking the user"解除 phase 限制——覆盖所有需要用户决策的场景（checkpoint、failed、paused、fallback、LOW confidence 等）
6. "Presenting results to user"作为新 Terminal Action 覆盖 completed/Path 1/2/0
7. FORBIDDEN 规则明确禁止无 Terminal Action 的 turn 和 free-form analysis output

### Sub-Deliverable B: Phase Progress Notice 机制

8. 每个 phase/sub_phase 完成后，coordinator 按 §3B.4 时机表输出对应类型的 Notice
9. Notice 输出是非阻塞的（coordinator 不等待用户回复，立即继续 Terminal Action）
10. Notice 使用固定 4 行模板，每行不超过 40 中文字符
11. checkpoint phase (analysis_checkpoint, checkpoint) 不输出 Notice（已有 ask user 交互）
12. completed phase 不输出 Notice（已有 present results 交互）
13. status=failed 的 phase 不输出 Notice（已有 ask user 交互）
14. Debate sub_phase 不逐个输出 Notice，只在 round 完成后输出合并 Notice
15. Audit-repair 循环不逐轮输出 Notice，只在循环结束时输出合并 Notice
16. 任何 phase 的 status=skipped 输出 Skip Notice
17. Notice 在 advance_plan + git commit 之后输出（advance_plan 返回值提供 next_phase 和 plan_number）。例外：debate next-round 场景不调用 advance_plan，plan_number 从 state.json 获取，next_phase = phase_debate
18. plan_number 优先取 advance_plan 返回值中的 `current.plan`；当 advance_plan 未调用时（仅 debate next-round 场景），从 state.json.plan_number 取值。禁止硬编码。
19. next_phase 优先取 advance_plan 返回值中的 `current.phase`；当 advance_plan 未调用时（仅 debate next-round 场景），next_phase = phase_debate。禁止从 digest 的 next_phase 字段取值。
20. output_summary 优先从 digest 字段提取，digest 信息不足时从产出文件提取 1-2 句关键内容（无 per-phase 详细规则）；output_summary 必须与当前 phase 的工作内容相关
21. phase_display_name 使用映射表 + 动态参数拼接
22. Git commit 不因 Notice 输出而被跳过或中断
23. Notice 定位为 Required Intermediate Step，不是 Terminal Action
24. §Phase Progress Notice subsection 写入 research.md §GENERAL RULES（§Turn Termination 之前），包含完整定义文本
25. 零核心源文件改动
26. 零 MCP/skill 改动
27. 零 state.json/DIGESTS.md schema 改动

---

## 7. 示例输出

### 7.1 phase_analysis 完成

```
✓ 分析 完成
  产出: 识别了3个核心学派和2个主要争议点，研究方向聚焦于有效场论方法
  进度: phase_analysis → phase_analysis_checkpoint (plan 2/11)
  下一步: 等待用户确认分析结果
```

### 7.2 phase_audit_1 完成（1轮，无问题）

```
✓ 审计（轻量） 完成（共 1 轮审计）
  修复: 0 个问题需修复, 0 个未解决
  进度: phase_audit_1 → phase_landscape (plan 4/11)
  下一步: 执行文献景观扫描补充引用
```

### 7.3 phase_audit_1 完成（3轮 repair 循环，仍有未解决问题）

```
✓ 审计（轻量） 完成（共 3 轮审计）
  修复: 4 个问题已修复, 2 个未解决 → 标记为 unresolved_gap
  进度: phase_audit_1 → phase_framing (plan 6/11)
  下一步: 构建研究问题（注入 2 个 unresolved gap 作为约束）
```

### 7.4 phase_landscape skip（跳过 → phase_framing）

```
✓ 文献景观扫描 已跳过
  产出: 审计未发现引用缺失，无需补充扫描
  进度: phase_landscape → phase_framing (plan 6/11)
  下一步: 直接进入研究问题构建
```

注：skip Notice 的 `current_phase` 取被跳过 phase 的名字（`phase_landscape`），`next_phase` 取 advance_plan 推进后的实际 phase。plan_number 取 advance_plan 返回值。

### 7.5 phase_framing 完成

```
✓ 研究问题构建 完成
  产出: 构建了4个研究问题，核心方向为有效场论的适用性边界验证
  进度: phase_framing → phase_audit_3 (plan 7/11)
  下一步: 审计推理链完整性和依赖结构
```

### 7.5a phase_audit_3 (framing retry) — 推理链重建后重新审计

```
✓ 推理链审计 完成（推理链重建）
  产出: framing retry 修复了2个不完整推理链，重新进入审计验证
  进度: phase_audit_3 → phase_audit_3 (plan 7/11)
  下一步: 对重建后的推理链执行新一轮审计
```

注：framing retry 后 advance_plan 推进到 `phase_audit_3`（重新审计），`next_phase` = phase_audit_3，plan_number 保持 7 不变。

### 7.6 Debate Round 1 完成 → Round 2（next round，不调用 advance_plan）

```
✓ 多方辩论 Round 1 完成
  结论: UPHELD: 2, REVISE: 1, ESCALATE: 1, CONCEDED: 0
  进度: phase_debate → phase_debate (plan 8/11)
  下一步: Round 2 聚焦 ESCALATE 话题
```

注：next-round 场景不调用 advance_plan（phase 不变，仍是 phase_debate），plan_number 从 state.json 获取（仍为 8）。

### 7.7 Debate Round 3 完成 → checkpoint（loop end，调用 advance_plan）

```
✓ 多方辩论 Round 3 完成
  结论: UPHELD: 3, REVISE: 0, ESCALATE: 0, CONCEDED: 0
  进度: phase_debate → phase_checkpoint (plan 9/11)
  下一步: 进入研究计划确认
```

注：loop-end 场景调用 advance_plan(phase=phase_checkpoint, plan_number=9)，plan_number 和 next_phase 从 advance_plan 返回值获取。

### 7.8 phase_execution 完成

```
✓ 逐问题执行 完成
  结果: resolved: 3, failed: 1, blocked: 0 个问题
  进度: phase_execution → completed (plan 11/11)
  下一步: 研究项目已完成
```
