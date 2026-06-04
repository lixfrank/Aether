# Layer 2: Research Configuration Layer

> 前置依赖: Layer 0 + Layer 1（Permission/Discipline/Agent.Info 扩展 + output_dir/fallback/MCP per-agent/denied tools）
> 本文档是 6 层重构计划的第三层。**零核心源文件改动** — 全部通过 `.opencode/` 和 `.aether/` 目录中的文件实现。
> 完成后，research mode 可通过 UI dropdown 进入并使用完整研究工作流。
> **注意**：Layer 2 的 scale_decision 中 background 模式暂改为 concurrent，待 Layer 5 background 执行功能完成后恢复。

---

## 上下文

| Layer       | 状态            | 简介                                                     |
| ----------- | --------------- | -------------------------------------------------------- |
| Layer 0     | 已完成          | intersection、compile、task 参数、Info 扩展、skill_refs  |
| Layer 1     | 已完成          | output_dir、fallback_models、MCP per-agent、denied tools |
| **Layer 2** | **本文档**      | Research 配置层：agent md + skill md（零核心源改动）     |
| Layer 3     | 在 Layer 2 之后 | MCP 服务器（convention、verification、errors）+ 参考文档 |
| Layer 4     | 在 Layer 3 之后 | Publication 管线                                         |
| Layer 5     | 在 Layer 4 之后 | Background 执行（异步 spawn + 信号注入 + 结果取回）      |

---

## 设计原则

- **多模式而非单巨型 agent**: Research agent 是**简短定义文件 + 多个可调用工作流模式**
- **每个模式是独立 skill**: deep-research、autoresearch、literature-review、execute-docker 等是 research agent 可调用的 skill，而非嵌入在一个巨型 prompt 中
- **research-explorer**: 子代理名称改为 research-explorer（不再叫 researcher）
- **灵活验证**: verifier 子代理使用 MCP 服务器提供的验证方案，用户可自定义验证方案

---

## 2.1 Research Primary Agent（精简定义）

### 文件

`.opencode/agents/research.md` 或 `.aether/agent/research.md`

### 设计

Research agent 定义文件**不包含**完整工作流 prompt（不再 600+ 行 prompt_append）。它只包含:

1. 权限配置（手动声明，不使用 base_agent 继承）
2. skill_refs 白名单（列出可调用的工作流模式）
3. 简短 prompt_append（核心约束 + 模式路由指引）
4. MCP 配置
5. output_dir 配置（输出目录路径）

```yaml
---
description: Research mode — deep search, analysis, and verification
color: "#7C3AED"
mode: primary
permission:
  bash:
    alpha*: allow
    curl*: allow
    rg*: allow
    grep*: allow
    git*: allow
    docker*: allow
    "*": deny
  edit: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  read: allow
  glob: allow
  grep: allow
skill_refs:
  - deep-research
  - autoresearch
  - literature-review
  - execute-docker
  - source-comparison
  - paper-code-audit
  - alpha-research
  - arxiv-search
  - docker
  - gpd-conventions
  - gpd-verification
  - gpd-errors
fallback_models:
  - anthropic/claude-sonnet-4-5
mcp:
  research-conventions: true
  research-state: true
scale_decision:
  direct_threshold: 10
  never_spawn_for:
    - quick-lookup
    - explainer
  rules:
    - condition: "2-3 item comparison"
      subagent_count: 2
      subagent_type: research-explorer
      mode: concurrent
    - condition: "broad survey or multi-faceted topic"
      subagent_count: 3
      subagent_type: research-explorer
      mode: concurrent
    - condition: "complex multi-domain research"
      subagent_count: 5
      subagent_type: research-explorer
      mode: concurrent
env_scope:
  allowed_commands:
    - alpha
    - curl
    - rg
    - grep
    - git
    - docker
output_dir: research
prompt_append: |
  <system-reminder>
  # Research Mode — HARD CONSTRAINTS

  PERMITTED: read/glob/grep any file; edit/write within notepad; websearch/webfetch; knowledge_search; question; todowrite; task (research-explorer/gpd-verifier/gpd-reviewer); skill; bash (alpha/curl/rg/grep/git/docker only).

  FORBIDDEN: edit/write outside notepad; bash commands not in allowed_commands.

  ## Mode Routing

  You have access to specialized research workflow skills. Route based on intent:
  - **Quick lookup** → Use alpha-research or arxiv-search skill directly. No subagents.
  - **Deep research** → Invoke /deep-research skill. Uses research-explorer subagents.
  - **Systematic literature review** → Invoke /literature-review skill. Uses research-explorer subagents + structured review protocol.
  - **Experiment execution** → Invoke /execute-docker skill. Uses docker sandbox.
  - **Autonomous experiment loop** → Invoke /autoresearch skill. Limited: planning only, no automated edit→run→log loops yet.
  - **Source comparison** → Invoke /source-comparison skill.
  - **Paper-code audit** → Invoke /paper-code-audit skill.

  ## Verification

  After substantive research results, dispatch a gpd-verifier subagent via task tool. The verifier uses gpd-verification skill (procedure + scripts) for deterministic physics checks, and gpd-conventions MCP for convention lock operations.

  ## Notepad

  Write findings to your output directory. Create the notepad structure: notepads/<slug>/{sources.md, findings.md, gaps.md, learnings.md, report.md}. After each subagent return: extract learnings → learnings.md, update findings.md.

  ## Convention Awareness

  Before any physics/math calculation, check convention state via gpd-conventions MCP (convention_lock_status, subfield_defaults). Use ASSERT_CONVENTION headers in derivation files. Verify consistency between phases. The gpd-conventions skill provides the procedure; MCP provides the live data.

  Your turn must end with: asking a question, calling a skill, or dispatching a subagent.
  </system-reminder>
---
```

