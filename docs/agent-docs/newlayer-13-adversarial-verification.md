# newlayer-13: autoresearch 对抗式增强验证

> 基于历史 execution 会话暴露的绕过问题，收紧 autoresearch 的叶子代理边界，
> 并把 research-verifier 从固定 checklist 检查者升级为对抗式增强审核者。

---

## 修改原因与设计依据

**大方向**：execution phase 不能由 `research-worker` 直接用 bash 和 write 工具完成全部计算、文档与结论，再只在最后交给 audit。每个 question 必须由 `local-executor` 和 `research-verifier` 两个隔离 context 分别承担执行与验证。verification 也不应停留在 framing 给出的固定细节标准上，而应在验证意图范围内主动增强具体检查。

**设计依据**：历史会话 `ses_0cc6db2e6ffeN3q3mGkKbLkp1r`（标题：`execution: 4-Wave 逐问题执行 (@research-worker subagent)`）显示现有 prompt 容易被 worker 解释为"可以务实绕过 leaf subagents"。该会话最终依赖 phase 末尾的 research-audit 才发现 FATAL 问题，说明 per-question verifier 的缺位是结构性风险。

**具体决策理由**：

- `local-executor` 是叶子执行者，用隔离 context 记录 Qn 的推理与执行结果；worker 直接执行会把 orchestration 和 execution 混成一层。local-executor 的隔离 context 也用于缓解长上下文占用问题——即使是纯理论/文献类 question 也需要独立 context 执行。
- `research-verifier` 是独立验证者，必须在每个 Qn 上出现；末尾 audit 只能审 phase 汇总，不能替代 per-question verification。
- framing 的 concrete checks 不可能一次完美；verifier 应在 Verification Intent 范围内持续生成高价值、非重复 challenge。
- prompt 应保持简洁，以"做什么与为什么"为主；不引入 maturity 等专用状态变量，Verdict 仍为 `PASS | FAIL | PARTIAL`。

---

## 1. 历史错误表现

### 会话证据

目标会话：`ses_0cc6db2e6ffeN3q3mGkKbLkp1r`

工具调用统计：

| tool      | count |
| --------- | ----- |
| bash      | 37    |
| edit      | 24    |
| write     | 18    |
| read      | 7     |
| todowrite | 4     |
| task      | 2     |
| skill     | 2     |
| grep      | 1     |

两次 `task` 调用都是 `research-audit`：

- `research-audit` — Audit execution phase artifacts
- `research-audit` — Re-audit execution after fixes

没有 `local-executor` 调用，也没有 `research-verifier` 调用。

### 具体绕过方式

worker 直接写入：

- `execution/Q_verify_EXECUTION.md`
- `execution/Q11_EXECUTION.md`
- `execution/Q_stop_EXECUTION.md`
- `execution/Q_viid_EXECUTION.md`
- `execution/Q10_EXECUTION.md`
- `execution/Q0_EXECUTION.md`
- `EXECUTION.md`
- `VERIFICATION.md`

但没有创建每题要求的：

- `execution/Qn_REASONING.md`
- `execution/Qn_VERIFICATION.md`

会话中 worker 明确推理：虽然 skill 要求 dispatch `local-executor` 和 `research-verifier`，但自己可以"务实"地直接用 bash 执行，再保留 audit/verification 结构。这导致原本用于隔离 execution 与 verification 的设计失效。

随后 worker 运行 `check_artifacts` 时也只检查了 `Qn_EXECUTION.md`、汇总文件和代码文件，未把 `Qn_REASONING.md` / `Qn_VERIFICATION.md` 作为 expected files。`research_state.md` 的 `ver` 字段也指向了 `Qn_EXECUTION.md`，而不是 `Qn_VERIFICATION.md`。

### 后果

phase 末尾的 `research-audit` 发现了 3 个 FATAL，说明：

- per-question verifier 缺位后，错误只能在最后阶段被发现。
- audit 被迫承担了本应由 verifier 逐题承担的职责。
- worker 可以先写结论，再让 audit 纠错，形成"先自证、后补救"的不良模式。

---

## 2. autoresearch 结构加固

### 目标文件

- `.aether/skills/autoresearch/SKILL.md`

### 核心修改

`autoresearch` 必须明确：worker 负责 orchestration，不负责替代 leaf execution 或 leaf verification。

每个 Qn 的最小结构是：

```text
research-worker dispatch local-executor
  -> local-executor writes Qn_REASONING.md + Qn_EXECUTION.md
research-worker checks files
research-worker dispatch research-verifier
  -> research-verifier writes Qn_VERIFICATION.md
research-worker reads Qn_VERIFICATION.md verdict
  -> decide retry / resolved / pause
```

### 简洁 prompt 建议

在 `autoresearch` 中加入类似如下原则：

