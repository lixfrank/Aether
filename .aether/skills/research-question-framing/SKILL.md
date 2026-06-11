---
name: research-question-framing
description: |
  Phase 6 (phase_framing) of the Path 3 research state machine.
  Converts gaps from literature-landscape-scan into structured, falsifiable research questions
  with verification criteria, with explicit reasoning chains from knowledge base to questions.
  Supports PICO (biomedical) and SMED (physics) frameworks.
  Outputs map directly to PLAN.md contracts.
  If audit phases found unresolved gaps, these are injected as constraints in framing.
  Produces framing_reasoning.md as the authoritative source for dependency data.
---

# Research Question Framing — phase_framing

This skill implements **Phase 6** of the Path 3 research state machine. It converts landscape gaps and analysis findings into structured research questions that become the PLAN.md contract, with explicit reasoning chains documenting the derivation from knowledge base to each question.

## Lifecycle Contract

**Input**: ROADMAP.md + landscape_map.md (gap_list) + research_analysis.md + AUDIT_1/2 resolution status

**Output** (MUST write all of these):

1. `.aether/research/persistence/PLAN.md` — Contract with claims, deliverables, acceptance_tests, forbidden_proxies, **environment_requirements**. Claims include derived_from/tractability/question fields. Execution Plan is multi-Wave structure.
2. `.aether/research/notepads/<slug>/research_questions.md` — Structured question framing with Depends_on/Required_by reference-type fields
3. `.aether/research/notepads/<slug>/framing_reasoning.md` — Reasoning chain from knowledge base to questions (authoritative source for dependency data)
4. `.aether/research/persistence/STATE.md` — Updated with phase=phase_framing completed

**Downstream note**: The `environment_requirements` field in PLAN.md is NOT just informational — it is consumed by the `/autoresearch` skill during execution_cycle to probe the host system and write `.aether/research/persistence/ENVIRONMENT.md`. ENVIRONMENT.md contains: (1) host_system probe results (what software is actually available), (2) plan_requirements (what was declared), (3) isolation_strategy (per-task decisions: uv_venv/local/local_compile), (4) gaps (missing critical software). The coordinator uses gaps to inform the user about unavailable software. **You MUST write environment_requirements with enough specificity for the execution phase to classify each requirement into an isolation strategy (uv_venv/local/local_compile).**

**State transition**: phase_framing → phase_audit_3 (reasoning chain audit)

**MUST NOT**: Execute experiments (that is phase_execution). Skip to phase_execution without phase_audit_3 and phase_debate.

**权威源规则**: framing_reasoning.md is the authoritative source for all dependency data (Dependency Graph, Execution Order, Inter-Question Dependencies) during framing and audit_3 phases. research_questions.md contains only Depends_on/Required_by quick reference summaries. PLAN.md Execution Plan Dependencies fields are **self-contained** — each dependency includes: dependency description, critical=true/false with reasoning, fallback path (if non-critical). No reference-only pointers to framing_reasoning.md without the full description. All dependency modifications are done first in framing_reasoning.md, then mechanically synced to research_questions.md and PLAN.md. After debate-repair modifies question structure, **PLAN.md Execution Plan Dependencies becomes the authoritative source** for dependency data — autoresearch reads PLAN.md as primary source, framing_reasoning.md only as fallback reference (when PLAN.md Dependencies info is incomplete after debate repair).

## Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase is phase_audit_2 completed (or phase_audit_1 completed if landscape was skipped)
2. Read `.aether/research/persistence/ROADMAP.md` — understand project scope; record commit SHA (via `git rev-parse HEAD`)
3. Read landscape_map.md (if exists) — extract gap_list; record commit SHA. If landscape was skipped, note landscape_map.md as "skipped (no file)"
4. Read research_analysis.md — extract initial findings; record commit SHA
5. Read STATE.md Blockers section — check for unresolved_gaps from audit phases (if audit_repair loop reached max 3 repairs)
6. Read state.json via research-state MCP (`get_state`)
7. Check AUDIT_1/2 resolution status:
   - Read latest audit_1 report from persistence/audits/ — extract resolution status (all resolved / N unresolved)
   - Read latest audit_2 report from persistence/audits/ (if exists) — extract resolution status
