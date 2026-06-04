# Layer 3: Research Infrastructure — MCP Verification Servers & Reference Docs

> 前置依赖: Layer 0-2（核心安全 + Agent 基础设施 + Research 配置层）
> 本文档是 5 层重构计划的第四层。提供 MCP 服务器和参考文档，使 verifier 子代理的验证方案**可灵活自定义**。
> 完成后，gpd-verifier 子代理可以通过 MCP 工具使用结构化验证、约定锁定、错误目录。

---

## 上下文

| Layer       | 状态            | 简介                                                |
| ----------- | --------------- | --------------------------------------------------- |
| Layer 0     | 已完成          | Permission/Discipline/Info 扩展                     |
| Layer 1     | 已完成          | mode-switch/fallback/background/MCP per-agent       |
| Layer 2     | 已完成          | Research agent/skill 配置文件（零核心源改动）       |
| **Layer 3** | **本文档**      | MCP 服务器 + 参考文档（独立进程，不影响核心运行时） |
| Layer 4     | 在 Layer 3 之后 | Publication 管线                                    |

---

## 设计原则

- **MCP 服务器作为验证方案提供者**: verifier 子代理通过 MCP 工具获取验证清单、运行检查，而非硬编码的 prompt 指令
- **灵活自定义**: 用户可以修改 MCP 服务器配置（添加新检查类型、修改检查清单内容）或替换整个 MCP 服务器
- **物理验证作为示例**: GPD 的物理验证体系作为 MCP 服务器的**具体实现示例**，同时作为其他开发者编写自定义验证方案的参考
- **独立进程**: MCP 服务器以独立 Python 进程运行，不影响 OpenCode 核心运行时

---

## 3.1 MCP 服务器架构

### 注册方式

在 `opencode.json` 的 `mcp` 字段中添加（由 research agent 的 `mcp` 配置在 mode enter 时 activate）:

```json
{
  "mcp": {
    "gpd-conventions": {
      "type": "local",
      "command": ["python3", "-m", "gpd_conventions_server"],
      "enabled": true
    },
    "gpd-verification": {
      "type": "local",
      "command": ["python3", "-m", "gpd_verification_server"],
      "enabled": true
    },
    "gpd-errors": {
      "type": "local",
      "command": ["python3", "-m", "gpd_errors_server"],
      "enabled": true
    }
  }
}
```

### 灵活自定义方法

用户自定义验证方案有三种方式:

1. **修改 MCP 服务器配置数据**（最简单）: MCP 服务器从 JSON/YAML 数据文件读取检查清单和错误类定义。用户修改数据文件即可改变验证行为，无需改代码。

2. **替换 MCP 服务器实现**（中等）: 用自定义 Python 模块替换 `gpd_verification_server`，保持相同的 tool 名称和 schema（tool interface 不变），但实现不同的检查逻辑。

3. **添加新 MCP 服务器**（最灵活）: 注册新的 MCP 服务器（如 `my-domain-verification`），在 verifier agent 的 permission 中添加对应的 MCP 工具权限，在 prompt_append 中引用新工具。

每个 MCP 服务器遵循 GPD 的 `registry_prefix` 约定（如 `gpd_verification`、`gpd_conventions`），OpenCode 将 MCP tool name 转换为 `mcp__<prefix>__<tool_name>` 格式。

---

## 3.2 gpd-verification MCP 服务器（核心验证方案）

### 功能

提供结构化验证检查接口，**不硬编码**具体检查内容。检查内容由数据文件定义，用户可修改。

### Tool Schema

