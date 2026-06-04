# Research Agent v2: 5-Layer Reconstruction Plan

> 基线版本: v0.6.0 (commit c79260d6a)
> 本文档是总览，指向 5 个独立的 Layer 文档。
> 替代此前所有 agent 设计文档（custom-agent-modes-design.md、parallel-agents-unified-design.md 等）。

---

## 架构概览

```
Layer 0: Core Security Enhancement ─── 所有用户受益
  Permission.intersection, Discipline.compile, Agent.Info扩展, skill_refs注入
  ↓
Layer 1: Agent Infrastructure ─── 通用 agent 模式创建
  mode-switch, fallback_models, background执行, prompt模式切换, MCP per-agent
  ↓
Layer 2: Research Config Layer ─── 零核心源改动
  agent md (research/research-explorer/gpd-verifier/gpd-reviewer) + skill md (多模式)
  ↓
Layer 3: Research Infrastructure ─── MCP服务器 + 参考文档
  gpd-verification MCP (灵活验证方案), gpd-conventions MCP, gpd-errors MCP
  物理验证bundle示例 (从GPD cherry-pick), 自定义检查开发者指南
  ↓
Layer 4: Publication Pipeline ─── 完全独立
  write-paper, peer-review, respond-to-referees (subagent + skill)
```

---

## Layer 文档

| Layer       | 文档                                 | 核心源文件改动                                                                                                                                                                                                 | 配置层文件                                                                                                         |
| ----------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Layer 0** | `layer-0-core-security.md`           | permission/index.ts (+intersection), session/discipline.ts (新), tool/task.ts (参数扩展), agent/agent.ts (Info扩展), session/system.ts (skill_refs), config/config.ts (Agent schema)                           | 无                                                                                                                 |
| **Layer 1** | `layer-1-agent-infrastructure.md`    | tool/mode-switch.ts (新), session/background.ts (新), session/concurrency.ts (新), tool/background-output.ts (新), session/prompt.ts (agent切换分支), session/processor.ts (fallback), tool/registry.ts (注册) | 无                                                                                                                 |
| **Layer 2** | `layer-2-research-config.md`         | **零**                                                                                                                                                                                                         | .opencode/agents/research.md, research-explorer.md, gpd-verifier.md, gpd-reviewer.md + .opencode/skills/ 11个skill |
| **Layer 3** | `layer-3-research-infrastructure.md` | **零**                                                                                                                                                                                                         | MCP服务器Python模块 + .opencode/get-physics-done/ 参考文档/数据文件                                                |
| **Layer 4** | `layer-4-publication-pipeline.md`    | **零**                                                                                                                                                                                                         | .opencode/agents/gpd-paper-writer.md, gpd-referee.md + .opencode/skills/ 3个skill                                  |

---

## 关键设计决策

### Research Agent 多模式设计（替代旧版巨型 prompt）

旧版 research.md 包含 300+ 行 prompt_append 嵌入完整 6-phase 工作流。新版:

- Research agent 定义文件约 50 行 prompt_append（核心约束 + 模式路由指引）
- 具体工作流通过 skill_refs 引用独立 skill: deep-research、autoresearch、literature-review、execute-docker
- Integrity Commandments 移入 research-explorer subagent 的 prompt_append（不再嵌入主 agent）
- scale_decision 通过 Layer 0 的 system.ts 注入（不再嵌入 prompt）

### 灵活验证方案（替代硬编码验证清单）

旧版 verifier agent 在 prompt 中硬编码验证步骤。新版:

- verifier agent 使用 gpd-verification MCP 工具（suggest_contract_checks、run_contract_check、run_check）
- 检查内容由数据文件定义（check_registry.json、bundles/\*.json），用户可修改
- 用户可以添加自定义检查（custom_checks/ 目录 + 注册到 check_registry.json）
- 用户可以替换整个 MCP 服务器（保持相同 tool interface，不同实现）

### Cherry-pick 验证（与 GPD 项目保持一致）

每个从 GPD cherry-pick 的数据文件包含 `gpd_source` 字段:

```json
{
  "gpd_source": {
    "repo": "psi-oss/get-physics-done",
    "path": "GPD源文件路径",
    "commit": "待钉定的具体commit hash",
    "cherry_pick_method": "semantic_equivalence"
  }
}
```

语义等价而非逐字复制: GPD 使用 Python 模块，我们使用 JSON 数据格式 + MCP 服务器读取。验证维度、红旗项、标准基准与 GPD 对应文件完全一致。

### 子代理命名变更

| 旧名称     | 新名称                | 原因                                                                |
| ---------- | --------------------- | ------------------------------------------------------------------- |
| researcher | **research-explorer** | 与 explore agent 的命名风格一致，更准确描述其角色（探索性证据收集） |

---

## 完整验收总清单

### Layer 0 验收

1. bun typecheck 通过
2. intersection(parent deny, child allow) → deny
3. compileDiscipline deny-before-allow 顺序正确
4. 不设新字段时 native agent 行为不变
5. env_scope.allowed_commands 编译为 bash deny + specific allow

### Layer 1 验收

6. build/plan 切换不受影响
7. research_enter 工具可用
8. fallback_models 降级正确
9. background mode spawn + output 正确
10. MCP per-agent activate/deactivate 正确

### Layer 2 验收

11. research mode 可通过 /research_enter 进入
12. skill_refs whitelist 生效（只看到指定 skills）
13. research-explorer subagent 可调用
14. gpd-verifier 使用 MCP 工具
15. 删除 research 配置文件后核心行为不变

### Layer 3 验收

16. gpd-verification MCP 服务器可用
17. 自定义检查可通过 custom_checks/ + check_registry.json 添加
18. qft.json 与 GPD verification-domain-qft.md 语义等价
19. gpd-conventions MCP 可读写约定锁定
20. MCP 服务器独立运行，不影响核心

### Layer 4 验收

21. write-paper skill 在 build mode 可调用
22. gpd-paper-writer subagent 可调用
23. respond-to-referees 三部分结构正确
24. journal templates 可用

### 回退安全

25. 删除所有 Layer 2-4 配置文件 + MCP 配置后，行为与 v0.6.0 一致
26. Layer 0-1 的核心源文件改动可通过删除新增代码恢复 v0.6.0 行为
