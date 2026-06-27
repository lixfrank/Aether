# Layer 1.6: 简化 uv 安装职责 —— 从核心代码下放至 research agent

> **目标**：将 research agent 所需的 uv 安装逻辑从 opencode 核心代码（`packages/opencode`）中移除，交由 research agent 自身承接。
> **约束**：相对 `upstream/dev` 最小改动；删除冗余设计；不破坏现有 research agent 的 uv 依赖链路。
> **范围**：覆盖 `src/util/python.ts` 及其 4 个核心消费点；并新增 research agent 侧的「uv 引导 + MCP 启动」链路（coordinator 前置步骤 + MCP 启动配置）。`src/persist/migrate.ts` 的 `seedDefaultAssets` 资产播种逻辑不在本层改动范围，但其测试中与 uv 相关的断言需调整（见 §4.4）。

---

## 1. 问题分析

### 1.1 现状：核心代码承担了 research agent 专属职责

本分支在核心代码中新增了 `src/util/python.ts`（142 行），其中 `findOrInstallUv()` 在 **opencode 进程启动期**（`src/index.ts` 中间件）自动下载并安装 uv 到 `~/.aether/bin/uv`。这带来四个问题：

| 问题                       | 说明                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **职责越界**               | uv 是 research agent（research-state MCP server）的运行期依赖，与 opencode 核心（通用 agent 运行时）无关。核心不应"懂 uv 是什么"。 |
| **与 research agent 重复** | research agent 自身应在 health-check 阶段管理 uv，`findOrInstallUv` 是越俎代庖。                                                   |
| **绕过授权设计**           | 启动期 `.catch(()=>{})` 静默安装，用户无感知，违反 per-item 授权原则（`env-setup/SKILL.md` D11）。                                 |
| **偏好硬编码**             | 国内镜像（`ghp.ci`/`ghfast.top`）与自定义下载逻辑被写死进核心。                                                                    |

### 1.2 承接点：research agent 的 health-check 阶段（无需新建 skill 基础设施）

research agent 已有 `health_check` 阶段作为天然的 uv 管理承接点。本方案将 uv 的「检测 + 授权 + 安装」下沉为该阶段的一个 **coordinator 级前置 shell 步骤**（任务简单，一行 `curl` 安装命令，无需预设脚本），在 research-state MCP server 启动**之前**完成。原有 `env-setup` skill + `install_registry.json` 的 uv 条目因此变为冗余，需清理（见 §4.3）。

---

## 2. 依赖链路分析（决定最小改动的关键）

### 2.1 uv 的真实消费者

uv 有两类消费者，**彼此独立**：

**(A) research-state MCP server（`server.py`）—— 本层关注对象**

`server.py` 通过 `uv run` 解析其 PEP 723 inline 依赖（`mcp`/`pydantic`/`filelock`）来启动自身，并在 `_run_cmd` 中调用 uv：

- `server.py:887` `_run_cmd(["uv", "--version"])` — infrastructure 检测
- `server.py:894` `_run_cmd(["uv", "python", "list"])` — infrastructure 检测
- `server.py:1425` `["uv", "run", str(script_path)]` — SymPy dry-run
- `server.py:1458` `["uv", "run", ...]` — paper-search 健康探测

> 另：`research-conventions` MCP server（`~/.aether/mcp/research-conventions/server.py`）同样以 `uv run` 拉起（PEP 723 inline 依赖 `mcp`/`pydantic`/`filelock`/`pyyaml`），被 5 个 agent 启用（research-worker/research-verifier/gpd-verifier/gpd-reviewer/local-executor，各 agent `.md` 中 `mcp: { research-conventions: true }`）。但其内部**无**裸 `uv` 调用（无 `subprocess`/`uv` 引用），故仅需 MCP `command` 改绝对路径（D5.2），无需 `server.py` 内 PATH 前置。

**(B) `packages/opencode/src/format/formatter.ts:238-244` —— 与本层 `python.ts` 删除无关**

核心中还存在一个**独立的** uv 消费者：`formatter.ts` 注册了一个名为 `uv` 的 formatter（`command: ["uv", "format", "--", "$FILE"]`），通过 `which("uv")`（`util/which.ts`）发现、`Process.spawn(["uv","format",...])` 调用。

