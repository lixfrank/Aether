# Layer 3: Research Infrastructure — 双层命名架构

> 前置依赖: Layer 0-2（核心安全 + Agent 基础设施 + Research 配置层）
> 本文档是 5 层重构计划的第四层。除 Layer 0 微改动（findOrInstallUv + skill_refs path injection）外，**零核心源文件改动** — 全部通过 `.aether/` 目录和 `~/.aether/` 用户级目录中的文件实现。
> 完成后，research-verifier（通用）可通过 skills+scripts 执行验证，gpd-verifier（物理插件）可额外执行确定性物理计算。

---

## 上下文

| Layer       | 状态            | 简介                                                                          |
| ----------- | --------------- | ----------------------------------------------------------------------------- |
| Layer 0     | 已完成          | Permission/Discipline/Info 扩展 + findOrInstallUv + skill_refs path injection |
| Layer 1     | 已完成          | output_dir、fallback_models、MCP per-agent、denied tools                      |
| Layer 2     | 已完成          | Research agent/skill 配置文件（零核心源改动）                                 |
| **Layer 3** | **本文档**      | MCP 状态层 + Skills/Scripts 计算层                                            |
| Layer 4     | 在 Layer 3 之后 | Publication 管线                                                              |
| Layer 5     | 在 Layer 4 之后 | Background 执行                                                               |

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
| **MCP（持久状态）**       | MCP 服务器               | 约定锁读写（原子）、项目状态管理、skill 路径查询           | 不做物理计算、不返回指引文本  |

### MCP/Skill 数据交互边界

**原则**：MCP 只管理持久状态（原子读写），不嵌入领域数据。领域数据由 skill 提供。

| 层        | 职责                                                                      | 数据来源                                      | 不做什么                         |
| --------- | ------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------- |
| **MCP**   | 持久状态的原子读写（state.json、convention lock）                         | MCP 内部数据结构                              | 不嵌入领域数据文件，不做物理计算 |
| **Skill** | 行为指引（SKILL.md）+ 领域数据文件（references/）+ 确定性计算（scripts/） | skill 目录内的文件                            | 不做原子状态读写，不做持久化     |
| **Agent** | 逻辑编排——决定何时调用 MCP、何时加载 skill、何时运行 script               | MCP 工具返回值 + skill 注入内容 + script 输出 | 不做原子操作，不做确定性计算     |

