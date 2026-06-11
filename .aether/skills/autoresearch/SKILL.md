---
name: autoresearch
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Per-question推进管理器 — autoresearch internally manages the complete
  per-question loop (Wave sorting → question serial → execution → verification → decision → failure propagation → retry → early abort).
  Coordinator dispatches once; autoresearch drives all question advancement internally.
  Invoked by research-worker via skill tool (unified invocation pattern).
---

# AutoResearch — phase_execution (Per-Question Execution Manager)

This skill implements phase_execution of the Path 3 research state machine. It is a **per-question execution manager** — coordinator dispatches research-worker once, research-worker invokes /autoresearch skill, and autoresearch internally manages the complete per-question loop including execution, verification, decision, failure propagation, retry, and early abort.

## Lifecycle Contract

**Input**: PLAN.md contract + STATE.md + framing digest (verification_approach → domain_mode, injected by coordinator via dispatch prompt) + state.json.execution (for session recovery)

**Output** (MUST write all of these):

1. `.aether/research/notepads/<slug>/execution/Qn_REASONING.md` — Per-question reasoning records (each question)
2. `.aether/research/notepads/<slug>/execution/Qn_EXECUTION.md` — Per-question execution results (each question)
3. `.aether/research/notepads/<slug>/execution/Qn_VERIFICATION.md` — Per-question verification reports (each question)
4. `.aether/research/persistence/ENVIRONMENT.md` — Host probe results + isolation strategy (written by autoresearch via bash probe)
5. `.aether/research/persistence/EXECUTION.md` — Phase-level summary (written once at execution end)
6. `.aether/research/persistence/VERIFICATION.md` — Phase-level summary (written once at execution end)

**State transition**: phase_execution → completed (managed by coordinator after receiving final_execution_digest)

**Precondition**: User must have confirmed execution at phase_checkpoint. MUST NOT invoke this skill without user confirmation.

**MUST NOT**: Modify PLAN.md claims/deliverables during execution. Call advance_plan (coordinator manages state transitions). Skip verification for any question. Dispatch verification subagent through research-worker (dispatch directly instead). Skip ENVIRONMENT.md bash probe.

**domain_mode**: Injected by coordinator via dispatch prompt. Autoresearch uses this value directly — does NOT自行判断domain_mode by reading framing digest. Value is one of: `physics`, `general`. Domain_mode is a one-time decision for the entire project — all questions use the same domain_mode.

## Terminology

**Wave** = topologically sorted dependency batch (from framing_reasoning.md §Execution Order / PLAN.md §Execution Plan). Wave 1 = [Q1, Q3], Wave 2 = [Q2].

**cycle** = autoresearch's retry cycle (cycle 1 = first execution, cycle 2 = first retry, cycle 3 = second retry). Each question has its own independent cycle counter.

**Qn** = question identifier from PLAN.md §Execution Plan (Q1, Q2, Q3, Q4, ...). Qn numbering corresponds to PLAN.md §Claims `question` field value. Used in file naming and state.json keys.

**Self-contained Dependencies** = PLAN.md Execution Plan Dependencies fields contain complete dependency description (critical annotation, fallback path description, scope of applicability, source reference). Autoresearch reads PLAN.md as primary source for dependency data; framing_reasoning.md only as fallback reference when PLAN.md Dependencies info is incomplete.

## Procedure — Per-Question推进管理器

### Step 1: Read Plan & Determine Waves

1. Read `.aether/research/persistence/PLAN.md` — extract §Execution Plan for per-Wave structure, question list, Dependencies (self-contained)
2. Read PLAN.md §Claims — extract tractability confidence for each question (HIGH > MEDIUM > LOW)
3. Determine Waves from PLAN.md §Execution Plan — list questions per Wave
4. Sort questions within each Wave by tractability confidence (HIGH > MEDIUM > LOW). Same confidence → follow PLAN.md Execution Plan ordering
5. Read `.aether/research/persistence/state.json` execution sub-object (if exists) → resume from interruption point if session recovery

### Step 2: Read Execution State & Resume

1. Read `state.json.execution` — if it exists:
   - current_wave, current_question, current_cycle, current_step, verification_retries, question_status, resolved_conclusions
   - If question_status has entries → this is session recovery → resume from current interruption point
   - If question_status empty or all "pending" → fresh start, begin from Wave 1 Question 1
