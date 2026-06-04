---
name: gpd-verification
description: Physics verification with deterministic computational scripts (SymPy). Establish contract targets, execute computational checks, produce VERIFICATION.md. Supplements research-verification with domain-specific physics computation.
---

# Physics Verification (Deterministic Computation Layer)

## When to Use
During verification of physics research results. Used by gpd-verifier subagent (research-verification provides the general framework; this skill adds physics-specific computation).

## Verification Computation Procedure

### Step 1: Load Verification Check Registry
Read `references/check_registry.json` for the 24 verification check definitions (14 universal + 10 contract-aware). Each entry specifies: id, key, name, tier, catches, evidence_kind, and which script implements it.

### Step 2: Classify Check Types
For each check from the registry, determine execution method:

| Check | Evidence Kind | Script | What it computes |
|-------|---------------|--------|-------------------|
| 5.1 dimensional_analysis | computational | `scripts/dimensional_check.py` | SymPy dimension tracking from raw expressions |
| 5.2 numerical_spot_check | computational | `scripts/spot_check.py` | Numerical substitution verification |
| 5.3 limiting_cases | hybrid | `scripts/limiting_case_check.py` | `sympy.limit()` actual limit computation |
| 5.4 conservation_laws | computational | `scripts/conservation_check.py` | SymPy conservation law verification |
| 5.5 numerical_convergence | computational | `scripts/convergence_check.py` | Convergence threshold testing |
| 5.6 literature_cross_check | hybrid | LLM + web search | No script (cross-source comparison) |
| 5.7 order_of_magnitude | computational | `scripts/spot_check.py` | Order-of-magnitude numerical check |
| 5.8 physical_plausibility | hybrid | LLM judgment | No script (domain-specific reasoning) |
| 5.9 ward_identities | computational | `scripts/ward_identity_check.py` | `sympy.simplify(q_μ·M^μ)` Ward identity check |
| 5.10 unitarity_bounds | computational | LLM + literature | Domain-specific bound computation |
| 5.11 causality_constraints | hybrid | LLM judgment | No script |
| 5.12 positivity_constraints | computational | `scripts/positivity_check.py` | Eigenvalue sign verification |
| 5.13 kramers_kronig | computational | `scripts/kramers_kronig_check.py` | Analytic continuation consistency |
| 5.14 statistical_validation | computational | `scripts/convergence_check.py` | Autocorrelation and error estimation |

Checks marked `computational` MUST use scripts when available. Checks marked `hybrid` may use LLM judgment but MUST also attempt script verification when available.

### Step 3: Execute Computational Checks
Invoke scripts via shell using uv run + PEP 723. Each script accepts JSON input and returns JSON output.

Input format: `{"expression": "...", "context": {...}, "conventions": {...}}`
Output format: `{"status": "pass|fail|warning", "computation": "...", "evidence": "...", "confidence": 0.0-1.0}`

Execute: `uv run scripts/<check_name>.py '<json_input>'`
  or: `echo '<json_input>' | uv run scripts/<check_name>.py` (stdin fallback for large JSON)

### Step 4: Execute Contract-Aware Checks (5.15-5.24)
For contract checks, read `references/contract_checks.json` for field schemas and binding targets.
1. Read PLAN.md contract section to extract claims, deliverables, acceptance_tests
2. Map each contract target to the appropriate contract check key
3. For each check, construct the required `observed` fields from research artifacts
4. Compare observed values against contract specifications
5. Record verdict: pass/fail/warning/insufficient_evidence

| Contract Check | Binding Targets | What it verifies |
|----------------|-----------------|-------------------|
| 5.15 limit_recovery | observable, claim, deliverable, acceptance_test | Correct asymptotic/limit behavior |
| 5.16 benchmark_reproduction | claim, deliverable, acceptance_test, reference | Matches published benchmarks |
| 5.17 direct_proxy_consistency | claim, deliverable, acceptance_test, forbidden_proxy | Direct vs proxy validation |
| 5.18 fit_family_mismatch | observable, claim, deliverable, acceptance_test | Correct extrapolation family |
| 5.19 estimator_family_mismatch | observable, claim, deliverable, acceptance_test | Unbiased estimator |
| 5.20 proof_hypothesis_coverage | observable, claim, deliverable, acceptance_test | All hypotheses covered |
| 5.21 proof_parameter_coverage | observable, claim, deliverable, acceptance_test | All parameters covered |
| 5.22 proof_quantifier_domain | observable, claim, deliverable, acceptance_test | Quantifier scope matched |
| 5.23 claim_to_proof_alignment | observable, claim, deliverable, acceptance_test | Proof matches claim |
| 5.24 counterexample_search | observable, claim, deliverable, acceptance_test | No counterexample found |

### Step 5: Interpret Results
- Script `pass` → record as **independently confirmed**
- Script `fail` → investigate root cause, do NOT override with LLM reasoning
- Script `warning` → flag for manual review
- Script `insufficient_evidence` → downgrade confidence, note script unable to parse/compute
- LLM-only judgment → downgrade confidence, flag as "not independently confirmed"

### Step 6: Compose Oracle Block
VERIFICATION.md must contain at least one **computational oracle block**: actual executed script output (not just "I ran the script" — paste the JSON output).

## Do Not
- Do not report "independently confirmed" based on LLM-only reasoning
- Do not skip computational oracle — must include actual script output
- Do not use keyword scanning instead of script computation where scripts exist
- Do not fabricate verification evidence
- Do not override a script `fail` verdict with LLM reasoning