# newlayer-3: landscape skill 修改

> 原 `.aether/skills/literature-landscape-scan/SKILL.md`（247行）
> 对应设计文档 §4.3 phase 能力包（landscape）。改动较轻——landscape 改为可选 phase。

---

## 修改原因与设计依据

**大方向**：landscape 旧设计绑定 FSM 路由（audit_1 findings 注入）+ advance_plan，新设计改为可选调用、直接更新 research_state.md。改动较轻。
**设计依据**：design doc §4.3（landscape 行：可选调用非强制 phase）、§4.1（依赖序）、§6.5（Failed Attempts 作为约束）、§7.4（audit 质量门 sub-subagent）、§13 决策 8。
**具体决策理由**：

- 删 SUPPLEMENTARY TASK（audit_1 findings injection）：不再有 audit_1 独立 phase，landscape 不再被 audit 路由强制注入补缺任务
- 读 Failed Attempts：避免重复扫描已排除方向（design doc §6.5）
- 产出路径改为 <workdir>：配合 slug 机制（design doc §3.6）
- 质量门采用 sub-subagent：与 newlayer-7 §1 对齐（scripts 由 worker 跑，语义审计 dispatch 独立 sub-subagent）

---

## 删除

| 段落                                                 | 理由                                    |
| ---------------------------------------------------- | --------------------------------------- |
| front matter 中 "Phase 4 / audit_1 路由" 标识        | 不再有 FSM 路由                         |
| Step1 中 state.json / advance_plan                   | 状态源改为 research_state.md            |
| "SUPPLEMENTARY TASK"（audit_1 findings injection）节 | audit_1 已合并，无独立 findings 注入    |
| 末尾复杂 PhaseResultDigest                           | 改为 Last Phase Result 节 + status 信号 |

## 保留（据当前原则灵活调整，非硬性照搬旧设计）

landscape skill 的核心能力是文献景观扫描，产出 landscape_map.md。具体保留内容：

- **domain map**：研究领域的方法/问题分类图谱。据 analysis.md 的 gap 和 Research Goal 聚焦扫描，非无目标泛搜
- **school classification**：识别不同学派/方法路线及其核心差异。据 Failed Attempts 排除已失败方向
- **timeline**：关键论文的时间线与演化关系
- **controversies**：标注领域内争议点及各方立场（须有 [src:id] 引用支撑）
- **open problems**：开放问题列表（供 framing 消费）
- research-explorer dispatch 机制（文献检索委托给 research-explorer）
- landscape_map.md 产出结构（上述各节）

## 修改

### M1. front matter description

```yaml
# 旧
description: |
  Phase 4 (phase_landscape) of the Path 3 research state machine.
  Scans literature landscape for a research topic...

# 新
description: |
  文献景观扫描，可选调用，非强制 phase。产出 <workdir>landscape_map.md。
  由 research-worker 调用。可选——analysis 后 framing 前按需调用。
  若扫描中发现 analysis.md 的 gap 识别有误或遗漏，可回写补充 analysis.md。
```

### M2. 输入输出

```markdown
# 旧

Input: state.json + ROADMAP.md

# 新

Input: <workdir>analysis.md + persistence/research_state.md
Output: <workdir>landscape_map.md（若发现 analysis.md 遗漏 gap，可回写补充 analysis.md）
```

### M3. Step1 改为读 research_state.md + analysis.md + Failed Attempts

```markdown
# 旧

Step 1: Read state.json via get_state, advance_plan...

# 新

Step 1: Read persistence/research_state.md + <workdir>analysis.md

- 获取 Research Goal / Current Understanding / Failed Attempts
- Failed Attempts 中的失败方法作为景观扫描的排除线索
- analysis.md 的 gap 识别作为扫描聚焦点（非无目标泛搜）
```

### M4. 产出路径

```markdown
# 旧

Write landscape_map.md to persistence/

# 新

Write <workdir>landscape_map.md
```