2. If state.json.execution does NOT exist → initialize it:

   ```bash
   # Determine slug from notepads directory
   slug=$(ls .aether/research/notepads/ | head -1)

   # Read PLAN.md Execution Plan to determine all question IDs
   # Then initialize state.json.execution via jq or Python
   jq '.execution = {
     "current_wave": 1,
     "current_question": "[first question in Wave 1]",
     "current_cycle": 1,
     "current_step": "execution",
     "verification_retries": {},
     "question_status": {
       "Q1": "pending",
       "Q2": "pending",
       ...
     },
     "resolved_conclusions": {}
   }' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
   ```

3. Read domain_mode from dispatch prompt — use this value directly, do NOT read framing digest to determine it

### Step 3: Environment Probe (before first question execution)

Before dispatching the first local-executor, perform environment probe:

```bash
uv --version 2>/dev/null || echo "CRITICAL: uv not available"
uv python list 2>/dev/null || echo "uv python management: not available"
wolframscript --version 2>/dev/null || echo "wolframscript: not available"
```

Demand-driven probing for each PLAN.md `environment_requirements` entry:

```bash
[tool_name] --version 2>/dev/null || [tool_name] -V 2>/dev/null || echo "[tool_name]: not available"
```

GPU probe if PLAN.md mentions GPU:

```bash
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "nvidia-smi: not available"
system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" || echo "GPU: not detected"
```

Write ENVIRONMENT.md to `.aether/research/persistence/ENVIRONMENT.md` BEFORE dispatching any executor.

ENVIRONMENT.md YAML structure:

```yaml
# Environment Profile — written by autoresearch at execution start

probe_timestamp: "[ISO 8601]"
cycle: 1

host_system:
  os: "[e.g., macOS 15.5 (Apple Silicon aarch64)]"
  uv: { available: true|false, version: "..." }
  uv_python: { available: true|false, versions: ["..."] }
  wolframscript: { available: true|false, version: "..." }
  tools:
    gcc: { available: true|false, version: "..." }
  gpu:
    available: true|false
    info: "..."

plan_requirements: [copied from PLAN.md environment_requirements]

isolation_strategy:
  - task: "[task_name]"
    strategy: "[uv_venv|local|local_compile]"
    software: ["..."]
    rationale: "[brief reason]"
    untrusted_source: true|false
    setup_commands: ["..."]
    run_prefix: "..."
    build_command: "..."
    run_command: "..."
    command: "..."

venv_state:
  path: ".aether/research/.venv"
  installed_packages: []
  last_cycle: null

gaps: []
```

**Isolation strategy classification**:

| Condition                                              | Strategy                                      |
| ------------------------------------------------------ | --------------------------------------------- |
| Licensed/self-contained software, host available       | `local`                                       |
| Pure Python + wheel-installable packages, uv available | `uv_venv`                                     |
| Pure Python, uv NOT available                          | `gap (critical)`                              |
| Compilation/build tasks, toolchain available           | `local_compile`                               |
| GPU workloads, local GPU available                     | `local` (with GPU)                            |
| Untrusted external repo code                           | `local_compile` with `untrusted_source: true` |
| Mixed (Python + compilation)                           | Split into separate tasks per strategy        |
| Compilation, toolchain NOT available                   | `gap (medium)`                                |

**Gap check**: If critical gap exists → do NOT dispatch executor for affected tasks → mark in digest → coordinator reports to user.

**Incremental ENVIRONMENT.md updates**: Between questions, if current question needs additional software, autoresearch performs bash probe and incrementally writes to ENVIRONMENT.md. Autoresearch owns this — NOT local-executor or verification worker.

### Step 4: Per-Question Loop

#### a. Check question_status

- If `state.json.execution.question_status[Qn]` == "blocked" → skip this question, continue to next
- If "pending" → proceed
- If "resolved" → skip (already completed), continue to next
- If "failed" → skip (max retries exhausted), continue to next

#### b. Prepare execution context

1. Read PLAN.md §Execution Plan → Qn's method, tools, falsification test, Dependencies (self-contained)
2. For each dependency Qd in Dependencies:
   - If Qd resolved → read `state.json.resolved_conclusions[Qd].conclusion_summary` + `output_paths`
   - If Qd failed + fallback exists → note in local-executor prompt that Qd failed and Qn uses fallback assumption
     - Inject Qd failure context from Qd_REASONING.md + Qd_EXECUTION.md into prompt
     - Fallback assumption description from PLAN.md §Execution Plan Dependencies for Qn (self-contained)
   - If Qd failed + critical → Qn already marked blocked (should have been caught in step a)
3. Read ENVIRONMENT.md for current environment state. If Qn needs additional software:
   - Perform bash probe (e.g., `pip list`, `python -c "import sympy"` using .aether/research/.venv/bin/python)
   - Incrementally write probe results to ENVIRONMENT.md (autoresearch does this directly, NOT via local-executor)

