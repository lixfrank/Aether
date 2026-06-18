---
name: gpd-domain-check
owner: research
description: Domain-specific physics verification checklists with computation method protocols. Use during verification to apply specialized checks for quantum field theory, condensed matter, statistical mechanics, and 11 other domains.
---

# Domain-Specific Verification

## When to Use

During verification, after identifying the physics domain of the current work.

## Domain Checklist Procedure

### Step 1: Identify Domain

Determine domain from phase goal and research content. Domains: qft, condensed_matter, stat_mech, gr_cosmology, nuclear_particle, quantum_info, amo, astrophysics, mathematical_physics, algebraic_qft, string_field_theory, soft_matter, fluid_plasma, classical_mechanics.

### Step 2: Load Domain Checklist

Read `references/bundles/<domain>.json` for domain-specific priority checks, red flags, and standard benchmarks.

### Step 3: Load Computation Method Protocols

If the research involves specific computation methods, read `references/protocols/<method>.json` for step-by-step guidance:

Available protocols:

- **perturbation_theory.json**: Steps for perturbative calculations, common pitfalls (wrong expansion order, missed counterterms), red flags
- **renormalization_group.json**: RG flow calculation steps, beta-function computation, fixed point analysis
- **dimensional_analysis.json**: Systematic dimension tracking procedure, when to use dimension_map
- **limiting_cases.json**: How to compute and verify limits systematically using sympy.limit()

If a protocol exists for your computation method, follow its steps and check its red_flags list before relying on results.

### Step 4: Execute Domain Checks

For each priority check in the domain checklist:

- If a script exists (dimensional_check.py, conservation_check.py, positivity_check.py, etc.), invoke it via shell
- If no script exists (literature agreement, physical plausibility), apply LLM judgment with explicit caveats

### Step 5: Check Domain Red Flags

Scan artifacts for domain-specific red flags listed in the bundle AND in the protocol file (if loaded).

### Step 6: Verify Standard Benchmarks

For each standard benchmark in the bundle, verify the result matches known values.

### Step 7: Record Coverage

Report which checks were script-verified vs LLM-judged vs deferred. Note which protocols were consulted.

## Do Not

- Do not skip domain red flags
- Do not claim domain coverage without checking at least priority_checks
- Do not use keyword scanning instead of script computation where scripts exist
- Do not skip protocol red_flags when a computation method protocol is available
