# Worker Prompt Templates & Output Structures

This reference contains prompt templates for subagent dispatch and output file structure templates. Autoresearch reads these when constructing dispatch prompts in Step 5d (local-executor) and Step 5g (verification subagents).

## Local-Executor Prompt Template

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
   Intention, Method, Divergence, Assumption introduced) → Dependency Usage → Partial Execution.
   Every divergence from PLAN.md method MUST be declared.
   Every new assumption NOT in framing_reasoning.md MUST be flagged as undeclared.

   **MANDATORY CONTENT DEPTH REQUIREMENTS** (Qn_REASONING.md depth requirements):
   - MUST contain a substantive derivation step for EACH method step in PLAN.md Execution Plan for Qn
   - Each step's Method field MUST describe a concrete, independently reproducible operation (NOT just an action label like "performed dimensional analysis"). Inspection/check steps without producing new information are NOT sufficient
   - **Substantive derivation may overturn PLAN.md method step's preset**: if execution reveals a PLAN.md method step's approach is incorrect/suboptimal, document the overturning in Divergence field
   - If a step cannot be fully executed due to gaps → write partial execution results (§Partial Execution subsection below). NEVER collapse multiple incomplete steps into a single "environment gap" statement
   - **Substantive derivation criteria (three准则)**: (a) Operational Specificity, (b) Output Traceability, (c) PLAN Correspondence — autoresearch (via judgment-worker) checks these
   - **MINIMUM length: 100 lines** (excluding section headers). Files under 100 lines will be classified as execution_shallow

2. Qn_EXECUTION.md — Execution results (numerical, code, output).
   Do NOT include a Dependencies section. All dependency details belong in
   Qn_REASONING.md §Dependency Usage only.

   **MANDATORY CONTENT DEPTH REQUIREMENTS** (Qn_EXECUTION.md depth requirements):
   - MUST contain at least one concrete artifact per PLAN.md method step (numerical results, code output, computed values, analysis artifacts)
   - If full execution is blocked → partial artifacts from executable sub-steps are still mandatory
   - NEVER write only a "Status: FAILED" line without detailing: what was attempted, what partially succeeded, specific gap that blocked completion
   - Include execution logs, command outputs, and computed data

Output files: notepads/[slug]/execution/Qn_REASONING.md, Qn_EXECUTION.md
After completing, output execution_cycle_digest as your final message.
```

## Verification Worker Prompt Template (domain_mode=general)

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

**MANDATORY VERIFICATION DEPTH** (Qn_VERIFICATION.md depth requirements):

Qn_VERIFICATION.md MUST contain detailed evidence for each sub-field verdict, not just PASS/FAIL labels:

- **method_fidelity**: each reasoning step MUST be compared to PLAN.md method with explicit quote-and-compare. For each step: "PLAN.md says [quote] → Qn_REASONING.md does [description] → match/divergence [reasoning]"
- **step_completeness**: every PLAN.md method step MUST be listed individually with found/not-found status and content summary. Format: "Step [N] [PLAN method description]: FOUND (content: [1-line summary]) / NOT FOUND"
- **assumption_audit**: each assumption MUST be cross-referenced with framing_reasoning.md section number. Format: "Assumption '[description]' → framing_reasoning.md §[section] line [N]: FOUND / NOT FOUND (undeclared)"
- **dependency_usage**: each dependency MUST be checked against resolved_conclusions scope with explicit scope comparison. Format: "Dependency [Qd]: used as [how Qd was used] → Qd conclusion scope: [scope description] → within scope / overgeneralization [reason]"
- **conclusion verification**: verification evidence MUST match the claim type per the claim-type hierarchy below (Computational/Structural/Conceptual). LLM-only reasoning WITHOUT computation/citation/reasoning chain is NEVER sufficient for "independently confirmed"

**MINIMUM length: 80 lines** (excluding digest YAML block). Files under 80 lines are considered shallow verification.

autoresearch 会检查上述深度要求是否满足（via 行数预筛 + judgment-worker(verification-depth-judgment)），不满足的 verification 将被 re-dispatch（verification_shallow_retry, 1 max per cycle, does NOT consume cycle）.

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

## GPD-Verifier Prompt Template (domain_mode=physics)

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

## Physics Mode Verification Merge

After both gpd-verifier and research-verifier return:

1. If either subagent crashed (empty task_result) → verification_retries < 3 → re-dispatch that subagent; ≥ 3 → mark Qn failed
2. If gpd-verifier has FAIL in any check → combined verdict = FAIL
3. If research-verifier has FAIL in any check → combined verdict = FAIL
4. Only if both ALL PASS → combined verdict = resolved
5. Merge rule: ALL pass → resolved; any FAIL → failed; write both results into Qn_VERIFICATION.md (retain both sets of results, do NOT overwrite)

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

## Partial Execution (if any step could not be fully executed)

If any step could not be fully executed due to environment/dependency gaps, this section MUST be present:

For each incomplete step:

- Step [N]: [what was attempted]
- Partial result: [what succeeded before the gap blocked further progress]
- Blocking gap: [specific gap description — NOT just "environment missing"]
- Gap impact on this step: [what this step would have produced if the gap were absent]
- Gap impact on downstream steps: [which subsequent steps are affected and how]
- Workaround attempted: [any alternative approach tried — even if it also failed]

NEVER write "No retry was attempted because the failures are structural/environmental" as a blanket dismissal — document each gap's impact on each affected step individually.
```

