# newlayer-1: 文件管理 / 状态文件 / slug / worker 回传机制

> 删除冗余文件、删除 research-state MCP（server.py 整体移除）、状态文件迁移到单一
> research_state.md、slug 机制、worker 回传 status 信号替代 digest、文件布局规范。
> 对应设计文档 §3（状态模型）、§3.6（slug）、§7.3（结构 checker）。

---

## 修改原因与设计依据

**大方向**：旧设计有五重叠加状态存储（STATE.md/state.json/DIGESTS.md/git/phase_commits）+ 专门的对账逻辑 + advance_plan/phase_rollback 等 mutating MCP + 8 个 read-only MCP tools，这些是 FSM 抽象的产物。新设计中 agent 直接读写 research_state.md、checker 脚本做确定性验证、health-check skill 自包含——server.py 的所有功能都有更好的替代方案，整体删除。

**设计依据**：design doc §3（状态模型）、§3.4（删除冗余含 ROADMAP 取消原因）、§3.6（slug 机制）、§7.3（结构 checker）、§13 决策 3/7/8/10/12。

**具体决策理由**：

- 删 advance_plan/phase_rollback：phase 推进改为 agent 直接更新 research_state.md + git commit，回退改为重入目标 phase（design doc §3.5, §4.4）
- 删 ROADMAP.md：内容被 research_state.md/landscape_map.md/PLAN.md 瓜分，Phase Breakdown 是固定默认序无需每项目定制（design doc §3.4）
- slug 不用确定性脚本：命名不是可靠性瓶颈，路径拼接才是，由 Active Workdir 记录 + check_artifacts.py 兜底解决（design doc §3.6.1）
- 删 server.py 整体（含全部 8 个 read-only tools）：见 §2 逐个分析
- 删 PhaseResultDigest / phase_result：worker 回传 status 信号 + research_state.md 的 Last Phase Result 节替代，单一信息来源无不一致风险（见 §5）

---

## 1. 删除的文件

| 文件                                                   | 行数 | 理由                                            |
| ------------------------------------------------------ | ---- | ----------------------------------------------- |
| skills/research-coordinator/SKILL.md                   | 541  | phase FSM 由 research.md phase 选择器替代       |
| skills/research-coordinator/references/\*.md（3 refs） | 1110 | 同上                                            |
| skills/research-coordinator/scripts/backup_repair.sh   | 68   | 同上                                            |
| agent/judgment-worker.md                               | 161  | verifier 即 judge，不再有独立 failure-synthesis |
| skills/research-audit-reasoning/SKILL.md               | 277  | 合并进 research-audit                           |
| skills/research-audit-repair/SKILL.md                  | 142  | 同上                                            |
| skills/research-audit-repair-reasoning/SKILL.md        | 178  | 同上                                            |
| skills/debate-adjudicator/SKILL.md                     | 147  | worker 自做 adjudication                        |
| skills/debate-repair/SKILL.md                          | 313  | worker 自做 repair                              |
| mcp/research-state/server.py                           | 1833 | 全部功能有替代方案，见 §2                       |
| mcp/research-conventions/server.py                     | 484  | 全部功能有替代方案，见 §2b                      |

合计删除 ~5254 行。

---

## 2. server.py 整体删除

> 文件：`.aether/mcp/research-state/server.py`（1833行）+ mcp/research-state/ 目录整体删除

### 2.1 mutating tools（5 个）

| tool                      | 理由                                                |
| ------------------------- | --------------------------------------------------- |
| `advance_plan`            | phase 推进由 primary agent 直接写 research_state.md |
| `phase_rollback`          | 回退用 git log + checkout 或重入目标 phase          |
| `update_debate_state`     | debate 状态由 worker 写 DEBATE.md                   |
| `update_audit_state`      | audit 状态由 worker 写 audit 报告                   |
| `_tighten_tool_contracts` | 内部辅助函数，mutating tools 删除后无用             |

