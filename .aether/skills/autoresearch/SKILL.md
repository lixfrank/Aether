---
name: autoresearch
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Environment-aware execution — probe host, classify isolation strategy,
  dispatch local-executor (uv venv / local tools / local compilation),
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

**MUST NOT**: Modify PLAN.md claims/deliverables during execution. Call advance_plan (coordinator manages state transitions). Skip environment verification. Execute compilation commands not declared in PLAN.md environment_requirements.

## Procedure — Execution Cycle (sub_phase=execution_cycle)

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase_execution
2. Read `.aether/research/persistence/PLAN.md` — extract contract (claims, acceptance_tests, forbidden_proxies, **environment_requirements**)
3. Read convention_lock_status via research-conventions MCP
4. Read cycle number from dispatch prompt (e.g., "cycle=1", "cycle=2 (retry)")

### Step 2: Environment Probe

Probe the host system for available software:

```bash
uv --version 2>/dev/null || echo "CRITICAL: uv not available — Python tasks cannot be isolated; report as critical gap"
uv python list 2>/dev/null || echo "uv python management: not available"
wolframscript --version 2>/dev/null || echo "wolframscript: not available"
```

Additionally, perform **demand-driven probing** for each `environment_requirements` entry with `isolation_hint` containing `local_compile` — extract tool names from the `software` field and probe:

```bash
[tool_name] --version 2>/dev/null || [tool_name] -V 2>/dev/null || echo "[tool_name]: not available"
```

Probe convention: try `--version` first, fall back to `-V`. Write results to ENVIRONMENT.md `host_system.tools` dict.

If PLAN.md environment requirements mention GPU, perform GPU probe:

```bash
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "nvidia-smi: not available"
system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" || echo "GPU: not detected"
```

Record results for ENVIRONMENT.md host_system section.

### Step 3: Classify Isolation Strategy

For each task derived from PLAN.md contract:

1. Extract software requirements from PLAN.md `environment_requirements` field
2. Apply classification rules:

| Condition                                                                            | Strategy                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Licensed/self-contained software (Mathematica, MATLAB, Stata), host available        | `local`                                                                       |
| Pure Python + wheel-installable packages (numpy, scipy, sympy, pandas), uv available | `uv_venv`                                                                     |
| Pure Python + wheel-installable packages, **uv NOT available**                       | `gap (critical)` — user must install uv first; do NOT fallback to bare python |
| Compilation/build tasks, toolchain available                                         | `local_compile`                                                               |
| GPU workloads (PyTorch/TensorFlow training), local GPU available                     | `local` (with GPU)                                                            |
| Untrusted external repo code                                                         | `local_compile` with `untrusted_source: true` (security constraints apply)    |
| Mixed (Python + compilation)                                                         | Split into separate tasks per strategy                                        |
| Compilation/build tasks, toolchain NOT available                                     | `gap (medium)` — non-critical, tasks marked inconclusive                      |

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
  uv: { available: true|false, version: "..." }
  uv_python: { available: true|false, versions: ["..."] }
  wolframscript: { available: true|false, version: "..." }
  tools: # 动态填充，key 由 PLAN.md environment_requirements 决定
    gcc: { available: true|false, version: "..." } # e.g., gcc, g++, rustc, go, cmake, make, ...
    # ... 任意工具，由需求驱动探测结果决定
  gpu:
    available: true|false
    info: "[e.g., NVIDIA A100 / Apple M2 Pro 16-core GPU / none]"

plan_requirements: [copied from PLAN.md environment_requirements]

isolation_strategy:
  - task: "[task_name]"
    strategy: "[uv_venv|local|local_compile]"
    software: ["..."]
    rationale: "[brief reason]"
    untrusted_source: true|false # only for local_compile
    setup_commands: ["..."] # for uv_venv / local_compile
    run_prefix: "..." # for uv_venv
    build_command: "..." # for local_compile (e.g., "cmake -B build && cmake --build build" / "cargo build" / "go build")
    run_command: "..." # for local_compile (e.g., "./build/simulation")
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

**strategy=local_compile → dispatch local-executor**:

> Security constraints are authoritatively defined in `local-executor.md`. The dispatch prompt references them without repeating.

```
task(
  description: "[task_name] (local_compile)",
  subagent_type: "local-executor",
  prompt: "Execute [task_name] via local compilation.
  Task: [description from PLAN.md]
  Isolation strategy: local_compile
  Build command: [from ENVIRONMENT.md]
  Run command: [from ENVIRONMENT.md]
  Acceptance tests: [relevant tests from PLAN.md]
  Untrusted source: [true|false from ENVIRONMENT.md]
  Observe ALL local_compile security constraints defined in local-executor.md.
  UV-FIRST POLICY: All Python execution MUST use .aether/research/.venv/bin/python or uv run.
  Read ENVIRONMENT.md for toolchain and strategy details.
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
      strategy: "[uv_venv|local|local_compile]"
      executor: "local-executor"
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

- local-executor: For all local tasks (strategy=uv_venv, local, or local_compile)
- gpd-verifier / research-verifier: For verification of results
- FORBIDDEN: Dispatching explore or general subagents for execution or verification work

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail. Never skip environment verification. Never execute compilation commands not declared in PLAN.md environment_requirements.
