---
name: research-audit
owner: research
description: |
  质量保证 skill（结构 checker 脚本 + 语义审计指引）。
  §1 调用流程为 worker runbook（worker 经 bash 跑 scripts + dispatch audit agent）。
  §2 语义审计方向为 research-audit agent 加载（fresh context 避免 self-review bias）。
  scripts/ 为确定性检查。
---

# Research Audit — 结构 checker + 语义审计

## §1 调用流程

> 本节是质量门的唯一 runbook。各 phase skill 不再重复此流程——worker 完成 phase 产出后直接按本节执行（scripts 由 worker 经 bash 跑，语义审计 dispatch research-audit agent）。

worker 完成 phase 产出后:

1. 跑 scripts/（bash，确定性，无 bias）:
   - `check_artifacts.py <research_state.md_path> <expected_files>` → 验证文件存在非空 + 在 workdir 内 + persistence 白名单
   - `check_sources.py <files...>` → 验证 [src:id] 引用都有下载文件
   - `check_verification.py <research_state.md>` → 验证 resolved claims 有验证记录
   - `check_conventions.py <research_state.md_path> <files_to_check...>` → 验证 ASSERT_CONVENTION 一致性 + 约定完整性
   - scripts 不过 → worker 自补缺失文件/引用/验证，重跑 scripts

2. dispatch research-audit subagent（subagent_type: "research-audit"）
   → research-audit agent fresh 读产物文件（不带 worker 推理历史）
   → 加载 research-audit skill，按 §2 指引做语义审计
   → 输出 FATAL/CONCERN/PASS 报告，写入 `<workdir>audits/audit*[phase]\_[date].md`
   → 返回报告给 worker

3. worker 读审计报告:
   - PASS → 质量门通过，继续后续流程
   - CONCERN/FATAL → 自修（推荐 2 次，非强制上限）
     - 修后重新 dispatch 审计 sub-subagent 验证修复
     - 若多次自修仍有问题，worker 须判断是否"严重到无法自修"
   - 严重问题（无法自修）→ 须写明无法自修的原因（具体说明什么阻碍了修复），
     写入 research_state.md 的 Last Phase Result issues 字段，回传 needs_attention

**关键设计点**：

- scripts 由 worker 直接跑（确定性，无 self-review bias 问题）
- 语义审计由独立 sub-subagent 跑（fresh context，避免 worker 对自己产出的确认偏差）
- 自修次数推荐 2 次但非强制——worker 可据问题性质判断是否值得继续修
- "严重问题"必须写明无法自修的原因，不能笼统标记

## §2 语义审计方向（按产物类型）

| 产物类型                       | 审计方向                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| analysis.md                    | 引用是否真支持论断; 事实是否准确; gap 识别是否合理; 领域覆盖是否充分                                                         |
| landscape_map.md               | 学派分类是否准确; 时间线是否完整; 争议标注是否有据; 覆盖度是否充分                                                           |
| framing_reasoning.md + PLAN.md | 推理链是否完整(无跳步); 问题是否可证伪; 方法是否适用; 依赖图是否无环; 验收标准是否充分; tractability confidence 是否符合规则 |
| DEBATE.md + 修订后的 PLAN.md   | critique 是否覆盖关键 debate topics; rebuttal 是否回应所有 critique points; adjudication 裁决是否合理; repair 修订是否正确   |
| execution 汇总                 | 结论是否由验证支持; 验证质量是否充分; 跨问题一致性; Failed Attempts 是否诚实记录                                             |

注：此表为方向性指引，非 rigid checklist。sub-subagent 应据产物具体内容自主判断需重点审计什么。

审计输出格式:

```markdown
## Audit Report — [phase] — [date]

### FATAL

- [文件:位置] [问题] [证据] [建议修复方向]

### CONCERN

- [文件:位置] [问题] [建议]

### PASS

[无问题的简要确认]
```

## §3 scripts 规格

> **路径参数约定**（避免歧义）：
>
> - `check_artifacts.py`：expected_files 传**相对 workdir 的文件名**（如 `PLAN.md`）。脚本自行解析 research_state.md 的 Active Workdir 并拼接，不要传带 workdir 前缀的路径（否则路径翻倍）。
> - `check_sources.py` / `check_conventions.py`：输入文件传**从 research root 可解析的路径**（即 `<workdir>/<file>`，如 `notepads/slug/framing_reasoning.md`）。这两个脚本直接 `Path(f).read_text()`，不自动解析 workdir。
> - worker 从各 phase skill 的 Output 节获知文件名，结合 research_state.md 的 Active Workdir 拼出上述路径。

### check_artifacts.py