- **与 `python.ts` 无 import 关联**：`formatter.ts` 不 import `util/python`，不引用 `findOrInstallUv`/`UV_BINARY`/`aetherBin`。故删除 `python.ts` **不会破坏 `formatter.ts` 编译**，本层核心删除侧的安全性结论不变。
- **PATH 副作用（需明确为有意识的行为变更）**：改动前核心 `index.ts` 把 `~/.aether/bin` 注入主进程 `process.env.PATH`，`formatter.ts` 的 `which("uv")` 会随之发现 research agent 装在 `~/.aether/bin` 的 uv；改动后该注入被移除（见 D6），`which("uv")` 仅依赖用户 shell PATH 上的 uv。即：**仅靠 research agent 装在 `~/.aether/bin` 的 uv，不再对 `uv format` formatter 可见**。这是可接受的：`uv format` formatter 属用户自有的代码格式化工具，非 research agent 路径；用户按标准方式（shell PATH）装 uv 即可，未装则该 formatter 不可用（`formatter.ts:243` 已做 `which("uv") !== null` 守卫，优雅降级）。本层在 §7 显式记录此行为变更，避免被误判为回归。

> 结论：**核心删除侧只针对 `python.ts` 及其消费点**；`formatter.ts` 的 uv 用途独立、不在本层删除范围，仅受 PATH 注入移除的间接影响（已明确为有意识变更）。

### 2.2 PATH 传递链（当前 → 改动后）

当前：

```
index.ts:75-79  process.env.PATH += ~/.aether/bin; findOrInstallUv()   (主进程)
    ↓ 继承
mcp/index.ts:328-332  env: { ...process.env, ...mcp.environment }       (MCP server 子进程)
    ↓ 继承
server.py:838  subprocess.run(cmd)  (不传 env，继承 server.py 进程 env)
    ↓ 依赖 PATH
["uv", ...]  能否找到 uv
```

改动后：主进程不再注入 `~/.aether/bin`、不再安装 uv。research-state MCP 子进程的 PATH 由 **`server.py` 顶部 2 行单目录前置**自行补充 `~/.aether/bin`（见 D5.2）。该前置在 `server.py` 启动时执行，而 uv 已由 D5.1 的 coordinator 前置步骤装好（先装后启），故无「装在启动后」的时序问题。`_run_cmd` 行为不变（继承已含 `~/.aether/bin` 的 `os.environ`）。

### 2.3 关键约束

两条硬约束决定 D5 的形态：

1. **server.py 必须由 `uv run` 拉起**（PEP 723 inline 依赖），故 uv 必须在 MCP server **启动时**就存在——而非仅在 `run_health_check` 被调用时。因此「先装后启」是必要条件，不仅是优化。
2. **research-worker 在其 prompt 处理起始即连接 research-state MCP**（`session/prompt.ts:893-903`：按 `agent.mcp` 列表在暴露工具前 `MCP.connect`），早于其任何 bash 工具调用。故 uv 引导不能放在 research-worker 的工具循环内，必须由 **coordinator 在 dispatch research-worker 之前**作为前置步骤完成。

另：server.py 内部 4 处裸 `["uv",...]` 调用仍需 `~/.aether/bin` 在 PATH 上。「先装后启」只保证 uv 存在，不保证其位于 server.py 继承的 PATH（PATH 在 opencode 启动时冻结，MCP 子进程继承之，本不含 `~/.aether/bin`；且实测 `uv run` 不会把 uv 自身目录传给子进程）。**agent 无法把 PATH 变更传播到 server.py 进程**（bash 子进程无法回写 opencode `process.env`，也无法触及已生成的 server.py 子进程 env）。故此残留由 D5.2 在 `server.py` 自身以 2 行单目录前置解决——在「先装后启」排序下它正确且简单（uv 在 `server.py` 启动时已存在）。

---

## 3. 设计决策

### D1：核心删除 `findOrInstallUv` 全部下载逻辑

