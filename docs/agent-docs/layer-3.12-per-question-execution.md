# Layer 3.12: Per-Question Execution — 逐问题推进与失败传播

> 依赖 Layer 3.11（framing_reasoning.md 的 Dependency Graph + Execution Order + critical dependency + fallback path）。
> 修改 phase_execution 从"一次性解决所有问题"改为"autoresearch 内部管理 per-question 推进"（方案 D）。
> 新增失败传播机制（B+C 混合：fallback 自动降级 + 用户决策兜底）。
> 与 Layer 3.11 可独立实施——Layer 3.11 完成后 PLAN.md 已有 Execution Order，Layer 3.12 使用它来驱动 autoresearch 内部逐 question 推进。

---

## 问题

当前 phase_execution 一次性派遣 worker 解决所有研究问题，存在四个结构性缺陷：

1. **忽略依赖关系**：研究问题之间存在知识层面的前置依赖（Q2 的假设建立在 Q1 的结论之上），一次性执行无法利用前置结论指导后续问题
2. **失败传播粗糙**：Q1 失败时，无法精准判断哪些后续问题受影响、哪些仍可执行、是否有 fallback path 可降级尝试
3. **执行记录混杂**：所有问题的执行记录混在单一 EXECUTION.md 中，无法追踪单个问题的解决过程、无法让后续 worker 精读前置问题的结果
4. **推理过程未被记录和验证**：当前 EXECUTION.md 只记录执行结果（数值、代码、输出），不记录从 PLAN.md claims 到具体求解步骤的推理过程；verification 只检查 claims 是否通过 falsification criterion，不检查推导过程是否忠于 PLAN.md 方法设计、是否跳步、是否引入了未声明假设。如果 worker 偏离了 PLAN.md 设计的方法（如本应使用 SymPy 维度分析但实际用了 LLM 推理），无法检测这种偏离

---

## 设计决策

### 为什么逐 question 推进而非并行

同一 Wave 内的 question 串行执行，理由：

1. **协调复杂度**：并行派遣多个 research-worker 同时写不同文件、同时消耗计算资源，协调成本高
2. **资源竞争**：research 项目通常不会同时跑两个 SymPy 计算，串行更可控
3. **前置输入可用性**：即使同一 Wave 内 question 无依赖关系，前一个 question 的执行结果可能为后一个提供有用的上下文（如共享 ENVIRONMENT.md 环境探测结果）
4. **失败处理简单**：串行执行中 Q1 失败时，coordinator 可以立即决定是否继续 Q3，不需要处理"并行 Q3 正在运行但 Q1 刚失败"的并发状态

### Wave 内 question 执行顺序

同一 Wave 内无互相依赖的 question 按 tractability confidence 从高到低执行（此排序规则与 Layer 3.11 §Execution Order 中的排序要求一致，在此重申以强调其强制性）：

| 排序依据                                      | 来源                                 | 理由                                                                                                                                      |
| --------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| tractability confidence (HIGH > MEDIUM > LOW) | PLAN.md §Claims 的 tractability 字段 | HIGH confidence question 更容易成功，先执行可为后续 MEDIUM/LOW question 提供更可靠的前置上下文；若 HIGH question 意外失败，可尽早暴露问题 |

tractability confidence 相同时，按 PLAN.md Execution Plan 中的排列顺序执行。

### ENVIRONMENT.md 共享与增量更新

ENVIRONMENT.md 在同一 phase_execution 内所有 question 间共享。每个 question 的 execution worker 都必须读取已有 ENVIRONMENT.md 获取当前环境状态（包括 venv_state.installed_packages 等动态字段）。如果当前 question 的任务需要额外软件或环境变更（如新包安装、新工具探测），**autoresearch worker 亲自使用 bash 工具执行补充探测**（如 `pip list`、`python -c "import sympy"` 等），并将探测结果增量写入 ENVIRONMENT.md——而非委托 local-executor 修改（local-executor 是 delegation_depth=0 的叶子节点，不应直接修改 persistence/ 共享文件），也非委托 verification worker 修改。autoresearch 作为 per-question 推进管理器拥有 bash 工具权限，可以直接执行环境探测命令。

### 术语约定

**Wave** = 拓扑排序的依赖批次（来自 PLAN.md §Execution Plan），如 Wave 1 = [Q1, Q3]，Wave 2 = [Q2]。**cycle** = autoresearch 的 retry cycle（cycle 1 = 首次执行，cycle 2 = 第一次 retry，cycle 3 = 第二次 retry），与本文档的 Wave 语义完全独立。同一 question 的不同 retry 对应不同的 cycle 编号，同一 Wave 内的不同 question 之间不使用 cycle 计数——每个 question 有自己独立的 cycle 计数器。

**Qn** = PLAN.md §Execution Plan 中每个研究问题的序号标识，n 从 1 开始递增（Q1, Q2, Q3, Q4, ...）。Qn 的编号与 PLAN.md §Claims 中 `question` 字段值对应（如 `question: Q1` 的 claims 属于 Q1）。Qn 在文件命名和 state.json 键名中统一使用此标识（如 Q1_REASONING.md, state.json.question_status.Q1）。

**自包含型 Dependencies** = PLAN.md Execution Plan 中每个 question 的 Dependencies 字段包含完整的依赖描述（dependency description、critical 标注及理由、fallback path 描述含适用范围和来源引用），不依赖外部引用（如"见 framing_reasoning.md §某 section"）。autoresearch 在 phase_execution 中读取依赖数据时以 PLAN.md 为首要来源，framing_reasoning.md 仅作为 fallback 参考（见 §与 Layer 3.11 的实施依赖关系 依赖数据权威源规则）。

### 失败传播策略：B+C 混合

| 步骤                                                    | 行为                                                                                                                                  | 理由                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Q1 失败 → 检查 PLAN.md fallback path                    | 如果 Q1 的 critical dependency 标注为 false（有 fallback）→ 后续 question 用 fallback 假设继续                                        | 利用 debate 设计的 plan resilience，不浪费后续 question 的可执行性 |
| Fallback 也失败 → 区分执行层面/设计层面                 | 执行层面：正常 retry（最多 3 次），retry 耗尽 → 暂停询问用户；设计层面（fallback_applicability=FAIL）：立即暂停询问用户，不消耗 retry | 见 §Fallback 失败的分类与处理                                      |
| Q1 失败 + critical dependency = true → 标记后续 blocked | 受影响 question 自动标记为 blocked，不尝试                                                                                            | 避免在无可行假设的情况下浪费资源                                   |

#### Fallback 失败的分类与处理

当使用 fallback assumption 执行的 question（Qd）本身失败时，需区分两类性质：

| 失败性质     | 包含场景                                                                                 | Retry 是否有意义 | 处理方式                                                 | 理由                                                                            |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **执行层面** | 计算崩溃/报错（execution 失败）；结论未通过 falsification criterion（verification 失败） | 有               | 正常 retry（最多 3 次）。Max retries 耗尽 → 暂停询问用户 | 失败在执行过程或方法适配，retry 可能改善                                        |
| **设计层面** | reasoning verification 发现 fallback assumption 的适用范围不覆盖当前 question 的实际用法 | 无               | **立即暂停询问用户**，不消耗 retry 次数                  | 根本原因在 fallback path 设计时未考虑此 question 的实际需求，retry 不会改变事实 |

判断规则：reasoning verification 中 `fallback_applicability = FAIL` → 设计层面失败，立即暂停。其余所有失败（execution 失败、conclusion verification 失败）→ 执行层面失败，先 retry 再暂停。

#### Fallback assumption 的传递方式

当 Q1 失败且后续 question Q2 有 fallback path 时：

1. Autoresearch worker 在构造 Q2 的 local-executor prompt 时标注"Q1 已失败，本 question 使用 fallback assumption"，并从 Q1_REASONING.md + Q1_EXECUTION.md 中提取 Q1 的 failure context 直接注入 prompt（per-question digest 不写入 DIGESTS.md，见 §Digest Schema 写入规则）。Fallback assumption 描述从 PLAN.md §Execution Plan Dependencies for Q2（自包含型：包含 fallback path 描述、适用范围、来源引用）提取并注入 prompt
2. Worker 执行 Q2 时，可尝试读取 Q1 的工作记录（Q1_REASONING.md + Q1_EXECUTION.md）获取更详细的失败上下文——但 Q1 文件可能不存在（极端场景：Q1 execution worker 连续崩溃未产出文件），此时 worker 应以 autoresearch 注入的 failure summary + PLAN.md Dependencies 的 fallback description 作为必要信息来源，而非依赖 Q1 文件。仅在 PLAN.md Dependencies fallback 信息不完整时，以 framing_reasoning.md §Inter-Question Dependencies 作为 fallback 参考（需注意标注 `[debate_repair_modified]` 的 section 可能过时）
3. Worker 在 Q2_REASONING.md §Dependency Usage 中记录 fallback assumption 的使用细节

### 输出文件结构：单独文件 + 备份历史 + 推理记录 + 汇总文件

每个 question 的执行、推理和验证记录单独放置。当前 cycle 的文件使用无后缀命名（Qn_REASONING.md），每次 retry 时旧文件备份为 \_cycle[N] 后缀，新文件替换当前版本：

```
.aether/research/notepads/<slug>/execution/
  Q1_REASONING.md         # Q1 当前有效版本（最新 cycle 的推理过程）
  Q1_EXECUTION.md         # Q1 当前有效版本（最新 cycle 的执行结果）
  Q1_VERIFICATION.md      # Q1 当前有效版本（最新 cycle 的验证报告）
  Q1_REASONING_cycle1.md   # Q1 cycle 1 的备份（retry 后移入）
  Q1_EXECUTION_cycle1.md
  Q1_VERIFICATION_cycle1.md
  Q1_REASONING_cycle2.md   # Q1 cycle 2 的备份（如果进行了第 3 次 retry）
  Q1_EXECUTION_cycle2.md
  Q1_VERIFICATION_cycle2.md
  ...
  Q2_REASONING.md
  Q2_EXECUTION.md
  ...

.aether/research/persistence/
  EXECUTION.md            # phase 级汇总：所有 resolved question 的结论摘要（execution 无法继续推进时写入）
  VERIFICATION.md         # phase 级汇总：所有 resolved question 的验证结论摘要（execution 无法继续推进时写入）
```

**版本规则**：

- Worker 始终写入 `Qn_REASONING.md` / `Qn_EXECUTION.md` / `Qn_VERIFICATION.md`（无后缀）
- Retry 前，autoresearch worker 将当前文件备份为 `_cycle[N]` 后缀（N 为当前 cycle 编号）
- Retry 后，worker 写入新版本替换当前文件（无后缀）
- `_cycle[N]` 备份保留用于审查和对比，但不参与后续判断
- Coordinator 和后续 worker 只读取无后缀的当前版本文件

**persistence 汇总文件**：

- `persistence/EXECUTION.md` 和 `persistence/VERIFICATION.md` 在 execution 无法继续推进时由 autoresearch worker 写入——写入时机、格式和职责见 §persistence 汇总格式（此处不重复定义写入时机规则）
- 汇总格式以结论索引和引用为主，不复写详细内容（见 §persistence 汇总格式）

**目录职责边界**：

| 目录                         | 职责                                                                                                        | 写入者                                         | 写入时机                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `notepads/[slug]/execution/` | per-question 工作文件（REASONING + EXECUTION + VERIFICATION + 备份）                                        | autoresearch 内部派遣的 worker（per question） | 每个 question 执行/验证完成后                                                                                              |
| `persistence/`               | phase 级状态与汇总文件（EXECUTION.md + VERIFICATION.md + ENVIRONMENT.md + STATE.md + PLAN.md + DIGESTS.md） | autoresearch worker（汇总 + ENVIRONMENT.md）   | ENVIRONMENT.md：首个 question 执行时；EXECUTION.md + VERIFICATION.md：execution 无法继续推进时（autoresearch worker 写入） |

**旧路径废止规则**：autoresearch 不再在每个 cycle 追加写入 `persistence/EXECUTION.md` 和 `persistence/VERIFICATION.md`（旧行为废止），改为执行结束时一次性写入汇总（见 §输出文件结构 写入时机）。

单独文件（notepads）的优点：

- worker context 更聚焦（只需读取当前 question + 依赖 question 的当前版本结果）
- 失败传播清晰（Q1 的结果决定 Q2 是否可执行）
- 验证范围精确（Q1_VERIFICATION.md 只验证 Q1 的 claims）
- 推理过程可审查（Q1_REASONING.md 记录从 PLAN 方法到具体求解的推导过程）
- 历史可追溯（retry 的推理变化可通过对比 \_cycle1 vs 当前版本审查）

### 为什么需要执行推理记录

当前 EXECUTION.md 只记录执行结果（数值、代码、输出），不记录从 PLAN.md claims 到具体求解步骤的推理过程。这导致：

1. **方法偏离不可检测**：worker 可能偏离 PLAN.md 设计的方法（如本应使用 SymPy 维度分析但实际用了 LLM 推理），verification 只看结果不看过程，无法检测
2. **跳步不可检测**：worker 可能跳过 PLAN.md 中的中间步骤（如 PLAN 要求"先做极限推导再做维度分析"，但 worker 直接做维度分析跳过了极限推导）
3. **未声明假设不可检测**：worker 可能在执行过程中引入了 PLAN.md 未声明的假设（如"假设小参数展开收敛"但 PLAN.md 未标注此假设）
4. **前置依赖不可追溯**：Q2 使用 Q1 的结论作为输入，但 Q2 的 EXECUTION.md 不记录"为什么用 Q1 结论、用了 Q1 的哪个部分、Q1 结论是否支持这个用法"

Qn_REASONING.md 解决这些问题——它记录从 PLAN.md 方法到具体求解的完整推导链条，让 verification 可以验证：

- 推导是否忠于 PLAN.md 的方法设计
- 推导步骤是否完整（无跳步）
- 执行过程中是否引入了未声明假设
- 对前置依赖的使用是否正确（Q1 结论是否真的支持 Q2 对它的用法）

### 为什么 verification 需要同时验证推理和结论

传统科研验证只验证结论（"结果是否正确"）。但 LLM agent 的执行过程有独特风险：agent 可能在执行中偏离计划的方法、跳过步骤、引入隐性假设。如果只验证结论，这些偏离不会被检测——即使结论碰巧正确，推导过程不可靠意味着结论不可复现、不可信赖。

推理验证和结论验证的关系类似于 framing 层的 reasoning chain audit 和 debate：

|              | 结论验证                                                 | 推理验证                            |
| ------------ | -------------------------------------------------------- | ----------------------------------- |
| **验证对象** | Qn_VERIFICATION.md 中的 claims + falsification criterion | Qn_REASONING.md 中的推导步骤        |
| **验证方式** | 确定性计算脚本（SymPy 等）                               | 推导步骤与 PLAN.md 方法设计对比     |
| **失败类型** | "结论不正确"                                             | "推导过程偏离了 PLAN.md 设计"       |
| **互补性**   | 结论正确但推导偏离 → 结论不可信赖（可能靠巧合）          | 推导忠实但结论错误 → 方法本身有问题 |