```markdown
worker 是 execution phase 的编排者，不是每个 question 的 leaf executor 或 verifier。
每个需要处理的 Qn 都必须 dispatch local-executor 和 research-verifier。
直接 bash 运行、直接写 Qn 结论、或 phase 末尾 audit 都不能替代这两个 leaf subagent。
```

### dispatch 硬约束（新增）

在 `autoresearch` 的 `## 硬约束` 节增加：

```markdown
- MUST: 每个 Qn 的执行必须通过 dispatch local-executor 完成，验证必须通过 dispatch research-verifier 完成。不得用 bash 直接执行 Qn 的研究任务或直接写 Qn 结论。
```

> **不再要求 dispatch 记录**：原设计曾要求 worker 在 research_state.md 记录 dispatch 事实供 audit 核查。经评估删除——dispatch 记录可被 worker 伪造，边际防绕过价值低，却增加 state 写入与解析负担。真正咬合的结构性约束是 `ver` 字段必须指向 `Qn_VERIFICATION.md`（见 §7 check_verification.py 后缀校验）：worker 若跳过 verifier，则无法产出合法 ver 文件、无法标记 resolved。
>
> **权限层硬阻断不可行（已核实）**：曾考虑在 worker 的 `edit` 权限中对 `execution/Qn_*.md` 加 deny、仅允许 leaf subagent 写入。经核实不可行：(1) worker 的 `edit` 权限现为 `.aether/research/**: allow`，确可写 execution 文件；但即便加 edit deny，worker 的 `bash: allow` 不受 edit 路径规则约束（bash 按命令文本匹配 `permission: "bash"` 规则，`external_directory` 仅拦项目外路径，`echo/sed/tee/printf` 等不在拦截列表），可绕过 edit deny 直写文件；(2) `task` dispatch 用 `Permission.intersection(parent, child)`，leaf subagent 权限是 worker 的子集，任何加在 worker 上的 deny 会传播给 leaf，无法实现"deny worker / allow leaf"的不对称。故 procedural（prompt + 结构 checker + audit 语义）是当前架构下唯一可行层。若模型指令遵循能力不足以遵守，属模型能力限制，不在设计层面进一步兜底。

### 文件要求

每个 Qn 必须有：

- `execution/Qn_REASONING.md`
- `execution/Qn_EXECUTION.md`
- `execution/Qn_VERIFICATION.md`

`research_state.md` 中 resolved question 的 `ver` 字段必须指向：

```text
notepads/<slug>/execution/Qn_VERIFICATION.md
```

不得指向：

```text
notepads/<slug>/execution/Qn_EXECUTION.md
```

### worker 可直接做的事

worker 仍可直接做编排性操作：

- 读 PLAN / state / previous verification。
- 检查文件存在与非空。
- 更新 `research_state.md`（Questions/Claims status + `ver` 字段 + Failed Attempts）。
- 写 `EXECUTION.md` / `VERIFICATION.md` 汇总。
- 运行 deterministic checker。
- dispatch wave-end audit。

但这些不能替代每题的 leaf execution 与 leaf verification。

---

## 3. PLAN 验证标准分层

### 目标文件

- `.aether/skills/research-question-framing/SKILL.md`

### 修改内容

framing 阶段的验证标准从 contract 级 `### Acceptance Tests` 列表改为 **per-question** 字段，置于 PLAN.md Execution Plan 每个 Qn 块内。不同 question 有不同的验证意图与具体检验，contract 级列表不再合适。

每个 Qn 块新增三个字段：

```markdown
**Qn: [question title]**

- Method: [method]
- Tools: [packages]
- Verification Intent: [要验证什么类型的问题，以及为什么这些验证能支持或证伪 claim]
- Baseline Concrete Checks: [framing 给出的最低具体检验方式和通过标准]
- Enhanced Concrete Checks: [初始为空，供 verifier 在 execution 中追加]
- Dependencies: ...
- Output file: execution/Qn_EXECUTION.md
```

- 原 per-question 的 `Falsification test` 字段被 `Baseline Concrete Checks` 收编（高层 falsification 逻辑仍写入 `research_questions.md` 的 `Falsification_criterion`；PLAN 的 per-question 具体检验统一归 Baseline Concrete Checks，避免新增并列概念）。
- 删除 contract 级 `### Acceptance Tests` 节（其内容已分散到各 Qn 块的 Baseline Concrete Checks）。

> **framing 不写 Enhanced Concrete Checks 内容**：framing 无法预知 execution 中发现的具体问题，只留空占位。Enhanced 由 verifier 在 execution 中追加（见 §4）。

### 语义边界