```python
# gpd_verification_server tools

@mcp_tool("suggest_contract_checks")
def suggest_contract_checks(contract: dict, project_dir: str) -> dict:
    """Given a PLAN contract (claims, deliverables, acceptance_tests, forbidden_proxies),
    suggest which verification checks should be run. Returns list of suggested check
    requests with templates."""
    # Reads contract, matches claims to check types from check_registry.json
    # Returns: [{check_type, request_template, required_fields, subject_id}]

@mcp_tool("run_contract_check")
def run_contract_check(request: dict, project_dir: str) -> dict:
    """Execute a specific verification check. Flexible: user defines what to check.
    Request format: {check_type, subject_id, parameters, expected_result, actual_result_path}"""
    # Loads check implementation from checks/ directory
    # Returns: {status: pass/fail/inconclusive, evidence, computation_output}

@mcp_tool("run_check")
def run_check(check_type: str, input: dict) -> dict:
    """Run a generic check by type. Types loaded from check_registry.json.
    Built-in types: dimensional, limiting_case, symmetry, conservation,
    math_consistency, convergence, literature_agreement, plausibility,
    statistical_rigor, spot_check, cross_check."""
    # Dispatches to check implementation module

@mcp_tool("get_bundle_checklist")
def get_bundle_checklist(bundle_ids: list[str]) -> dict:
    """Get domain-specific verification checklist. Bundles defined in bundles/ directory.
    Physics bundles: qft, condensed_matter, stat_mech, numerical, gr, nuclear_particle,
    quantum_info, optics, astro, fluid, materials, genomics."""
    # Loads from bundles/<domain>.json

@mcp_tool("get_checklist")
def get_checklist(domain: str) -> dict:
    """Get generic verification checklist for a domain."""

@mcp_tool("dimensional_check")
def dimensional_check(expression: str, symbol_dimensions: dict) -> dict:
    """Dedicated dimensional analysis. expression: LaTeX-like string.
    symbol_dimensions: {symbol: dimension_string, e.g. "mass^2"}"""
    # Parses expression, traces dimensions, verifies consistency

@mcp_tool("limiting_case_check")
def limiting_case_check(expression: str, limits: list[dict]) -> dict:
    """Dedicated limiting case verification. limits: [{variable, value, expected_result}]"""

@mcp_tool("symmetry_check")
def symmetry_check(expression: str, symmetries: list[str]) -> dict:
    """Dedicated symmetry verification. symmetries: ["parity", "time_reversal", "rotational", ...]"""
```

### 数据文件结构（用户可修改）

```
.opencode/get-physics-done/verification/
├── check_registry.json          # 检查类型注册（用户可添加新类型）
├── bundles/                     # 领域验证 bundle（用户可添加新领域）
│   ├── qft.json                 # 量子场论验证清单
│   ├── condensed_matter.json    # 凝聚态物理验证清单
│   ├── stat_mech.json           # 统计力学验证清单
│   ├── numerical.json           # 数值计算验证清单
│   ├── gr.json                  # 广义相对论验证清单
│   ├── nuclear_particle.json    # 核与粒子物理验证清单
│   ├── quantum_info.json        # 量子信息验证清单
│   ├── optics.json              # 光学验证清单
│   ├── astro.json               # 天体物理验证清单
│   ├── fluid.json               # 流体力学验证清单
│   ├── materials.json           # 材料科学验证清单
│   └── genomics.json            # 基因组学验证清单
├── checks/                      # 检查实现模块（用户可添加新检查）
│   ├── dimensional.py           # 维度分析实现
│   ├── limiting_case.py         # 极限情况实现
│   ├── symmetry.py              # 对称性验证实现
│   ├── conservation.py          # 守恒律验证实现
│   └── ...                      # 更多检查实现
└── custom_checks/               # 用户自定义检查目录（空，等待用户填充）
    └── README.md                # 说明如何添加自定义检查
```

### 自定义检查的开发者指南

**文件**: `.opencode/get-physics-done/verification/custom_checks/README.md`

```
# Adding Custom Verification Checks

1. Create a Python file in this directory: my_check.py
2. Implement a function: def run(input: dict) -> dict
3. Register in check_registry.json:
   {
     "my_check_type": {
       "module": "custom_checks.my_check",
       "function": "run",
       "description": "What this check does",
       "required_fields": ["field1", "field2"],
       "output_schema": {"status": "str", "evidence": "str"}
     }
   }
4. The gpd-verification MCP server will auto-discover and expose it as:
   mcp__gpd_verification__run_check(check_type="my_check_type", input={...})

5. To make your verifier subagent use it, add permission in .opencode/agents/gpd-verifier.md:
   permission:
     mcp__gpd_verification__run_check: allow
   And reference it in prompt_append.

Example: See checks/dimensional.py for a complete implementation.
```