`util/python.ts` 的下载/解压/镜像逻辑（`downloadWithMirrors`/`extractTarGz`/`extractZip`/`platformArchive`/`executable`/`findOrInstallUv`）整体删除。安装职责交由 research agent coordinator 前置步骤。

### D2：核心删除无消费者的路径常量/函数

`aetherMcp`、`UV_BINARY`、`aetherBin`、`aetherHome` 在核心代码中无消费者（仅 export），删除。

### D3：`AETHER_HOME` 常量内联至 `migrate.ts`

`AETHER_HOME` 唯一核心消费者是 `persist/migrate.ts`（`seedDefaultAssets`，不在本层改动范围）。该常量内联为 `migrate.ts` 内部局部常量 `path.join(os.homedir(), ".aether")`，移除对 `util/python` 的 import。

### D4：核心删除 `AetherBinPlugin`

`plugin/aether-bin.ts` 通过 `shell.env` hook 把 `~/.aether/bin` 注入 bash tool 的 shell PATH。其存在前提是"核心把 uv 装在 `~/.aether/bin`"。改动后 uv 由 research agent 自管，`~/.aether/bin` 不再是核心应感知的概念。整文件删除，`plugin/index.ts` 移除其注册。

> 注：删除后 bash tool 的 shell PATH 不再含 `~/.aether/bin`。这影响 `formatter.ts` 的 `which("uv")`（见 §2.1(B)），已明确为有意识变更；research agent 自身不依赖 bash shell 发现 uv（走 MCP server，`server.py` 顶部自前置 `~/.aether/bin`，见 D5.2）。

### D5：research agent 侧 —— 先装后启（核心侧全为删除，新增集中于本侧）

uv 的检测+授权+安装下沉为 research agent health-check 阶段的 **coordinator 前置 shell 步骤**，在 research-state / research-conventions MCP server 启动**之前**完成；`server.py` 顶部加 2 行单目录 PATH 前置，使内部裸 `uv` 调用可发现已装好的 uv；MCP 配置取干净形态（`command` 用绝对路径 `~/.aether/bin/uv`）。**D5 不新增任何核心代码（核心侧删除见 D1–D4/D6）；不使用 `sh -c` 包装。**

**D5.1 coordinator 前置 uv 引导（bash，单行安装，无预设脚本）**

research-coordinator 进入 `health_check` 阶段、**dispatch research-worker 之前**，执行：

> **§8 集成**：本步骤替换 research-coordinator §8 Session Start Procedure 中 Step 1 的 `(or uv --version for Tier 0)` 部分，置于 `invoke /health-check skill` **之前**执行——因 health-check skill 依赖 research-state MCP（需 uv 启动 `server.py`），uv 必须先就位。§8 Step 1 相应拆为两步：先 D5.1 uv 引导，再 invoke /health-check skill（consequential 编辑见 §4.3）。

1. 检测：`~/.aether/bin/uv --version`（绝对路径，不依赖 PATH）。
2. 若不存在：经 `question` 工具向用户做 **per-item 授权**（"uv 不可用（priority: critical），是否安装到 `~/.aether/bin`？[y/n]"），保留 D11 授权原则，杜绝静默安装。
3. 授权通过后安装：
   ```sh
   curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="$HOME/.aether/bin" sh
   ```
   `UV_UNMANAGED_INSTALL` 把 uv 装到指定路径且**不修改 shell PATH/profile**（见 astral 安装器文档），干净、单行、无预设脚本。research agent 由此拥有隔离的、位于 `~/.aether/bin` 的自有 uv，不与用户其它位置的 uv 混淆。
4. 验证：`~/.aether/bin/uv --version`。
5. 通过后才 dispatch research-worker（触发 research-state MCP 连接）。

> 设计要点：research agent **不复用**用户已装在 `~/.local/bin` 等处的 uv——统一以 `~/.aether/bin/uv` 为研究链路的权威路径，消除 PATH 歧义。若用户别处已有 uv，此处会在 `~/.aether/bin` 再装一份（~10MB，可接受），换取启动路径的确定性。

**D5.2 `server.py` 顶部 2 行单目录 PATH 前置 + MCP 配置取干净形态**

