# Layer 3.1: Research Skills 补充设计

> 前置依赖: Layer 0-3（核心安全 + Agent 基础设施 + Research 配置层 + MCP 状态层 + Skills/Scripts 计算层）
> 本文档是对 Layer 3 的**补充**，仅涉及通用 research skills 的完善和调整。**不修改 Layer 3 已完成的 MCP 服务器和 gpd-\* 物理插件**。
> 所有改动限制在 `.aether/` 目录内的 skills 和 agent 定义文件，零核心源文件改动。

---

## 上下文

| Layer   | 状态       | 简介                                                             |
| ------- | ---------- | ---------------------------------------------------------------- |
| Layer 0 | 已完成     | Permission/Discipline/Info 扩展 + findOrInstallUv                |
| Layer 1 | 已完成     | output_dir、fallback_models、MCP per-agent                       |
| Layer 2 | 已完成     | Research agent/skill 配置文件                                    |
| Layer 3 | 已完成     | MCP 状态层 + Skills/Scripts 计算层                               |
| **3.1** | **本文档** | 通用 research skills 完善 + 目录规范化 + paper-search skill 集成 |

### Layer 3 已完成内容（本文档不修改）

- MCP 服务器: `research-conventions` (6 tools) + `research-state` (5 tools) → **不动**
- gpd-\* 物理插件: 4 skills (gpd-verification/gpd-errors/gpd-domain-check/gpd-conventions) + scripts + references → **不动**
- research-verification skill (通用验证框架) → **不动**
- 通用 agents (research.md, research-explorer.md, research-verifier.md) → **仅修改 research.md 的 skill_refs 和 prompt**
- gpd-\* agents (gpd-verifier.md, gpd-reviewer.md) → **不动**

---

## 设计原则

### 原则 1: 目录规范化 — `.aether/skills/` (复数)

**现状**: 当前项目使用 `.aether/skill/` (单数)。OpenCode 核心代码的 `OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"` 同时扫描单数和复数目录，**不影响技能发现**。但 `getDefaultSkillsDir()` 函数（用于 UI 技能管理）只查找 `skills/` (复数)。

**决策**: 将 `.aether/skill/` 重命名为 `.aether/skills/`，与 OpenCode 核心代码的规范路径一致。

**改动范围**:

- 目录重命名: `.aether/skill/` → `.aether/skills/`
- 所有 agent 定义中引用 skill 目录的路径自动适配（agent 不硬编码路径，skill 发现通过 glob + frontmatter name）
- MCP `research-conventions/server.py` 中的 `_init_skill_dirs()` 已包含 `.aether/skill/` 和 `.opencode/skills/` → 需要更新为 `.aether/skills/`

**不变内容**:

- gpd-\* 插件仍放在 `.aether/skills/plugins/gpd/` 子目录（只是从 `skill/plugins/gpd/` 变为 `skills/plugins/gpd/`）
- skill 发现机制不变（glob `{skill,skills}/**/SKILL.md` + frontmatter name）
- MCP 服务器功能不变

### 原则 2: 主 agent 不硬编码 skill_refs

**现状**: `research.md` 的 YAML frontmatter 中硬编码了 `skill_refs: [deep-research, paper-search, literature-landscape-scan, research-question-framing]`。

**问题**: 主 agent 应有充分权限选择不同 skills，不应限制 skill 可见性。`skill_refs` 的语义是"仅注入这些 skills"，会屏蔽其他可用 skills。

**决策**: 移除 `research.md` 的 `skill_refs` 字段。将 skill 路由指引放入 markdown body（prompt）中，agent 通过 `skill` 工具按名称调用，不受可见性限制。

**改动**:

```md
---
description: Research mode — deep search, analysis, and verification
color: "#7C3AED"
mode: primary
permission:
  "*": deny
  grep: allow
  glob: allow
  read: allow
  edit: allow
  bash: allow
  webfetch: allow
  skill: allow
  external_directory: allow
  research_conventions_*: allow
  research_state_*: allow
fallback_models:
  - anthropic/claude-sonnet-4-5
mcp:
  research-conventions: true
  research-state: true
output_dir: ".aether/research"
---

# Research Agent

Orchestrate deep research: explore, analyze, verify, and produce structured reports.

## Routing

| Intent                    | Action                                        |
| ------------------------- | --------------------------------------------- |
| Quick lookup              | Use paper-search skill directly               |
| Deep research             | Invoke /deep-research skill                   |
| Systematic lit review     | Invoke /literature-review skill               |
| Autonomous research loop  | Invoke /autoresearch skill                    |
| Broad landscape scan      | Invoke /literature-landscape-scan skill       |
| Research question framing | Invoke /research-question-framing skill       |
| Verification              | Delegate to research-verifier or gpd-verifier |

## Session Recovery

On session start, read `.aether/research/persistence/STATE.md` and `state.json` to restore prior phase, decisions, and blockers.

## Project Lifecycle

1. Use deep-research skill to generate ROADMAP.md
2. Write PLAN.md with contract (claims, deliverables, acceptance_tests, forbidden_proxies)
3. Delegate verification to appropriate subagent
4. Advance state via research-state MCP (advance_plan)
5. Maintain STATE.md with current phase, decisions, blockers

## Integrity

Never fabricate sources. Never claim verification without evidence.
```

**不变内容**: subagents (research-explorer, research-verifier, gpd-verifier, gpd-reviewer) 保持现有 `skill_refs` — subagent 需要精确的 skill 可见性控制。

### 原则 3: 项目级 skills 包含完整集

**现状**: `deep-research` 和 `literature-review` 仅存在于全局 `.opencode/skills/` 中，不在项目级 `.aether/skills/` 中。

**决策**: 将 `deep-research` 和 `literature-review` 的 SKILL.md 复制到 `.aether/skills/` 下，确保项目级 skill 集完整，不依赖全局安装。

**但需验证**: 这两个全局 skill 的内容是否符合 Layer 2/3 设计文档的功能预期？验证结果见 §3.4。

### 原则 4: paper-search skill 集成

