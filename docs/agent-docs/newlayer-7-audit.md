# newlayer-7: research-audit skill 合并重构

> 原 research-audit (237行) + research-audit-reasoning (277行) + research-audit-repair (142行) + research-audit-repair-reasoning (178行)
> → 合并为单一 research-audit skill（结构 checker 脚本 + 语义审计指引）
> 对应设计文档 §7.1-7.4

---

## 修改原因与设计依据

**大方向**：旧设计有 3 个 audit phase + 3 个 repair skill + max-3 循环 + 计数器 + 备份脚本，过度复杂冗余，且 audit 与 repair 分散在独立 phase/skill 衔接臃肿。新设计合并为单一 research-audit skill（结构 checker 脚本 + 语义审计指引），由 worker 调用。
**设计依据**：design doc §7.1（合一 rationale）、§7.2（分工：结构 vs 语义）、§7.3（checker Python + server.py 整体删除）、§7.4（语义审计）、§13 决策 2/3/10。
**具体决策理由**：

- 合一 guard+audit：两者性质不同（确定性 vs LLM）但都是"质量保证"能力，合并减少 skill 数量，概念统一（design doc §7.1, §13 决策 10）
- checker 只判存在性不判内容：早期方案误以为 checker 能取代 audit，但 checker 无法判推理是否成立/引用是否支持——这些是语义判断必须 LLM audit（design doc §7.2）
- scripts 由 worker 跑、语义审计由 worker dispatch 独立 sub-subagent：scripts 是确定性 Python 无 bias；语义审计需要独立判断，同一 context 自审 bias 严重（worker 刚完成产出，context 充满自己的推理，倾向于认为自己写的合理）。sub-subagent fresh 读产物文件提供独立判断。调用写入 research-worker.md（见 newlayer-10 M4 Subagent Dispatch Rules）
- 通用 audit skill 不绑定 phase：一套 skill，sub-subagent 据产物类型自选审计方向，取代旧按 phase 拆三套（design doc §7.4）
- 不照搬旧 audit 知识：旧 Cross-Verification/severity 表/推理链 checklist 过于 rigid，改为灵活原则，仅参考旧知识的思路（见 §5）

## 删除

| 文件                                                      | 行  | 理由             |
| --------------------------------------------------------- | --- | ---------------- |
| `.aether/skills/research-audit-reasoning/SKILL.md`        | 277 | 合并入通用 audit |
| `.aether/skills/research-audit-repair/SKILL.md`           | 142 | worker 自修取代  |
| `.aether/skills/research-audit-repair-reasoning/SKILL.md` | 178 | worker 自修取代  |

原 `.aether/skills/research-audit/SKILL.md` (237行) → 整体重写。

---

## 新建：research-audit skill 结构

```
.aether/skills/research-audit/
  SKILL.md                    — 语义审计指引（sub-subagent 据产物类型审内容）
  scripts/
    check_sources.py          — 引用→下载文件映射
    check_verification.py     — resolved claim→验证记录
    check_artifacts.py        — 必备文件存在非空 + workdir 路径校验
    check_conventions.py      — ASSERT_CONVENTION 验证 + 约定完整性 + 跨字段一致性
```

---

## SKILL.md 内容规格

### front matter

```yaml
---
name: research-audit
owner: research
description: |
  质量保证 skill（结构 checker 脚本 + 语义审计指引）。
  scripts/ 为确定性检查（worker 经 bash 调用）。
  SKILL.md 为语义审计指引（worker dispatch 独立 sub-subagent 调用，fresh context 避免 self-review bias）。
---
```

### §1 调用流程

```markdown
worker 完成 phase 产出后:

1. 跑 scripts/（bash，确定性，无 bias）:
   - check_artifacts.py <research_state.md_path> <expected_files> → 验证文件存在非空 + 在 workdir 内 + persistence 白名单
   - check_sources.py <files...> → 验证 [src:id] 引用都有下载文件
   - check_verification.py <research_state.md> → 验证 resolved claims 有验证记录
   - scripts 不过 → worker 自补缺失文件/引用/验证，重跑 scripts

2. dispatch sub-subagent: research-audit（delegation_depth: 0）
   → sub-subagent fresh 读产物文件（不带 worker 推理历史）
   → 按 SKILL.md §2 指引做语义审计
   → 输出 FATAL/CONCERN/PASS 报告，写入 <workdir>audits/audit\*[phase]\_[date].md
   → 返回报告给 worker

3. worker 读审计报告:
   - PASS → 质量门通过，继续后续流程
   - CONCERN/FATAL → 自修（推荐 2 次，非强制上限）
     - 修后重新 dispatch 审计 sub-subagent 验证修复
     - 若多次自修仍有问题，worker 须判断是否"严重到无法自修"
   - 严重问题（无法自修）→ 须写明无法自修的原因（具体说明什么阻碍了修复），
     写入 research_state.md 的 Last Phase Result issues 字段，回传 needs_attention
```

**关键设计点**：