#### c. Update state.json.execution.current_step

```bash
jq '.execution.current_step = "execution"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

#### d. Dispatch local-executor

Determine slug from notepads directory:

```bash
slug=$(ls .aether/research/notepads/ | head -1)
```

Construct local-executor prompt with:

- Qn, Wave number, cycle number (from current_cycle)
- Method, tools, falsification test (from PLAN.md)
- Dependency context (resolved conclusions or fallback assumption)
- ENVIRONMENT.md handling instructions
- MANDATORY two output files: Qn_REASONING.md + Qn_EXECUTION.md
- Retry revision_needed (if cycle > 1, from previous cycle's execution_cycle_digest revision_needed)

Prompt template:

```
Execute question [Qn] (wave [N]) of phase_execution (cycle [C]).
Invoke /autoresearch skill.
Read PLAN.md Execution Plan wave [N] → question [Qn].

[If cycle > 1, add:]
REVISION FROM PREVIOUS CYCLE: [revision_needed from previous execution_cycle_digest — specific description of what to revise and why previous attempt failed]

ENVIRONMENT.md handling: Read ENVIRONMENT.md in persistence/ for current environment state (including venv_state). If current question needs additional software, autoresearch will supplement probe and incrementally update ENVIRONMENT.md — you do NOT modify ENVIRONMENT.md yourself.

DEPENDENCIES (from resolved questions):
- [Qd] conclusion: [conclusion_summary from state.json.resolved_conclusions[Qd]]
  - Input for [Qn]: [what Qd provides]
  - File reference: notepads/[slug]/execution/[Qd]_REASONING.md, [Qd]_EXECUTION.md, [Qd]_VERIFICATION.md

OR (if dependency failed, using fallback):
- [Qd] has failed. This question uses fallback assumption instead of [Qd]'s conclusion.
  - Failure context (from autoresearch): [Qd failure context from Qd_REASONING.md + Qd_EXECUTION.md]
  - [Qd] files ([Qd]_REASONING.md + [Qd]_EXECUTION.md) may be read for additional failure context, but may not exist ([Qd] worker crashed). If absent, rely on failure context summary + PLAN.md Dependencies fallback description.
  - Fallback assumption: [from PLAN.md Execution Plan Dependencies for Qn — self-contained fallback description]

Method: [from PLAN.md]
Tools: [from PLAN.md]
Falsification test: [from PLAN.md Acceptance Tests for Qn]

MANDATORY: You MUST write TWO output files:

1. Qn_REASONING.md — Step-by-step derivation from PLAN.md method to concrete solution.
   Structure: Method Design Reference → Step-by-Step Derivation (each step with
   Intention, Method, Divergence, Assumption introduced) → Dependency Usage.
   Every divergence from PLAN.md method MUST be declared.
   Every new assumption NOT in framing_reasoning.md MUST be flagged as undeclared.

2. Qn_EXECUTION.md — Execution results (numerical, code, output).
   Do NOT include a Dependencies section. All dependency details belong in
   Qn_REASONING.md §Dependency Usage only.

Output files: notepads/[slug]/execution/Qn_REASONING.md, Qn_EXECUTION.md
After completing, output execution_cycle_digest as your final message.
```

```
task(
  description: "[Qn] execution cycle [C]",
  subagent_type: "local-executor",
  delegation_depth: 0,
  prompt: [constructed prompt above]
)
```

#### e. Read execution results → execution-level failure decision

After local-executor returns task_result:

1. Check if task_result is empty or has no structured content → **execution_failed**
2. Check if Qn_REASONING.md + Qn_EXECUTION.md exist in `notepads/[slug]/execution/`
   - Both exist → **execution_produced** → proceed to verification dispatch (step f-g)
   - Neither exists → **execution_failed**
3. Parse execution_cycle_digest from task_result (last YAML code block with `phase_result_digest:`)
   - Parse failed → treat as execution_produced (files exist) but note digest parsing issue
   - Parse success → extract revision_needed for potential retry

**Execution-level failure decision table**:

| Condition                                               | Decision           | Next action                                                            |
| ------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| task_result empty/no structured content                 | execution_failed   | current_cycle < 3 → backup + retry; current_cycle ≥ 3 → mark Qn failed |
| Qn_REASONING.md + Qn_EXECUTION.md not exist             | execution_failed   | Same as above                                                          |
| Qn_REASONING.md + Qn_EXECUTION.md exist + digest normal | execution_produced | Proceed to verification dispatch                                       |
| digest.status=failed (partial output)                   | execution_produced | Proceed to verification dispatch (verifier judges correctness)         |

**Key distinction**: execution-level failure only judges "did the worker produce verifiable files", NOT "are results correct". Result correctness is judged by verification.

#### f. Update state.json.execution.current_step

```bash
jq '.execution.current_step = "verification"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