alphaXiv (https://alphaxiv.org) 是 arXiv 的 AI-enhanced 前端，提供:

- AI 生成的论文概述（比原始 arXiv abstract 更易 agent 消费）
- 论文音频版本
- 结构化的论文分类和讨论
- URL 格式: `alphaxiv.org/abs/XXXX.XXXXX`（映射到 arXiv ID）
- 论文概述页面: `alphaxiv.org/overview/XXXX.XXXXX`

**对 agent 的关键优势**:

- alphaxiv overview 页面提供 AI 生成的结构化论文总结，agent 用 `webfetch` 即可获取高质量论文内容理解，无需下载/解析 PDF
- 比 arXiv API 返回的 abstract 更深入（包含方法、结果、局限性的结构化摘要）
- URL 格式与 arXiv ID 一一对应，可无缝替换

**决策**: 在 `paper-search` skill 中增加 alphaxiv 集成（arXiv API 搜索 + alphaxiv webfetch 深度理解）:

- 搜索阶段仍使用 arXiv API（获取 ID 列表）
- 内容理解阶段优先使用 alphaxiv overview URL (`webfetch https://alphaxiv.org/overview/<arxiv_id>`)
- arXiv abstract 作为 fallback

---

## 3.1 目录结构变更

### 变更前 (Layer 3)

```
.aether/skill/                              → 单数命名
  research-verification/SKILL.md
  research-question-framing/SKILL.md
  literature-landscape-scan/SKILL.md
  plugins/gpd/
    gpd-verification/SKILL.md + scripts/ + references/
    gpd-errors/SKILL.md + references/
    gpd-domain-check/SKILL.md + references/bundles/
    gpd-conventions/SKILL.md + references/
```

### 变更后 (Layer 3.1)

```
.aether/skills/                             → 复数命名（与核心代码一致）
  deep-research/SKILL.md                    → 从全局复制+适配
  literature-review/SKILL.md                → 从全局复制+适配
  autoresearch/SKILL.md                     → 新增
  paper-search/SKILL.md                  → arXiv API 搜索 + alphaxiv webfetch 深度理解
  research-verification/SKILL.md            → 不动（Layer 3 已完成）
  research-question-framing/SKILL.md        → 需增强（§3.5）
  literature-landscape-scan/SKILL.md        → 需增强（§3.6）
  plugins/gpd/                              → 不动（Layer 3 已完成）
    gpd-verification/...
    gpd-errors/...
    gpd-domain-check/...
    gpd-conventions/...
```

---

## 3.2 research.md Agent 变更

**改动**: 移除 `skill_refs` 硬编码，改为 prompt 中的路由指引。

**不改动**: permission、mcp、output_dir、fallback_models 等 YAML 配置。

变更前后的完整对比见 §原则 2 的代码块。

**关键**: subagent 定义文件 (research-explorer.md, research-verifier.md, gpd-verifier.md, gpd-reviewer.md) **保持现有 skill_refs 不变** — subagent 需要精确的 skill 可见性控制，这是设计意图。

---

## 3.3 MCP server.py 路径更新

`research-conventions/server.py` 中的 `_init_skill_dirs()` 需要将 `.aether/skill/` 更新为 `.aether/skills/`:

```python
def _init_skill_dirs():
    global SKILL_DIRS
    home = Path.home()
    candidates = [
        home / ".aether" / "skills",       # 更新: skill → skills
        home / ".opencode" / "skills",
        home / ".claude" / "skills",
        home / ".agents" / "skills",
    ]
    cwd = Path.cwd()
    candidates.extend([
        cwd / ".aether" / "skills",         # 更新: skill → skills
        cwd / ".opencode" / "skills",
    ])
    for d in candidates:
        if d.exists():
            SKILL_DIRS.append(d)
```

---

## 3.4 deep-research & literature-review 功能验证

### deep-research (全局版 192 行)

**功能**: 5步研究流程（Clarify → Identify → Gather → Synthesize → Document），输出格式（Executive Summary + Key Findings + Detailed Analysis + Areas of Consensus/Debate + Sources + Gaps），源评估标准。

**与设计文档预期对比**:

| 设计预期 (Layer 2 §2.5)                   | deep-research 实际      | 差距                                  |
| ----------------------------------------- | ----------------------- | ------------------------------------- |
| 使用 research-explorer subagent 并行搜索  | 未提及 subagent 使用    | 需增加 subagent 指引                  |
| 写入 ROADMAP.md                           | 未提及持久化文件        | 需增加 ROADMAP/PLAN/STATE.md 写入指引 |
| 与 research-state MCP 集成 (advance_plan) | 无 MCP 集成             | 需增加 MCP 调用指引                   |
| 与 research-conventions MCP 集成          | 无 MCP 集成             | 需增加约定检查指引                    |
| 输出到 output_dir (notepad 结构)          | 输出格式是自由 markdown | 需适配 notepad 结构                   |
| 源评估含 paper-search skill               | 只含通用评估标准        | 需增加物理文献评估                    |

**决策**: 将全局 deep-research 复制到 `.aether/skills/deep-research/`，并在 SKILL.md 中增加:

1. 研究持久化指引（ROADMAP.md → PLAN.md → STATE.md 写入）
2. MCP 集成指引（advance_plan、convention_lock_status 调用时机）
3. subagent 使用指引（何时 dispatch research-explorer）
4. notepad 输出结构指引（output_dir/notepads/<slug>/）
5. 物理文献源评估补充（paper-search skill + alphaxiv overview）

### literature-review (全局版 584 行)

**功能**: 7阶段完整文献综述流程（Planning → Search → Screening → Selection → Extraction → Synthesis → Citation Verification），含 scripts (verify_citations.py, generate_pdf.py, search_databases.py)，references (citation_styles.md, database_strategies.md)，assets (review_template.md)。

**与设计文档预期对比**:

| 设计预期 (Layer 2 §2.5)            | literature-review 实际                    | 差距                                       |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------ |
| 物理领域文献综述                   | 面向生物医学（PubMed, gget, bioservices） | 需增加物理数据库指引（paper-search skill） |
| 与 research-explorer subagent 配合 | 未提及 subagent                           | 需增加 subagent 指引                       |
| 输出到 output_dir                  | 自由输出                                  | 需适配 notepad 结构                        |
| 含 scripts 和 references           | 有 3 scripts + 2 references + 1 asset     | 需复制这些文件到项目级目录                 |
| Citation verification              | 有 verify_citations.py                    | 超出设计预期，保留                         |

**决策**: 将全局 literature-review **连同 scripts/、references/、assets/ 子目录**完整复制到 `.aether/skills/literature-review/`，并在 SKILL.md 中增加:

1. 物理文献数据库指引（paper-search skill + alphaxiv overview 深度理解）
2. subagent 使用指引
3. notepad 输出结构适配
4. 移除对 gget/bioservices 等生物医学工具的硬依赖（改为可选）

---

## 3.5 autoresearch Skill (新增)

### 设计背景

Layer 2 §2.5.4 提到 autoresearch skill，功能为"自主研究循环：planning → execute → verify → advance"。当前不存在此 skill。

### 文件

`.aether/skills/autoresearch/SKILL.md`

### 设计

autoresearch 是一个轻量级自主研究循环 skill，适合让 research agent 在用户不在时自动推进研究项目。**当前仅支持 planning 阶段**，不包含 automated edit→run→log 循环（Layer 5 background execution 后实现）。

```yaml
---
name: autoresearch
description: Autonomous research loop — plan, execute, verify, advance. Currently supports planning phase only; full execution loop deferred to Layer 5.
---
```

SKILL.md 核心内容:

- **Plan Phase**: 读 ROADMAP.md 确定当前阶段 → 使用 deep-research skill 收集证据 → 写 PLAN.md 合约 → 调用 research-state MCP advance_plan 推进状态
- **Verify Phase**: dispatch research-verifier 或 gpd-verifier subagent → 读 VERIFICATION.md → 根据结果决定继续/回退/修正
- **Advance Phase**: 更新 STATE.md → 推进状态 → 写入下一阶段 PLAN.md
- **Limitations**: 当前不支持自动执行计算脚本（需 Layer 5 background execution）

---

## 3.6 literature-landscape-scan 增强

### 现状

当前 SKILL.md 仅 15 行，过于简略:

```markdown
## Procedure

1. Identify key search terms
2. Survey recent publications
3. Map competing theories
4. Identify open problems

## Outputs

literature_map, gap_list
```

### 增强设计

增强为完整的文献景观扫描程序，增加:

1. **搜索策略**: 多数据库并行搜索指引（paper-search skill + alphaxiv overview 深度理解）
2. **结构化输出**: landscape_map.md 格式规范（领域地图、学派分类、关键论文时间线、争议点标注、开放问题列表）
3. **alphaxiv 集成**: 通过 paper-search skill 搜索获取 arXiv ID 列表后，用 alphaxiv overview 快速理解论文内容
4. **与 research-question-framing 配合**: landscape scan 的 gap_list 作为 research-question-framing 的输入
5. **质量标准**: 论文覆盖度、时间跨度、学派平衡性

---

## 3.7 research-question-framing 增强

### 现状

当前 SKILL.md 仅 18 行，过于简略:

```markdown
## Procedure

1. Identify the domain and phenomenon
2. Define the gap in current understanding
3. Formulate a specific, falsifiable question
4. Specify measurement criteria

## Outputs

structured research question with scope constraints
```

### 增强 design

增强为完整的研究问题构建程序，增加:

1. **PICO 框架适配**: 不仅限于生物医学 PICO，提供物理领域的问题框架（系统 → 模型 → 预期 → 偏差）
2. **从 landscape scan 输入**: 读取 literature-landscape-scan 的 gap_list，将 gap 转化为可验证的研究问题
3. **可验证性标准**: 每个研究问题必须有 falsification criterion、measurement method、expected evidence kind
4. **与 PLAN.md 合约对接**: 研究问题直接映射为 PLAN.md 的 claims + acceptance_tests
5. **输出格式**: structured research question (domain, phenomenon, gap, question, falsification_criterion, measurement_method, evidence_kind, scope_constraints)
6. **与 MCP 集成**: 新问题创建前检查 convention_lock_status，确保约定一致

---

## 3.8 paper-search skill（arXiv API 搜索 + alphaxiv webfetch 深度理解）

### 现状

全局 arxiv-search SKILL.md (33 行): 仅提供 `arxiv_search.py` 脚本调用，返回 title + abstract。原 `alpha-research` skill 依赖 alpha CLI（不存在）。

### 增强设计

替换 alpha CLI 依赖为 arXiv API 搜索 + alphaxiv webfetch 深度理解:

1. **arXiv API 搜索**（无需登录）：关键词搜索 + 分类过滤，返回 title + abstract
2. **alphaxiv 深度理解**: 对每个感兴趣的 arXiv ID，使用 `webfetch https://alphaxiv.org/overview/<arxiv_id>` 获取 AI 生成的结构化概述
3. **alphaxiv overview 内容**: 包含 Key Findings、Methodology、Limitations、Broader Impact 的结构化摘要 — 比 abstract 更适合 agent 消费
4. **fallback**: alphaxiv overview 不可用时（网络问题、新论文尚未生成 overview），回退到 arXiv abstract

SKILL.md 增加:

```markdown
## Deep Understanding (alphaxiv)

After obtaining arXiv IDs from search, for papers requiring deeper analysis:

1. Construct alphaxiv overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
2. Use webfetch to retrieve the overview page
3. The overview provides structured: Key Findings, Methodology, Limitations, Broader Impact
4. Use overview content for research synthesis instead of relying solely on abstracts

Fallback: if alphaxiv overview is unavailable, use the arXiv abstract from search results.
```

---

## 3.9 对 Layer 3 已完成内容的影响检查

| Layer 3 内容                | Layer 3.1 是否修改                | 影响                                   |
| --------------------------- | --------------------------------- | -------------------------------------- |
| research-conventions MCP    | 更新 \_init_skill_dirs() 中的路径 | 路径名更新，功能不变                   |
| research-state MCP          | 不修改                            | 无影响                                 |
| gpd-\* 4 skills + scripts   | 不修改                            | 无影响                                 |
| research-verification skill | 不修改                            | 无影响                                 |
| research-verifier.md        | 不修改                            | 无影响                                 |
| gpd-verifier.md             | 不修改                            | 无影响                                 |
| gpd-reviewer.md             | 不修改                            | 无影响                                 |
| research-explorer.md        | 不修改                            | 无影响                                 |
| research.md                 | 移除 skill_refs，修改 prompt      | skill 可见性扩大，路由改为 prompt 指引 |

**关键**: Layer 3.1 的所有改动都不会破坏 Layer 3 已完成的 MCP 服务器和 gpd-\* 物理插件。唯一的 MCP 变动是 `research-conventions/server.py` 中一个候选路径名更新（从 `.aether/skill/` 到 `.aether/skills/`），不改变任何 tool schema 或功能。

---

## 验收测试

```
T3.1a: .aether/skills/ 目录存在，所有 SKILL.md 文件被 OpenCode 正常发现（glob {skill,skills}/**/SKILL.md）
T3.1b: getDefaultSkillsDir() 返回 .aether/skills/ 路径，UI 技能管理功能正常
T3.2:  research.md 无 skill_refs 字段，agent 可见所有 skills（不再受 skill_refs 白名单限制）
T3.3:  research.md prompt 包含 skill 路由指引，agent 能通过 /skill 调用 deep-research/literature-review/autoresearch 等
T3.4:  deep-research skill 在 .aether/skills/ 下存在，SKILL.md 包含持久化指引和 MCP 集成
T3.5:  literature-review skill 在 .aether/skills/ 下存在，包含 scripts/、references/、assets/ 子目录
T3.6:  autoresearch skill 在 .aether/skills/ 下存在，SKILL.md 描述 planning-only 自主循环
T3.7:  literature-landscape-scan SKILL.md 增强为完整程序（搜索策略+结构化输出+paper-search skill+质量标准）
T3.8:  research-question-framing SKILL.md 增强为完整程序（PICO/物理框架+gap输入+可验证性+PLAN合约对接）
T3.9:  paper-search SKILL.md 包含 arXiv API 搜索 + alphaxiv 集成指引（overview URL 构造+webfetch+fallback）
T3.10: research-conventions MCP server.py 中 _init_skill_dirs() 包含 .aether/skills/ 路径
T3.11: 目录重命名后，gpd-* 物理插件 skills 正常被发现（plugins/gpd/ 在 .aether/skills/ 下）
T3.12: 删除 .aether/skill/ 目录后，所有 skill 发现仅从 .aether/skills/ 工作
T3.13: Layer 3 MCP 服务器（research-conventions + research-state）tool schema 和功能不变
T3.14: gpd-* 物理插件（4 skills + 6 scripts + references）内容和功能不变
```

---

## 实施顺序

1. **目录重命名**: `.aether/skill/` → `.aether/skills/`（含 plugins/gpd/ 子目录）
2. **MCP 路径更新**: `research-conventions/server.py` 中 `_init_skill_dirs()`
3. **research.md 变更**: 移除 `skill_refs`，修改 prompt body
4. **deep-research 复制+适配**: 从全局复制到 `.aether/skills/deep-research/`，增加持久化和 MCP 指引
5. **literature-review 复制+适配**: 从全局完整复制（含 scripts/references/assets），增加物理文献指引
6. **paper-search skill**: 替换 alpha CLI 依赖，增加 alphaxiv webfetch 集成
7. **autoresearch 新增**: 创建 `.aether/skills/autoresearch/SKILL.md`
8. **literature-landscape-scan 增强**: 扩充 SKILL.md
9. **research-question-framing 增强**: 扩充 SKILL.md
10. **验收测试**: 逐项验证