- `Verification Intent` 是 per-question 的 high-level 契约。
- `Baseline Concrete Checks` 是 per-question 的最低要求。
- `Enhanced Concrete Checks` 是 per-question 的可追加字段（初始为空）。
- verifier 可增强具体检查，但不能静默改变 claim、Verification Intent、依赖关系或问题范围。
- 若发现 high-level 标准不足，应在 verification 中说明，让 worker/primary 判断是否暂停或回到上游 phase。

### verifier 对 PLAN.md 的写权限边界

autoresearch SKILL.md 保持 `FORBIDDEN: 修改 PLAN.md`（worker 自约束）。verifier 的写权限例外写在 **research-verifier.md**（agent 自身定义），不在 autoresearch 的 FORBIDDEN 条款中嵌套声明：

```markdown
（research-verifier.md）

### PLAN.md 写权限

verifier 只可向某 Qn 块的 `Enhanced Concrete Checks` 字段追加内容，不得修改 PLAN.md 的其他任何字段。
```

> **例外位置选择**：FORBIDDEN 条款是 worker 的自约束，不应嵌套对其他 agent 的授权。verifier 是独立 agent，其写权限由自身 agent 定义声明。worker 读 autoresearch 知道"自己不能改 PLAN.md"，verifier 读自身 agent 定义知道"自己可追加 Enhanced Concrete Checks"，两者各从自身定义获知权限边界，不存在交叉歧义。

verifier 向 Enhanced Concrete Checks 追加的内容必须是单调增强：增加、澄清或收紧。不能删除、降低或替换 baseline。

---

## 4. research-verifier 对抗式增强审核

### 目标文件

- `.aether/agent/research-verifier.md`

### 职责变化

`research-verifier` 不再只是检查 executor 是否满足 PLAN 中已有细节标准。它应围绕 Verification Intent 主动寻找能实质挑战 execution 结论的高价值检查。

保留现有 verdict：

```markdown
PASS | FAIL | PARTIAL
```

不新增 maturity / blocked 等专用状态变量。资源、工具、数据或人类裁决问题直接用自然语言写入 `PARTIAL` 的原因。

### challenge 定义

```markdown
challenge = 试图从不同角度推翻或削弱 execution 结论的验证尝试。
区别于 baseline check 的"确认执行做了该做的事"，challenge 旨在"证明执行结论可能是错的"。
非重复 = 不与已有 baseline / enhanced check 覆盖相同的验证角度。
高价值 = 若 challenge 成立，会实质影响 verdict。
```

### 简洁 prompt 建议

```markdown
验证不是固定 checklist。PLAN 的 Baseline Concrete Checks 是下界，不是上界。
verifier 应先确认 baseline 没有被跳过，再围绕 Verification Intent 主动提出高价值、非重复的 challenge。
若 challenge 推翻或削弱 execution 结论，写 FAIL/PARTIAL 并说明 executor 需要补什么。
若 challenge 持续通过，继续寻找新的高价值 challenge。
只有当 verifier 已尝试提出新 challenge 但确实无法提出新的、非重复的、高价值 challenge 时，才给出最终 PASS。
```

### Enhanced Checks 的持久化与提取（retry 语义）

verifier 一次性完成两步：

1. **所有 enhanced checks 写入 `Qn_VERIFICATION.md`** 的 Enhanced Checks + Challenge Log 节（完整记录，含 provenance：此 check 是否已提取到 PLAN.md 哪个 Qn 块）。
2. **verifier 判断每个 enhanced check 是否追加到 PLAN.md**，判据收敛为一条：

```markdown
- "此 check 是某 Qn（自身或其依赖者）executor 必须满足的执行条件？" → 是 → 追加到那个 Qn 块的 Enhanced Concrete Checks
- 否（仅本 Qn 特定执行细节、或无具体落点的方法论） → 留 Qn_VERIFICATION.md
```

> **PLAN.md 自封闭**：Enhanced Concrete Checks 是纯 check 内容（可执行条件句），不包含对 `Qn_VERIFICATION.md` 的指针、不含易失的 round 锚点。check 若需引用依赖结论，引用该 Qn 的 claim（PLAN 内稳定标识），不引用验证文件。原因：retry 时 `Qn_VERIFICATION.md` 会被备份为 `Qn_VERIFICATION_v<N>.md`（newlayer-12 历史保留规则），任何指向验证文件的引用都会指向被改名的文件。故 provenance（来自哪一轮、哪个 Qn 的验证）只留在 `Qn_VERIFICATION.md` 自身的 Enhanced Checks 节——该文件有自己的 `_v<N>` 备份链可追溯；PLAN.md 不承担 provenance。

> **由 verifier 完成提取，不由 worker 提取**——worker 不应做验证判断。verifier 有 PLAN.md 访问权，能看到依赖图，可判断 check 应落到哪个 Qn 块。

