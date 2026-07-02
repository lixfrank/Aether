---
name: debate
owner: research
description: |
  辩论编排 skill。指引 worker 编排 critique/rebuttal sub-subagent，
  自做 adjudication + repair。由 research-worker 调用。
---

# Debate Orchestration

worker 内部从 round 1 开始，自行管理轮次。

## 编排逻辑

worker 读 `<workdir>PLAN.md`, `persistence/research_state.md`

```
├─ dispatch sub-subagent: debate-critic (delegation_depth: 0)
│ → critic 写 critique 到 <workdir>DEBATE.md，返回
│ （worker 不在此处读 DEBATE.md——直接派 rebuttal，由 rebuttal 自行读）
├─ dispatch sub-subagent: debate-rebuttal (delegation_depth: 0)
│ prompt: "读 <workdir>DEBATE.md 获取最新 critique，回应之"
│ → rebuttal 写 rebuttal 到 <workdir>DEBATE.md，返回
├─ worker 自做 adjudication:
│ 读 DEBATE.md 的 critique + rebuttal，对每 topic 裁决:
│ UPHELD = critique 不成立（rebuttal 成功反驳）
│ REVISE = critique 成立，需修改 PLAN
│ ESCALATE = 双方都有道理，worker 无法判定，需下一轮深入
│ 写 adjudication 到 <workdir>DEBATE.md
├─ worker 自做 repair（若 REVISE）:
│ 据 REVISE 裁决修改 <workdir>PLAN.md / <workdir>research_questions.md
│ ESCALATE topics 不修，留给下一轮
│ 写 repair 到 <workdir>DEBATE.md
├─ worker 判断是否需下一轮:
│ 有 ESCALATE 且 round < 2 → worker 内部继续下一轮
│ round 2 仍有 ESCALATE → 写 Last Phase Result (phase=debate / status=needs_attention / summary / issues=[ESCALATE topics]), 回传 needs_attention
│ 无 ESCALATE → 写 Last Phase Result (phase=debate / status=completed / summary / issues=[]), 回传 completed
```

## 轮次管理

- max 2 轮（旧 3 轮）：第 2 轮聚焦 ESCALATE + 未决问题足够
- round 2 聚焦：worker 给 critic/rebuttal dispatch prompt 加 "FOCUS on: [ESCALATE topics]"
- DEBATE.md 结构不严格要求：agent 灵活组织内容，只需确保 critique / rebuttal / adjudication / repair 各轮内容可辨识

## 人类参与

debate 完成（needs_attention 或 completed）后在 pause 点呈现裁决摘要，人类可询问 / 讨论 / 指示

## 质量门（与 newlayer-7 §1 对齐）

1. worker 跑 scripts（bash，确定性）:
   - `check_artifacts.py <research_state.md> <workdir>DEBATE.md` → 验证 DEBATE.md 存在非空
   - 若修订了 PLAN.md → check_artifacts.py 验证 PLAN.md 存在非空
   - 不过 → worker 自补，重跑 scripts
2. worker dispatch research-audit agent（fresh context，避免 self-review bias）:
   - sub-subagent 读 `<workdir>DEBATE.md` + 修订后的 PLAN.md，按 newlayer-7 §2 审计方向审:
     critique 是否覆盖关键 debate topics / rebuttal 是否回应所有 critique points /
     adjudication 裁决是否合理 / repair 修订是否正确
   - 输出 FATAL/CONCERN/PASS 报告
3. worker 读报告:
   - PASS → 通过
   - CONCERN/FATAL → 自修（推荐 2 次），修后重新 dispatch 审计 sub-subagent
   - 严重问题（无法自修）→ 须写明原因，写入 Last Phase Result issues

## 回传

更新 research_state.md 的 Last Phase Result 节 (phase=debate / status / summary / issues)，
回传 status 信号 (completed | needs_attention)
