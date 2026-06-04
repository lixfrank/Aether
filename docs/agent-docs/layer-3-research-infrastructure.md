# Layer 3: Research Infrastructure — 双层命名架构

> 前置依赖: Layer 0-2（核心安全 + Agent 基础设施 + Research 配置层）
> 本文档是 5 层重构计划的第四层。**零核心源文件改动** — 全部通过 `.opencode/` 和 `.aether/` 目录中的文件实现。
> 完成后，research-verifier（通用）可通过 skills+scripts 执行验证，gpd-verifier（物理插件）可额外执行确定性物理计算。

---

## 上下文

| Layer       | 状态            | 简介                                                     |
| ----------- | --------------- | -------------------------------------------------------- |
| Layer 0     | 已完成          | Permission/Discipline/Info 扩展                          |
| Layer 1     | 已完成          | output_dir、fallback_models、MCP per-agent、denied tools |
| Layer 2     | 已完成          | Research agent/skill 配置文件（零核心源改动）            |
| **Layer 3** | **本文档**      | MCP 状态层 + Skills/Scripts 计算层                       |
| Layer 4     | 在 Layer 3 之后 | Publication 管线                                         |
| Layer 5     | 在 Layer 4 之后 | Background 执行                                          |

---

## 设计原则

### 双层命名架构

组件分为两个命名层，确保通用研究基础设施可用于任何领域，物理功能作为可选插件：

| 前缀         | 含义                             | 范围               | 示例                                                                                                           |
| ------------ | -------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `research-*` | 通用研究基础设施                 | 适用于任何研究领域 | research-state MCP、research-conventions MCP（框架）、research-verification skill（通用验证程序）              |
| `gpd-*`      | 物理领域插件（Get Physics Done） | 仅适用于物理研究   | gpd-verification scripts（SymPy 计算）、gpd-errors catalog（物理错误类）、gpd-domain-check bundles（物理领域） |

**research-verifier**（通用）skill_refs 仅含 `research-verification`。**gpd-verifier**（物理插件）skill_refs 增加 4 个 gpd-\* skills。非物理领域用户使用 research-verifier + 自己的领域验证 skills。

### 分层验证架构（替代 GPD 的全 MCP 方案）

GPD 使用 8 个 MCP 服务器处理所有功能（验证指引、错误目录、约定管理、技能路由、项目状态、模式库、协议、arXiv）。但我们的分析表明 GPD 的 MCP 服务器实际上分为两类：

| 类别                     | GPD 实现                                               | 我们的方案               | 原因                                                                         |
| ------------------------ | ------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| **持久状态管理**         | MCP（convention_set 原子写入、advance_plan 推进状态）  | **保留 MCP**             | 需要文件锁、事务性写入、实时数据查询，prompt/skill 无法实现                  |
| **指引文本与关键词扫描** | MCP（run_check 返回 oracle_hint、关键词扫描 artifact） | **移至 skill + scripts** | SKILL.md 注入比 MCP 返回的一次性文本更可见持久；确定性计算比关键词扫描更可靠 |

核心改进：GPD 的 verification MCP 标注为 `evidence_kind: "computational"` 的检查（维度分析、Ward 恒等式、极限推导）**实际只做关键词扫描和返回指引文本**，物理验证依赖 LLM 自己写 SymPy 并自己判断。我们的 scripts 做**确定性物理计算**——维度追踪用 SymPy 解析表达式、极限推导用 `sympy.limit()`、Ward 恒等式用 `sympy.simplify()`。LLM 只负责解读计算结果。

### 三层验证能力

| 层                        | 提供者                   | 做什么                                                     | 不做什么                      |
| ------------------------- | ------------------------ | ---------------------------------------------------------- | ----------------------------- |
| **Scripts（确定性计算）** | skill 附带的 Python 脚本 | SymPy 维度追踪、极限推导、Ward 恒等式验证、数值 spot-check | 不做 LLM 推理、不返回指引文本 |
| **Skills（行为指引）**    | SKILL.md via skill_refs  | 验证程序、报告格式、oracle gate 要求、错误识别策略         | 不做计算、不写文件            |
| **MCP（持久状态）**       | MCP 服务器               | 约定锁读写（原子）、项目状态管理、约定验证（结构化）       | 不做物理计算、不返回指引文本  |