> **retry 语义**：retry 时 `Qn_VERIFICATION.md` 被覆写（丢失上一轮的 Qn 特定 check + provenance），但 PLAN.md 各 Qn 块的 Enhanced Concrete Checks 持久存在。新 verifier 以目标 Qn 块的 Baseline + Enhanced（含上一轮提取的跨问题 check）为起点，不会遗漏。Qn 特定 check 随覆写丢失是合理的——retry 已修复该问题。

> **过保守积累的缓解**：Enhanced Concrete Checks 按 per-question 落点（§3），适用性由"它属于哪个 Qn 块"自带，后续 verifier 无需跨问题标签判适用性，噪音有上限（每个 Qn 验证次数受时间预算约束）。

> **天然兜底**：即使 verifier 未将某 enhanced check 提取到 PLAN.md，worker 在处理依赖 question 时已读 `Qd_VERIFICATION.md`（autoresearch SKILL.md 依赖处理节），信息仍可达。提取到 PLAN.md 是"隐式可达 → 显式 baseline"的优化，不是关键路径。

---

## 5. Qn_VERIFICATION.md 结构

### 目标文件

- `.aether/agent/research-verifier.md`
- `.aether/skills/autoresearch/SKILL.md`

### 结构原则

Qn_VERIFICATION.md 采用嵌套结构，使"过程验证"与"结论验证"两层名实相符：

1. **Reasoning Verification**（保留现有 4 子项，不变）：检查"执行过程是否正确"——执行是否遵循方法、推理是否跳步、假设是否有效、依赖是否正确使用。
2. **Conclusion Verification**（容器节，含 Baseline/Enhanced/Challenge Log 子节）：检查"执行结论是否成立"——围绕 Verification Intent 做对抗式增强验证。

### 推荐完整结构

```markdown
# Qn Verification

## Verdict

PASS | FAIL | PARTIAL

## Verification Summary

[执行 TL;DR：verdict + 核心理由，供 worker/audit/primary 快速判断]

## Reasoning Verification

- method_fidelity: [PASS/FAIL + 理由] — 执行是否遵循 PLAN.md 指定的方法
- step_completeness: [PASS/FAIL + 理由] — 推理步骤是否完整（无跳步）
- assumption_audit: [PASS/FAIL + 理由] — 假设是否有效
- dependency_usage: [PASS/FAIL + 理由] — 是否正确使用了依赖的结果

## Conclusion Verification

[结合以下 Baseline / Enhanced / Challenge Log 综合判断 execution 结论是否由证据支持]

### Baseline Checks

[PLAN.md Baseline Concrete Checks 如何执行，结果如何]

### Enhanced Checks

[verifier 新增了哪些检验，为什么有价值，结果如何；每条注明是否已提取到 PLAN.md 哪个 Qn 块]

### Challenge Log

[verifier 尝试过的 challenge：挑战目标、类别、结果、对 verdict 的影响。含"尝试提出新 challenge 但无法提出"的判断过程]

## Evidence

[跨 check 的原始证据：计算结果 / 引用对照 / 复算 / 数值表 / 附件入口。各 check 子节内只放结论性结果句，原始数据归本节或附件]

## Remaining Concerns

[仍未解决/需上游处理的问题及原因]
```

### 设计要点

- **Verification Summary 保留**：作为顶层 TL;DR，与 `## Conclusion Verification` 容器开头的综合段分工——前者一语概之供快速决策，后者是结合子节的详细综合判断。
- **`## Conclusion Verification` 是容器**：含 `### Baseline Checks` / `### Enhanced Checks` / `### Challenge Log` 三个子节 + 开头综合段。旧版"单行结论是否由证据支持"被本容器开头的综合段替代，命名不再与旧单行冲突。
- **删除 `## Verification Intent` 节**：verifier 直接读 PLAN 获取 intent，不在验证文件转抄（避免两端不同步）。
- **`## Evidence` 顶层 + 各 check 子节内嵌结果句**：check 子节只放"结论性结果"（如 "SymPy 复算与 executor 一致"），原始数值/日志/脚本输出放 `## Evidence` 或附件。避免证据既在 Evidence 又散落在各 check。
- **`## Remaining Concerns` 顶层**：它是前瞻性"需上游处理"的开放问题，不属于"结论验证"本身，放顶层而非 Conclusion Verification 下。

重型日志、数值表、图像或脚本输出可放附件，主文件保持权威摘要入口。

### 单文件理由

- worker、audit、人类都只需读一个 `ver` 文件。
- 避免旧 round 文件被误读为最终结论（retry 覆写同一文件）。
- executor retry 能直接看到失败原因、增强检查与剩余 concern。
- `check_verification.py` 仍保持简单：只检查 `ver` 指向 `Qn_VERIFICATION.md`，且含 verdict（不再检查 Challenge Log 节，见 §7）。

---

## 6. 收敛原则

不使用复杂 harness 或专用状态变量。verifier 的停止原则（详见 §4 prompt 建议）：