由 §2.3 的约束（`uv run` 不传 uv 目录给子进程、agent 无法传播 PATH 到 `server.py` 进程），`server.py` 内部 4 处裸 `["uv",...]` 调用要发现 uv，须由 `server.py` 自身在启动时把 `~/.aether/bin` 前置进 `os.environ["PATH"]`。

在 `server.py` 模块级（所有 import 之后、`mcp = FastMCP(...)` 之前）插入 PATH 前置块（注释自描述，不引用设计文档术语）：

```python
# Ensure uv at ~/.aether/bin is discoverable by bare `uv` calls in _run_cmd.
# uv is installed to ~/.aether/bin before this process starts.
_uv_bin = os.path.expanduser("~/.aether/bin")
if _uv_bin not in os.environ.get("PATH", "").split(os.pathsep):
    os.environ["PATH"] = _uv_bin + os.pathsep + os.environ.get("PATH", "")
```

- `os`/`os.path` 已 import，无新增依赖。`_run_cmd`（line 834）不传 env、继承 `os.environ`，故 4 处 `["uv",...]`（887/894/1425/1458）能发现 uv。
- **正确性依赖 D5.1 排序**：uv 在 `server.py` 启动**之前**已由 coordinator 装好，故这 2 行执行时 `~/.aether/bin/uv` 已存在——模块级代码在启动时跑一次即足够，不存在「装在启动后看不到」的时序问题。
- 单目录、幂等的 PATH 前置惯用法（`server.py` 确保自身依赖目录在其 PATH 上），无文件存在性判断、无多目录候选。

**MCP 配置取干净形态**（`command` 用绝对路径 uv，无需 `sh -c`、无需 `environment`）：

```jsonc
// research-state / research-conventions MCP 配置（.aether/aether.jsonc 中的 local server 条目）
// 两者 command 形态一致，仅 server.py 路径不同：
"research-state": {
  "type": "local",
  "command": ["~/.aether/bin/uv", "run", "~/.aether/mcp/research-state/server.py"],
  "enabled": false,
},
"research-conventions": {
  "type": "local",
  "command": ["~/.aether/bin/uv", "run", "~/.aether/mcp/research-conventions/server.py"],
  "enabled": false,
}
```

> 本层**只改 `command`**，`enabled` 维持既有 `false` 不动：这两个 server 的启用由各 agent `.md` 的 `mcp: { research-state: true }` / `mcp: { research-conventions: true }` 按 agent 粒度 opt-in（见 §2.1 research-conventions 被 5 个 agent 启用），全局 `enabled` 不应置 `true`（否则会对所有 agent 生效）。

- `command` 数组各元素的 `~` 由 `mcp/index.ts:321` 的 `expandTilde`（定义于 line 40）既有逻辑展开为 `$HOME`，故 `uv` 以绝对路径被定位、`server.py` 以绝对路径被 `uv run` 拉起（PEP 723 inline 依赖由 uv 解析）。
- 启动时 uv 必须存在（`command` 首元素即 `~/.aether/bin/uv`，不在 PATH 上、靠绝对路径定位）——由 D5.1 的 coordinator 前置步骤保证（§2.3 约束 1/2）。
- 若现行配置用裸 `uv run server.py`，删除核心 PATH 注入后将因主进程 PATH 不含 `~/.aether/bin` 而启动失败，故改为绝对路径是**必需**改动。
- **`research-conventions` 仅需 `command` 改动**：其 `server.py` 内部无裸 `["uv",...]` 调用（无 `subprocess` 引用），无需 D5.2 的 PATH 前置；但 `uv run` 拉起同样依赖 uv 存在，故 `command` 绝对路径化同样必需。该 server 被 5 个 agent 启用，`prompt.ts:893-903` 会在 dispatch 时尝试连接。

### D6：index.ts 启动中间件移除 uv 相关调用

删除 `findOrInstallUv` import 与调用、`aetherBin` import 与 PATH 注入块。`seedDefaultAssets` 调用保留（属于 migrate，不在本层范围）。

---

## 4. 改动清单（逐文件）

### 4.1 核心代码（以删除/回退为主，不新增 uv 逻辑）

#### `packages/opencode/src/util/python.ts` —— **整文件删除**

