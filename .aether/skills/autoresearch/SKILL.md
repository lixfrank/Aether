---
name: autoresearch
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Autonomous research loop — plan, execute, verify, advance.
  Invoked by the research agent ONLY after phase_checkpoint (user confirmed execution).
  Executes PLAN.md via sandbox-executor, verifies via gpd-verifier/research-verifier,
  writes VERIFICATION.md. Background execution loops deferred to Layer 5.
---

# AutoResearch — phase_execution

This skill implements **Phase 5** of the Path 3 research state machine. It is invoked by the research agent ONLY after the user has confirmed execution at phase_checkpoint.

## Lifecycle Contract

**Input**: PLAN.md (contract with claims, deliverables, acceptance_tests) + ROADMAP.md + user confirmation from phase_checkpoint

**Output** (MUST write all of these):

1. `output_dir/persistence/EXECUTION.md` — Execution results (written by sandbox-executor)
2. `output_dir/persistence/VERIFICATION.md` — Verification report (appended, never overwritten)
3. `output_dir/persistence/STATE.md` — Updated with phase=phase_execution completed → completed

**State transition**: phase_execution → completed

**Precondition**: User must have confirmed execution at phase_checkpoint. MUST NOT invoke this skill without user confirmation.

**MUST NOT**: Modify PLAN.md claims/deliverables during execution. If acceptance tests fail, report to user, do not silently adjust criteria.

## Procedure

### Step 1: Read Current State

1. Read `output_dir/persistence/STATE.md` — confirm phase_checkpoint was passed with user_decision=confirmed
2. Read `output_dir/persistence/PLAN.md` — extract contract (claims, deliverables, acceptance_tests, forbidden_proxies)
3. Read `output_dir/persistence/ROADMAP.md` — understand overall project context
4. Read state.json via research-state MCP (`get_state`)
5. Check `convention_lock_status` via research-conventions MCP

### Step 2: Prepare Execution

1. Read PLAN.md contract section to extract:
   - Execution commands and scripts to run
   - Acceptance tests to verify
   - Deliverables expected
   - Environment requirements (Python version, dependencies, Docker setup)
   - Convention context (from research-conventions MCP — sandbox-executor reads but never writes)
2. Identify local resources needed:
   - Code files referenced in PLAN.md (e.g., dct_nis_python, amflow)
   - Data files needed for computation
   - Copy any required project files into output_dir for sandbox access

### Step 3: Dispatch sandbox-executor

Via task tool, pass:

- PLAN.md contract reference (commands, acceptance tests, deliverables)
- Environment requirements (Python version, GPU, dependencies)
- Convention context
- File paths for execution scripts and data

### Step 4: Read Execution Report

1. Read `output_dir/persistence/EXECUTION.md` produced by sandbox-executor
2. Decision:
   - All acceptance tests passed → proceed to verification
   - Some acceptance tests failed → investigate root cause, may need to revise execution setup
   - Inconclusive results → may need alternative approach

### Step 5: Verify Results

1. **Dispatch verifier** based on domain:
   - General research: delegate to `research-verifier` subagent (uses research-verification skill)
   - Physics domain: delegate to `gpd-verifier` subagent (uses gpd-verification + gpd-domain-check + gpd-conventions)
2. Pass PLAN.md contract and EXECUTION.md results to verifier
3. Read `VERIFICATION.md` produced by verifier
4. Decision:
   - All claims verified → proceed to completion
   - Some claims failed → investigate, may need revised execution
   - Computational oracle overrides LLM-only judgment → respect oracle results

### Step 6: Update State → Completed

1. Update `output_dir/persistence/STATE.md`:
   - phase: completed
   - key decisions: [final verification results]
   - blockers: [any remaining issues]
   - next_action: present results to user
2. Call `advance_plan` via research-state MCP (set phase to completed)
3. Present final results summary to user

## State Machine (Internal to this skill)

```
reading_state → preparing_execution → dispatching_executor → reading_report →
  [all passed] → dispatching_verifier → reading_verification → completed
  [some failed] → investigating → [may revise] → re-dispatching_executor
```

## Subagent Dispatch

- sandbox-executor: For Docker-isolated execution of PLAN.md commands
- gpd-verifier / research-verifier: For verification of results
- FORBIDDEN: Dispatching explore or general subagents for execution or verification work

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail.