```markdown
不要因为 baseline checks 通过就停止。
不要因为一次强 challenge 通过就停止。
必须先尝试提出新 challenge——只有当已尝试但确实无法提出新的、非重复的、高价值 challenge 时，才停止增强验证。
如果剩余疑点需要改变 claim、intent、依赖、范围或资源条件，应写明原因交给 autoresearch/primary 决策。
```

> "无法提出新 challenge"不是主观声称，而是"尝试了但提不出"的结果。Challenge Log 中应记录"尝试提出新 challenge 但无法提出"的判断过程，使 audit 可核查 verifier 是否真正尝试过。

---

## 7. checker 与 audit 加固

### 目标文件

- `.aether/skills/research-audit/SKILL.md`
- `.aether/skills/research-audit/scripts/check_artifacts.py`
- `.aether/skills/research-audit/scripts/check_verification.py`
- 新增 `.aether/skills/research-audit/scripts/check_qn_artifacts.py`
- `.aether/skills/autoresearch/SKILL.md`（per-wave audit scope 与响应）

### check_artifacts.py 保持通用模式

`check_artifacts.py` 是各 phase 共用的产物检查器（analysis 检 `analysis.md`、framing 检 `PLAN.md` 等、execution 检 Qn 文件），**不改为 Qn 驱动**。签名保持 `check_artifacts.py <research_state.md_path> <expected_file1> <expected_file2> ...`，逻辑不变。

### 新增 check_qn_artifacts.py（execution 专用）

当前 expected_files 由 worker 传入，worker 可选择性遗漏文件。新增 execution 专用 checker，Qn 驱动：

```text
用法: uv run check_qn_artifacts.py <research_state.md_path> <Qn1> <Qn2> ...
逻辑:
  1. 解析 research_state.md 的 Active Workdir
  2. 对每个 Qn: 拼接 <workdir>execution/Qn_REASONING.md, Qn_EXECUTION.md, Qn_VERIFICATION.md
  3. 验证每个文件存在 + 非空
  4. 验证 persistence/ 白名单 + workdir 边界（与 check_artifacts 一致）
输出 JSON:
  {"ok": bool, "missing": [...], "empty": [...], "outside_workdir": [...], "persistence_violations": [...]}
```

worker 传入 Qn 标识符（如 `Q0`、`Q_verify`），脚本自动拼接三个文件名。autoresearch 的文件验证节由 `check_artifacts` 改调 `check_qn_artifacts`；其他 phase 仍调 `check_artifacts`。

### check_verification.py 加固

```text
逻辑修改:
  1. 放宽 Qn 标识符正则: `-\s*(Q[\w]+):`（兼容 Q0 / Q_verify / Q_stop，原 `Q\d+` 会漏非数字 ID）
  2. 对每个 resolved claim: 验证 ver 路径以 _VERIFICATION.md 结尾（不得指向 _EXECUTION.md）
  3. 验证 ver 文件含 Verdict 节
```

> **不再由脚本检查"含 Challenge Log 节"**：Challenge Log 是 verifier 灵活产出的对抗验证记录，脚本硬探节标题既脆化又形式化。Challenge Log 的充分性交给 audit 语义审（见下）。

### audit 语义审计加固

`research-audit` SKILL.md §2 增加 execution 行的审计方向：

- 若 Qn 没有独立 verification 文件或 ver 指向 execution 文件，却被标为 resolved，应判为 FATAL。
- 检查 Qn_VERIFICATION.md 是否像**独立的对抗验证**而非 worker 自报：Challenge Log 应含至少一条**具体** challenge（挑战目标 + 结果），或一条**带理由**的"尝试提出新 challenge 但无法提出"。空泛一句"已尝试无法提出"判 CONCERN。
- 检查是否存在 worker 直接执行并跳过 leaf subagent 的迹象（如 Qn_VERIFICATION.md 推理口吻与 Qn_REASONING.md 雷同、缺乏独立复算/对照）。

### per-wave audit 的 scope 扩充与 autoresearch 响应

per-wave audit 原只查同 Wave 内跨问题一致性。现并入 per-question 内容判断——审本 Wave 各 `Qn_VERIFICATION.md` 是否像独立对抗验证（上述 Challenge Log 最低信号、是否 worker 自报），并在报告中**指明本 Wave 哪个 Qn 存在什么问题**，使 worker 能定向处理。

**为什么是 per-wave 而非 per-question**：Wave 内 question 互不依赖（拓扑排序的定义），伪造的 `Qn_VERIFICATION.md` 不影响同 Wave 兄弟，只影响下一 Wave 的依赖者；per-wave audit 在 Wave 末、下一 Wave 前运行，天然卡在传播路径上。故 per-wave 已能在伪造传播前拦截，且不丢失跨问题一致性（audit 相对 verifier 的独特价值），成本 W 远低于 per-question 的 N。research-verifier 本就是 per-question 对抗审核者，audit 不复制其逐 Qn 复核。

