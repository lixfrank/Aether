---
name: research-verification
description: Structured research verification procedure (domain-agnostic). Establish contract targets, execute verification methods, produce VERIFICATION.md report. Domain-specific checks provided by domain plugin skills. Supports domain_mode parameter (general/physics) and per-question claim filtering.
---

# Structured Verification (General Framework)

## When to Use

After substantive research results for a single question [Qn], before finalizing verification. Used by research-verifier subagent (dispatched by autoresearch directly, NOT through research-worker).

## Parameters

- **domain_mode**: `general` (default) or `physics`. Injected by autoresearch dispatch prompt. When domain_mode=physics, autoresearch dispatches gpd-verifier as a SEPARATE subagent — research-verification does NOT call gpd plugin skills internally. When domain_mode=general, execute standard 6-step Procedure below.
- **question**: Qn identifier (e.g., "Q1"). Only verify claims with `question=Qn` from PLAN.md §Claims.
- **cycle**: execution cycle number for current question.

## Verification Procedure (domain_mode=general)

### Step 1: Establish Contract Targets (per-question claim filtering)

Read PLAN.md contract (claims, deliverables, acceptance_tests, forbidden_proxies). **Per-question claim filtering**: only select claims where `question=Qn` — do NOT verify claims from other questions. If no contract, derive from phase goal in ROADMAP.md.

Also read resolved_conclusions for upstream questions (for dependency usage check in Reasoning Verification):

- Read state.json.resolved_conclusions via bash (jq or Python json module)
- For each upstream dependency Qd, extract conclusion_summary and scope for dependency_usage verification

### Step 2: Classify Check Types

For each contract target (Qn's claims only), classify verification method:

| Check Category              | Method                        | Availability                                                     |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Computational verification  | Domain scripts (if available) | Physics: gpd-verification scripts; other domains: custom scripts |
| Convention/norm consistency | MCP convention tools          | Always available                                                 |
| Literature agreement        | LLM + web search              | Always available (LLM judgment)                                  |
| Logical consistency         | LLM reasoning                 | Always available (LLM judgment)                                  |
| Statistical rigor           | LLM + scripts (if available)  | Depends on domain                                                |

### Step 3: Execute Available Verification

Invoke domain-specific scripts via shell if available. Otherwise use general verification methods: re-derivation, numerical spot-checks, cross-source comparison.

### Step 4: Interpret Results

- Script `pass` → record as independently confirmed
- Script `fail` → investigate root cause, do NOT override with LLM reasoning
- LLM-only judgment → downgrade confidence, flag as "not independently confirmed"

### Step 5: Verify Conventions/Norms

Use research-conventions MCP for convention lock operations (convention_lock_status, convention_check, assert_convention_validate).

### Step 6: Reasoning Verification (Qn_REASONING.md)

For each step in Qn_REASONING.md §Step-by-Step Derivation:

a. **Method fidelity**: Does the step's Method match PLAN.md Execution Plan for Qn?

- If Divergence declared: Is the reason valid? Is impact correctly described?
- If no Divergence but method clearly differs from PLAN.md → flag as undeclared divergence → FAIL

b. **Step completeness**: Does every PLAN.md method step have a corresponding reasoning step?

- Missing steps → flag as skipped step → FAIL

c. **Assumption audit**: For each "Assumption introduced" in reasoning steps:

- Is this assumption declared in framing_reasoning.md §Assumptions Introduced?
- If NOT → flag as undeclared assumption → FAIL (FATAL for verification)

d. **Dependency usage**: For each dependency in Qn_REASONING.md §Dependency Usage:

- Is the usage within the scope of Qd's conclusion_summary? (no overgeneralization — compare against resolved_conclusions scope)
- If fallback assumption used → is it the same fallback from PLAN.md Execution Plan Dependencies (self-contained description)?
- Overgeneralization or mismatch → FAIL

e. **Fallback applicability** (if fallback assumption used):

- Is the fallback assumption applicable to Qn's actual usage scenario?
- If NOT → flag as fallback inapplicable → FAIL (structural failure, must pause and ask user, no retry)
- If no fallback used → N/A

### Step 7: Write Qn_VERIFICATION.md

Write to `notepads/[slug]/execution/Qn_VERIFICATION.md`. Report must include two sections:

## Reasoning Verification

- method_fidelity: [PASS / FAIL — with details per step]
- step_completeness: [PASS / FAIL — list any skipped steps]
- assumption_audit: [PASS / FAIL — list any undeclared assumptions]
- dependency_usage: [PASS / FAIL — list any overgeneralization]
- fallback_applicability: [PASS / FAIL / N/A — list if fallback not applicable to Qn's usage]

## Conclusion Verification

- [standard verification format: computational oracle block, convention consistency, claims assessment]

Computational oracle block (at least one executed code block or script output) must be included.
Convention consistency check results must be included.

### Step 8: Output verification_digest

Output verification_digest as FINAL message. **MUST NOT include a `status` field** — autoresearch judges question outcome from claims + reasoning sub-fields directly.

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: verification
  cycle: [C]
  question: "[Qn]"
  domain_mode: "[general]"
  conclusion_summary: "[key numerical results, scope of validity, caveats]"
  claims_verified: ["[claim 1]"]
  claims_failed: ["[claim N]"]
  reasoning_verification:
    method_fidelity: PASS | FAIL
    step_completeness: PASS | FAIL
    assumption_audit: PASS | FAIL
    dependency_usage: PASS | FAIL
    fallback_applicability: PASS | FAIL | N/A
  output_paths:
    verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  next_phase: null
```

MUST NOT output any other text after this YAML block.

## domain_mode=physics Note

When domain_mode=physics, autoresearch dispatches gpd-verifier and research-verifier as **separate independent subagents**. research-verification does NOT internally call gpd plugin skills for physics mode — autoresearch manages the dispatch and result merging externally. This skill only handles the general verification portion in physics mode (same 8-step Procedure above with domain_mode=general in the dispatch prompt).

## Do Not

- Do not report "independently confirmed" based on LLM-only reasoning
- Do not skip computational oracle — must include actual executed code or script output
- Do not fabricate verification evidence
- Do not include a `status` field in the verification digest
- Do not verify claims from other questions (per-question claim filtering is mandatory)