#### g. Dispatch verification subagent

**domain_mode=general**:

```
task(
  description: "general verification [Qn] cycle [C]",
  subagent_type: "research-verifier",
  delegation_depth: 0,
  prompt: "Execute verification for question [Qn] of phase_execution (cycle [C]).
Invoke /research-verification skill with domain_mode=general.
Read Qn_REASONING.md, Qn_EXECUTION.md, and PLAN.md Contract section for Qn's claims ONLY.
Do NOT verify claims from other questions.

RESOLVED CONCLUSIONS (from upstream questions, for dependency usage check):
- [Qd] conclusion_summary: [from state.json.resolved_conclusions[Qd].conclusion_summary]
  - Scope: [what Qd's conclusion covers and its limitations]
  - File reference: [Qd]_VERIFICATION.md (for detailed scope check)

[If any dependency Qd has failed and Qn uses fallback, add:]
- [Qd] has failed. Qn uses fallback assumption: [from PLAN.md Dependencies for Qn]

TWO-PART VERIFICATION:

Part 1 — Reasoning Verification (Qn_REASONING.md):

For each step in Qn_REASONING.md §Step-by-Step Derivation:
a. Method fidelity: Does the step's Method match PLAN.md Execution Plan for Qn?
   - If Divergence declared: Is the reason valid? Is impact correctly described?
   - If no Divergence but method clearly differs from PLAN.md → flag as undeclared divergence
b. Step completeness: Does every PLAN.md method step have a corresponding reasoning step?
   - Missing steps → flag as skipped step
c. Assumption audit: For each 'Assumption introduced':
   - Is this assumption declared in framing_reasoning.md §Assumptions Introduced?
   - If NOT → flag as undeclared assumption (FATAL for verification)
d. Dependency usage check: For each dependency in §Dependency Usage:
    - Is the usage within the scope of Qd's conclusion_summary? (no overgeneralization)
    - If fallback assumption used → is it the same fallback from PLAN.md Execution Plan Dependencies?
e. Fallback applicability check (if fallback assumption used):
   - Is the fallback assumption applicable to Qn's actual usage scenario?
   - If NOT → flag as fallback inapplicable (structural failure — must pause and ask user, no retry)

Part 2 — Conclusion Verification (Qn_EXECUTION.md + deterministic scripts):
Claims to verify: [list Qn's claims from PLAN.md — those with question=Qn]

VERIFICATION RESULT FORMAT:

Qn_VERIFICATION.md must contain two sections:
## Reasoning Verification
- method_fidelity: [PASS / FAIL — with details per step]
- step_completeness: [PASS / FAIL — list any skipped steps]
- assumption_audit: [PASS / FAIL — list any undeclared assumptions]
- dependency_usage: [PASS / FAIL — list any overgeneralization]
- fallback_applicability: [PASS / FAIL / N/A — list if fallback not applicable to Qn's usage]

## Conclusion Verification
- [general verification format per research-verification skill]

Decision rules:
- ALL claims verified + ALL reasoning sub-fields PASS or N/A → Qn resolved
- Reasoning FAIL (method divergence, undeclared assumption) → execution process unreliable, must retry
- Reasoning FAIL (fallback inapplicable, structural) → immediate pause and ask user (no retry)
- Conclusion FAIL (reasoning PASS) → method itself may be flawed, retry with revised strategy

Digest MUST include these fields:
- conclusion_summary: '[key numerical results, scope of validity, caveats]'
- claims_verified: [list of verified claims]
- claims_failed: [list of failed claims]
- reasoning_verification: { method_fidelity, step_completeness, assumption_audit, dependency_usage, fallback_applicability }
- Do NOT include a 'status' field in the digest — autoresearch judges question outcome from claims + reasoning sub-fields directly

Output file: notepads/[slug]/execution/Qn_VERIFICATION.md
After completing, output verification_digest as your final message."
)
```

**domain_mode=physics** — sequentially dispatch two subagents:

1. Dispatch gpd-verifier first:

```
task(
  description: "gpd verification [Qn] cycle [C]",
  subagent_type: "gpd-verifier",
  delegation_depth: 0,
  prompt: "Execute gpd-verification for question [Qn] of phase_execution (cycle [C]).
Invoke /gpd-verification skill + /gpd-domain-check skill + /gpd-conventions skill.

Claims to verify: [list Qn's claims from PLAN.md — those with question=Qn ONLY].
Do NOT verify claims from other questions.

Read Qn_REASONING.md and Qn_EXECUTION.md for execution context.
Read PLAN.md Contract section for Qn's claims ONLY.

TWO-PART VERIFICATION:

Part 1 — Reasoning Verification (Qn_REASONING.md, physics domain perspective):
a. Method fidelity: Does each step's Method match PLAN.md Execution Plan for Qn? Flag undeclared divergences.
b. Step completeness: Does every PLAN.md method step have a corresponding reasoning step? Flag skipped steps.
c. Assumption audit: Are new assumptions declared in framing_reasoning.md §Assumptions Introduced? Flag undeclared assumptions as FATAL.
d. Dependency usage: Is dependency usage within scope of upstream conclusion_summary? Flag overgeneralization.
e. Fallback applicability (if fallback used): Is the fallback assumption applicable to Qn's actual usage? If NOT → flag as fallback inapplicable (structural failure).

Part 2 — Conclusion Verification (physics domain-specific):
Procedure:
1. Convention check (gpd-conventions MCP)
2. Computational verification (gpd-verification SymPy scripts)
3. Domain-specific structural check (gpd-domain-check)

Write gpd-specific verification results — autoresearch will merge with general verification results into Qn_VERIFICATION.md.

Output gpd verification digest as your final message.
Digest MUST include: conclusion_summary, claims_verified, claims_failed, reasoning_verification (5 sub-fields: method_fidelity, step_completeness, assumption_audit, dependency_usage, fallback_applicability). Do NOT include a 'status' field."
)
```

2. Dispatch research-verifier (general verification):

```
task(
  description: "general verification [Qn] cycle [C]",
  subagent_type: "research-verifier",
  delegation_depth: 0,
  prompt: [same template as domain_mode=general above, with domain_mode=general]
)
```

3. After both subagents return, merge results:
   - If either subagent crashed (empty task_result) → verification_retries < 3 → re-dispatch that subagent; ≥ 3 → mark Qn failed
   - If gpd-verifier has FAIL in any check → combined verdict = FAIL
   - If research-verifier has FAIL in any check → combined verdict = FAIL
   - Only if both ALL PASS → combined verdict = resolved
   - Merge rule: ALL pass → resolved; any FAIL → failed; write both results into Qn_VERIFICATION.md (retain both sets of results, do NOT overwrite)

#### h. Read verification_digest → decision

**Digest parsing**: Extract verification_digest YAML block from task_result text (last `yaml` code block starting with `phase_result_digest:`).

1. If parsing fails:
   - verification_retries < 3 → re-dispatch verification worker (prompt emphasizes "output MUST include `yaml phase_result_digest:` code block as last output")
   - verification_retries ≥ 3 → mark Qn failed, trigger failure propagation
   - Increment verification_retries[Qn] in state.json
2. If parsing succeeds but key fields missing (question, claims, reasoning_verification):
   - Same handling as parsing fail (verification retry)
3. If parsing succeeds → apply **Verification Decision判定规则**:

| Condition                                                                      | Decision            | Next action                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Condition                                                                      | Decision            | Next action                                                                                                                                                                           | Loop behavior                                                |
| ------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| claims_failed empty + ALL reasoning sub-fields PASS or N/A                     | **resolved**        | Write conclusion_summary to state.json.resolved_conclusions[Qn] → continue next question                                                                                              | Continue per-question loop (next question in current Wave)   |
| reasoning has FAIL + fallback_applicability=FAIL                               | **paused_ask_user** | Design-level failure — immediately output paused digest (pause_reason: fallback_failed_ask_user, see paused digest schema below), NO retry (neither execution nor verification)       | **BREAK loop** — output paused digest, end autoresearch turn |
| reasoning has FAIL + fallback_applicability≠FAIL                               | **retry_execution** | Execution cycle < 3 → backup + retry; ≥ 3 → mark Qn failed                                                                                                                            | Loop back to step d (backup → re-dispatch local-executor)    |
| claims_failed non-empty + ALL reasoning PASS                                   | **retry_execution** | Method may be flawed — execution cycle < 3 → backup + retry                                                                                                                           | Loop back to step d                                          |
| claims_failed non-empty + reasoning has FAIL (not fallback_applicability=FAIL) | **retry_execution** | Both reasoning and conclusion issues — execution cycle < 3 → retry                                                                                                                    | Loop back to step d                                          |
| execution cycle ≥ 3 + still not resolved                                       | **failed**          | Mark question_status=failed → trigger failure propagation                                                                                                                             | Continue per-question loop → failure propagation (step k)    |