---

## 3.1 MCP 服务器（通用状态层）

### 3.1.1 research-conventions MCP 服务器

保留原因：约定锁需要原子性写入和文件锁保护。框架是通用的（任何研究领域都有约定/规范需要锁定），当前数据是物理领域的。

#### Tool Schema

```python
@mcp_tool("convention_lock_status")
def convention_lock_status(project_dir: str) -> dict:
    """Return current convention lock state from state.json.
    Convention keys are domain-specific — physics uses metric_signature,
    fourier_convention, etc; other domains define their own convention schema."""

@mcp_tool("convention_set")
def convention_set(key: str, value: str, project_dir: str) -> dict:
    """Atomically set a convention value. Convention keys are defined by
    the domain's convention schema (see references/convention_schema.json).
    Physics keys: natural_units, metric_signature, fourier_convention, gauge_choice,
    renormalization_scheme, coupling_convention, spin_basis, state_normalization,
    coordinate_system, index_positioning, time_ordering, commutation_convention.
    Uses file-lock for atomic write."""

@mcp_tool("convention_check")
def convention_check(file_content: str, project_dir: str) -> dict:
    """Check ASSERT_CONVENTION headers in file_content against current lock"""

@mcp_tool("assert_convention_validate")
def assert_convention_validate(file_path: str, project_dir: str) -> dict:
    """Validate all ASSERT_CONVENTION lines in a file against current lock"""

@mcp_tool("subfield_defaults")
def subfield_defaults(domain: str) -> dict:
    """Return default conventions for a domain.
    Physics defaults (14 subfields) loaded from gpd-conventions skill data.
    Other domain defaults can be registered in references/convention_defaults/."""
```

**移除的工具**（转至 skill）：`convention_diff`（两个阶段约定对比 — 两个文件读 + 字典减法，agent 自行完成）、`convention_diff`（对比两个约定锁 — 纯 dict 操作，不需要 MCP）。

#### 注册方式

```json
{
  "mcp": {
    "research-conventions": {
      "type": "local",
      "command": ["python3", "-m", "research_conventions_server"],
      "enabled": true
    }
  }
}
```

#### 数据存储

`.aether/conventions/state.json`（与 Layer 2 文档中定义一致）。

#### 子领域默认约定

物理领域的默认值由 gpd-conventions skill 提供（作为插件数据），MCP 服务器加载 `references/convention_defaults/physics.json`。其他领域可注册自己的默认值文件。

### 3.1.2 research-state MCP 服务器

保留原因：项目状态需要原子性写入（advance_plan 推进状态），健康检查需要结构化验证。

#### Tool Schema

```python
@mcp_tool("get_state")
def get_state(project_dir: str) -> dict:
    """Return structured project state from state.json"""

@mcp_tool("advance_plan")
def advance_plan(phase: str, plan_number: str, project_dir: str) -> dict:
    """Atomically advance project to next plan in state.json"""

@mcp_tool("validate_state")
def validate_state(project_dir: str) -> dict:
    """Validate state.json schema, conventions, phase format"""

@mcp_tool("get_progress")
def get_progress(project_dir: str) -> dict:
    """Return computed progress summary"""

@mcp_tool("run_health_check")
def run_health_check(project_dir: str, fix: bool = False) -> dict:
    """Full project health dashboard: structure, storage, state validity, conventions, config"""
```

#### 注册方式

```json
{
  "mcp": {
    "research-state": {
      "type": "local",
      "command": ["python3", "-m", "research_state_server"],
      "enabled": true
    }
  }
}
```

---

## 3.2 research-\* Skills（通用框架层）

### 3.2.1 research-verification skill

**通用验证程序框架**——适用于任何研究领域。物理领域用户在此基础上叠加 gpd-\* 物理插件。