upstream/dev 无此文件，删除后核心不再含 uv 下载逻辑。

#### `packages/opencode/src/plugin/aether-bin.ts` —— **整文件删除**

upstream/dev 无此文件。

#### `packages/opencode/src/plugin/index.ts` —— 移除 2 处

- 删除 `import { AetherBinPlugin } from "./aether-bin"`（line 12）
- 从 `INTERNAL_PLUGINS` 数组移除 `AetherBinPlugin`（line 55）

回归 upstream 形态。

#### `packages/opencode/src/index.ts` —— 移除 uv 相关块

删除（line 37, 75-79）：

```ts
import { aetherBin, findOrInstallUv } from "./util/python"
// ...
const aetherBinDir = aetherBin()
if (!process.env.PATH?.includes(aetherBinDir)) {
  process.env.PATH = `${aetherBinDir}:${process.env.PATH ?? ""}`
}
await findOrInstallUv().catch(() => {})
```

保留 `seedDefaultAssets` 调用（属 migrate，本层不动）。

#### `packages/opencode/src/persist/migrate.ts` —— 内联 AETHER_HOME

- 删除 `import { AETHER_HOME } from "@/util/python"`（line 10）
- 在文件内新增局部常量：`const AETHER_HOME = path.join(os.homedir(), ".aether")`（`os`/`path` 已 import，line 2-3）
- `seedDefaultAssets` 中 5 处 `AETHER_HOME` 用法（line 472/475/488/495/496）不变，均指向新局部常量

#### `packages/opencode/src/util/which.ts` —— **不动**

通用工具（`Global.Path.bin` 拼接），非 uv 专属。`formatter.ts` 经此发现 uv（见 §2.1(B)）。

#### `packages/opencode/src/format/formatter.ts` —— **不动（但行为变更，见 §2.1(B)/§7）**

独立 uv 消费者，不依赖被删资产。PATH 注入移除后其 `which("uv")` 不再看见 `~/.aether/bin` 的 uv，属有意识变更。

### 4.2 research agent 资产（逻辑新增）

#### research-state / research-conventions MCP 启动配置 —— `command` 用绝对路径 uv（D5.2）

将 `.aether/aether.jsonc` 中 research-state 与 research-conventions 两个 local MCP server 的 `command` 均设为 §3 D5.2 所示干净形态（`["~/.aether/bin/uv", "run", "~/.aether/mcp/<name>/server.py"]`）。两者当前均用裸 `uv run`，删除核心 PATH 注入后将启动失败，故改为绝对路径是**必需**改动（理由见 D5.2）。research-conventions 被 5 个 agent 启用（research-worker/research-verifier/gpd-verifier/gpd-reviewer/local-executor）。

#### research-coordinator —— health-check 阶段前置 uv 引导（D5.1）

在 `health_check` 阶段、dispatch research-worker 之前，插入 §3 D5.1 的「检测→授权→安装→验证」shell 步骤。该步骤替换 §8 Session Start Procedure Step 1 的 `(or uv --version for Tier 0)` 部分，置于 `invoke /health-check skill` 之前（因 health-check skill 依赖 research-state MCP，需 uv 先就位）。§8 及 `session-recovery.md` 的 consequential 编辑见 §4.3。

#### `.aether/mcp/research-state/server.py` —— 顶部 2 行单目录 PATH 前置（D5.2）

按 §3 D5.2 在模块级（所有 import 后、`mcp = FastMCP(...)` 前）插入 `os.environ["PATH"]` 前置 `~/.aether/bin`（注释自描述、不引用设计文档术语）。`_run_cmd(["uv",...])`（line 887/894/1425/1458）调用点**不动**。其中 `uv_available`/`uv_python_management`（887/894）因 uv 已由 coordinator 前置安装而恒为 pass，变为冗余但无害的确认性检查，保留以避免改动调用点。

### 4.3 research agent skill 文档 —— 需清理 uv 冗余 + 集成 D5.1（consequential）

原 `env-setup` + `install_registry.json` 的 uv 安装链路被 D5.1 的 coordinator 前置步骤取代，以下需清理以避免**两套 uv 安装机制并存**的冗余/混淆；同时需将 D5.1 集成进 coordinator 现有流程：

