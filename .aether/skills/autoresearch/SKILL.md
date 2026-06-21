---
name: autoresearch
owner: research
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Per-question推进管理器 — autoresearch internally manages the complete
  per-question loop (Wave sorting → question serial → execution → verification → decision → failure propagation → retry → early abort).
  Coordinator dispatches once; autoresearch drives all question advancement internally.
  Invoked by research-worker via skill tool (unified invocation pattern).
---

# AutoResearch — phase_execution (Per-Question Execution Manager)

This skill implements phase_execution of the Path 3 research state machine. It is a **per-question execution manager** — coordinator dispatches research-worker once, research-worker invokes /autoresearch skill, and autoresearch internally manages the complete per-question loop including execution, verification, decision, failure propagation, retry, and early abort.

## File Structure

```
.aether/skills/autoresearch/
  SKILL.md                           — Core procedure (this file)
  references/
    digest-schemas.md                — All digest YAML schemas + persistence format templates + retry logic
    worker-prompts.md                — Subagent prompt templates + output file structures + ENVIRONMENT.md format
    edge-cases.md                    — Decision tables + error handling + session recovery + state.json operations
```

Autoresearch reads SKILL.md at skill invocation. It reads reference files at specific steps when detailed templates, schemas, or decision tables are needed — not all at once.

## Lifecycle Contract

**Input**: PLAN.md contract + STATE.md + framing digest (domain_mode, injected by coordinator via dispatch prompt) + state.json.execution (for session recovery)

**Output** (MUST write all of these):

1. `.aether/research/notepads/<slug>/execution/Qn_REASONING.md` — Per-question reasoning records
2. `.aether/research/notepads/<slug>/execution/Qn_EXECUTION.md` — Per-question execution results
3. `.aether/research/notepads/<slug>/execution/Qn_VERIFICATION.md` — Per-question verification reports
4. `.aether/research/persistence/ENVIRONMENT.md` — Host probe results + isolation strategy
5. `.aether/research/persistence/EXECUTION.md` — Phase-level summary (written once at execution end)
6. `.aether/research/persistence/VERIFICATION.md` — Phase-level summary (written once at execution end)

**State transition**: phase_execution → completed (managed by coordinator after receiving final_execution_digest)

**Precondition**: User must have confirmed execution at phase_checkpoint. MUST NOT invoke without user confirmation.

**MUST NOT**: Modify PLAN.md claims/deliverables. Call advance_plan (coordinator manages state transitions). Skip verification for any question. Dispatch verification subagent through research-worker. Skip ENVIRONMENT.md bash probe.

**domain_mode**: Injected by coordinator via dispatch prompt. Autoresearch uses this value directly — does NOT自行判断domain_mode. Value: `physics` or `general`. One-time decision — all questions use same domain_mode.

## Terminology

**Wave** = topologically sorted dependency batch (from PLAN.md §Execution Plan). Wave 1 = [Q1, Q3], Wave 2 = [Q2].

**cycle** = autoresearch's retry cycle (cycle 1 = first execution, cycle 2 = first retry, cycle 3 = second retry). Each question has its own independent cycle counter.

**Qn** = question identifier from PLAN.md §Execution Plan (Q1, Q2, Q3, Q4...). Qn numbering corresponds to PLAN.md §Claims `question` field value.

**Self-contained Dependencies** = PLAN.md Execution Plan Dependencies contain complete dependency description (critical annotation, fallback path, scope, source reference). PLAN.md is primary source; framing_reasoning.md only as fallback reference.

## Procedure — Per-Question推进管理器

### Step 1: Read Plan & Determine Waves

1. Read `.aether/research/persistence/PLAN.md` — extract §Execution Plan for per-Wave structure, question list, Dependencies (self-contained)
2. Read PLAN.md §Claims — extract tractability confidence for each question (HIGH > MEDIUM > LOW)
3. Determine Waves from PLAN.md §Execution Plan — list questions per Wave
4. Sort questions within each Wave by tractability confidence (HIGH > MEDIUM > LOW). Same confidence → follow PLAN.md ordering
5. Read `.aether/research/persistence/state.json` execution sub-object (if exists) → resume from interruption point if session recovery (see `references/edge-cases.md` §Session Recovery for detailed recovery logic)

### Step 2: Read Execution State & Resume

1. Read `state.json.execution`:
   - If exists with question_status entries → session recovery → resume from current interruption point (see `references/edge-cases.md` §Session Recovery)
   - If empty or all "pending" → fresh start, begin from Wave 1 Question 1
2. If state.json.execution does NOT exist → initialize it (see `references/edge-cases.md` §state.json Operations for initialization schema and jq command)
3. Read domain_mode from dispatch prompt — use this value directly, do NOT自行判断