- scripts 由 worker 直接跑（确定性，无 self-review bias 问题）
- 语义审计由独立 sub-subagent 跑（fresh context，避免 worker 对自己产出的确认偏差）
- 自修次数推荐 2 次但非强制——worker 可据问题性质判断是否值得继续修
- "严重问题"必须写明无法自修的原因，不能笼统标记

### §2 语义审计方向（按产物类型）

```markdown
| 产物类型                       | 审计方向                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| analysis.md                    | 引用是否真支持论断; 事实是否准确; gap 识别是否合理; 领域覆盖是否充分                                                         |
| landscape_map.md               | 学派分类是否准确; 时间线是否完整; 争议标注是否有据; 覆盖度是否充分                                                           |
| framing_reasoning.md + PLAN.md | 推理链是否完整(无跳步); 问题是否可证伪; 方法是否适用; 依赖图是否无环; 验收标准是否充分; tractability confidence 是否符合规则 |
| execution 汇总                 | 结论是否由验证支持; 验证质量是否充分; 跨问题一致性; Failed Attempts 是否诚实记录                                             |
```

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

### §3 scripts 规格

#### check_artifacts.py

```
用法: uv run check_artifacts.py <research_state.md_path> <expected_file1> <expected_file2> ...
逻辑:
  1. 解析 research_state.md 的 Active Workdir
  2. 对每个 expected_file: 拼接 <workdir><file>, stat 存在 + 非空
  3. 验证 persistence/ 白名单: persistence/ 下只允许 research_state.md + ENVIRONMENT.md（不允许其他文件）
  4. 扫描 notepads/ 下所有文件, 验证工作文件路径以 Active Workdir 开头
     (路径可靠性兜底 + 文件布局合规, 取代旧 server.py 的 validate_file_locations)
输出 JSON:
  {"ok": bool, "missing": [...], "empty": [...], "outside_workdir": [...], "persistence_violations": [...]}
```

#### check_sources.py

```
用法: uv run check_sources.py <file1> <file2> ...
逻辑:
  1. 扫描所有 [src:<id>] 引用模式
  2. 对每个 id: 查 .aether/research/literatures/registry.json 是否注册 → 查 literatures/<id>.* 文件是否存在
  3. 报告 cited_without_source（引用了但没下载 → 编造风险）
输出 JSON:
  {"ok": bool, "cited_without_source": [<id>...], "missing_files": [<id>...]}
```

#### check_verification.py

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

#### check_conventions.py

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

### §4 与旧 audit 的映射

```markdown
| 旧 audit 检查项         | 新机制                   | 位置        |
| ----------------------- | ------------------------ | ----------- |
| citation support        | check_sources.py         | scripts/    |
| factual accuracy        | 语义审计(analysis 类型)  | SKILL.md §2 |
| method applicability    | 语义审计(framing 类型)   | SKILL.md §2 |
| reasoning chain quality | 语义审计(framing 类型)   | SKILL.md §2 |
| domain coverage         | 语义审计(landscape 类型) | SKILL.md §2 |
| resolved claim 有验证   | check_verification.py    | scripts/    |
| 文件存在非空            | check_artifacts.py       | scripts/    |
```

### §5 审计原则（替代 rigid checklist）

**不照搬旧 audit 的 rigid checklist**（Cross-Verification 2+来源硬规则、severity 查找表、推理链检查项列表），仅参考其思路。新设计采用灵活原则，让审计 sub-subagent 自主判断：

```markdown
- **独立性**：审计 sub-subagent fresh 读产物文件，不带 worker 推理历史，独立判断
- **科学严谨性**：评估推理是否成立、证据是否支持论断、方法是否适用——据产物具体内容自主决定重点审计什么
- **严重度判断**（sub-subagent 自主，非查表）：
  - FATAL = 会导致结论无效的问题
  - CONCERN = 应修正但不导致结论无效
  - PASS = 无重大问题
- **多角度验证**：对关键发现，从不同角度交叉验证（非机械"2+来源"规则，而是据判断需要时自然采用）
- **参考旧知识但不照搬**：旧 audit 的 Cross-Verification 思路（多来源验证）、severity 分级思路（按影响判严重度）、推理链检查思路（跳步/遗漏/不一致）可作参考，但不作为 rigid checklist 强制执行
```

---

## 对 newlayer-10 的影响

research-worker.md 的 Subagent Dispatch Rules 使用 own/owner 机制（无 allowed 列表，见 newlayer-10 M4）。research-audit 作为同 owner (research) 的 subagent，自动可被 dispatch。各 phase skill 指定实际 dispatch research-audit sub-subagent 做语义审计（scripts 由 worker 自己经 bash 跑，语义审计 dispatch sub-subagent 避免 self-review bias，见 newlayer-7 §1）。

---

## 预期结果

- 旧 4 个 audit skill (834行) → 1 个 research-audit skill (~120行 SKILL.md + ~250行 scripts) = ~370行
- scripts 是确定性 Python，可靠且零 token
- 语义审计由独立 sub-subagent 跑，避免 self-review bias