- `.aether/skills/env-setup/references/install_registry.json` —— **移除 `uv` 条目**（line 2-13）。uv 不再由 env-setup 安装；`git`/`git_init` 条目保留。
- `.aether/skills/env-setup/SKILL.md` —— 移除 Step 6 中 uv 专支（"For uv: suggest source ~/.bashrc..."），因 uv 已前置装好、env-setup 不再处理 uv。
- `.aether/skills/health-check/SKILL.md` —— 补注：uv 由 coordinator 前置步骤保证存在（D5.1），`run_health_check` 的 `uv_available`/`uv_python_management` 为确认性检查；Step 5 的 `failed_items` 中 `uv_available → auto_installable:true, priority:critical` 映射保留（无害，因不再触发）。
- `.aether/skills/research-coordinator/references/session-recovery.md` §Tier 0 LLM Bootstrap —— **移除 uv 安装机制**（step 2-4：load env-setup / `curl` 安装 / re-check + suggest source）。uv 安装已由 D5.1 coordinator 前置步骤在 §8 Step 1 之前完成，此处仅保留检测逻辑（`~/.aether/bin/uv --version`），不再含安装命令。运行中 uv 被删除的极低概率场景暂不处理。
- `.aether/skills/research-coordinator/SKILL.md` §8 Session Start Procedure Step 1 —— 将 `(or uv --version for Tier 0)` 替换为 D5.1 前置 uv 引导步骤，置于 `invoke /health-check skill` 之前。改后 Step 1 拆为两步：先 D5.1 uv 引导（检测→授权→安装→验证），再 invoke /health-check skill。

> 这些为 research agent skill 文档的 consequential 编辑，逻辑上从属于 D5；若需保持本层 PR 聚焦，可作为同层紧随提交。

### 4.4 测试调整

#### `packages/opencode/test/util/python.test.ts` —— **整文件删除**

测试对象 `aetherBin`/`aetherHome` 已删除。

#### `packages/opencode/test/layer-1/seed-default-assets.test.ts` —— 移除 `~/.aether/bin` 断言

该测试 line 8 自行定义 `AETHER_HOME`（不 import `util/python`），故删除 `python.ts` 不影响其编译。但 **line 47-54 的断言 `~/.aether/bin/ directory exists for uv installation` 在新设计下失效**：

- 改动前：`~/.aether/bin` 由核心 `findOrInstallUv`（`fs.mkdir(AETHER_BIN)`）创建，`seedDefaultAssets` 运行时通常已存在。
- 改动后：核心不再创建 `~/.aether/bin`；`seedDefaultAssets` 只播种 `agent/mcp/skills/health` 子目录（不含 `bin`）。`~/.aether/bin` 改由 **research agent coordinator 前置步骤**（D5.1）在首次 health-check 时创建。
- 故该断言不再属于 `seedDefaultAssets` 的职责，应**删除 line 47-54 这条用例**：`~/.aether/bin` 的创建者已转移至 research agent 运行期（D5.1），与种子资产测试无关。

#### `packages/opencode/test/mcp/tilde-expansion.test.ts` —— **不动（仅语义遗留）**

line 38-41 以 `~/.aether/bin/uv` 为例测试 `~`→home 展开（通用 MCP 机制，§9 保留）。其只测字符串展开、不依赖文件存在，仍通过；语义上不再代表"uv 装于此"，属可接受的历史用例。

---

## 5. 改动后职责归属

| 职责                   | 改动前                                                     | 改动后                                                                                                                        |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| uv **下载安装**        | 核心 `findOrInstallUv`（静默，镜像，`~/.aether/bin`）      | coordinator 前置 shell 步骤（per-item 授权，`UV_UNMANAGED_INSTALL`，`~/.aether/bin`）                                         |
| uv **检测**            | 核心 `findOrInstallUv` 预检 + `health-check` 检测（重复）  | coordinator 前置步骤唯一检测（`~/.aether/bin/uv --version`）                                                                  |
| uv **PATH 可见性**     | 核心 `index.ts`（主进程）+ `AetherBinPlugin`（bash shell） | `server.py` 顶部 2 行单目录前置（`~/.aether/bin`）                                                                            |
| uv **启动 MCP server** | 隐式：核心预装后 MCP 配置用裸 `uv run`                     | 显式：research-state/research-conventions MCP `command` 用绝对路径 `~/.aether/bin/uv`；research-state `server.py` 自前置 PATH |
| `AETHER_HOME` 常量     | `util/python.ts`（export）                                 | `migrate.ts` 内联（唯一消费者）                                                                                               |