### Step 3: Environment Probe (before first question execution)

Before dispatching the first local-executor, perform environment probe and write ENVIRONMENT.md. See `references/worker-prompts.md` §ENVIRONMENT.md YAML Structure for full format and `references/worker-prompts.md` §Environment Probe Commands for probe commands.

Key steps:

1. Bash probe host system (uv, python, wolframscript, GPU)
2. Demand-driven probe for each PLAN.md `environment_requirements` entry
3. Classify isolation strategy per table in `references/worker-prompts.md` §Isolation Strategy Classification
4. Write ENVIRONMENT.md to `.aether/research/persistence/ENVIRONMENT.md`
5. **Gap classification + resolution attempt**: Classify each discovered gap per `references/worker-prompts.md` §Gap Classification（见 `references/edge-cases.md` §Execution-level Three-Stage Decision §Gap Classification 表）. For each gap:
   - `auto_installable` → proceed to Step 4 (environment self-build). Do NOT skip executor dispatch for questions affected by this gap — attempt resolution first
   - `user_decision_needed` → mark questions affected by this gap as `blocked` in state.json.execution.question_status (blocking_dependency = gap description, blocking_reason="environment"). Questions NOT affected by this gap continue execution normally. At execution end, include user_decision_needed gaps in final_execution_digest → coordinator informs user about environment requirements after execution completes
   - `hard_blocked` → do NOT dispatch executor for affected questions. Other questions continue normally
   - After classification → proceed to Step 4

### Step 4: Environment Self-Build (auto_installable gaps only)

For each gap classified as `auto_installable` in Step 3:

1. For each auto_installable gap, determine installation method:
   - Use web search (webfetch/websearch) to find the correct installation method for the missing software in the current environment
   - Do NOT rely on hardcoded installation commands — software versions and installation methods change over time. Always discover the correct method for the current environment via web search
   - Web search retry: if first search returns no useful results → retry with alternative search queries (up to 2 additional attempts with different keyword combinations, 3 total attempts). If all search attempts fail → reclassify this gap as `user_decision_needed` (skip installation attempt, mark affected questions as blocked)
   - If websearch/webfetch tool is unavailable or returns errors → reclassify this gap as `user_decision_needed` (skip installation attempt)
2. Execute installation via bash using the web-search-discovered method:
   - Python packages: install into .aether/research/.venv
   - Wolfram/Mathematica paclets: install via wolframscript
   - System tools: report as user_decision_needed (autoresearch MUST NOT run brew/apt/sudo without explicit user consent)
3. After each install attempt → re-probe to verify installation success
4. Update ENVIRONMENT.md:
   - If installed successfully → remove gap from gaps list, update host_system.tools or venv_state.installed_packages
   - If install failed → reclassify this gap as `user_decision_needed`. Mark questions affected by this gap as `blocked` in state.json.execution.question_status
5. Write updated ENVIRONMENT.md with final gap classification

### Step 5: Per-Question Loop

For each Wave, for each question [Qn] (sorted by tractability confidence):

#### a. Check question_status

- `state.json.execution.question_status[Qn]` == "blocked" → skip
- "pending" → proceed
- "resolved" → skip (already completed)
- "failed" → skip (max retries exhausted)
- "skipped_vague" → skip (user chose to skip vague questions — distinct from blocked; no execution attempt)

#### b. Prepare execution context (执行于每个 question 的每次 dispatch — 正常推进与 retry 均经过此步)

1. Read PLAN.md §Execution Plan → Qn's method, tools, falsification test, Dependencies
2. For each dependency Qd in Dependencies:
   - If Qd resolved → read `state.json.resolved_conclusions[Qd].conclusion_summary` + `output_paths`
   - If Qd failed + fallback exists → note in local-executor prompt that Qd failed and Qn uses fallback assumption. Inject Qd failure context from Qd_REASONING.md + Qd_EXECUTION.md. Fallback description from PLAN.md §Execution Plan Dependencies for Qn (self-contained)
   - If Qd failed + critical → Qn already blocked (caught in step a)
3. **Re-read ENVIRONMENT.md**（每次 dispatch 前都 re-read——前一个 question 的 environment_retry 可能已更新 ENVIRONMENT.md，本 question 必须看到最新环境状态）. 若 Qn 需额外软件 → autoresearch supplements bash probe 并增量写入 ENVIRONMENT.md（NOT by local-executor）

#### c. Update state.json.execution.current_step = "execution"

See `references/edge-cases.md` §state.json Operations for jq command.

#### d. Dispatch local-executor

Construct local-executor prompt per template in `references/worker-prompts.md` §Local-Executor Prompt Template. Fill in:

