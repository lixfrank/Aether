---
name: research-question-framing
description: Frame research questions for systematic investigation. Converts gaps from literature-landscape-scan into structured, falsifiable research questions with verification criteria. Supports PICO (biomedical) and System-Model-Expectation-Deviation (physics) frameworks. Outputs map directly to PLAN.md contracts.
---

# Research Question Framing

Transform research gaps and open problems into structured, falsifiable research questions that can drive systematic investigation and map directly to PLAN.md contracts.

## When to Use

Use this skill when:

- Converting open problems from a literature-landscape-scan gap_list into actionable research questions
- Defining or refining a research question before beginning a project
- Creating PLAN.md contracts from identified research gaps
- Ensuring research questions are falsifiable and verifiable before committing resources

## Framework Selection

Choose a question framework based on domain:

### PICO Framework (Biomedical / Clinical)

- **P**opulation: Who/what is the study about?
- **I**ntervention: What is being tested/applied?
- **C**omparison: What is it compared against?
- **O**utcome: What is the measured result?

Example: "What is the efficacy of CRISPR-Cas9 (I) for treating sickle cell disease (P) compared to standard care (C) in improving patient outcomes (O)?"

### SMED Framework (Physics / Theoretical)

- **System**: What physical system or phenomenon?
- **Model**: What theoretical model or computational approach?
- **Expectation**: What does the model predict?
- **Deviation**: What discrepancies exist between prediction and observation?

Example: "In the Standard Model (M) applied to B-meson decays (S), does the predicted branching ratio (E) deviate from LHCb measurements (D) beyond 3σ?"

### General Framework (Cross-disciplinary)

- **Context**: What is the broader setting?
- **Problem**: What specific issue needs investigation?
- **Approach**: What methodology will be used?
- **Evidence**: What kind of evidence would confirm or refute?

## Procedure

### Step 1: Read Landscape Input

If starting from a literature-landscape-scan:

1. Read the gap_list from `landscape_map.md`
2. For each open problem, extract: description, significance, difficulty, related schools
3. Prioritize gaps by: significance (High first) × feasibility (Easy/Medium first)
4. Select 1-3 gaps to frame as research questions

### Step 2: Apply Question Framework

For each selected gap, apply the appropriate framework:

1. **Identify domain**: Is this physics, biomedical, CS, or cross-disciplinary?
2. **Select framework**: PICO, SMED, or General
3. **Fill in framework elements**:
   - Be specific — avoid vague terms
   - Include quantitative bounds where possible
   - Reference specific systems, models, or populations
4. **Formulate question**: Combine framework elements into a single, focused question

### Step 3: Specify Verifiability Criteria

Every research question MUST include:

1. **Falsification criterion**: What specific result would prove the question's hypothesis wrong?
   - Must be concrete and measurable
   - Example: "If the branching ratio is within 2σ of SM prediction, the anomaly claim is falsified"

2. **Measurement method**: How will evidence be gathered?
   - Computational simulation, experimental data, literature synthesis, theoretical derivation
   - Specify tools/databases: arXiv, alphaxiv, INSPIRE-HEP, specific simulation packages

3. **Evidence kind**: What type of evidence is expected?
   - Numerical result with error bars
   - Qualitative classification
   - Literature consensus or disagreement
   - Theoretical proof or derivation

### Step 4: Map to PLAN.md Contract

Each research question maps directly to PLAN.md contract fields:

| Question element            | PLAN.md field     |
| --------------------------- | ----------------- |
| Framework assertion         | claims            |
| Expected deliverable        | deliverables      |
| Falsification criterion     | acceptance_tests  |
| Disallowed evidence sources | forbidden_proxies |

Write the mapping to `.aether/research/persistence/PLAN.md`.

### Step 5: Check Conventions

Before finalizing questions for physics domains:

1. Call `convention_lock_status` via research-conventions MCP
2. Verify that metric_signature, natural_units, fourier_convention, etc. are consistent with the question's assumptions
3. If conventions are unlocked, set them before proceeding

### Step 6: Write Structured Output

Write output to `output_dir/notepads/<slug>/research_questions.md`:

```markdown
# Research Questions: [Topic]

## Question 1: [Title]

- **Domain**: [Physics / Biomedical / CS / Cross-disciplinary]
- **Framework**: [SMED / PICO / General]
- **System**: [Specific system/phenomenon]
- **Model**: [Specific theoretical/computational approach]
- **Expectation**: [What the model predicts]
- **Deviation**: [Observed or expected discrepancy]
- **Question**: [Full formulated question]
- **Falsification_criterion**: [Specific result that would prove hypothesis wrong]
- **Measurement_method**: [How evidence will be gathered]
- **Evidence_kind**: [Type of expected evidence]
- **Scope_constraints**: [Time range, system bounds, approximation limits]
- **PLAN.md mapping**:
  - claims: [Derived from framework assertion]
  - acceptance_tests: [Derived from falsification criterion]
  - forbidden_proxies: [Sources that must not be used as sole evidence]

## Question 2: [Title]

[Same structure]
```

## Integration with Other Skills

- **literature-landscape-scan**: Input — gap_list provides open problems to convert into questions
- **deep-research**: Use for preliminary evidence gathering on newly framed questions
- **research-verification**: Verify that questions meet falsifiability and verifiability standards
- **autoresearch**: Framed questions drive PLAN.md contracts for the autonomous research loop

## Integrity

Never frame a question that cannot be falsified. Every question must have a concrete falsification criterion and measurable evidence kind.