**核心创新**：替代 GPD 的 verification MCP 服务器。GPD 的 MCP 只返回指引文本和关键词扫描结果。我们的 skill 提供**行为指引**（SKILL.md），**确定性计算**（scripts/），**数据文件**（bundles/）。

#### 文件

`.opencode/skills/research-verification/SKILL.md`

```yaml
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
```

---

## 3.3 gpd-\* Skills（物理插件层）

物理领域验证插件，在 research-verification 通用框架之上叠加。gpd-verifier agent 的 skill_refs 包含 research-verification + 4 个 gpd-\* skills。

### 插件目录约定

**Skills** 放在 `.opencode/skills/plugins/gpd/` 子目录中，利用 OpenCode 的 `**/SKILL.md` glob 发现 + frontmatter `name` 字段命名，**零代码改动**即可实现插件隔离：

```
.opencode/skills/plugins/gpd/gpd-verification/SKILL.md  → skill name: "gpd-verification"
.opencode/skills/plugins/gpd/gpd-errors/SKILL.md         → skill name: "gpd-errors"
.opencode/skills/plugins/gpd/gpd-domain-check/SKILL.md   → skill name: "gpd-domain-check"
.opencode/skills/plugins/gpd/gpd-conventions/SKILL.md    → skill name: "gpd-conventions"
```

**Agents** 保持 flat 结构 + `gpd-` 前缀（因为 agent name 由路径推导）：

```
.opencode/agents/gpd-verifier.md    → agent name: "gpd-verifier"
.opencode/agents/gpd-reviewer.md    → agent name: "gpd-reviewer"
```

**插件管理**：

- **卸载**：删除 `.opencode/skills/plugins/gpd/` 目录 + 删除 `.opencode/agents/gpd-*.md`
- **分享**：打包 `plugins/gpd/` + flat agents + MCP 配置建议
- **其他领域插件**：创建 `.opencode/skills/plugins/bio/` + `.opencode/agents/bio-verifier.md`

### 3.3.1 gpd-verification skill

### 3.3.2 gpd-errors skill

物理领域插件——LLM 物理推理错误目录。替代 GPD 的 errors MCP 服务器。

#### 文件

`.opencode/skills/plugins/gpd/gpd-errors/SKILL.md`

```yaml
---
name: gpd-errors
description: LLM physics error catalog with detection strategies. Use to identify common LLM physics reasoning errors during verification.
---

# LLM Physics Error Detection

## When to Use
During verification, after producing research results. Check for known LLM-specific physics error patterns.

## Error Detection Procedure

### Step 1: Identify Domain
Determine which physics domain the current work belongs to (qft, condensed_matter, stat_mech, numerical, gr, nuclear_particle, quantum_info, optics, astro, fluid, materials, genomics).

### Step 2: Load Error Catalog
Read `references/error_catalog.json` for the 20 highest-risk error classes. Filter by domain.

### Step 3: Check Each Error Class
For each relevant error class, apply the detection strategy:

| Error Class | Detection Strategy |
|-------------|-------------------|
| E01: CG coefficient sign error | Verify triangle inequality, m-values sum. Spot-check one CG against Varshalovich tables. |
| E02: Metric signature flip | Trace metric through every equation. Check sign of contraction g_μν g^μν = d. |
| E03: Ward identity violation | Replace ε^μ → k^μ. Check S-matrix cancellation. (Use ward_identity_check.py script) |
| E04: Wrong eigenvalue count | Count must match Hilbert space dimension. |
| E05: Gauge parameter in observable | ξ must cancel from physical observables. |
| ... | (See references/error_catalog.json for full 20 classes) |

### Step 4: Record Findings
For each checked error class, record: {class_id, detected: bool, evidence: str, severity: high|medium|low}.

### Step 5: Flag for Expert Review
For errors that require domain expertise to evaluate, flag as "expert_needed" with specific domain and reason.

## Do Not
- Do not skip high-severity error checks
- Do not claim "no errors found" without checking at least domain-relevant classes
- Do not fabricate detection results — must be based on actual verification
```

