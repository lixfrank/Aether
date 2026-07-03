# newlayer-6.1: autoresearch 时间预算机制

> 前置: [newlayer-6](newlayer-6-execution.md)（autoresearch skill 重构，已实现）
> 本文档为 newlayer-6 的后续增强：per-question 固定轮数终止（cycle max 3 / 文件验证 max 2）→ per-question min/max 工作时间预算。
> 对应设计文档 §6.1（结构化执行保留）、§6.2（verifier 即 judge）。

---

## 修改原因与设计依据

**大方向**：newlayer-6 的终止机制是固定轮数——cycle max 3（verdict 失败重试上限）+ 文件验证 max 2（产出不合格重试上限）。不区分问题难度：复杂研究问题 3 轮往往不够探索，简单问题 3 轮又浪费。时间预算让简单问题快速通过、复杂问题有充足探索时间、硬上限控制成本。

**设计依据**：design doc §6.1（结构化执行保留——autoresearch 的结构是因为 agent 不擅长自然做这些才存在）、§6.2（verifier 即 judge——verifier 产出 verdict，execution 据 verdict 决策）。

**核心洞察**：时间比轮数更贴合研究本质——研究的"工作量"是时间而非轮次。三档 zone（below_min / between / above_max）将"何时该停"从机械轮数改为：最小时间保必要探索、中间区由 agent 自省判断、最大时间硬控成本。

**具体决策理由**：

- **per-question 而非 phase 级**：每个问题难度不同，独立预算更合理。phase 级总预算会让简单问题挤占复杂问题的时间。
- **移除所有固定轮数上限（cycle max 3 + 文件验证 max 2），纯时间驱动**：时间预算是"该 question 上还能试多久"的单一控制，适用于所有失败点（文件验证不合格 / verdict FAIL/PARTIAL）。保留独立 max 会引入两套终止机制，逻辑割裂。单问题在预算内反复失败时，below_min 的"不得停止"+ between 的自判已足够防止无意义循环。
- **默认 min=60min / max=1440min**：严肃研究问题单次 dispatch 受 local-executor timeout 限制，一个问题常需多次 dispatch+验证循环。60min min 确保不浅尝辄止；1440min max 是 generous 硬上限，多数问题远在此之前解决。可经 reset --min/--max 按项目覆盖。
- **超时后立即暂停整阶段**：超时问题的分析对用户决策"是否继续其他问题"有参考价值——用户应先看超时分析再决定。立即暂停符合"等待下一步指示"语义；用户可指示"跳过 Q2 继续 Q3"。
- **min/max 配置不入 research_state.md，存 .timing.json**：research_state.md 是"对研究问题的理解"，min/max 是执行力学配置，污染研究状态且无明确归属。check_time_budget.py 是唯一消费者——默认值硬编码脚本，覆盖经 reset --min/--max 存入 .timing.json 该 Qn 记录，check 从中读取。配置随 question 的 timing 记录走，re-dispatch 后不丢。
- **reset 合并 start（单一动作，始终归零）**：不设幂等 start + 独立 reset 两动作。reset 始终归零计时——首次处理 / re-examine 均调 reset。re-dispatch 重新处理该 Qn 即刷新预算（可接受：re-dispatch 罕见且人类发起，人类知悉成本）；续算则直接 check 不调 reset。
- **timing 落盘 .timing.json，gitignore**：时间是执行力学，非研究产物。.timing.json 不入 research_state.md，且加入 .gitignore 不污染 git 审计轨。
- **不新增 status**：超时暂停的 question 保持 `open`，问题分析写入 Last Phase Result。paused 即 needs_attention 回传，check_verification.py 不受影响（只查 resolved claims）。
- **自判去僵化**：between 区 agent 自主判断能否找到正确道路，非 rigid checklist。保留两条软性指引（verification 指出根本性问题 / agent 自判无额外尝试方向），agent 据情况权衡。允许 agent 工作中自主发现 PLAN.md 预设之外的新方向。

---

## 删除

| 段落                                                      | 理由                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Terminology 中 `cycle` 定义                               | 被 `time budget` / `zone` 取代                                                        |
| 据 verdict 决策中 `cycle < 3 → 重试 / cycle = 3 → failed` | 被 zone 三档决策取代                                                                  |
| 文件验证中 `重跑对应 subagent（max 2）`                   | 文件验证失败也纳入时间预算决策，无独立 max                                            |
| `cycle = 3 → Qn status 改 failed` 自动路径                | 超时改为 needs_attention 暂停（非自动 failed）；question 是否 failed 由人类审查后决定 |

## 保留

- Wave 拓扑排序（从 PLAN.md 依赖图）
- 逐问题执行→验证→决策循环
- 每 Wave 后 audit
- 暂停问用户（critical dep 失败 / 需假设）
- 输出文件路径不变
- Failed Attempts 记录（超时停止时也记录已试方法）

## 修改

### T1. check_time_budget.py（新脚本）

位置：`.aether/skills/autoresearch/scripts/check_time_budget.py`（autoresearch 的调度脚本，非 research-audit 质量门脚本——research-audit/scripts/ 只放 post-phase 质量门 check\_\*.py）