```
用法: uv run check_artifacts.py <research_state.md_path> <expected_file1> <expected_file2> ...
逻辑:
  1. 解析 research_state.md 的 Active Workdir
  2. 对每个 expected_file: 拼接 <workdir><file>, stat 存在 + 非空
  3. 验证 persistence/ 白名单: persistence/ 下只允许 research_state.md + ENVIRONMENT.md
  4. 扫描 notepads/ 下所有文件, 验证工作文件路径以 Active Workdir 开头
输出 JSON:
  {"ok": bool, "missing": [...], "empty": [...], "outside_workdir": [...], "persistence_violations": [...]}
```

### check_sources.py

```
用法: uv run check_sources.py <file1> <file2> ...
逻辑:
  1. 扫描所有 [src:<id>] 引用模式
  2. 对每个 id: 查 .aether/research/literatures/registry.json 是否注册 → 查 literatures/<id>.* 文件是否存在
  3. 报告 cited_without_source（引用了但没下载 → 编造风险）
输出 JSON:
  {"ok": bool, "cited_without_source": [<id>...], "missing_files": [<id>...]}
```

### check_verification.py

```
用法: uv run check_verification.py <research_state.md_path>
逻辑:
  1. 解析 research_state.md 的 Questions/Claims, 提取 status=resolved 的 claims
  2. 对每个 resolved claim: 查其 ver 路径引用的验证文件是否存在 + 非空(≥30行) + 含 verdict (PASS/FAIL/PARTIAL)
  3. 报告 unverified_claims
输出 JSON:
  {"ok": bool, "unverified_claims": [<claim_id>: <reason>...]}
```

**check_artifacts 与 check_verification 的区分**：check_artifacts 检查 phase 是否产出了预期文件（phase 级结构检查）；check_verification 检查 research_state.md 中所有 resolved claims 是否有验证记录（state 级约束检查，跨 phase）。

### check_conventions.py

```
用法: uv run check_conventions.py <research_state.md_path> <files_to_check...>
逻辑:
  1. 解析 research_state.md 的 ## Conventions 节，获取当前约定值
  2. 对每个 files_to_check: 扫描 <!-- ASSERT_CONVENTION: key=value --> 行，验证与当前约定一致
  3. 检查完整性: critical 约定（如 metric_signature / fourier_convention / natural_units）是否已设
  4. 跨字段一致性: 从 domain 约定 skill 的 reference 文件加载跨字段规则（如 gpd-conventions/references/cross_field_rules.json），检查是否有矛盾
  5. 若 ## Conventions 节为空或无 ASSERT_CONVENTION 行 → 跳过（非物理 domain 可能无约定）
输出 JSON:
  {"ok": bool, "mismatches": [<file:key:expected:actual>...], "critical_unset": [<key>...], "cross_field_warnings": [...]}
```

注：check_conventions.py 从 domain 约定 skill（如 gpd-conventions）的 reference 文件加载约定选项和跨字段规则，不硬编码 domain 知识。非物理 domain 若无约定 skill，脚本自动跳过约定检查。

## §4 与旧 audit 的映射

| 旧 audit 检查项         | 新机制                   | 位置        |
| ----------------------- | ------------------------ | ----------- |
| citation support        | check_sources.py         | scripts/    |
| factual accuracy        | 语义审计(analysis 类型)  | SKILL.md §2 |
| method applicability    | 语义审计(framing 类型)   | SKILL.md §2 |
| reasoning chain quality | 语义审计(framing 类型)   | SKILL.md §2 |
| domain coverage         | 语义审计(landscape 类型) | SKILL.md §2 |
| resolved claim 有验证   | check_verification.py    | scripts/    |
| 文件存在非空            | check_artifacts.py       | scripts/    |

## §5 审计原则（替代 rigid checklist）

**不照搬旧 audit 的 rigid checklist**（Cross-Verification 2+来源硬规则、severity 查找表、推理链检查项列表），仅参考其思路。新设计采用灵活原则，让审计 sub-subagent 自主判断：

- **独立性**：审计 sub-subagent fresh 读产物文件，不带 worker 推理历史，独立判断
- **科学严谨性**：评估推理是否成立、证据是否支持论断、方法是否适用——据产物具体内容自主决定重点审计什么
- **严重度判断**（sub-subagent 自主，非查表）：
  - FATAL = 会导致结论无效的问题
  - CONCERN = 应修正但不导致结论无效
  - PASS = 无重大问题
- **多角度验证**：对关键发现，从不同角度交叉验证（非机械"2+来源"规则，而是据判断需要时自然采用）
- **参考旧知识但不照搬**：旧 audit 的 Cross-Verification 思路（多来源验证）、severity 分级思路（按影响判严重度）、推理链检查思路（跳步/遗漏/不一致）可作参考，但不作为 rigid checklist 强制执行
