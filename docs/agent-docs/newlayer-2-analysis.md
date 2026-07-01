# newlayer-2: analysis skill 修改

> 原 `.aether/skills/deep-research/SKILL.md`（239行）→ 重命名目录为 `.aether/skills/analysis/`，skill name 改为 `analysis`
> 对应设计文档 §4.3 phase 能力包（analysis）、§3（状态模型）

---

## 修改原因与设计依据

**大方向**：analysis 是研究起点，旧设计产出 ROADMAP.md（内容与其他文件高度重合）+ 调 advance_plan（FSM 产物）。新设计让 analysis 直接初始化 research_state.md（单一状态来源）+ 产出 analysis.md（详细分析），不再产 ROADMAP。
**设计依据**：design doc §3.1-3.2（research_state.md 定位与结构）、§3.4（ROADMAP 取消）、§3.6（slug 创建）、§4.3（analysis 行）、§7.4（audit 质量门 sub-subagent）、§13 决策 8。
**具体决策理由**：

- 删 ROADMAP.md 产出：ROADMAP 各节被瓜分，analysis 改为初始化 research_state.md 的 Research Goal/Current Understanding/Phase History（design doc §3.4）
- 新增 slug 创建（Step 1b）：analysis 是新项目的入口，需创建 notepads/<slug>/ 并记录 Active Workdir（design doc §3.6）
- 新增 audit 质量门：产出后 worker 跑 scripts + dispatch research-audit agent 做语义审计（design doc §7.4, newlayer-7 §1）
- 文献下载委托给 research-explorer：analysis 不需关注下载路径/registry 细节，research-explorer 统一管理搜索与下载（newlayer-9）

---

## 删除

| 段落                                                 | 理由                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| front matter 中 "Phase 1 / Entry Gate / Path 3" 标识 | 不再有 Entry Gate FSM                                                                                                                                    |
| Step1 中 state.json / get_state 读取                 | 状态源改为 research_state.md                                                                                                                             |
| Step1 中 convention_lock_status 检查                 | convention 由 agent 灵活管理（任何 phase 发现需要约定时均可写入 research_state.md ## Conventions 节），不限定特定 phase；check_conventions.py 验证一致性 |
| Step3.5 中 literatures/index.json 引用               | 下载委托给 research-explorer，analysis 不关注下载细节                                                                                                    |
| Step5（Write ROADMAP.md）整节                        | ROADMAP.md 已删，gap / 方向并入 analysis.md                                                                                                              |
| Step7 中 advance_plan 调用                           | advance_plan 已删                                                                                                                                        |
| Step8 中复杂 PhaseResultDigest                       | 改为 Last Phase Result 节 + status 信号                                                                                                                  |

## 保留

- Step2（Clarify Question）
- Step3（Gather Info）
- Step4（Synthesize）
- Step6（Write Analysis，改路径）
- Source Evaluation / Integrity 节

## 修改

### M1. front matter

```yaml
# 旧
name: deep-research
description: |
  Phase 1 of the Path 3 research state machine. Entry Gate...

# 新
name: analysis
description: |
  深度分析 skill。澄清研究目标、收集信息、综合分析、产出 analysis.md 并初始化/更新 research_state.md。
  由 research-worker 调用。产出 <workdir>analysis.md。
```

### M2. 输入输出

```markdown
# 旧

Output: ROADMAP.md + analysis

# 新

Input: research_state.md（恢复上下文）+ 用户研究 prompt（新项目）
Output: <workdir>analysis.md + 更新 persistence/research_state.md
```

### M3. Step1 改为读 research_state.md

```markdown
# 旧

Step 1: Read state.json via get_state MCP tool...

# 新

Step 1: Read persistence/research_state.md

- 存在 → 恢复上下文（Research Goal / Current Understanding / Phase History / Human Directives）
- 不存在 → 新项目，使用 dispatch prompt 中的用户研究 prompt
```

### M4. 删 Step5，原 Step6 → Step5

```markdown
# 旧 Step5: Write ROADMAP.md（整节删除）

# 旧 Step6 → 新 Step5: Write <workdir>analysis.md

analysis.md 是 analysis phase 的详细工作产物，兼具输出与推理记录功能。
须包含详细的推理过程（从文献到 gap/方向的论证链，含 [src:id] 引用与证据），
不能直接简单给出结论。research_state.md 的 Current Understanding 是从中提取的摘要。
下游消费者（landscape/framing/debate/audit）读取 analysis.md 获取详细论证依据。
```

