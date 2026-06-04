# Research Agent v2: 6-Layer Reconstruction Plan

> 基线版本: v0.6.0 (commit c79260d6a)
> 本文档是总览，指向 6 个独立的 Layer 文档。
> 替代此前所有 agent 设计文档（custom-agent-modes-design.md、parallel-agents-unified-design.md 等）。

---

## 架构概览

```
Layer 0: Core Security Enhancement ─── 所有用户受益
  Permission.intersection, Discipline.compile, Agent.Info扩展, skill_refs注入
  ↓
Layer 1: Agent Infrastructure ─── 通用 agent 模式支持
  fallback_models, output_dir注入, MCP per-agent, denied tools优化
  ↓
Layer 2: Research Config Layer ─── 零核心源改动
  agent md (research/research-explorer/research-verifier/gpd-verifier/gpd-reviewer) + skill md (多模式)
  ↓
Layer 3: Research Infrastructure ─── 双层命名: research-* (通用框架) + gpd-* (物理插件)
  research-* MCP (state, conventions 框架) + research-* skills (verification 程序框架)
  gpd-* skills (物理计算 scripts, 错误目录, 领域 bundles, 约定默认值)
  参考文档 (从GPD cherry-pick), 自定义检查开发者指南
  ↓
Layer 4: Publication Pipeline ─── 完全独立
  write-paper, peer-review, respond-to-referees (subagent + skill)
  ↓
Layer 5: Background Execution ─── 独立层（可延后实现）
  异步spawn + 信号注入 + 结果取回 + SQLite持久化
```

---

## Layer 文档

| Layer       | 文档                                 | 核心源文件改动                                                                                                                                                                                                                                                                      | 配置层文件                                                                                                                                        |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Layer 0** | `layer-0-core-security.md`           | permission/index.ts (+intersection), session/discipline.ts (新), tool/task.ts (参数扩展+权限重构+2新import+移除手工拼接代码块), agent/agent.ts (Info扩展+1新import,不含base_agent), session/system.ts (skill_refs追加), config/config.ts (Agent schema+knownKeys+Info.category字段) | 无                                                                                                                                                |
| **Layer 1** | `layer-1-agent-infrastructure.md`    | permission/index.ts (+EDIT_TOOLS export), session/system.ts (outputDir函数), tool/task.ts (fallback+promptWithFallback), config/config.ts (mcp+output_dir字段), agent/agent.ts (mcp+outputDir字段+merge), session/prompt.ts (outputDir调用+MCP过滤+denied过滤)                      | 无                                                                                                                                                |
| **Layer 2** | `layer-2-research-config.md`         | **零**                                                                                                                                                                                                                                                                              | agents/research.md, research-explorer.md, research-verifier.md, gpd-verifier.md, gpd-reviewer.md (flat + prefix) + skills (多模式, plugins/ 隔离) |
| **Layer 3** | `layer-3-research-infrastructure.md` | **零**                                                                                                                                                                                                                                                                              | research-_ MCP (state, conventions) + research-_ skills (通用) + gpd-\* skills in plugins/gpd/ (物理插件隔离) + 参考文档                          |
| **Layer 4** | `layer-4-publication-pipeline.md`    | **零**                                                                                                                                                                                                                                                                              | .aether/agent/gpd-paper-writer.md, gpd-referee.md + .aether/skill/ 3个skill                                                                       |
| **Layer 5** | `layer-5-background-execution.md`    | session/background.ts (新), session/background.sql.ts (新), tool/background-output.ts (新), tool/task.ts (background分支), tool/registry.ts (+background_output), session/projectors.ts (+2 projector+修改现有Session.Delete函数体追加清理)                                         | 无                                                                                                                                                |

---

## 关键设计决策

### Research Agent 多模式设计（替代旧版巨型 prompt）

旧版 research.md 包含 300+ 行 prompt_append 嵌入完整 6-phase 工作流。新版:

