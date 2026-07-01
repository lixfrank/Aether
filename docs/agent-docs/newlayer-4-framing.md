# newlayer-4: framing skill 修改

> 原 `.aether/skills/research-question-framing/SKILL.md`（484行）
>
> - references/re_derive_gap.md（93行）
>   方向指导核心能力，改动需谨慎——推理链生成 / 可证伪 / 依赖图 / 方法适用性不可破坏。

---

## 修改原因与设计依据

**大方向**：framing 是方向指导核心（gap→可证伪问题+依赖图+验收），核心 Step 2-9 不动。删除的是与 FSM 的衔接（re_derive_gap L3 回滚、advance_plan、复杂权威源规则、AUDIT report 读取）。
**设计依据**：design doc §4.3（framing 行）、§3.3（Human Directives 作为输入）、§6.5（Failed Attempts 作为 framing 约束）、§7.4（audit 审推理链）、§13 决策 8。
**具体决策理由**：

- 删 re_derive_gap.md（93行）：L3 回滚 splice 机制是 FSM 的产物，新设计回退=直接重入 framing（design doc §4.4）
- 简化权威源规则：旧规则有复杂对账机制（splice-update、debate 后对账），简化为一条——framing_reasoning.md 是推理记录（供 audit 检测推理正确性），PLAN.md 是后续工作读取的信息文件，debate 修订后 PLAN.md 为权威源
- 读 Failed Attempts 作为约束：已验证失败的方法在 framing 时需考虑替代路径（design doc §6.5）
- 读 Human Directives：人类可能要求增删/调整问题（design doc §3.3）
- gap 来源：ROADMAP.md→analysis.md（gap 在 analysis.md 中，landscape_map.md 提供补充参考）
- 新增 audit 质量门审推理链：framing 的推理链完整性是严谨性关键（design doc §9 约束 4）

---

## 删除

| 段落                                                                 | 行(约) | 理由                                    |
| -------------------------------------------------------------------- | ------ | --------------------------------------- |
| references/re_derive_gap.md 整体                                     | 93     | L3 回滚 splice 机制不再需要，回退用 git |
| front matter 中 "Phase 6 / two modes" 标识                           | —      | 不再有 FSM                              |
| Step1 中 state.json / advance_plan / ROADMAP.md / AUDIT reports 读取 | —      | 状态源改为 research_state.md            |
| "权威源规则"复杂描述                                                 | —      | 简化为三条规则                          |
| Step10 中 advance_plan 调用                                          | —      | advance_plan 已删                       |
| Step11 中复杂 PhaseResultDigest                                      | —      | 改为 Last Phase Result 节 + status 信号 |

## 保留（不动）

- Step2（Select Gaps + Significance Argument）
- Step3（Solution Paths + Tractability Classification，仅对备选 path 分类，排除 Failed Attempts 中的已失败方法）
- Step4（Derive Question + 溯源）
- Step5（Derive Falsification）
- Step6（Inter-Question Dependencies）
- Step7（Write Research Questions + Framing Reasoning）
- Step8（Map to PLAN.md）
- Step9（Check Conventions — 读 research_state.md ## Conventions 节 + 跑 check_conventions.py 验证）
- Integrity 节

> 以上是 framing 的核心能力，原样保留。

## 修改

### M1. front matter description

```yaml
# 旧
description: |
  Phase 6 (phase_framing) of the Path 3 research state machine.
  Converts gaps from literature-landscape-scan into structured, falsifiable research questions...
  Two running modes: full_derive (default) and re_derive_gap (L3 rollback mode)...

# 新
description: |
  将 gap 转化为可证伪问题 + 依赖图 + 验收。方向指导核心能力。
  由 research-worker 调用。产出 <workdir>PLAN.md + research_questions.md + framing_reasoning.md。
```

### M2. 输入输出

```markdown
# 旧

Input: ROADMAP.md + landscape_map.md + AUDIT reports

# 新

Input: <workdir>analysis.md（gap 来源）+ <workdir>landscape_map.md（若存在，补充参考）+ persistence/research_state.md
Output: <workdir>PLAN.md + <workdir>research_questions.md + <workdir>framing_reasoning.md
```

### M3. 权威源规则简化

```markdown
# 旧（复杂多段描述）

framing_reasoning.md 是依赖数据的权威源...
PLAN.md 在 re_derive_gap 模式下 splice-update...
debate 修订后 framing_reasoning.md 与 PLAN.md 对账...

# 新（一条规则）

framing_reasoning.md 是推理记录文件，用于检测推理正确性（audit 审推理链）。
PLAN.md 是后续工作（debate/execution）实际读取的信息文件。
debate 修订 PLAN.md 后，PLAN.md 为执行阶段的权威源，framing_reasoning.md 不随后续修订同步。
```