**autoresearch 响应**：worker 读 audit 报告，对被指出的 Qn 据问题性质判断后处理——验证质量问题（Challenge Log 缺失/疑似 worker 自报）则重跑该 Qn 的 verifier（必要时先重跑 local-executor）；跨问题一致性问题则自修或暂停问用户。处理完再进入下一 Wave。阻塞以自然语言写入 audit 报告与 research_state.md 的 Failed Attempts / Last Phase Result，由 worker 据问题内容决策，**不引入专用状态变量**（如 BLOCKED 标记）。

> 风格原则：audit 响应是 orchestration 判断而非查表。给 agent"读到哪个 Qn 有什么问题→据问题性质决定重跑/自修/暂停"的逻辑链即可，不规定精确到文件/行的操作、不列举禁用动作、不设"条件→必须动作"的硬规则，以维持 agent 灵活性。

### 与历史设计文档的不一致（注明，不修改历史文档）

> **I3**：newlayer-8 定义 check_verification.py 职责为"验证 Qn_VERIFICATION.md 非空 + 含 verdict 即可"。本文档增加 ver 路径指向检查 + 正则放宽（不再增加 Challenge Log 节脚本检查）。以本文档为准。
>
> **I4**：newlayer-6 设计文档 line 160 定义 check_artifacts 验证 `Qn_REASONING.md + Qn_EXECUTION.md`（不含 Qn_VERIFICATION.md），而当前已实现的 autoresearch SKILL.md 已改为验证三个文件。本文档延续实现版做法（三文件），以本文档为准，但三文件检查由新增的 `check_qn_artifacts.py` 承担，`check_artifacts.py` 回归通用产物检查器（各 phase 共用）。三者职责区分：`check_artifacts`（通用产物存在性，各 phase）、`check_qn_artifacts`（execution 三文件 Qn 驱动）、`check_verification`（state 级 ver 指向 + verdict）。

---

## 8. local-executor 适应性

### 目标文件

- `.aether/agent/local-executor.md`

> §8 含一项主题内修改（`theoretical` 执行方式，支撑 §2"所有 Qn 必走 local-executor"）、一项 front matter 描述同步、与一项顺带格式修复（剥离 `<system-reminder>` 标签）。

### 适应非计算类 question

local-executor 的核心目标是**在不同 Qn 之间实现上下文隔离**，缓解长上下文占用问题。因此即使是纯理论/文献类 question 也需要 dispatch local-executor，而非由 worker 直接处理。

当前 local-executor.md 的描述偏向需要程序环境的计算问题（`uv_venv` / `local` / `local_compile` 执行方式）。需补充对纯理论/文献类 question 的适应：

- **front matter `description` 字段**：当前为"执行单个 question [Qn] 的研究任务（计算/编译/运行），产出推理与结果"，括注不覆盖理论类。更新为"（计算/编译/运行/理论推导）"。
- **执行方式节**：新增 `theoretical` 执行方式（见下）。

```markdown
## 执行方式

据 ENVIRONMENT.md 和 PLAN.md method 选择：

- uv_venv: 用 .aether/research/.venv/bin/python 或 uv run 执行
- local: 用 host 已装软件（如 wolframscript）直接执行
- local_compile: 用 PLAN.md 指定的 build_command 编译，产出在 .aether/research/ 内
- theoretical: 纯理论推导/文献查证类 question，无需计算环境。agent 在隔离 context 中完成推理与查证，产出 Qn_REASONING.md + Qn_EXECUTION.md
```

### REASONING 与 EXECUTION 的区分

```markdown
- Qn_REASONING.md: agent 的详细思考推理过程，包括正确的尝试与错误的尝试、被排除的方向等。是"过程记录"。
- Qn_EXECUTION.md: 最终结果，只记录最后的理论推导/计算结果/查证结论等。是"结果记录"。
```

### 剥离 system-reminder 标签

当前 local-executor.md 的全部业务指令被包裹在 `<system-reminder>` 标签内（line 23-80）。经核实：

- 框架（`config.ts` loadAgent）将 front matter 后的全部内容作为 `prompt` 直接注入 system prompt，不剥离 `<system-reminder>` 标签。
- `<system-reminder>` 作为纯文本出现在 system prompt 中，不影响功能加载，但在语义上可能被模型理解为"提醒"而非"主要指令"（system prompt 中定义了该标签为"NOT part of the user's provided input"）。
- 同系统中 research-verifier / research-audit / debate-critic / debate-rebuttal 均不使用此标签，格式不一致。