---

## 3.3 物理验证 Bundle 示例（从 GPD cherry-pick）

以下是从 GPD 项目中提取的物理验证 bundle，作为 MCP 服务器数据文件的**具体示例**。每个 bundle JSON 文件定义了该领域的验证检查清单、红红旗项和标准基准。

### cherry-pick 验证方法

为确保与 GPD 项目本身保持一致:

1. **来源追踪**: 每个 bundle JSON 文件顶部包含 `gpd_source` 字段，指向 GPD 项目中的对应文件路径和 commit hash
2. **语义等价**: 不逐字复制 GPD 的文件内容（GPD 使用 Python 模块而非 JSON），而是将 GPD 的验证逻辑**语义等价地**转换为 JSON 数据格式，保留所有检查维度、红旗项和标准基准
3. **版本对齐**: 当 GPD 项目更新验证内容时，更新 `gpd_source` 的 commit hash 和对应的 JSON 数据
4. **测试对齐**: 每个 bundle 有对应的测试文件，验证 JSON 数据中的检查项与 GPD 原始 Python 实现覆盖相同的检查维度

### qft.json（量子场论验证 bundle）

```json
{
  "gpd_source": {
    "repo": "psi-oss/get-physics-done",
    "path": "src/gpd/mcp/servers/verification_server.py + src/gpd/references/verification/domains/verification-domain-qft.md",
    "commit": "main (to be pinned to specific commit on implementation)",
    "cherry_pick_method": "semantic_equivalence"
  },
  "domain": "qft",
  "description": "Quantum Field Theory verification bundle",
  "priority_checks": [
    {
      "check_type": "dimensional",
      "name": "Dimensional consistency",
      "procedure": "Trace dimensions of every symbol through every equation. Verify [expression] = [expected].",
      "red_flags": ["Dimension mismatch without explicit conversion", "Mixed natural/SI units without declaration"],
      "standard_benchmarks": [
        "Peskin & Schroeder Eq. (2.56) for retarded propagator",
        "Dimensional analysis: [G] = mass^(d-2)"
      ]
    },
    {
      "check_type": "limiting_case",
      "name": "Limiting cases",
      "procedure": "Take independent limits: massless, static, zero coupling, high energy. Verify each reproduces known result.",
      "red_flags": ["No massless limit computed", "Static limit doesn't reduce to known result"],
      "standard_benchmarks": ["Massless propagator → 1/(4πr)", "Static limit of retarded Green's function"]
    },
    {
      "check_type": "symmetry",
      "name": "Symmetry constraints",
      "procedure": "Check Ward identities, gauge invariance, Lorentz invariance. Replace ε^μ → k^μ, verify cancellation.",
      "red_flags": ["Gauge parameter ξ survives in observable", "ε^μ → k^μ substitution doesn't cancel"],
      "standard_benchmarks": ["Ward identity: q_μ M^μ = 0", "ξ cancellation in physical amplitude"]
    },
    {
      "check_type": "conservation",
      "name": "Conservation laws",
      "procedure": "Verify energy-momentum conservation, charge conservation, probability conservation at each vertex.",
      "red_flags": ["Energy-momentum not conserved at vertex", "Probability conservation violated"],
      "standard_benchmarks": ["Sum rule: Σ|M_n|^2 = 1", "Charge conservation at each interaction"]
    },
    {
      "check_type": "math_consistency",
      "name": "Mathematical consistency",
      "procedure": "Check analytic continuation, branch cut handling, pole structure, contour integration.",
      "red_flags": ["Branch cut handled inconsistently", "Wrong contour for integral"],
      "standard_benchmarks": ["S-matrix poles at physical masses", "Causal boundary conditions in contour integration"]
    }
  ],
  "specific_red_flags": [
    "Sign errors in angular momentum CG coefficients (verify triangle inequality, m-values sum)",
    "Metric signature flip (trace metric through every equation)",
    "Ward identity violation (ε^μ → k^μ must cancel)",
    "Wrong eigenvalue count (must match Hilbert space dimension)",
    "Fourier convention mismatch (verify 2π placement, reality conditions)",
    "Fermionic sign error (count anticommutation signs, Pauli exclusion)",
    "Missing fermion loop sign (-1)^L (count fermion loops)",
    "Matsubara frequency convention: boson 2nπT, fermion (2n+1)πT",
    "Renormalization scheme mixing (intermediate quantities are scheme-dependent)",
    "Identity claim from training data (verify at 3+ test points numerically)"
  ]
}
```