## Qn_EXECUTION.md Structure

**No Dependencies section** — dependency info authoritative source is Qn_REASONING.md §Dependency Usage only.

```markdown
# [Qn] Execution Record

## Execution

[execution content — numerical results, code, output]
```

## ENVIRONMENT.md YAML Structure

Autoresearch writes this to `.aether/research/persistence/ENVIRONMENT.md` BEFORE dispatching any executor. Incrementally updated between questions by autoresearch (NOT by local-executor or verification worker).

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

### Isolation Strategy Classification

| Condition                                              | Strategy                                      |
| ------------------------------------------------------ | --------------------------------------------- |
| Licensed/self-contained software, host available       | `local`                                       |
| Pure Python + wheel-installable packages, uv available | `uv_venv`                                     |
| Pure Python, uv NOT available                          | `gap`                                         |
| Compilation/build tasks, toolchain available           | `local_compile`                               |
| GPU workloads, local GPU available                     | `local` (with GPU)                            |
| Untrusted external repo code                           | `local_compile` with `untrusted_source: true` |
| Mixed (Python + compilation)                           | Split into separate tasks per strategy        |
| Compilation, toolchain NOT available                   | `gap`                                         |

> **注**: gap 行不再带 (critical)/(medium) 严重度标签——所有 gap 一律流入 §Gap Classification（下表），完整定义见 `edge-cases.md` §Execution-level Three-Stage Decision §Gap Classification 表.

### Gap Classification

完整定义见 `edge-cases.md` §Execution-level Three-Stage Decision §Gap Classification 表（三个 category 的完整定义 + classification rules + hard_blocked 保守判定原则 + 终止路径判定）. autoresearch 在 Step 3 用下表做 gap classification:

- `auto_installable` → proceed to Step 4 (environment self-build)
- `user_decision_needed` → mark affected questions blocked, continue others
- `hard_blocked` → do NOT dispatch executor for affected questions

**谁负责分类**: autoresearch 在 Step 3 (Environment Probe) 自行做 gap classification（规则匹配 + bash probe 结果），不 dispatch judgment-worker.

### Environment Probe Commands

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

**Gap classification**: Classify each discovered gap per §Gap Classification above, then proceed per SKILL.md Step 3 point 5.

**Incremental ENVIRONMENT.md updates**: Between questions, if current question needs additional software, autoresearch performs bash probe and incrementally writes to ENVIRONMENT.md.

## Judgment Worker Prompt Templates

autoresearch dispatches judgment-worker (subagent at `.aether/agent/judgment-worker.md`, delegation_depth=0, read-only) for structured rubric evaluation. **Task rubrics and YAML return schemas are authoritative in `.aether/agent/judgment-worker.md`** — judgment-worker reads its own agent definition at dispatch time, so the dispatch prompt only needs to specify the task type and file targets. Each template below is a dispatch skeleton autoresearch fills in; it does NOT repeat the rubric/YAML (which live in judgment-worker.md §Four Judgment Tasks).

**a. shallow-judgment** (Step 5e Stage 1, execution_shallow 判定):

```
task(
  description: "shallow judgment [Qn]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Apply task a (execution_shallow rubric) per your agent definition.
  Read notepads/[slug]/execution/Qn_REASONING.md and Qn_EXECUTION.md.
  Read PLAN.md §Execution Plan for Qn's method.
  Return YAML per task a schema."
)
```

**b. verification-depth-judgment** (Step 5h0):

```
task(
  description: "verification depth judgment [Qn]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Apply task b (verification_depth rubric) per your agent definition.
  Read notepads/[slug]/execution/Qn_VERIFICATION.md.
  Read PLAN.md §Claims for Qn's claims ONLY.
  Return YAML per task b schema."
)
```

**c. failure-synthesis** (Step 5m):

```
task(
  description: "failure synthesis [Qn] cycle [N]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Apply task c (failure_synthesis) per your agent definition.
  Read notepads/[slug]/execution/Qn_REASONING_cycle[N].md and Qn_VERIFICATION_cycle[N].md.
  Read PLAN.md §Execution Plan for Qn's method.
  Return YAML per task c schema."
)
```

**d. claim_impossible_classification** (**autoresearch dispatch** — Stage 2 检测 claim_impossible 后立即 dispatch):

```
task(
  description: "claim_impossible classification [Qn]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Apply task d (claim_impossible_classification) per your agent definition.
  Read Qn_REASONING.md + Qn_EXECUTION.md (current execution output).
  Read framing_reasoning.md for [Qn]'s Gap→Question→Claim derivation chain.
  Read PLAN.md §Claims + §Acceptance Tests for [Qn].
  Read research_questions.md for [Qn] definition.
  Return YAML per task d schema (level: L1|L2|L3 + 修正方向)."
)
```

**judgment-worker dispatch 降级模式**: dispatch 失败 (task 超时/空返回) → 重试 max 2 次. 3 次失败 → autoresearch 退回内联判断（降级模式，digest 标 `judgment_worker_unavailable: true`）— autoresearch 直接读文件 + 应用三准则 rubric. 行数预筛 (bash `grep -cv`) 始终可用.