- Research agent 定义文件约 50 行 prompt_append（核心约束 + 模式路由指引 + Scale Decision 文本）
- 具体工作流通过 skill_refs 引用独立 skill: deep-research、autoresearch、literature-review、execute-docker
- Integrity Commandments 移入 research-explorer subagent 的 prompt_append（不再嵌入主 agent）
- scale_decision 作为 prompt_append 内文本（不再需要核心代码注入，零核心文件改动）

### 不使用 base_agent 继承

原方案包含 `base_agent` 字段用于 agent 间继承（如 research 继承 explore 的 permission/model/prompt）。经分析后去掉，原因：

1. 只涉及 4 个 research 系 agent，手动声明 permission 的成本很低
2. explore 的 permission 不太会频繁变动，手动复制不会造成维护负担
3. 去掉后 agent.ts 的改动从"带继承和编译的复杂合并"降为"逐字段赋值"，侵入性显著降低
4. 如果未来需要继承，可作为独立改动单独引入

Layer 2 的 research 系 agent 需手动声明 permission，参考 explore 的 permission 规则。

### skill_refs 替换广播（而非追加）

原方案在有 skillRefs 的 agent 中追加广播式 skill 列表之后。新方案改为**替换**：有 skillRefs 时只注入指定的 skill 完整内容，不再返回广播列表。这确保：

- 无 skillRefs 时输出与 v0.6.0 完全一致（广播路径不变）
- 有 skillRefs 时只包含指定的 skill 内容，减少 context window 噪声
- 函数主路径逻辑简洁：有 skillRefs → 返回注入；无 skillRefs → 返回广播

### 灵活验证方案（替代硬编码验证清单 + 替代 GPD 的纯指引型 MCP）

旧版 verifier agent 在 prompt 中硬编码验证步骤。GPD 用 MCP 服务器返回指引文本但**不做真实物理计算**（仅关键词扫描）。新版:

- verifier agent 使用 **skill_refs** 获取验证程序（SKILL.md 注入行为指引）
- verifier agent 使用 **scripts**（附在 skills 中）执行确定性物理计算（SymPy 维度追踪、极限推导、Ward 恒等式验证等）
- MCP 仅保留**持久状态管理**（约定锁读写、项目状态推进、原子性操作）
- 检查内容由数据文件定义（check_registry.json、bundles/\*.json），用户可修改
- 用户可以添加自定义检查（custom_checks/ 目录 + 注册到 check_registry.json）
- 用户可以替换 skill 和 scripts（保持相同 SKILL.md 格式，不同计算实现）

**与 GPD 的关键差异**: GPD 的 verification MCP 工具只返回指引文本和关键词扫描结果，物理验证依赖 LLM 自己写 SymPy 代码。我们的 scripts 做**确定性计算**——维度追踪用 SymPy 解析表达式而非预标注括号，极限推导用 `sympy.limit()` 而非关键词检查 "limit" 是否出现。LLM 只负责解读计算结果和写验证报告，物理正确性不依赖 LLM 判断。

### Task Tool 权限重构（统一 permission 流程）

旧版 task.ts 使用两套并行机制：手工拼接 permission 数组 + tools dict。新版统一为一套：

- 所有约束通过 `Discipline.compile()` 编译为 Ruleset
- 通过 `Permission.intersection()` 计算完整 `sessionPermission`
- `primary_tools` deny 规则追加在 `sessionPermission` 末尾（保留"子代理不可用 primary_tools"的 v0.6.0 行为）
- `sessionPermission` + `primary_tools deny` 传入 `Session.create({permission})`
- 运行时 `Permission.disabled()` 自动硬删除 denied 工具，替代 tools dict
- 不需要改动 prompt.ts（冗余的 agent.permission 规则不影响 evaluate 结果）

**实现注意**：`Tool.Context.agent` 在 execute 中是 `string`（agent name），不是 `Agent.Info`。需要通过 `Agent.get(ctx.agent)` 获取 caller 的 `Agent.Info` 才能调用 `intersection(callerAgent.permission, ...)`。