### 其他领域 bundle（精简版）

| Bundle           | 关键检查类型                                                                                 | GPD 源路径                                |
| ---------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| condensed_matter | symmetry (lattice), convergence (k-point), conservation (energy)                             | `verification-domain-condensed-matter.md` |
| stat_mech        | dimensional, limiting_case (T→0, T→∞), conservation (partition function Z>0)                 | `verification-domain-stat-mech.md`        |
| numerical        | convergence, benchmark reproduction, error budget, grid resolution                           | `verification-domain-numerical.md`        |
| gr               | dimensional, limiting_case (weak field → Newtonian), symmetry (diffeomorphism)               | `verification-domain-gr.md`               |
| nuclear_particle | dimensional, limiting_case (zero momentum), symmetry (isospin), conservation (baryon number) | `verification-domain-nuclear.md`          |
| quantum_info     | math_consistency (tensor product), symmetry (unitarity), conservation (norm)                 | `verification-domain-quantum-info.md`     |
| optics           | dimensional, limiting_case (paraxial), symmetry (time reversal)                              | `verification-domain-optics.md`           |
| astro            | dimensional, limiting_case (vacuum → flat spacetime), conservation (flux)                    | `verification-domain-astro.md`            |
| fluid            | dimensional, limiting_case (laminar → Stokes), conservation (mass/momentum)                  | `verification-domain-fluid.md`            |
| materials        | convergence (VASP parameters), dimensional, limiting_case (ideal crystal)                    | `verification-domain-materials.md`        |
| genomics         | statistical_rigor (p-value), convergence (bootstrap), literature_agreement                   | `verification-domain-genomics.md`         |

---

## 3.4 gpd-conventions MCP 服务器

### 功能

提供约定锁定管理，防止跨阶段约定漂移。

### Tool Schema

```python
@mcp_tool("convention_lock_status")
def convention_lock_status(project_dir: str) -> dict:
    """Return current convention lock state from .aether/conventions/state.json"""

@mcp_tool("convention_set")
def convention_set(key: str, value: str, project_dir: str) -> dict:
    """Set a convention value. Keys: natural_units, metric_signature, fourier_convention,
    gauge_choice, renormalization_scheme, coupling_convention, spin_basis,
    state_normalization, coordinate_system, index_positioning, time_ordering,
    commutation_convention. Updates .aether/conventions/state.json"""

@mcp_tool("convention_check")
def convention_check(file_content: str, project_dir: str) -> dict:
    """Check ASSERT_CONVENTION headers in file_content against current lock"""

@mcp_tool("convention_diff")
def convention_diff(phase_a: str, phase_b: str, project_dir: str) -> dict:
    """Compare conventions between two phases"""

@mcp_tool("assert_convention_validate")
def assert_convention_validate(file_path: str, project_dir: str) -> dict:
    """Validate all ASSERT_CONVENTION lines in a file against current lock"""

@mcp_tool("subfield_defaults")
def subfield_defaults(domain: str) -> dict:
    """Return default conventions for a physics subfield"""
```

### 数据存储

`.aether/conventions/state.json`:

```json
{
  "natural_units": "natural",
  "metric_signature": "mostly-minus",
  "fourier_convention": "physics",
  "gauge_choice": "lorentz",
  "renormalization_scheme": "on-shell",
  "coupling_convention": "Yukawa",
  "spin_basis": "Weyl",
  "state_normalization": "covariant",
  "coordinate_system": "cartesian",
  "index_positioning": "upper-lower",
  "time_ordering": "Euclidean",
  "commutation_convention": "left-to-right",
  "locked_at": "2026-05-10T12:00:00Z",
  "locked_by": "research agent phase 1"
}
```

### 子领域默认约定（从 GPD cherry-pick）