### M5. 末尾改为更新 research_state.md（删 advance_plan）

```markdown
# 旧

末尾: advance_plan(phase=framing, ...)

# 新

末尾: 更新 persistence/research_state.md

- 推荐更新: Phase History 追加 landscape✓ / Current Understanding 追加景观发现
  （agent 据发现可灵活更新其他节，不限于以上推荐）
- 若回写了 analysis.md，在 Phase History 注明 "analysis.md updated by landscape"
```

## 新增

### A1. 质量门（与 newlayer-7 §1 对齐）

```markdown
Step N: 质量门

1. worker 跑 scripts（bash，确定性）:
   - check_artifacts.py → 验证 <workdir>landscape_map.md 存在非空
   - check_sources.py → 验证 landscape_map.md 中 [src:id] 引用都有下载文件
   - 不过 → worker 自补，重跑 scripts
2. worker dispatch research-audit agent（fresh context，避免 self-review bias）:
   - sub-subagent 读 <workdir>landscape_map.md，按 newlayer-7 §2 审计方向审:
     学派分类是否准确 / 时间线是否完整 / 争议标注是否有据 / 覆盖度是否充分
   - 输出 FATAL/CONCERN/PASS 报告
3. worker 读报告:
   - PASS → 通过
   - CONCERN/FATAL → 自修（推荐 2 次），修后重新 dispatch 审计 sub-subagent
   - 严重问题（无法自修）→ 须写明原因，写入 Last Phase Result issues
```

### A2. 回传 status 信号

```markdown
更新 research_state.md 的 Last Phase Result 节 (phase=landscape / status / summary / issues),
回传 status 信号 (completed | needs_attention)
```

---

## 预期结果

SKILL.md 从 247行 → ~210行（删 audit_1 路由 / SUPPLEMENTARY TASK / digest，加 research_state.md 更新 + 质量门 + 保留内容明确化）。

---

## 验收目标

### 语义验收

- [ ] skill name 保留 `literature-landscape-scan`（不改名），front matter description 标注"可选调用，非强制 phase"
- [ ] landscape 是可选 phase：analysis 后 framing 前按需调用，非强制执行
- [ ] 读取 Failed Attempts 作为景观扫描排除线索（避免重复扫描已排除方向）
- [ ] 读取 analysis.md 的 gap 识别作为扫描聚焦点（非无目标泛搜）
- [ ] landscape_map.md 产出结构包含：domain map / school classification / timeline / controversies（须有 [src:id] 引用）/ open problems
- [ ] 若扫描中发现 analysis.md 的 gap 识别有误或遗漏，可回写补充 analysis.md
- [ ] 产出路径为 `<workdir>landscape_map.md`（配合 slug 机制）
- [ ] 质量门流程与 newlayer-7 §1 对齐：check_artifacts.py + check_sources.py → dispatch research-audit agent → 自修
- [ ] 回传格式：Last Phase Result 节写入 `phase=landscape / status / summary / issues`

### 脚本强制验收

- [ ] `不得存在` SKILL.md 中的 `audit_1` / `SUPPLEMENTARY TASK` / `audit_1 findings injection` 引用
- [ ] `不得存在` SKILL.md 中的 `advance_plan` 调用
- [ ] `不得存在` SKILL.md 中的 `state.json` / `get_state` 引用
- [ ] `不得存在` SKILL.md 中的 `PhaseResultDigest` 引用
- [ ] `不得存在` SKILL.md 中的 `Phase 4` / `phase_landscape` FSM 标识
- [ ] `不得存在` 产出路径引用 `persistence/landscape_map.md`（应为 `<workdir>landscape_map.md`）
- [ ] `check_artifacts.py` 验证 `<workdir>landscape_map.md` 存在非空
- [ ] `check_sources.py` 验证 landscape_map.md 中所有 `[src:id]` 引用都有下载文件