### 2.2 read-only tools（8 个）——全部删除，替代方案如下

| tool                      | 替代方案                                         | 理由                                                              |
| ------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| `get_state`               | agent 直接读 research_state.md（markdown）       | LLM 解析 markdown 是其强项；MCP 解析为 JSON 反而多一层            |
| `validate_state`          | check_artifacts.py 验证文件存在非空 + 字段完整性 | checker 脚本覆盖，无需 MCP                                        |
| `get_progress`            | primary 读 research_state.md 后自行派生          | Phase History + Questions 已含进度信息，无需 MCP 代算             |
| `check_file_updated`      | worker 直接读文件确认内容写入                    | 旧 coordinator 不能读文件才需 mtime 间接判断；worker 可直接读文件 |
| `validate_file_locations` | check_artifacts.py 验证文件在 Active Workdir 内  | checker 脚本覆盖 workdir 路径校验                                 |
| `get_phase_info`          | primary 读 Phase History 最后一行即知当前 phase  | 无需 MCP                                                          |
| `get_config`              | 不需要                                           | 新流程无任何环节需读项目配置（agent 配置在 front matter）         |
| `run_health_check`        | 迁移到 health-check skill scripts/               | 确定性检查代码适合脚本，skill 自包含不依赖 MCP                    |

### 2.3 run_health_check 迁移

run_health_check 的四层检查逻辑（infrastructure/persistence/skill_chain/runtime，约 400 行 Python）迁移到 `health-check skill/scripts/run_health_check.py`。迁移时更新：

- \_check_persistence：改为检查 research_state.md 存在性 + 格式（不再检查 state.json/STATE.md）
- \_check_skill_chain：删除 judgment-worker / research-audit-reasoning / research-audit-repair\* / debate-adjudicator / debate-repair 检查；新增 research-audit/scripts/ 下四个 checker 脚本检查 + debate-rebuttal 检查
- \_check_runtime：删除 advance_plan round-trip + phase_rollback registration 测试；保留 SymPy dry-run + paper-search 测试

health-check skill 从"调用 MCP tool"变为"自包含脚本"，不依赖 research-state MCP。

### 2.4 MCP 注册删除

research.md 和 research-worker.md 等 agent 的 front matter 中 `mcp: research-state: true` 和 `mcp: research-conventions: true` 均需删除（两个 MCP 都不再存在）。

---

## 2b. research-conventions MCP 整体删除

> 文件：`.aether/mcp/research-conventions/server.py`（484行）+ mcp/research-conventions/ 目录整体删除

### 删除理由

与 research-state MCP 同理——所有功能有更好替代方案，且硬编码了物理 domain 知识（19 个物理约定键、合法值、跨字段规则），不应在通用 MCP 中。

### 7 个 tools 的替代方案

| tool                         | 替代方案                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| `convention_lock_status`     | agent 直接读 research_state.md 的 ## Conventions 节                    |
| `convention_set`             | agent 直接写 research_state.md 的 ## Conventions 节                    |
| `convention_check`           | research-audit skill 的 check_conventions.py 脚本（确定性 regex 检查） |
| `convention_validate`        | check_conventions.py 脚本（完整性 + 跨字段一致性检查）                 |
| `assert_convention_validate` | check_conventions.py 脚本（ASSERT_CONVENTION 行验证）                  |
| `subfield_defaults`          | agent 直接读 gpd-conventions/references/convention_defaults.json       |
| `skill_resolve_path`         | 删除（agent 用 glob/read 找 skill）                                    |

### 迁移方案

**convention 值存储** → research_state.md 新增 `## Conventions` 节。convention 是通用概念（不限于物理），存储在通用状态文件中。agent 直接读写。

**ASSERT_CONVENTION 检查 + 完整性验证 + 跨字段一致性** → research-audit skill 的 `scripts/check_conventions.py`。确定性脚本，与 check_sources/check_verification/check_artifacts 同类。check_conventions.py 逻辑：