```python
SUBFIELD_DEFAULTS = {
    "qft": {
        "natural_units": "natural",
        "metric_signature": "mostly-minus",
        "fourier_convention": "physics",
        "renormalization_scheme": "on-shell",
    },
    "condensed_matter": {
        "natural_units": "natural",
        "metric_signature": "mostly-plus",
        "fourier_convention": "physics",
        "gauge_choice": "coulomb",
    },
    "stat_mech": {
        "natural_units": "boltzmann",
        "metric_signature": "mostly-minus",
        "matsubara_convention": "standard",
    },
    "numerical": {
        "natural_units": "SI",
        "coordinate_system": "cartesian",
        "convergence_threshold": "1e-6",
    },
    "gr": {
        "natural_units": "geometric",
        "metric_signature": "mostly-plus",
        "coordinate_system": "general",
    },
}
```

---

## 3.5 gpd-errors MCP 服务器

### 功能

提供 LLM 物理错误目录查询，帮助 verifier 识别常见 LLM 物理推理错误。

### Tool Schema

```python
@mcp_tool("get_error_class")
def get_error_class(class_id: str) -> dict:
    """Get details of a specific error class"""

@mcp_tool("check_error_classes")
def check_error_classes(content: str, domain: str) -> dict:
    """Check content for known error patterns"""

@mcp_tool("list_error_classes")
def list_error_classes(domain: str = None) -> dict:
    """List all error classes, optionally filtered by domain"""

@mcp_tool("get_detection_strategy")
def get_detection_strategy(class_id: str) -> dict:
    """Get detection strategy for an error class"""

@mcp_tool("get_traceability")
def get_traceability(check_category: str) -> dict:
    """Get traceability matrix: error classes → verification check categories"""
```

### 错误类数据（精选 20 类，从 GPD 的 104 类中 cherry-pick 最高风险的）

**文件**: `.opencode/get-physics-done/verification/errors/error_catalog.json`

```json
{
  "gpd_source": {
    "repo": "psi-oss/get-physics-done",
    "path": "src/gpd/references/verification/errors/llm-physics-errors.md",
    "commit": "main (to be pinned)",
    "cherry_pick_method": "semantic_equivalence",
    "note": "GPD has 104 error classes; this catalog selects the 20 highest-risk classes. Full catalog can be added by expanding error_catalog.json."
  },
  "error_classes": [
    {
      "id": "E01",
      "name": "Sign errors in angular momentum CG coefficients",
      "domain": "qft",
      "detection": "Verify triangle inequality, m-values sum",
      "severity": "high"
    },
    {
      "id": "E02",
      "name": "Metric signature flip",
      "domain": "qft/gr",
      "detection": "Trace metric through every equation",
      "severity": "high"
    },
    {
      "id": "E03",
      "name": "Ward identity violation",
      "domain": "qft",
      "detection": "Replace ε^μ → k^μ, check S-matrix cancellation",
      "severity": "high"
    },
    {
      "id": "E04",
      "name": "Wrong eigenvalue count",
      "domain": "quantum_info",
      "detection": "Count matches Hilbert space dimension",
      "severity": "high"
    },
    {
      "id": "E05",
      "name": "Gauge parameter survives observable",
      "domain": "qft",
      "detection": "ξ must cancel from physical observables",
      "severity": "high"
    },
    {
      "id": "E06",
      "name": "Fourier convention mismatch",
      "domain": "qft/signal",
      "detection": "Verify 2π placement, reality conditions",
      "severity": "medium"
    },
    {
      "id": "E07",
      "name": "Fermionic sign error",
      "domain": "qft/condensed_matter",
      "detection": "Count anticommutation signs, Pauli exclusion",
      "severity": "high"
    },
    {
      "id": "E08",
      "name": "Partition function sign/phase",
      "domain": "stat_mech",
      "detection": "Z > 0, KMS periodicity",
      "severity": "medium"
    },
    {
      "id": "E09",
      "name": "Matsubara frequency convention",
      "domain": "stat_mech/qft",
      "detection": "boson: 2nπT, fermion: (2n+1)πT",
      "severity": "medium"
    },
    {
      "id": "E10",
      "name": "Renormalization scheme mixing",
      "domain": "qft",
      "detection": "Intermediate quantities are scheme-dependent",
      "severity": "high"
    },
    {
      "id": "E11",
      "name": "Identity claim from training data",
      "domain": "all",
      "detection": "Verify at 3+ test points numerically",
      "severity": "high"
    },
    {
      "id": "E12",
      "name": "Missing fermion loop sign (-1)^L",
      "domain": "qft",
      "detection": "Count fermion loops",
      "severity": "medium"
    },
    {
      "id": "E13",
      "name": "Boundary condition mismatch",
      "domain": "numerical",
      "detection": "BC_COUNT must equal ODE_ORDER",
      "severity": "high"
    },
    {
      "id": "E14",
      "name": "Jacobi identity violation",
      "domain": "qft/gr",
      "detection": "Verify for operator algebra",
      "severity": "medium"
    },
    {
      "id": "E15",
      "name": "Self-consistency false convergence",
      "domain": "condensed_matter",
      "detection": "Check k-point convergence",
      "severity": "medium"
    },
    {
      "id": "E16",
      "name": "Perturbation order incomplete",
      "domain": "qft",
      "detection": "Count all terms at declared order",
      "severity": "high"
    },
    {
      "id": "E17",
      "name": "KK relation violation",
      "domain": "optics/condensed_matter",
      "detection": "Verify Re/Im χ(ω) satisfy KK",
      "severity": "medium"
    },
    {
      "id": "E18",
      "name": "FEM convergence order mismatch",
      "domain": "numerical",
      "detection": "Richardson extrapolation",
      "severity": "medium"
    },
    {
      "id": "E19",
      "name": "Elasticity normalization mismatch",
      "domain": "gr/mechanics",
      "detection": "Relativistic vs non-relativistic",
      "severity": "low"
    },
    {
      "id": "E20",
      "name": "Symmetry factor wrong",
      "domain": "qft",
      "detection": "Count vertices and propagators",
      "severity": "medium"
    }
  ]
}
```