#### References 目录

`.opencode/skills/plugins/gpd/gpd-errors/references/`

- `error_catalog.json` — 20 最高风险错误类（与 Layer 2 原设计一致，含 gpd_source 字段）
- `detection_strategies.json` — 每个错误类的详细检测策略和示例
- `traceability_matrix.json` — 错误类 → 验证检查方法映射

---

### 3.2.3 gpd-domain-check skill

### 3.3.3 gpd-domain-check skill

物理领域插件——物理领域验证 bundle。替代 GPD 的 verification MCP 中的 domain checklist 功能。

#### 文件

`.opencode/skills/plugins/gpd/gpd-domain-check/SKILL.md`

```yaml
---
name: gpd-domain-check
description: Domain-specific physics verification checklists. Use during verification to apply specialized checks for quantum field theory, condensed matter, statistical mechanics, and 9 other domains.
---

# Domain-Specific Verification

## When to Use
During verification, after identifying the physics domain of the current work.

## Domain Checklist Procedure

### Step 1: Identify Domain
Determine domain from phase goal and research content. Domains: qft, condensed_matter, stat_mech, numerical, gr, nuclear_particle, quantum_info, optics, astro, fluid, materials, genomics.

### Step 2: Load Domain Checklist
Read `references/bundles/<domain>.json` for domain-specific priority checks, red flags, and standard benchmarks.

### Step 3: Execute Domain Checks
For each priority check in the domain checklist:
- If a script exists (dimensional_check.py, limiting_case_check.py, etc.), invoke it via shell
- If no script exists (literature agreement, physical plausibility), apply LLM judgment with explicit caveats

### Step 4: Check Domain Red Flags
Scan artifacts for domain-specific red flags listed in the bundle.

### Step 5: Verify Standard Benchmarks
For each standard benchmark in the bundle, verify the result matches known values.

### Step 6: Record Coverage
Report which checks were script-verified vs LLM-judged vs deferred.

## Do Not
- Do not skip domain red flags
- Do not claim domain coverage without checking at least priority_checks
- Do not use keyword scanning instead of script computation where scripts exist
```

#### References 目录

`.opencode/skills/plugins/gpd/gpd-domain-check/references/bundles/`

12 个领域 bundle JSON 文件（与 Layer 3 原设计中的 bundles/ 一致，含 gpd_source 字段）。qft.json 包含完整的 priority_checks、specific_red_flags 和 standard_benchmarks（与原设计一致）。

---

### 3.2.4 gpd-conventions skill

### 3.3.4 gpd-conventions skill

物理领域插件——物理约定程序和默认值。MCP 提供通用约定锁框架，gpd-conventions skill 提供物理领域的具体约定内容和 14 个子领域默认值。

#### 文件

`.opencode/skills/plugins/gpd/gpd-conventions/SKILL.md`

```yaml
---
name: gpd-conventions
description: Physics convention lock management. Check, set, validate, and compare conventions across research phases. Use before any calculation to ensure consistency.
---

# Convention Management

## When to Use
Before any physics/math calculation, and during verification to check convention consistency.

## Convention Procedure

### Step 1: Check Current Lock
Call `convention_lock_status` MCP tool to read current convention state from state.json.

### Step 2: Set Conventions (New Project)
If no lock exists, call `subfield_defaults(domain)` MCP tool to get recommended defaults for your domain, then call `convention_set(key, value)` MCP tool for each convention to create the lock.

### Step 3: Validate Conventions
Before each derivation/computation:
- Add `<!-- ASSERT_CONVENTION: natural_units=natural, metric_signature=mostly-minus -->` header to your file
- Call `assert_convention_validate(file_path)` MCP tool to verify headers match lock

### Step 4: Cross-Phase Consistency
When referencing prior phase results, verify convention lock matches. If conventions differ, convert results to current lock conventions before use.

## Subfield Defaults (Quick Reference)
- QFT: natural units, mostly-minus metric, physics Fourier, on-shell renormalization
- Condensed matter: natural units, mostly-plus metric, physics Fourier, Coulomb gauge
- Stat mech: Boltzmann units, mostly-minus metric, standard Matsubara
- Numerical: SI units, Cartesian coordinates, convergence threshold 1e-6
- GR: geometric units, mostly-plus metric, general coordinates

## Do Not
- Do not start a derivation without checking convention_lock_status first
- Do not mix conventions across phases without explicit conversion
- Do not change conventions mid-project without convention_set and re-verification
```