核心代码对 uv 的认知从"下载、安装、注入 PATH"降为"零认知"。research agent 对 uv 的管理收敛为「coordinator 前置装好 → MCP 以绝对路径 uv 拉起 server.py → server.py 自前置 `~/.aether/bin` 使内部裸调用可发现」的单链路；核心侧仅做删除、不新增 uv 逻辑，且不使用 `sh -c` 包装。

---

## 6. 时序与闭环验证

### 6.1 首次运行（uv 未装）

1. opencode 启动 → 不再装 uv、不再注入 PATH（核心已删）。
2. 用户触发 research agent → coordinator 进入 `health_check` 阶段。
3. coordinator 前置步骤：`~/.aether/bin/uv --version` → 不存在 → `question` 授权 → `curl ... | env UV_UNMANAGED_INSTALL="$HOME/.aether/bin" sh` → 验证通过。
4. coordinator dispatch research-worker → `prompt.ts:893-903` 连接 research-state / research-conventions MCP → 以 D5.2 干净 `command`（`~/.aether/bin/uv run server.py`，绝对路径定位 uv）启动：uv 已存在，`uv run` 解析 PEP 723 依赖并拉起 `server.py`；research-state `server.py` 模块级 2 行前置把 `~/.aether/bin` 加入 `os.environ["PATH"]`。
5. research-worker 调 `run_health_check` → `server.py:887/894` 的 uv 检测 pass（uv 已在 PATH 上）→ runtime 层 `uv run script`（1425/1458）亦 pass。

**无需重启 MCP server 进程**：uv 在 `server.py` 启动前已就位（D5.1 排序保证），`server.py` 模块级 PATH 前置在启动时即生效。

### 6.2 已有 uv（`~/.aether/bin`，存量/已引导用户）

1. opencode 启动 → 不注入 PATH。
2. coordinator 前置步骤：`~/.aether/bin/uv --version` → 存在 → 跳过安装。
3. dispatch research-worker → research-state / research-conventions MCP 以绝对路径 `command` 启动 → research-state `server.py` 自前置 PATH → `run_health_check` pass。

### 6.3 用户别处已有 uv（如 `~/.local/bin`）但 `~/.aether/bin` 无

coordinator 前置步骤只认 `~/.aether/bin/uv`（权威路径），检测为不存在 → 引导安装到 `~/.aether/bin`（与用户既有 uv 隔离）。后续链路同 6.1 步骤 4-5。设计上不复用用户既有 uv，以消除 PATH 歧义、保证启动路径确定。

---

## 7. 风险与缓解

| 风险                                                                                  | 影响                                                                                                                           | 缓解                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| coordinator 未执行前置步骤即 dispatch research-worker                                 | MCP `command` 首元素 `~/.aether/bin/uv` 不存在 → `server.py` 启动失败 → MCP `failed` → research-worker 无法 `run_health_check` | coordinator skill 须将 D5.1 列为 `health_check` 的强制前置步骤（§4.3）；失败时 coordinator 应感知 MCP `failed` 状态并回退执行引导。 |
| research-state / research-conventions MCP 配置仍用裸 `uv run`（未改为绝对路径）       | `command` 首元素为裸 `uv`，主进程 PATH 不含 `~/.aether/bin` → 启动失败                                                         | 本层显式要求 `command` 用绝对路径 `~/.aether/bin/uv`（§4.2，必需改动）。                                                            |
| 删除 `AetherBinPlugin` 后 `formatter.ts` 的 `which("uv")` 找不到 research agent 的 uv | `uv format` formatter 对"仅有 research agent uv"的用户不可用                                                                   | 有意识变更（§2.1(B)）：`formatter.ts:243` 已优雅降级；用户按标准方式装 uv 即可。非 research agent 路径，非回归。                    |
| 用户从未运行 research agent → uv 永不预装                                             | 无影响。非 research agent 用户本就不需要 uv。                                                                                  | 设计预期：uv 是 research agent 专属依赖。                                                                                           |
| `UV_UNMANAGED_INSTALL` 禁用 `uv self update`                                          | research agent 的 uv 不能自更新                                                                                                | coordinator 前置步骤可重跑安装命令升级；可接受。                                                                                    |
| 两套 uv 安装机制并存（若 §4.3 清理未做）                                              | env-setup / session-recovery Tier 0 与 coordinator 前置步骤都可能尝试装 uv，位置/授权语义冲突                                  | §4.3 强制移除 `install_registry.json` 的 uv 条目、env-setup 的 uv 专支、`session-recovery.md` §Tier 0 的安装步骤，消除冗余。        |