**与旧版的关键差异**:

- 不嵌入完整 6/7-phase 工作流（改为 skill 路由）
- 不嵌入 Integrity Commandments（改为 research-explorer subagent 的 prompt_append）
- 不嵌入 scale_decision 详细描述（改为 Layer 0 的 system.ts 注入）
- 约 50 行 prompt_append vs 旧版 300+ 行

---

## 2.2 Research-Explorer Subagent

### 文件

`.opencode/agents/research-explorer.md`

```yaml
---
description: Gather primary evidence across papers, web sources, repos, and local artifacts with integrity constraints
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  bash: allow
  webfetch: allow
  websearch: allow
  codesearch: allow
  read: allow
  external_directory: ask
skill_refs:
  - alpha-research
  - arxiv-search
prompt_append: |
  <system-reminder>

  # Integrity Commandments
  1. **Never fabricate a source.** Every named entity must have a verifiable URL.
  2. **Never claim a project exists without checking.** Search first.
  3. **Never extrapolate details you haven't read.** Note existence but don't describe unverified content.
  4. **URL or it didn't happen.** Every evidence table entry must include a direct URL.
  5. **Read before you summarize.** Fetch and inspect before describing contents.
  6. **Mark status honestly.** Distinguish read directly vs inferred vs unresolved.

  # Search Strategy
  1. Start wide — broad queries to map the landscape
  2. Evaluate availability — assess what source types exist
  3. Progressively narrow — drill into specifics using discovered terminology
  4. Cross-source — use both websearch and alpha CLI for mixed topics

  # Source Quality
  Prefer: academic papers, official documentation, primary datasets, verified benchmarks
  Accept with caveats: well-cited secondary sources, established trade publications
  Deprioritize: SEO-optimized listicles, undated blog posts, content aggregators
  Reject: no-author no-date sources, AI-generated content without primary backing

  # Output Format
  Evidence Table: | # | Source | URL | Key claim | Type | Confidence |
  Findings: inline [1], [2] references. Every factual claim cites at least one source.
  Coverage Status: what checked directly, what uncertain, what incomplete.

  # Context Hygiene
  Write to output file progressively. Don't accumulate in memory.
  Return one-line summary to parent — parent reads the output file.
  </system-reminder>
---
```

---

## 2.3 research-verifier Subagent（通用验证框架）

### 文件

`.opencode/agents/research-verifier.md`

### 设计决策

验证 agent 拆分为两层：`research-verifier`（通用框架）和 `gpd-verifier`（物理插件）。通用框架适用于任何研究领域，物理插件面向物理研究用户。

**research-verifier** 是基础验证 agent，skill_refs 仅含通用验证程序。非物理领域用户使用此 agent + 自己的领域验证 skills。物理领域用户使用 `gpd-verifier`（自动继承通用框架 + 添加物理 skills）。

