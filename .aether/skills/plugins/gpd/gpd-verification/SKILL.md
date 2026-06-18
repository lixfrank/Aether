---
name: gpd-verification
owner: research
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

| Check                       | Evidence Kind | Script                            | What it computes                                    |
| --------------------------- | ------------- | --------------------------------- | --------------------------------------------------- |
| 5.1 dimensional_analysis    | computational | `scripts/dimensional_check.py`    | SymPy dimension tracking from raw expressions       |
| 5.2 numerical_spot_check    | computational | `scripts/spot_check.py`           | Numerical substitution verification                 |
| 5.3 limiting_cases          | hybrid        | `scripts/limiting_case_check.py`  | `sympy.limit()` actual limit computation            |
| 5.4 conservation_laws       | computational | `scripts/conservation_check.py`   | SymPy conservation law simplification verification  |
| 5.5 numerical_convergence   | computational | `scripts/convergence_check.py`    | Convergence threshold testing                       |
| 5.6 literature_cross_check  | hybrid        | LLM + web search                  | No script (cross-source comparison)                 |
| 5.7 order_of_magnitude      | computational | `scripts/spot_check.py`           | Order-of-magnitude numerical check                  |
| 5.8 physical_plausibility   | hybrid        | LLM judgment                      | No script (domain-specific reasoning)               |
| 5.9 ward_identities         | computational | `scripts/ward_identity_check.py`  | `sympy.simplify(q_μ·M^μ)` Ward identity check       |
| 5.10 unitarity_bounds       | computational | LLM + literature                  | Domain-specific bound computation                   |
| 5.11 causality_constraints  | hybrid        | LLM judgment                      | No script                                           |
| 5.12 positivity_constraints | computational | `scripts/positivity_check.py`     | Eigenvalue sign verification for matrices           |
| 5.13 kramers_kronig         | computational | `scripts/kramers_kronig_check.py` | Analytic continuation consistency (symmetry + sign) |
| 5.14 statistical_validation | computational | `scripts/convergence_check.py`    | Autocorrelation and error estimation                |

Checks marked `computational` MUST use scripts when available. Checks marked `hybrid` may use LLM judgment but MUST also attempt script verification when available.

**Dimensional analysis guidance**: When using dimensional_check.py (5.1), the agent MUST construct a `dimension_map` from research context mapping each symbol to its physical dimension. Without a dimension_map, the script returns `status: warning, confidence: 0.3` — it cannot automatically infer dimensions. The dimension_map is domain knowledge the agent provides, not something the script guesses. Example: `{"m": "E", "L": "E^-1", "t": "E^-1"}` in natural units.

**Conservation check guidance**: When using conservation_check.py (5.4), provide `conserved_quantity` (the expression that should simplify to zero/constant) and `expected_value` (typically "0"). Substitutions can simplify before checking.

**Positivity check guidance**: When using positivity_check.py (5.12), provide `matrix` as a list-of-lists or SymPy Matrix expression, and `positivity_type` ("non-negative", "positive", or "non-positive").

**Kramers-Kronig guidance**: When using kramers_kronig_check.py (5.13), provide `real_part` and/or `imaginary_part` expressions, and `check_type` ("consistency" for sign checks, "symmetry" for even/odd verification).

### Step 3: Execute Computational Checks

Invoke scripts via shell using uv run + PEP 723. Each script accepts JSON input and returns JSON output.

Input format: `{"expression": "...", "context": {...}, "conventions": {...}}`
Output format: `{"status": "pass|fail|warning", "computation": "...", "evidence": "...", "confidence": 0.0-1.0, "schema_version": 1}`

Execute: `uv run scripts/<check_name>.py '<json_input>'`
or: `echo '<json_input>' | uv run scripts/<check_name>.py` (stdin fallback for large JSON)

### Step 4: Execute Contract-Aware Checks (5.15-5.24)

For contract checks, read `references/contract_checks.json` for field schemas, binding targets, required_fields, and request_templates.

1. Read PLAN.md contract section to extract claims, deliverables, acceptance_tests
2. Map each contract target to the appropriate contract check key
3. For each check, construct the required `observed` fields from research artifacts — consult `required_fields` and `request_template` in contract_checks.json
4. Compare observed values against contract specifications
5. Record verdict: pass/fail/warning/insufficient_evidence

### Step 5: Interpret Results

- Script `pass` → record as **independently confirmed**
- Script `fail` → investigate root cause, do NOT override with LLM reasoning
- Script `warning` → flag for manual review
- Script `insufficient_evidence` → downgrade confidence, note script unable to parse/compute
- LLM-only judgment → downgrade confidence, flag as "not independently confirmed"

### Step 6: Compose Oracle Block

VERIFICATION.md must contain at least one **computational oracle block**: actual executed script output (not just "I ran the script" — paste the JSON output). All script outputs now include `schema_version: 1` for format stability.

### Step 7: Record Error Findings for Memory

Append error findings to VERIFICATION.md error section. This enables future verification cycles to prioritize checking previously-detected error patterns (per gpd-errors skill Step 0).

## Do Not

- Do not report "independently confirmed" based on LLM-only reasoning
- Do not skip computational oracle — must include actual script output
- Do not use keyword scanning instead of script computation where scripts exist
- Do not fabricate verification evidence
- Do not override a script `fail` verdict with LLM reasoning
- Do not run dimensional_check.py without a dimension_map (it will return warning with 0.3 confidence)
