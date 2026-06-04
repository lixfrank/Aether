---
name: gpd-conventions
description: Physics convention lock management. Check, set, validate, compare, and diff conventions across research phases. Use before any calculation to ensure consistency.
---

# Convention Management

## When to Use

Before any physics/math calculation, and during verification to check convention consistency.

## Convention Procedure

### Step 0: Load History

Before checking error patterns, read `.aether/research/persistence/VERIFICATION.md` for any prior convention-related findings. Prioritize checking conventions that were flagged in previous verification cycles.

### Step 1: Check Current Lock

Call `convention_lock_status` MCP tool to read current convention state. This now returns statistics: set_fields, unset_fields, completeness_percent, and cross-field warnings (e.g., "Euclidean metric + physics Fourier: sign issues").

### Step 2: Set Conventions (New Project)

If no lock exists or completeness is low, call `subfield_defaults(domain)` MCP tool to get recommended defaults, then call `convention_set(key, value, project_dir)` for each convention. The tool now:

- Normalizes values (strips spaces, lowercases)
- Warns about non-standard values (e.g., "mostly minus" → suggests "mostly-minus")
- Requires `force=True` to override already-set conventions
- Returns `previous_value` and `forced` status

### Step 3: Validate Conventions

Before each derivation/computation:

- Add `<!-- ASSERT_CONVENTION: natural_units=natural, metric_signature=mostly-minus -->` header to your file
- Call `assert_convention_validate(file_path, project_dir, require_assertions=True)` MCP tool
- This now requires at least one ASSERT line (returns `valid: False` if missing)
- Returns `required_assertion_keys` listing which keys must be asserted based on current lock

Call `convention_validate(project_dir)` to check lock completeness and cross-field consistency (e.g., missing critical conventions like metric_signature, fourier_convention, natural_units).

### Step 4: Cross-Phase Convention Diff

When referencing prior phase results, conventions may differ across phases. To check:

1. Read both phases' `state.json` conventions dicts
2. Compare key-by-key: changed, added, removed
3. **Critical severity** for differences in: `metric_signature`, `fourier_convention`, `natural_units` — these require explicit conversion before using prior results
4. **Warning severity** for differences in: `gauge_choice`, `renormalization_scheme`, `coordinate_system`
5. Apply cross_convention_rules from subfield defaults to convert results

Example diff procedure:

```markdown
## Convention Diff: Phase 1 → Phase 2

- metric_signature: mostly-minus → mostly-plus **CRITICAL** — must flip all metric components
- fourier_convention: physics → physics (consistent)
- natural_units: natural → natural (consistent)
- gauge_choice: Lorentz → Coulomb (WARNING) — propagator form changes
```

### Step 5: Convention Defaults Reference

Standard convention sets for common domains:

| Domain           | Units     | Metric       | Fourier | Gauge    | Coord     |
| ---------------- | --------- | ------------ | ------- | -------- | --------- |
| QFT              | natural   | mostly-minus | physics | Lorentz  | Minkowski |
| Condensed matter | natural   | mostly-plus  | physics | Coulomb  | Cartesian |
| Stat mech        | boltzmann | mostly-minus | physics | —        | Cartesian |
| Numerical        | SI        | —            | —       | —        | Cartesian |
| GR               | geometric | mostly-plus  | physics | harmonic | general   |

## Convention Keys (19 Standard Fields)

natural_units, metric_signature, fourier_convention, gauge_choice, renormalization_scheme, coupling_convention, spin_basis, state_normalization, coordinate_system, index_positioning, time_ordering, commutation_convention, levi_civita_sign, generator_normalization, creation_annihilation_order, lagrangian_sign, angular_momentum, spin_statistics, matsubara

## Do Not

- Do not start a derivation without checking convention_lock_status first
- Do not mix conventions across phases without explicit conversion
- Do not change conventions mid-project without convention_set(force=True) and re-verification
- Do not accept files without ASSERT_CONVENTION lines — every derivation artifact must declare its conventions