```
用法:
  uv run check_time_budget.py <research_state.md_path> <qid> reset [--min M --max M]
  uv run check_time_budget.py <research_state.md_path> <qid> check
  M 为分钟（整数），默认 min=60 / max=1440
```

**reset**：解析 Active Workdir → `<workdir>execution/.timing.json` 记录 qid 的 `started_at=now`（归零，覆盖旧记录）。`--min/--max`（分钟）存入 .timing.json 供 check 读取；不提供则 check 用脚本默认。校验 min ≤ max，否则 error。

**check**：读 .timing.json 的 started_at + min/max（无则用默认 60/1440）→ 计算 elapsed → 判定 zone → 返回 action + remaining 余量。无记录返回 not_started。

zone → action 映射（确定性判定，agent 据 action 决策）：

| elapsed vs budget | zone        | action        | agent 决策                       |
| ----------------- | ----------- | ------------- | -------------------------------- |
| < min             | below_min   | must_continue | 不得停（除非 PASS）              |
| min ≤ < max       | between     | self_judge    | agent 自判：有路→retry / 无路→停 |
| ≥ max             | above_max   | hard_stop     | 立即停，反馈用户                 |
| 未 reset          | not_started | error         | 先调 reset                       |

输出（check，含 remaining 余量供 agent 规划 retry 策略）：

```json
{
  "qid": "Q2",
  "started_at": "...",
  "elapsed_minutes": 120.0,
  "zone": "between",
  "action": "self_judge",
  "remaining_to_min_minutes": -60.0,
  "remaining_to_max_minutes": 1320.0,
  "min_minutes": 60,
  "max_minutes": 1440
}
```

- `remaining_to_min_minutes`：below_min 区告诉 agent 还须坚持多久（负=已过 min）
- `remaining_to_max_minutes`：between 区告诉 agent 时间余量（负=已过 max）

内部用秒做 zone 边界精确比较（避免 59.9min 报 below_min 但显示 60min 的歧义），输出转 minutes（1 位小数）。

timing 文件 `<workdir>execution/.timing.json`（dotfile，gitignore，脚本自管）：

```json
{
  "questions": {
    "Q1": { "started_at": "2026-07-03T10:00:00+00:00" },
    "Q2": { "started_at": "2026-07-03T10:15:00+00:00", "min_minutes": 30, "max_minutes": 120 }
  }
}
```

（min/max 仅在 reset 显式提供时存入；无则 check 用默认）

### T2. autoresearch SKILL.md 时间预算机制 + 决策 + 自判

**时间预算机制节**：

- 处理 Qn 前（首次或 re-examine）调 `reset`（归零计时，可选 --min/--max）
- 每次 subagent 产出验证后（文件验证 或 verdict 验证）调 `check`
- timing 落盘 .timing.json；re-dispatch 重新处理则 reset 刷新预算，续算则直接 check

**时间预算决策节（统一，适用于所有失败点）**：

- PASS（仅 verdict 场景）→ resolved（无论 zone）
- 任何失败（文件验证不合格 / verdict FAIL/PARTIAL）→ 据 zone：
  - below_min → 不得停止，调整方法/prompt 后重跑对应 subagent，不得机械重复
  - between → agent 自主判断（见自判）：有路→retry / 无路→停
  - above_max → 立即停，写问题分析，回传 needs_attention
- "重跑对应 subagent"：check_artifacts 失败→local-executor；check_verification 失败→research-verifier；verdict FAIL→local-executor

**自判节（去僵化）**：
agent 在 between 区失败后自主判断能否找到正确道路——主动寻找是否还有未试的尝试方向（不限于 PLAN.md 预设方法，可在工作过程中自主发现新方向）。以下情形倾向停止（非 rigid 规则，agent 据情况权衡）：

- verification 指出根本性问题（claim 与物理/数学定律矛盾 / method 根本不适用）
- agent 自身判断没有额外的尝试方向

否则继续 retry（修订方法或尝试新方向）。

### T3. 暂停行为（超时后）

between 自判停止 / above_max 硬停时：

1. 记录已试方法到 research_state.md 的 Failed Attempts（method + 失败原因 + 排除方向）
2. 写问题分析到 Last Phase Result（status=needs_attention），含：失败模式 / 已试方法 / verification 关键发现 / 建议方向
3. **立即回传 needs_attention，不处理其他 question**
4. 已 resolved 的 question 结论保留在 research_state.md

用户收到 needs_attention 后可指示：

- "调整 Q2 方法为 X" → primary agent 修改 PLAN.md + 记 Failed Attempts → re-dispatch autoresearch（reset Q2 刷新预算）
- "跳过 Q2，继续 Q3" → Q2 标 deferred，autoresearch 处理 Q3
- "回 framing 重新框定" → primary agent 重入 framing phase

### T4. 硬约束更新