---

## 3.6 项目持久化与恢复

### 状态文件

| 文件                              | 用途                 | 维护者                                     |
| --------------------------------- | -------------------- | ------------------------------------------ |
| `GPD/STATE.md`                    | 当前阶段、决定、阻碍 | research agent prompt_append 指示维护      |
| `GPD/state.json` project_contract | 约定锁定、项目合同   | gpd-conventions MCP 服务器读写             |
| `GPD/ROADMAP.md`                  | 阶段结构和进度       | research agent 的 deep-research skill 写入 |

### 恢复机制

research agent 的 prompt_append 中包含:

```
## Session Recovery
On entering research mode, read GPD/STATE.md and GPD/state.json for project context.
If STATE.md indicates incomplete phase, resume from that point.
```

**不修改核心 prompt.ts** — 恢复指令在 agent md 的 prompt_append 中，由 mode-switch enter 时注入。

---

## 3.7 MCP Skill 路由文件

为了让 research agent 的 skill_refs 包含 `gpd-conventions` 和 `gpd-verification`，需要创建对应的 SKILL.md 文件（作为 MCP 工具的路由入口）:

### gpd-conventions skill

**文件**: `.opencode/skills/gpd-conventions/SKILL.md`

```yaml
---
name: gpd-conventions
description: Physics convention lock management. Check, set, validate, and compare conventions across research phases. Use before any calculation to ensure consistency.
---

# Convention Management

Use gpd-conventions MCP tools:

- `convention_lock_status` — check current convention lock
- `convention_set` — set a convention (metric_signature, fourier_convention, units, gauge_choice, etc.)
- `convention_check` — verify file's ASSERT_CONVENTION headers match lock
- `subfield_defaults` — get default conventions for a domain

Before any calculation in physics/math, call `convention_lock_status` to confirm which conventions are active.
```

### gpd-verification skill

**文件**: `.opencode/skills/gpd-verification/SKILL.md`