## 新增

### A1. Step1b 新建 slug 与 workdir（新项目时）

```markdown
Step 1b（新项目）: 从 Research Goal 派生 slug（连字符化 ≤30 字符），
读 Workdir History 防冲突，创建 notepads/<slug>/，更新 Active Workdir。
```

### A2. Step6 初始化/更新 research_state.md

```markdown
Step 6: 初始化或更新 persistence/research_state.md

- 新项目: 创建 research_state.md，填充 Research Goal / Current Understanding / Active Workdir / Phase History
- 回退重入: 据发现灵活更新相关节（推荐更新 Current Understanding + Phase History，
  但 agent 据发现可更新其他节如 Failed Attempts / Questions/Claims 等）
```

### A3. Step7 跑 research-audit 质量门

```markdown
Step 7: 质量门（与 newlayer-7 §1 对齐）

1. worker 跑 scripts（bash，确定性）:
   - check_artifacts.py → 验证 <workdir>analysis.md 存在非空 + research_state.md 存在
   - check_sources.py → 验证 analysis.md 中 [src:id] 引用都有下载文件
   - 不过 → worker 自补，重跑 scripts
2. worker dispatch research-audit agent（fresh context，避免 self-review bias）:
   - sub-subagent 读 <workdir>analysis.md，按 newlayer-7 §2 审计方向审:
     引用是否真支持论断 / 事实是否准确 / gap 识别是否合理 / 领域覆盖是否充分
   - 输出 FATAL/CONCERN/PASS 报告
3. worker 读报告:
   - PASS → 通过
   - CONCERN/FATAL → 自修（推荐 2 次），修后重新 dispatch 审计 sub-subagent
   - 严重问题（无法自修）→ 须写明原因，写入 Last Phase Result issues
```

### A4. Step8 回传 status 信号

```markdown
Step 8: 更新 research_state.md 的 Last Phase Result 节 (phase=analysis / status / summary / issues),
回传 status 信号 (completed | needs_attention)
```

---

## 预期结果

SKILL.md 从 239行 → ~220行（删 ROADMAP / Entry Gate / digest，加 research_state.md 初始化 + 质量门）。

---

## 验收目标

### 语义验收

- [ ] skill name 从 `deep-research` 改为 `analysis`，目录从 `skills/deep-research/` 改为 `skills/analysis/`
- [ ] analysis 是新项目入口：新项目时创建 slug + notepads/<slug>/ + 初始化 research_state.md（Research Goal / Current Understanding / Active Workdir / Phase History）
- [ ] 回退重入时：更新 Current Understanding + Phase History，不重新创建 slug
- [ ] analysis.md 包含详细推理过程（从文献到 gap/方向的论证链，含 [src:id] 引用），不是简单结论；research_state.md 的 Current Understanding 是从中提取的摘要
- [ ] 质量门流程：worker 跑 check_artifacts.py + check_sources.py → dispatch research-audit agent（fresh context）→ 据报告自修（推荐 2 次）→ 严重问题写入 Last Phase Result issues
- [ ] 回传格式：Last Phase Result 节写入 `phase=analysis / status / summary / issues`，回传 `completed` 或 `needs_attention`
- [ ] convention 检查不在 analysis 阶段执行（analysis 是通用分析；约定由 agent 在任何 phase 发现需要时写入 research_state.md ## Conventions 节，framing Step 9 是主要设置+验证点但非唯一）
- [ ] 文献下载委托给 research-explorer，analysis 不关注下载路径/registry 细节

### 脚本强制验收

- [ ] `不得存在` `skills/deep-research/` 目录（已重命名）
- [ ] `不得存在` SKILL.md 中的 `ROADMAP.md` 产出引用
- [ ] `不得存在` SKILL.md 中的 `advance_plan` 调用
- [ ] `不得存在` SKILL.md 中的 `get_state` / `state.json` 引用
- [ ] `不得存在` SKILL.md 中的 `PhaseResultDigest` / `phase_result` YAML 引用
- [ ] `不得存在` SKILL.md 中的 `Entry Gate` / `Path 3` 标识
- [ ] `不得存在` SKILL.md 中的 `convention_lock_status` 调用（convention 检查移到 framing）
- [ ] `check_artifacts.py` 验证 `<workdir>analysis.md` 存在非空 + `persistence/research_state.md` 存在
- [ ] `check_sources.py` 验证 analysis.md 中所有 `[src:id]` 引用都有下载文件（registry.json 注册 + literatures/ 文件存在）