- 读 research_state.md 的 ## Conventions 节获取当前约定值
- 扫描产物文件中的 `<!-- ASSERT_CONVENTION: key=value -->` 行，验证与当前约定一致
- 检查完整性（critical 约定是否已设）
- 跨字段一致性检查（从 gpd-conventions skill 的 reference 文件加载规则）

**CONVENTION_OPTIONS + CROSS_FIELD_WARNINGS** → gpd-conventions skill 的 reference JSON 文件（如 `convention_options.json` + `cross_field_rules.json`）。check_conventions.py 从 skill reference 加载，不硬编码。其他 domain 可新增自己的约定 skill + reference 文件。

**convention_defaults** → 已在 gpd-conventions/references/convention_defaults.json（保留不变）。

**skill_resolve_path** → 删除。agent 用 glob 工具找 skill。

---

## 3. 状态文件

### 3.1 删除的冗余状态文件

| 文件                   | 理由                                                  |
| ---------------------- | ----------------------------------------------------- |
| persistence/state.json | 合并到 research_state.md                              |
| persistence/STATE.md   | 同上                                                  |
| persistence/DIGESTS.md | 不再有 digest；Last Phase Result 在 research_state.md |
| persistence/ROADMAP.md | gap/方向信息并入 analysis.md + research_state.md      |

### 3.2 research_state.md（单一状态来源）

```markdown
# Research State

## Active Workdir

notepads/<slug>/

## Workdir History

- notepads/<slug>/ ([date], 目标: [简述])

## Research Goal

[研究目标。可被人类修改/推翻/扩展。]

## Current Understanding

[已确认正确(带证据) + 已验证为错(带失败原因) + 不确定性]

## Questions / Claims

- Q1: [问题] — status: resolved (ver: <workdir>execution/Q1_VERIFICATION.md, srcs: [src:a])
  method: [方法] dependencies: [] notes: [关键发现]
- Q2: [问题] — status: partial (ver: <workdir>execution/Q2_VERIFICATION.md) dependencies: [Q1] notes: [...]

## Dependency Graph

Q1 → Q2 → Q3

## Failed Attempts

[验证为错的方法(防止重试)]

## Phase History

- analysis ✓ (commit abc123) — 产出 <workdir>analysis.md
- landscape ✓ (commit def456) — 产出 <workdir>landscape_map.md
- framing ✓ (commit ghi789) — 产出 <workdir>PLAN.md, <workdir>research_questions.md
- debate ✓ (commit jkl012) — 产出 <workdir>DEBATE.md
- execution [in progress] — Q1✓ Q2(partial) Q3(open)

## Last Phase Result

- phase: execution
- status: needs_attention
- summary: "Q2 critical dep failed, awaiting human decision"
- issues: ["Q2: critical dependency Q1 failed without fallback"]

## Human Directives

- [pending] 优先做 Q3, 完成后暂停等我审核
- [processed×] (已执行, 保留可追溯)

## Open Decisions

- [ ] Q2 partial 是否可接受?

## Conventions

[研究约定值（如物理: natural_units=natural, metric_signature=mostly-minus, ...）。
非物理 domain 可为空或填该 domain 的约定。
由 agent 在工作过程中灵活写入（任何 phase 发现需要约定时均可设置），agent 直接读写。
check_conventions.py 验证一致性与完整性，但不限定哪个 phase 可以写。]

## Next To Handle

[当前要做的事/刚收到的人类指示待办]
```

**Last Phase Result 节说明**：worker 完成 phase 后将执行结果写入此节（phase/status/summary/issues）。primary agent 每 turn 开头读 research_state.md 时，从此节获取 worker 的最近汇报。此节是 worker→primary 的信息传递通道，替代旧的 phase_result digest。git 历史保留每次 commit 时的完整状态（含 Last Phase Result），即完整审计轨。

### 3.3 literatures/ + registry.json

跨阶段共享的下载文献目录（`.aether/research/literatures/`，路径不变）。download_paper.py 下载成功后写 registry.json：

