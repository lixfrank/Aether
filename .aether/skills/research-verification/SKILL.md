---
name: research-verification
description: Structured research verification procedure (domain-agnostic). Establish contract targets, execute verification methods, produce VERIFICATION.md report. Domain-specific checks provided by domain plugin skills.
---

# Structured Verification (General Framework)

## When to Use
After substantive research results, before finalizing a phase. Used by research-verifier subagent.

## Verification Procedure

### Step 1: Establish Contract Targets
Read PLAN.md contract (claims, deliverables, acceptance_tests, forbidden_proxies). If no contract, derive from phase goal in ROADMAP.md.

### Step 2: Classify Check Types
For each contract target, classify verification method:

| Check Category | Method | Availability |
|----------------|--------|-------------|
| Computational verification | Domain scripts (if available) | Physics: gpd-verification scripts; other domains: custom scripts |
| Convention/norm consistency | MCP convention tools | Always available |
| Literature agreement | LLM + web search | Always available (LLM judgment) |
| Logical consistency | LLM reasoning | Always available (LLM judgment) |
| Statistical rigor | LLM + scripts (if available) | Depends on domain |

### Step 3: Execute Available Verification
Invoke domain-specific scripts via shell if available. Otherwise use general verification methods: re-derivation, numerical spot-checks, cross-source comparison.

### Step 4: Interpret Results
- Script `pass` → record as independently confirmed
- Script `fail` → investigate root cause, do NOT override with LLM reasoning
- LLM-only judgment → downgrade confidence, flag as "not independently confirmed"

### Step 5: Verify Conventions/Norms
Use research-conventions MCP for convention lock operations (convention_lock_status, convention_check, assert_convention_validate).

### Step 6: Write VERIFICATION.md
Report must include:
- YAML frontmatter with contract results, gap status, score, confidence
- Computational oracle block (at least one executed code block or script output)
- Convention consistency check results
- Gaps summary (if any)

## Do Not
- Do not report "independently confirmed" based on LLM-only reasoning
- Do not skip computational oracle — must include actual executed code or script output
- Do not fabricate verification evidence