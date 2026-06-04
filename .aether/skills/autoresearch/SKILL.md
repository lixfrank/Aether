---
name: autoresearch
description: Autonomous research loop — plan, execute, verify, advance. Supports planning and execution phases; background execution deferred to Layer 5.
---

# AutoResearch

Autonomous research loop for advancing research projects without continuous user supervision. Supports planning and execution phases via sandbox-executor subagent; background execution→verify→log cycles require Layer 5.

## When to Use

Use this skill when:

- A research project needs autonomous advancement through phases
- The user wants the agent to proceed through planning → verification → advancement without step-by-step supervision
- The research ROADMAP.md exists and needs to drive next-phase planning

## Current Scope

**Planning and execution phases**. The autoresearch loop can:

1. Read current state and determine next phase
2. Collect evidence and write PLAN.md contract
3. Dispatch sandbox-executor subagent to execute PLAN.md commands in Docker isolation
4. Dispatch verification subagents
5. Advance state via MCP

**Not yet supported** (deferred to Layer 5):

- Background task management (non-blocking execution)
- Long-running computational loops with automatic edit→run→log cycles

## Loop Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` to determine current phase
2. Read `.aether/research/persistence/ROADMAP.md` to understand project phases and milestones
3. Read `.aether/research/persistence/state.json` via research-state MCP (`get_state`) to confirm machine state
4. If no state exists, initialize: set phase to `planning`, write initial ROADMAP.md

### Step 2: Plan Phase

Based on current ROADMAP phase:

1. **Determine research needs**: What evidence is needed for this phase?
2. **Collect evidence**: Invoke `/deep-research` skill to gather and synthesize evidence
   - For literature: dispatch `research-explorer` subagent for parallel database searches
   - For physics: use alpha-research skill (no-login mode) + alphaxiv overview for paper understanding
3. **Write PLAN.md contract**: Write to `.aether/research/persistence/PLAN.md` with:

   ```markdown
   # Phase N: [Phase Name]

   ## Claims

   - [Claim 1]: [Specific assertion to verify]
   - [Claim 2]: [Specific assertion to verify]

   ## Deliverables

   - [Deliverable 1]: [Expected output]
   - [Deliverable 2]: [Expected output]

   ## Acceptance Tests

   - [Test 1]: [How to verify claim 1]
   - [Test 2]: [How to verify claim 2]

   ## Forbidden Proxies

   - [Proxies that must NOT be used as evidence for specific claims]
   ```

4. **Check conventions**: Call `convention_lock_status` via research-conventions MCP before proceeding
5. **Advance state**: Call `advance_plan` via research-state MCP to move from `planning` to `executing`

### Step 3: Execute Phase

1. **Prepare execution**: Read PLAN.md contract section to extract execution commands, acceptance tests, deliverables, and environment requirements
2. **Dispatch sandbox-executor**: Via task tool, pass:
   - PLAN.md contract reference (commands, acceptance tests, deliverables)
   - Environment requirements (Python version, GPU, dependencies)
   - Convention context (read from research-conventions MCP — sandbox-executor reads but never writes)
3. **Read execution report**: Read `.aether/research/persistence/EXECUTION.md` produced by sandbox-executor
4. **Decision**:
   - All acceptance tests passed → proceed to verification phase
   - Some acceptance tests failed → investigate root cause, may need to revise PLAN.md or execution setup
   - Inconclusive results → may need alternative execution approach or manual intervention

### Step 4: Verify Phase

1. **Dispatch verifier**: Based on domain:
   - General research: delegate to `research-verifier` subagent (uses research-verification skill)
   - Physics domain: delegate to `gpd-verifier` subagent (uses gpd-verification + gpd-domain-check)
2. **Read results**: Read `VERIFICATION.md` produced by verifier
3. **Decision**:
   - All claims verified → advance to next phase
   - Some claims failed → investigate root cause, may need to revise PLAN.md
   - Script pass overrides LLM-only judgment → respect computational oracle results

### Step 5: Advance Phase

1. **Update STATE.md**: Record phase completion, decisions made, blockers encountered
2. **Advance state**: Call `advance_plan` via research-state MCP
3. **Write next PLAN.md**: If project has remaining phases, write new contract for next phase
4. **Report to user**: Summarize phase completion and next steps

## State Machine

```
initial → planning → executing → verifying → completed
                                    ↓
                              (if failed) → revising → planning
```

Current support: `initial → planning → executing → verifying → advance`

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning.