"ALL reasoning sub-fields PASS or N/A": fallback_applicability=N/A treated as PASS. Other 4 sub-fields (method_fidelity, step_completeness, assumption_audit, dependency_usage) must ALL be PASS.

#### i. Update state.json.execution

After decision for Qn:

```bash
# For resolved:
jq '.execution.question_status.[Qn] = "resolved" | .execution.resolved_conclusions.[Qn] = {"conclusion_summary": "[conclusion_summary from verification digest]", "output_paths": {"reasoning": "notepads/[slug]/execution/[Qn]_REASONING.md", "execution": "notepads/[slug]/execution/[Qn]_EXECUTION.md", "verification": "notepads/[slug]/execution/[Qn]_VERIFICATION.md"}} | .execution.current_wave = [wave_number] | .execution.current_question = "[Qn]" | .execution.current_cycle = [C]' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# For failed:
jq '.execution.question_status.[Qn] = "failed" | .execution.current_wave = [wave_number] | .execution.current_question = "[Qn]" | .execution.current_cycle = [C]' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Reset verification_retries on cycle retry:
jq '.execution.verification_retries.[Qn] = 0' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

#### j. Early abort check (after EVERY question decision)

After updating question_status for Qn, check:

1. Are there any remaining "pending" questions in state.json.execution.question_status?
2. If NO → all remaining questions are failed/blocked, no executable question left → **early abort**
3. Early abort triggers: write persistence 汇总 with partial results → output final digest → coordinator calls advance_plan

This check runs after EVERY question decision, not only at Wave boundaries.

#### k. Failure propagation

When Qn fails (max retries) OR fallback fails:

1. Read PLAN.md §Execution Plan Dependencies for Qn (self-contained: critical/fallback/dependency description)
2. For each dependent question Qd (questions that depend on Qn):
   - Critical dependency → mark Qd as "blocked" in state.json.question_status
   - Non-critical + fallback described in PLAN.md → continue Qd with fallback assumption (inject in next Qd's execution prompt)
   - No fallback in PLAN.md → output **paused digest** (see paused digest schema below), wait for coordinator to ask user

**Failed/blocked question list**: Derived dynamically from question_status filter (`question_status[Qn] == "failed"` or `"blocked"`). No independent failed_questions/blocked_questions arrays — avoids three-field synchronization inconsistency.

#### l. Backup before retry (if retry needed)

When retrying execution for Qn (decision = retry_execution):

1. Backup current files:

   ```bash
   slug=$(ls .aether/research/notepads/ | head -1)
   cp .aether/research/notepads/${slug}/execution/Qn_REASONING.md .aether/research/notepads/${slug}/execution/Qn_REASONING_cycle${C}.md
   cp .aether/research/notepads/${slug}/execution/Qn_EXECUTION.md .aether/research/notepads/${slug}/execution/Qn_EXECUTION_cycle${C}.md
   cp .aether/research/notepads/${slug}/execution/Qn_VERIFICATION.md .aether/research/notepads/${slug}/execution/Qn_VERIFICATION_cycle${C}.md
   ```

   (C = current cycle number being backed up, not new cycle number)

2. Increment current_cycle for Qn
3. Reset verification_retries[Qn] to 0
4. Dispatch new execution + verification cycle (loop back to step d)

**Verification retry** (when verification_digest parsing fails):

- Does NOT backup Qn_VERIFICATION.md (verification worker rewrites it each time)
- Does NOT consume execution cycle
- Does NOT reset verification_retries (increment from current value)
- Only re-dispatch verification subagent

### Step 5: Final Output + Write Summaries

After all Waves processed OR early abort triggered:

1. Write `persistence/EXECUTION.md` — phase-level summary (one-time write, NOT per-cycle append):

```markdown
# Execution Summary

## Resolved Questions

| Question | Conclusion Summary                                            | File Reference                            |
| -------- | ------------------------------------------------------------- | ----------------------------------------- |
| Q1       | [conclusion_summary from state.json.resolved_conclusions[Q1]] | notepads/[slug]/execution/Q1_EXECUTION.md |
| Q3       | [conclusion_summary from state.json.resolved_conclusions[Q3]] | notepads/[slug]/execution/Q3_EXECUTION.md |

## Failed Questions

| Question | Failure Reason                                           | File Reference                            |
| -------- | -------------------------------------------------------- | ----------------------------------------- |
| Q2       | [failure context from Q2_REASONING.md + Q2_EXECUTION.md] | notepads/[slug]/execution/Q2_REASONING.md |

## Blocked Questions

| Question | Blocking Dependency | Note                                   |
| -------- | ------------------- | -------------------------------------- |
| Q4       | Q2 (critical)       | Cannot proceed without Q2's conclusion |

## Overall Result

