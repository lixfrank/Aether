---
name: gpd-errors
owner: research
description: LLM physics error catalog with detection strategies. Use to identify common LLM physics reasoning errors during verification. Includes historical error pattern memory from prior verification cycles.
---

# LLM Physics Error Detection

## When to Use

During verification, after producing research results. Check for known LLM-specific physics error patterns.

## Error Detection Procedure

### Step 0: Load Historical Error Memory

Read `.aether/research/persistence/VERIFICATION.md` for prior verification error findings. Prioritize checking error classes that were previously detected in this project. This provides project-specific error pattern memory without requiring a separate MCP server.

If VERIFICATION.md exists and contains prior error findings, extract:

- Previously detected error class IDs (e.g., E02, E07)
- Previously flagged severity levels
- Context in which errors occurred

Prioritize these classes in Step 3 below.

### Step 1: Identify Domain

Determine which physics domain the current work belongs to (qft, condensed_matter, stat_mech, gr_cosmology, nuclear_particle, quantum_info, amo, astrophysics, mathematical_physics, algebraic_qft, string_field_theory, soft_matter, fluid_plasma, classical_mechanics).

### Step 2: Load Error Catalog

Read `references/error_catalog.json` for the 25 highest-risk error classes. Filter by domain.

### Step 3: Check Each Error Class

For each relevant error class (prioritizing historically-detected classes from Step 0), apply the detection strategy:

| Error Class                        | Detection Strategy                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| E01: CG coefficient sign error     | Verify triangle inequality, m-values sum. Spot-check one CG against Varshalovich tables. |
| E02: Metric signature flip         | Trace metric through every equation. Check sign of contraction g_μν g^μν = d.            |
| E03: Ward identity violation       | Replace ε^μ → k^μ. Check S-matrix cancellation. (Use ward_identity_check.py script)      |
| E04: Wrong eigenvalue count        | Count must match Hilbert space dimension.                                                |
| E05: Gauge parameter in observable | ξ must cancel from physical observables.                                                 |
| ...                                | (See references/error_catalog.json for full 25 classes)                                  |

### Step 4: Record Findings

For each checked error class, record: {class_id, detected: bool, evidence: str, severity: high|medium|low}.

### Step 5: Update Error Memory

Append new error findings to VERIFICATION.md's error section. This creates a growing project-specific error pattern memory that supplements the static 25-class catalog with "what we actually caught" experience.

### Step 6: Flag for Expert Review

For errors that require domain expertise to evaluate, flag as "expert_needed" with specific domain and reason.

## Do Not

- Do not skip high-severity error checks
- Do not skip historically-detected error classes (from Step 0)
- Do not claim "no errors found" without checking at least domain-relevant classes
- Do not fabricate detection results — must be based on actual verification
