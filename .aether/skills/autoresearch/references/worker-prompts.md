# Worker Prompt Templates & Output Structures

This reference contains prompt templates for subagent dispatch and output file structure templates. Autoresearch reads these when constructing dispatch prompts in Step 4d (local-executor) and Step 4g (verification subagents).

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
   Intention, Method, Divergence, Assumption introduced) → Dependency Usage.
   Every divergence from PLAN.md method MUST be declared.
   Every new assumption NOT in framing_reasoning.md MUST be flagged as undeclared.

2. Qn_EXECUTION.md — Execution results (numerical, code, output).
   Do NOT include a Dependencies section. All dependency details belong in
   Qn_REASONING.md §Dependency Usage only.

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
| Pure Python, uv NOT available                          | `gap (critical)`                              |
| Compilation/build tasks, toolchain available           | `local_compile`                               |
| GPU workloads, local GPU available                     | `local` (with GPU)                            |
| Untrusted external repo code                           | `local_compile` with `untrusted_source: true` |
| Mixed (Python + compilation)                           | Split into separate tasks per strategy        |
| Compilation, toolchain NOT available                   | `gap (medium)`                                |

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

**Gap check**: If critical gap exists → do NOT dispatch executor for affected tasks → mark in digest → coordinator reports to user.

**Incremental ENVIRONMENT.md updates**: Between questions, if current question needs additional software, autoresearch performs bash probe and incrementally writes to ENVIRONMENT.md.