```yaml
---
name: gpd-verification
description: Structured physics verification via MCP tools. Dimensional analysis, limiting cases, symmetry checks, conservation laws, and domain-specific verification bundles. Use for rigorous verification of research results.
---

# Structured Verification

Use gpd-verification MCP tools:

- `suggest_contract_checks(contract)` — get suggested verification checks for your PLAN
- `run_contract_check(request)` — execute a specific check with custom parameters
- `get_bundle_checklist(bundle_ids)` — get domain-specific checklist (qft, condensed_matter, numerical, etc.)
- `run_check(check_type, input)` — run a check by type (dimensional, limiting_case, symmetry, conservation, ...)
- `dimensional_check(expression, dimensions)` — dedicated dimensional analysis
- `limiting_case_check(expression, limits)` — dedicated limiting case check
- `symmetry_check(expression, symmetries)` — dedicated symmetry verification

These tools are flexible — define custom verification parameters, not just use hardcoded checklists.
```

---

## 3.8 参考文档

### 文件结构

```
.opencode/get-physics-done/
├── verification/
│   ├── check_registry.json
│   ├── bundles/ (12 domain JSON files)
│   ├── checks/ (Python check implementations)
│   ├── custom_checks/ (user directory + README)
│   └── errors/
│       └── error_catalog.json
├── conventions/
│   └── subfield_defaults.json
├── references/
│   ├── verification/
│   │   ├── core/
│   │   │   ├── verification-core.md         # 通用验证维度和优先级
│   │   │   ├── computational-verification-templates.md  # 5 个 copy-paste 计算验证模板
│   │   │   └── verification-hierarchy-mapping.md  # 验证层次映射
│   │   └── domains/                          # 12+ 领域验证参考（按需加载）
│   │       ├── verification-domain-qft.md
│   │       ├── verification-domain-condensed-matter.md
│   │       └─ ... (11 more)
│   └── planning/
│       ├── planner-conventions.md            # 规划约定检查指导
│       └── planner-approximations.md         # 近似追踪指导
│   └── shared/
│       ├── shared-protocols.md               # 共享协议（禁止文件、源层次、约定追踪）
│       └── canonical-schema-discipline.md    # 规范 schema 约定
├── templates/
│   ├── verification-report.md                # VERIFICATION.md 报告模板
│   └── contract-results-schema.md            # 合同结果 schema
└── paper-templates/
│   ├── prl.tex                               # Physical Review Letters
│   ├── nature.tex                            # Nature
│   ├── jhep.tex                              # JHEP
│   ├── apj.tex                               # ApJ
│   ├── mnras.tex                             # MNRAS
│   └── jfm.tex                               # JFM
```

参考文档不注入 system prompt，而是通过 agent prompt_append 中的 `@` 引用路径，由 LLM 在需要时通过 `read` 工具按需加载（GPD 方式）。

---

## 验收测试

```
T3.1: gpd-verification MCP 服务器启动后，mcp__gpd_verification__run_check 工具可用
T3.2: gpd-verification suggest_contract_checks 返回基于 contract 的建议检查
T3.3: gpd-verification get_bundle_checklist("qft") 返回 QFT 验证清单
T3.4: gpd-verification dimensional_check 通过维度追踪返回 pass/fail
T3.5: gpd-conventions MCP 服务器启动后，mcp__gpd_conventions__convention_lock_status 可用
T3.6: gpd-conventions convention_set("metric_signature", "mostly-minus") 更新 state.json
T3.7: gpd-conventions convention_check 验证 ASSERT_CONVENTION 行与锁定一致
T3.8: gpd-errors MCP 服务器启动后，mcp__gpd_errors__list_error_classes 返回 20 个错误类
T3.9: 修改 check_registry.json 添加新检查类型后，run_check 可调用新类型
T3.10: 修改 bundles/custom.json 后，get_bundle_checklist("custom") 返回新 bundle
T3.11: 添加 custom_checks/my_check.py + 注册后，run_check("my_check_type") 调用自定义检查
T3.12: verifier agent 通过 MCP 工具运行验证（不硬编码检查清单）
T3.13: cherry-pick 验证: qft.json 的检查维度与 GPD verification-domain-qft.md 语义等价
T3.14: MCP 服务器独立运行，不影响 OpenCode 核心运行时
T3.15: 删除 MCP 配置后，OpenCode 核心行为不变
```