---

## 3.4 移除的 MCP 服务器

以下 MCP 服务器**不保留**，功能由 research-_ 通用框架 + gpd-_ 物理插件替代：

| 原 MCP 服务器        | 替代方案                                      | 替代原因                                                                                               |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **gpd-verification** | gpd-verification skill + scripts + references | MCP 只返回指引文本和关键词扫描。skill 提供持久可见的行为指引；scripts 提供确定性物理计算而非关键词扫描 |
| **gpd-errors**       | gpd-errors skill + references                 | MCP 从 markdown 解析错误目录并返回 JSON。skill + references/ 数据文件直接提供，不需要 Python 进程解析  |
| **gpd-patterns**     | 不需要                                        | CRUD 模式库（add_pattern、promote_pattern）。研究项目不需要跨 session 的错误模式演化                   |
| **gpd-protocols**    | 不需要                                        | 协议路由（route_protocol）。skill_refs 本身就是路由机制，不需要额外 MCP                                |
| **gpd-skills**       | 不需要                                        | 技能路由（route_skill）。OpenCode 的 skill_refs + slash commands 已提供路由                            |
| **gpd-arxiv**        | arxiv-search skill（已存在）                  | GPD 的 arxiv MCP 是上游 arxiv_mcp_server 的桥接。OpenCode 已有独立的 arxiv-search skill                |

**保留的 MCP**：research-conventions（通用约定锁框架）、research-state（通用项目状态管理）。2 个 MCP 进程替代 GPD 的 8 个。

---

## 3.4 与 GPD 的架构对比

| 功能         | GPD 实现                                                                               | 我们实现                                                             | 改进点                                               |
| ------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| 维度分析     | MCP dimensional_check：解析预标注 `[M][L]^2` 括号，关键词扫描                          | script dimensional_check.py：SymPy 解析原始表达式，追踪维度          | 确定性计算 vs 关键词扫描；原始表达式 vs 预标注       |
| 极限推导     | MCP limiting_case_check：关键词扫描 "limit"/"→" 是否出现，返回 `requires_verification` | script limiting_case_check.py：`sympy.limit()` 实际计算极限值        | 确定性计算 vs 关键词扫描；实际推导 vs 文档存在性检查 |
| Ward 恒等式  | MCP run_check 返回 oracle_hint 文本；LLM 自己写 SymPy 并自己判断                       | script ward*identity_check.py：`sympy.simplify(q*μ\*M^μ)` 确定性验证 | 确定性计算 vs LLM 自写代码自判断                     |
| 对称性验证   | MCP symmetry_check：返回策略描述文本                                                   | script symmetry_check.py：SymPy 变换验证模板                         | 确定性计算 vs 文本指引                               |
| 错误目录     | MCP 从 markdown 解析 104 类，返回 JSON                                                 | skill references/error_catalog.json（精选 20 类）+ SKILL.md 程序     | 预加载 vs 按需查询；精选 vs 全量                     |
| 领域清单     | MCP 硬编码 DOMAIN_CHECKLISTS 字典                                                      | skill references/bundles/\*.json 数据文件                            | 可修改 JSON vs 硬编码 Python；按需加载 vs 预加载     |
| 约定锁       | MCP（原子写入）                                                                        | MCP research-conventions（原子写入，通用框架）                       | 相同机制，但通用框架而非物理专用                     |
| 项目状态     | MCP gpd-state                                                                          | MCP research-state（通用项目状态）                                   | 相同机制，但通用命名                                 |
| 报告格式验证 | MCP correctness_validators                                                             | skill SKILL.md 中的 oracle gate 程序                                 | prompt 注入 vs MCP 调用                              |
| 技能路由     | MCP skills_server route_skill                                                          | OpenCode skill_refs + slash commands                                 | 原生机制 vs 自建路由                                 |
| 协议路由     | MCP protocols_server route_protocol                                                    | skill_refs 本身                                                      | 原生机制 vs 自建路由                                 |

