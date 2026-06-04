---
name: research-question-framing
description: |
  Phase 3 (phase_framing) of the Path 3 research state machine.
  Converts gaps from literature-landscape-scan into structured, falsifiable research questions
  with verification criteria. Supports PICO (biomedical) and SMED (physics) frameworks.
  Outputs map directly to PLAN.md contracts.
---

# Research Question Framing — phase_framing

This skill implements **Phase 3** of the Path 3 research state machine. It converts landscape gaps and analysis findings into structured research questions that become the PLAN.md contract.

## Lifecycle Contract

**Input**: ROADMAP.md + landscape_map.md (gap_list) + research_analysis.md

**Output** (MUST write all of these):

1. `output_dir/persistence/PLAN.md` — Contract with claims, deliverables, acceptance_tests, forbidden_proxies
2. `output_dir/notepads/<slug>/research_questions.md` — Structured question framing
3. `output_dir/persistence/STATE.md` — Updated with phase=phase_framing completed

**State transition**: phase_framing → phase_checkpoint (user confirmation)

**MUST NOT**: Execute experiments (that is phase_execution). Skip to phase_execution without phase_checkpoint.

## Procedure

### Step 1: Read Current State

1. Read `output_dir/persistence/STATE.md` — confirm phase is phase_landscape completed (or phase_analysis if landscape was skipped)
2. Read `output_dir/persistence/ROADMAP.md` — understand project scope
3. Read landscape_map.md (if exists) — extract gap_list
4. Read research_analysis.md — extract initial findings
5. Read state.json via research-state MCP (`get_state`)
6. Check `convention_lock_status` via research-conventions MCP if physics domain

### Step 2: Select Gaps for Framing

1. Read the gap_list from landscape_map.md (or derive gaps from research_analysis.md if landscape was skipped)
2. For each open problem, extract: description, significance, difficulty, related schools
3. Prioritize gaps by: significance (High first) × feasibility (Easy/Medium first)
4. Select 1-3 gaps to frame as research questions

### Step 3: Apply Question Framework

For each selected gap:

1. **Identify domain**: Physics, biomedical, CS, or cross-disciplinary
2. **Select framework**:
   - **SMED (Physics/Theoretical)**: System, Model, Expectation, Deviation
   - **PICO (Biomedical/Clinical)**: Population, Intervention, Comparison, Outcome
   - **General (Cross-disciplinary)**: Context, Problem, Approach, Evidence
3. **Fill in framework elements**:
   - Be specific — avoid vague terms
   - Include quantitative bounds where possible
   - Reference specific systems, models, or populations
4. **Formulate question**: Combine framework elements into a single, focused question

### Step 4: Specify Verifiability Criteria

Every research question MUST include:

1. **Falsification criterion**: What specific result would prove the hypothesis wrong?
   - Must be concrete and measurable

2. **Measurement method**: How will evidence be gathered?
   - Computational simulation, experimental data, literature synthesis, theoretical derivation
   - Specify tools/databases/packages

3. **Evidence kind**: What type of evidence is expected?
   - Numerical result with error bars, qualitative classification, literature consensus, theoretical proof

### Step 5: Write Research Questions Document

Write to `output_dir/notepads/<slug>/research_questions.md`:

```markdown
# Research Questions: [Topic]

## Question 1: [Title]

- **Domain**: [Physics / Biomedical / CS / Cross-disciplinary]
- **Framework**: [SMED / PICO / General]
- **System/Population**: [Specific system/phenomenon]
- **Model/Intervention**: [Specific approach]
- **Expectation/Comparison**: [What the model predicts / what it's compared against]
- **Deviation/Outcome**: [Observed discrepancy / measured result]
- **Question**: [Full formulated question]
- **Falsification_criterion**: [What proves hypothesis wrong]
- **Measurement_method**: [How evidence will be gathered]
- **Evidence_kind**: [Type of expected evidence]
- **Scope_constraints**: [Time range, system bounds, approximation limits]

## Question 2: [Title]

[same structure]
```

### Step 6: Map to PLAN.md Contract

Write to `output_dir/persistence/PLAN.md`:

```markdown
# Research Plan — [Project Name]

## Contract

### Claims

- [Claim 1]: [Specific assertion derived from research question]
- [Claim 2]: [Specific assertion derived from research question]

### Deliverables

- [Deliverable 1]: [Expected output — e.g., numerical results, code implementation, theoretical derivation]
- [Deliverable 2]: [Expected output]

### Acceptance Tests

- [Test 1]: [How to verify claim 1 — derived from falsification criterion]
- [Test 2]: [How to verify claim 2]

### Forbidden Proxies

- [Proxy 1]: [What shortcuts MUST NOT be used as evidence — e.g., LLM-only reasoning for numerical claims]
- [Proxy 2]: [What sources MUST NOT be sole evidence]

### Execution Plan

- Method: [Python/C++/Mathematica/etc.]
- Tools: [Specific software packages — e.g., amflow, dct_nis_python]
- Environment: [Docker/local/remote]
- Verification approach: [gpd-verifier / research-verifier]
```

### Step 7: Check Conventions

Before finalizing for physics domains:

1. Call `convention_lock_status` via research-conventions MCP
2. Verify metric_signature, natural_units, fourier_convention consistency
3. If conventions are unlocked, set them before proceeding

### Step 8: Update State

1. Update `output_dir/persistence/STATE.md`:
   - phase: phase_framing completed
   - key decisions: [research questions chosen, framework selected]
   - blockers: [any]
   - next_action: enter phase_checkpoint (present plan to user for confirmation)
2. Call `advance_plan` via research-state MCP
3. Output a PhaseResultDigest as your final message (see Step 9). The coordinator will enter phase_checkpoint based on the digest.

### Step 9: Output PhaseResultDigest

Output a YAML code block as your FINAL message with this schema:

```yaml
phase_result_digest:
  phase: phase_framing
  sub_phase: null
  cycle: null
  status: completed
  research_questions:
    - question: "[full formulated question text]"
      framework: [SMED | PICO | General]
      falsification_criterion: "[1 sentence]"
  claims:
    - claim: "[1 sentence assertion]"
      acceptance_test: "[1 sentence verification method]"
  forbidden_proxies:
    - "[proxy 1 description]"
    - "[proxy 2 description]"
  execution_method: "[Python | C++ | Mathematica | theoretical derivation]"
  verification_approach: [gpd-verifier | research-verifier]
  output_paths:
    plan: persistence/PLAN.md
    research_questions: notepads/[slug]/research_questions.md
  next_phase: phase_checkpoint
```

MUST NOT output any other text after this YAML block.

## Integrity

Never frame a question that cannot be falsified. Every question must have a concrete falsification criterion and measurable evidence kind.