修改时剥离 `<system-reminder>` / `</system-reminder>` 标签，使内容直接作为 agent 指令。（research-worker.md 和 research-explorer.md 也有同样问题，不在本文档修改范围内，但建议后续统一处理。）

---

## 9. 文件级修改清单

### `.aether/skills/autoresearch/SKILL.md`

- 明确 worker 是编排者，不是 leaf executor/verifier。
- 每个 Qn 必须 dispatch `local-executor` 与 `research-verifier`。
- 硬约束新增：dispatch 必须通过 leaf subagent，不得 bash 直写 Qn 结论（**不要求 dispatch 记录写入 research_state.md**）。
- 每个 Qn 必须产出 `Qn_REASONING.md`、`Qn_EXECUTION.md`、`Qn_VERIFICATION.md`。
- `ver` 字段必须指向 `Qn_VERIFICATION.md`。
- phase 末尾 audit 不替代 per-question verifier。
- 文件验证节由 `check_artifacts` 改调 `check_qn_artifacts`（execution 专用）；其他 phase 仍调 `check_artifacts`。
- **术语同步**：将"按 PLAN.md 中的 Acceptance Tests 验证"更新为"按 per-question 的 Verification Intent + Baseline Concrete Checks 验证"。
- **FORBIDDEN 修改 PLAN.md 保持 worker 自约束**：不含 verifier 例外（verifier 写权限由 research-verifier.md 自身声明，详见 §3）。
- **Qn_VERIFICATION.md 结构更新**：line 81 "含 verdict + evidence + 4 子项判定"更新为引用 §5 完整嵌套结构。
- **per-wave audit scope 与响应**：每 Wave 后 audit 并入 per-question 内容判断（Qn_VERIFICATION.md 对抗真实性 + Challenge Log 信号），audit 报告指明哪个 Qn 有什么问题；worker 据问题性质决定重跑该 Qn verifier / 自修 / 暂停，处理完再进下一 Wave。不引入专用状态变量（详见 §7）。

### `.aether/agent/local-executor.md`

- 保持叶子执行者定位，不 dispatch 进一步 subagent。
- front matter `description` 更新括注为"（计算/编译/运行/理论推导）"，覆盖理论类 question。
- 补充 `theoretical` 执行方式，适应纯理论/文献类 question（支撑 §2"所有 Qn 必走 local-executor"）。
- 明确 Qn_REASONING.md（过程）与 Qn_EXECUTION.md（结果）的区分。
- 剥离 `<system-reminder>` 标签（顺带格式一致性修复）。
- 强调产出 Qn reasoning + execution，不能替代 verifier。

### `.aether/agent/research-verifier.md`

- 改为对抗式增强审核者。
- 保留 `PASS | FAIL | PARTIAL`。
- 保留 `## Reasoning Verification`（4 子项）；`## Conclusion Verification` 改为容器节，含 `### Baseline Checks` / `### Enhanced Checks` / `### Challenge Log` 子节 + 开头综合段（详见 §5）。
- 顶层保留 `## Verdict` / `## Verification Summary` / `## Evidence` / `## Remaining Concerns`；删除 `## Verification Intent` 节（直接读 PLAN，不转抄）。
- 增加 challenge 定义（详见 §4）。
- 增加 challenge generation 收敛原则：必须先尝试提出新 challenge（详见 §6）。
- 增加 enhanced checks 持久化与提取规则：全部写入 Qn_VERIFICATION.md（含 provenance），跨问题 check 追加到 PLAN.md 对应 Qn 块的 Enhanced Concrete Checks（PLAN.md 自封闭，不反向引用 Qn_VERIFICATION.md，详见 §4）。
- **明确 PLAN.md 写权限边界（例外声明位置）**：在 research-verifier.md 自身声明"只可向某 Qn 块的 Enhanced Concrete Checks 字段追加，不得修改其他任何字段"。不在 autoresearch FORBIDDEN 条款中嵌套此例外（详见 §3）。

### `.aether/skills/research-question-framing/SKILL.md`

- 删除 contract 级 `### Acceptance Tests` 节。
- 每个 Qn 块新增 per-question 字段：`Verification Intent` / `Baseline Concrete Checks` / `Enhanced Concrete Checks`（初始为空占位）。
- 原 per-question `Falsification test` 字段被 `Baseline Concrete Checks` 收编。

### `.aether/skills/research-audit/SKILL.md` 与 scripts