- Qn, Wave number, cycle number (from current_cycle)
- Method, tools, falsification test (from PLAN.md)
- Dependency context (resolved conclusions or fallback assumption)
- MANDATORY two output files: Qn_REASONING.md + Qn_EXECUTION.md (structure templates in `references/worker-prompts.md`)
- Retry revision_needed (if cycle > 1, from previous cycle's execution_cycle_digest)

```
task(
  description: "[Qn] execution cycle [C]",
  subagent_type: "local-executor",
  delegation_depth: 0,
  prompt: [constructed prompt]
)
```

#### e. Read execution results → Three-Stage Decision

After local-executor returns, apply THREE-STAGE decision per `references/edge-cases.md` §Execution-level Three-Stage Decision（Stage 1 Output Completeness Check / Stage 2 Root-Cause Analysis / Stage 3 Cycle Decision 完整表、Retry Loop-back Procedure、Reset rules、Per-Question Flow 均在该节）. SKILL.md 只声明决策逻辑.

**行数预筛 + judgment-worker dispatch**：Stage 1 execution_shallow 判定走 `edge-cases.md` §行数预筛两阶段设计（行数预筛 fast path → judgment-worker(shallow-judgment) 权威评估）.

- **Stage 1 — Output Completeness Check**:
  - execution_produced → proceed to verification dispatch (step f-g)
  - execution_shallow → shallow_retry (max 1 per cycle, does NOT consume cycle): 行数预筛 → judgment-worker(shallow-judgment) → 据 improvement_guidance 构造 shallow_retry dispatch prompt → re-dispatch local-executor
  - execution_failed → proceed to Stage 2
- **Stage 2 — Root-Cause Analysis** (for execution_failed): classify root cause (Environment gap / PLAN.md method too vague / claim_impossible / Local-executor crash/timeout / Environment physically impossible) per `references/edge-cases.md` §Execution-level Three-Stage Decision §Stage 2 完整表
- **Stage 3 — Cycle Decision**: shallow_retry/environment_retry/verification_shallow_retry 不消耗 cycle (各 max 1 per cycle, cycle retry 时 reset). Cycle-consuming limit: 3 per question. Total dispatch limit: 7 per question.

#### f. Update state.json.execution.current_step = "verification"

See `references/edge-cases.md` §state.json Operations for jq command.

#### g. Dispatch verification subagent

**domain_mode=general**: Dispatch research-verifier. Prompt template in `references/worker-prompts.md` §Verification Worker Prompt Template.

```
task(description: "general verification [Qn] cycle [C]", subagent_type: "research-verifier", delegation_depth: 0, prompt: [constructed prompt])
```

**domain_mode=physics**: Sequentially dispatch two subagents:

1. Dispatch gpd-verifier first (prompt template in `references/worker-prompts.md` §GPD-Verifier Prompt Template)
2. Dispatch research-verifier (same as general mode, domain_mode=general)
3. After both return, merge results per `references/worker-prompts.md` §Physics Mode Verification Merge

#### h. Read verification_digest → decision

Extract verification_digest YAML block from task_result text. For domain_mode=physics, read both gpd-verifier and research-verifier task_results and merge per `references/worker-prompts.md` §Physics Mode Verification Merge before applying decision.

**h0. Verification depth check (before decision)**

按 `references/worker-prompts.md` §MANDATORY VERIFICATION DEPTH（verification 深度要求）+ 本步下方 verification_shallow_retry 流程执行. **行数预筛**（bash `grep -cv`，< 80 行直接判 shallow 跳过 judgment-worker）→ ≥ 80 行 dispatch judgment-worker(verification-depth-judgment, 见 `references/worker-prompts.md` §Judgment Worker Prompt Templates) → 读结构化判定 → 若 shallow 用 improvement_guidance 构造 verification_shallow_retry prompt.

verification_shallow_retry 流程（Step 5h0，在 "Apply decision table" 之前执行，与 execution_shallow_retry 对称）:

1. 行数预筛（cheap pre-filter，autoresearch 用 bash 获取 substantive 行数，不加载内容到 context）:
   - 若 substantive 行数 < 80 → verification_shallow（**fast path，跳过 judgment-worker**）：构造 generic verification_shallow_retry dispatch prompt "Your Qn_VERIFICATION.md has [N] substantive lines (minimum 80). Each verification sub-field requires concrete evidence quoting PLAN.md — not just PASS/FAIL labels." Re-dispatch verification worker（1 verification_shallow_retry，does NOT consume cycle/retries）
   - 若 substantive 行数 ≥ 80 → dispatch judgment-worker(verification-depth-judgment) 做深度 rubric 评估. judgment-worker 返回 deficient_fields + improvement_guidance → autoresearch 据此构造 targeted verification_shallow_retry dispatch prompt
2. verification_shallow_retry dispatch 前设置 current_step="verification", current_retry_type="verification_shallow"
3. 备份 Qn_VERIFICATION.md → Qn_VERIFICATION_shallow1.md
4. dispatch prompt 注入 "PREVIOUS VERIFICATION WAS SHALLOW" + 具体子字段缺陷列表
5. 仍 shallow after 1 retry → 视为 verification 失败: 若 reasoning 子字段 FAIL → retry_execution（consume cycle）；若 reasoning 全 PASS 但 conclusion 证据不足 → retry_execution（method 可能 flawed）

Apply decision table in `references/edge-cases.md` §Verification Decision 判定规则:

- **resolved** → write conclusion_summary to state.json.resolved_conclusions[Qn] → continue next question
- **paused_ask_user** → output paused digest immediately, BREAK loop
- **retry_execution** → backup current files, loop back to step d
- **failed** → mark question_status=failed, trigger failure propagation

If verification_digest parsing fails → see `references/edge-cases.md` §Verification Digest 解析失败处理.

#### i. Update state.json.execution

See `references/edge-cases.md` §state.json Operations for jq commands per decision outcome:

- resolved: update question_status, resolved_conclusions, current_wave, current_question, current_cycle
- failed: update question_status, current_wave, current_question, current_cycle
- On execution cycle retry: reset verification_retries[Qn] to 0

#### j. Early abort check (after EVERY question decision)

After updating question_status for Qn, check:

1. Are there any remaining "pending" questions in state.json.execution.question_status?
2. If NO → all remaining questions are failed/blocked → **early abort**
3. Early abort: write persistence 汇总 with partial results → output final digest → coordinator calls advance_plan

This check runs after EVERY question decision, not only at Wave boundaries.

#### k. Failure propagation

When Qn fails (max retries) OR fallback fails:

1. Read PLAN.md §Execution Plan Dependencies for Qn (self-contained: critical/fallback/dependency description)
2. For each dependent question Qd:
   - Critical dependency → mark Qd as "blocked" in state.json.question_status
   - Non-critical + fallback described in PLAN.md → continue Qd with fallback assumption (inject in next Qd's execution prompt)
   - No fallback in PLAN.md → output **paused digest** (see `references/digest-schemas.md` §paused digest), wait for coordinator to ask user

**failed/blocked question list**: Derived dynamically from question_status filter. No independent failed_questions/blocked_questions arrays.

#### l. Backup before retry (if retry needed)

When retrying execution for Qn (decision = retry_execution), backup current files as \_cycle[N] suffix and dispatch new cycle. See `references/edge-cases.md` §Backup Before Retry for detailed commands.

After backup: increment current_cycle, reset verification_retries[Qn] to 0, loop back to step d.

#### m. Failure synthesis (cycle-consuming retry only)

按 `references/edge-cases.md` §Execution-level Three-Stage Decision §Retry Loop-back Procedure step 6 执行: dispatch judgment-worker(failure-synthesis, 见 `references/worker-prompts.md` §Judgment Worker Prompt Templates) → 读 cycle_revision_context → 注入下一 cycle dispatch prompt.

插入位置: Step 5l "Backup before retry" 之后，cycle retry 最后一步，backup 完成、cycle 递增之后、dispatch 新 cycle 之前执行. judgment-worker(failure-synthesis) 从 Qn_REASONING_cycle[N].md + Qn_VERIFICATION_cycle[N].md 提炼失败上下文为结构化摘要, 返回 key_failures (含 revision_direction) 供 autoresearch 注入下一 cycle dispatch prompt.

cycle ≥2 的 dispatch prompt MUST 包含 simplified scope hint（源自 failure-synthesis 的 revision_direction）；failure-synthesis 无明确方向时 autoresearch 自主简化 scope——不得以相同 scope 重试上一 cycle 失败. 自主简化时 MUST 在 dispatch prompt 内显式记录决策依据三要素（简化了什么 / 为什么 / 预期影响），供 verification 和 audit 判断结论覆盖范围.

### Step 6: Final Output + Write Summaries

After all Waves processed OR early abort triggered:

1. Write `persistence/EXECUTION.md` — phase-level summary per format in `references/digest-schemas.md` §Persistence 汇总格式 §EXECUTION.md
2. Write `persistence/VERIFICATION.md` — phase-level summary per format in `references/digest-schemas.md` §Persistence 汇总格式 §VERIFICATION.md
3. Output **final_execution_digest** as FINAL message per schema in `references/digest-schemas.md` §final_execution_digest
4. If status=paused → use paused digest schema in `references/digest-schemas.md` §paused digest

MUST NOT output any other text after the digest YAML block.
