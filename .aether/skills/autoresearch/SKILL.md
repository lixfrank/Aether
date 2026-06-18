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

**Input**: PLAN.md contract + STATE.md + framing digest (verification_approach → domain_mode, injected by coordinator via dispatch prompt) + state.json.execution (for session recovery)

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
5. **Gap check**: If critical gap exists → do NOT dispatch executor for affected tasks → mark in digest → coordinator reports to user

### Step 4: Per-Question Loop

For each Wave, for each question [Qn] (sorted by tractability confidence):

#### a. Check question_status

- `state.json.execution.question_status[Qn]` == "blocked" → skip
- "pending" → proceed
- "resolved" → skip (already completed)
- "failed" → skip (max retries exhausted)

#### b. Prepare execution context

1. Read PLAN.md §Execution Plan → Qn's method, tools, falsification test, Dependencies
2. For each dependency Qd in Dependencies:
   - If Qd resolved → read `state.json.resolved_conclusions[Qd].conclusion_summary` + `output_paths`
   - If Qd failed + fallback exists → note in local-executor prompt that Qd failed and Qn uses fallback assumption. Inject Qd failure context from Qd_REASONING.md + Qd_EXECUTION.md. Fallback description from PLAN.md §Execution Plan Dependencies for Qn (self-contained)
   - If Qd failed + critical → Qn already blocked (caught in step a)
3. Read ENVIRONMENT.md. If Qn needs additional software → autoresearch supplements bash probe and incrementally writes to ENVIRONMENT.md (NOT by local-executor)

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

#### e. Read execution results → execution-level failure decision

After local-executor returns, apply decision table in `references/edge-cases.md` §Execution-level Failure Decision:

- execution_produced → proceed to verification dispatch (step f-g)
- execution_failed → current_cycle < 3 → backup + retry; ≥ 3 → mark Qn failed

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

Extract verification_digest YAML block from task_result text. For domain_mode=physics, read both gpd-verifier and research-verifier task_results and merge per `references/worker-prompts.md` §Physics Mode Verification Merge before applying decision. Apply decision table in `references/edge-cases.md` §Verification Decision 判定规则.

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

### Step 5: Final Output + Write Summaries

After all Waves processed OR early abort triggered:

1. Write `persistence/EXECUTION.md` — phase-level summary per format in `references/digest-schemas.md` §Persistence 汇总格式 §EXECUTION.md
2. Write `persistence/VERIFICATION.md` — phase-level summary per format in `references/digest-schemas.md` §Persistence 汇总格式 §VERIFICATION.md
3. Output **final_execution_digest** as FINAL message per schema in `references/digest-schemas.md` §final_execution_digest
4. If status=paused → use paused digest schema in `references/digest-schemas.md` §paused digest

MUST NOT output any other text after the digest YAML block.
