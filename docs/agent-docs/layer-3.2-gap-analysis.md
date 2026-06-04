# Layer 3.2: Gap Analysis — 当前实现与设计文档的差距及 GPD 细节对比

> 前置文档: Layer 3 (research-infrastructure.md)
> 本文档记录当前实现与 Layer 3 设计文档的差距、与 GPD 原生实现的细节对比，以及修复方案。

---

## 目录

1. [MCP 服务器差距](#1-mcp-服务器差距)
2. [Scripts 实现差距](#2-scripts-实现差距)
3. [数据文件差距](#3-数据文件差距)
4. [skill_resolve_path 实现问题](#4-skill_resolve_path-实现问题)
5. [GPD 功能对照：被移除的 MCP](#5-gpd-功能对照被移除的-mcp)
6. [MCP 响应封装与 tool annotations](#6-mcp-响应封装与-tool-annotations)
7. [修复优先级排序](#7-修复优先级排序)

---

## 1. MCP 服务器差距

### 1.1 research-conventions MCP

#### 1.1.1 convention_lock_status — 缺少统计信息

| 方面     | 设计文档要求                           | 当前实现                                    | GPD 原生参考                                                                                                                                                         |
| -------- | -------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 返回内容 | "Return current convention lock state" | `{"conventions": {}, "project_dir": "..."}` | `{"lock": {...}, "set_count": N, "total_standard_fields": 18, "set_fields": [...], "unset_fields": [...], "custom_conventions": {...}, "completeness_percent": X.X}` |

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:290-323`

**差距**: agent 无法知道哪些约定已设、哪些未设、完整性百分比。仅返回裸 dict，agent 需自行计算统计信息。

**修复方案**: 返回值增加 `set_fields`, `unset_fields`, `set_count`, `total_standard_fields`, `completeness_percent` 字段。

#### 1.1.2 convention_set — 无值校验/规范化/非标警告

| 方面       | 设计文档要求                                                    | 当前实现                        | GPD 原生参考                                                                                 |
| ---------- | --------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| 值校验     | "Convention keys are defined by the domain's convention schema" | 直接写入 state dict，无任何校验 | ConventionLock Pydantic 模型 + normalize_key/normalize_value + CONVENTION_OPTIONS 枚举       |
| 非标值警告 | 设计文档 §3.1.1 描述 key 有枚举值                               | 无                              | `known_options` + `non_standard` 警告 "Non-standard value 'X' for 'Y'. Known options: [...]" |
| force 选项 | 设计文档未明确                                                  | 无                              | `force=True` 允许覆盖已设约定 + `already_set` 状态                                           |
| 前后值对比 | 设计文档未明确                                                  | 无                              | `previous_value` + `forced: True`                                                            |

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:326-404`, `gpd/core/conventions.py`

**差距**: 当前实现允许任意 key/value 写入，无规范化。LLM 可能写入 `mostly minus`（有空格）而非标准值 `mostly-minus`，导致后续 convention_check 失败。

**修复方案**:

1. 在 MCP server 中引入 `KNOWN_CONVENTIONS` 枚举和 `CONVENTION_OPTIONS` dict（从 gpd-conventions skill 的 references 加载）
2. 添加 `normalize_key()` / `normalize_value()` 函数
3. 添加 `force` 参数和 `already_set` 状态返回
4. 添加非标值警告机制

#### 1.1.3 convention_check — 功能完全不同

| 方面 | 设计文档要求                                                           | 当前实现                                  | GPD 原生参考                                |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| 功能 | "Check ASSERT_CONVENTION headers in file_content against current lock" | 做 ASSERT_CONVENTION 行匹配 vs state dict | 校验 ConventionLock 的完整性+跨字段关联检查 |

**关键差异**: 设计文档定义 `convention_check(file_content, project_dir)` 检查文件中的 ASSERT 行，GPD 定义 `convention_check(lock)` 校验 lock 本身的完整性。两者是不同功能。

当前实现做了 ASSERT 行匹配（符合设计），但缺少 lock 自身的完整性校验。GPD 的 lock 校验包括：

- 缺失关键约定警告（metric_signature, fourier_convention, natural_units）
- 跨字段关联检查（euclidean + QFT Fourier → sign issues, SI + mostly-plus → ensure c factors）

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:407-459`

**修复方案**: 保持当前 ASSERT 行匹配功能，新增 `convention_validate(project_dir)` 工具做 lock 完整性+关联检查。

#### 1.1.4 assert_convention_validate — 缺少强制断言要求

| 方面     | 设计文档要求                                                                 | 当前实现                                      | GPD 原生参考                                                                           |
| -------- | ---------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| 参数     | `file_path, project_dir`                                                     | `file_path, project_dir`                      | `file_content, lock`（接收内容而非路径）                                               |
| 强制断言 | "Every derivation artifact must include at least one ASSERT_CONVENTION line" | 无强制要求，空文件返回 `all_consistent: True` | `require_assertions=True` + `required_assertion_keys` 检查                             |
| 必检 key | 设计文档未明确                                                               | 无                                            | `required_assertion_keys(parsed_lock)` — 根据 lock 中已设的约定推断哪些 key 必须被断言 |

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:520-585`, `gpd/core/conventions.py:check_assertions/parse_assert_conventions/required_assertion_keys`

**差距**: 文件无 ASSERT 行时当前实现静默返回空结果（`all_consistent: True`），违反设计"每份推导产物必须包含至少一行 ASSERT_CONVENTION"的要求。

**修复方案**:

1. 保留 `file_path` 接口（读文件）但也支持 `file_content` 接口（直接传入内容）
2. 实现 `require_assertions=True` 逻辑：如果文件中没有 ASSERT 行，返回 `valid: False` + `message: "No ASSERT_CONVENTION lines found"`
3. 实现 `required_assertion_keys`：根据 lock 中已设的 key 列出必须被断言的 key

#### 1.1.5 convention_diff — 缺失

设计文档 §3.1.1: "移除的工具（转至 skill）: convention_diff（两个阶段约定对比 — 两个文件读 + 字典减法，agent 自行完成）"

当前状态: skill 中无 convention_diff 指引，gpd-conventions SKILL.md Step 4 只说 "verify convention lock matches" 但无具体操作指引。

GPD 原生: `convention_diff(lock_a, lock_b)` 返回 changed/added/removed + severity（critical for metric_signature/fourier_convention/natural_units）

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:462-517`

**修复方案**: 在 gpd-conventions SKILL.md Step 4 中添加 diff 操作指引："当引用先前阶段结果时，读取两个阶段的 state.json conventions dict，逐 key 比较差异。metric_signature/fourier_convention/natural_units 差异为 critical severity——必须转换后再使用。"

#### 1.1.6 TOCTOU 竞态 — 文件锁不覆盖 read-modify-write 周期

当前实现: `_read_state()` 获取锁 → 释放锁 → 修改 state → `_write_state()` 再次获取锁 → 释放锁

GPD 原生: `_update_lock_in_project()` 在整个 read-modify-write 周期持锁（`with file_lock(state_path):` 包裹整个操作）

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:252-283`

**差距**: 两个 `convention_set` 调用可能并发执行，A 读 → B 读 → A 写 → B 写，B 的写入覆盖 A 的修改（经典的 TOCTOU 竞态）。

**修复方案**: 将 `_read_state` + 修改 + `_write_state` 合并为单次锁持有操作，参考 GPD 的 `_update_lock_in_project()` 模式。

#### 1.1.7 subfield_defaults — convention_defaults 字段名不一致

| 我们的字段名       | GPD 字段名                    | 差距说明               |
| ------------------ | ----------------------------- | ---------------------- |
| `units`            | `natural_units`               | GPD 使用更具体的命名   |
| `lagrangian_sign`  | —                             | 我们新增，GPD 无此字段 |
| `angular_momentum` | —                             | 我们新增，GPD 无此字段 |
| `spin_statistics`  | —                             | 我们新增，GPD 无此字段 |
| `matsubara`        | —                             | 我们新增，GPD 无此字段 |
| —                  | `index_positioning`           | GPD 有，我们缺         |
| —                  | `levi_civita_sign`            | GPD 有，我们缺         |
| —                  | `generator_normalization`     | GPD 有，我们缺         |
| —                  | `creation_annihilation_order` | GPD 有，我们缺         |

GPD 源码位置: `gpd/mcp/servers/conventions_server.py:100-179` (SUBFIELD_DEFAULTS dict)

**修复方案**: 对齐 GPD 字段名（使用 `natural_units` 而非 `units`），补充 GPD 有而我们缺的字段。保留我们新增的字段（GPD 没有但这些确实有物理意义）。

### 1.2 research-state MCP

#### 1.2.1 get_state — 缺少合约层

| 方面     | 当前实现           | GPD 原生参考                                                                                        |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| 返回内容 | 裸 state.json dict | state dict + `project_contract_load_info` + `project_contract_validation` + `project_contract_gate` |

GPD 源码位置: `gpd/mcp/servers/state_server.py:63-93` (`load_state_json` 函数调用 `_project_contract_runtime_payload_for_state`)

**差距**: agent 无法知道当前项目是否有合约、合约是否通过验证、是否被 gate 阻止。

**修复方案**: 在 state.json 中增加 `project_contract` 区域（当前设计已有此字段但未实际使用）。get_state 返回时附加合约验证状态。这需要先建立合约系统（见 §1.2.6）。

#### 1.2.2 advance_plan — agent 需手动指定而非自动推进

| 方面     | 当前实现                                         | GPD 原生参考                                                      |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| 参数     | `phase: str, plan_number: str, project_dir: str` | `project_dir: str`（无 phase/plan_number 参数）                   |
| 推进逻辑 | agent 手动传入新 phase 和 plan_number            | `state_advance_plan(cwd)` 自动从 ROADMAP.md 推断下一个 phase+plan |

GPD 源码位置: `gpd/mcp/servers/state_server.py:159-177`, `gpd/core/state.py:state_advance_plan`

**差距**: agent 需先读取 ROADMAP.md 推断下一步，再手动传入。GPD 的自动推进更安全（基于结构化 roadmap 数据）。

**修复方案**: 保留手动参数作为 override，但增加从 ROADMAP.md 自动推断下一步的默认行为。需先实现 ROADMAP.md 结构化解析。

#### 1.2.3 validate_state — 过于简单

| 方面   | 当前实现                                            | GPD 原生参考                                                                                  |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 校验项 | phase 非空 + plan_number 靨空 + conventions 是 dict | schema 校验 + convention lock + state vs STATE.md 一致性 + phase 格式 + project_contract 验证 |

GPD 源码位置: `gpd/mcp/servers/state_server.py:203-227`, `gpd/core/state.py:state_validate`

**修复方案**: 增加校验项：(1) state.json schema 版本校验; (2) conventions dict 每个值非空; (3) phase 格式校验（数字或 "exploration"); (4) plan_number 格式校验。

#### 1.2.4 run_health_check — 过于简单

| 方面   | 当前实现                                                                             | GPD 原生参考                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 检查项 | state.json 是否存在 + STATE.md 是否存在 + ROADMAP.md 是否存在 + state 中是否有 phase | 11+维度：环境、项目结构、存储路径、compaction、roadmap一致性、orphans、conventions、frontmatter、return envelopes、config、git status |

GPD 源码位置: `gpd/mcp/servers/state_server.py:230-253`, `gpd/core/health.py:run_health`

**修复方案**: 逐步扩展：(1) state.json schema 校验; (2) conventions 完整性; (3) ROADMAP.md phase 列表 vs state.json phase 一致性; (4) persistence 目录完整性（STATE.md + state.json + ROADMAP.md + PLAN.md 是否都存在）。

#### 1.2.5 缺失工具 — get_config, get_phase_info

| 工具             | 当前实现 | GPD 原生参考                                                                   |
| ---------------- | -------- | ------------------------------------------------------------------------------ |
| `get_config`     | 未实现   | 返回 GPD 配置（model profile, autonomy mode, research mode, workflow toggles） |
| `get_phase_info` | 未实现   | 返回 phase 目录、plan count、summary count、complete 判断                      |

GPD 源码位置: `gpd/mcp/servers/state_server.py:123-157`, `gpd/mcp/servers/state_server.py:255-275`

**修复方案**:

- `get_config`: 读取 `.aether/agent/` 目录配置 + aether.jsonc，返回 agent 配置摘要
- `get_phase_info`: 解析 ROADMAP.md 的 phase 列表，返回指定 phase 的详情

#### 1.2.6 state.json 恢复机制缺失

GPD 有 `peek_state_json()` + `recover_intent=True` 参数，能从损坏的 state.json 中恢复意图（降级为部分状态而非完全失败）。

GPD 源码位置: `gpd/core/state.py:peek_state_json`

**修复方案**: 增加 state.json 读取容错：(1) JSON 解析失败时返回默认 state + warning; (2) 缺失字段时补默认值而非报错。

---

## 2. Scripts 实现差距

### 2.1 SKILL.md 引用不存在的脚本

gpd-verification SKILL.md Step 2 表格列出以下脚本但不存在：

| SKILL.md 列出的脚本               | 实际存在   | 差距                                                                                    |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `scripts/conservation_check.py`   | **不存在** | check_registry 5.4 script=null，但 SKILL.md Step 2 列为 `scripts/conservation_check.py` |
| `scripts/positivity_check.py`     | **不存在** | SKILL.md 5.12 行列出                                                                    |
| `scripts/kramers_kronig_check.py` | **不存在** | SKILL.md 5.13 行列出                                                                    |

设计文档 §3.3.1 仅规划了 6 个脚本（dimensional/limiting/ward/symmetry/spot/convergence），未包含 conservation/positivity/kramers_kronig。

**修复方案**: 两种选择——

1. **实现这些脚本**：conservation_check.py（SymPy 简化验证守恒律）、positivity_check.py（矩阵特征值符号检查）、kramers_kronig_check.py（解析延拓一致性）
2. **修正 SKILL.md**：移除不存在脚本的引用，改为 "LLM + scripts (if available)" 或 "script=null" 标记

推荐方案 1——这些是物理验证中高价值的确定性计算。

### 2.2 dimensional_check 无法自动推断维度

设计文档 §3.5: "维度分析: SymPy 解析原始表达式，自动推断维度"

当前实现: 需要 `dimension_map` 参数手动提供（`{symbol: dimension_string}`），无 map 时返回 `warning` + `confidence: 0.3`。

**差距**: 设计要求"自动推断"但实现依赖手动标注。"自动推断"在技术上需要：(1) 知道每个 symbol 的物理维度（如 m=mass, L=length），这本身是领域知识；(2) SymPy 无法从纯数学表达式推断物理维度。

**修复方案**: 保留 `dimension_map` 作为必需输入（这是合理的——维度是领域知识），但在 gpd-verification SKILL.md 中明确指引："agent 必须从 research 上下文中提取每个 symbol 的物理维度，构造 dimension_map 后传入脚本。无 dimension_map 时脚本无法执行维度追踪。" 这不违反设计精神——"自动"指的是"不需要预标注 `[M][L]^2` 括号"，而非"不需要告诉脚本每个变量是什么维度"。

### 2.3 所有脚本的共同不足

| 方面          | 当前状态                    | 应改进                                                                      |
| ------------- | --------------------------- | --------------------------------------------------------------------------- |
| 错误输出格式  | stderr 错误信息 + exit code | 不统一，部分脚本捕获异常返回 JSON，部分 stderr 退出                         |
| 超时处理      | 无                          | 设计 §3.10 提到"计算超时 → MCP timeout → status: warning"，但脚本无超时机制 |
| 大 JSON stdin | 支持 stdin 但无大小限制     | 无限制，极长表达式可能导致 SymPy 内存溢出                                   |

---

## 3. 数据文件差距

### 3.1 contract_checks.json — 过于简化

当前 `contract_checks.json` 每个条目只有 `observed_fields`（描述性文本）和 `verification_method`（描述性文本）。

GPD 的合约检查有严格的 Pydantic schema 定义，每个检查有：

- `required_request_fields`（哪些字段必需）
- `schema_required_request_fields`（schema 级别必需）
- `schema_required_request_anyof_fields`（任一分支必需）
- `optional_request_fields`
- `request_template`（完整 JSON 模板）
- binding targets 有 `ContractBindingRequest` Pydantic 模型强制校验

GPD 源码位置: `gpd/mcp/servers/verification_server.py:122-386` (\_CONTRACT_CHECK_REQUEST_HINTS)

**差距**: agent 无法系统化执行合约验证——不知道每个检查需要哪些字段、哪些是必需的、如何构造请求。

**修复方案**: 在 `contract_checks.json` 中为每个检查增加：

- `required_fields`: 列出必需的 observed 字段名
- `optional_fields`: 列出可选字段名
- `request_template`: 完整的 JSON 输入模板示例
- `binding_targets_schema`: 每个 binding target 的类型和描述

### 3.2 error_catalog.json — 数量与设计文档矛盾

设计文档 §3.3.2: "20 最高风险错误类"
实际: 25 个错误类

GPD 原生: 104 个错误类（从 4 个 markdown 文件解析）

**修复方案**: 更新 SKILL.md 描述从"20"改为"25"，或在设计文档中明确"精选 25 类"而非"20 类"。无需扩展到 104 类——精选是设计意图。

### 3.3 domain bundles — 数量与设计文档矛盾

设计文档 §3.3.3: "12 物理领域 bundle JSON 文件"
实际: 14 个 bundle（qft, condensed_matter, stat_mech, gr_cosmology, amo, nuclear_particle, astrophysics, mathematical_physics, algebraic_qft, string_field_theory, quantum_info, soft_matter, fluid_plasma, classical_mechanics）

GPD 原生 DOMAIN_CHECKLISTS: 同样 14 个领域

**修复方案**: 更新设计文档中的 "12" 为 "14"。

---

## 4. skill_resolve_path 实现问题

### 4.1 扫描路径应统一为 ~/.agents/skills

当前实现扫描 5 个路径：

```python
candidates = [
    home / ".aether" / "skill",    # 项目级（但用了 home）
    home / ".opencode" / "skills", # OpenCode 默认
    home / ".claude" / "skills",   # Claude 专用
    home / ".agents" / "skills",   # 通用
]
cwd = Path.cwd()
candidates.extend([
    cwd / ".aether" / "skill",    # 项目级
    cwd / ".opencode" / "skills", # 项目级 OpenCode
])
```

问题：

1. `home / ".aether" / "skill"` 是用户级目录而非项目级——不应在 `home` 下找 `.aether/skill`
2. `.claude/skills` 是 Claude Code 专用路径，不应扫描
3. 缺少项目级 `.aether/skill/plugins/` 的扫描（GPD 插件目录）

**修复方案**: 参考 Aether 核心 skill 发现机制（`packages/opencode/src/skill/index.ts`）：

Aether 核心扫描路径：

```typescript
// 用户级
EXTERNAL_DIRS = [".claude", ".agents"] // ← 应统一为 ".agents"
// 扫描模式: "skills/**/SKILL.md"

// 项目级（通过 Config.directories()）
// 扫描模式: "{skill,skills}/**/SKILL.md"

// 配置级（aether.jsonc skills.paths）
// 扫描模式: "**/SKILL.md"
```

MCP server 的 skill_resolve_path 应与核心一致：

```python
SKILL_SCAN_DIRS = []  # 启动时初始化

def _init_skill_dirs(project_dir: Path):
    """与 Aether 核心 skill 发现路径对齐"""
    home = Path.home()
    # 用户级（与核心 EXTERNAL_DIRS 一致，统一为 .agents）
    candidates = [home / ".agents" / "skills"]
    # 项目级
    candidates.extend([
        project_dir / ".aether" / "skill",
        project_dir / ".opencode" / "skills",
    ])
    for d in candidates:
        if d.exists():
            SKILL_SCAN_DIRS.append(d)
```

### 4.2 SKILL.md frontmatter 解析应使用 YAML parser

当前实现用正则解析 frontmatter：

```python
if content.startswith("---"):
    end = content.find("---", 3)
    if end != -1:
        frontmatter = content[3:end]
        for line in frontmatter.splitlines():
            if line.strip().startswith("name:"):
                name = line.split(":", 1)[1].strip().strip('"').strip("'")
```

问题：正则无法处理多行值、嵌套 YAML、带引号字符串等。

Aether 核心使用 `ConfigMarkdown.parse(match)` 解析 frontmatter（使用 Zod schema + YAML parser）。

**修复方案**: MCP server 是 Python 进程，应使用 Python YAML parser：

```python
import yaml

def _parse_skill_frontmatter(content: str) -> dict | None:
    if not content.startswith("---"):
        return None
    end = content.find("---", 3)
    if end == -1:
        return None
    frontmatter = content[3:end]
    try:
        return yaml.safe_load(frontmatter)
    except yaml.YAMLError:
        return None
```

MCP server 的 PEP 723 dependencies 应增加 `pyyaml>=6.0`。

### 4.3 CWD 问题详解

**问题**: MCP server 的 `_init_skill_dirs()` 在模块初始化时用 `Path.cwd()` 确定项目级 skill 目录。但 MCP server 是独立子进程，其 CWD 取决于 OpenCode 如何启动它。

OpenCode 启动 MCP 进程的典型流程：

1. 用户在项目 `/Users/lx/project-x` 目录下启动 OpenCode
2. OpenCode 根据 aether.jsonc 中 `mcp.research-conventions.command` 配置执行 `uv run ~/.aether/mcp/research-conventions/server.py`
3. 子进程的 CWD 取决于 OpenCode 的 spawn 实现——可能是 OpenCode 进程的 CWD（项目根目录），也可能是系统默认（如 `~`）

当前 Aether 核心代码中 MCP 启动逻辑未公开（在 TypeScript 中），但参考 bun spawn 行为，子进程默认继承父进程的 CWD。这意味着：

- 如果 OpenCode 从项目根目录启动 → `Path.cwd()` 正确
- 如果用户在子目录中启动 OpenCode → `Path.cwd()` 可能不是项目根
- 如果 OpenCode 未来改为从 `~/.aether/mcp/` 目录启动 MCP → `Path.cwd()` 完全不是项目根

**修复方案**: 所有 MCP 工具都已接受 `project_dir` 参数。skill_resolve_path 也应接受 `project_dir` 参数，用它而非 `Path.cwd()` 定位项目级 skill：

```python
@mcp.tool()
def skill_resolve_path(skill_name: str, relative_path: str = "", project_dir: str = "") -> dict[str, Any]:
    pd = _resolve_project_dir(project_dir)
    # 用 pd 而非 Path.cwd() 定位项目级 skill
    skill_dir = _find_skill_dir(skill_name, project_dir=pd)
    ...
```

### 4.4 缓存机制

当前实现每次调用 `_find_skill_dir()` 都 rglob 所有 SKILL.md 文件——无缓存。

Aether 核心的 skill 发现有 `InstanceState` 缓存（基于 ScopedCache，每个项目实例缓存一次）。

**修复方案**: 在 MCP server 中添加模块级缓存：

```python
_skill_cache: dict[str, Path | None] = {}
_cache_lock = threading.Lock()

def _find_skill_dir(skill_name: str, project_dir: Path = None) -> Path | None:
    cache_key = f"{skill_name}:{project_dir}"
    if cache_key in _skill_cache:
        return _skill_cache[cache_key]
    # ... 扫描逻辑 ...
    with _cache_lock:
        _skill_cache[cache_key] = result
    return result
```

---

## 5. GPD 功能对照：被移除的 MCP

### 5.1 patterns_server — 跨 session 错误模式演化

**GPD 实现**: 4 个 MCP 工具

- `add_pattern(domain, title, category, severity, ...)`: 记录新错误模式到本地库
- `promote_pattern(pattern_id)`: 置信度递进（single_observation → confirmed → systematic）
- `lookup_pattern(domain, keywords)`: 搜索已有模式
- `seed_patterns()`: 初始化 8 个基础物理模式（幂等）

GPD 源码位置: `gpd/mcp/servers/patterns_server.py`, `gpd/core/patterns.py`

**设计说不需要的理由**: 研究项目不需要跨 session 的错误模式演化——gpd-errors skill 已提供精选 25 类作为"预先种好的模式库"。

**实际差距**: 长期研究中 LLM 确实会反复犯同一类错误。静态目录无"我上次确实犯了 E02"的个性化记忆。

**弥补方案（不恢复 MCP）**: 在 VERIFICATION.md 中追加发现的错误类记录。下次验证时 agent 读取 `.aether/research/persistence/VERIFICATION.md` 的历史记录，优先检查历史中实际犯过的错误类。这是文件级记忆而非 MCP 级记忆——符合"skill + files 代替 MCP"的设计原则。

在 gpd-errors SKILL.md 中增加 Step 0: "读取 VERIFICATION.md 中历史验证记录的 error findings，优先检查历史中检测到的错误类。"

### 5.2 protocols_server — 计算方法指引

**GPD 实现**: 57 个物理计算协议文件 + 4 个 MCP 工具

- `get_protocol(name)`: 返回协议全文（steps + checkpoints + body）
- `list_protocols(domain)`: 列出可用协议
- `route_protocol(computation_type)`: 关键词+token序列匹配，返回最相关协议
- `get_protocol_checkpoints(name)`: 返回协议的验证 checkpoints

协议示例: perturbation-theory.md, renormalization-group.md, dimensional-analysis.md, limiting-cases.md 等

GPD 源码位置: `gpd/mcp/servers/protocols_server.py`, `gpd/specs/references/protocols/*.md` (57个)

**设计说不需要的理由**: skill_refs 机制已实现"根据任务类型自动注入指引"。

**实际差距**: GPD 协议是**计算方法指引**（如何做 perturbation theory），我们的 skill 是**验证指引**（如何检查结果）。前者指导"怎么做"，后者指导"怎么验"。57 个协议覆盖几乎所有物理计算场景的步骤和常见陷阱。我们完全缺少计算方法指引。

**弥补方案（不恢复 MCP）**: 将高频协议的精华内容整理为 skill references 数据文件：

1. 在 gpd-domain-check skill 中增加 `references/protocols/` 子目录，存放领域相关的计算方法指引摘要（从 GPD 57 个协议中 cherry-pick 高频协议的 steps 和 red_flags 部分）
2. 在 gpd-domain-check SKILL.md Step 3 中增加："如果当前研究涉及特定计算方法（如 perturbation theory, renormalization group），读取 `references/protocols/<method>.json` 获取步骤指引和常见陷阱"
3. 不需要 MCP 进程——这些是静态指引文本，skill 注入即可

### 5.3 skills_server — 技能路由

**GPD 实现**: `route_skill(computation_type)` — 根据计算描述匹配最相关的 skill

GPD 源码位置: `gpd/mcp/servers/skills_server.py`

**设计说不需要的理由**: OpenCode 的 skill_refs + slash commands 已提供路由。

**实际**: skill_refs 是 agent 配置级的静态路由（gpd-verifier 总是加载 gpd-verification + gpd-errors + gpd-domain-check + gpd-conventions），而 GPD 的 route_skill 是动态路由（根据当前计算类型决定加载哪些 skill）。我们不需要动态路由——agent 的 skill_refs 已经覆盖了所有验证相关 skill。

**结论**: 正确移除，无需弥补。

### 5.4 gpd-arxiv — arXiv 搜索

**GPD 实现**: arXiv MCP 是上游 `arxiv_mcp_server` 的桥接

**设计说不需要的理由**: OpenCode 的 alpha-research skill 已包含 arxiv-search 模式。

**结论**: 正确移除。

---

## 6. MCP 响应封装与 tool annotations

### 6.1 stable_mcp_response/error

GPD 所有 MCP 工具返回统一的 `StableMCPEnvelope`：

```python
class StableMCPEnvelope(dict[str, object]):
    """Schema-versioned MCP envelope for all server responses."""

def stable_mcp_response(payload, *, error=None) -> StableMCPEnvelope:
    """Return a stable MCP response envelope without nesting the payload."""
    response = StableMCPEnvelope()
    if payload is not None:
        response.update(payload)  # payload 字段平铺到顶层
    if error is not None:
        response["error"] = str(error)
    response["schema_version"] = 1
    return response

def stable_mcp_error(error) -> StableMCPEnvelope:
    if isinstance(error, PydanticValidationError):
        error = "; ".join(_format_pydantic_validation_errors(error))
    return stable_mcp_response(error=error)
```

GPD 源码位置: `gpd/mcp/servers/__init__.py:76-112`

**好处**:

1. 每个 response 都带 `schema_version: 1`，未来格式变更时 agent 可检测版本
2. 错误统一为 `{"error": "...", "schema_version": 1}` 格式，而非五花八门的异常 dict
3. PydanticValidationError 被格式化为人类可读的行内错误而非原始 traceback
4. payload 字段平铺到顶层（不嵌套在 `data` 下），agent 直接访问

**当前不足**: 所有工具返回裸 dict，无 schema_version，错误格式不统一（有些用 `{"error": "..."}` 有些直接返回 dict）。

**修复方案**: 在 MCP server 中引入 `stable_mcp_response` / `stable_mcp_error` 封装函数（纯 Python，约 30 行），所有工具统一使用。

### 6.2 tool annotations

MCP 协议的 `ToolAnnotations` 有 4 个语义字段：

- `readOnlyHint`: 工具是否只读
- `destructiveHint`: 工具是否会破坏性修改
- `idempotentHint`: 工具是否幂等
- `openWorldHint`: 工具是否影响开放世界

GPD 对每个工具标注这些属性：

```python
# 只读工具
convention_lock_status → read_only_tool_annotations()
convention_check → read_only_tool_annotations()
subfield_defaults → read_only_tool_annotations()

# 修改工具
convention_set → mutating_tool_annotations(destructive=True, idempotent=False)
```

GPD 源码位置: `gpd/mcp/servers/__init__.py:32-73`

**好处**: LLM 在决策是否调用工具时可参考语义标注；权限系统可据此自动决定是否允许调用。

**当前不足**: 所有工具无 annotations。LLM 不知道 convention_set 会破坏性修改已有约定。

**修复方案**: 为每个 MCP 工具添加 annotations：

```python
from mcp.types import ToolAnnotations

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
MUTATING_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False)
MUTATING_NON_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)

@mcp.tool(annotations=READ_ONLY)
def convention_lock_status(project_dir: str) -> dict:
    ...

@mcp.tool(annotations=MUTATING_DESTRUCTIVE)
def convention_set(key: str, value: str, project_dir: str) -> dict:
    ...
```

### 6.3 tighten_registered_tool_contracts

GPD 在所有 MCP server 的末尾调用 `tighten_registered_tool_contracts(mcp)`，它：

1. 为每个工具生成 `extra="forbid"` 的 strict Pydantic model（禁止未知参数）
2. 替换工具的 call handler 为 strict 版本（未知参数 → stable_mcp_error）
3. 将 strict schema 发布为工具的 inputSchema

GPD 源码位置: `gpd/mcp/servers/__init__.py:274-325`

**好处**: LLM 传入未知参数时立即报错而非静默忽略。例如 LLM 调用 `convention_set(key="metric_signature", value="mostly-minus", project_dir="/foo", force=True)` 但忘记 force 参数名写成了 `override=True`，strict schema 会返回 "Unsupported arguments: override"。

**当前不足**: FastMCP 默认允许未知参数——LLM 传错参数名时静默忽略，可能导致工具行为不符预期。

**修复方案**: 添加 `tighten_registered_tool_contracts` 等效函数（Python，约 50 行），在 server.py 末尾调用。

---

## 7. 修复优先级排序

### P0 — 阻塞验证流程正确性

| #    | 问题                                                   | 影响                                                             | 修复工作量                                      |
| ---- | ------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------- |
| P0-1 | TOCTOU 竞态（convention_set read-modify-write 不持锁） | 并发写入丢失修改                                                 | ~30 行修改                                      |
| P0-2 | assert_convention_validate 无强制断言要求              | 无 ASSERT 行的文件静默通过验证                                   | ~20 行修改                                      |
| P0-3 | SKILL.md 引用不存在脚本                                | agent 尝试执行 conservation/positivity/kramers_kronig 脚本会失败 | 实现脚本（~200 行/个）或修正 SKILL.md（~10 行） |
| P0-4 | skill_resolve_path CWD 问题                            | MCP 进程可能找不到项目级 skill                                   | ~15 行修改（增加 project_dir 参数）             |

### P1 — 影响验证质量

| #    | 问题                                               | 影响                         | 修复工作量                                    |
| ---- | -------------------------------------------------- | ---------------------------- | --------------------------------------------- |
| P1-1 | convention_set 无值校验/规范化                     | 非标值写入导致后续检查失败   | ~100 行（引入 KNOWN_CONVENTIONS + normalize） |
| P1-2 | convention_lock_status 缺少统计信息                | agent 无法判断约定完整性     | ~20 行修改                                    |
| P1-3 | contract_checks.json 缺少 required_fields/template | agent 无法系统化执行合约验证 | JSON 文件修改 + ~50 行 schema                 |
| P1-4 | validate_state 过于简单                            | 无法检测 state 结构问题      | ~50 行                                        |
| P1-5 | stable_mcp_response/error 封装                     | 响应格式不统一，错误信息混乱 | ~30 行新增函数                                |

### P2 — 提升体验但不阻塞

| #     | 问题                              | 影响                                     | 修复工作量                               |
| ----- | --------------------------------- | ---------------------------------------- | ---------------------------------------- |
| P2-1  | tool annotations                  | LLM 无法区分读/写工具                    | ~20 行标注                               |
| P2-2  | tighten_registered_tool_contracts | 未知参数静默忽略                         | ~50 行新增函数                           |
| P2-3  | convention_defaults 字段名不一致  | 与 GPD 数据不互操作                      | JSON 文件修改                            |
| P2-4  | convention_diff 缺失指引          | SKILL.md 无跨阶段约定比较指引            | ~15 行 SKILL.md 修改                     |
| P2-5  | 缺少计算方法指引（protocols）     | agent 无"怎么做 perturbation theory"指引 | 数据文件创建（cherry-pick GPD 协议精华） |
| P2-6  | run_health_check 过于简单         | 仅 3 项检查                              | ~80 行扩展                               |
| P2-7  | 缺少 get_config/get_phase_info    | agent 无法获取项目配置和 phase 详情      | ~60 行新增工具                           |
| P2-8  | 错误模式记忆（patterns 替代方案） | 无"上次犯了 E02"的个性化记忆             | SKILL.md 修改 + VERIFICATION.md 格式约定 |
| P2-9  | error_catalog 数量描述矛盾        | SKILL.md 说"20"实际"25"                  | ~5 行文字修改                            |
| P2-10 | domain bundles 数量描述矛盾       | 设计说"12"实际"14"                       | ~5 行文字修改                            |