8. Check `convention_lock_status` via research-conventions MCP if physics domain

### Step 2: Select Gaps & Construct Significance Argument

> **Significance Argument and Priority Justification are two separate outputs**: Significance Argument is per-gap research value justification (internal reasoning within a single gap). Priority Justification is cross-gap selection decision documentation (comparison and tradeoff rationale among multiple gaps). Both are produced in this Step but at different logical levels.

1. Read the gap_list from landscape_map.md (or derive gaps from research_analysis.md if landscape was skipped)
2. Read unresolved_gaps from STATE.md Blockers (if present from audit phases) — these are hard constraints:
   - "以下知识基础存在未验证的声明，framing 时必须为这些声明设计独立的验证路径"
   - Each unresolved_gap must have a corresponding verification path in PLAN.md
3. For each candidate gap, construct **Significance Argument** (cite relevant passages from ROADMAP.md / landscape_map.md, justify why this gap's research value matters):
   - Include inline citations: `> 引用: ROADMAP.md §[section] "[relevant excerpt]"` and/or `> 引用: landscape_map.md §[section] "[relevant excerpt]"`
4. Evaluate significance × tractability estimate → select 1-3 gaps
5. Write **Priority Justification** to framing_reasoning.md — cross-gap selection decision documentation with significance × tractability comparison matrix:

| Gap   | Significance      | Tractability                 | Reasoning    |
| ----- | ----------------- | ---------------------------- | ------------ |
| Gap 1 | [High/Medium/Low] | [HIGH/MEDIUM/LOW confidence] | [1 sentence] |
| Gap 2 | [same]            | [same]                       | [same]       |

6. Write Significance Argument sections to framing_reasoning.md §Gap → Question Mapping (per-gap reasoning)

### Step 3: Survey Solution Paths & Construct Tractability Argument

For each selected gap:

1. **Survey solution paths**: Extract all possible solution paths from landscape_map.md §Schools of Thought (if landscape skipped, from ROADMAP.md §Analysis). For each path:
   - Path label (Path A: School [name]'s method [method], etc.)
   - Citation: `> 引用: landscape_map.md §Schools of Thought "[relevant excerpt]"` (or ROADMAP.md §Analysis if landscape skipped)
   - Citation for key paper: `> 引用: [key paper arXiv ID / DOI] "[relevant excerpt]"`
   - Evidence strength: STRONG / MODERATE / WEAK
   - Partial success evidence: yes/no + specific evidence

   > **Data source rule**: When landscape_map.md exists, Solution Paths Survey's primary source is landscape_map.md §Schools of Thought. When landscape is skipped (landscape_map.md doesn't exist), extract method/school information from ROADMAP.md §Analysis as substitute source, and annotate Source Knowledge Base with landscape_map.md as skipped.

2. **Select most feasible path** → construct **Tractability Argument** (why this path has credibility, cite specific literature evidence):
   - Selected path: [Path A/B/C]
   - Selection reason: [partial success evidence + available method + computational feasibility + resource constraint match]
   - Tractability confidence: HIGH / MEDIUM / LOW — following §Tractability Confidence Classification rules
   - Confidence justification: [specific evidence supporting this confidence level]
   - LOW type: foundation_insufficient / frontier_problem / null (null when not LOW)
     - foundation_insufficient: default assumption — all path evidence ≤ WEAK or no available path or critical resource gap
     - frontier_problem: after landscape supplement still LOW — foundation_insufficient falsification failed, method-level innovation truly needed
     - null: not LOW confidence
   - LOW handling status: pending_supplement / supplement_in_progress / supplement_failed → frontier / resolved / null
     - pending_supplement: LOW discovered, waiting for coordinator decision on landscape supplement
     - supplement_in_progress: landscape supplement ongoing
     - supplement_failed → frontier: supplement still LOW, upgraded to frontier_problem, needs PoC question
     - resolved: supplement upgraded confidence, no longer LOW
     - null: not LOW confidence
   - PoC question(s): if frontier_problem, list PoC questions / null

3. **Tractability Confidence Classification** — confidence is a judgment of evidence conditions, not a subjective estimate. Minimum necessary conditions:

   **HIGH** — must satisfy ALL simultaneously:
   1. ≥1 STRONG evidence path (peer-reviewed paper successfully applying method to same-class problem, or original code/data reproducible)
   2. Partial success evidence exists (same-class problem's partial sub-goal has been solved)
   3. No critical resource gap (all critical resources in PLAN.md Environment Requirements available)

   **MEDIUM** — must satisfy at least 1:
   1. ≥1 MODERATE evidence path (peer-reviewed paper proposes method but not verified on same-class problem, or method has success cases on related but different-class problems)
   2. STRONG evidence path but no partial success (method has strong theoretical basis but no one has actually done it)
   3. Fallback path exists and fallback has at least MODERATE evidence

   **LOW** — triggered by ANY of these:
   1. All path evidence strength = WEAK (only conceptual/review discussion, no concrete method or data)
   2. No available path (no relevant method found in landscape/ROADMAP)
   3. Critical resource gap (critical resource unavailable and no alternative)

4. **List Assumptions Introduced** (new assumptions not covered by ROADMAP/landscape, with source and verifiability):
   - Assumption 1: [description]
     - Source: [推理需要 / 方法前提 / 简化假设]
     - Verifiability: [can verify in execution / cannot verify → label as limit]
     - ROADMAP/landscape coverage: [yes / no — if no, label as "unverified assumption"]

5. Write to framing_reasoning.md §Gap → Question Mapping: Solution Paths Survey + Tractability Argument + Assumptions Introduced sections

### Step 4: Derive Question from Tractability Argument

For each selected gap, **derive question from tractability argument** — NOT independently generate:

1. The selected path defines the method/assumption to verify; the question is the solvability test of that method/assumption
2. Select question framework (SMED/PICO/General) — framework choice must be consistent with selected path's nature (theory path → SMED, experimental path → PICO, cross-disciplinary → General)
3. Fill in framework elements with **explicit 溯源** mapping:
   - System/Population ← selected path's research object (溯源: framing_reasoning.md §Solution Paths Survey Path [N]'s research object)
   - Model/Intervention ← selected path's method (溯源: same)
   - Expectation/Comparison ← selected path's expected conclusion vs existing results (溯源: tractability argument's confidence justification)
   - Deviation/Outcome ← selected path's deviation to test (溯源: significance argument's gap evidence)