### 默认值策略：undefined 而非 z.default()

`Agent.Info` 不是从 config 直接 zod parse 的——native agent 在 `agent.ts` 中手工构建，custom agent 在 merge 循环中逐字段赋值。`z.default()` 在 parse 时生效但不走 parse，形同虚设。

所有新增字段使用 `.optional()`（无 `z.default()`），默认值为 undefined。语义：

- `undefined` = "不限制"（不产生规则、不改变行为）→ 与 v0.6.0 一致
- 显式传值才生效（如 `delegation_depth: 0` → 禁止 task 工具）

### env_scope 编译统一入口

env_scope 的编译**只在 `agent.ts` 中进行**（通过 `Discipline.compile()`），不在 `task.ts` 的 discipline 参数中重复编译。编译后的规则作为 agent.permission 的一部分，在 task.ts 的 `intersection()` 中自然参与权限计算。

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

### 双层命名：research-_（通用框架）+ gpd-_（物理插件）

Layer 2-3 的组件分为两个命名层：

| 前缀         | 含义             | 范围               | 示例                                                                                                                      |
| ------------ | ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `research-*` | 通用研究基础设施 | 适用于任何研究领域 | research-state MCP、research-conventions MCP（框架）、research-verification skill（通用验证程序）                         |
| `gpd-*`      | 物理领域插件     | 仅适用于物理研究   | gpd-verification scripts（SymPy 计算）、gpd-errors catalog（20 精选物理错误类）、gpd-domain-check bundles（QFT/GR/CM 等） |

**verifier agent 拆分为两层**：

- `research-verifier` — 通用验证框架（验证程序、oracle gate、报告格式），skill_refs 默认仅含 `research-verification`
- `gpd-verifier` — 物理验证插件（继承 research-verifier，添加 gpd-specific skill_refs），面向物理研究用户

非物理领域用户只需使用 `research-verifier` + 自己的领域验证 skills。物理领域用户使用 `gpd-verifier`（自动包含通用框架 + 物理插件）。

### 插件目录约定（Skills 隔离，Agents 保持 flat）

**Skills** 放在 `.aether/skill/plugins/<plugin>/` 子目录中，利用 OpenCode 的 `**/SKILL.md` glob 发现 + frontmatter `name` 字段命名，**零代码改动**即可实现隔离：

```
.aether/skill/plugins/gpd/gpd-verification/SKILL.md  → skill name: "gpd-verification"（来自 frontmatter）
.aether/skill/plugins/gpd/gpd-errors/SKILL.md        → skill name: "gpd-errors"
.aether/skill/plugins/bio/bio-verification/SKILL.md   → skill name: "bio-verification"
```

**Agents** 保持 flat 结构 + 前缀命名（因为 agent name 由路径推导，嵌套路径会产生丑名，改动成本高于收益）：

```
.aether/agent/research.md             → 通用 agent
.aether/agent/gpd-verifier.md         → 物理插件 agent（gpd- 前缀）
.aether/agent/bio-verifier.md         → 生物插件 agent（bio- 前缀，假设未来有）
```

**插件管理**：删除整个 `plugins/gpd/` 目录 + 删除 flat agents `gpd-*.md` 即可卸载物理插件。分享插件只需打包 `plugins/<name>/` + 对应 flat agents。

### 子代理命名变更

| 旧名称       | 新名称                                                      | 原因                                                                |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| researcher   | **research-explorer**                                       | 与 explore agent 的命名风格一致，更准确描述其角色（探索性证据收集） |
| gpd-verifier | **research-verifier**（通用）+ **gpd-verifier**（物理插件） | 双层命名：通用验证框架 + 物理领域扩展                               |

---

## 完整验收总清单

### Layer 0 验收