### Per-question resolution 采用二元判定

Per-question resolution 采用二元判定（resolved/failed）而非 per-claim 细粒度判定。理由：

1. **复杂度控制**：per-claim tracking 需要在 state.json 中记录每个 claim 的独立状态，并在失败传播时判断"依赖 Q1 的 claim A 但 Q1 只有 claim B verified"的复杂场景，大幅增加 state.json 和传播逻辑复杂度
2. **系统性风险**：LLM agent 执行中部分 claim 失败通常意味着方法层面的系统性问题（方法不匹配、假设不成立），不宜仅使用 passed claims 作为可靠输入——即使个别 claim 通过，整个执行过程的可靠性存疑
3. **降级路径已存在**：fallback 机制已为受影响 question 提供降级路径，无需通过 per-claim 细粒度来"抢救"部分结论

如果未来需要 per-claim resolution，可在 resolved_conclusions 中增加 per-claim status 子字段，但当前设计暂不引入此复杂度。

### Verifier 统一架构：autoresearch 内部直接派遣 verification subagent

当前 research.md 的 verification dispatch 做 3-way 路由（gpd-only / research-only / both），physics 场景需顺序派遣两个独立 worker 写同一 VERIFICATION.md，存在协调冲突。每新增一个领域都要同时改 coordinator 路由逻辑和新增 verifier skill。

统一方案：autoresearch 内部直接派遣 verification subagent，根据 domain_mode 决定派遣哪个 subagent（不再通过 research-worker 中转，也不再通过 general subagent 调用 gpd plugin）。coordinator 完全不参与 verification routing——autoresearch 从 framing digest 的 `verification_approach` 判断 domain_mode，直接派遣对应 subagent：

| framing digest verification_approach | domain_mode | autoresearch 派遣                                             |
| ------------------------------------ | ----------- | ------------------------------------------------------------- |
| physics                              | `physics`   | 先派遣 gpd-verifier → 后派遣 research-verifier → 内部合并结果 |
| general / 其他                       | `general`   | 派遣 research-verifier → research-verification skill          |
| [future: math]                       | `math`      | 派遣 math-verifier → math-specific + general verification     |
| [future: chemistry]                  | `chemistry` | 派遣 chemistry-verifier → chemistry-specific + general        |

**coordinator 路由简化**：从 "选择 gpd-verifier / research-verifier / both" 变为 "不参与 verification routing——只做一次 dispatch autoresearch"，autoresearch 内部完全管理 verification subagent 派遣。domain_mode 的判定规则见 §domain_mode 确定规则。

### Verification 派遣架构：autoresearch 内部管理（方案 D）

当前 phase_execution 的 verification 经过三层嵌套：coordinator → research-worker → autoresearch → verifier。autoresearch 在 verification sub_phase 中只是 routing wrapper（不做任何验证计算），Layer 3.12 的 per-question 模式下 autoresearch 的 verification sub_phase 完全移除（输入文件、输出文件、digest 格式、verifier 路由全部变更）。

Layer 3.12 采用方案 D：将 per-question 推进的完整循环（Wave 排序 → question 串行 → execution → verification → decision → 失败传播 → retry → early abort）交给 autoresearch worker 内部管理。Coordinator 只做一次 dispatch，autoresearch worker 内部驱动所有 question 的串行推进，包括 verification 的派遣。autoresearch 直接派遣 research-verifier subagent（general mode）或 gpd-verifier + research-verifier subagent（physics mode）执行 verification，不再通过 research-worker 中转。

```
coordinator ──→ research-worker (autoresearch) ──→ 内部管理 per-question 推进循环
                                                  │
                                                  ├─→ execution sub-loop (per question)
                                                  │    autoresearch → local-executor → Qn_EXECUTION.md + Qn_REASONING.md
                                                  │
├─→ verification sub-loop (per question)
                                                   │    autoresearch → research-verifier → research-verification skill → Qn_VERIFICATION.md
                                                   │    (physics mode: autoresearch → gpd-verifier → gpd-verification/gpd-domain-check/gpd-conventions → general verification → Qn_VERIFICATION.md)
                                                  │
                                                  ├─→ decision (per question)
                                                  │    autoresearch 读 verification_digest → resolved / failed / retry / blocked
                                                  │
                                                  ├─→ failure propagation (per question)
                                                  │    autoresearch 读 framing_reasoning.md → mark blocked / use fallback
                                                  │
                                                  ├─→ user decision (when needed)
                                                  │    autoresearch 输出 paused digest → coordinator asks user → re-dispatch
                                                  │
└─→ all questions processed → autoresearch writes persistence/EXECUTION.md + VERIFICATION.md
                                                        → outputs final digest → coordinator calls advance_plan(phase=completed)
```

**与当前架构及方案 C 的差异**：

| 维度             | 当前（autoresearch 中转）                              | 方案 C（coordinator 直接）                        | 方案 D（autoresearch 内部管理）                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 派遣层数         | 3 层（coordinator → worker → autoresearch → verifier） | 2 层（coordinator → worker → verification skill） | 执行 3 层（coordinator → autoresearch → local-executor）；验证 3 层（coordinator → autoresearch → research-verifier → research-verification skill）；physics 验证 3 层（coordinator → autoresearch → gpd-verifier → gpd plugin skills） |
| decision 权责    | autoresearch 代理部分                                  | coordinator 独占                                  | autoresearch 独占（用户决策除外——需要用户决策时输出 paused digest，由 coordinator 代理）                                                                                                                                                |
| coordinator 交互 | 每个 question 2 次 dispatch                            | 每个 question 2 次 dispatch                       | 1 次 dispatch（全部 question 推进在 autoresearch 内部完成），用户决策时额外 1 次 re-dispatch                                                                                                                                            |
| digest 格式      | autoresearch 合并 execution + verification             | 两个独立 digest（execution + verification）       | autoresearch 内部管理所有 question 的 execution + verification digest；最终输出 1 个 summary digest                                                                                                                                     |
| session recovery | 不需要额外标识                                         | 需要 current_step 标识                            | autoresearch 内部读取 state.json.execution 恢复中断点（current_wave + current_question + current_cycle + current_step）                                                                                                                 |

**方案 D 的理由**：

1. **coordinator 上下文减压**：per-question 推进是一个紧密耦合的内部循环（question 状态 → 下一个 question → 检查依赖 → fallback → retry），放在 autoresearch worker 内部更自然——coordinator 的职责是跨 phase 的宏观路由（analysis → audit → framing → debate → execution），不应管理 execution 内部的 question 推进细节。4 question × 2 dispatch × 3 retry = 最多 24 次 coordinator 交互，改为 autoresearch 内部管理后 coordinator 只需 1 次 dispatch + 1 次 final digest 解析
2. **推进逻辑局部性**：per-question 推进是同一类操作的串行重复（Q1 execution → Q1 verification → Q1 decision → Q2 execution → ...），天然适合内化到一个 worker，与 debate loop 的每步都是独立 skill 派遣（advocacy/critique/adjudication/repair）不同
3. **autoresearch 复杂度降低**：autoresearch 不再混合 verification 职责，但新增 per-question 推进管理职责——两种职责的复杂度相当，但推进管理更自然地属于 autoresearch（它已经管理 execution cycle 的状态）

**方案 D 的代价**：

1. **用户决策中断**：autoresearch worker 无法直接使用 question tool。需要用户决策时（fallback 失败 + critical dependency 失败 + max retries 耗尽），worker 输出 `status: paused` digest（含暂停原因和受影响 question 列表），coordinator 解析后询问用户，用户回答后 coordinator 重新 dispatch autoresearch worker（prompt 注入用户决策）。增加 1-2 个交互回合，但只在少数场景发生
2. **autoresearch 上下文膨胀**：autoresearch 需要管理 per-question 推进的完整循环逻辑（Wave 排序、question 串行、失败传播、retry、ENVIRONMENT.md 增量更新），SKILL.md 可能从 297 行膨胀到 500+ 行
3. **session recovery 复杂度转移**：session recovery 从 coordinator 转移到 autoresearch（autoresearch 读取 state.json.execution 判断中断点，内部恢复），但总量不变
4. **verification 派遣架构调整**：autoresearch 内部直接派遣 verification subagent（不再通过 research-worker 中转）。general mode：coordinator → autoresearch → research-verifier → research-verification skill（3 层）；physics mode：coordinator → autoresearch → gpd-verifier → gpd-verification/gpd-domain-check/gpd-conventions + research-verification skill（3 层）。local-executor 和 gpd-verifier 均是 delegation_depth=0 的叶子节点（`delegation_depth` 是 task() 工具的运行时参数，调用者通过 `task(delegation_depth: 0)` 传入，Discipline.compile 在运行时将其编译为 `{permission: "task", pattern: "*", action: "deny"}` 规则，禁止 subagent 再次使用 task 工具；同时也是 agent 定义层面属性 Agent.Info.delegationDepth，两处均可生效），不可再嵌套。delegation_depth 参数值域为 0-3（定义见 `packages/opencode/src/session/discipline.ts` Discipline.Schema 和 `packages/opencode/src/tool/task.ts`），行为是阈值式：0 → deny task（叶子节点），1/2/3 → allow task（非叶子节点）。非零值之间无行为差异，不用于嵌套计数

**用户决策通道**（方案 D 的配套机制）：

当 autoresearch worker 需要用户决策时，输出特殊 digest：

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted]"
  pause_details:
    failed_question: "[Qn]"
    failure_summary: "[...]"
    affected_questions: ["[Qd list]"]
    fallback_attempted: true|false
    user_options:
      - "Skip all dependent questions, accept partial results"
      - "Provide alternative assumption for [Qd] (you specify)"
      - "Abort execution"
  execution_progress:
    resolved_questions: ["[list of already resolved questions]"]
    failed_questions: ["[list]"]
    blocked_questions: ["[list]"]
    current_wave: [N]
    current_question: "[Qn where pause occurred]"