- **新增 `check_qn_artifacts.py`**：Qn 驱动，拼 `execution/<Qn>_REASONING/EXECUTION/VERIFICATION.md` 三文件存在非空（详见 §7）。
- **`check_artifacts.py` 保持通用模式**：各 phase 共用，签名与逻辑不变（详见 §7）。
- `check_verification.py` 加固：放宽正则为 `Q[\w]+` + ver 路径以 `_VERIFICATION.md` 结尾 + 含 Verdict（**不再检查 Challenge Log 节**，详见 §7）。
- §1 runbook 与 §3 路径约定同步：execution 质量门改调 `check_qn_artifacts`，其他 phase 仍调 `check_artifacts`。
- §2 execution 行审计方向：ver 指向 FATAL 检查、Challenge Log 最低可审计信号（具体 challenge 或带理由的"无法提出"）、worker 跳过 leaf subagent 迹象检查。**不再检查 dispatch 记录**。
- per-wave audit 报告需指明本 Wave 哪个 Qn 存在什么问题（供 autoresearch 定向响应，详见 §7）。

---

## 验收目标

### 结构与 dispatch

- [ ] 每个 Qn 都由 `local-executor` 和 `research-verifier` 分别处理。
- [ ] autoresearch 硬约束含"必须通过 dispatch leaf subagent 执行/验证"一条（**不要求 dispatch 记录写入 research_state.md**）。
- [ ] 每个 Qn 都有 `Qn_REASONING.md`、`Qn_EXECUTION.md`、`Qn_VERIFICATION.md`。
- [ ] `research_state.md` 中 resolved question 的 `ver` 指向 `Qn_VERIFICATION.md`。
- [ ] worker 不能用直接 bash 执行 + 最后 audit 替代 leaf subagents。

### verifier 对抗式增强

- [ ] `research-verifier` 会执行 baseline checks，并主动尝试提出 enhanced checks / challenge。
- [ ] Challenge Log 记录 verifier 尝试提出新 challenge 的过程（含最低可审计信号：至少一条具体 challenge 或一条带理由的"无法提出"）。
- [ ] verifier 不静默修改 high-level Verification Intent、claim、dependencies 或 scope。
- [ ] verifier 只可向 PLAN.md 某 Qn 块的 `Enhanced Concrete Checks` 字段追加，不得修改其他任何字段。
- [ ] enhanced checks 全部写入 Qn_VERIFICATION.md；跨问题 check 追加到 PLAN.md 对应 Qn 块。
- [ ] PLAN.md 的 Enhanced Concrete Checks 自封闭（纯 check 内容，不反向引用 Qn_VERIFICATION.md，不含易失 round 锚）。
- [ ] Verdict 保持 `PASS | FAIL | PARTIAL`，不新增 maturity 状态。

### Qn_VERIFICATION.md 结构

- [ ] `## Reasoning Verification`（4 子项）保留不变。
- [ ] `## Conclusion Verification` 为容器节，含 `### Baseline Checks` / `### Enhanced Checks` / `### Challenge Log` 子节 + 开头综合段。
- [ ] 顶层保留 `## Verdict` / `## Verification Summary` / `## Evidence` / `## Remaining Concerns`；不设 `## Verification Intent` 节。
- [ ] `Remaining Concerns` 在顶层，不在 `## Conclusion Verification` 下。
- [ ] `Qn_VERIFICATION.md` 是唯一权威验证入口。

### checker 与 audit

- [ ] 新增 `check_qn_artifacts.py` 接收 Qn 标识符，自动拼接三个文件名。
- [ ] `check_artifacts.py` 保持通用 expected_files 模式（各 phase 共用）。
- [ ] `check_verification.py` 放宽正则 `Q[\w]+` + 验证 ver 路径以 `_VERIFICATION.md` 结尾 + 含 Verdict（不检查 Challenge Log 节）。
- [ ] checker/audit 能把缺失 per-question verification 或 ver 指向 execution 文件判为 FATAL。
- [ ] audit 检查 Challenge Log 最低可审计信号（语义层，非脚本）。
- [ ] per-wave audit 并入 per-question 对抗真实性判断，并在报告中指明哪个 Qn 有什么问题。
- [ ] autoresearch 据 audit 指出的问题重跑对应 Qn 的 verifier / 自修 / 暂停，不引入专用状态变量。

### 术语与一致性

- [ ] autoresearch SKILL.md 中 "Acceptance Tests" 引用更新为 per-question 的 "Verification Intent + Baseline Concrete Checks"。
- [ ] framing SKILL.md 删除 contract 级 `### Acceptance Tests`，改为 per-question 字段（Enhanced 初始为空占位）。
- [ ] research-verifier.md 明确 PLAN.md 写权限：只可向某 Qn 块的 Enhanced Concrete Checks 字段追加（per-question）。autoresearch FORBIDDEN 修改 PLAN.md 保持 worker 自约束，不嵌套 verifier 授权。

### local-executor 适应性

- [ ] local-executor.md 含 `theoretical` 执行方式。
- [ ] local-executor.md front matter `description` 括注含理论推导（覆盖非计算类）。
- [ ] local-executor.md 明确 REASONING（过程）与 EXECUTION（结果）区分。
- [ ] local-executor.md 剥离 `<system-reminder>` 标签。