[N questions resolved / N total questions. Key findings: [1-2 sentence synthesis from resolved conclusion_summaries].]
```

2. Write `persistence/VERIFICATION.md` — phase-level summary:

```markdown
# Verification Summary

## Resolved Questions

| Question | Reasoning Verdict | Conclusion Verdict | File Reference                               |
| -------- | ----------------- | ------------------ | -------------------------------------------- |
| Q1       | ALL PASS          | ALL PASS           | notepads/[slug]/execution/Q1_VERIFICATION.md |
| Q3       | ALL PASS          | ALL PASS           | notepads/[slug]/execution/Q3_VERIFICATION.md |

## Failed Questions

| Question | Failure Category | Details              | File Reference                               |
| -------- | ---------------- | -------------------- | -------------------------------------------- |
| Q2       | conclusion FAIL  | [claims_failed list] | notepads/[slug]/execution/Q2_VERIFICATION.md |

## Blocked Questions

| Question | Note                         |
| -------- | ---------------------------- |
| Q4       | Not verified (blocked by Q2) |
```

3. Output **final_execution_digest** as FINAL message:

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: completed | partial | paused
  domain_mode: "[physics / general]"
  resolved_questions:
    - question: "[Qn]"
      conclusion_summary: "[from state.json.resolved_conclusions[Qn]]"
      output_paths:
        reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
        execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
        verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  failed_questions:
    - question: "[Qn]"
      failure_summary: "[from Qn_REASONING.md + Qn_EXECUTION.md failure context]"
      output_paths:
        reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
        execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
        verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  blocked_questions:
    - question: "[Qn]"
      blocking_dependency: "[Qd (critical) / reason]"
  overall_result: "[N resolved / N total questions]"
  output_paths:
    execution_summary: "persistence/EXECUTION.md"
    verification_summary: "persistence/VERIFICATION.md"
  next_phase: null
```

**When status=paused** (user decision needed), use paused digest schema instead:

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted]"
  pause_details:
    failed_question: "[Qn]"
    failure_summary: "[...]"
    affected_questions: ["[Qd list]"]
    fallback_attempted: true|false
    user_options:
      - "Skip all dependent questions, accept partial results"
      - "Provide alternative assumption for [Qd] (you specify)"
      - "Abort execution"
  execution_progress:
    resolved_questions: ["[list]"]
    failed_questions: ["[list]"]
    blocked_questions: ["[list]"]
    current_wave: [N]
    current_question: "[Qn]"
```

MUST NOT output any other text after the digest YAML block.

## Per-question Digest Schema

### execution_cycle_digest

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: execution_cycle
  cycle: [N]
  question: "[Qn]"
  status: completed | partial | failed
  tests_passed: ["[test 1]"]
  tests_failed: ["[test N]"]
  revision_needed: null | "[what to revise]"
  output_paths:
    reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
    execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
  next_phase: null
```

**status semantics**:

- `completed`: Qn_REASONING.md + Qn_EXECUTION.md produced, all declared tests_passed
- `partial`: Qn_REASONING.md + Qn_EXECUTION.md produced, some tests_failed
- `failed`: local-executor crashed/produced no files

**Deleted fields** (compared to old schema): `tests_inconclusive`, `execution_summary`, `environment_strategy_used`, `gaps_reported`, `output_paths.environment`

### verification_digest

**NO `status` field** — autoresearch judges from claims + reasoning sub-fields.

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: verification
  cycle: [N]
  question: "[Qn]"
  domain_mode: "[physics / general]"
  conclusion_summary: "[key numerical results, scope of validity, caveats — worker-generated]"
  claims_verified: ["[claim 1]"]
  claims_failed: ["[claim N]"]
  reasoning_verification:
    method_fidelity: [PASS / FAIL]
    step_completeness: [PASS / FAIL]
    assumption_audit: [PASS / FAIL]
    dependency_usage: [PASS / FAIL]
    fallback_applicability: [PASS / FAIL / N/A]
  output_paths:
    verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  next_phase: null
```

### DIGESTS.md 写入规则

Per-question execution_cycle_digest and verification_digest are consumed internally by autoresearch — **NOT written to DIGESTS.md**. Autoresearch writes 1 final_execution_digest to DIGESTS.md after all questions processed. Paused digest also writes 1 entry to DIGESTS.md.

## Qn_REASONING.md Structure

```markdown
# [Qn] Execution Reasoning

## Method Design Reference

- PLAN.md method: [method description from PLAN.md Execution Plan for Qn]
- PLAN.md tools: [tools list from PLAN.md]
- PLAN.md falsification test: [test description from PLAN.md Acceptance Tests for Qn]