```

Coordinator 收到 paused digest 后：

1. 使用 question tool 向用户呈现暂停原因和选项
2. 用户做出决策后，coordinator 重新 dispatch autoresearch worker
3. Re-dispatch prompt 注入用户决策（如"用户选择 skip all dependent questions"或"用户提供替代假设: [具体内容]"）
4. autoresearch worker 从暂停点继续推进

### Early abort：全 Wave 失败时终止项目

如果某个 Wave 内所有 question 都失败（且无 fallback 可继续），且所有后续 Wave 的 question 也全部 blocked，Coordinator 应立即终止项目执行并向用户报告，而非继续推进后续 Wave。

终止条件：当前 Wave 完成后，state.json.execution.question_status 中所有**未完成** question 的状态均为 failed 或 blocked（无仍可执行的 pending question）。已有 resolved question 的结果仍然输出到 persistence 汇总文件。只要后续无可执行 question，就触发 early abort 输出已有结果——而非继续空转。

### autoresearch Skill 适配（per-question 推进管理）

当前 autoresearch SKILL.md 按"一次性解决所有 question"设计（Step 1-10 均假设所有 question 在同一 cycle 内执行）。Layer 3.12 采用方案 D，autoresearch 从"单 question 执行工具"变为"per-question 推进管理器"（理由见 §方案 D 的理由）。

**核心变更**：autoresearch 从"全量执行"变为"per-question 推进管理器"（理由见 §方案 D 的理由）。Coordinator 只做一次 dispatch，autoresearch 在内部管理完整推进循环。autoresearch 不再被 coordinator 逐 question 逐 cycle 派遣——它自行读取 PLAN.md Execution Order，自行确定 Wave 排序和 question 推进顺序，自行管理每个 question 的 execution → verification → decision 循环（domain_mode 由 coordinator 注入经 research-worker 传递，见 §domain_mode 确定规则）。

**新版 Procedure（per-question 推进管理）**：

autoresearch 内部包含两层循环：外层循环（Wave → question 排序 → question 串行推进），内层循环（单 question 的 execution → verification → decision → retry）。5 步大纲在实施阶段已展开为详细子步骤（每个 Step 的输入、操作、输出、异常处理）。

**SKILL.md 分解架构**（见 §autoresearch SKILL.md 分解）：autoresearch skill 目录采用核心+reference 分解结构。SKILL.md（~213 行）包含核心流程骨架和每步骤的意图声明，reference 文件包含完整模板、schema、判定表和操作细节。autoresearch 在具体步骤时用 Read 工具查阅对应 reference——不一次性加载全部信息到 context。

| Step | 名称                           | 说明                                                                                                                                                                                                             | 对应伪代码位置                                 |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Read Plan & Determine Waves    | 读取 PLAN.md Execution Order + §Claims tractability → 确定 Wave 列表和 question 排序                                                                                                                             | §autoresearch 内部推进逻辑 Step 1              |
| 2    | Read Execution State           | 读取 state.json.execution → 恢复中断点                                                                                                                                                                           | §autoresearch 内部推进逻辑 Step 2              |
| 3    | Environment Probe              | Bash 探测主机环境 → 分类隔离策略 → 写入 ENVIRONMENT.md（在第一个 local-executor dispatch 之前执行）                                                                                                              | §autoresearch 内部推进逻辑 Step 3              |
| 4    | Per-Question Loop              | 逐 question 串行推进：execution → verification → decision → 失败传播 → retry（子步骤 a-l 见 §autoresearch 内部推进逻辑 Step 4 详尽子步骤）；每个 question decision 后检查 early abort（子步骤 j 内化在 Loop 中） | §autoresearch 内部推进逻辑 Step 4 (子步骤 a-l) |
| 5    | Final Digest + Write Summaries | 写入 persistence 汇总 + 输出 final digest                                                                                                                                                                        | §autoresearch 内部推进逻辑 Step 5              |

**新增产出**：Qn_REASONING.md（step-by-step derivation + dependency usage），写入 `notepads/[slug]/execution/Qn_REASONING.md`。

**产出变更**：autoresearch 不再在每个 cycle 追加写入 `persistence/EXECUTION.md` 和 `persistence/VERIFICATION.md`，改为在执行结束时一次性写入汇总（旧路径废止规则见 §输出文件结构）。

**Verification sub_phase 完全移除**：autoresearch 不再包含原有的 verification sub_phase（旧版 autoresearch SKILL.md §Procedure — Verification 整节删除）。Verification 在 autoresearch 的 per-question 推进循环内部通过 dispatch verification subagent 执行（见 §Verification 派遣架构：方案 D）。

**autoresearch 对 verification 的内部派遣**：autoresearch 在 per-question 循环内，对每个 question 的 verification 步骤通过 task tool 直接派遣对应 subagent：

- general mode：`task(subagent_type: "research-verifier", delegation_depth: 0)` → research-verifier 内部调用 research-verification skill（domain_mode=general）
- physics mode：`task(subagent_type: "gpd-verifier", delegation_depth: 0)` → gpd-verifier 内部调用 gpd-verification/gpd-domain-check/gpd-conventions + research-verification skill（domain_mode=physics）
  domain_mode 由 autoresearch 从 framing digest 的 verification_approach 判断并注入 dispatch prompt。local-executor 和 gpd-verifier 均是 delegation_depth=0 的叶子节点（`delegation_depth` 是 task() 工具的运行时参数——调用者通过 `task(delegation_depth: 0)` 将其传入，Discipline.compile 在运行时将其编译为 `{permission: "task", pattern: "*", action: "deny"}` 规则，禁止该 subagent 再次使用 task 工具。`delegation_depth` 同时也是 agent 定义层面的属性（Agent.Info.delegationDepth），两处均可生效——agent 定义预设默认值，task() 参数允许调用者按需覆盖。值域为 0-3（见 `packages/opencode/src/session/discipline.ts` Discipline.Schema 和 `packages/opencode/src/tool/task.ts`），行为是阈值式：0 → deny task（叶子节点），1/2/3 → allow task（非叶子节点）。非零值之间无行为差异，不用于嵌套计数），不可再嵌套。

### autoresearch SKILL.md 分解架构

autoresearch skill 目录从单文件 SKILL.md（787 行）重构为核心流程文件 + 3 个 reference 文件的自包含分解结构。分解原则：

1. **自包含**：所有 reference 文件在 `.aether/skills/autoresearch/references/` 目录下，autoresearch 不依赖外部设计文档
2. **按需加载**：核心 SKILL.md（~213 行）在 skill invocation 时加载；reference 文件仅在具体步骤时通过 Read 工具按需查阅，不一次性加载全部信息到 LLM context
3. **无信息丢失**：所有 787 行的信息完整分布在 4 个文件中

**文件结构**：

| 文件                           | 行数 | 内容                                                                                                                                                                                                                                                                                                                 | 加载时机                    |
| ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `SKILL.md`                     | ~213 | 核心流程骨架：Lifecycle Contract + Terminology + Procedure Step 1-5（每步骤声明意图，引用 reference 获取具体模板/schema/规则）                                                                                                                                                                                       | skill invocation 时始终加载 |
| `references/digest-schemas.md` | ~203 | execution_cycle_digest YAML + verification_digest YAML + final_execution_digest YAML + paused digest YAML + DIGESTS.md 写入规则 + Digest 输出格式约束 + persistence 汇总格式模板（EXECUTION.md + VERIFICATION.md）+ Retry Logic                                                                                      | Step 5 输出时               |
| `references/worker-prompts.md` | ~302 | local-executor prompt 模板 + verification general prompt 模板 + gpd-verifier prompt 模板 + physics mode verification 合并规则 + Qn_REASONING.md 结构模板 + Qn_EXECUTION.md 结构模板 + ENVIRONMENT.md YAML 结构 + isolation strategy classification 表 + environment probe commands                                   | Step 4d/g 派遣 subagent 时  |
| `references/edge-cases.md`     | ~178 | Execution-level Failure Decision 表 + Verification Decision 判定规则表 + verification digest 解析失败 3 场景 + verification_retries 独立计数规则 + state.json 完整 schema + 初始化/更新 jq 命令 + state.json 写入失败恢复 + Session Recovery（autoresearch 层）+ subagent dispatch constraints + backup before retry | 异常场景/初始化/恢复时      |

**从 SKILL.md 移出的内容分类**：

| 内容类型                                             | 移出理由                                              |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Digest YAML schemas（4 个完整 schema ~70 行）        | 仅在 Step 5 输出时需要，不需要在 Step 1 就加载        |
| Worker prompt 模板（3 个完整模板 ~130 行）           | 仅在 Step 4d/g 派遣 subagent 时需要                   |
| Qn_REASONING.md + Qn_EXECUTION.md 结构模板（~50 行） | 给 local-executor 的产出格式要求，Step 4d 派遣时查阅  |
| ENVIRONMENT.md YAML 模板 + isolation 表（~40 行）    | Step 3 写入时查阅                                     |
| Persistence 汇总格式模板（~52 行）                   | Step 5 写入时查阅                                     |
| Verification Decision 判定规则表（~12 行）           | Step 4h 判定时查阅                                    |
| Execution-level Failure Decision 表（~9 行）         | Step 4e 判定时查阅                                    |
| Session Recovery（~15 行）                           | 仅 crash 后 re-dispatch 时需要                        |
| verification digest 解析失败处理（~6 行 + 3 场景）   | 仅 subagent 输出异常时需要                            |
| verification_retries 规则（~10 行）                  | 仅 verification retry 时需要                          |
| state.json 初始化/更新 jq 命令（~35 行）             | 实现细节，核心流程只需声明意图                        |
| Paused digest schema（~23 行）                       | 仅在 fallback_inapplicable/critical_dep_failed 时需要 |
| Physics mode verification 合并规则（~15 行）         | 仅 physics mode + 双 verifier 返回时需要              |
| Bash 环境探测命令（~17 行）                          | 实现细节，核心流程只需声明探测哪些工具                |

**SKILL.md 核心保留的内容**：Lifecycle Contract（~20行）+ Terminology（~8行）+ Procedure Step 1-5 每步骤的意图声明和决策要点（~120行）+ Integrity（~5行）。每步骤声明"做什么"而非"如何做"，具体实现细节通过引用 reference 文件获取。

**分解的收益**：

- **LLM context 按需加载**：峰值 working context 从 787 行降至 ~213 行（减少 73% 峰值 context 占用），总信息量不变
- **认知可读性**：核心流程一口气读完，模板/schema 按需查阅
- **维护局部性**：修改 worker prompt 不需要重读整个 SKILL.md

### research-verification domain_mode 内部流程

research-verification skill 新增 `domain_mode` 参数（从 autoresearch dispatch prompt 传入）。不同 domain_mode 决定内部验证流程：

**domain_mode=general**：执行当前 research-verification SKILL.md 的标准 8 步 Procedure（Establish Contract Targets → Classify Check Types → Execute Available Verification → Interpret Results → Verify Conventions/Norms → Reasoning Verification → Write Qn_VERIFICATION.md → Output verification_digest），但 Step 1 新增 per-question claim 筛选——只筛选 PLAN.md Claims 中 `question=Qn` 的 claims，不验证其他 question 的 claims。

**domain_mode=physics**：autoresearch 不再通过 research-verification 内部调用 gpd plugin skills——而是**分别派遣 gpd-verifier 和 research-verifier 两个独立 subagent**，两者各自产出独立结果，autoresearch 在内部合并。gpd-verifier 的 dispatch prompt 注入"只验证 Qn 的 claims"约束（与 research-verifier 的 per-question claim 筛选一致）。合并规则（见 §physics mode verification 合并规则）：单一 fail 即判定为 fail，全部 pass 才判定为 pass；gpd-verifier 崩溃按 verification 未完成处理（见 §Verification digest 解析失败处理）。autoresearch 在两个 subagent 都完成后，将结果合并写入最终的 Qn_VERIFICATION.md（或由 research-verifier 在 Step 9 写入，autoresearch 后续读取）。

> **为什么改为分别派遣而非 research-verification 内部调用**：gpd-verifier 是独立定义的 subagent（`.aether/agent/gpd-verifier.md`），拥有完整的 gpd skill 调用链和 convention 管理。将其降级为 research-verification 的内部 plugin（通过 general subagent 中转）增加了无意义的嵌套层数，且 general subagent 缺乏 gpd-verifier 的专业上下文（convention lock 管理、domain-specific checklist 结构等）。分别派遣让每个 subagent 在自己的专业上下文中执行，autoresearch 作为管理器合并结果——职责更清晰，嵌套更扁平。

**domain_mode=physics 的 dispatch 流程**：

autoresearch 在 per-question 循环内的 verification 步骤：

1. 派遣 gpd-verifier subagent：

```
task(
  description: "gpd verification Qn cycle [C]",
  subagent_type: "gpd-verifier",
  delegation_depth: 0,
  prompt: "Execute gpd-verification for question [Qn] of phase_execution (cycle [C]).
Invoke /gpd-verification skill + /gpd-domain-check skill + /gpd-conventions skill.

Claims to verify: [list Qn's claims from PLAN.md — those with question=Qn ONLY].
Do NOT verify claims from other questions.

Read Qn_REASONING.md and Qn_EXECUTION.md for execution context.
Read PLAN.md Contract section for Qn's claims ONLY.

Procedure:
1. Convention check (gpd-conventions MCP)
2. Computational verification (gpd-verification SymPy scripts)
3. Domain-specific structural check (gpd-domain-check)
4. Write results — autoresearch will merge with general verification results

Output gpd verification digest as your final message."
)
```

2. 派遣 research-verifier subagent：

```
task(
  description: "general verification Qn cycle [C]",
  subagent_type: "research-verifier",
  delegation_depth: 0,
  prompt: [按 §Worker Prompt 模板 — Verification worker 构造，填入 Qn、cycle C、domain_mode=general、claims 列表]
)
```

3. 读取两个 subagent 的 task_result，合并结果：
   - gpd-verifier 的 domain-specific results + research-verifier 的 general results → 合并为 Qn_VERIFICATION.md 的最终内容
   - 合并规则见 §physics mode verification 合并规则

#### physics mode verification 合并规则（权威定义）

合并原则：**全部 pass 才判定为 pass，有一处 fail 即判定为 fail**。

| gpd-verifier 结果 | research-verifier 结果 | 合并判定     | 写入 Qn_VERIFICATION.md 的内容                                                                                                                               |
| ----------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 全部 PASS         | 全部 PASS              | PASS         | 两部分结果均写入 Reasoning Verification + Conclusion Verification                                                                                            |
| 有 FAIL           | 全部 PASS              | FAIL         | gpd FAIL 部分 + research PASS 部分均写入，FAIL 部分标记为 verification failed                                                                                |
| 全部 PASS         | 有 FAIL                | FAIL         | gpd PASS 部分 + research FAIL 部分均写入，FAIL 部分标记为 verification failed                                                                                |
| 有 FAIL           | 有 FAIL                | FAIL         | 两部分 FAIL 均写入                                                                                                                                           |
| 崩溃/无结果       | 任何结果               | 按未完成处理 | gpd-verifier 崩溃 → verification_retries < 3 → 重新 dispatch gpd-verifier（见 §Verification digest 解析失败处理）；verification_retries ≥ 3 → mark Qn failed |
| 任何结果          | 崩溃/无结果            | 按未完成处理 | research-verifier 崩溃 → 同上处理逻辑                                                                                                                        |

gpd-verifier 和 research-verifier 的结果独立写入 Qn_VERIFICATION.md 的对应 section，不做覆盖——即使 gpd FAIL 但 research PASS，research PASS 结果仍然保留供审查，但最终判定为 FAIL。

**[future: math / chemistry]**：当新增领域时，autoresearch 新增对应的 verifier subagent 派遣（如 math-verifier），不需修改 research-verification skill 内部流程——只需在 autoresearch 的 domain_mode 映射表中新增一行。

---

## 状态机变更

### 旧 phase_execution（一次性，coordinator 逐 cycle 管理）

```
phase_execution:
  Coordinator 循环管理 execution cycle + verification:
    Cycle 1:
      coordinator → research-worker (execution_cycle, cycle=1)
      → autoresearch → local-executor(s) → EXECUTION.md (追加)
      → autoresearch → verification sub_phase
        → coordinator 指定 verifier: gpd-verifier / research-verifier / both (3-way routing)
        → verifier 写入 VERIFICATION.md (追加)
      → coordinator 判断 verification digest:
        all verified → completed
        some failed + cycle < 3 → retry
    Cycle 2:
      coordinator → research-worker (execution_cycle, cycle=2)
      → autoresearch → local-executor(s) → EXECUTION.md (追加)
      → verification (same 3-way routing)
    Cycle 3:
      same structure → completed or partial
```

### 新 phase_execution（autoresearch 内部管理 per-question 推进）

```
phase_execution:
  │
  ├─ Coordinator dispatches autoresearch worker (一次派遣)
  │    │
  │    ▼ autoresearch 内部管理 per-question 推进循环：
  │
  ├─ Read PLAN.md Execution Order → determine question list per Wave
  │  Sort questions within each Wave by tractability confidence (见 §Wave 内 question 执行顺序)
  │  autoresearch bash probe → update ENVIRONMENT.md if needed
  │
  ├─ Wave 1 questions: [Q1, Q3] (no dependencies, sorted by tractability)
  │    │
  │    ├─ Question Q1 (highest tractability in Wave):
  │    │    autoresearch dispatches local-executor → Q1_REASONING.md + Q1_EXECUTION.md
  │    │    autoresearch dispatches verification subagent(s):
  │    │      - general mode: research-verifier → research-verification skill → Q1_VERIFICATION.md
  │    │      - physics mode: gpd-verifier → gpd skills, then research-verifier → general verification
  │    │      → autoresearch internally merges results → Q1_VERIFICATION.md
  │    │    │
  │    │    ├─ Q1 fully verified (见 §Verification Decision 判定规则) → mark Q1 resolved
  │    │    │    └─ Q1 conclusion_summary available for dependent questions
  │    │    │
  │    │    ├─ Q1 failed (execution retryable, cycle < 3) → backup → retry execution + verification
  │    │    ├─ Q1 verification digest 解析失败 → verification retry (见 §Verification digest 解析失败处理)
  │    │    │
  │    │    └─ Q1 failed (max retries) → failure propagation:
  │    │        ├─ critical dep → mark dependents blocked
  │    │        ├─ non-critical + fallback → use fallback, continue dependents (见 §Fallback 失败的分类与处理)
  │    │        └─ no fallback → output paused digest → coordinator asks user → re-dispatch
  │    │
  │    ├─ Question Q3: (independent, proceed regardless of Q1 outcome)
  │    │    [same structure: execution → verification → decision → early abort check]
  │    │
  │    ├─ Early abort check (after each question decision):
  │    │    all remaining question_status ∈ {failed, blocked} with no pending → terminate
  │    │
  ├─ Wave 2 questions: [Q2] (depends on Q1)
  │    │
  │    ├─ Q1 resolved → Q2 proceeds with Q1's conclusion_summary as input context
  │    │
  │    ├─ Q1 failed + Q2 has fallback → Q2 proceeds with fallback assumption
  │    │
  │    ├─ Q1 failed + Q2 critical → Q2 blocked, skip
  │    │
  │    └─ Q1 failed + no fallback → paused digest → coordinator asks user
  │
  ├─ Wave 3 questions: [Q4] (depends on Q2)
  │    [same structure]
  │
├─ All questions processed → autoresearch writes persistence/EXECUTION.md + persistence/VERIFICATION.md
│    │    → outputs final_execution_digest → coordinator reads digest → advance_plan(phase=completed) → present results
│
└─ Some questions blocked/unresolved (execution cannot continue) → autoresearch writes partial persistence/EXECUTION.md + persistence/VERIFICATION.md
   → outputs final_execution_digest → coordinator reads digest → advance_plan(phase=completed) → present partial results + unresolved list
```

### state.json 新增字段

```json
{
  "execution": {
    "current_wave": 1,
    "current_question": "Q1",
    "current_cycle": 1,
    "current_step": "execution",
    "verification_retries": {
      "Q1": 0
    },
    "question_status": {
      "Q1": "pending",
      "Q2": "pending",
      "Q3": "pending",
      "Q4": "pending"
    },
    "resolved_conclusions": {
      // ONLY fully verified questions (ALL claims verified + ALL reasoning checks PASS) are included.
      // Questions with partial verification (some claims failed, some reasoning checks FAIL)
      // are NOT included — they remain in question_status as "failed", and their partial results
      // are not available as dependency inputs for downstream questions.
      // Workers read full conclusions from Qn_VERIFICATION.md directly.
      // Authority source: see §conclusion_summary 生命周期
      "Q1": {
        "conclusion_summary": "... (from verification_digest, worker-generated)",
        "output_paths": {
          "reasoning": "execution/Q1_REASONING.md",
          "execution": "execution/Q1_EXECUTION.md",
          "verification": "execution/Q1_VERIFICATION.md"
        }
      }
    }
  }
}
```

**conclusion_summary 来源**：由 verification worker 在 digest 中返回（worker 是验证的作者，提取最可靠），autoresearch worker 从 verification worker 的 task_result 中提取 `conclusion_summary`，直接写入 `state.json.resolved_conclusions[Qn]`（agent 直接写入，见 §state.json 更新方式）。不由 coordinator 从 VERIFICATION.md 提取（避免额外 LLM 解释步骤和上下文开销）。

**失败历史保留**：`question_status` 保留终态（`failed` / `blocked`），而非清空。当用户选择 rollback 到更早 phase（如 re-framing）时，`execution` 子对象整体清空（问题 ID 可能变化），与 `audit` 子对象无交互——`audit` 子对象属于 `phase_audit` 时期，`execution` 子对象属于 `phase_execution` 时期，两者互不影响。session recovery 时保留失败历史有益——恢复时可以跳过已 failed/blocked 的 question。failed/blocked question 列表从 `question_status` 动态筛选（`question_status[Qn] == "failed"` 或 `question_status[Qn] == "blocked"`），不再维护独立的 `failed_questions` / `blocked_questions` 数组——避免三字段同步维护的不一致风险。

**resolved_conclusions 权威性**：见 §conclusion_summary 生命周期（权威定义）。`resolved_conclusions` 是依赖可用性信息的唯一权威源，conclusion_summary 的双重用途（依赖可用性判断 + persistence 汇总聚合）及权威源规则均在此小节统一定义。

#### state.json 更新方式（混合方案）

state.json 的更新采用混合方案——根据更新频率和原子性需求选择不同的更新机制：

| 更新级别         | 更新内容                                                                                                                 | 更新方式           | 理由                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------- |
| phase 转换级     | phase, plan_number, phase_commits, progress                                                                              | MCP (advance_plan) | 低频（每 phase 1 次）、需要原子性（4 字段同时更新）、需要跨 phase 协调                                  |
| execution 内部级 | current_wave, current_question, current_cycle, current_step, verification_retries, question_status, resolved_conclusions | agent 直接写入     | 高频（每 question 完成更新 1 次）、需要灵活更新（字段组合随推进状态变化）、autoresearch worker 内部管理 |

**agent 直接写入 state.json 的安全约束**：

1. **只修改 execution 子对象**：agent 使用 `jq` 命令或 edit 工具修改 state.json 时，只修改 `execution` 子对象的字段，不触碰其他字段（phase, plan_number, audit, conventions, progress, phase_commits 等）。`jq` 命令示例：`jq '.execution.current_wave = 2 | .execution.current_question = "Q2" | .execution.question_status.Q1 = "resolved"' state.json`
2. **current_step 值域**：`current_step` 仅用于 session recovery 标识中断点，值域为 `{execution, verification}`——对应 autoresearch 内部推进循环中需要派遣 subagent 的两个阶段。其他步骤（Prepare execution context、decision、failure propagation、backup_retry）不需要中断恢复（这些步骤由 autoresearch 亲自执行，无 subagent 派遣，中断后可直接重新执行），因此不在 current_step 值域中
3. **写入时机**：agent 在每个 question 的 decision 步骤后写入（verified → 更新 resolved_conclusions；failed → 更新 question_status 为 failed；blocked → 更新 question_status 为 blocked）。不在 execution worker dispatch 前写入（dispatch 前只更新 current_step）
4. **与 MCP 的协调**：phase 转换（advance_plan）仍通过 MCP 执行——agent 不直接修改 phase 和 plan_number 字段。execution 内部推进完成后，coordinator 调用 advance_plan(phase=completed) 完成最后的 phase 转换
5. **写入失败恢复**：如果 jq 写入失败（文件锁定、权限问题等）→ autoresearch 输出 paused digest（status=paused, pause_reason=state_update_failed, pause_details 含写入失败的具体错误信息），coordinator 重新 dispatch autoresearch worker。如果 jq 不可用（`jq --version` 返回非零），autoresearch 使用 Python json 模块替代（`python3 -c "import json; d=json.load(open('state.json')); d['execution']['current_wave']=2; json.dump(d, open('state.json','w'))"`），或使用 edit 工具直接修改 state.json 中 execution 子对象的字段

**为什么不用 MCP update_execution_state**：

1. 高频更新（4 question × 3 cycle = 最多 24 次）的 MCP tool 开发成本不划算——需要设计接受 6+ 字段的 tool schema，server.py 增加约 200-300 行
2. MCP 启动依赖增加风险——如果 MCP server 不可用（uv 缺失），execution 内部推进会卡住。agent 直接写入只需 bash `jq` 命令，不依赖 MCP
3. autoresearch worker 内部管理推进逻辑时，直接写入 state.json 更自然——worker 可以在同一个上下文中完成"做 decision + 更新 state.json + 继续下一个 question"，不需要额外的 tool call 间接层

#### Digest Schema（权威定义）

**DIGESTS.md 写入规则**：per-question 的 execution_cycle_digest 和 verification_digest 作为 task_result 返回给 autoresearch worker，供其内部管理推进逻辑使用——**不写入 DIGESTS.md**。autoresearch 在所有 question 处理完毕后输出 1 条 final_execution_digest 写入 DIGESTS.md（与 debate phase "每轮仅 repair 写 1 条 DIGESTS.md"的模式一致）。如果 autoresearch 输出 paused digest（需用户决策），paused digest 也写入 DIGESTS.md（1 条）。

execution_cycle_digest 和 verification_digest 的权威 schema 定义如下。后续所有对 digest 字段的引用均指向本小节，不在其他位置重复定义。

**execution_cycle_digest 权威 schema（替代旧 autoresearch SKILL.md 行 230-249 的 schema）**：

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: execution_cycle
  cycle: [N]
  question: "[Qn]"
  status: completed | partial | failed
  tests_passed: ["[test 1]"]
  tests_failed: ["[test N]"]
  revision_needed: null | "[what to revise]"
  output_paths:
    reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
    execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
  next_phase: null
```

**字段变更对照**（与旧 autoresearch SKILL.md 行 230-249 的逐字段对比）：

| 字段                        | 旧 schema 状态 | 新 schema 状态 | 变更说明                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`                     | 保留           | 保留           | 不变                                                                                                                                                                                                                                                                                                                  |
| `sub_phase`                 | 保留           | 保留           | 不变                                                                                                                                                                                                                                                                                                                  |
| `cycle`                     | 保留           | 保留           | 不变（旧 schema 曾有 `attempt` 字段名，已统一为 `cycle`）                                                                                                                                                                                                                                                             |
| `question`                  | 无             | **新增**       | per-question 模式必须标识当前 question                                                                                                                                                                                                                                                                                |
| `status`                    | 4 值           | 3 值           | 语义重定义：`completed` = 产出文件且 tests_passed；`partial` = 产出文件但 tests_failed（进入 verification）；`failed` = worker 崩溃/未产出。**`inconclusive` 已删除**——gaps prevented test 属于 verification 层面，execution 只有"产出"或"未产出"二元判定（见 §Execution-level Failure Decision status 语义重定义表） |
| `tests_passed`              | 全局 scope     | per-Qn scope   | 语义收缩：只包含当前 Qn 的 tests（旧 schema 是所有 question 汇总）                                                                                                                                                                                                                                                    |
| `tests_failed`              | 全局 scope     | per-Qn scope   | 同上                                                                                                                                                                                                                                                                                                                  |
| `tests_inconclusive`        | 保留           | **删除**       | inconclusive 语义属于 verification 层面，execution 层面无此判定                                                                                                                                                                                                                                                       |
| `execution_summary`         | 保留           | **删除**       | 全局概要由 final_execution_digest 提供，不需要 per-question 概要                                                                                                                                                                                                                                                      |
| `revision_needed`           | 保留           | 保留           | 不变                                                                                                                                                                                                                                                                                                                  |
| `environment_strategy_used` | 保留           | **删除**       | 环境策略信息在 ENVIRONMENT.md 持久化，autoresearch 内部管理，不依赖 digest 传递                                                                                                                                                                                                                                       |
| `gaps_reported`             | 保留           | **删除**       | 环境 gaps 由 ENVIRONMENT.md 记录 + autoresearch bash probe 处理                                                                                                                                                                                                                                                       |
| `output_paths.reasoning`    | 无             | **新增**       | per-question 模式下产出 Qn_REASONING.md                                                                                                                                                                                                                                                                               |
| `output_paths.execution`    | persistence/   | notepads/      | 路径变更：`persistence/EXECUTION.md` → `notepads/[slug]/execution/Qn_EXECUTION.md`                                                                                                                                                                                                                                    |
| `output_paths.environment`  | 保留           | **删除**       | ENVIRONMENT.md 路径不再需要——autoresearch 内部管理写入                                                                                                                                                                                                                                                                |
| `next_phase`                | 可非空         | 固定 null      | autoresearch 内部管理下一步，不依赖 coordinator 路由                                                                                                                                                                                                                                                                  |

**verification_digest 新增字段**：

verification_digest **不包含 `status` 字段**——autoresearch 从 `claims_verified/claims_failed` 和 `reasoning_verification` 5 个 sub-fields 组合判定 question 的 resolved/failed/retry/blocked/paused_ask_user 状态（见 §Verification Decision 判定规则），不再依赖（也不再存在）status 字段。verification worker prompt 中明确要求 "Do NOT include a 'status' field in the digest"（见 §Worker Prompt 模板 — Verification worker）。

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: verification
  cycle: [N]
  question: "[Qn]"
  domain_mode: "[physics / general]"
  conclusion_summary: "[key numerical results, scope of validity, caveats — worker-generated]"
  claims_verified: ["[claim 1]"]
  claims_failed: ["[claim N]"]
  reasoning_verification:
    method_fidelity: [PASS / FAIL]
    step_completeness: [PASS / FAIL]
    assumption_audit: [PASS / FAIL]
    dependency_usage: [PASS / FAIL]
    fallback_applicability: [PASS / FAIL / N/A]
  output_paths:
    verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  next_phase: null
```

**final_execution_digest（autoresearch 最终输出）**：

autoresearch worker 在所有 question 处理完毕后输出的最终 digest，写入 DIGESTS.md（1 条汇总条目）：

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: completed | partial | paused
  domain_mode: "[physics / general]"
  resolved_questions:
    - question: "[Qn]"
      conclusion_summary: "[from state.json.resolved_conclusions[Qn]]"
      output_paths:
        reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
        execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
        verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  failed_questions:
    - question: "[Qn]"
      failure_summary: "[from Qn_REASONING.md + Qn_EXECUTION.md failure context]"
      output_paths:
        reasoning: "notepads/[slug]/execution/Qn_REASONING.md"
        execution: "notepads/[slug]/execution/Qn_EXECUTION.md"
        verification: "notepads/[slug]/execution/Qn_VERIFICATION.md"
  blocked_questions:
    - question: "[Qn]"
      blocking_dependency: "[Qd (critical) / reason]"
  overall_result: "[N resolved / N total questions]"
  output_paths:
    execution_summary: "persistence/EXECUTION.md"
    verification_summary: "persistence/VERIFICATION.md"
  next_phase: null
```

当 status=paused 时，使用 §用户决策通道 中定义的 paused digest schema 替代此 schema。

#### Digest 输出格式约束（权威定义）

autoresearch 和 verification subagent 输出的 digest 必须遵循以下格式约束，确保 coordinator 和 autoresearch 可以可靠地从返回文本中提取结构化数据：

1. **位置约束**：digest 必须是返回消息中**最后一个 `yaml` code block**，以 `phase_result_digest:` 开头。digest 前可以有推理过程摘要或说明文本（供人类审阅），但 digest 本身必须在末尾且可被唯一识别
2. **必须字段校验**：coordinator 和 autoresearch 在解析 digest 后，检查 `phase` 和 `status`（或 `sub_phase` 和 `question`）字段是否存在。如果这两个字段存在，可以判断 digest 类型。如果字段缺失，回退到全文扫描寻找关键词（"paused"、"completed"、"partial"、"resolved"、"failed"）
3. **YAML 格式要求**：使用 YAML 而非 JSON（YAML 对人类可读性更好，研究项目的 digest 会被写入 DIGESTS.md 供后续 phase 审阅）。嵌套深度 ≤ 3，长文本内容用 `[text]` 占位而非实际多行字符串
4. **Fallback**：如果 coordinator 无法从返回消息中提取任何结构化 digest（无 yaml code block 或解析完全失败），将整个返回消息当作非结构化结果，输出到用户并询问下一步操作

#### domain_mode 确定规则（权威定义）

domain_mode 由 **coordinator** 从 framing digest 的 `verification_approach` 字段判断，在 dispatch **research-worker**（不是直接 dispatch autoresearch——coordinator dispatch research-worker，research-worker 内部调用 /autoresearch skill）时注入 prompt。autoresearch 不自行读取 framing digest 判断 domain_mode——使用 coordinator 注入（经 research-worker 传递）的值，避免 autoresearch 额外读取 framing digest 带来不必要的上下文负担。确定规则：

| verification_approach 来源                                     | domain_mode                                    | 确定方式                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| framing digest 中有 verification_approach 字段                 | 从字段值映射                                   | coordinator 从 framing PhaseResultDigest 读取 verification_approach 字段（值域 `{physics, general}`，Layer 3.12 新增此字段到 framing digest schema——值域定义和推导规则在 Layer 3.12 中完成，Layer 3.11 framing skill Step 11 输出需同步新增此字段），映射为 domain_mode 并注入 dispatch prompt |
| framing digest 缺少 verification_approach 字段                 | 从 PLAN.md Claims 推导                         | coordinator 读取 PLAN.md §Claims 的 derived_from：所有 claim 引用 SMED framework → physics；引用 PICO → general；混合 → physics。推导结果注入 dispatch prompt                                                                                                                                  |
| 无 framing digest（极端场景：session recovery 后 digest 丢失） | 从 framing_reasoning.md §Derived Question 推导 | coordinator 读取 framing_reasoning.md §Derived Question：framework=SMED → physics；framework=PICO → general；混合 → physics。推导结果注入 dispatch prompt                                                                                                                                      |

**domain_mode 是一次性决策**：整个 research project 的 domain_mode 在 framing 阶段确定后不会在 question 间变化——所有 question 使用相同的 domain_mode。coordinator 在首次 dispatch research-worker 时确定 domain_mode 并注入 prompt（经 research-worker 传递到 /autoresearch skill invocation），autoresearch 使用注入值无需自行判断。

#### conclusion_summary 生命周期（权威定义）

conclusion_summary 的完整生命周期统一定义如下，不在其他位置重复：

| 阶段 | 角色                | 操作                                                                                                                            |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 生成 | verification worker | 在 verification_digest 中输出 `conclusion_summary` 字段（key numerical results, scope of validity, caveats — worker-generated） |
| 接收 | autoresearch worker | 从 verification worker 的 task_result 中提取 `conclusion_summary`                                                               |
| 存储 | autoresearch worker | 写入 `state.json.resolved_conclusions[Qn].conclusion_summary`（agent 直接写入，见 §state.json 更新方式）                        |
| 使用 | autoresearch worker | 后续 question 的 local-executor prompt 构造从此字段读取依赖结论概要                                                             |
| 汇总 | autoresearch worker | 写入 `persistence/EXECUTION.md` 和 `persistence/VERIFICATION.md`（见 §persistence 汇总格式）                                    |

**权威源规则**：`state.json.resolved_conclusions` 是依赖可用性信息的唯一权威源。Workers 需要结论概要时从 state.json 读取；需要结论细节时直接读取 Qn_VERIFICATION.md。不由 coordinator 从 VERIFICATION.md 提取 conclusion_summary（避免额外 LLM 解释步骤）。

#### Verification Decision 判定规则（权威定义）

autoresearch 不使用 verification_digest 的 `status` 字段做判定——直接从 `claims_verified/claims_failed` 和 `reasoning_verification` 5 个 sub-fields 组合判定 question 的最终状态：

| 条件                                                                       | 判定结果            | 后续行为                                                                                                |
| -------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| claims_failed 为空 + ALL reasoning sub-fields PASS 或 N/A                  | **resolved**        | 写入 resolved_conclusions → 继续下一个 question                                                         |
| reasoning 有 FAIL + fallback_applicability=FAIL                            | **paused_ask_user** | 设计层面失败——立即输出 paused digest，不消耗任何 retry（执行层面 retry 或 verification retry 均不适用） |
| reasoning 有 FAIL + fallback_applicability≠FAIL                            | **retry_execution** | 推理偏离但 fallback 未失效——execution cycle < 3 时 retry（backup + re-dispatch local-executor）         |
| claims_failed 非空 + ALL reasoning PASS                                    | **retry_execution** | 推理忠实但结论错误——方法本身可能有问题，execution cycle < 3 时 retry                                    |
| claims_failed 非空 + reasoning 有 FAIL（不含 fallback_applicability=FAIL） | **retry_execution** | 同时有推理偏离和结论错误——execution cycle < 3 时 retry                                                  |
| execution cycle ≥ 3 + 仍未 resolved                                        | **failed**          | 标记 question_status=failed → 触发失败传播                                                              |

"ALL reasoning sub-fields PASS 或 N/A"：fallback_applicability=N/A 时视为 PASS，不参与判定。其余 4 个 sub-fields（method_fidelity、step_completeness、assumption_audit、dependency_usage）必须全部 PASS。

#### Execution-level Failure Decision（权威定义）

local-executor dispatch 后，autoresearch 需要判定 execution 是否成功产出结果。判定规则：

| 条件                                                                 | 判定结果               | 后续行为                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| task_result 为空或无结构化内容（worker 崩溃）                        | **execution_failed**   | current_cycle < 3 → backup + retry（re-dispatch local-executor）；current_cycle ≥ 3 → mark Qn failed                             |
| Qn_REASONING.md + Qn_EXECUTION.md 均不存在（worker 未产出任何文件）  | **execution_failed**   | 同上                                                                                                                             |
| Qn_REASONING.md + Qn_EXECUTION.md 存在 + execution_cycle_digest 正常 | **execution_produced** | 继续进入 verification dispatch（见 §autoresearch 内部推进逻辑 Step f-g）                                                         |
| execution_cycle_digest.status=failed（部分产出但测试失败）           | **execution_produced** | 继续进入 verification dispatch——verification 会判定结论是否通过 falsification criterion，execution 产出了文件即进入 verification |

**关键区分**：execution-level failure 只判定"worker 是否产出了可验证的文件"，不判定"结果是否正确"。结果正确性由 verification 判定。execution 崩溃/未产出 → 直接 retry execution cycle；execution 产出了文件但结果可能有误 → 进入 verification 让 verifier 判断。

**execution_cycle_digest status 语义重定义**（与旧 autoresearch SKILL.md 的 status 语义不同）：

| status 值   | 语义                                                                         | 后续行为                                                                  | 与旧 schema 的差异                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed` | Qn_REASONING.md + Qn_EXECUTION.md 已产出，且所有 PLAN.md 声明的 tests_passed | 继续进入 verification dispatch                                            | 旧 schema completed = all tests_passed（语义一致）                                                                                           |
| `partial`   | Qn_REASONING.md + Qn_EXECUTION.md 已产出，但部分 tests_failed                | 继续进入 verification dispatch（verifier 判断结论是否通过 falsification） | 旧 schema partial = some tests_failed（语义一致）                                                                                            |
| `failed`    | local-executor 崩溃/未产出任何文件                                           | current_cycle < 3 → retry；current_cycle ≥ 3 → mark Qn failed             | 旧 schema failed 含"execution 崩溃"（语义一致），但旧 schema 还有 `inconclusive`（已删除——gaps prevented test 的语义属于 verification 层面） |

**旧 schema 删除字段清单**（旧 autoresearch SKILL.md 行 230-249 中以下字段不再使用）：

| 删除字段                    | 删除理由                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests_inconclusive`        | inconclusive 语义属于 verification 层面（gaps prevented test），execution 只有"产出"或"未产出"二元判定    |
| `execution_summary`         | autoresearch 是 per-question 推进管理器，全局概要由 final_execution_digest 提供，不需要 per-question 概要 |
| `environment_strategy_used` | 环境策略信息在 ENVIRONMENT.md 持久化，autoresearch 内部管理，不依赖 digest 传递                           |
| `gaps_reported`             | 环境 gaps 由 ENVIRONMENT.md 记录 + autoresearch bash probe 处理，不需要 per-question digest 报告          |
| `output_paths.environment`  | ENVIRONMENT.md 路径不再需要——autoresearch 内部管理写入，不在 per-question digest 中报告                   |

#### Verification digest 解析失败处理与 verification retry 计数

autoresearch 从 verification worker 的 task_result 文本中解析 verification_digest YAML block。解析失败有三种场景：

| 场景                                 | 判断方式                                                                | 处理方式                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| verification 中断（worker 崩溃）     | task_result 为空或无结构化内容                                          | verification_retries < 3 → 重新 dispatch verification worker（verification retry）；verification_retries ≥ 3 → mark Qn failed                                                  |
| verification 完成但格式不符合 schema | task_result 有内容但无法解析为 YAML block                               | verification_retries < 3 → 重新 dispatch verification worker 要求"输出必须包含 `yaml phase_result_digest:` code block 作为最后输出"；verification_retries ≥ 3 → mark Qn failed |
| autoresearch 提取内容失败            | YAML 解析成功但关键字段缺失（question、claims、reasoning_verification） | verification_retries < 3 → 重新 dispatch verification worker 要求"必须包含所有必需字段"；verification_retries ≥ 3 → mark Qn failed                                             |

**verification_retries 独立计数**：verification retry 使用 `state.json.execution.verification_retries[Qn]` 计数，与 execution cycle 的 `current_cycle` 完全独立。每个 question 初始化为 0，每次 verification retry 递增 1，上限 3。question resolved 或 execution cycle retry 时重置为 0。

**verification retry 不消耗 execution cycle**：verification 是独立的验证步骤，其失败不应导致整个 execution cycle 被标记为失败并 backup 重做。只有 execution 本身失败才消耗 execution cycle 计数。

**verification retry 时的 Qn 文件处理**：verification retry 不需要 backup Qn_VERIFICATION.md（verification worker 每次重新写入，覆盖旧版本）。只有 execution cycle retry 时才 backup 所有 Qn 文件。

### 总体流程（方案 D：coordinator 一次 dispatch）

**Coordinator dispatch research-worker prompt 模板**（coordinator dispatch research-worker，research-worker 内部调用 /autoresearch skill——不是直接 dispatch autoresearch subagent）：

```
Execute phase_execution (per-question推进 mode).
Invoke /autoresearch skill.
Read PLAN.md Execution Plan for per-Wave structure, question list, and Dependencies (self-contained).
Read state.json.execution for current execution state (if session recovery, resume from current interruption point).
Domain mode: [domain_mode — determined by coordinator from §domain_mode 确定规则, injected into prompt; autoresearch uses this value directly, does NOT自行判断domain_mode].

You MUST manage per-question推进 internally:
1. Read PLAN.md → determine Waves and question sorting (tractability confidence, HIGH > MEDIUM > LOW)
2. Read state.json.execution → resume from interruption point if needed
3. Per-question loop: execution → verification → decision → failure propagation → retry
4. Output final_execution_digest (见 §Digest Schema) or paused digest (见 §用户决策通道)

MANDATORY: You MUST write persistence/EXECUTION.md and persistence/VERIFICATION.md as phase-level summaries when execution cannot proceed further (all Waves processed or early abort). Summary format见 §persistence 汇总格式. You MUST NOT write per-question intermediate results to persistence/ — per-question outputs go to notepads/[slug]/execution/ only.
MANDATORY: You MUST NOT skip verification for any question — every question must go through execution → verification → decision.
MANDATORY: You MUST dispatch verification subagent directly (research-verifier for general mode, gpd-verifier + research-verifier for physics mode — domain_mode is provided above, do NOT read framing digest to determine it) — not through research-worker (see §Verifier 统一架构).
```

**Coordinator re-dispatch research-worker prompt 模板**（用户决策后恢复——coordinator 重新 dispatch research-worker，research-worker 内部调用 /autoresearch skill）：

```
Continue phase_execution (per-question推进 mode) from pause point.
Invoke /autoresearch skill.

USER DECISION: [user's choice from question tool — e.g., "Skip all dependent questions, accept partial results" or "Provide alternative assumption: [user-specified content]" or "Abort execution"]

Domain mode: [domain_mode — same as initial dispatch, determined by coordinator from §domain_mode 确定规则]

Read state.json.execution for current execution state. Resume from current_wave/current_question.
The paused question [Qn] should be handled per user decision:
- If skip: mark [Qn] and all dependents as blocked → continue with remaining questions
- If alternative assumption: inject user-provided assumption as fallback for [Qn] → continue
- If abort: output final digest with partial results immediately

Continue per-question推进 per §autoresearch Skill 适配 procedure.
```

1. Coordinator 构造 research-worker dispatch prompt（按上方模板），注入 domain_mode
2. Coordinator 派遣 research-worker（一次 dispatch——research-worker 内部调用 /autoresearch skill，autoresearch 内部管理所有 question 推进）
3. 等待 research-worker 返回 digest（digest 来自 autoresearch 的最终输出）
4. 如果 digest status=paused → coordinator 使用 question tool 询问用户 → 用户决策后 re-dispatch research-worker（按上方 re-dispatch 模板，注入用户决策）
5. 如果 digest status=completed/partial → coordinator 调用 advance_plan(phase=completed) → present results（persistence 汇总文件已由 autoresearch 写入）

### Coordinator 与 Autoresearch 职责边界与衔接时序

方案 D 下 persistence 汇总文件由 autoresearch 写入，coordinator 不参与格式化。两者的职责边界和衔接时序如下：

**职责边界**：

| 职责                          | 执行者                       | 说明                                                                                              |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| per-question 推进管理         | autoresearch                 | Wave 排序、question 串行、execution/verification dispatch、decision、失败传播、retry、early abort |
| ENVIRONMENT.md 探测与写入     | autoresearch                 | bash 探测 + 增量写入 persistence/ENVIRONMENT.md                                                   |
| per-question 工作文件写入     | autoresearch 派遣的 subagent | local-executor → Qn_REASONING.md + Qn_EXECUTION.md；verification subagent → Qn_VERIFICATION.md    |
| state.json execution 字段更新 | autoresearch                 | agent 直接写入（见 §state.json 更新方式）                                                         |
| persistence 汇总文件写入      | autoresearch                 | 执行结束时一次性写入 persistence/EXECUTION.md + persistence/VERIFICATION.md                       |
| DIGESTS.md 写入               | autoresearch                 | final_execution_digest 写入 1 条；paused digest 写入 1 条                                         |
| phase 转换（advance_plan）    | coordinator                  | 调用 MCP advance_plan(phase=completed)                                                            |
| 用户决策代理                  | coordinator                  | 收到 paused digest → question tool 询问用户 → re-dispatch 注入用户决策                            |
| crash 兜底写入                | coordinator                  | autoresearch crash 且 persistence 汇缩文件不存在时，coordinator 从 state.json 兜底写入汇总        |

**衔接时序（4 种场景）**：

**场景 1：正常完成**

```
autoresearch:
  1. per-question 推进循环（所有 question resolved/failed/blocked）
  2. 写入 persistence/EXECUTION.md + persistence/VERIFICATION.md（一次性，见 §persistence 汇总格式）
  3. 输出 final_execution_digest（output_paths 包含 execution_summary + verification_summary）

coordinator:
  4. 收到 digest → 解析 status=completed/partial
  5. 调用 advance_plan(phase=completed) → advance_plan 内部更新 state.json.phase + plan_number
  6. present results（persistence 汇缩文件已存在，可直接读取展示）
```

**场景 2：暂停恢复**

```
autoresearch:
  1. per-question 推进循环中遇到需用户决策的情况
  2. 输出 paused digest（status=paused, 见 §用户决策通道）
  → 不写入 persistence 汇缩文件（执行尚未结束，后续 question 可能继续推进）

coordinator:
  3. 收到 paused digest → 解析 status=paused → 将 paused digest 追加到 DIGESTS.md（1 条）
  4. 使用 question tool 向用户呈现暂停原因和选项
  5. 用户做出决策后 → 构造 re-dispatch prompt（注入用户决策）

autoresearch (re-dispatch):
  6. 从暂停点继续 per-question 推进（处理暂停 question per 用户决策）
  7. 继续推进剩余 question
  8. 写入 persistence/EXECUTION.md + persistence/VERIFICATION.md（一次性）
  9. 输出 final_execution_digest

coordinator:
  10. 收到 digest → advance_plan(phase=completed) → present results
```

**场景 3：Early abort**

```
autoresearch:
  1. per-question 推进循环中 early abort 条件触发（所有未完成 question failed/blocked，无 pending）
  2. 写入 persistence/EXECUTION.md + persistence/VERIFICATION.md（部分结果汇总）
  3. 输出 final_execution_digest（status=partial, 含部分 resolved + 全部 failed/blocked）

coordinator:
  4. 收到 digest → 解析 status=partial
  5. 调用 advance_plan(phase=completed) → present partial results + unresolved list
```

**场景 4：Crash 兜底**

```
session recovery:
  coordinator:
  1. 确认 phase=phase_execution → 读取 state.json.execution
  2. 检查 persistence/EXECUTION.md + persistence/VERIFICATION.md 是否已存在
     - 已存在 → autoresearch 已完成汇总写入 → advance_plan(phase=completed)
     - 不存在 → 继续检查 question_status
  3. question_status 中所有 question 已 resolved/failed/blocked（无 pending）
     → autoresearch crash 于汇总写入阶段
     → coordinator 从 state.json 兜底写入 persistence/EXECUTION.md + persistence/VERIFICATION.md
     → advance_plan(phase=completed)
  4. question_status 中仍有 pending → autoresearch crash 于 per-question 推进阶段
     → coordinator 重新 dispatch autoresearch（prompt 注入 recovery 指令）
     → autoresearch 从中断点恢复并继续推进
     → 推进完成后 autoresearch 写入 persistence 汇总 + 输出 final digest
     → coordinator 调 advance_plan(phase=completed)
```

**persistence 汇总写入时序约束**：

- autoresearch 写入 persistence/EXECUTION.md + persistence/VERIFICATION.md **必须在输出 final_execution_digest 之前**——这样 digest 的 output_paths 可以引用实际已写入的文件路径，coordinator 收到 digest 后可以确认汇总文件已存在
- autoresearch 写入汇总后 **不需要通知 coordinator**——coordinator 通过 digest 的 output_paths 字段确认汇总文件位置；coordinator 不重新读取汇总文件内容（只做 advance_plan 转换）
- 如果 autoresearch 写入汇总文件后 crash（极端场景：写入完成但 digest 未输出）→ coordinator 在 session recovery 中发现 persistence 汇总文件已存在 → 直接 advance_plan，无需 re-dispatch autoresearch

### autoresearch 内部推进逻辑（per-question 循环）

autoresearch worker 内部执行完整的 per-question 推进循环：

```
1. Read Plan & Determine Waves:
   - Read PLAN.md Execution Order → determine all Waves and question lists
   - Sort questions within each Wave by tractability confidence（排序规则见 §Wave 内 question 执行顺序，此处不重复定义）
   - Read state.json.execution → resume from interruption point if session recovery

2. Read Execution State & Resume:
   - Read state.json.execution → current_wave, current_question, current_cycle, current_step, verification_retries, question_status, resolved_conclusions
   - If state.json.execution exists → resume from interruption point
   - If state.json.execution does NOT exist → initialize it (见 §autoresearch 内部推进逻辑 Step 2)
   - Read domain_mode from dispatch prompt — use directly, NOT自行判断

3. Environment Probe (before first local-executor dispatch):
   - Bash probe host system → classify isolation strategy → write ENVIRONMENT.md
   - Incremental updates between questions (见 §ENVIRONMENT.md 共享与增量更新)

4. Per-Question Loop (outer: Wave iteration, inner: question iteration):
   For each Wave, for each question [Qn] (sorted by tractability confidence):

   a. Check question_status:
      - "blocked" → skip
      - "pending" → proceed

   b. Prepare execution context:
      - Read PLAN.md §Execution Plan → Qn's method, tools, falsification test, Dependencies (self-contained: critical/fallback/dependency description)
      - For each dependency Qd in Dependencies:
        - If Qd resolved → read state.json.resolved_conclusions[Qd].conclusion_summary + output_paths
          → local-executor will read Qd_REASONING.md + Qd_EXECUTION.md + Qd_VERIFICATION.md
        - If Qd failed + fallback exists → note in local-executor prompt that Qd failed and Qn uses fallback
          → inject Qd failure context from Qd_REASONING.md + Qd_EXECUTION.md into prompt
        - If Qd failed + critical → skip Qn (already blocked)
      - ENVIRONMENT.md: read for current environment state; if Qn needs additional software, autoresearch supplements bash probe and incrementally writes ENVIRONMENT.md

   c. Update state.json.execution.current_step = "execution" (agent 直接写入)

   d. Dispatch local-executor → Qn_REASONING.md + Qn_EXECUTION.md

   e. Read execution results → execution-level failure decision per §Execution-level Failure Decision（execution_produced → proceed to verification; execution_failed → retry if cycle < 3, mark failed if cycle ≥ 3）

   f. Update state.json.execution.current_step = "verification" (agent 直接写入)

   g. Dispatch verification subagent (domain_mode from coordinator dispatch prompt, 见 §domain_mode 确定规则):
      - domain_mode=general → task(subagent_type: "research-verifier", delegation_depth: 0, prompt: [按 §Worker Prompt 模板])
      - domain_mode=physics → sequentially dispatch gpd-verifier then research-verifier (见 §research-verification domain_mode 内部流程 domain_mode=physics dispatch 流程)

   h. Read verification_digest → decision (见 §Verification Decision 判定规则):
      **Digest 解析**：autoresearch 从 verification worker 的 task_result 文本中解析 verification_digest YAML block，提取 conclusion_summary 和 reasoning_verification 字段。解析失败处理见 §Verification digest 解析失败处理与 verification retry 计数。
      - Decision logic per §Verification Decision 判定规则 table
      - resolved → store conclusion_summary in state.json.resolved_conclusions[Qn] (agent直接写入)
      - Only fully verified questions stored (ALL claims verified AND ALL non-N/A reasoning checks PASS)

   i. Update state.json.execution (agent 直接写入, see §state.json 更新方式):
      - current_wave, current_question, current_cycle, current_step
      - question_status, resolved_conclusions, verification_retries

   j. **Early abort check (after each question decision)**：
      After updating question_status for Qn (resolved/failed/blocked), check:
      - Are there any remaining "pending" questions in question_status?
      - If NO → all remaining questions are failed/blocked, no executable question left → terminate (early abort)
      - This check runs after EVERY question decision, not only at Wave boundaries
      - Early abort triggers: autoresearch writes persistence 汇总 with partial results → outputs final digest → coordinator calls advance_plan

   k. Failure propagation:
      When Qn fails (max retries) OR fallback fails:
      - Read PLAN.md §Execution Plan Dependencies for Qn (self-contained: critical/fallback/dependency description)
      - For each dependent question Qd:
        - Critical → mark Qd as "blocked" in state.json.question_status
        - Non-critical + fallback described in PLAN.md → continue Qd with fallback assumption
        - No fallback in PLAN.md → output paused digest, wait for coordinator to ask user

   l. Backup before retry (if retry needed):
      - Backup Qn_REASONING.md / Qn_EXECUTION.md / Qn_VERIFICATION.md as _cycle[N] suffix
      - Dispatch new execution + verification cycle

5. Final Output + Write Summaries:
   All Waves processed OR early abort triggered →
   - Write persistence/EXECUTION.md + persistence/VERIFICATION.md (见 §persistence 汇总格式)
   - Output final digest with:
     - All resolved question conclusion_summaries
     - All failed question failure summaries
     - All blocked question blocking dependencies
     - Overall result status
```

### Retry 逻辑

每个 question 最多 3 次 execution cycle：

| Cycle | 行为                                                        | 文件操作                                                                                    |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1     | 正常执行                                                    | Worker 写入 Qn_REASONING.md + Qn_EXECUTION.md                                               |
| 2     | 基于前次 execution_cycle_digest 的 revision_needed 修订策略 | autoresearch 备份当前文件为 \_cycle1 后缀 → Worker 写入新 Qn_REASONING.md + Qn_EXECUTION.md |
| 3     | 再次修订                                                    | autoresearch 备份当前文件为 \_cycle2 后缀 → Worker 写入新 Qn_REASONING.md + Qn_EXECUTION.md |
| >3    | 标记失败，触发失败传播                                      | N/A                                                                                         |

Retry 备份操作：autoresearch worker 在 retry 前将 Qn_REASONING.md / Qn_EXECUTION.md / Qn_VERIFICATION.md 分别备份为 Qn_REASONING_cycle[N].md / Qn_EXECUTION_cycle[N].md / Qn_VERIFICATION_cycle[N].md（N 为当前 cycle 编号——被备份文件的 cycle 编号，不是新 cycle 编号。如 cycle 1 备份为 \_cycle1，cycle 2 备份为 \_cycle2）。Worker 写入新版本替换无后缀文件。

---

## Worker Prompt 模板

以下模板由 autoresearch worker 内部构造，用于派遣 local-executor 和 verification worker。

### Execution worker（local-executor，带依赖输入 + 推理记录产出）

```
Execute question [Qn] (wave [N]) of phase_execution (cycle [C]).
Invoke /autoresearch skill.
Read PLAN.md Execution Plan wave [N] → question [Qn].

[If cycle > 1, add:]
REVISION FROM PREVIOUS CYCLE: [revision_needed from previous execution_cycle_digest — specific description of what to revise and why previous attempt failed]

ENVIRONMENT.md handling: Read ENVIRONMENT.md in persistence/ for current environment state (including venv_state). If current question needs additional software, autoresearch will supplement probe and incrementally update ENVIRONMENT.md — you do NOT modify ENVIRONMENT.md yourself.

DEPENDENCIES (from resolved questions):
- Q1 conclusion: [conclusion_summary from state.json.resolved_conclusions[Q1]]
  - Input for [Qn]: [what Q1 provides — e.g., numerical parameter, classification result]
  - File reference: notepads/[slug]/execution/Q1_REASONING.md, Q1_EXECUTION.md, Q1_VERIFICATION.md

OR (if dependency failed, using fallback):
- Q1 has failed. This question uses fallback assumption instead of Q1's conclusion.
  - Failure context (from autoresearch): [Q1 failure context from Q1_REASONING.md + Q1_EXECUTION.md]
  - Q1 files (Q1_REASONING.md + Q1_EXECUTION.md) may be read for additional failure context, but may not exist (Q1 worker crashed). If absent, rely on failure context summary + PLAN.md Dependencies fallback description.
  - Fallback assumption: [from PLAN.md Execution Plan Dependencies for Qn — self-contained fallback description, including: what alternative assumption to use, scope of applicability, source reference]

Method: [from PLAN.md]
Tools: [from PLAN.md]
Falsification test: [from PLAN.md Acceptance Tests for Qn]

MANDATORY: You MUST write TWO output files:

1. Qn_REASONING.md — Step-by-step derivation from PLAN.md method to concrete solution.
   Structure: Method Design Reference → Step-by-Step Derivation (each step with
   Intention, Method, Divergence, Assumption introduced) → Dependency Usage.
   Every divergence from PLAN.md method MUST be declared.
   Every new assumption NOT in framing_reasoning.md MUST be flagged as undeclared.

2. Qn_EXECUTION.md — Execution results (numerical, code, output).
   Do NOT include a Dependencies section. All dependency details belong in
   Qn_REASONING.md §Dependency Usage only.

Output files: notepads/[slug]/execution/Qn_REASONING.md, Qn_EXECUTION.md
After completing, output execution_cycle_digest as your final message.
```

### Verification worker（research-verifier subagent，推理验证 + 结论验证 + 统一 domain_mode）

以下模板由 autoresearch worker 内部构造，用于派遣 research-verifier subagent 调用 research-verification skill。

```
Execute verification for question [Qn] of phase_execution (cycle [C]).
Invoke /research-verification skill with domain_mode=[general].
Read Qn_REASONING.md, Qn_EXECUTION.md, and PLAN.md Contract section for Qn's claims ONLY.
Do NOT verify claims from other questions.

RESOLVED CONCLUSIONS (from upstream questions, for dependency usage check):
- [Qd] conclusion_summary: [from state.json.resolved_conclusions[Qd].conclusion_summary]
  - Scope: [what Qd's conclusion covers and its limitations — used for dependency_usage check]
  - File reference: Qd_VERIFICATION.md (for detailed scope check)

[If any dependency Qd has failed and Qn uses fallback, add:]
- [Qd] has failed. Qn uses fallback assumption: [from PLAN.md Dependencies for Qn]

TWO-PART VERIFICATION:

Part 1 — Reasoning Verification (Qn_REASONING.md):

For each step in Qn_REASONING.md §Step-by-Step Derivation:
a. Method fidelity: Does the step's Method match PLAN.md Execution Plan for Qn?
   - If Divergence declared: Is the reason valid? Is impact correctly described?
   - If no Divergence but method clearly differs from PLAN.md → flag as undeclared divergence
b. Step completeness: Does every PLAN.md method step have a corresponding reasoning step?
   - Missing steps → flag as skipped step
c. Assumption audit: For each "Assumption introduced":
   - Is this assumption declared in framing_reasoning.md §Assumptions Introduced?
   - If NOT → flag as undeclared assumption (FATAL for verification)
d. Dependency usage check: For each dependency in §Dependency Usage:
    - Is the usage within the scope of Qd's conclusion_summary? (no overgeneralization — compare against resolved_conclusions scope)
    - If fallback assumption used → is it the same fallback from PLAN.md Execution Plan Dependencies (self-contained description)?
e. Fallback applicability check (if fallback assumption used):
   - Is the fallback assumption applicable to Qn's actual usage scenario?
   - If NOT → flag as fallback inapplicable (设计层面失败 — must pause and ask user, no retry)

Part 2 — Conclusion Verification (Qn_EXECUTION.md + deterministic scripts):
Claims to verify: [list Qn's claims from PLAN.md — those with question=Qn]

VERIFICATION RESULT FORMAT:

Qn_VERIFICATION.md must contain two sections:
## Reasoning Verification
- method_fidelity: [PASS / FAIL — with details per step]
- step_completeness: [PASS / FAIL — list any skipped steps]
- assumption_audit: [PASS / FAIL — list any undeclared assumptions]
- dependency_usage: [PASS / FAIL — list any overgeneralization]
- fallback_applicability: [PASS / FAIL / N/A — list if fallback not applicable to Qn's usage]

## Conclusion Verification
- [general verification format per research-verification skill]

Decision rules (见 §Verification Decision 判定规则):
- ALL claims verified + ALL reasoning sub-fields PASS or N/A → Qn resolved
- Reasoning FAIL (method divergence, undeclared assumption) → execution process unreliable, must retry
- Reasoning FAIL (fallback inapplicable, 设计层面) → structural failure, immediate pause and ask user (no retry)
- Conclusion FAIL (reasoning PASS) → method itself may be flawed, retry with revised strategy

Digest MUST include these fields (见 §Digest Schema（权威定义） for authoritative schema):
- conclusion_summary: "[key numerical results, scope of validity, caveats]"
- claims_verified: [list of verified claims]
- claims_failed: [list of failed claims]
- reasoning_verification: { method_fidelity, step_completeness, assumption_audit, dependency_usage, fallback_applicability }
- Do NOT include a "status" field in the digest — autoresearch judges question outcome from claims + reasoning sub-fields directly (见 §Verification Decision 判定规则)

Output file: notepads/[slug]/execution/Qn_VERIFICATION.md
After completing, output verification_digest as your final message.
```

---

## 输出文件结构

文件结构树和版本规则见 §输出文件结构：单独文件 + 备份历史 + 推理记录 + 汇总文件。

### Qn_REASONING.md 结构

每个 question 的推理记录记录从 PLAN.md 方法到具体求解的完整推导链条：

```markdown
# Q2 Execution Reasoning

## Method Design Reference

- PLAN.md method: [method description from PLAN.md Execution Plan for Q2]
- PLAN.md tools: [tools list from PLAN.md]
- PLAN.md falsification test: [test description from PLAN.md Acceptance Tests for Q2]

## Step-by-Step Derivation

### Step 1: [derive/describe what was done]

- Intention: [what this step is supposed to achieve per PLAN.md]
- Method: [how this step was executed — matching PLAN.md method or diverging]
- Divergence: [NONE / describe if method diverged from PLAN.md]
  - Reason for divergence: [if diverged: why]
  - Impact: [if diverged: what this means for downstream steps]
- Assumption introduced: [NONE / describe any new assumption not in PLAN.md]
  - Is this assumption in framing_reasoning.md Assumptions Introduced? [yes / no]
  - If no → this is an undeclared assumption that must be flagged in verification

### Step 2: [same structure]

...

## Dependency Usage

- Q1 conclusion used: [what was used from Q1]
  - From: Q1_VERIFICATION.md §[section], claim [X]
  - How used: [parameter in equation / initial condition / method selection criterion]
  - Is this usage consistent with Q1's conclusion scope? [yes / no]
  - If no → overgeneralization detected, must be flagged in verification

- Fallback assumption (if applicable):
  - Assumption: [description — from PLAN.md §Execution Plan Dependencies for [Qn]（自包含型，权威源见 §与 Layer 3.11 的实施依赖关系 依赖数据权威源规则）]
  - Risk: [what could go wrong]
```

### Qn_EXECUTION.md 结构

Execution 文件不包含 Dependencies section（理由：依赖信息的唯一权威源是 Qn_REASONING.md §Dependency Usage。Verification worker 同时读取 REASONING.md 和 EXECUTION.md，依赖详情已在上下文中，不需要在 EXECUTION.md 中重复。删除此 section 避免双处维护导致不一致，节省 verification worker 上下文）：

```markdown
# Q2 Execution Record

## Execution

[execution content — numerical results, code, output]
```

---

## persistence 汇总格式

persistence/EXECUTION.md 和 persistence/VERIFICATION.md 在 execution 无法继续推进时由 **autoresearch worker** 写入。autoresearch 已有全部汇总数据（在 per-question 推进过程中收集），写入过程是纯机械格式化（从 state.json.resolved_conclusions + question_status 生成 3 个表格 + Overall Result 段落），不引入额外的 LLM 解释误差。写入流程：autoresearch 从 state.json.resolved_conclusions 获取所有 resolved question 的 conclusion_summary，从 state.json.execution.question_status 筛选 failed/blocked question（question_status[Qn] == "failed" 或 "blocked"），从 Qn_REASONING.md + Qn_EXECUTION.md 获取 failure context。格式以结论索引和引用为主，不复写详细内容：

```markdown
# Execution Summary

## Resolved Questions

| Question | Conclusion Summary                                            | File Reference                            |
| -------- | ------------------------------------------------------------- | ----------------------------------------- |
| Q1       | [conclusion_summary from state.json.resolved_conclusions[Q1]] | notepads/[slug]/execution/Q1_EXECUTION.md |
| Q3       | [conclusion_summary from state.json.resolved_conclusions[Q3]] | notepads/[slug]/execution/Q3_EXECUTION.md |

## Failed Questions

| Question | Failure Reason                                           | File Reference                            |
| -------- | -------------------------------------------------------- | ----------------------------------------- |
| Q2       | [failure context from Q2_REASONING.md + Q2_EXECUTION.md] | notepads/[slug]/execution/Q2_REASONING.md |

## Blocked Questions

| Question | Blocking Dependency | Note                                   |
| -------- | ------------------- | -------------------------------------- |
| Q4       | Q2 (critical)       | Cannot proceed without Q2's conclusion |

## Overall Result

[N questions resolved / N total questions. Key findings: [1-2 sentence synthesis from resolved conclusion_summaries].]
```

```markdown
# Verification Summary

## Resolved Questions

| Question | Reasoning Verdict | Conclusion Verdict | File Reference                               |
| -------- | ----------------- | ------------------ | -------------------------------------------- |
| Q1       | ALL PASS          | ALL PASS           | notepads/[slug]/execution/Q1_VERIFICATION.md |
| Q3       | ALL PASS          | ALL PASS           | notepads/[slug]/execution/Q3_VERIFICATION.md |

## Failed Questions

| Question | Failure Category | Details              | File Reference                               |
| -------- | ---------------- | -------------------- | -------------------------------------------- |
| Q2       | conclusion FAIL  | [claims_failed list] | notepads/[slug]/execution/Q2_VERIFICATION.md |

## Blocked Questions

| Question | Note                         |
| -------- | ---------------------------- |
| Q4       | Not verified (blocked by Q2) |
```

---

## Session Recovery

### 从 phase_execution 中断恢复

方案 D 下 session recovery 的责任分为两层：

**coordinator 层**（判断是否需要 dispatch autoresearch + crash 兜底）：

1. 读取 STATE.md → 确认当前 phase 为 phase_execution
2. 读取 state.json（via MCP get_state） → 确认 execution 子对象存在
3. 检查 persistence/EXECUTION.md 和 persistence/VERIFICATION.md 是否已存在
   - 已存在 → autoresearch 之前已完成汇总写入 → 直接调用 advance_plan(phase=completed) → present results
   - 不存在 → 继续检查 execution 子对象
4. 如果 execution 子对象存在且 current_step 非空 → 派遣 autoresearch worker（prompt 注入 "Session recovery re-dispatch. Read state.json.execution to determine current interruption point (current_wave, current_question, current_cycle, current_step, question_status) and resume from there. After all questions processed, write persistence/EXECUTION.md and persistence/VERIFICATION.md per §persistence 汇总格式."）
5. 如果 execution 子对象存在且 question_status 中所有 question 都已 resolved/failed/blocked（无 pending）但 persistence 汇缩文件不存在 → autoresearch 之前 crash 于汇总写入阶段 → coordinator 从 state.json 兜底写入 persistence/EXECUTION.md + persistence/VERIFICATION.md（按 §persistence 汇总格式），然后 advance_plan(phase=completed)
6. 如果 execution 子对象不存在 → 派遣 autoresearch worker（prompt 注入 "Fresh start, no prior execution state in state.json. Determine Waves from PLAN.md and framing_reasoning.md and proceed from Wave 1 Question 1. After all questions processed, write persistence/EXECUTION.md and persistence/VERIFICATION.md per §persistence 汇总格式."）

**注意**：coordinator 不注入具体的中断点参数（current_wave, current_question 等），autoresearch 自行从 state.json.execution 读取恢复。

**autoresearch 层**（内部恢复具体中断点）：

1. 读取 state.json.execution → current_wave, current_question, current_cycle, current_step, verification_retries, question_status
2. 根据状态恢复（per-question digest 不写入 DIGESTS.md，恢复依据为 state.json.execution + 文件存在性检查）：
   - current_step = "execution" → 检查 Qn_REASONING.md + Qn_EXECUTION.md 是否存在
     - 文件存在且完整 → 构造 fallback digest，直接进入 verification dispatch（verification_retries 从 state.json 继续计数，不重置）
     - 文件不存在 → 重新 dispatch local-executor（cycle = current_cycle），verification_retries 重置为 0（execution cycle retry 时重置 verification_retries，见 §verification_retries 独立计数）
   - current_step = "verification" → 检查 Qn_VERIFICATION.md
     - 文件存在 → 构造 fallback verification digest，直接做 decision
     - 文件不存在 → 重新 dispatch verification worker（verification_retries 从 state.json 继续计数，不重置——verification retry 途中中断，恢复后从当前 verification_retries 值继续）
   - question_status 中有 blocked → 继续推进下一个 non-blocked question
   - question_status 中有 pending → 从该 question 继续

---

## 实现改动清单

| 改动项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 类型                                                   | 文件                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| phase_execution 从一次性改为 autoresearch 内部管理 per-question 推进（方案 D）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **重大修改**                                           | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |
| coordinator 推进逻辑简化为：一次 dispatch autoresearch → 等待 final/paused digest → 用户决策时 re-dispatch → 调用 advance_plan。**research.md Execution Loop (约 75 行) 整体替换**：删除 coordinator-managed 逐 cycle dispatch 逻辑（cycle 1 → verification → retry 循环），替换为约 10 行的新逻辑：dispatch autoresearch (一次) → 等待 digest → 如果 paused 则 question tool 询问用户并 re-dispatch → 如果 completed/partial 则调用 advance_plan(phase=completed)（persistence 汇总由 autoresearch 写入，coordinator 不负责格式化）                                                                                                                                                                                                                                                                                                       | **重大修改**                                           | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |
| 用户决策通道（autoresearch 输出 paused digest → coordinator 用 question tool 询问 → re-dispatch 注入用户决策）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 新增                                                   | `.aether/agent/research.md` + `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                          |
| 失败传播逻辑（B+C 混合 + fallback 失败分类：执行层面 vs 设计层面 + fallback assumption 传递方式）——由 autoresearch 内部管理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| state.json 新增 execution 字段（current_wave, current_question, current_cycle, current_step, verification_retries, question_status, resolved_conclusions）；移除 failed_questions 和 blocked_questions 数组（从 question_status 动态筛选）；失败历史保留终态不清空；rollback 到更早 phase 时整体清空；execution 与 audit 子对象无交互；execution 内部字段由 autoresearch worker agent 直接写入（见 §state.json 更新方式），phase 转换级字段仍通过 MCP 更新                                                                                                                                                                                                                                                                                                                                                                                 | 修改                                                   | `.aether/skills/autoresearch/SKILL.md` (直接写入) + MCP 服务器源码 (advance_plan 保留)                                                                                                                                                                                                                                        |
| resolved_conclusions.conclusion_summary 由 verification subagent digest 返回，由 autoresearch worker 写入 state.json；resolved_conclusions 是依赖可用性信息唯一权威源（见 §conclusion_summary 生命周期）；persistence 汇总从此字段聚合派生                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| execution worker 提示词模板由 autoresearch 内部构造（带依赖输入 + fallback indicator + mandatory reasoning output + 无 Dependencies section + retry 时注入 revision_needed）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| verification worker 提示词模板由 autoresearch 内部构造（推理验证 + 结论验证 + domain_mode=general + conclusion_summary digest 字段 + fallback applicability check + resolved_conclusions 注入 dependency usage check）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| autoresearch skill 重大修改：从"全量执行工具"变为"per-question 推进管理器"（见 §autoresearch Skill 适配）；包括：内部管理 Wave 排序和 question 串行推进、ENVIRONMENT.md 增量更新（autoresearch bash 探测）、内部直接派遣 local-executor 和 verification subagent、管理 decision 和失败传播、Verification sub_phase 完全移除、执行结束时一次性写入 persistence/EXECUTION.md + persistence/VERIFICATION.md 汇总（不再在每个 cycle 追加写入）。分解架构见 §autoresearch SKILL.md 分解架构                                                                                                                                                                                                                                                                                                                                                     | **重大修改**                                           | `.aether/skills/autoresearch/SKILL.md` + `.aether/skills/autoresearch/references/`                                                                                                                                                                                                                                            |
| autoresearch 内部 verification 派遣架构变更：从 research-worker 中转改为直接派遣 verification subagent（general mode → research-verifier；physics mode → gpd-verifier + research-verifier），不再通过 research-worker 或 general subagent 中转                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| Verification Decision 判定规则：autoresearch 从 claims_verified/claims_failed + reasoning_verification 5 sub-fields 组合判定 question 状态（resolved/failed/retry_execution/paused_ask_user），不再使用 verification_digest status 字段（见 §Verification Decision 判定规则）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| verification_retries 独立计数机制：verification retry 使用 state.json.execution.verification_retries[Qn] 计数，与 execution cycle 的 current_cycle 完全独立，上限 3 次；verification retry 不消耗 execution cycle、不 backup Qn 文件；verification digest 解析失败分三类处理（见 §Verification digest 解析失败处理与 verification retry 计数）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| current_step 值域定义为 {execution, verification}（仅用于 session recovery 中断点标识，见 §state.json 更新方式）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| ENVIRONMENT.md 增量探测由 autoresearch 亲自用 bash 执行（而非委托 local-executor 或 verification worker），见 §ENVIRONMENT.md 共享与增量更新                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| Early abort 检查在每个 question decision 后执行（而非仅在 Wave 结束时），见 §autoresearch 内部推进逻辑 Step j                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| Qn_REASONING.md 新增产出（step-by-step derivation + dependency usage）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| Qn_EXECUTION.md 删除 Dependencies section（依赖信息只在 REASONING.md 中，避免双处维护不一致）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| Retry 备份机制（autoresearch 在 retry 前备份当前文件为 \_cycle[N] 后缀）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| persistence/EXECUTION.md + persistence/VERIFICATION.md 由 autoresearch worker 在 execution 无法继续推进时一次性写入（不再是每个 cycle 追加写入，而是执行结束时一次性汇总写入）；coordinator 仅在 autoresearch crash 兜底场景中从 state.json 写入（见 §Session Recovery）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| research-verification skill 新增 domain_mode=general 流程（标准 6 步 + per-question claim 筛选）；domain_mode=physics 不再由 research-verification 内部管理——改为 autoresearch 分别派遣 gpd-verifier + research-verifier 两个独立 subagent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 修改                                                   | `.aether/skills/research-verification/SKILL.md`                                                                                                                                                                                                                                                                               |
| research-verification skill Step 1 新增 per-question claim 筛选（只筛选 question=Qn 的 claims，不验证其他 question 的 claims）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 修改                                                   | `.aether/skills/research-verification/SKILL.md`                                                                                                                                                                                                                                                                               |
| gpd-verifier 从 coordinator 直接派遣改为 autoresearch 内部直接派遣（physics mode verification subagent）；`.aether/agent/gpd-verifier.md` 需修改以适配 per-question verification dispatch：prompt 应接受 question (Qn)、cycle (C)、claims 列表（仅 Qn 的 claims）参数，输出 Qn_VERIFICATION.md 到 notepads/[slug]/execution/（而非 persistence/VERIFICATION.md），digest 格式遵循 §Verification worker Prompt 模板（reasoning_verification 5 sub-fields + conclusion_summary + claims_verified/claims_failed，不含 status 字段）；phase_debate 等场景仍通过 research-worker + skill invocation 使用，保留 gpd-verifier 的现有 debate 场景调用方式不变                                                                                                                                                                                      | 修改                                                   | `.aether/agent/gpd-verifier.md` + `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                      |
| research-verifier 从 coordinator 直接派遣改为 autoresearch 内部直接派遣（general mode 和 physics mode verification subagent）；`.aether/agent/research-verifier.md` 需修改以适配 per-question verification dispatch：prompt 应接受 question (Qn)、cycle (C)、domain_mode (general)、claims 列表（仅 Qn 的 claims）、resolved_conclusions 注入参数，输出 Qn_VERIFICATION.md 到 notepads/[slug]/execution/（而非 persistence/VERIFICATION.md），digest 格式遵循 §Verification worker Prompt 模板（reasoning_verification 5 sub-fields + conclusion_summary + claims_verified/claims_failed，不含 status 字段）；domain_mode=general 时执行 research-verification skill 标准 6 步 Procedure + per-question claim 筛选；domain_mode=physics 时 autoresearch 分别派遣 gpd-verifier + research-verifier（见 §domain_mode=physics dispatch 流程） | 修改                                                   | `.aether/agent/research-verifier.md` + `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                 |
| Qn_VERIFICATION.md 新增 Reasoning Verification section（5 sub-fields 含 fallback_applicability）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 修改                                                   | `.aether/skills/research-verification/SKILL.md`                                                                                                                                                                                                                                                                               |
| verification_digest schema **删除 `status` 字段**（旧 autoresearch SKILL.md 行 272-285 的 `status: completed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | partial                                                | failed`字段删除——autoresearch 从`claims_verified/claims_failed`+`reasoning_verification` 5 sub-fields 组合判定 question 状态，见 §Verification Decision 判定规则；verification worker prompt 明确要求 "Do NOT include a 'status' field in the digest"）；新增 reasoning_verification (5 sub-fields) + conclusion_summary 字段 | 修改                               | `.aether/agent/research.md` + `.aether/skills/autoresearch/SKILL.md` |
| execution_cycle_digest schema 移除 attempt 字段（统一使用 cycle）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 修改                                                   | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |
| session recovery 增加 per-question 中断恢复逻辑（基于无后缀文件名检查 + current_step 值域 {execution, verification}）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 修改                                                   | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |
| research.md 删除 3-way verifier 路由和 per-question coordinator 推进逻辑，coordinator 只做一次 dispatch autoresearch + 处理 paused digest + 调用 advance_plan（persistence 汇总由 autoresearch 写入，coordinator 不负责格式化）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 修改                                                   | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |
| autoresearch 不再在每个 cycle 追加写入 persistence/EXECUTION.md 和 persistence/VERIFICATION.md（旧行为废止），改为在执行结束时一次性写入汇总（见 §输出文件结构 旧路径废止规则）。autoresearch 同时直接写入 persistence/ENVIRONMENT.md（bash 探测）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| Early abort 机制（每个 question decision 后检查是否仍有 pending question，无则终止）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 新增                                                   | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |
| 依赖数据权威源从 framing_reasoning.md 转移到 PLAN.md：PLAN.md Execution Plan Dependencies 字段从引用型改为自包含型（包含完整的 critical 标注、fallback path 描述、dependency description）；autoresearch 以 PLAN.md 为依赖数据首要来源，framing_reasoning.md 仅作为 fallback 参考；debate repair 必须同步更新 PLAN.md Dependencies 为自包含型（见 Layer 3.11 修改）                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **重大修改**                                           | `docs/agent-docs/layer-3.11-framing-reasoning-audit.md` + `.aether/skills/debate-repair/SKILL.md`                                                                                                                                                                                                                             |
| research-worker.md Phase Routing 表更新：新增 phase_execution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | execution_cycle → Invoke /autoresearch skill（方案 D） | 修改                                                                                                                                                                                                                                                                                                                          | `.aether/agent/research-worker.md` |
| autoresearch SKILL.md §Procedure — Verification 删除（verification 在 autoresearch 的 per-question 循环内部通过 dispatch research-verifier / gpd-verifier subagent 执行，不再有独立的 verification sub_phase）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| domain_mode 确定规则（coordinator 从 framing digest verification_approach 或 PLAN.md Claims derived_from 推导，注入 autoresearch dispatch prompt；见 §domain_mode 确定规则）；domain_mode 是一次性决策，所有 question 使用相同 domain_mode；domain_mode 决定 autoresearch 派遣哪个 verification subagent；autoresearch 不自行读取 framing digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| conclusion_summary 生命周期统一定义（见 §conclusion_summary 生命周期）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 新增                                                   | `.aether/skills/autoresearch/SKILL.md` + `.aether/agent/research.md`                                                                                                                                                                                                                                                          |
| state.json 更新方式混合方案（见 §state.json 更新方式）：phase 转换级用 MCP advance_plan，execution 内部级由 autoresearch worker agent 直接写入（只修改 execution 子对象，不触碰其他字段）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 新增                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| 更新 `research-agent-runtime-design.md` execution 流程图                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 修改                                                   | `docs/agent-docs/research-agent-runtime-design.md`                                                                                                                                                                                                                                                                            |
| framing PhaseResultDigest 新增 verification_approach 字段（值域 {physics, general}，与 Layer 3.12 domain_mode 对齐）；Layer 3.12 定义值域和推导规则，Layer 3.11 framing skill Step 11 输出需同步新增此字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 新增                                                   | `.aether/skills/research-question-framing/SKILL.md` + `.aether/agent/research.md`                                                                                                                                                                                                                                             |
| Fallback assumption 传递方式中 failure context 来源从 DIGESTS.md 改为 Qn_REASONING.md + Qn_EXECUTION.md（per-question digest 不写入 DIGESTS.md）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 修改                                                   | `.aether/skills/autoresearch/SKILL.md`                                                                                                                                                                                                                                                                                        |
| final_execution_digest failed_questions.failure_summary 来源从 DIGESTS.md 改为 Qn_REASONING.md + Qn_EXECUTION.md failure context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 修改                                                   | `.aether/agent/research.md`                                                                                                                                                                                                                                                                                                   |

| autoresearch SKILL.md 迁移策略：直接替换旧模式，不保留旧"全量执行"模式作为 fallback。旧 autoresearch Procedure（Step 1-10 全量执行 + Verification sub_phase）整体删除，替换为 per-question 推进管理器 Procedure（见 §autoresearch Skill 适配）。旧 verification sub_phase 的 routing wrapper 角色被 autoresearch 内部 per-question 循环取代。
| autoresearch SKILL.md 分解架构重构（见 §autoresearch SKILL.md 分解架构）：从单文件 787 行 SKILL.md 重构为核心流程文件（~213 行）+ 3 个 reference 文件（references/digest-schemas.md ~203 行 + references/worker-prompts.md ~302 行 + references/edge-cases.md ~178 行）。核心流程只保留 Procedure Step 1-5 每步骤意图声明和决策要点，具体模板/schema/判定表/jq 命令通过引用 reference 文件获取。所有 reference 文件在 `.aether/skills/autoresearch/references/` 目录下，自包含不依赖外部设计文档 | **重大修改** | `.aether/skills/autoresearch/SKILL.md` + `.aether/skills/autoresearch/references/` |

---

## 与 Layer 3.11 的实施依赖关系

| 依赖                                 | 来源                                                      | 说明                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLAN.md per-Wave Execution Plan      | PLAN.md §Execution Plan                                   | autoresearch 内部构造 local-executor prompt 依赖输入（method, tools, falsification test）                                                                                                                                             |
| PLAN.md Dependencies (自包含型)      | PLAN.md §Execution Plan Dependencies 字段                 | autoresearch 失败传播判断 blocked vs fallback + worker prompt 依赖输入 + fallback assumption 来源。Dependencies 字段为自包含型（包含完整的 critical 标注、fallback path 描述、dependency description），不再依赖 framing_reasoning.md |
| Question-Claim mapping               | PLAN.md §Claims (question 字段)                           | 验证只针对当前 question 的 claims                                                                                                                                                                                                     |
| tractability confidence              | PLAN.md §Claims (tractability 字段)                       | Wave 内 question 排序依据                                                                                                                                                                                                             |
| verification_approach                | framing PhaseResultDigest (verification_approach 字段)    | coordinator 确定并注入 domain_mode 的依据（见 §domain_mode 确定规则——coordinator 从 framing digest 读取此字段，映射为 domain_mode 注入 autoresearch dispatch prompt；autoresearch 不自行读取 framing digest）                         |
| framing_reasoning.md (fallback 参考) | framing_reasoning.md §各 Gap §Inter-Question Dependencies | 当 PLAN.md Dependencies 因 debate repair 遗漏而不完整时的 fallback 参考源。标注 `[debate_repair_modified]` 的 section 可能过时——autoresearch 使用时需比对 PLAN.md，仅补充 PLAN.md 缺失的 fallback path 描述                           |

> **排序来源统一规则**：见 §Wave 内 question 执行顺序。

> **依赖数据权威源规则**：见 §与 Layer 3.11 的实施依赖关系。

Layer 3.11 未完成时，Layer 3.12 无法运行（缺少依赖关系信息）。framing_reasoning.md 的 Dependency Graph、Execution Order、Inter-Question Dependencies 是 autoresearch worker 确定 Wave 列表、排序策略、失败传播的基础，缺失时 per-question 推进逻辑无法正确执行。

---

## 验收清单

1. phase_execution 由 autoresearch worker 内部管理 per-question 推进（方案 D），coordinator 只做一次 dispatch
2. Wave 内 question 按 tractability confidence 从高到低排序执行（见 §Wave 内 question 执行顺序）
3. state.json.execution 包含 current_wave, current_question, current_cycle, current_step (值域 {execution, verification}), verification_retries, question_status, resolved_conclusions；question_status 保留终态（failed/blocked 不清空，无独立的 failed_questions/blocked_questions 数组）；rollback 到更早 phase 时 execution 子对象整体清空
4. resolved_conclusions.conclusion_summary 由 verification subagent digest 返回，由 autoresearch worker 写入 state.json；权威源定义见 §conclusion_summary 生命周期
5. ENVIRONMENT.md 在 question 间共享与增量更新（autoresearch 亲自 bash 探测并写入，不委托 local-executor/verification worker）
6. autoresearch 内部管理每个 question 的完整循环：execution → verification → decision → 失败传播
7. execution (local-executor) 产出 Qn_REASONING.md + Qn_EXECUTION.md（当前版本，无版本后缀）
8. execution_cycle_digest schema 符合 §Digest Schema 权威定义（旧 schema 的 `tests_inconclusive`、`execution_summary`、`environment_strategy_used`、`gaps_reported`、`output_paths.environment` 字段删除；新增 `question` 和 `output_paths.reasoning`；`status` 值域从 4 值收缩为 3 值——删除 `inconclusive`；`tests_passed/tests_failed` scope 从全局收缩为 per-Qn；`output_paths.execution` 路径从 `persistence/` 变为 `notepads/`；`next_phase` 固定为 null）
9. Qn_REASONING.md 包含 Method Design Reference + Step-by-Step Derivation + Dependency Usage
10. reasoning step 包含 Intention + Method + Divergence + Assumption introduced
11. Divergence 声明：偏离 PLAN.md 方法时必须声明原因和影响
12. Assumption 声明：新假设不在 framing_reasoning.md 中时标注为 undeclared
13. Dependency Usage 标注：使用了哪个前置 question 的结论、用于什么、是否在结论范围内
14. Qn_EXECUTION.md 不包含 Dependencies section（理由见 §Qn_EXECUTION.md 结构）
15. Retry 时 autoresearch 备份当前文件为 \_cycle[N] 后缀，worker 写入新版本替换无后缀文件
16. verification 只针对当前 question 的 claims（从 PLAN.md Claims 中筛选 question=Qn）
17. verification subagent 由 autoresearch 内部直接派遣（general mode → research-verifier；physics mode → gpd-verifier + research-verifier），不再通过 research-worker 或 general subagent 中转
18. domain_mode 由 coordinator 从 framing digest verification_approach 或 PLAN.md Claims derived_from 确定，注入 autoresearch dispatch prompt（见 §domain_mode 确定规则）；domain_mode 是一次性决策，所有 question 使用相同 domain_mode；autoresearch 不自行读取 framing digest 判断 domain_mode
19. verification subagent 进行两部分验证：Reasoning Verification (5 sub-fields 含 fallback_applicability) + Conclusion Verification
20. Verification Decision 判定规则：autoresearch 从 claims + reasoning sub-fields 组合判定（不使用 verification_digest status），见 §Verification Decision 判定规则
21. fallback inapplicable → immediate pause, ask user, no retry
22. Qn fully verified → autoresearch worker 存 conclusion_summary 到 state.json.resolved_conclusions → Qn conclusion available for dependents
23. Qn 失败 (max retries) → autoresearch 读 PLAN.md §Execution Plan Dependencies（自包含型）→ propagate dependency impact
24. critical dependency → 后续 question 自动 blocked
25. non-critical + fallback → 后续 question 用 PLAN.md Dependencies 中的 fallback assumption 继续（failure context 来自 Qd_REASONING.md + Qd_EXECUTION.md）
26. 每个 question 最多 3 次 execution cycle；verification retry 最多 3 次（独立计数，见 §Verification digest 解析失败处理）
27. Early abort 检查在每个 question decision 后执行（而非仅在 Wave 结束时），见 §autoresearch 内部推进逻辑
28. persistence/EXECUTION.md + persistence/VERIFICATION.md 由 autoresearch 在执行结束时一次性写入（不再每个 cycle 追加写入）；coordinator 仅在 crash 兜底场景中从 state.json 写入
29. session recovery 可从任意 question 中断点恢复（基于 current_step {execution, verification} + 无后缀文件名检查）；coordinator 检查 persistence 汇缩文件是否已存在判断是否需要兜底写入
30. research.md 删除 3-way verifier 路由和 per-question coordinator 推进逻辑，coordinator 只做一次 dispatch autoresearch + 处理 paused digest + 调用 advance_plan
31. 输出文件命名正确（Qn_REASONING.md, Qn_EXECUTION.md, Qn_VERIFICATION.md, 备份为 \_cycle[N] 后缀）
32. tractability confidence 统一从 PLAN.md §Claims 的 tractability 字段读取（见 §Wave 内 question 执行顺序）
33. verification_digest 不包含 status 字段（autoresearch 从 claims + reasoning sub-fields 判定）
34. execution worker prompt retry 时注入 revision_needed（见 §Worker Prompt 模板 — Execution worker）
35. verification worker prompt 注入 resolved_conclusions 供 dependency usage check（见 §Worker Prompt 模板 — Verification worker）
36. autoresearch SKILL.md 分解架构正确：核心 SKILL.md ~213 行 + references/digest-schemas.md + references/worker-prompts.md + references/edge-cases.md，所有 reference 文件自包含不依赖外部设计文档，核心流程通过引用 reference 获取具体模板/schema/规则