4. Write to framing_reasoning.md §Derived Question section (including framework element 溯源 mapping)

### Step 5: Derive Falsification Criterion from Tractability Argument

For each question, **derive falsification criterion from tractability argument** — NOT independently design:

1. Falsification criterion from tractability confidence justification negation — confidence justification lists supporting evidence; falsification criterion is "the negation situation of these supporting evidence"
2. Measurement method from selected path's available methods
3. Evidence kind from selected path's evidence types
4. Write to framing_reasoning.md §Derived Question's Falsification section (including criterion 溯源 mapping):
   - Falsification 溯源: ← framing_reasoning.md §Tractability Argument confidence justification: [supporting evidence → negation situation]

### Step 6: Construct Inter-Question Dependencies

1. For each Assumptions Introduced, annotate source (knowledge base vs other question's expected conclusion)
2. Construct dependency graph + execution order (topological sort)
3. Annotate critical dependency (whether dependent question becomes completely unexecutable if prerequisite question fails; false means fallback path exists) + fallback path
4. Write to framing_reasoning.md §Inter-Question Dependencies + §Dependency Graph + §Execution Order

For each question's Inter-Question Dependencies:

- Depends on: [Q1 / Q2 / none]
  - Dependency description: [Q1's conclusion [claim X] is prerequisite parameter for this question's method [method Y]]
  - Critical dependency: [true / false]
  - Fallback path: [if critical=false: "if Q1 conclusion doesn't hold, can use alternative assumption [Z]"; if critical=true: no fallback]
- Required by: [Q3 / none]

Dependency Graph (from all questions' Inter-Question Dependencies):

```
Q1 ──→ Q2 (Q2's assumption depends on Q1's conclusion [claim X])
Q1 ──→ Q3 (Q3's method parameter depends on Q1's provided value)
Q3 (independent, no prerequisite dependency)
```

Execution Order (topological sort from Dependency Graph):

| Wave | Questions | Executable reason                                                                 |
| ---- | --------- | --------------------------------------------------------------------------------- |
| 1    | Q1, Q3    | No prerequisite dependency (Q1's assumptions from knowledge base, Q3 independent) |
| 2    | Q2        | Depends on Q1 (execute after Q1 completes)                                        |

> Note: Within the same Wave, questions execute serially, sorted by tractability confidence from high to low (HIGH > MEDIUM > LOW). Same confidence level sorted by Execution Order table ordering.

### Step 7: Write Research Questions & Framing Reasoning

Write two files:

1. `.aether/research/notepads/<slug>/research_questions.md` — each question's structured definition + Depends_on/Required_by reference-type fields:

```markdown
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
- **Depends_on**: See framing_reasoning.md §Gap [N] → Inter-Question Dependencies
  - Quick reference: [Q1 (critical) / none]
- **Required_by**: See framing_reasoning.md §Gap [N] → Inter-Question Dependencies
  - Quick reference: [Q3 / none]
```

2. `.aether/research/notepads/<slug>/framing_reasoning.md` — complete reasoning chain:

```markdown
# Framing Reasoning Chain

## Source Knowledge Base

- ROADMAP.md: [commit SHA — framing worker's latest commit SHA at execution time]
- landscape_map.md: [commit SHA / skipped (no file)]
- research_analysis.md: [commit SHA]
- AUDIT_1.md resolution status: [all resolved / N unresolved]
- AUDIT_2.md resolution status: [all resolved / N unresolved]

## Gap → Question Mapping

### Gap 1: [gap description from landscape_map.md]

#### Significance Argument

[Why this gap is important — cite relevant ROADMAP.md / landscape_map.md passages]

> 引用: ROADMAP.md §[section] "[relevant excerpt]"
> 引用: landscape_map.md §[section] "[relevant excerpt]"

#### Solution Paths Survey

[Paths that could close this gap]

- Path A: School [name]'s method [method]
  - 引用: landscape_map.md §Schools of Thought "[excerpt]" (or ROADMAP.md §Analysis if landscape skipped)
  - 引用: [key paper arXiv ID / DOI] "[excerpt]"
  - Evidence strength: [STRONG / MODERATE / WEAK]
  - Partial success: [yes/no + evidence]

- Path B: [same structure]

#### Tractability Argument

[Most feasible path and its justification]

- Selected path: [Path A/B/C]
- Selection reason: [partial success + available method + computational feasibility + resource match]
- Tractability confidence: [HIGH / MEDIUM / LOW]
- Confidence justification: [specific evidence]
- LOW type: [foundation_insufficient / frontier_problem / null]
- LOW handling status: [pending_supplement / ... / null]
- PoC question(s): [list / null]

#### Assumptions Introduced

- Assumption 1: [description]
  - Source: [推理需要 / 方法前提 / 简化假设]
  - Verifiability: [verifiable in execution / limit]
  - ROADMAP/landscape coverage: [yes / no → "unverified assumption"]

#### Inter-Question Dependencies

- Depends on: [Q1 / none]
  - Dependency description: [Q1's conclusion [claim X] is prerequisite for this question's method [Y]]
  - Critical dependency: [true / false]
  - Fallback path: [description / none]
- Required by: [Q3 / none]

#### Derived Question

- Question: [SMED/PICO/General framed question]
- Framework used: [SMED / PICO / General]
- Framework element 溯源:
  - System/Population ← framing_reasoning.md §Solution Paths Survey, Path [N]: [research object]
  - Model/Intervention ← framing_reasoning.md §Solution Paths Survey, Path [N]: [method]
  - Expectation/Comparison ← framing_reasoning.md §Tractability Argument: [expected conclusion vs existing results]
  - Deviation/Outcome ← framing_reasoning.md §Significance Argument: [deviation to test]
- Falsification criterion: [from tractability confidence justification negation]
  - Falsification 溯源: ← framing_reasoning.md §Tractability Argument confidence justification: [supporting evidence → negation situation]
- Measurement method: [from selected path's available methods]
- Evidence kind: [from selected path's evidence types]
- How question maps to PLAN.md Claims: [claim 1 → question 1 gap 1]

## Priority Justification

| Gap   | Significance      | Tractability      | Reasoning    |
| ----- | ----------------- | ----------------- | ------------ |
| Gap 1 | [High/Medium/Low] | [HIGH/MEDIUM/LOW] | [1 sentence] |

## Dependency Graph

Q1 ──→ Q2 (Q2's assumption depends on Q1's conclusion)
Q3 (independent)

## Execution Order (topological sort)

| Wave | Questions | Executable reason          |
| ---- | --------- | -------------------------- |
| 1    | Q1, Q3    | No prerequisite dependency |
| 2    | Q2        | Depends on Q1              |

## Unresolved Knowledge Gaps (from audit_1/2)

- Unresolved gap 1: [description from AUDIT_1/2]
  - Impact on reasoning: [which reasoning steps affected]
  - Mitigation in question design: [how question design accommodates uncertainty]
```

### Step 8: Map to PLAN.md Contract

Write to `.aether/research/persistence/PLAN.md`. Claims section includes derived_from/tractability/question fields (extracted from framing_reasoning.md §Derived Question). Execution Plan is multi-Wave structure based on framing_reasoning.md §Execution Order. Dependencies are **self-contained** — each dependency includes: dependency description, critical=true/false with reasoning, fallback path (if non-critical). No reference-only pointers without the full description.

```markdown
# Research Plan — [Project Name]

## Contract

### Claims

- [Claim 1]: [assertion]
  - derived_from: "framing_reasoning.md §Gap 1, Path A"
  - tractability: [HIGH / MEDIUM / LOW]
  - question: [Q1]
- [Claim 2]: [assertion]
  - derived_from: "framing_reasoning.md §Gap 2, Path B"
  - tractability: [MEDIUM]
  - question: [Q2]

### Deliverables

- [Deliverable 1]: [Expected output]
- [Deliverable 2]: [Expected output]

### Acceptance Tests

- [Test 1]: [How to verify claim 1 — derived from falsification criterion]
- [Test 2]: [How to verify claim 2]

### Forbidden Proxies

- [Proxy 1]: [What shortcuts MUST NOT be used as evidence]
- [Proxy 2]: [What sources MUST NOT be sole evidence]

### Execution Plan (per-Wave, based on framing_reasoning.md §Execution Order)

#### Wave 1: Q1, Q3

**Q1: [question title]**

- Method: [method]
- Tools: [packages]
- Falsification test: [from acceptance test]
- Dependencies: none (knowledge-base only)
- Output file: execution/Q1_EXECUTION.md

**Q3: [question title]**

- Method: [method]
- Tools: [packages]
- Falsification test: [from acceptance test]
- Dependencies: none (independent)
- Output file: execution/Q3_EXECUTION.md

#### Wave 2: Q2

**Q2: [question title]**

- Method: [method]
- Tools: [packages]
- Falsification test: [from acceptance test]
- Dependencies:
  - Q1 (critical): Q1's conclusion [claim X] provides initial parameter [specific parameter name] for this question's method [method Y]. Q1 failure means this question cannot execute.
    - Fallback: none (critical dependency, Q1 failure → Q2 blocked)
  - [OR: Q1 (non-critical): Q1's conclusion [claim X] provides initial parameter [parameter name] for this question's method [method Y].]
    - Fallback: if Q1 conclusion doesn't hold, can use alternative assumption [Z] to attempt this question (source: framing_reasoning.md §Gap [N] → Inter-Question Dependencies fallback path)
- Output file: execution/Q2_EXECUTION.md

### Environment Requirements

> Each requirement MUST include the `critical` field and enough detail for the execution phase to classify the isolation strategy.

- requirement_1:
  software: "[e.g., Python 3.11]"
  packages: ["numpy", "scipy", "sympy"]
  purpose: "[e.g., numerical simulation]"
  isolation_hint: "[uv_venv — pure Python, wheel-installable]"
  critical: true
```

### Step 9: Check Conventions

Before finalizing for physics domains:

1. Call `convention_lock_status` via research-conventions MCP
2. Verify metric_signature, natural_units, fourier_convention consistency
3. If conventions are unlocked, set them before proceeding

### Step 10: Update State

1. Update `.aether/research/persistence/STATE.md`:
   - phase: phase_framing completed
   - key decisions: [research questions chosen, framework selected, tractability confidence levels]
   - blockers: [any, including LOW confidence questions needing landscape supplement]
   - next_action: enter phase_audit_3 (reasoning chain audit)
2. Call `advance_plan` via research-state MCP
3. Output a PhaseResultDigest as your final message (see Step 11). The coordinator will enter phase_audit_3 based on the digest.

### Step 11: Output PhaseResultDigest

Output a YAML code block as your **FINAL message** with this schema:

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
      derived_from: "framing_reasoning.md §Gap [N], Path [A/B/C]"
      tractability: [HIGH | MEDIUM | LOW]
      question: [Q1]
      acceptance_test: "[1 sentence verification method]"
  forbidden_proxies:
    - "[proxy 1 description]"
    - "[proxy 2 description]"
  execution_method: "[Python | C++ | Mathematica | mixed]"
  reasoning_chain_paths:
    - gap: "[gap description]"
      tractability_confidence: [HIGH/MEDIUM/LOW]
      selected_path: "[path description]"
      assumptions_introduced: [N]
      unresolved_assumptions: [N]
      inter_question_dependencies:
        depends_on: [Q1 / none]
        critical: [true / false]
        required_by: [Q3 / none]
  dependency_graph:
    edges:
      - from: [Q1]
        to: [Q2]
        type: [critical / non-critical-with-fallback]
        description: "[dependency description]"
    independent_questions: [Q3]
  execution_order:
    - wave: 1
      questions: [Q1, Q3]
    - wave: 2
      questions: [Q2]
  environment_requirements:
    - software: "[Python 3.11]"
      packages: ["numpy", "scipy"]
      purpose: "[numerical simulation]"
      isolation_hint: "[uv_venv]"
      critical: true
    - software: "[Mathematica 13+]"
      purpose: "[symbolic verification]"
      isolation_hint: "[local]"
      critical: true
  verification_approach: [physics | general]
  output_paths:
    plan: persistence/PLAN.md
    research_questions: notepads/[slug]/research_questions.md
    framing_reasoning: notepads/[slug]/framing_reasoning.md
  next_phase: phase_audit_3
```

MUST NOT output any other text after this YAML block.

## Integrity

Never frame a question that cannot be falsified. Every question must have a concrete falsification criterion and measurable evidence kind. Every reasoning step must have explicit citations from ROADMAP.md / landscape_map.md. Every assumption not covered by the knowledge base must be labeled as "unverified assumption". Tractability confidence must not violate the minimum necessary conditions defined in §Tractability Confidence Classification.