---

## 3.5 参考文档

### 文件结构

```
.opencode/
  agents/                                     → flat 结构 + 前缀命名
  │   research.md                             → 通用 research agent
  │   research-explorer.md                    → 通用 explorer subagent
  │   research-verifier.md                    → 通用 verifier subagent
  │   gpd-verifier.md                         → 物理插件 verifier (gpd- 前缀)
  │   gpd-reviewer.md                         → 物理插件 reviewer
  skills/                                     → 通用 skills (flat) + 插件 skills (plugins/ 子目录)
  │   deep-research/SKILL.md                  → 通用
  │   autoresearch/SKILL.md                   → 通用
  │   literature-review/SKILL.md              → 通用
  │   research-verification/SKILL.md          → 通用验证框架
  │   plugins/gpd/                            → 物理插件（可独立卸载/分享）
  │   │   gpd-verification/SKILL.md           → 验证程序 + scripts/
  │   │   │   scripts/dimensional_check.py
  │   │   │   scripts/limiting_case_check.py
  │   │   │   scripts/ward_identity_check.py
  │   │   │   scripts/symmetry_check.py
  │   │   │   scripts/spot_check.py
  │   │   │   scripts/convergence_check.py
  │   │   gpd-errors/SKILL.md                 → 错误目录 + references/
  │   │   │   references/error_catalog.json
  │   │   │   references/detection_strategies.json
  │   │   │   references/traceability_matrix.json
  │   │   gpd-domain-check/SKILL.md           → 领域 bundle + references/
  │   │   │   references/bundles/qft.json (12 domains)
  │   │   gpd-conventions/SKILL.md            → 约定程序 + references/
  │   │   │   references/convention_defaults.json
  │   │   │   references/subfield_defaults/physics.json
  │   plugins/bio/                            → 生物插件（假设未来有，示例）
  │   │   bio-verification/SKILL.md           → 生物验证程序
  │   │   bio-errors/SKILL.md                 → 生物错误目录
  get-physics-done/                           → 参考文档（物理领域参考，按需加载）
  │   references/verification/
  │   templates/
  │   paper-templates/
```

参考文档不注入 system prompt，而是通过 agent prompt_append 中的 `@` 引用路径，由 LLM 在需要时通过 `read` 工具按需加载（GPD 方式）。

**注意**: 错误目录和领域 bundle 数据文件不再放在 `get-physics-done/` 下，而是附在各自的 skills 中（references/ 子目录）。这样每个 skill 是自包含的，用户可以独立替换或移除某个 skill 而不影响其他。

---

## 3.6 项目持久化与恢复

### 状态文件

| 文件                              | 用途                 | 维护者                                     |
| --------------------------------- | -------------------- | ------------------------------------------ |
| `GPD/STATE.md`                    | 当前阶段、决定、阻碍 | research agent prompt_append 指示维护      |
| `GPD/state.json` project_contract | 约定锁定、项目合同   | gpd-conventions MCP 服务器读写             |
| `GPD/ROADMAP.md`                  | 阶段结构和进度       | research agent 的 deep-research skill 写入 |

### 恢复机制

与 Layer 2 原设计一致（research agent prompt_append 中包含恢复指令）。

---

## 3.7 Cherry-pick 验证（与 GPD 项目保持一致）

每个从 GPD cherry-pick 的数据文件包含 `gpd_source` 字段（与 overview 文档定义一致）。

**语义等价但计算增强**: GPD 使用 Python MCP 模块返回指引文本和关键词扫描。我们使用 JSON 数据格式 + skill SKILL.md 程序 + scripts 确定性计算。验证维度、红旗项、标准基准与 GPD 对应文件完全一致，但**计算验证由 scripts 执行而非依赖 LLM 判断**。