1. bun typecheck 通过
2. intersection(parent deny, child allow) → deny
3. compileDiscipline deny-before-allow 顺序正确
4. 不设新字段时 native agent 行为不变（permission 语义安全修复除外）
5. env_scope.allowed_commands 编译为 bash deny + specific allow（只在 agent.ts 中编译一次）
6. delegation_depth undefined → 不产生 task 规则；delegation_depth 0 → task denied
7. skillRefs 替换广播，有 skillRefs 时只注入指定 skill；无 skillRefs 时输出与 v0.6.0 一致
8. sessionPermission 通过 Session.create({permission}) 传递后，运行时 Permission.disabled 正确硬删除 denied 工具
9. primary_tools deny 规则追加在 sessionPermission 末尾，子代理不可用 primary_tools（与 v0.6.0 行为一致）
10. category 路由无效 model 时 → 静默 fallback
11. Config.Agent 新字段在 knownKeys 白名单中，不落入 options；Config.Info 的 category 字段在 .strict() schema 中正确定义

### Layer 1 验收

12. build/plan 切换不受影响
13. UI dropdown 切换到 research 后 permission/skill_refs/MCP/output_dir 自动生效（不需 insertReminders 改动）
14. subagent fallback_models 降级正确（promptWithFallback helper 在 task.ts，不改 processor.ts）
15. MCP per-agent 工具过滤正确（resolveTools 中过滤，不做 connect/disconnect）
16. denied tools 过滤正确（resolveTools 中过滤，不展示被 deny 的工具）

### Layer 2 验收

17. research mode 可通过 UI dropdown 进入
18. skill_refs whitelist 生效（广播 + skillRefs 追加）
19. research-explorer subagent 可调用
20. research-verifier subagent 可调用（通用验证框架）
21. gpd-verifier subagent 可调用（物理验证插件，继承 research-verifier + 添加 gpd skills）
22. 删除 research 配置文件后核心行为不变
23. MCP 权限使用 wildcard 模式（research*conventions*\*），配合 mcp 配置实现 server 级可见性
24. bash 权限统一使用 env_scope，不在 permission 中手动声明 bash 规则

### Layer 3 验收

23. research-state MCP 服务器可用（通用项目状态管理）
24. research-conventions MCP 服务器可用（通用约定锁框架）
25. research-verification skill 通过 skill_refs 注入到 research-verifier prompt（通用验证程序）
26. gpd-verification skill 通过 skill_refs 注入到 gpd-verifier prompt（物理计算 scripts）
27. dimensional_check.py 用 SymPy 确定性计算维度（非关键词扫描）
28. limiting_case_check.py 用 sympy.limit() 确定性计算极限
29. ward_identity_check.py 用 sympy.simplify() 确定性验证 Ward 恒等式
30. gpd-errors skill + references/error_catalog.json 可用（20 高风险物理错误类）
31. gpd-domain-check skill + references/bundles/ 可用（12 物理领域 bundle）
32. 仅 2 个 MCP 进程运行（research-state + research-conventions）
33. 自定义检查可通过 scripts/ + SKILL.md 添加（无核心代码改动）
34. 非物理领域用户可使用 research-verifier + 自己的领域验证 skills（无需 gpd-\* 插件）

### Layer 4 验收

35. write-paper skill 在 build mode 可调用
36. gpd-paper-writer subagent 可调用
37. respond-to-referees 三部分结构正确
38. journal templates 可用

### Layer 5 验收

39. background mode spawn 立即返回 taskID，primary agent 不等待
40. background task 完成后 primary session 消息流中出现合成通知信号
41. background_output 工具取回完整结果（内存 Map）或截断摘要（SQLite）
42. background_output 对 running task 返回 "still running"（不阻塞等待）
43. promptWithFallback 在 Layer 1 定义，serial 和 background 模式共用
44. primary step abort 不传播到 background task；session delete 时 background task 标记 cancelled
45. background_task SQLite 表正确持久化

### 回退安全

46. 删除所有 Layer 2-4 配置文件 + MCP 配置后，行为与 v0.6.0 一致
47. Layer 0-1 的核心源文件改动可通过删除新增代码恢复 v0.6.0 行为
48. 删除 Layer 5 background 相关代码后，task tool 退回 serial/concurrent