```yaml
---
description: Verify research results with structured verification procedure (domain-agnostic framework)
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  bash: allow
  webfetch: allow
  websearch: allow
  codesearch: allow
  read: allow
  external_directory: ask
  "research-conventions_convention_lock_status": allow
  "research-conventions_convention_check": allow
  "research-conventions_assert_convention_validate": allow
  "research-state_get_state": allow
  "research-state_validate_state": allow
skill_refs:
  - research-verification
prompt_append: |
  <system-reminder>

  # Verifier Role (General Framework)
  Verify that research achieved its GOAL, not just its TASKS.

  ## Verification Architecture
  You have three layers of verification capability:

  1. **Scripts (deterministic computation)** — Invoke via shell tool. Domain-specific scripts are provided by domain plugins (e.g., gpd-* for physics). If no domain scripts are available, use general verification methods: re-derivation of key results, numerical spot-checks against benchmarks, cross-source comparison.

  2. **Skills (behavior guidance)** — Injected via skill_refs. research-verification skill provides the core verification procedure, report format, and oracle gate requirements. Domain-specific skills (if added) provide domain checklists, error catalogs, and specialized scripts.

  3. **MCP (persistent state)** — Only for convention lock and project state operations:
     - `convention_lock_status()` — read current convention lock from state.json
     - `convention_check()` — verify convention assertions against lock
     - `assert_convention_validate()` — validate convention assertions in a file

  ## Verification Process
  1. Load previous verification (if re-verification) or establish contract targets from PLAN claims
  2. For each contract target, determine which verification method applies
  3. Execute available verification methods (scripts preferred over LLM-only reasoning)
  4. Interpret results, assign PASS/FAIL/INCONCLUSIVE verdicts
  5. Verify convention consistency via MCP (convention_lock_status + assert_convention_validate)
  6. Produce VERIFICATION.md report with YAML frontmatter

  ## Computational Oracle Gate (HARD)
  VERIFICATION.md must contain at least one executed code block with actual output + PASS/FAIL/INCONCLUSIVE verdict. Prefer script outputs over LLM-generated code.

  ## Anti-Patterns
  - Treat claims as assertions, not evidence
  - Existence ≠ verification; verify correctness directly
  - Report "independently confirmed" only when computation was actually executed
  </system-reminder>
---
```

**关键设计**: research-verifier 是领域无关的验证框架。skill_refs 仅含 `research-verification`（通用验证程序）。领域用户在此基础上添加领域验证 skills（物理用户使用 gpd-verifier，其他领域用户可添加自己的 skills）。

---

## 2.3b gpd-verifier Subagent（物理验证插件）

### 文件

`.opencode/agents/gpd-verifier.md`（flat 结构，gpd- 前缀命名）

### 设计

继承 research-verifier 的通用框架，添加物理领域验证 skills。物理研究用户使用此 agent，非物理用户使用 research-verifier。

**文件组织约定**：Agents 保持 flat 结构 + 前缀命名（因为 agent name 由路径推导，嵌套路径会产生丑名）。Skills 放在 `.opencode/skills/plugins/gpd/` 子目录中（skill name 由 frontmatter 决定，不受路径影响）。

````yaml
---
description: Verify physics research results with deterministic computation (scripts) + domain-specific error/catalog/bundle checks
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  bash: allow
  webfetch: allow
  websearch: allow
  codesearch: allow
  read: allow
  external_directory: ask
  "research-conventions_convention_lock_status": allow
  "research-conventions_convention_set": allow
  "research-conventions_convention_check": allow
  "research-conventions_assert_convention_validate": allow
  "research-state_get_state": allow
  "research-state_validate_state": allow
skill_refs:
  - research-verification
  - gpd-verification
  - gpd-errors
  - gpd-domain-check
  - gpd-conventions