- MUST: 处理 Qn 前（首次或 re-examine）调 reset；每次 subagent 产出验证后（文件验证或 verdict）调 check；据 zone 决策
- MUST: below_min 区任何失败时不得停止（须 retry 至 min_time，除非 PASS）；每次 retry 须调整方法或 dispatch prompt，不得机械重复
- MUST: between 自判停止 / above_max 硬停时，记录已试方法到 Failed Attempts + 写问题分析到 Last Phase Result + 立即回传 needs_attention

---

## 对其他文件的影响

- **newlayer-6**：顶部加交叉引用注（cycle/文件验证 max 2 已被时间预算替换，见 newlayer-6.1）
- **newlayer-1 §3.2**：research_state.md 模板**不新增** ## Time Budget 节（min/max 配置不入研究状态；节计数维持 13）
- **research-audit SKILL.md §3**：无需改——check_time_budget.py 在 `autoresearch/scripts/`（非 research-audit/scripts/），research-audit §3 只管 post-phase 质量门脚本
- **check_artifacts.py**：无需改——timing 文件在 Active Workdir 内，不触发 outside_workdir；不在 persistence/，不触发 persistence_violations
- **check_verification.py**：无需改——超时暂停的 question 保持 `open`，check_verification 只查 resolved claims
- **.aether/research/.gitignore**：加 `**/.timing.json`（不污染 git 审计轨）
- **health-check run_health_check.py**：无需改——check_time_budget.py 是 autoresearch 专属脚本，不在 research-audit/scripts/，health-check 的 audit_scripts 列表不含它
- **local-executor.md / research-verifier.md**：无需改——时间预算是 autoresearch 调度层机制，不影响 subagent 定义

---

## 预期结果

- autoresearch SKILL.md：~132行 → ~166行（+时间预算机制节 + 统一决策 + 自判 + 硬约束 + 暂停行为）
- 新增 check_time_budget.py：~150行（确定性脚本，PEP 723 header，reset/check 两动作，minutes 单位）
- research-audit SKILL.md：+check_time_budget.py 规格（~20行）
- .aether/research/.gitignore：+.timing.json 规则
- research_state.md 模板：不变（min/max 不入研究状态）

---

## 验收目标

### 语义验收

- [ ] per-question time budget（min/max）替换 cycle max 3 + 文件验证 max 2；SKILL.md 不得存在 `cycle` / `max 2` 终止逻辑
- [ ] 三档 zone 决策：below_min→must_continue / between→self_judge / above_max→hard_stop
- [ ] 时间预算决策适用于**所有失败点**（文件验证不合格 / verdict FAIL/PARTIAL），非仅 verdict
- [ ] 自判去僵化：agent 自主判断 + 两条软性指引（verification 根本性问题 / agent 自判无额外方向），非 rigid checklist；允许 agent 工作中自主发现新方向
- [ ] below_min 区任何失败时不得停止；每次 retry 须调整方法或 dispatch prompt，不得机械重复
- [ ] 超时暂停（between 自判停止 / above_max 硬停）：立即暂停整阶段，写问题分析到 Last Phase Result（status=needs_attention），回传 needs_attention，不处理其他 question
- [ ] min/max 配置不入 research_state.md；默认 60/1440 分钟硬编码脚本，覆盖经 reset --min/--max 存 .timing.json
- [ ] reset 单一动作（始终归零），非幂等 start + 独立 reset 两动作
- [ ] timing 落盘 `<workdir>execution/.timing.json`（gitignore），不入 research_state.md
- [ ] check 输出含 remaining_to_min_minutes / remaining_to_max_minutes（minutes 单位，1 位小数）
- [ ] check_time_budget.py 由 autoresearch 执行期间调用（处理 Qn 前 reset，每次 subagent 产出验证后 check），非 post-phase 质量门
- [ ] 不新增 question status——超时暂停的 question 保持 `open`，分析写入 Last Phase Result

### 脚本强制验收

- [ ] `不得存在` autoresearch SKILL.md 中的 `cycle` / `max 3` / `max 2` 终止逻辑引用
- [ ] `不得存在` autoresearch SKILL.md 中的 `start` 动作引用（已合并为 reset）
- [ ] `不得存在` autoresearch SKILL.md 中的 `## Time Budget` / `research_state.md ... Time Budget` 引用
- [ ] `check_time_budget.py` 存在于 `.aether/skills/autoresearch/scripts/`（非 research-audit/scripts/）
- [ ] `check_time_budget.py reset` 归零 started_at + 存 --min/--max 到 .timing.json；校验 min≤max
- [ ] `check_time_budget.py check` 输出含 `zone` + `action` + `remaining_to_min_minutes` + `remaining_to_max_minutes`
- [ ] `check_time_budget.py` 无 --min/--max 时用默认 60/1440 分钟
- [ ] `.timing.json` 写入 `<workdir>execution/`（gitignore，不在 git 审计轨）
- [ ] `check_artifacts.py` 不误报 `.timing.json`（在 Active Workdir 内，不触发 outside_workdir / persistence_violations）
- [ ] research_state.md 模板**无** `## Time Budget` 节（newlayer-1 §3.2 节计数维持 13）
- [ ] `.aether/research/.gitignore` 含 `**/.timing.json`