```json
{
  "entries": [
    {
      "id": "2305.12345",
      "type": "arxiv",
      "title": "...",
      "authors": ["..."],
      "year": 2023,
      "file": "2305.12345.pdf",
      "downloaded_at": "ISO8601"
    }
  ]
}
```

check_sources.py 据此验证引用 → 下载文件映射，实现 anti-fabrication 闭环。

### 3.4 persistence/ENVIRONMENT.md

跨阶段共享的环境探测记录。记录主机可用软件、Python 版本、隔离策略等。跨阶段共享避免重复探测，后续阶段可增量更新（追加新发现的环境依赖）。

---

## 4. slug 机制

### 设计

research_state.md 含 Active Workdir + Workdir History 两个字段，agent 自主管理路径：

- agent 创建新阶段时：从 Research Goal 派生 slug 名（关键词连字符化，≤30 字符）
- 读 Workdir History 防冲突，冲突则追加 -2 / -3
- 创建 notepads/<slug>/ 目录
- 更新 research_state.md 的 Active Workdir + Workdir History
- 旧 slug 目录保留不删

### 路径可靠性兜底

check_artifacts.py（research-audit skill）强制验证：所有 phase 产出文件必须在 Active Workdir 路径内。路径 = Active Workdir 完整路径 + 文件名拼接，agent 读取后使用，不自行拼凑。

---

## 5. worker 回传机制（替代 digest）

### 旧设计

旧 PhaseResultDigest 为复杂 YAML，每 phase schema 不同，含 next_phase/sub_phase/round/cycle/status/outputs/多类型计数器。后简化为 phase_result（5 字段）。worker 回传 phase_result 作为最后一条消息。

### 新设计

**worker 回传 status 信号 + 写入 research_state.md 的 Last Phase Result 节。**

worker 完成 phase 后：

1. 更新 research_state.md 的 Phase History + Questions/Claims + Failed Attempts 等
2. 在 research_state.md 的 **Last Phase Result** 节写入：phase / status / summary / issues
3. 回传消息仅含 **status 信号**：`completed` / `needs_attention`

primary agent 每 turn 开头读 research_state.md（为 phase 选择器），从 Last Phase Result 节获取 worker 的最近汇报详情。

### 为何替代 digest

- **单一信息来源**：所有状态（含 worker 汇报）在 research_state.md，无 digest 与 state 的潜在不一致
- **减少接口复杂度**：worker→primary 从 5 字段 YAML 降到 1 词信号
- **无冗余存储**：git 历史保留每次 commit 的完整 research_state.md（含 Last Phase Result），即完整审计轨，无需额外 digest 文件
- **primary 本来就读 state**：phase 选择器每 turn 读 research_state.md，Last Phase Result 在其中，无额外读取开销

### 影响

research-worker.md 的 "LAST message MUST be single YAML with phase_result" 规则改为 "LAST message MUST be a single word: completed | needs_attention"。Last Phase Result 节由 worker 在返回前写入 research_state.md。具体修改见 newlayer-10。

---

## 6. 文件布局

```
.aether/research/
├── persistence/              # 跨阶段共享
│   ├── research_state.md     # 单一状态来源（含 Last Phase Result）
│   └── ENVIRONMENT.md        # 主机环境探测（跨阶段共享）
├── literatures/              # 文献下载（跨阶段共享，路径不变）
│   ├── registry.json         # 下载索引（download_paper.py 写入）
│   └── *.pdf                 # 下载的文献
└── notepads/<slug>/          # 当前阶段所有产出
    ├── analysis.md
    ├── landscape_map.md
    ├── PLAN.md
    ├── research_questions.md
    ├── framing_reasoning.md
    ├── DEBATE.md
    ├── EXECUTION.md            # phase 汇总（workdir 根目录）
    ├── VERIFICATION.md         # phase 汇总（workdir 根目录）
    ├── execution/
    │   ├── Qn_REASONING.md     # per-question 推理
    │   ├── Qn_EXECUTION.md     # per-question 执行结果
    │   └── Qn_VERIFICATION.md  # per-question 验证报告
    └── audits/               # audit 报告（与产物在一起）
```