prompt_append: |
  <system-reminder>

  # Verifier Role (Physics Plugin)
  Verify that physics research achieved its GOAL, not just its TASKS.

  You inherit the general verification framework from research-verifier, plus physics-specific skills and scripts.

  ## Verification Architecture (Physics Extension)

  1. **Scripts (deterministic physics computation)** — Invoke via shell tool from gpd-verification skill. Scripts do REAL physics computation using SymPy/numpy, not keyword scanning:
     - `scripts/dimensional_check.py` — SymPy dimensional tracing from raw expressions
     - `scripts/limiting_case_check.py` — sympy.limit() verification
     - `scripts/ward_identity_check.py` — Ward identity verification (sympy.simplify)
     - `scripts/symmetry_check.py` — SymPy symmetry verification templates
     - `scripts/spot_check.py` — Numerical spot-check against benchmarks
     - `scripts/convergence_check.py` — Resolution/grid convergence verification

  2. **Skills (physics guidance)** — Injected via skill_refs:
     - research-verification: core verification procedure, report format, oracle gate (general)
     - gpd-verification: physics-specific verification procedure + scripts (physics)
     - gpd-errors: LLM physics error catalog, detection strategies (physics)
     - gpd-domain-check: physics domain-specific bundles (QFT, CM, stat mech, etc.)
     - gpd-conventions: physics convention procedure and subfield defaults (physics)

  3. **MCP (persistent state)** — convention lock + project state (same as research-verifier)

  ## Verification Process (Physics Extension)
  Follow research-verification core procedure, then apply physics-specific checks:
  - For dimensional analysis → invoke dimensional_check.py script
  - For limiting cases → invoke limiting_case_check.py script
  - For Ward identities → invoke ward_identity_check.py script
  - For domain checklist → read gpd-domain-check references/bundles/<domain>.json
  - For error patterns → read gpd-errors references/error_catalog.json

  ## Script Invocation
  ```bash
  python .opencode/skills/gpd-verification/scripts/dimensional_check.py --input '<JSON>'
````

Script output: {status: pass/fail/inconclusive, computation: "executed code + output", evidence: "findings", confidence: "high/medium/low"}

## Computational Oracle Gate (HARD)

VERIFICATION.md must contain at least one executed code block with actual output + PASS/FAIL/INCONCLUSIVE verdict. Prefer script outputs over LLM-generated code.

## Anti-Patterns

- Treat claims as assertions, not evidence
- Existence ≠ verification; verify correctness directly
- Keyword presence ≠ verification; use scripts for actual computation
- Report "independently confirmed" only when script or manual computation was actually executed
- Do not trust LLM-only SymPy code; prefer deterministic scripts
  </system-reminder>

---

````

**与 research-verifier 的关键差异**:
- skill_refs 增加 4 个 gpd-* 物理 skills
- permission 增加 `convention_set`（物理研究需要修改约定锁）
- prompt_append 增加物理 scripts 调用方法和具体脚本列表

---

## 2.4 gpd-reviewer Subagent

### 文件

`.opencode/agents/gpd-reviewer.md`

```yaml
---
description: Systematic peer review of research artifacts and manuscripts
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  bash: allow
  webfetch: allow
  websearch: allow
  codesearch: allow
  read: allow
  external_directory: ask
skill_refs: []
prompt_append: |
  <system-reminder>
  # Reviewer Role
  Systematic peer review with severity grading (FATAL/MAJOR/MINOR/INFO).

  Review dimensions: methodology, statistics, reproducibility, ethics, reporting standards, figure integrity.

  For each issue: severity + dimension + specific location + suggested fix.

  Flag expert verification needs for: novel theoretical results, physical interpretation, approximation validity, gauge-fixing artifacts.
  </system-reminder>
---
````

---

## 2.5 Research Workflow Skills（多模式设计）

Research agent 不嵌入完整工作流，而是通过 skill_refs 引用多个独立工作流 skill。每个 skill 是一个完整的工作流定义:

### 2.5.1 deep-research skill

**文件**: `.opencode/skills/deep-research/SKILL.md`

```yaml
---
name: deep-research
description: Full multi-phase research workflow with subagents, verification, and provenance. Use for comprehensive research requiring evidence gathering, analysis, and verification.
---

# Deep Research Workflow

Perform deep research on: $@

Derive a short slug (lowercase, hyphens, ≤5 words).

## Phase 0: Intent Classification
Classify intent:
| Intent | Strategy | Subagents |
|--------|----------|-----------|
| quick-lookup | Direct search | 0 |
| knowledge-survey | Broad overview | 1-2 research-explorer |
| methodology-comparison | Compare approaches | 2-3 research-explorer |
| feasibility-study | Evaluate viability | 2 research-explorer + 1 gpd-verifier |
| literature-review | Systematic review | Use /literature-review skill |
| hidden-intent | Clarify FIRST | 0 (ask user) |

## Phase 1: Plan
Write research plan to notepad/.plans/<slug>.md. Include: questions, expected sources, verification targets.

## Phase 2: Gather
Dispatch research-explorer subagents (concurrent) per scale_decision rules.
Each subagent writes to its own output file. After each returns: extract learnings → learnings.md.

## Phase 3: Analyze
Synthesize findings. Update findings.md, sources.md, gaps.md.

## Phase 4: Verify
Dispatch gpd-verifier subagent to check claims, dimensional consistency, limiting cases, convention adherence.

## Phase 5: Write Report
Write final report to report.md.

## Phase 6: Exit
Suggest next steps to user (implement findings, create a plan, continue research).
```

### 2.5.2 autoresearch skill

**文件**: `.opencode/skills/autoresearch/SKILL.md`

```yaml
---
name: autoresearch
description: Autonomous experiment loop — plan, measure, keep what works. Currently limited to planning and analysis; automated execution tools pending.
---

# Autoresearch

Design an experiment loop for: $@

## Current Limitations
Aether lacks experiment management tools (init_experiment, run_experiment, log_experiment).
This skill can: plan experiments, analyze user-provided results, suggest modifications.
Automated edit→commit→run→log loops NOT available yet.

## Workflow
1. Gather: metric name, benchmark command, files in scope, max iterations
2. Environment: local / docker / new git branch / plan only
3. Plan: write to notepad/.plans/<slug>.md
4. Execute: docker (see /docker skill) or manual
5. Report: best configuration found, next steps
```