---

## 3.8 自定义检查的开发者指南

### 添加新验证脚本

1. 在 `.opencode/skills/plugins/gpd/gpd-verification/scripts/` 中创建 `my_check.py`
2. 实现标准接口: `def run(input_data: dict) -> dict`，返回 `{status, computation, evidence, confidence}`
3. 在 SKILL.md 的 Step 2 检查类型表中添加条目
4. verifier subagent 会通过 shell 工具调用新脚本

### 添加新错误类

1. 在 `.opencode/skills/plugins/gpd/gpd-errors/references/error_catalog.json` 中添加条目
2. 在 SKILL.md 的 Step 3 检测策略表中添加条目
3. 无需修改 MCP 服务器或核心代码

### 添加新领域 bundle

1. 在 `.opencode/skills/plugins/gpd/gpd-domain-check/references/bundles/` 中创建 `<domain>.json`
2. 在 SKILL.md 的 Step 1 域列表中添加条目
3. 无需修改 MCP 服务器或核心代码

### 替换验证 skill

1. 创建新 skill 目录（如 `.opencode/skills/my-verification/SKILL.md`）
2. 保持相同接口约定（Procedure 结构、script JSON 输入/输出格式）
3. 在 verifier agent 的 skill_refs 中替换 `gpd-verification` → `my-verification`
4. 无需修改 MCP 服务器或核心代码

---

## 验收测试

```
T3.1: research-conventions MCP 服务器启动后，mcp__research_conventions__convention_lock_status 可用
T3.2: research-conventions convention_set("metric_signature", "mostly-minus") 原子更新 state.json
T3.3: research-conventions convention_check 验证 ASSERT_CONVENTION 行与锁定一致
T3.4: research-conventions subfield_defaults("qft") 返回 QFT 默认约定（从 gpd-conventions skill 数据加载）
T3.5: research-state MCP 服务器启动后，mcp__research_state__get_state 可用
T3.6: research-state advance_plan 原子推进项目状态
T3.7: research-verification skill 通过 skill_refs 注入到 research-verifier prompt（通用框架）
T3.8: gpd-verification skill 通过 skill_refs 注入到 gpd-verifier prompt（物理插件）
T3.9: dimensional_check.py 接受 JSON 输入，返回 {status, computation, evidence, confidence}
T3.10: dimensional_check.py 用 SymPy 解析原始表达式（非预标注括号），追踪维度
T3.11: limiting_case_check.py 用 sympy.limit() 计算极限值（非关键词扫描）
T3.12: ward_identity_check.py 用 sympy.simplify() 验证 q_μ*M^μ = 0（确定性计算）
T3.13: gpd-errors skill 通过 skill_refs 注入（在 plugins/gpd/ 目录），references/error_catalog.json 包含 20 个物理错误类
T3.14: gpd-domain-check skill 通过 skill_refs 注入（在 plugins/gpd/ 目录），references/bundles/qft.json 包含 QFT 验证清单
T3.15: gpd-verifier agent 调用 gpd-verification scripts 获取确定性计算结果
T3.16: gpd-verifier agent 调用 research-conventions MCP 进行约定锁读写
T3.17: research-verifier agent 仅有 research-verification skill（无 gpd-* 物理插件）
T3.18: cherry-pick 验证: qft.json 的检查维度与 GPD verification-domain-qft.md 语义等价
T3.19: 修改 error_catalog.json 添加新错误类后，gpd-errors skill 识别新类
T3.20: 添加 scripts/my_check.py + 注册后，gpd-verifier 可调用新检查
T3.21: 仅 2 个 MCP 进程运行（research-conventions + research-state），不影响 OpenCode 核心
T3.22: 删除 MCP 配置 + skills 后，OpenCode 核心行为不变
T3.23: 非物理领域用户可使用 research-verifier + 自己的领域验证 skills（无需 gpd-* 插件）
```