**布局原则**：

- `persistence/` 放跨阶段共享的状态：research_state.md（理解累积）、ENVIRONMENT.md（机器环境）
- `literatures/` 放跨阶段共享的文献下载（路径不变，新增 registry.json 索引）
- `notepads/<slug>/` 放该阶段独有的产出：各 phase 工作文件 + audit 报告
- audit 报告放 notepads/<slug>/audits/——审计针对特定阶段产物，与产物在一起

---

## 预期结果

- 删除文件 ~5254 行（含 research-state server.py 1833 行 + research-conventions server.py 484 行）
- research-state MCP 整体删除（server.py + 目录 + agent front matter 中的 mcp 注册）
- run_health_check 逻辑迁移到 health-check skill scripts/（~400 行）
- 状态存储: state.json / STATE.md / DIGESTS.md / ROADMAP.md（4）→ research_state.md（1）
- worker 回传: phase_result YAML（5 字段）→ status 信号（1 词）+ Last Phase Result 节
- 新增 research_state.md 模板 + literatures/registry.json 闭环

---

## 验收目标

### 语义验收

- [ ] research_state.md 模板包含全部 13 个节：Active Workdir / Workdir History / Research Goal / Current Understanding / Questions/Claims / Dependency Graph / Failed Attempts / Phase History / Last Phase Result / Human Directives / Open Decisions / Conventions / Next To Handle
- [ ] Last Phase Result 节字段为 `phase` / `status` / `summary` / `issues`，与所有 phase skill（newlayer-2~6）回传格式一致
- [ ] worker 回传机制为 status 信号（`completed` / `needs_attention`），替代旧的 phase_result YAML
- [ ] slug 机制：agent 从 Research Goal 派生 slug（≤30 字符），读 Workdir History 防冲突，旧 slug 保留不删
- [ ] 文件布局与设计文档 §3.6.3 一致：persistence/ 放跨阶段共享状态，literatures/ 放文献，notepads/<slug>/ 放阶段产出
- [ ] 文件布局：EXECUTION.md 和 VERIFICATION.md 位于 `<workdir>` 根目录（非 execution/ 子目录内），与 newlayer-6 M2 和设计文档 §4.3 一致
- [ ] registry.json 字段为 `id` / `type` / `title` / `authors` / `year` / `file` / `downloaded_at`，与 newlayer-9 M2 的 `update_registry()` 函数签名一致
- [ ] run_health_check 迁移后更新 `_check_persistence`（检查 research_state.md 而非 state.json/STATE.md）、`_check_skill_chain`（删旧 skill 检查 + 加新 checker 脚本检查）、`_check_runtime`（删 advance_plan/phase_rollback 测试）

### 脚本强制验收

- [ ] `不得存在` `.aether/mcp/research-state/` 目录（整体删除）
- [ ] `不得存在` `.aether/mcp/research-conventions/` 目录（整体删除）
- [ ] `不得存在` persistence/ 下的 `state.json` / `STATE.md` / `DIGESTS.md` / `ROADMAP.md` 文件
- [ ] `不得存在` agent front matter 中的 `mcp: research-state: true` 或 `mcp: research-conventions: true`
- [ ] `不得存在` agent front matter 中的 `research_state_*: allow` 或 `research_conventions_*: allow` 权限条目
- [ ] `check_artifacts.py` 验证 persistence/ 白名单：只允许 `research_state.md` + `ENVIRONMENT.md`，不允许其他文件
- [ ] `check_artifacts.py` 验证 notepads/ 下所有工作文件路径以 Active Workdir 开头
- [ ] `check_artifacts.py` 输出 JSON 含 `ok` / `missing` / `empty` / `outside_workdir` / `persistence_violations` 字段
