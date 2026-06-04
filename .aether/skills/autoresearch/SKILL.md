---
name: autoresearch
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Environment-aware execution — probe host, classify isolation strategy,
  dispatch multi-executor (sandbox-executor for Docker, local-executor for uv venv/local),
  collect results, evaluate acceptance tests, output digest.
  Invoked by research-worker via skill tool (unified invocation pattern).
---

# AutoResearch — phase_execution (Environment-Aware)

This skill implements phase_execution of the Path 3 research state machine. It is invoked by the research-worker via the skill tool, receiving cycle number and sub_phase from the dispatch prompt.

## Lifecycle Contract

**Input**: PLAN.md contract + STATE.md + ENVIRONMENT.md (may not exist on cycle 1) + cycle number from dispatch prompt

**Output** (MUST write all of these):

1. `.aether/research/persistence/ENVIRONMENT.md` — Host probe results + isolation strategy decisions
2. `.aether/research/persistence/EXECUTION.md` — Execution results (appended sections from executors)
3. `.aether/research/persistence/STATE.md` — Updated with cycle status

**State transition**: phase_execution → completed (managed by coordinator, NOT by this skill)

**Precondition**: User must have confirmed execution at phase_checkpoint. MUST NOT invoke this skill without user confirmation.

**MUST NOT**: Modify PLAN.md claims/deliverables during execution. Call advance_plan (coordinator manages state transitions). Skip environment verification. Fall back to host execution when Docker isolation is required.

## Procedure — Execution Cycle (sub_phase=execution_cycle)

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase_execution
2. Read `.aether/research/persistence/PLAN.md` — extract contract (claims, acceptance_tests, forbidden_proxies, **environment_requirements**)
3. Read convention_lock_status via research-conventions MCP
4. Read cycle number from dispatch prompt (e.g., "cycle=1", "cycle=2 (retry)")

### Step 2: Environment Probe

Probe the host system for available software:

```bash
python3 --version 2>/dev/null || echo "python: not available"
uv --version 2>/dev/null || echo "CRITICAL: uv not available — Python tasks cannot be isolated; report as critical gap"
docker --version 2>/dev/null || echo "docker: not available"
wolframscript --version 2>/dev/null || echo "wolframscript: not available"
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "gpu: not available"
```

Record results for ENVIRONMENT.md host_system section.

### Step 3: Classify Isolation Strategy

For each task derived from PLAN.md contract:

1. Extract software requirements from PLAN.md `environment_requirements` field
2. Apply classification rules:

| Condition                                                                             | Strategy                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Licensed/self-contained software (Mathematica, MATLAB, Stata), host available         | `local`                                                                       |
| Pure Python + wheel-installable packages (numpy, scipy, sympy, pandas), uv available  | `uv_venv`                                                                     |
| Pure Python + wheel-installable packages, **uv NOT available**                        | `gap (critical)` — user must install uv first; do NOT fallback to bare python |
| C/C++ compilation needed (pybind11 development, Cython C extension), Docker available | `docker`                                                                      |
| GPU workloads (PyTorch/TensorFlow training), Docker + GPU available                   | `docker`                                                                      |
| Untrusted external repo code, Docker available                                        | `docker`                                                                      |
| Mixed (Python + Mathematica)                                                          | Split into separate tasks per strategy                                        |

3. For each task, write `isolation_strategy` entry in ENVIRONMENT.md
4. Identify gaps: critical software that is unavailable on host

### Step 4: Write ENVIRONMENT.md

Write `.aether/research/persistence/ENVIRONMENT.md` with the following YAML structure:

```yaml
# Environment Profile — written by research-worker at execution_cycle start

probe_timestamp: "[ISO 8601]"
cycle: [N]

host_system:
  os: "[e.g., macOS 15.5 (Apple Silicon aarch64)]"
  python: { available: true|false, versions: ["..."], default: "..." }
  docker: { available: true|false, desktop: true|false, version: "..." }
  wolframscript: { available: true|false, version: "..." }
  uv: { available: true|false, version: "..." }
  gpu: { available: true|false }

plan_requirements: [copied from PLAN.md environment_requirements]

isolation_strategy:
  - task: "[task_name]"
    strategy: "[docker|uv_venv|local]"
    software: ["..."]
    rationale: "[brief reason]"
    setup_commands: ["..."] # for uv_venv strategy
    run_prefix: "..." # for uv_venv strategy
    command: "..." # for local strategy (e.g., wolframscript -c)

venv_state:
  path: ".aether/research/.venv"
  installed_packages: [] # populated after local-executor runs
  last_cycle: null # updated after each cycle

gaps: [] # or list of missing critical software
```

HARD CONSTRAINT: ENVIRONMENT.md MUST be written to `.aether/research/persistence/ENVIRONMENT.md` BEFORE dispatching any executor. Executors read this file to determine their execution strategy. If ENVIRONMENT.md is not written, executors will lack isolation strategy information and may default to unsafe host execution.

### Step 5: Gap Check

If any gap has `critical: true`:

- Do NOT dispatch any executor for tasks that depend on the missing software
- Set `status: failed` in digest with `reason: "Critical software unavailable: [gap description]"`
- The coordinator will report to the user and wait for decision

If gaps exist but are non-critical:

- Proceed with available tasks
- Mark affected acceptance tests as `inconclusive` in digest

### Step 6: Dispatch Executors

For each task in isolation_strategy:

**strategy=docker → dispatch sandbox-executor**:

```
task(
  description: "[task_name] (docker)",
  subagent_type: "sandbox-executor",
  prompt: "Execute [task_name] in Docker sandbox.
  Task: [description from PLAN.md]
  Isolation strategy: docker
  Base image: [from ENVIRONMENT.md]
  Commands: [from PLAN.md]
  Acceptance tests: [relevant tests from PLAN.md]
  Convention context: [summary]
  Read ENVIRONMENT.md for strategy details.
  Write results to .aether/research/persistence/EXECUTION.md (append section)."
)
```

**strategy=uv_venv or strategy=local → dispatch local-executor**:

UV-FIRST POLICY: All Python execution MUST use .aether/research/.venv/bin/python or uv run. NEVER use bare python3 or pip install. If venv setup fails, report failure — do NOT fall back to host python.

```
task(
  description: "[task_name] ([strategy])",
  subagent_type: "local-executor",
  prompt: "Execute [task_name] in local environment.
  Task: [description from PLAN.md]
  Isolation strategy: [uv_venv|local]
  Commands: [from PLAN.md]
  Setup commands: [from ENVIRONMENT.md]
  Run prefix: [from ENVIRONMENT.md]
  Acceptance tests: [relevant tests from PLAN.md]
  Convention context: [summary]
  UV-FIRST POLICY: All Python execution MUST use .aether/research/.venv/bin/python or uv run. NEVER use bare python3 or pip install. If venv setup fails, report failure — do NOT fall back to host python.
  Read ENVIRONMENT.md for venv state and strategy details.
  Write results to .aether/research/persistence/EXECUTION.md (append section)."
)
```

**Parallel dispatch**: When multiple tasks have different strategies and no inter-task dependencies, dispatch them in parallel using multiple task tool calls in a single message.

**Sequential dispatch**: When tasks depend on each other's output, dispatch sequentially.

### Step 7: Collect Results

1. Read `.aether/research/persistence/EXECUTION.md` — collect sections written by each executor
2. For each task, check:
   - Did the executor write its section? If missing → that task failed
   - Are all output files present? Check deliverables from PLAN.md
3. Aggregate results across all tasks

### Step 8: Evaluate Acceptance Tests

Evaluate each acceptance_test from PLAN.md against aggregated execution results:

- All passed → status: completed
- Some failed → status: partial, revision_needed: brief description
- Inconclusive → status: inconclusive
- If gap prevented a test → mark as skipped with reason

### Step 9: Update STATE.md

Update `.aether/research/persistence/STATE.md` with cycle status:

- current_phase: phase_execution (cycle N status)
- key decisions: [execution results summary]
- blockers: [any gaps or failures]
- next_action: [verification or retry]

### Step 10: Output PhaseResultDigest

Output execution_cycle_digest as FINAL message:

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: execution_cycle
  cycle: [N from dispatch prompt]
  status: completed | partial | failed | inconclusive
  tests_passed: ["[test 1]", "[test 2]"]
  tests_failed: ["[test N]"]
  tests_inconclusive: ["[test M]"]
  execution_summary: "[brief: what was run, which executors used, key results]"
  revision_needed: null | "[what to revise if tests failed]"
  environment_strategy_used:
    - task: "[task_name]"
      strategy: "[docker|uv_venv|local]"
      executor: "[sandbox-executor|local-executor]"
  gaps_reported: [] | ["[gap description]"]
  output_paths:
    environment: persistence/ENVIRONMENT.md
    execution: persistence/EXECUTION.md
  next_phase: null
```

MUST NOT output any other text after this YAML block.

## Procedure — Verification (sub_phase=verification)

When invoked with sub_phase=verification:

1. Read `.aether/research/persistence/EXECUTION.md` + PLAN.md contract section
2. Read `.aether/research/persistence/STATE.md` — confirm execution cycle completed
3. Dispatch verifier — follow EXPLICIT specification from coordinator dispatch prompt:
   - If prompt specifies gpd-verifier: dispatch gpd-verifier (uses gpd-verification + gpd-domain-check + gpd-conventions)
   - If prompt specifies research-verifier: dispatch research-verifier (uses research-verification)
   - If prompt specifies both (physics domain): dispatch gpd-verifier first, then research-verifier for domain-agnostic checks
   - Use delegation_depth: 0
4. Read `.aether/research/persistence/VERIFICATION.md` produced by verifier
5. Evaluate claims:
   - All verified → status: completed
   - Some failed → status: partial, list failed claims
   - Computational oracle overrides LLM-only judgment → respect oracle results
6. Update STATE.md with verification status
7. Output verification_digest:

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: verification
  cycle: [N from dispatch prompt]
  status: completed | partial | failed
  claims_verified: ["[claim 1]", "[claim 2]"]
  claims_failed: ["[claim N]"]
  claims_inconclusive: ["[claim M]"]
  key_numerical_results: ["[brief result 1]", "[brief result 2]"]
  output_paths:
    verification: persistence/VERIFICATION.md
  next_phase: null
```

MUST NOT output any other text after this YAML block.

## Subagent Dispatch

- sandbox-executor: For Docker-isolated tasks (strategy=docker)
- local-executor: For uv venv and host tool tasks (strategy=uv_venv or local)
- gpd-verifier / research-verifier: For verification of results
- FORBIDDEN: Dispatching explore or general subagents for execution or verification work

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail. Never skip environment verification. Never fall back to host execution when Docker isolation is required.