---

## 8. 验收清单

- [ ] `packages/opencode/src/util/python.ts` 删除
- [ ] `packages/opencode/src/plugin/aether-bin.ts` 删除
- [ ] `packages/opencode/src/plugin/index.ts` 无 `AetherBinPlugin` 引用
- [ ] `packages/opencode/src/index.ts` 无 `findOrInstallUv`/`aetherBin` 调用，`seedDefaultAssets` 保留
- [ ] `packages/opencode/src/persist/migrate.ts` 内联 `AETHER_HOME`，无 `util/python` import
- [ ] `packages/opencode/src/format/formatter.ts` 不动（行为变更已记录于 §2.1(B)/§7）
- [ ] research-state / research-conventions MCP 配置 `command` 均为绝对路径形态 `["~/.aether/bin/uv", "run", ...]`（D5.2）
- [ ] research-coordinator skill 含 `health_check` 前置 uv 引导步骤（D5.1），§8 Step 1 已拆为 D5.1 + health-check skill
- [ ] `.aether/skills/env-setup/references/install_registry.json` 无 `uv` 条目
- [ ] `.aether/skills/env-setup/SKILL.md` 无 uv 专支
- [ ] `.aether/skills/health-check/SKILL.md` 补注 uv 由 coordinator 前置保证、`uv_available` 为确认性检查
- [ ] `.aether/skills/research-coordinator/references/session-recovery.md` §Tier 0 移除 uv 安装机制，仅保留检测
- [ ] `packages/opencode/test/util/python.test.ts` 删除
- [ ] `packages/opencode/test/layer-1/seed-default-assets.test.ts` 移除 `~/.aether/bin` 断言（line 47-54）
- [ ] `.aether/mcp/research-state/server.py` 顶部 2 行 `~/.aether/bin` PATH 前置（D5.2），`_run_cmd` 调用点不动
- [ ] `bun typecheck`（packages/opencode）通过
- [ ] research agent 首次运行（无 uv）→ coordinator 前置引导 → MCP 启动 → `run_health_check` pass 闭环
- [ ] research agent 已有 uv（`~/.aether/bin`）场景 coordinator 前置检测直接跳过、`run_health_check` pass

---

## 9. 不在本层范围

- `seedDefaultAssets`（资产播种）：见 `migrate.ts`，用户已确认不可减少。
- `mcp/index.ts` 的 `~` 展开与 `environment` merge：通用 MCP 机制，与 uv 无关，保留（D5.2 仅依赖其既有 `command` 数组各元素 `~` 展开，不改此处）。
- `formatter.ts` 的 `uv format` formatter：独立核心 uv 消费者，不在本层删除范围；仅受 PATH 注入移除的间接影响（§2.1(B)/§7）。
- `Discipline`/`Permission.intersection`/`skill_refs` 注入等其它 Layer 1 改动：后续层处理。
- Windows 平台：D5.1 的 `curl -LsSf ... | sh` 安装方式仅支持 Unix（macOS/Linux）。原 `python.ts` 的 win32 支持（`extractZip`/`uv-x86_64-windows-msvc.zip`）随文件删除而移除，本层不补充 Windows uv 安装路径。