当 MCP 需要读取 skill 的领域数据（如 `subfield_defaults("qft")` 需要物理约定默认值），通过 `skill_resolve_path` 工具定位 skill 目录，再读取 skill 内的 JSON 数据文件。MCP 不硬编码领域数据路径。

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
    Loads defaults from skill references via skill_resolve_path.
    Physics defaults loaded from gpd-conventions/references/convention_defaults/physics.json.
    Other domain defaults loaded from corresponding skill data."""

@mcp_tool("skill_resolve_path")
def skill_resolve_path(skill_name: str, relative_path: str = "") -> dict:
    """Resolve the absolute path to a skill directory or a specific file within it.
    Scans known skill directories (.aether/skill/, .opencode/skills/, global skill paths)
    for a skill matching the given name (from SKILL.md frontmatter name field).
    Returns: {skill_dir: str, resolved_path: str | None, found: bool}
    MCP servers use this to locate domain-specific data files bundled in skills."""
```

**移除的工具**（转至 skill）：`convention_diff`（两个阶段约定对比 — 两个文件读 + 字典减法，agent 自行完成）、`convention_diff`（对比两个约定锁 — 纯 dict 操作，不需要 MCP）。

#### 注册方式

MCP 服务器源码放在 `~/.aether/mcp/research-conventions/`，使用 `uv run` + PEP 723 inline script metadata 启动：

```json
{
  "mcp": {
    "research-conventions": {
      "type": "local",
      "command": ["uv", "run", "~/.aether/mcp/research-conventions/server.py"],
      "enabled": true
    }
  }
}
```

`uv run` 自动解析 server.py 头部的 PEP 723 inline dependencies（`mcp`, `pydantic`），创建临时 venv，安装依赖，执行脚本。如果 `uv` 不可用，Aether 核心的 `findOrInstallUv()` 函数自动安装到 `~/.aether/bin/uv`。

#### 数据存储

`.aether/research/persistence/state.json`（见 §3.7 项目持久化）。

#### 子领域默认约定

物理领域的默认值由 gpd-conventions skill 提供（作为插件数据）。MCP 服务器通过 `skill_resolve_path("gpd-conventions")` 定位 skill 目录，再读取 `references/convention_defaults/physics.json`。其他领域可注册自己的默认值文件——只要存在对应的 skill 并在 references/ 中放置数据文件。

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
      "command": ["uv", "run", "~/.aether/mcp/research-state/server.py"],
      "enabled": true
    }
  }
}
```

---

## 3.2 research-\* Skills（通用框架层）

### 3.2.1 research-verification skill

**通用验证程序框架**——适用于任何研究领域。物理领域用户在此基础上叠加 gpd-\* 物理插件。

**核心创新**：替代 GPD 的 verification MCP 服务器。GPD 的 MCP 只返回指引文本和关键词扫描结果。我们的 skill 提供**行为指引**（SKILL.md），**确定性计算**（scripts/），**数据文件**（references/）。

#### 文件

`.aether/skill/research-verification/SKILL.md`

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

**Skills** 放在 `.aether/skill/plugins/gpd/` 子目录中，利用 OpenCode 的 `**/SKILL.md` glob 发现 + frontmatter `name` 字段命名，**零代码改动**即可实现插件隔离：

```
.aether/skill/plugins/gpd/gpd-verification/SKILL.md  → skill name: "gpd-verification"
.aether/skill/plugins/gpd/gpd-errors/SKILL.md         → skill name: "gpd-errors"
.aether/skill/plugins/gpd/gpd-domain-check/SKILL.md   → skill name: "gpd-domain-check"
.aether/skill/plugins/gpd/gpd-conventions/SKILL.md    → skill name: "gpd-conventions"
```

**Agents** 保持 flat 结构 + `gpd-` 前缀（因为 agent name 由路径推导）：

```
.aether/agent/gpd-verifier.md    → agent name: "gpd-verifier"
.aether/agent/gpd-reviewer.md    → agent name: "gpd-reviewer"
```

**插件管理**：

- **卸载**：删除 `.aether/skill/plugins/gpd/` 目录 + 删除 `.aether/agent/gpd-*.md`
- **分享**：打包 `plugins/gpd/` + flat agents + MCP 配置建议
- **其他领域插件**：创建 `.aether/skill/plugins/bio/` + `.aether/agent/bio-verifier.md`

### 3.3.1 gpd-verification skill

物理领域插件——确定性物理计算验证。替代 GPD 的 verification MCP 服务器（8 个 MCP 工具）。

**与 GPD 的关键差异**：GPD 的 verification MCP 实际分为两类：

1. **关键词扫描工具**（`run_check`、`limiting_case_check`、`symmetry_check`）——只做文本模式匹配和返回指引文本
2. **部分有实际计算的合约验证**（`run_contract_check` 中的 benchmark reproduction、proof coverage 等）——做数值比较和集合运算

我们的方案将**关键词扫描全部替换为确定性 SymPy 计算**，将**合约验证保留为结构化 JSON schema**，将**检查注册表和数据文件**从 MCP 硬编码 Python dict 移至 skill 内的 JSON 数据文件。

#### 文件

`.aether/skill/plugins/gpd/gpd-verification/SKILL.md`

```yaml
---
name: gpd-verification
description: Physics verification with deterministic computational scripts (SymPy).
Establish contract targets, execute computational checks, produce VERIFICATION.md.
Supplements research-verification with domain-specific physics computation.
---

# Physics Verification (Deterministic Computation Layer)

## When to Use
During verification of physics research results. Used by gpd-verifier subagent
(research-verification provides the general framework; this skill adds physics-specific
computation).

## Verification Computation Procedure

### Step 1: Load Verification Check Registry
Read `references/check_registry.json` for the 24 verification check definitions
(14 universal + 10 contract-aware). Each entry specifies: id, key, name, tier,
catches, evidence_kind, and which script implements it.

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

Checks marked `computational` MUST use scripts when available. Checks marked `hybrid`
may use LLM judgment but MUST also attempt script verification when available.

### Step 3: Execute Computational Checks
Invoke scripts via shell using uv run + PEP 723. Each script accepts JSON input
and returns JSON output (see §3.10 Script Calling Interface).

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
VERIFICATION.md must contain at least one **computational oracle block**:
actual executed script output (not just "I ran the script" — paste the JSON output).

## Do Not
- Do not report "independently confirmed" based on LLM-only reasoning
- Do not skip computational oracle — must include actual script output
- Do not use keyword scanning instead of script computation where scripts exist
- Do not fabricate verification evidence
- Do not override a script `fail` verdict with LLM reasoning
```

#### References 目录

`.aether/skill/plugins/gpd/gpd-verification/references/`

- `check_registry.json` — 24 验证检查定义（id, key, tier, catches, evidence_kind, script_name, gpd_source）
- `contract_checks.json` — 10 合约检查的字段 schema 和 binding targets（cherry-pick from GPD verification_contract_policy.py）
- `domain_checklists/` — 13 物理领域清单（cherry-pick from GPD DOMAIN_CHECKLISTS dict，含 gpd_source）

#### Scripts 目录

`.aether/skill/plugins/gpd/gpd-verification/scripts/`

6 个确定性计算脚本，每个使用 PEP 723 inline metadata 声明 SymPy 依赖（见 §3.9 Python 依赖管理）：

| 脚本                     | GPD 对应                                            | 改进                                     |
| ------------------------ | --------------------------------------------------- | ---------------------------------------- |
| `dimensional_check.py`   | GPD `dimensional_check`（预标注 `[M][L]^2` 解析）   | SymPy 解析**原始表达式**，自动推断维度   |
| `limiting_case_check.py` | GPD `limiting_case_check`（关键词扫描 "limit"/"→"） | `sympy.limit()` **实际计算极限值**       |
| `ward_identity_check.py` | GPD `run_check` 返回 oracle_hint；LLM 自己写 SymPy  | `sympy.simplify(q_μ·M^μ)` **确定性验证** |
| `symmetry_check.py`      | GPD `symmetry_check`（返回策略描述文本）            | SymPy 变换验证模板                       |
| `spot_check.py`          | GPD `run_check` 5.2 无对应脚本                      | 数值代入验证（新增）                     |
| `convergence_check.py`   | GPD `run_check` 5.5 无对应脚本                      | 收敛阈值测试（新增）                     |

### 3.3.2 gpd-errors skill

物理领域插件——LLM 物理推理错误目录。替代 GPD 的 errors MCP 服务器。

#### 文件

`.aether/skill/plugins/gpd/gpd-errors/SKILL.md`

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

`.aether/skill/plugins/gpd/gpd-errors/references/`

- `error_catalog.json` — 20 最高风险错误类（含 gpd_source 字段）
- `detection_strategies.json` — 每个错误类的详细检测策略和示例
- `traceability_matrix.json` — 错误类 → 验证检查方法映射

---

### 3.3.3 gpd-domain-check skill

物理领域插件——物理领域验证 bundle。替代 GPD 的 verification MCP 中的 domain checklist 功能。

#### 文件

`.aether/skill/plugins/gpd/gpd-domain-check/SKILL.md`

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

`.aether/skill/plugins/gpd/gpd-domain-check/references/bundles/`

12 个领域 bundle JSON 文件（含 gpd_source 字段）。qft.json 包含完整的 priority_checks、specific_red_flags 和 standard_benchmarks。

---

### 3.3.4 gpd-conventions skill

物理领域插件——物理约定程序和默认值。MCP 提供通用约定锁框架，gpd-conventions skill 提供物理领域的具体约定内容和 14 个子领域默认值。

#### 文件

`.aether/skill/plugins/gpd/gpd-conventions/SKILL.md`

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

#### References 目录

`.aether/skill/plugins/gpd/gpd-conventions/references/`

- `convention_defaults.json` — 14 物理子领域默认约定（含 gpd_source）
- `subfield_defaults/physics.json` — QFT 等子领域详细约定配置

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

**保留的 MCP**：research-conventions（通用约定锁框架 + skill_resolve_path）、research-state（通用项目状态管理）。2 个 MCP 进程替代 GPD 的 8 个。

---

## 3.5 与 GPD 的架构对比

| 功能         | GPD 实现                                                                               | 我们实现                                                            | 改进点                                               |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| 维度分析     | MCP dimensional_check：解析预标注 `[M][L]^2` 括号，关键词扫描                          | script dimensional_check.py：SymPy 解析原始表达式，追踪维度         | 确定性计算 vs 关键词扫描；原始表达式 vs 预标注       |
| 极限推导     | MCP limiting_case_check：关键词扫描 "limit"/"→" 是否出现，返回 `requires_verification` | script limiting_case_check.py：`sympy.limit()` 实际计算极限值       | 确定性计算 vs 关键词扫描；实际推导 vs 文档存在性检查 |
| Ward 恒等式  | MCP run_check 返回 oracle_hint 文本；LLM 自己写 SymPy 并自己判断                       | script ward*identity_check.py：`sympy.simplify(q*μ·M^μ)` 确定性验证 | 确定性计算 vs LLM 自写代码自判断                     |
| 对称性验证   | MCP symmetry_check：返回策略描述文本                                                   | script symmetry_check.py：SymPy 变换验证模板                        | 确定性计算 vs 文本指引                               |
| 错误目录     | MCP 从 markdown 解析 104 类，返回 JSON                                                 | skill references/error_catalog.json（精选 20 类）+ SKILL.md 程序    | 预加载 vs 按需查询；精选 vs 全量                     |
| 领域清单     | MCP 硬编码 DOMAIN_CHECKLISTS 字典                                                      | skill references/bundles/\*.json 数据文件                           | 可修改 JSON vs 硬编码 Python；按需加载 vs 预加载     |
| 约定锁       | MCP（原子写入）                                                                        | MCP research-conventions（原子写入，通用框架）                      | 相同机制，但通用框架而非物理专用                     |
| 项目状态     | MCP gpd-state                                                                          | MCP research-state（通用项目状态）                                  | 相同机制，但通用命名                                 |
| 报告格式验证 | MCP correctness_validators                                                             | skill SKILL.md 中的 oracle gate 程序                                | prompt 注入 vs MCP 调用                              |
| 技能路由     | MCP skills_server route_skill                                                          | OpenCode skill_refs + slash commands                                | 原生机制 vs 自建路由                                 |
| 协议路由     | MCP protocols_server route_protocol                                                    | skill_refs 本身                                                     | 原生机制 vs 自建路由                                 |
| 领域数据加载 | MCP 硬编码 Python dict                                                                 | MCP skill_resolve_path → skill references/ JSON                     | 动态发现 vs 硬编码；skill 自包含 vs MCP 内嵌         |

---

## 3.6 文件结构

```
~/.aether/
  bin/uv                                    → Aether 自动安装的 uv 二进制（~10MB，单文件）
  mcp/
    research-conventions/
      server.py                             → research-conventions MCP 服务器源码（PEP 723 inline deps）
    research-state/
      server.py                             → research-state MCP 服务器源码（PEP 723 inline deps）

.aether/                                     → 项目级配置和数据
  agent/                                     → flat 结构 + 前缀命名
  │   research.md                             → 通用 research agent
  │   research-explorer.md                    → 通用 explorer subagent
  │   research-verifier.md                    → 通用 verifier subagent
  │   gpd-verifier.md                         → 物理插件 verifier (gpd- 前缀)
  │   gpd-reviewer.md                         → 物理插件 reviewer
  skill/                                     → 通用 skills (flat) + 插件 skills (plugins/ 子目录)
  │   deep-research/SKILL.md                  → 通用
  │   autoresearch/SKILL.md                   → 通用
  │   literature-review/SKILL.md              → 通用
  │   research-verification/SKILL.md          → 通用验证框架
  │   plugins/gpd/                            → 物理插件（可独立卸载/分享）
  │   │   gpd-verification/SKILL.md           → 验证程序 + scripts/ + references/
  │   │   │   scripts/dimensional_check.py    → SymPy 维度追踪（PEP 723 inline deps）
  │   │   │   scripts/limiting_case_check.py  → sympy.limit() 极限计算
  │   │   │   scripts/ward_identity_check.py  → sympy.simplify() Ward 恒等式
  │   │   │   scripts/symmetry_check.py       → SymPy 变换验证
  │   │   │   scripts/spot_check.py           → 数值 spot-check
  │   │   │   scripts/convergence_check.py    → 收敛阈值测试
  │   │   │   references/check_registry.json  → 24 验证检查定义
  │   │   │   references/contract_checks.json → 10 合约检查 schema
  │   │   │   references/domain_checklists/   → 13 物理领域清单 JSON
  │   │   gpd-errors/SKILL.md                 → 错误目录 + references/
  │   │   │   references/error_catalog.json   → 20 物理错误类
  │   │   │   references/detection_strategies.json
  │   │   │   references/traceability_matrix.json
  │   │   gpd-domain-check/SKILL.md           → 领域 bundle + references/
  │   │   │   references/bundles/qft.json     → 12 物理领域 bundles
  │   │   gpd-conventions/SKILL.md            → 约定程序 + references/
  │   │   │   references/convention_defaults.json
  │   │   │   references/subfield_defaults/physics.json
  │   plugins/bio/                            → 生物插件（假设未来有，示例）
  │   │   bio-verification/SKILL.md           → 生物验证程序
  │   │   bio-errors/SKILL.md                 → 生物错误目录
  research/                                   → 通用研究持久化（所有 research agent 共享）
  │   persistence/
  │   │   STATE.md                            → 当前阶段、决定、阻碍
  │   │   state.json                          → 结构化状态（convention lock、phase、plan number）
  │   │   ROADMAP.md                          → 阶段结构和进度
  │   │   PLAN.md                             → 当前 phase 合约
  │   │   VERIFICATION.md                     → 验证报告（每次验证追加）
```

**与原设计的关键变更**：

1. **移除 `get-physics-done/` 参考文档目录**：所有领域数据文件（错误目录、领域 bundles、检查注册表）已附在各自的 skills 中（references/ 子目录）。每个 skill 自包含，用户可以独立替换或移除某个 skill 而不影响其他。Agent 通过 skill_refs 注入获取 skill 目录路径（Layer 0 微改动），然后用 Read 工具读取 references/ 文件。

2. **MCP 服务器源码放在 `~/.aether/mcp/`**：用户级目录，不污染项目目录。使用 `uv run` + PEP 723 启动，无需全局安装 Python 包。

3. **项目持久化放在 `.aether/research/persistence/`**：通用 research 范畴，非 GPD 独有。任何使用 research agent 的项目都会构造此持久化记录。

---

## 3.7 项目持久化与恢复

项目持久化是**所有 research agent 的通用功能**，而非 GPD 独有内容。任何使用 research agent 的项目都会在 `.aether/research/persistence/` 下构造持久化记录。

### 状态文件

| 文件                                           | 用途                                                                | 维护者                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `.aether/research/persistence/STATE.md`        | 当前阶段、决定、阻碍                                                | research agent prompt_append 指示维护                                 |
| `.aether/research/persistence/state.json`      | 结构化状态（convention lock、phase、plan number、project_contract） | research-state MCP 读写 + research-conventions MCP 写 convention lock |
| `.aether/research/persistence/ROADMAP.md`      | 阶段结构和进度                                                      | research agent 的 deep-research skill 写入                            |
| `.aether/research/persistence/PLAN.md`         | 当前 phase 合约（claims, deliverables, acceptance_tests）           | research agent prompt_append 指示写入                                 |
| `.aether/research/persistence/VERIFICATION.md` | 验证报告（每次验证追加）                                            | verifier subagent 写入                                                |

### 与 output_dir 的关系

Layer 1 的 `output_dir` 配置允许 agent 指定输出目录。如果 research agent 配置了 `output_dir: ".aether/research"`，则持久化文件在 `.aether/research/persistence/` 下。如果没有配置 output_dir，默认仍在 `.aether/research/persistence/` 下。

### 恢复机制

research agent 的 prompt_append 中包含恢复指令：session 开始时读取 `.aether/research/persistence/STATE.md` 和 `state.json`，恢复上次中断的阶段和决定。

---

## 3.8 Cherry-pick 验证（与 GPD 项目保持一致）

每个从 GPD cherry-pick 的数据文件包含 `gpd_source` 字段（与 overview 文档定义一致）。

**语义等价但计算增强**: GPD 使用 Python MCP 模块返回指引文本和关键词扫描。我们使用 JSON 数据格式 + skill SKILL.md 程序 + scripts 定性计算。验证维度、红旗项、标准基准与 GPD 对应文件完全一致，但**计算验证由 scripts 执行而非依赖 LLM 判断**。

---

## 3.9 Python 依赖管理（uv + PEP 723）

### 方案选择

| 方案             | 优点                                                       | 缺点                         | 自动安装可行性             |
| ---------------- | ---------------------------------------------------------- | ---------------------------- | -------------------------- |
| venv             | 标准工具                                                   | 需手动创建+维护，pip 慢      | 低——无法自动 bootstrap     |
| **uv + PEP 723** | 单二进制（~10MB），自动安装 Python，秒级 venv，inline deps | 需安装 uv（Aether 自动完成） | **高**——Aether 自动安装 uv |
| Bun spawn 扩展   | 可完全自动化                                               | 需改动核心源文件             | 高但侵入性高               |

### 选择：uv + PEP 723

**理由**：

1. uv 是单二进制，Aether 通过 `findOrInstallUv()` 自动安装到 `~/.aether/bin/uv`（Layer 0 微改动）
2. PEP 723 inline script metadata 让脚本自声明依赖，`uv run` 自动解析并安装
3. MCP 服务器使用 `uv run server.py` 启动，无需全局安装 Python 包
4. 无 uv 时退化为 `python3 -m` 方式，要求用户手动安装依赖（与现有 PDF converter 行为一致）

### PEP 723 示例（script）

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12", "numpy>=1.24"]
# ///
import sympy
# ... script body
```

执行：`uv run dimensional_check.py '{"expression": "..."}'`

### PEP 723 示例（MCP server）

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0", "pydantic>=2.0", "filelock>=3.0"]
# ///
from mcp.server.fastmcp import FastMCP
# ... server body
```

执行：`uv run ~/.aether/mcp/research-conventions/server.py`

### findOrInstallUv() — Layer 0 微改动

Aether 核心新增函数 `findOrInstallUv()`（放在 `packages/opencode/src/util/python.ts` 或类似位置）：

1. 检查 `~/.aether/bin/uv` 是否存在
2. 检查 PATH 中是否有 `uv`
3. 如果两者都没有，从官方源下载 uv 单二进制到 `~/.aether/bin/uv`
4. 返回 uv 的绝对路径

此函数仅在未来 Layer 5（background execution）或 MCP 启动时使用，不影响现有功能。属于 Layer 0 级别的通用基础设施改动。

---

## 3.10 Script 调用接口规范

### 入口方式

脚本同时支持 CLI 参数和 stdin（Python 标准模式），优先使用 CLI 参数（小输入），stdin 用于大 JSON：

```python
import json, sys

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: script.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(input_data: dict) -> dict:
    # ... computation
    pass

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)
```

### 输入 JSON schema

每个脚本有特定输入字段，但共享通用外壳：

```json
{
  "expression": "string — SymPy-parseable expression",
  "context": {
    "domain": "string — physics domain",
    "conventions": {
      "metric_signature": "mostly-minus|mostly-plus",
      "natural_units": "natural|SI|geometric"
    }
  },
  "check_specific_fields": { ... }
}
```

各脚本特有字段：

| 脚本                     | 必需输入字段                                   |
| ------------------------ | ---------------------------------------------- |
| `dimensional_check.py`   | `expression`, `expected_dimensions`（可选）    |
| `limiting_case_check.py` | `expression`, `limits`（dict: 变量→极限值）    |
| `ward_identity_check.py` | `amplitude`, `momentum`, `polarization`        |
| `symmetry_check.py`      | `expression`, `symmetry_type`, `transform`     |
| `spot_check.py`          | `expression`, `test_values`（dict: 变量→数值） |
| `convergence_check.py`   | `series`, `order`, `threshold`                 |

### 输出 JSON schema

统一输出格式：

```json
{
  "status": "pass | fail | warning | insufficient_evidence",
  "computation": "string — human-readable description of what was computed",
  "evidence": "string — SymPy computation trace or numerical result",
  "confidence": 0.0-1.0,
  "details": { ... }
}
```

### 错误处理

| 情况                    | 脚本行为                                           | Agent 应如何处理                                      |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| SymPy 无法解析表达式    | `status: "insufficient_evidence", confidence: 0.0` | 降级为 LLM 判断，标注 "script unable to parse"        |
| 依赖缺失（无 SymPy/uv） | stderr 错误信息，exit code 1                       | 降级为 LLM 判断，标注 "script dependency unavailable" |
| JSON 输入格式错误       | stderr schema 错误，exit code 2                    | 检查输入格式，修正后重试                              |
| 计算超时                | MCP timeout → `status: "warning"`                  | 记录为 "timeout"，不覆盖为 pass                       |
| Script pass             | `status: "pass"`                                   | 记录为 independently confirmed                        |
| Script fail             | `status: "fail"`                                   | **不得用 LLM reasoning override**                     |

### Agent 路由机制

两层路由：

- `research-verification` SKILL.md Step 2 提供通用检查分类表
- `gpd-verification` SKILL.md Step 2 提供物理检查→script 映射表

Agent 查阅 SKILL.md 的映射表，确定 `check_id → script_name`，构造 JSON 输入，通过 shell 执行。

---

## 3.11 Skill References 访问机制

### skill_refs 注入提供 skill 目录路径

Layer 0 微改动：`system.ts` 的 skill_refs 注入添加 skill 目录路径（`file://` URL）：

```typescript
// system.ts line 67 — 修改后
...found.map((s) => [
  `### Skill: ${s.name}`,
  `Skill directory: ${pathToFileURL(path.dirname(s.location)).href}`,
  s.content
].join("\n"))
```

此改动使 skill_refs agent 能解析 SKILL.md 中的相对路径（如 `references/error_catalog.json`），用 Read 工具拼接 `base_dir + relative_path` 读取绝对路径文件。

### 三层可见性保障

| 层                      | 机制                                      | 保障                                                 |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------- |
| SkillTool（一次性加载） | base directory URL + sampled 10 files     | 已有机制                                             |
| skill_refs 注入         | Skill name + directory URL + full content | Layer 0 微改动新增 directory                         |
| Agent 主动发现          | list/glob/read 工具访问 skill 目录        | 已有机制（skill 目录在 external_directory 白名单中） |

有了 skill 目录路径注入后，移除 `get-physics-done/` 独立参考目录完全合理——skill-bundled references 的可访问性优于独立目录方式（SKILL.md 作为 manifest 比 `@path` 引用更丰富且自包含）。

---

## 3.12 自定义检查的开发者指南

### 添加新验证脚本

1. 在 `.aether/skill/plugins/gpd/gpd-verification/scripts/` 中创建 `my_check.py`
2. 添加 PEP 723 inline metadata（声明依赖）
3. 实现标准接口：CLI 参数或 stdin 接收 JSON，stdout 返回 `{status, computation, evidence, confidence}`
4. 在 SKILL.md 的 Step 2 检查类型表中添加条目
5. verifier subagent 会通过 `uv run scripts/my_check.py '<json>'` 调用新脚本

### 添加新错误类

1. 在 `.aether/skill/plugins/gpd/gpd-errors/references/error_catalog.json` 中添加条目
2. 在 SKILL.md 的 Step 3 检测策略表中添加条目
3. 无需修改 MCP 服务器或核心代码

### 添加新领域 bundle

1. 在 `.aether/skill/plugins/gpd/gpd-domain-check/references/bundles/` 中创建 `<domain>.json`
2. 在 SKILL.md 的 Step 1 域列表中添加条目
3. 无需修改 MCP 服务器或核心代码

### 替换验证 skill

1. 创建新 skill 目录（如 `.aether/skill/my-verification/SKILL.md`）
2. 保持相同接口约定（Procedure 结构、script JSON 输入/输出格式）
3. 在 verifier agent 的 skill_refs 中替换 `gpd-verification` → `my-verification`
4. 无需修改 MCP 服务器或核心代码

---

## 验收测试

```
T3.1: research-conventions MCP 服务器通过 uv run 启动后，mcp__research_conventions__convention_lock_status 可用
T3.2: research-conventions convention_set("metric_signature", "mostly-minus") 原子更新 .aether/research/persistence/state.json
T3.3: research-conventions convention_check 验证 ASSERT_CONVENTION 行与锁定一致
T3.4: research-conventions subfield_defaults("qft") 通过 skill_resolve_path 定位 gpd-conventions skill，返回 QFT 默认约定
T3.5: research-conventions skill_resolve_path("gpd-errors") 返回 gpd-errors skill 目录的绝对路径
T3.6: research-state MCP 服务器通过 uv run 启动后，mcp__research_state__get_state 可用
T3.7: research-state advance_plan 原子推进项目状态
T3.8: research-verification skill 通过 skill_refs 注入到 research-verifier prompt（通用框架）
T3.9: gpd-verification skill 通过 skill_refs 注入到 gpd-verifier prompt（物理插件）
T3.10: skill_refs 注入包含 skill directory URL（file:// 格式），agent 可用 Read 工具读取 references 文件
T3.11: dimensional_check.py 接受 JSON 输入（CLI 或 stdin），返回 {status, computation, evidence, confidence}
T3.12: dimensional_check.py 用 SymPy 解析原始表达式（非预标注括号），追踪维度
T3.13: limiting_case_check.py 用 sympy.limit() 计算极限值（非关键词扫描）
T3.14: ward_identity_check.py 用 sympy.simplify() 验证 q_μ·M^μ = 0（确定性计算）
T3.15: 所有 scripts 使用 PEP 723 inline metadata 声明 sympy 依赖，uv run 自动安装
T3.16: gpd-errors skill 通过 skill_refs 注入，references/error_catalog.json 包含 20 个物理错误类
T3.17: gpd-domain-check skill 通过 skill_refs 注入，references/bundles/qft.json 包含 QFT 验证清单
T3.18: gpd-verifier agent 调用 gpd-verification scripts 获取确定性计算结果
T3.19: gpd-verifier agent 调用 research-conventions MCP 进行约定锁读写
T3.20: research-verifier agent 仅有 research-verification skill（无 gpd-* 物理插件）
T3.21: cherry-pick 验证: qft.json 的检查维度与 GPD verification-domain-qft.md 语义等价
T3.22: 修改 error_catalog.json 添加新错误类后，gpd-errors skill 识别新类
T3.23: 添加 scripts/my_check.py + PEP 723 + SKILL.md 注册后，gpd-verifier 可调用新检查
T3.24: 仅 2 个 MCP 进程运行（research-conventions + research-state），不影响 OpenCode 核心
T3.25: 删除 MCP 配置 + skills 后，OpenCode 核心行为不变
T3.26: 非物理领域用户可使用 research-verifier + 自己的领域验证 skills（无需 gpd-* 插件）
T3.27: 项目持久化文件位于 .aether/research/persistence/（非 GPD/ 独有目录）
T3.28: findOrInstallUv() 自动安装 uv 到 ~/.aether/bin/uv（Layer 0 微改动）
T3.29: MCP 服务器源码在 ~/.aether/mcp/ 目录下，不污染项目目录
T3.30: skill_resolve_path 可定位任意 skill 目录，MCP 不硬编码领域数据路径
```