### M4. Step1 简化

```markdown
# 旧

Step 1: Read state.json / advance_plan / ROADMAP.md / AUDIT reports / landscape_map.md

# 新

Step 1: Read persistence/research_state.md + <workdir>analysis.md（gap 来源）+ <workdir>landscape_map.md（若存在，补充参考）

- 获取 Research Goal / Current Understanding / Failed Attempts / Human Directives
- Failed Attempts 作为 framing 约束（已知失败方法不再选为 solution path）
- Human Directives 作为人类增删/调整指示
```

### M5. gap 来源

```markdown
# 旧

从 ROADMAP.md 读取 gap

# 新

从 <workdir>analysis.md 读取 gap（analysis.md 是 gap 识别的权威来源）
若 <workdir>landscape_map.md 存在，读取其 open problems / controversies 作为补充参考
（landscape_map.md 负责文献景观，gap 本身在 analysis.md 中；landscape 可回写补充 analysis.md 的 gap）
```

### M6. 产出路径

```markdown
# 旧

Write to persistence/PLAN.md, persistence/research_questions.md, ...

# 新

Write <workdir>PLAN.md, <workdir>research_questions.md, <workdir>framing_reasoning.md
```

### M7. Step10 改为更新 research_state.md（删 advance_plan）

```markdown
# 旧

Step 10: advance_plan(phase=debate, ...)

# 新

Step 10: 更新 persistence/research_state.md

- Questions / Claims: 写入各 question（status=open / method / dependencies / notes）
- Dependency Graph: 写入 Q1→Q2→Q3
- Phase History 追加 framing✓
```

### M8. 回传 status 信号

```markdown
Step 11: 更新 research_state.md 的 Last Phase Result 节 (phase=framing / status / summary / issues),
回传 status 信号 (completed | needs_attention)
```

## 新增

### A1. 从 Failed Attempts 读取已知失败方法作为 framing 约束

```markdown
Step 1 扩展: 读 research_state.md 的 Failed Attempts

- 已验证为错的方法直接排除，不再出现在 Step3 的备选 solution paths 中
- Step3 Tractability Classification 只对备选 solution paths（排除已失败的）做可行性预判（HIGH/MEDIUM/LOW），不在 Tractability 中重复标记 infeasible
- Failed Attempts 中的失败条件可帮助定义 question 的 falsification criterion（Step5）：
  例如"解析延拓在 m→0 发散"是已知失败条件，则对应 question 的 falsification criterion 可引用此条件
```

### A2. 从 Human Directives 读取人类指示

```markdown
Step 1 扩展: 读 research_state.md 的 Human Directives

- 人类指示可能涉及增删问题、调整方法、修改依赖关系等
- agent 按自身理解参考人类指示，灵活调整 framing 各步骤的产出
- 不做机械的指示→步骤映射，而是理解指示意图后自然融入 framing 推理
- 处理后标记 [processed×]
```

### A3. 质量门（与 newlayer-7 §1 对齐）

```markdown
Step N: 质量门

1. worker 跑 scripts（bash，确定性）:
   - check_artifacts.py → 验证 <workdir>PLAN.md + research_questions.md + framing_reasoning.md 存在非空
   - check_sources.py → 验证 framing_reasoning.md 中 [src:id] 引用都有下载文件
   - 不过 → worker 自补，重跑 scripts
2. worker dispatch research-audit sub-subagent（fresh context，避免 self-review bias）:
   - sub-subagent 读 framing_reasoning.md + PLAN.md，按 newlayer-7 §2 审计方向审:
     推理链是否完整(无跳步) / 问题是否可证伪 / 方法是否适用 / 依赖图是否无环 / 验收标准是否充分
   - 输出 FATAL/CONCERN/PASS 报告
3. worker 读报告:
   - PASS → 通过
   - CONCERN/FATAL → 自修（推荐 2 次），修后重新 dispatch 审计 sub-subagent
   - 严重问题（无法自修）→ 须写明原因，写入 Last Phase Result issues
```

---

## 预期结果

- SKILL.md 从 484行 → ~400行（删 re_derive_gap 模式 / 复杂权威源规则 / FSM 衔接，加 research_state.md 更新 + 质量门）
- references/re_derive_gap.md: 93行 → 0（删除）
