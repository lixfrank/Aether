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
   - scripts 不过 → worker 自补缺失文件/引用/验证，重跑 scripts

2. dispatch research-audit subagent（`subagent_type: "research-audit", delegation_depth: 0`）
   → research-audit agent fresh 读产物文件（不带 worker 推理历史）
   → 加载 research-audit skill，按 §2 指引做语义审计（含 convention 审计，见 §2 Convention 审计段）
   → 输出 FATAL/CONCERN/PASS 报告，写入 `<workdir>audits/audit*[phase]_[date].md`
   → 返回报告给 worker

3. worker 读审计报告:
   - PASS → 质量门通过，继续后续流程
   - CONCERN/FATAL → 自修（推荐 2 次，非强制上限）
     - 修后重新 dispatch 审计 subagent 验证修复
     - 若多次自修仍有问题，worker 须判断是否"严重到无法自修"
   - 严重问题（无法自修）→ 须写明无法自修的原因（具体说明什么阻碍了修复），
     写入 research_state.md 的 Last Phase Result issues 字段，回传 needs_attention

## §2 语义审计方向（按产物类型）

| 产物类型                       | 审计方向                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| analysis.md                    | 引用是否真支持论断; 事实是否准确; gap 识别是否合理; 领域覆盖是否充分                                                         |
| landscape_map.md               | 学派分类是否准确; 时间线是否完整; 争议标注是否有据; 覆盖度是否充分                                                           |
| framing_reasoning.md + PLAN.md | 推理链是否完整(无跳步); 问题是否可证伪; 方法是否适用; 依赖图是否无环; 验收标准是否充分; tractability confidence 是否符合规则 |
| DEBATE.md + 修订后的 PLAN.md   | critique 是否覆盖关键 debate topics; rebuttal 是否回应所有 critique points; adjudication 裁决是否合理; repair 修订是否正确   |
| execution 汇总                 | 结论是否由验证支持; 验证质量是否充分; 跨问题一致性; Failed Attempts 是否诚实记录                                             |

**Convention 审计**（当 research_state.md 含 `## Conventions` 节时，跨产物额外执行）：
用 grep 收集各文件 `<!-- ASSERT_CONVENTION: ... -->` 声明，读 research_state.md `## Conventions` 与 domain reference（如 `gpd-conventions/references/convention_defaults.json` + `cross_field_rules.json`）。约定键未必与 reference 词汇一致——**必须语义匹配** state/ASSERT 键与 reference 键，不可硬匹配。核对声明值是否一致、是否适用本研究；未能在 reference 匹配的约定用 webfetch/websearch 核查。

注：此表为方向性指引。subagent 应据产物具体内容自主判断需重点审计什么。

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
> - `check_sources.py`：输入文件传**从 research root 可解析的路径**（即 `<workdir>/<file>`，如 `notepads/slug/framing_reasoning.md`）。脚本直接 `Path(f).read_text()`，不自动解析 workdir。
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

> convention 一致性/完整性验证不由脚本承担（约定键未必与 reference 词汇一致，硬匹配不可靠）——由 research-audit agent 语义执行（见 §2 Convention 审计段）。

## §4 审计原则

- **独立性**：审计 subagent fresh 读产物文件，不带 worker 推理历史，独立判断
- **科学严谨性**：评估推理是否成立、证据是否支持论断、方法是否适用——据产物具体内容自主决定重点审计什么
- **严重度判断**（subagent 自主，非查表）：
  - FATAL = 会导致结论无效的问题
  - CONCERN = 应修正但不导致结论无效
  - PASS = 无重大问题
- **多角度验证**：对关键发现，从不同角度交叉验证（据判断需要时自然采用）
