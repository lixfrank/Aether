# Layer 3.16: Research Agent Definition Decomposition — identity+skill 分层架构（1762→178+525+294+229+566行，核心文件行数-90%）

> 前置依赖: Layer 0-3.15（所有已完成层）
> 修改范围: `.aether/agent/research.md`（重构）+ `.aether/skills/research-coordinator/`（新建 skill）
> 零核心源文件改动，零 MCP 改动。

---

## 目录

1. [问题分析](#1-问题分析)
2. [行业实践调研](#2-行业实践调研)
3. [关键设计决策](#3-关键设计决策)
4. [分解方案总览](#4-分解方案总览)
5. [目标 research.md 详细设计](#5-目标-researchmd-详细设计)
6. [research-coordinator skill 详细设计](#6-research-coordinator-skill-详细设计)
7. [逐行迁移映射表](#7-逐行迁移映射表)
8. [不修改的部分](#8-不修改的部分)
9. [验收清单](#9-验收清单)

---

## 1. 问题分析

### 1.1 当前状况

| 指标               | 当前值                                                      | 行业参考值                                                                 |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| research.md 总行数 | 1762                                                        | MetaGPT role 80-150行; CrewAI YAML 10-30行; Codex CLI 单体 298行(无状态机) |
| 同项目其他 agent   | worker 294行, executor 289行, explorer 120行, verifier 60行 | research.md 是最大文件的 **6倍**                                           |
| 重复声明次数       | file_scope约束3次, git rollback3次, audit-repair3处展开     | 行业标准: 同一约束只声明1次, 参数化差异用表格                              |
| Prompt模板硬编码   | ~200行(6种dispatch prompt逐字模板)                          | autoresearch已有references/worker-prompts.md存放模板                       |

### 1.2 核心问题

| 问题         | 表现                                                                           | 占比 | 行业共识                                                                                             |
| ------------ | ------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------- |
| **职责越界** | agent定义包含完整状态机、路由决策、dispatch prompt、crash recovery、Notice模板 | ~60% | CrewAI: agent YAML vs tasks YAML; MetaGPT: role.py vs prompts/; Magentic-One: \_prompts.py vs worker |
| **重复冗余** | file_scope 3次, git rollback 3次, audit-repair 3处几乎相同展开                 | ~15% | 参数化差异用表格而非逐处展开                                                                         |
| **过度规格** | 每个sub_phase的完整dispatch prompt硬编码                                       | ~10% | autoresearch: references/worker-prompts.md                                                           |
| **概念混杂** | coordinator与agent概念混在一起                                                 | ~5%  | Magentic-One: orchestrator纯路由                                                                     |

### 1.3 与 Layer 2 设计原则的冲突

Layer 2 明确提出:

> **多模式而非单巨型 agent**: Research agent 是**简短定义文件 + 多个可调用工作流模式**

当前 1762行正是 Layer 2 试图避免的"单巨型 agent prompt"。后续 Layer 3.x 的增量修改逐步丰富了状态机，但都是在 research.md 上做增量，最终比 Layer 2 原始目标更严重。

---

## 2. 行业实践调研

### 2.1 9个成熟项目对比

| 项目             | Agent定义行数                     | Identity↔Workflow分离                     | 状态机在哪里              |
| ---------------- | --------------------------------- | ------------------------------------------ | ------------------------- |
| **CrewAI**       | 10-30行 YAML                      | Strong: agents.yaml vs tasks.yaml          | Crew Process + tasks.yaml |
| **AutoGen**      | 5-15行 code                       | Moderate: agent vs Team class              | Team/GroupChat            |
| **LangGraph**    | 无persona字段                     | None: graph IS agent                       | StateGraph Python         |
| **Codex CLI**    | 298行单体Markdown                 | Weak: monolithic                           | 无状态机                  |
| **MetaGPT**      | 80-150行                          | Strong: 3层(identity→instruction→workflow) | RoleReactMode + states    |
| **Magentic-One** | orchestrator ~100行; worker ~25行 | Extreme: orchestrator无persona             | LedgerEntry JSON          |
| **PydanticAI**   | 5-20行                            | Strong: Agent vs pydantic-graph            | pydantic-graph独立库      |
| **OpenHands**    | 100-300行class                    | Moderate: class vs microagents             | Agent step() loop         |

### 2.2 五种设计模式

| 模式                                   | 代表                                | 适用场景          | research agent匹配度               |
| -------------------------------------- | ----------------------------------- | ----------------- | ---------------------------------- |
| **A: Persona-First**                   | CrewAI, MetaGPT                     | 角色扮演协作      | 部分匹配(coordinator有persona需要) |
| **B: Graph-First**                     | LangGraph, PydanticAI               | 复杂条件分支      | 部分匹配(Path3是复杂工作流)        |
| **C: Monolithic Prompt**               | Codex CLI                           | 单个强大编程agent | 不匹配(多agent架构)                |
| **D: Minimal Agent+Rich Orchestrator** | AutoGen, Magentic-One               | 灵活多agent组合   | **高匹配**                         |
| **E: Layered Composition**             | Codex AGENTS.md, OpenHands, MetaGPT | 跨项目适配        | **高匹配**(Aether已有skill体系)    |

### 2.3 关键行业共识

1. Agent定义文件只定义身份、权限、硬约束和高层行为规范；流程逻辑归skill/workflow
2. Orchestrator persona应极简(Magentic-One空persona; CrewAI manager纯编排)
3. 状态机应是独立模块(LangGraph StateGraph; PydanticAI pydantic-graph; MetaGPT states)
4. Prompt模板应外部化(MetaGPT prompts/; autoresearch references/worker-prompts.md)
5. Agent定义行数应<150行(最复杂MetaGPT 80-150行)

---

## 3. 关键设计决策

### 3.1 Coordinator Persona: 5行persona+skill内容规则

Persona只含身份、风格和identity级硬约束，不含内容判断力。内容判断力规则属instruction层(MetaGPT三层架构)，放在SKILL.md §8a。

```
You are the research coordinator. You manage the research state machine,
dispatch research-worker subagents for each phase, and interact with the
user at checkpoint phases. Your communication style is concise and
professional. You never produce free-form analysis — all output follows
the state machine's structured templates and procedures.
```

- "manage state machine" → identity声明
- "dispatch research-worker" → identity声明
- "interact at checkpoint phases" → identity声明
- "concise and professional" → 风格指引(不含内容判断力)
- "never produce free-form analysis" → identity级硬约束(定义coordinator本质:路由引擎而非分析器)

不含的内容(放SKILL.md §8a):

- checkpoint摘要的内容优先级("研究问题和核心发现优先")
- notice output_summary提取规则("优先从digest字段提取")
- completed结果呈现结构("resolved conclusions first")

#### §3↔§8↔references 交叉引用设计

SKILL.md §3 Coordinator Routing描述流程骨架,§8 User Interaction & Output Rules描述交互内容判断力和输出模板,references/phase-routing.md描述条件路由决策完整展开。

§8分两个子节:

- **§8a User Interaction Content Rules**: 面向用户的交互内容判断力
- **§8b Output & Dispatch Rules**: 输出模板和dispatch prompt注入规则

§3每个涉及内容输出的步骤处添加显式交叉引用:

- Notice步骤: "输出Notice — 模板见 §8b"
- Checkpoint步骤: "呈现摘要 — 内容优先级见 §8a, rollback见 references/phase-routing.md §Checkpoint Rollback"
- LOW confidence步骤: "选项文案见 §8a, 路由见 references/phase-routing.md §Audit-3 Routing, prompt注入见 §8b"
- Audit条件分支: "完整条件路由见 references/phase-routing.md §Audit-1/2/3 Routing"

---

### 3.2 Entry Gate 归属: 放入 research.md (identity层)

Entry Gate分类是identity级行为——回答"research agent能做什么类型的任务"(quick lookup vs literature review vs research project)，不是instruction层执行逻辑。

**设计理由**:

1. **context效率**: Path 1/2用户不再被迫加载SKILL.md ~606行，research.md ~173行包含完整分类和Path 0/1/2处理
2. **概念清晰**: Entry Gate分类是identity层信息(MetaGPT三层架构: identity→instruction→workflow)
3. **SKILL.md纯粹**: SKILL.md变为纯Path 3 coordinator instruction，不含身份判断逻辑
4. **行业对齐**: CrewAI agents.yaml(identity层)定义agent类型,MetaGPT role.py(identity)定义角色+能力——分类是identity而非instruction

**组织方式**: research.md中Entry Gate作为完整section(~68行),含分类规则+enforcement+Path 1/2/0完整处理。SKILL.md §1变为Path 3 State Machine Overview。

---

### 3.3 Session Recovery: 正常路径SKILL+异常references

正常路径(~15行)在SKILL.md §9,异常路径在references/session-recovery.md。

**设计理由**:

1. 与autoresearch SKILL.md+edge-cases.md模式对齐
2. SKILL.md可控,新增phase只改references
3. 避免跨skill接口契约

#### references/session-recovery.md结构

```
§Phase-Specific Crash Recovery
§Repair Crash Recovery (audit phases)
§Health Check Digest Processing
§STATE.md Format Templates
§User-Triggered Health Check
§LLM-only Mode Behavior
§Digest Parsing Fallback + Task Dispatch Failure
§File Location Relocate (validate_file_locations MCP non-compliant修正策略)
```

SKILL.md中Session Start Procedure(~15行):

```
1. Health check: invoke /health-check skill (or uv --version for Tier 0)
   → degraded: read references/session-recovery.md §Health Check Digest Processing
2. Git check: git rev-parse → if not in repo: git init + initial commit
3. Read STATE.md + state.json → determine current phase
   → Active project: resume from current phase
     (crash recovery: read references/session-recovery.md §Phase-Specific Crash Recovery)
   → No active project: classify via Entry Gate (in research.md)
4. Dispatch research-worker for current phase
```

---

### 3.4 File Location Relocate: 异常路径references而非正常路径SKILL

`validate_file_locations` MCP调用留在Digest Processing正常路径中(每次必须调用),但**relocate修正操作**移到references/session-recovery.md。

**设计理由**:

1. relocate是防御性修正(~40-50%首次运行触发,后续通常不触发),不是每次都需要的核心流程
2. MCP `suggested_correction`字段已提供具体修正建议,coordinator按建议执行即可——relocate策略在references中明确即可
3. 正常路径精简~10行:"validate→if compliant: advance→commit→Notice→route; if non-compliant: read references/session-recovery.md §File Location Relocate"

SKILL.md §3 Digest Processing正常路径:

```
3. If status=completed:
   - Call validate_file_locations via research-state MCP
   - If compliant=true: proceed below
   - If compliant=false: read references/session-recovery.md §File Location Relocate
   - Append digest YAML to DIGESTS.md
   - Call advance_plan → git commit → Notice → route → Terminal Action
```

references/session-recovery.md §File Location Relocate(~25行):

- nested_output_dir: 移除嵌套.aether/research前缀,保留最内层路径
- outside_output_dir: 移入.aether/research/notepads/<slug>/或合适子目录
- persistence_non_whitelisted: 移到notepads/<slug>/或删除临时文件
- 每种修正后: 更新现有文件中的内部引用,然后re-call validate_file_locations确认compliance

---

## 4. 分解方案总览

### 4.1 信息流向

```
research.md (~178行)
  │
  │ 身份 + 权限 + 硬约束 + persona + Entry Gate(完整分类规则+Path 0/1/2处理)
  │ + 高层行为声明 + Skill Invocation Mechanism + Turn Termination
  │
  │ Path 0: 直接在research.md中处理(拒绝+建议切换build agent)
  │ Path 1: 直接调用/paper-search skill(无需invoke research-coordinator)
  │ Path 2: 直接调用/literature-review skill(无需invoke research-coordinator)
  │
  └─ Path 3: invoke /research-coordinator skill tool
        │
        │ SKILL.md (525行, injected via skill tool, content remains in
        │   conversation history across turns until compaction removes it;
        │   re-invoke on next turn if compaction occurred — see §Skill
        │   Invocation Mechanism in research.md)
        │   §1 Path 3 State Machine Overview (高层图+phase顺序)
        │   §2 Coordinator Routing (流程骨架+Digest Processing正常路径;
        │      Notice步骤标注"模板见§7b";
        │      Checkpoint步骤标注"内容优先级见§7a, rollback见references/phase-routing.md";
        │      异常处理标注"见references/session-recovery.md")
        │   §3 Phase Transition Rules (before/after entering + skip rules)
        │   §4a Audit-Repair通用机制 (含Repair Pre-backup声明)
        │   §4b Audit-3特殊路由 (4条分支决策树概述+引用references/phase-routing.md)
        │   §5 Debate Loop (流程骨架+sub_phase顺序+引用references/phase-routing.md)
        │   §6 Execution Phase (domain_mode+dispatch+digest routing概述)
        │   §7 User Interaction & Output Rules
        │     §7a: User Interaction Content Rules (checkpoint摘要+LOW confidence文案+呈现结构)
        │     §7b: Output & Dispatch Rules (Notice模板+phase_display_name mapping表+Debate Worker Prompt Injection)
        │   §8 Session Start Procedure (正常路径)
        │   §General Rules (输出目录+persistence约定+子agent规则+Convention Awareness+Integrity分层声明)
        │
        └─ references/
            │ session-recovery.md (294行) — 异常路径+relocate策略
            │   (含Digest Parsing Fallback + Task Dispatch Failure + Repair Crash Recovery
            │    + Phase-Specific Crash Recovery + Health Check Digest Processing
            │    + File Location Relocate + LLM-only Mode 3-tier分层等)
            │ phase-routing.md (229行) — 条件路由决策(不一定每次触发)
            │   (含audit_1/2/3完整条件分支+checkpoint rollback操作+PoC Repair Sub-route
            │    +Landscape Supplement Sub-route+Infeasible Gap Marking
            │    +debate sub-phase routing表+debate round termination
            │    +error handling+repair digest processing两条路径
            │    +user rejection options+execution paused recovery)
            │ phase-detail-tables.md (566行) — 参数化表格+完整dispatch prompts
            │   (含Repair Pre-backup file lists + Debate Repair Pre-backup细节
            │    +State Consistency Check完整步骤+完整skip/rollback/consistency规则
            │    +Phase↔state.json Mapping+Phase Dispatch Table+Phase display name mapping)
```

### 4.2 各文件行数预估

| 文件                                                                    | 当前行数 | 实际行数 | 原预估行数 | 变化     |
| ----------------------------------------------------------------------- | -------- | -------- | ---------- | -------- |
| `.aether/agent/research.md`                                             | 1762     | 178      | ~173±10    | **-90%** |
| `.aether/skills/research-coordinator/SKILL.md`                          | 0(新建)  | 525      | ~542±30    | +525     |
| `.aether/skills/research-coordinator/references/session-recovery.md`    | 0(新建)  | 294      | ~200±20    | +294     |
| `.aether/skills/research-coordinator/references/phase-routing.md`       | 0(新建)  | 229      | ~130±15    | +229     |
| `.aether/skills/research-coordinator/references/phase-detail-tables.md` | 0(新建)  | 566      | ~425±30    | +566     |
| **总计**                                                                | 1762     | 1792     | ~1470±105  | +2%      |

总信息量增加约2%，但分布结构彻底改善。核心改善:

1. research.md从1762行降至~173行:身份+Entry Gate+硬约束+行为声明，不含完整状态机、dispatch prompt、crash recovery等instruction层内容
2. SKILL.md从原research.md中instruction层内容(~860行)降至~542行:条件路由决策移入references/phase-routing.md,relocate修正移入references/session-recovery.md
3. Path 1/2用户context消耗从~715行降至~173行(无需加载SKILL.md)

消除重复: file_scope从3处→1处,git rollback从3处→1处(references统一),audit-repair展开从3处→1处+1处参数差异表,"never free-form analysis"只在persona一处声明。

### 4.3 问题类别解决方式

| 问题类别 | 占比 | 解决方式                     | 核心价值                            |
| -------- | ---- | ---------------------------- | ----------------------------------- |
| 职责越界 | ~60% | identity↔skill组织结构分离  | **可维护性改善**:identity层独立修改 |
| 重复冗余 | ~15% | 参数化差异表替代逐处展开     | **一致性改善**:一处修改全局生效     |
| 过度规格 | ~10% | prompt模板外部化到references | **context效率改善**:按需加载        |
| 概念混杂 | ~5%  | coordinator概念独立为skill   | **概念清晰**:路由vs执行分层         |

### 4.4 与已有skill的关系

| 已有skill                 | 是否需要修改 | 原因                                    |
| ------------------------- | ------------ | --------------------------------------- |
| deep-research             | 否           | worker仍通过skill_refs调用              |
| research-audit系列        | 否           | 同上                                    |
| literature-landscape-scan | 否           | 同上                                    |
| research-question-framing | 否           | 同上                                    |
| debate系列                | 否           | 同上                                    |
| autoresearch              | 否           | 同上                                    |
| health-check              | 否           | coordinator在session start调用,路径不变 |
| paper-search              | 否           | Path 1仍直接调用(从research.md)         |
| literature-review         | 否           | Path 2仍直接调用(从research.md)         |

---

## 5. 目标 research.md 详细设计

### 5.1 Frontmatter(保持原样,38行)

```yaml
---
description: Research mode — deep search, analysis, and verification
color: "#7C3AED"
mode: primary
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  external_directory: ask
  research_conventions_*: allow
  research_state_*: allow
mcp:
  research-conventions: true
  research-state: true
env_scope:
  denied_commands:
    - "git push --force*"
    - "git push -f*"
    - "git reset --hard*"
    - "git rebase -i*"
    - "git clean -fd"
    - "git checkout * -- ."
output_dir: ".aether/research"
file_scope:
  - ".aether/research/**"
---
```

### 5.2 系统约束(~12行,一处声明不重复)

```markdown
<system-reminder>
# Research Mode — HARD CONSTRAINTS

PERMITTED: read/glob/grep any file; edit/write within .aether/research
(enforced by file_scope); websearch/webfetch; knowledge_search; question;
todowrite; task; skill; bash (full access); MCP (research-conventions,
research-state).

FORBIDDEN: edit/write outside .aether/research (enforced by file_scope).
MUST NOT use bash commands to write files outside .aether/research —
the file_scope permission system only restricts write/edit tools, bash
is not restricted. You MUST self-enforce this constraint.

Never fabricate sources. (identity级硬约束 — 定义research agent的本质)
</system-reminder>
```

注: integrity声明采用分层方案: "fabricate sources"为identity级约束,只在research.md声明一处; "verification without evidence"和"override oracle"为instruction级约束,放在SKILL.md §General Rules中。SKILL.md中的引用声明"The research coordinator identity includes a fundamental commitment to never fabricating sources (declared in research.md §HARD CONSTRAINTS)"作为compaction安全网。

### 5.3 Persona(~5行)

```markdown
You are the research coordinator. You manage the research state machine,
dispatch research-worker subagents for each phase, and interact with the
user at checkpoint phases. Your communication style is concise and
professional. You never produce free-form analysis — all output follows
the state machine's structured templates and procedures.
```

### 5.4 Entry Gate(~68行,完整分类+Path 0/1/2处理)

```markdown
## ENTRY GATE — MANDATORY FIRST STEP

You MUST classify every user prompt through the Entry Gate BEFORE taking any other action. No research action, file reading, or subagent dispatch may occur until the gate is passed.

### Gate Procedure

1. Read `.aether/research/persistence/STATE.md` and `state.json` to check for an active project.
2. If STATE.md shows an active project (phase ≠ "not yet started"), skip classification — continue the existing workflow from the current phase.
3. If STATE.md shows no active project, classify the prompt intent:

### Classification Rules (deterministic)

| Condition                                                                                                                          | Path                            | Workflow                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| Single factual question answerable by one search (e.g. "What is FBI-DCT?")                                                         | **Path 1: Quick lookup**        | Invoke /paper-search skill directly, no subagents, no state machine |
| Explicitly requests literature survey (contains "综述", "review", "survey", "literature review")                                   | **Path 2: Literature review**   | Invoke /literature-review skill                                     |
| Contains research intent + multi-phase description, or requires feasibility analysis, method comparison, experimental verification | **Path 3: Research project**    | Invoke /research-coordinator skill for full state machine           |
| No research intent and not a factual lookup                                                                                        | **Path 0: Not a research task** | Inform user, suggest switching to build agent                       |

4. After classification, write the decision to STATE.md:
```

## Current Phase

gate → [path chosen]

## Classification

intent: [quick_lookup / literature_review / research_project / non_research]
path: [1 / 2 / 3 / 0]
reason: [brief justification]

```

5. Proceed to the chosen path's workflow. You MUST NOT take actions outside the chosen path.

### Gate Enforcement

- FORBIDDEN: Skipping the gate
- FORBIDDEN: Classifying as Path 1/2 then executing Path 3 actions
- FORBIDDEN: Classifying as Path 3 then dispatching explore, general, research-explorer, or verifiers directly — use research-worker only

### Path 0 (not research)

Inform user this is outside research scope; suggest switching to build agent. Reset STATE.md Current Phase to "not yet started".

### Path 1 (quick lookup)

Use /paper-search skill directly. Do NOT write ROADMAP.md, PLAN.md, or modify state.json. After answering, reset STATE.md Current Phase to "not yet started" and clear Classification.

### Path 2 (literature review)

Invoke /literature-review skill. Do NOT write Path 3 persistence files. After completion, reset STATE.md Current Phase to "not yet started" and clear Classification.
```

### 5.5 高层行为声明+Skill Invocation Mechanism(~30行)

```markdown
## Behavior Framework

### Path 3 Skill Invocation

For Path 3, invoke the /research-coordinator skill tool. The skill tool
returns SKILL.md content as a tool result — this content persists in
conversation history across turns until context compaction removes it.

### Skill Invocation Mechanism (applies to all paths)

**Compaction detection**: On each turn start, check whether you can recall
the Entry Gate classification result (path number + intent). If you cannot,
context compaction has likely removed skill content — re-invoke the
/research-coordinator skill tool (Path 3 only). For Path 1/2, re-classify
via Entry Gate (§5.4) since /paper-search and /literature-review are
invoked directly, not through research-coordinator skill.

**Re-invoke rule**: One re-invocation per turn is sufficient. No cascading re-invocations.

### Turn Termination

Every turn MUST end with exactly one Terminal Action:

1. **Dispatch** research-worker subagent → wait for worker return
2. **Ask user** via question tool → wait for user reply
3. **Present results** → output final text, no further action expected

These three categories have ZERO overlap. Every coordinator turn must reach exactly one of these.

FORBIDDEN: ending a turn without a Terminal Action. (Note: "never produce free-form analysis" is declared in persona above — not repeated here.)
```

### 5.6 硬约束(~10行)

```markdown
## Hard Constraints

- FORBIDDEN: skipping the Entry Gate
- FORBIDDEN: classifying as Path 1/2 then executing Path 3 actions
- FORBIDDEN: dispatching explore, general, research-explorer, or
  verifiers directly for Path 3 — use research-worker only
- FORBIDDEN: bypassing the state machine phases in order
- FORBIDDEN: editing/writing outside .aether/research via bash
- FORBIDDEN: ending a turn without a Terminal Action (dispatch/ask/present)
- Path 3: research-worker ONLY (with skill_refs for
  paper-search, health-check, debate-advocate, debate-critic,
  debate-adjudicator, debate-repair)
- Path 2: literature-review skill manages its own subagent dispatch

Note: "never produce free-form analysis" is an identity-level hard
constraint declared in persona (§5.3) — not repeated here per
one-declaration principle.
```

### 5.7 Session Start(~8行)

```markdown
## Session Start

On session start:

1. Execute Entry Gate classification (§5.4) if no active project
2. If Path 3: invoke /research-coordinator skill tool (per §Skill
   Invocation Mechanism), then execute §Session Start Procedure (§8
   of skill content) for health check → git check → state recovery
3. For crash/interrupt recovery, read references/session-recovery.md
```

### 5.8 目标文件总行数

| Section       | 原预估行数 | 实际行数 |
| ------------- | ---------- | -------- |
| Frontmatter   | 38         | 38       |
| 系统约束      | 12         | 12       |
| Persona       | 5          | 5        |
| Entry Gate    | 68         | 68       |
| 高层行为声明  | 30         | 37       |
| 硬约束        | 10         | 11       |
| Session Start | 8          | 8        |
| **总计**      | **~173**   | **178**  |

注: 178行超过MetaGPT参考值上限(150行)约28行,但Entry Gate是identity层内容而非冗余膨胀。178行仍在OpenHands参考值范围内(100-300行)。核心改善:从1762行降至178行,行数-90%。

---

## 6. research-coordinator skill 详细设计

### 6.1 文件结构

```
.aether/skills/research-coordinator/
  SKILL.md                           — 525行 (Path 3核心流程+用户交互规则)
  references/
    session-recovery.md               — 294行 (异常路径+crash recovery+relocate策略+health check digest processing)
    phase-routing.md                  — 229行 (条件路由决策——不一定每次触发的分支逻辑)
    phase-detail-tables.md            — 566行 (参数化表格+完整dispatch prompts+mapping+rollback协议)
```

### 6.2 SKILL.md Section 结构

| §   | 标题                            | 原预估行数 | 实际行数 | 内容来源(当前research.md行号)                      | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------- | ---------- | -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Path 3 State Machine Overview   | ~40        | ~35      | 114-297(精简)                                      | 状态机高层图+phase顺序列表(不展开条件分支——条件分支路由在references/phase-routing.md)。不含Phase Behavior Summary Table(与§2 Dispatch Table合并消除冗余)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | Coordinator Routing             | ~120       | ~90      | 366-442+400-414(精简)                              | Phase Dispatch Table(含phase名/skill/核心输出/routing摘要)+Dispatch Procedure(phase 1-7)+Digest Processing完整正常路径(YAML提取→parse→validate_file_locations MCP→if compliant: DIGESTS.md→advance_plan→git commit→Notice→route→Terminal Action; if non-compliant: read references/session-recovery.md §File Location Relocate)+State Consistency Check(digest processing后续步骤)+Phase routing rules精简版。流程骨架中:Notice步骤标注"模板见§7b";Checkpoint步骤标注"内容优先级见§7a, rollback见references/phase-routing.md §Checkpoint Rollback";异常处理标注"见references/session-recovery.md §Digest Parsing Fallback+Task Dispatch Failure" |
| 3   | Phase Transition Rules          | ~80        | ~40      | 320-364+1365-1371(各自保留)                        | Before/after entering phase+两处Phase skip rules各自保留(landscape skip条件表+全局skip禁令)+Git commit protocol。不含State Consistency Check(在§2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4a  | Audit-Repair通用机制            | ~80        | ~45      | 598-664(合并精简)                                  | 通用循环机制1处+Repair Pre-backup声明(3行)+参数差异引用references/phase-detail-tables.md §Audit-Repair。条件分支路由不展开——引用references/phase-routing.md §Audit-1 Routing / §Audit-2 Routing                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4b  | Audit-3特殊路由概述             | ~40        | ~15      | 675-878(高度精简)                                  | 4条分支概述+完整条件分支路由+dispatch prompts引用references/phase-routing.md §Audit-3 Routing+references/phase-detail-tables.md §Dispatch Prompts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | Debate Loop流程骨架             | ~80        | ~25      | 936-1162(高度精简)                                 | 5 sub_phase顺序+Repair Pre-backup声明(1行)+Sub-phase Output Verification(check_file_updated MCP)+引用references/phase-routing.md §Debate Sub-phase Routing+§Debate Round Termination+§Debate Error Handling+§Repair Digest Processing+§User Rejection Options。dispatch prompt模板移到references/phase-detail-tables.md                                                                                                                                                                                                                                                                                                                          |
| 6   | Execution Phase                 | ~40        | ~20      | 1250-1362(高度精简)                                | domain_mode概述+initial dispatch+digest routing概述。paused recovery+crash兜底移到references/phase-routing.md。domain_mode完整规则表+re-dispatch prompt模板移到references/phase-detail-tables.md                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | User Interaction & Output Rules | ~70        | ~90      | 459-503+1218-1249+900-914+1633-1732+986-1037(合并) | **§7a User Interaction Content Rules**:摘要内容优先级+LOW confidence选项文案+phase_checkpoint呈现结构+completed结果呈现。**§7b Output & Dispatch Rules**:Phase Progress Notice模板(5种)+phase_display_name mapping表+Debate Worker Prompt Injection(4种场景)                                                                                                                                                                                                                                                                                                                                                                                     |
| 8   | Session Start Procedure         | ~15        | ~11      | 1409-1460(正常路径)                                | Health check→git check→state read→恢复或分类。Entry Gate分类已在research.md中处理(§5.4),此处只处理Path 3的session恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -   | General Rules                   | ~55        | ~28      | 1585-1632+1626-1628(补充)                          | Output directory+Persistence directory conventions+Subagent dispatch rules+Convention Awareness(gpd-conventions MCP)+Integrity分层声明: identity级"fabricate sources"→research.md一处;instruction级→SKILL.md此处一处;引用声明"fabricate sources属identity级,见research.md §HARD CONSTRAINTS"作为compaction安全网                                                                                                                                                                                                                                                                                                                                 |

**总计: 525行** (原预估~542±30行。§2-§6比预估更精简,更多细节移入references/;§7比预估多~20行因Notice模板完整展开而非仅引用)

注: "原~860行"指当前research.md中将被迁移到SKILL.md的所有内容总行数(1762行减去保留在research.md的~173行,再减去将迁移到references/的~530行),而非一个已存在的文件。

| 减少来源                              | 原内容行数 | SKILL.md行数 | 移入文件                       | 说明                                                   |
| ------------------------------------- | ---------- | ------------ | ------------------------------ | ------------------------------------------------------ |
| §2 完整条件分支路由展开               | ~170       | ~120         | references/phase-routing.md    | 条件分支不一定每次触发,按需read                        |
| §4a+§4b audit_1/2/3完整条件路由展开   | ~150       | ~120         | references/phase-routing.md    | 同上                                                   |
| §5 Debate完整routing/error/recovery表 | ~155       | ~80          | references/phase-routing.md    | sub_phase routing表/termination表/error handling表按需 |
| §6 Execution paused+crash兜底         | ~60        | ~40          | references/phase-routing.md    | paused recovery不一定触发                              |
| §2 relocate修正操作                   | ~10        | 0(移出)      | references/session-recovery.md | 防御性修正,首次运行触发后通常不再需要                  |
| §7 Notice模板                         | ~80        | ~70          | —                              | phase_display_name mapping表保留在§7b                  |
| §General Rules                        | ~50        | ~55          | —                              | +5行补充Convention Awareness+persistence conventions   |
| §1 Entry Gate                         | ~68        | 0(移出)      | research.md §5.4               | Entry Gate是identity层,放在research.md                 |
| **合计**                              | **~860**   | **~542**     |                                |                                                        |

### 6.3 references/phase-routing.md 内容

此文件存放**不一定每次触发的条件路由决策**——coordinator仅在遇到特定digest字段组合时才需read此文件。与autoresearch references/edge-cases.md定位类似。

| Section                               | 原预估行数 | 实际行数 | 内容来源                                | 说明                                                                                                                                                  |
| ------------------------------------- | ---------- | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit-1 Routing (完整条件分支)        | ~20        | ~14      | 505-512                                 | 3条条件分支完整展开                                                                                                                                   |
| Audit-2 Routing (完整条件分支)        | ~15        | ~7       | 554-560                                 | 3条条件分支完整展开                                                                                                                                   |
| Audit-3 Routing (完整条件分支决策树)  | ~25        | ~50      | 675-688                                 | 4条主条件分支完整展开+LOW confidence 3-option文案+PoC Repair Sub-route+Landscape Supplement Sub-route+Infeasible Gap Marking                          |
| Checkpoint Rollback操作               | ~20        | ~30      | 478-486+1242-1248+1246-1248(MCP verify) | git rollback完整操作步骤+MCP state consistency verification(get_state→phase must match STATE.md)——含analysis_checkpoint和phase_checkpoint两种rollback |
| Debate Sub-phase Routing表            | ~10        | ~10      | 946-954                                 | 完整路由表含failed/retry处理                                                                                                                          |
| Debate Round Termination Conditions表 | ~10        | ~10      | 1166-1171                               | 3种termination条件完整表                                                                                                                              |
| Debate Error Handling表               | ~10        | ~10      | 1175-1181                               | 5种error scenario的detection+action完整表                                                                                                             |
| Repair Digest Processing两条路径      | ~15        | ~30      | 1185-1207                               | Path A(next round)和Path B(loop end→checkpoint)完整步骤                                                                                               |
| User Rejection Options                | ~10        | ~15      | 1234-1248                               | 3个选项+各自操作路径含round counter处理                                                                                                               |
| Execution Paused Recovery             | ~10        | ~18      | 1306-1345                               | paused digest处理+user decision+re-dispatch概述                                                                                                       |

**总计: 229行** (原预估~130±15行。超出原因:audit_3包含3个子路由完整展开,Checkpoint包含2种rollback,Repair Digest Processing/User Rejection有更多细节)

### 6.4 references/phase-detail-tables.md 内容

| Section                                 | 原预估行数 | 实际行数 | 内容来源                                                                                                   | 说明                                                                                                                                                                                             |
| --------------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase↔state.json Mapping               | ~25        | ~25      | 299-318                                                                                                    | 完整mapping表(含plan_number+Phase detection rule)                                                                                                                                                |
| Audit-Repair Phase-Specific Differences | ~30        | ~30      | 649-657                                                                                                    | 参数差异表(替代3处展开)                                                                                                                                                                          |
| Repair Pre-backup File Lists            | ~15        | ~25      | 515-520+562-570+689-699                                                                                    | 每种audit phase的repair target files具体备份路径列表                                                                                                                                             |
| Debate Repair Pre-backup                | ~5         | ~7       | 968-974                                                                                                    | PLAN.md.pre_repair_round{N}操作步骤                                                                                                                                                              |
| All Dispatch Prompt Templates           | ~250       | ~330     | 524-543+574-595+704-749+936-963+1052-1127+766-781+794-821+840-878+1270-1290+1327-1343+488-503+149-151(注1) | 含3种audit repair+framing retry+landscape supplement+PoC question+debate 5 sub_phase+execution+execution re-dispatch+analysis_checkpoint rollback re-dispatch+landscape audit_1 injection prompt |
| Domain Mode Determination               | ~15        | ~15      | 1254-1264                                                                                                  | domain_mode完整规则表                                                                                                                                                                            |
| Git Rollback Protocol(统一)             | ~25        | ~25      | 480-486+1242-1248+1452+443-457                                                                             | 统一rollback操作步骤+State Consistency Check的rollback操作                                                                                                                                       |
| State Consistency Check(完整)           | ~15        | ~15      | 443-457                                                                                                    | 完整一致性检查+rollback步骤                                                                                                                                                                      |
| Phase Display Name Mapping              | ~15        | ~15      | 1669-1681                                                                                                  | state.json phase→phase_display_name映射表                                                                                                                                                        |
| Persistence Directory Conventions       | ~20        | ~20      | 1596-1616                                                                                                  | audits/命名规则+literatures/结构                                                                                                                                                                 |

注1: 488-503为analysis_checkpoint rollback后的re-dispatch prompt模板,149-151为landscape worker的audit_1 findings注入prompt。原936-1127范围已去重拆分为936-963和1052-1127。

**总计: 566行** (原预估~425±30行。超出原因:Dispatch Prompts部分~330行而非预估~250行,含更多完整prompt模板如focused round template+analysis_checkpoint re-dispatch+landscape injection)

### 6.5 references/session-recovery.md 内容

| Section                           | 原预估行数 | 实际行数 | 内容来源      | 说明                                                                          |
| --------------------------------- | ---------- | -------- | ------------- | ----------------------------------------------------------------------------- |
| Phase-Specific Crash Recovery     | ~40        | ~72      | 1464-1500     | 6种phase分支crash恢复+Git consistency check                                   |
| Repair Crash Recovery (audit)     | ~10        | ~20      | 926-934       | repair worker crash→restore backup→retry+Debate Repair Crash Recovery         |
| Health Check Digest Processing    | ~20        | ~27      | 1520-1540     | pass/degraded/failed三种处理路径+env-setup per-item authorization             |
| STATE.md Format Templates         | ~15        | ~30      | 1542-1567     | STATE.md格式规范+Health Status Format+Next Action Update Rules                |
| User-Triggered Health Check       | ~15        | ~15      | 1505-1518     | 用户触发health check(不更新Next Action)                                       |
| LLM-only Mode Behavior            | ~10        | ~45      | 1569-1577     | uv不可用时的降级行为+Tier 0/Tier 0.5/Tier 1-3完整步骤+Migrate temp files      |
| Digest Parsing Fallback           | ~30        | ~20      | 1372-1401     | YAML解析失败的处理(INCOMPLETE/MISSING/COMPLETED_FALLBACK)                     |
| Task Dispatch Failure             | ~10        | ~8       | 1395-1401     | 3次dispatch失败后终止                                                         |
| File Location Relocate            | ~25        | ~38      | 404-405(扩展) | validate_file_locations non-compliant修正策略(嵌套/外域/非白名单)+re-call确认 |
| STATE.md Health Status Format     | ~15        | (合并)   | 1542-1556     | Health Status section格式(合并到STATE.md Format Templates)                    |
| STATE.md Next Action Update Rules | ~10        | (合并)   | 1557-1567     | 各场景下的Next Action规则(合并到STATE.md Format Templates)                    |

**总计: 294行** (原预估~200±20行。超出原因:LLM-only Mode含完整3-tier分层+temp migration流程;Health Check含env-setup授权流程;Phase-Specific Crash Recovery含Git consistency check)

### 6.6 与 autoresearch skill 的 references 模式对齐

| 对齐维度                                 | autoresearch                        | research-coordinator(实际) |
| ---------------------------------------- | ----------------------------------- | -------------------------- |
| SKILL.md核心流程                         | 213行                               | 525行                      |
| references/按需细节                      | 683行(3个文件)                      | 1089行(3个文件)            |
| 总计                                     | 896行                               | 1614行                     |
| SKILL.md是否包含session recovery正常路径 | 否(autoresearch不处理session start) | 是(~11行)                  |
| references/是否包含异常路径              | 是(edge-cases.md)                   | 是(session-recovery.md)    |
| references/是否包含条件路由决策          | 是(edge-cases.md决策表)             | 是(phase-routing.md)       |

注: research-coordinator总计(1614行)高于autoresearch(896行),这是合理的:coordinator管理10个phase的状态机+3条audit路径+debate多轮循环+4条audit-3特殊分支+session recovery+checkpoint交互。references/更完整的原因:audit_3含3个子路由完整展开(PoC/Landscape Supplement/Infeasible),Health Check含3-tier分层+temp migration,Dispatch Prompts含更多完整模板。

### 6.7 Audit-Repair 合并示例(3处→1处)

当前research.md中audit-repair机制在audit_1、audit_2、audit_3各展开一次,总计约250行。差异仅在:

| 维度          | audit_1                   | audit_2                      | audit_3                              |
| ------------- | ------------------------- | ---------------------------- | ------------------------------------ |
| Audit targets | ROADMAP+research_analysis | +landscape_map               | framing_reasoning+PLAN+rq            |
| Audit scope   | light(citation)           | full(citation+domain+method) | reasoning chain+dependency           |
| Audit skill   | /research-audit           | /research-audit              | /research-audit-reasoning            |
| Repair files  | ROADMAP+research_analysis | +landscape_map               | +reasoning+PLAN+rq+ROADMAP+landscape |
| Repair skill  | /research-audit-repair    | /research-audit-repair       | /research-audit-repair-reasoning     |
| Next phase    | framing(或landscape)      | framing                      | debate(或framing)                    |
| plan_number   | 3                         | 5                            | 7                                    |

**合并后**: SKILL.md中通用机制(~40行) + references/phase-detail-tables.md中参数差异表(~30行) = ~70行,替代250行,减少72%。

```
1. Dispatch audit worker → returns audit digest (issues_found, has_citation_gaps / has_structural_incompleteness)
2. issues_found=0 → advance_plan to next phase → git commit → Notice → Terminal Action
3. issues_found>0 + repair_count<3 → dispatch repair worker (read references/phase-detail-tables.md §Audit-Repair for phase-specific parameters)
4. repair returns → re-dispatch audit worker (audit_round incremented)
5. Repeat 2-4 until issues_found=0 or repair_count=3
6. repair_count=3 + issues_found>0 → mark unresolved → advance_plan → git commit → Notice → Terminal Action
```

---

## 7. 逐行迁移映射表

### 7.1 research.md → 目标 research.md

| 当前行号                  | 内容                                             | 目标去向                                                                                                                                              |
| ------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-38                      | Frontmatter                                      | **保留原位**(research.md)                                                                                                                             |
| 40-46                     | 系统约束(HARD CONSTRAINTS)                       | **保留**(精简为~12行,一处声明)                                                                                                                        |
| 47-99                     | Entry Gate                                       | **保留原位**(research.md §5.4,完整展开)                                                                                                               |
| 101-111                   | Path 1/2描述                                     | **保留原位**(research.md §5.4 Path 0/1/2子节)                                                                                                         |
| 113-297                   | Path 3 State Machine(完整图)                     | → coordinator SKILL.md §1(精简版~40行,只保留高层图+phase顺序)                                                                                         |
| 299-318                   | Phase↔state.json Mapping                        | → references/phase-detail-tables.md §Phase↔state.json Mapping                                                                                        |
| 320-364                   | Phase Transition Rules                           | → coordinator SKILL.md §3(含两处skip rules各自保留)                                                                                                   |
| 366-442                   | Coordinator Routing+Dispatch+Digest              | → coordinator SKILL.md §2(精简~120行,relocate移出正常路径至references/session-recovery.md)                                                            |
| 149-151(嵌在状态机图注释) | landscape worker的audit_1 findings注入prompt     | → references/phase-detail-tables.md §Dispatch Prompts                                                                                                 |
| 1372-1401                 | Digest Parsing Fallback + Task Dispatch Failure  | → references/session-recovery.md §Digest Parsing Fallback+Task Dispatch Failure                                                                       |
| 404-405                   | validate_file_locations relocate修正             | → references/session-recovery.md §File Location Relocate(SKILL.md §2正常路径只保留validate+if-compliant分支,non-compliant分支引用此处)                |
| 443-457                   | State Consistency Check                          | → coordinator SKILL.md §2(digest processing后续)+references/phase-detail-tables.md §State Consistency Check                                           |
| 459-473+476-487           | analysis_checkpoint(摘要呈现+rollback路由)       | → coordinator SKILL.md §7a+references/phase-routing.md §Checkpoint Rollback                                                                           |
| 488-503                   | analysis_checkpoint rollback re-dispatch prompt  | → references/phase-detail-tables.md §Dispatch Prompts                                                                                                 |
| 505-553                   | Audit-1 routing                                  | → coordinator SKILL.md §4a+references/phase-routing.md §Audit-1 Routing                                                                               |
| 554-596                   | Audit-2 routing                                  | → coordinator SKILL.md §4a+references/phase-routing.md §Audit-2 Routing                                                                               |
| 675-878                   | Audit-3 routing + framing retry + LOW confidence | → coordinator SKILL.md §4b+references/phase-routing.md §Audit-3 Routing+§7a(LOW confidence)+§7b(audit_3 prompt injection)+references/dispatch prompts |
| 879-914                   | Infeasible + LOW confirmation文案                | → coordinator SKILL.md §7a+references/phase-routing.md §Audit-3 Routing                                                                               |
| 936-1182                  | Debate Loop完整routing/error/recovery            | → coordinator SKILL.md §5+references/phase-routing.md                                                                                                 |
| 1218-1249                 | phase_checkpoint                                 | → coordinator SKILL.md §7a+references/phase-routing.md §Checkpoint Rollback+§User Rejection Options                                                   |
| 1250-1362                 | Execution Phase                                  | → coordinator SKILL.md §6+references/phase-routing.md+references/phase-detail-tables.md                                                               |
| 1633-1732                 | Phase Progress Notice                            | → coordinator SKILL.md §7b                                                                                                                            |
| 1626-1628                 | Convention Awareness                             | → coordinator SKILL.md §General Rules                                                                                                                 |
| 1596-1616                 | Persistence directory conventions                | → coordinator SKILL.md §General Rules+references/phase-detail-tables.md §Persistence Directory Conventions                                            |
| 1736-1762                 | Turn Termination                                 | → 目标research.md §5.5(高层行为声明)                                                                                                                  |

### 7.2 删除的重复内容

| 重复内容          | 出现位置                                                          | 处理方式                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| file_scope自约束  | 第43-45行+第1585-1594行+frontmatter                               | 保留一处(research.md §系统约束)。frontmatter权限层强制与system-reminder行为层自约束互补,非重复                                               |
| git rollback模式  | 第480-486行+第1242-1248行+第1452行+第443-457行(State Consistency) | 合并到references/phase-detail-tables.md §Git Rollback Protocol+§State Consistency Check+references/phase-routing.md §Checkpoint Rollback     |
| audit-repair展开  | 第505-553行+第554-596行+第675-749行                               | 合并为通用机制(§4a)+参数差异表(references/phase-detail-tables.md)+条件路由(references/phase-routing.md)                                      |
| Phase Skip Rules  | 第353-368行+第1365-1371行                                         | 两处各自保留在SKILL.md §3:前者为landscape skip条件判断表,后者为全局skip禁令,二者内容不同非纯重复                                             |
| Integrity声明     | 第45行("fabricate sources")+第1629-1631行(3条integrity)           | 分层声明: identity级"fabricate sources"→research.md一处;instruction级→SKILL.md §General Rules一处;SKILL.md中添加引用声明作为compaction安全网 |
| "never free-form" | 当前源文件仅1处(第1755行)                                         | 一处声明原则:只在persona(§5.3)声明                                                                                                           |
| skill invocation  | 原方案4处重复声明                                                 | 一处声明:research.md §Skill Invocation Mechanism(§5.5),§5.2和§5.7只引用此section                                                             |

---

## 8. 不修改的部分

| 文件                                 | 原因                                     |
| ------------------------------------ | ---------------------------------------- |
| `.aether/agent/research-worker.md`   | 已是合理的294行subagent定义,不需要修改   |
| `.aether/agent/research-explorer.md` | 已是合理的120行,不需要修改               |
| `.aether/agent/research-verifier.md` | 已是合理的60行,不需要修改                |
| `.aether/agent/gpd-verifier.md`      | 已是合理的77行,不需要修改                |
| `.aether/agent/local-executor.md`    | 已是合理的289行,不需要修改               |
| `.aether/agent/gpd-reviewer.md`      | 已是合理的40行,不需要修改                |
| 所有现有skill SKILL.md               | 调用路径不变(worker仍通过skill_refs调用) |
| MCP server源码                       | 零改动                                   |
| 核心源文件                           | 零改动                                   |

---

## 9. 验收清单

### 9.1 research.md 验收

| #   | 检查项           | 标准                                                                                                                      |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | 总行数           | ≤ 190行(实际178行)                                                                                                        |
| 2   | Frontmatter完整  | 所有原字段保留                                                                                                            |
| 3   | 系统约束一处声明 | file_scope+bash自约束+"fabricate sources"只出现1次;instruction级integrity在SKILL.md §General Rules声明                    |
| 4   | Persona ≤ 5行    | 只含身份+风格+"never free-form analysis"硬约束,不含内容判断力                                                             |
| 5   | Entry Gate完整   | 分类规则+enforcement+Path 0/1/2完整处理(不引用skill,直接在research.md中执行)                                              |
| 6   | Path路由         | Path 0/1/2在research.md中直接处理;Path 3 invoke /research-coordinator skill                                               |
| 7   | Skill Invocation | §Skill Invocation Mechanism一处声明(含compaction检测机制),§5.2和§5.7只引用此section                                       |
| 8   | Turn Termination | 3种Terminal Action声明完整,含"ZERO overlap"约束声明+Required Intermediate Steps说明                                       |
| 9   | 硬约束完整       | 6条FORBIDDEN完整+2条非FORBIDDEN格式约束(Path 3 subagent+Path 2),含note说明"never free-form analysis"在persona已声明不重复 |
| 10  | Session Start    | 不展开recovery流程,引用Entry Gate(§5.4)和skill invocation(§5.5)                                                           |
| 11  | 无重复声明       | 同一规则不出现2次以上(含"never free-form analysis"只在persona一处,skill invocation只在§5.5一处)                           |

### 9.2 research-coordinator skill 验收

| #   | 检查项                             | 标准                                                                                                                                                                                                                                                  |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SKILL.md行数                       | ≤ 650行(实际525行)                                                                                                                                                                                                                                    |
| 2   | §1 State Machine                   | 高层图+phase顺序完整(不展开条件分支,不含Entry Gate——Entry Gate在research.md §5.4)                                                                                                                                                                     |
| 3   | §2 Coordinator Routing             | Phase Dispatch Table+Digest Processing正常路径(validate→if compliant: advance→commit→Notice→route; if non-compliant: read references/session-recovery.md §File Location Relocate)+State Consistency Check+Phase routing rules精简版。交叉引用标注完整 |
| 4   | §3 Phase Transition                | 两处Phase skip rules各自保留(landscape条件表+全局禁令)+Git commit protocol                                                                                                                                                                            |
| 5   | §4a Audit-Repair通用机制           | 通用循环机制1处+Repair Pre-backup声明(3行)+参数差异引用references/phase-detail-tables.md §Audit-Repair。条件分支引用references/phase-routing.md                                                                                                       |
| 6   | §4b Audit-3特殊路由概述            | 4条分支概述+完整条件分支+dispatch prompts引用references/phase-routing.md+references/phase-detail-tables.md                                                                                                                                            |
| 7   | §5 Debate Loop流程骨架             | 5 sub_phase顺序+Repair Pre-backup声明+Sub-phase Output Verification+引用references/phase-routing.md                                                                                                                                                   |
| 8   | §6 Execution Phase概述             | domain_mode概述+initial dispatch+digest routing概述。paused+crash引用references/phase-routing.md                                                                                                                                                      |
| 9   | §7 User Interaction & Output Rules | **§7a**:摘要优先级+LOW confidence文案+checkpoint呈现结构+completed结果呈现。**§7b**:5种Notice模板+phase_display_name mapping+4种Debate Worker Prompt Injection                                                                                        |
| 10  | §8 Session Start                   | 正常路径(~11行)完整+skill生命周期说明。Entry Gate分类已在research.md,此处只处理Path 3 session恢复                                                                                                                                                     |
| 11  | General Rules                      | 输出目录+Persistence conventions+子agent规则+Convention Awareness+Integrity分层声明                                                                                                                                                                   |
| 12  | §2↔§7交叉引用                     | §2流程中Notice步骤标注"模板见§7b",Checkpoint步骤标注"内容优先级见§7a, rollback见references/phase-routing.md §Checkpoint Rollback",LOW confidence标注"选项文案见§7a,路由见references/phase-routing.md §Audit-3 Routing"                                |
| 13  | 无重复声明                         | 同一规则不出现2次以上                                                                                                                                                                                                                                 |
| 14  | 不含Entry Gate                     | SKILL.md不含Entry Gate分类规则(已在research.md §5.4)                                                                                                                                                                                                  |

### 9.3 references/ 验收

| #   | 检查项                 | 标准                                                                                                                                                                                                                                |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | session-recovery.md    | §Phase-Specific Crash Recovery(6种分支)完整                                                                                                                                                                                         |
| 2   | session-recovery.md    | §Repair Crash Recovery (audit phases)完整                                                                                                                                                                                           |
| 3   | session-recovery.md    | §Digest Parsing Fallback + Task Dispatch Failure完整                                                                                                                                                                                |
| 4   | session-recovery.md    | §Health Check Digest Processing完整                                                                                                                                                                                                 |
| 5   | session-recovery.md    | §STATE.md Format Templates完整                                                                                                                                                                                                      |
| 6   | session-recovery.md    | §User-Triggered Health Check完整                                                                                                                                                                                                    |
| 7   | session-recovery.md    | §LLM-only Mode完整                                                                                                                                                                                                                  |
| 8   | session-recovery.md    | §File Location Relocate完整(nested/outside/persistence_non_whitelisted修正策略+re-call确认)                                                                                                                                         |
| 9   | phase-routing.md       | §Audit-1 Routing(3条条件分支)完整                                                                                                                                                                                                   |
| 10  | phase-routing.md       | §Audit-2 Routing(3条条件分支)完整                                                                                                                                                                                                   |
| 11  | phase-routing.md       | §Audit-3 Routing(4条分支决策树+LOW confidence 3-option文案)完整                                                                                                                                                                     |
| 12  | phase-routing.md       | §Checkpoint Rollback操作(git命令完整步骤+MCP state consistency verification)完整                                                                                                                                                    |
| 13  | phase-routing.md       | §Debate Sub-phase Routing表完整                                                                                                                                                                                                     |
| 14  | phase-routing.md       | §Debate Round Termination Conditions表完整                                                                                                                                                                                          |
| 15  | phase-routing.md       | §Debate Error Handling表完整                                                                                                                                                                                                        |
| 16  | phase-routing.md       | §Repair Digest Processing两条路径完整                                                                                                                                                                                               |
| 17  | phase-routing.md       | §User Rejection Options(3个选项+各自操作路径)完整                                                                                                                                                                                   |
| 18  | phase-routing.md       | §Execution Paused Recovery完整                                                                                                                                                                                                      |
| 19  | phase-detail-tables.md | Phase↔state.json Mapping表完整(含plan_number+Phase detection rule)                                                                                                                                                                 |
| 20  | phase-detail-tables.md | Audit-Repair参数差异表完整(3种audit)                                                                                                                                                                                                |
| 21  | phase-detail-tables.md | Repair Pre-backup File Lists完整(3种audit phase的具体备份路径)                                                                                                                                                                      |
| 22  | phase-detail-tables.md | Debate Repair Pre-backup完整(PLAN.md备份操作)                                                                                                                                                                                       |
| 23  | phase-detail-tables.md | All Dispatch Prompt Templates完整(含3种audit repair+framing retry+landscape supplement+PoC question+debate 5 sub_phase+execution+execution re-dispatch+analysis_checkpoint rollback re-dispatch+landscape audit_1 injection prompt) |
| 24  | phase-detail-tables.md | Domain Mode规则完整                                                                                                                                                                                                                 |
| 25  | phase-detail-tables.md | Git Rollback Protocol统一(含State Consistency Check rollback)替代3处重复                                                                                                                                                            |
| 26  | phase-detail-tables.md | State Consistency Check完整(一致性检查+rollback步骤)                                                                                                                                                                                |
| 27  | phase-detail-tables.md | Phase Display Name Mapping完整(state.json phase→display name+dynamic parameter)                                                                                                                                                     |
| 28  | phase-detail-tables.md | Persistence Directory Conventions完整(audits/命名规则+literatures/结构)                                                                                                                                                             |

### 9.4 信息完整性验收

| #   | 检查项                    | 标准                                                                                                                                     |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 原research.md所有信息保留 | 逐行映射表覆盖所有1762行                                                                                                                 |
| 2   | 无信息丢失                | 每个功能点在新结构中有明确归属                                                                                                           |
| 3   | 调用路径不变              | Path 1→paper-search(从research.md直接调用); Path 2→literature-review(从research.md直接调用); Path 3→research-coordinator→research-worker |
| 4   | worker dispatch不变       | research-worker skill_refs+PhaseResultDigest格式不变                                                                                     |

### 9.5 运行验证

| #   | 检查项                | 方法                                                                        |
| --- | --------------------- | --------------------------------------------------------------------------- |
| 1   | research.md加载无报错 | 启动opencode,选择research mode,确认agent加载成功                            |
| 2   | Entry Gate分类正确    | 测试4种prompt(quick lookup/literature review/research project/non-research) |
| 3   | Path 1/2无需加载skill | Path 1直接调用paper-search,Path 2直接调用literature-review,不加载SKILL.md   |
| 4   | Path 3完整流程        | 执行一个简单research项目,验证从analysis到completed完整流程                  |
| 5   | Session Recovery正常  | 中断一个active project,重启session,验证恢复到正确phase                      |
| 6   | Checkpoint交互质量    | analysis_checkpoint+phase_checkpoint输出摘要质量(内容判断力规则生效)        |
| 7   | Notice输出格式        | 各phase Progress Notice格式正确                                             |
| 8   | File relocate         | 首次运行触发validate_file_locations non-compliant时,修正策略正确执行        |