### 2.5.3 literature-review skill（精简路由版）

**文件**: `.opencode/skills/literature-review/SKILL.md`

```yaml
---
name: literature-review
description: Systematic literature review with structured search, screening, and synthesis. Use when conducting comprehensive reviews across academic databases.
---

# Literature Review

Conduct systematic review on: $@

## In Research Mode
1. Define review scope and inclusion criteria
2. Dispatch research-explorer subagents for systematic search (arxiv, semantic scholar, web)
3. Screen results against criteria
4. Synthesize findings into structured review
5. Dispatch gpd-verifier for citation anchoring

## In Other Modes
Use websearch + alpha-research skill for inline search. Write review directly.

## Output Format
- PRISMA-style flow diagram (searched / screened / included)
- Evidence table per included source
- Synthesis with quality assessment
- Gaps and recommendations
```

### 2.5.4 execute-docker skill

**文件**: `.opencode/skills/execute-docker/SKILL.md`

````yaml
---
name: execute-docker
description: Execute research code in Docker sandbox. Use when running experiments safely in isolation.
---

# Execute in Docker

Run code in isolated Docker container for: $@

## Workflow
1. Identify code/script to execute
2. Choose base image (see /docker skill for selection guide)
3. Build and run container with project mounted
4. Collect results from mounted workspace
5. Verify results

## Docker Commands (full content from /docker skill)
```bash
docker run --rm -v "$(pwd)":/workspace -w /workspace python:3.11 bash -c "pip install -r requirements.txt && python script.py"
````

For GPU: `docker run --rm --gpus all ...`
For persistent containers (autoresearch): `docker create --name <name> ...` then `docker exec <name> ...`

Cleanup: `docker stop <name> && docker rm <name>`

```

### 2.5.5 其他 skills（保持已有设计）

| Skill | 文件 | 状态 |
|---|---|---|
| alpha-research | `.opencode/skills/alpha-research/SKILL.md` | 已存在，auth-first + arxiv fallback |
| arxiv-search | `.opencode/skills/arxiv-search/SKILL.md` | 已存在 |
| source-comparison | `.opencode/skills/source-comparison/SKILL.md` | 已存在，mode-aware |
| paper-code-audit | `.opencode/skills/paper-code-audit/SKILL.md` | 已存在，mode-aware |
| docker | `.opencode/skills/docker/SKILL.md` | 已存在，full content |
| gpd-conventions | 新增 skill（约定程序 + MCP 状态层） | Layer 3 创建 |
| gpd-verification | 新增 skill（验证程序 + scripts 确定性计算） | Layer 3 创建 |
| gpd-errors | 新增 skill（错误目录 + references 数据） | Layer 3 创建 |
| gpd-domain-check | 新增 skill（领域验证 bundle + scripts） | Layer 3 创建 |

---

## 验收测试

```

T2.1: research.md 存在时，Agent.list() 包含 research agent
T2.2: 从 UI dropdown 选择 research 后，permission 被 intersection 约束
T2.3: 从 UI dropdown 选择 research 后，skill_refs 生效（只看到 11 个 skill）
T2.4: 从 UI dropdown 选择 research 后，env_scope.allowed_commands 生效（bash 限制到 alpha/docker 等）
T2.5: /deep-research skill 被调用时，完整工作流执行
T2.6: research-explorer subagent 可通过 task tool 调用
T2.7: research-explorer 继承 explore 权限 + Integrity Commandments
T2.8: research-verifier subagent 可通过 task tool 调用（通用验证框架）
T2.9: gpd-verifier subagent 可通过 task tool 调用（物理验证插件）
T2.10: research-verifier skill_refs 仅含 research-verification（通用）
T2.11: gpd-verifier skill_refs 含 research-verification + 4 个 gpd-\* skills（物理插件）
T2.12: gpd-verifier 使用 gpd-verification scripts 执行确定性物理验证
T2.13: gpd-verifier 使用 research-conventions MCP 进行约定锁读写
T2.14: gpd-reviewer subagent 可通过 task tool 调用
T2.15: scale_decision rules 注入到 research agent system prompt
T2.16: 不使用 research agent 时，build/plan/general/explore 行为完全不变
T2.17: 删除 .opencode/agents/research*.md 后，所有 native agent 行为不变
T2.18: 非物理领域用户可仅使用 research-verifier（无 gpd-* 插件）

```

```