## Step-by-Step Derivation

### Step 1: [derive/describe what was done]

- Intention: [what this step is supposed to achieve per PLAN.md]
- Method: [how this step was executed — matching PLAN.md method or diverging]
- Divergence: [NONE / describe if method diverged from PLAN.md]
  - Reason for divergence: [if diverged: why]
  - Impact: [if diverged: what this means for downstream steps]
- Assumption introduced: [NONE / describe any new assumption not in PLAN.md]
  - Is this assumption in framing_reasoning.md Assumptions Introduced? [yes / no]
  - If no → this is an undeclared assumption that must be flagged in verification

### Step 2: [same structure]

...

## Dependency Usage

- [Qd] conclusion used: [what was used from Qd]
  - From: Qd_VERIFICATION.md §[section], claim [X]
  - How used: [parameter in equation / initial condition / method selection criterion]
  - Is this usage consistent with Qd's conclusion scope? [yes / no]
  - If no → overgeneralization detected, must be flagged in verification

- Fallback assumption (if applicable):
  - Assumption: [description — from PLAN.md §Execution Plan Dependencies for [Qn]]
  - Risk: [what could go wrong]
```

## Qn_EXECUTION.md Structure

**No Dependencies section** — dependency info authoritative source is Qn_REASONING.md §Dependency Usage only.

```markdown
# [Qn] Execution Record

## Execution

[execution content — numerical results, code, output]
```

## Retry Logic

| Cycle | Behavior                                 | File operation                                             |
| ----- | ---------------------------------------- | ---------------------------------------------------------- |
| 1     | Normal execution                         | Worker writes Qn_REASONING.md + Qn_EXECUTION.md            |
| 2     | Based on previous cycle revision_needed  | Backup current files as \_cycle1 → Worker writes new files |
| 3     | Second revision                          | Backup current files as \_cycle2 → Worker writes new files |
| >3    | Mark failed, trigger failure propagation | N/A                                                        |

Retry backup: autoresearch backs up Qn_REASONING.md / Qn_EXECUTION.md / Qn_VERIFICATION.md as Qn_REASONING_cycle[N].md / Qn_EXECUTION_cycle[N].md / Qn_VERIFICATION_cycle[N].md (N = current cycle being backed up). Worker writes new versions replacing no-suffix files.

**verification_retries independent counting**: Uses state.json.execution.verification_retries[Qn]. Initialized to 0 per question. Incremented on each verification retry. Upper limit 3. Reset to 0 on execution cycle retry or question resolved.

**verification retry does NOT consume execution cycle**: Verification is an independent step. Its failure should NOT cause entire execution cycle to be backup-and-redone. Only execution failure consumes execution cycle count.

**verification retry does NOT backup Qn files**: Verification worker rewrites Qn_VERIFICATION.md each time. Only execution cycle retry backs up all Qn files.

## Session Recovery (autoresearch layer)

When autoresearch is re-dispatched for session recovery:

1. Read state.json.execution → current_wave, current_question, current_cycle, current_step, verification_retries, question_status
2. Resume based on state:
   - current_step = "execution" → check if Qn_REASONING.md + Qn_EXECUTION.md exist
     - Files exist and complete → construct fallback digest, directly enter verification dispatch (verification_retries continues from state.json, NOT reset)
     - Files don't exist → re-dispatch local-executor (cycle = current_cycle), reset verification_retries to 0
   - current_step = "verification" → check if Qn_VERIFICATION.md exists
     - File exists → construct fallback verification digest, directly do decision
     - File doesn't exist → re-dispatch verification worker (verification_retries continues from state.json, NOT reset)
   - question_status has blocked → continue next non-blocked question
   - question_status has pending → continue from that question

## Subagent Dispatch

- local-executor: For all local tasks (strategy=uv_venv, local, or local_compile). delegation_depth=0 enforced via task() runtime parameter — Discipline.compile translates `delegation_depth: 0` into `{permission: "task", pattern: "*", action: "deny"}` at runtime, preventing further subagent nesting.
- research-verifier: For general mode verification (domain_mode=general). Same delegation_depth=0 enforcement.
- gpd-verifier: For physics mode domain-specific verification (dispatched by autoresearch directly, NOT through research-worker). Same delegation_depth=0 enforcement.
- FORBIDDEN: Dispatching explore or general subagents for execution or verification work
- FORBIDDEN: Dispatching verification subagent through research-worker (dispatch directly via task tool)

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail. Never skip environment verification. Never execute compilation commands not declared in PLAN.md environment_requirements. Never skip verification for any question — every question must go through execution → verification → decision.
