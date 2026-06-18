---
name: env-setup
owner: research
description: |
  Per-item authorization auto-install workflow for missing software
  detected by health check. Reads install_registry.json for install
  commands, verify commands, and priority ordering. Coordinates with
  the user via question tool for each item individually.
---

# env-setup — Per-Item Authorization Auto-Install

This skill guides the coordinator through installing missing software detected by the health check, using per-item user authorization (D11).

## Prerequisites

- Health check has been run and a `PhaseResultDigest` with `status: degraded` or `status: failed` is available
- The digest contains `failed_items` with `auto_installable`, `priority`, and `failure_class` fields

## Procedure

### Step 1: Read install_registry.json

Read `.aether/skills/env-setup/references/install_registry.json` to get install commands, verify commands, post-install notes, and conditions for each item.

### Step 2: Classify and Sort Items

From `digest.failed_items` and the registry:

- **installable_items**: items where `auto_installable == true` or `auto_installable == "partial"`, sorted by priority (critical → high → medium → low)
- **manual_items**: items where `auto_installable == false` or not in the registry

### Step 3: Per-Item Authorization

For each installable_item, ask the user **one at a time** using the question tool:

```
[software_name] 不可用（priority: [priority]）
[description of what it enables]
安装命令：[install_command]
是否授权自动安装 [software_name]？[yes/no]
```

- User agrees → proceed to install
- User declines → mark as `user_declined`, continue to next item

### Step 4: Execute Installation

For each authorized item:

1. Check `condition` field (e.g., `git_available == pass AND git_working_dir == fail`). If condition not met, skip and inform user.
2. Determine platform: `uname -s` → "macOS" or "Linux"
3. Execute the install command from `platforms` matching the current platform
4. If `verify_delay_seconds` is set → wait that many seconds (inform user "等待服务启动...")
5. Execute `verify_command` to verify installation
6. Verification failure:
   - For uv: suggest user `source ~/.bashrc` or restart terminal (PATH may not be updated in current process)
   - For others: mark as `install_failed`, inform user
7. Verification success → mark as `installed`
8. If `post_install_note` exists → inform user
9. If `auto_installable == "partial"` → inform user they need to run `manual_step` (e.g., web-based account setup)

### Step 5: Report Results

After all items processed:

```
安装结果：
- [已安装]: [software_name] → 验证通过
- [安装失败]: [software_name] → [reason]
- [用户拒绝]: [software_name] → 可稍后通过"检查环境"重新检测并安装
- [需手动步骤]: [software_name] → 请执行 [manual_step]

仍需手动处理：
- [manual_items list]
```

### Step 6: Re-check

After installation completes, the coordinator should dispatch research-worker(mode=health_check, layers=None) to verify the full environment.

## Key Design

- **Per-item authorization**: Each item is authorized individually. User can install only uv (required) and skip optional tools.
- **Read-only health check**: The health check MCP tool is READ_ONLY. Installation is a write operation handled by this skill with per-item user authorization.
- **No batch authorization**: NEVER ask "Install all missing items?" — always ask per-item.

## Platform Detection

```bash
uname -s
```

- "Darwin" → macOS
- "Linux" → Linux

Use the appropriate install command from `install_registry.json` platforms field.
