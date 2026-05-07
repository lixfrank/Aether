# Research Agent Implementation Plan

Based on Feynman project analysis and Aether's current architecture.

Branch: `feat/research-agent`

## Overview

8 interconnected changes. Change 0 is a prerequisite refactor that unifies the Permission/Discipline model. Changes 1-7 build on that unified foundation to add research agent capabilities.

---

## Change 0: Unify Discipline → Permission Model (Prerequisite Refactor)

### Problem

Currently, Aether has **three separate systems** that all express "what an agent may do":

1. **`Agent.Info.permission`** — `Permission.Ruleset` (Rules array on agent definition)
2. **`Session.permission`** — `Permission.Ruleset` (Rules array on session, persisted in SQL)
3. **`Discipline`** — its own schema with `permission_override` (shortcut format) + `file_scope` (glob array) + `env_scope` (planned)

These overlap and create ambiguity:

- `file_scope` is a parallel constraint to permission `pattern` fields — same concept, different representation
- `permission_override` uses `{ permission: [action, ...patterns] }` shortcut format that `fromOverride()` must translate into Rules — an unnecessary conversion layer
- `env_scope.allowed_commands` (planned) would be yet another parallel constraint to bash `pattern` rules

### Design Principle: Permission is the single constraint language

All constraints on what an agent may do should be expressed as `Permission.Ruleset`. Discipline fields like `permission_override`, `file_scope`, and `env_scope.allowed_commands` are **convenience shortcuts** that get compiled into Rules at session creation time. The runtime never sees shortcuts — it only evaluates Rules.

This mirrors Feynman's approach: every constraint (file scope, command prefix, tool access) is a permission rule, and the runtime has one evaluation path.

### Refactor Steps

#### Step 0a: Expand `fromOverride` to compile all shortcuts into Rules

**File**: `packages/opencode/src/session/discipline.ts`

Current `fromOverride` only handles `{ permission: [action, ...patterns] }`. Expand it to also compile `file_scope` and `env_scope.allowed_commands`:

```ts
export function compileDiscipline(discipline: Discipline): Permission.Ruleset {
  const ruleset: Permission.Ruleset = []

  // 1. Compile permission_override (existing logic, unchanged)
  if (discipline.permission_override) {
    for (const [permission, values] of Object.entries(discipline.permission_override)) {
      const action = values[0]
      if (!VALID_ACTIONS.has(action)) continue
      if (values.length === 1) {
        ruleset.push({ permission, pattern: "*", action: action as Permission.Action })
      } else {
        for (let i = 1; i < values.length; i++) {
          ruleset.push({ permission, pattern: values[i], action: action as Permission.Action })
        }
      }
    }
  }

  // 2. Compile file_scope into FILE_TOOLS rules
  //    file_scope: ["src/auth/**", "package.json"]
  //    → For each FILE_TOOL: blanket deny first, then specific allow rules per scope pattern.
  //    Rule ordering is CRITICAL: evaluate() uses findLast (last matching rule wins).
  //    Blanket deny "*" must come BEFORE specific scope allow patterns,
  //    so that findLast matches the specific allow for scoped paths
  //    and the blanket deny for everything else.
  if (discipline.file_scope?.length) {
    const FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]
    for (const tool of FILE_TOOLS) {
      // Add blanket deny FIRST — any file not in scope is denied
      ruleset.push({ permission: tool, pattern: "*", action: "deny" })
      // Add specific allows AFTER — scoped paths override the blanket deny via findLast
      for (const scopePattern of discipline.file_scope) {
        ruleset.push({ permission: tool, pattern: scopePattern, action: "allow" })
      }
    }
  }

  // 3. Compile env_scope.allowed_commands into bash rules
  //    allowed_commands: ["docker", "curl"]
  //    → { permission: "bash", pattern: "*", action: "deny" }  (blanket deny, FIRST)
  //    → { permission: "bash", pattern: "docker*", action: "allow" }
  //    → { permission: "bash", pattern: "curl*", action: "allow" }
  //    Same deny-before-allow ordering: blanket deny first, specific allow overrides via findLast.
  if (discipline.env_scope?.allowed_commands?.length) {
    ruleset.push({ permission: "bash", pattern: "*", action: "deny" })
    for (const cmd of discipline.env_scope.allowed_commands) {
      ruleset.push({ permission: "bash", pattern: `${cmd}*`, action: "allow" })
    }
  }

  return ruleset
}
```

Key design decisions:

- **Rule ordering is CRITICAL**: `evaluate()` uses `findLast` — the last matching rule wins. Therefore, **blanket deny rules must come BEFORE specific allow rules**. If allow rules came before deny rules, `findLast` would always match the deny `*` pattern (since `*` matches everything), making all allow rules ineffective. The correct ordering is: deny `*` first → then allow specific patterns → `findLast` matches the specific allow for scoped paths and the blanket deny for everything else.
- `file_scope` compiles to **blanket deny + specific allow rules** per FILE_TOOL. This replaces the separate `evaluateWithScope` path with standard `evaluate` (findLast semantics).
- `allowed_commands` compiles to **blanket deny + specific allow rules** per command prefix. The prefix `docker` becomes pattern `docker*`, matching `docker`, `docker build`, `docker-compose` etc.
- **No more separate `evaluateWithScope` function** — scope checking is now just normal rule evaluation via `findLast`.

#### Step 0b: Remove `Session.fileScope` — it's now encoded in `Session.permission`

**Files**: `packages/opencode/src/session/session.sql.ts`, `packages/opencode/src/session/index.ts`, `packages/opencode/src/session/schema.ts`

Currently `Session.Info` has both `permission: Permission.Ruleset` and `fileScope: string[]`. After the refactor, `file_scope` is compiled into the Ruleset by `compileDiscipline`, so the separate `fileScope` field is redundant.

Changes:

1. Remove `file_scope` column from `SessionTable` in `session.sql.ts`
2. Remove `fileScope` from `Session.Info` schema
3. In `Session.create`, instead of passing `fileScope` separately, compile it via `compileDiscipline` and merge into `permission`
4. Add a DB migration to drop the `file_scope` column

The session creation flow becomes:

```ts
// Before (current):
const session = await Session.create({
  parentID: ctx.sessionID,
  permission: effectivePermission,
  delegationDepth: depth,
  maxSteps: discipline.max_steps ?? agent.steps,
  fileScope: discipline.file_scope,
})

// After (refactored):
const disciplineRules = compileDiscipline(discipline)
const effectivePermission = Permission.intersection(callerPermission, agent.permission, disciplineRules)
const session = await Session.create({
  parentID: ctx.sessionID,
  permission: effectivePermission,
  delegationDepth: depth,
  maxSteps: discipline.max_steps ?? agent.steps,
  // fileScope removed — now encoded in permission
})
```

#### Step 0c: Simplify `evaluateWithScope` → standard `evaluate`

**File**: `packages/opencode/src/permission/index.ts`

Currently `evaluateWithScope` has a separate `scopeMatch` check that runs after normal evaluation. After file_scope is compiled into Rules, this separate check is unnecessary — the scope patterns are already in the Ruleset as allow/deny rules.

However, we still need `evaluateWithScope` for one reason: **the primary agent's output_dir notepad scope**. When a research agent enters, `mode-switch.ts` creates a notepad and sets a scope that restricts edit/write to the notepad directory. This scope is NOT from Discipline — it's from the agent definition's `output_dir`.

So the refactor is:

- Remove the `scope` parameter that came from `Session.fileScope` (now encoded in Rules)
- Keep `evaluateWithScope` but rename it to `evaluateWithOutputScope` — only used for the notepad output_dir restriction
- Or simpler: compile the output_dir scope into the agent's permission Ruleset at mode-switch time, and then just use `evaluate` everywhere

The cleanest approach: **compile output_dir scope into agent permission at mode-switch**.

```ts
// In mode-switch.ts, when creating notepad:
const notepadScopeRules: Permission.Ruleset = [
  { permission: "edit", pattern: notepadDir + "/**", action: "allow" },
  { permission: "write", pattern: notepadDir + "/**", action: "allow" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "write", pattern: "*", action: "deny" },
]
// These rules get appended to the agent's permission via Permission.merge,
// so they override the agent's broader edit/write permissions.
```

After this, `evaluateWithScope` can be fully replaced by `evaluate`. The function signature simplifies from `evaluateWithScope(permission, path, ruleset, scope?)` to just `evaluate(permission, path, ruleset)`.

#### Step 0d: Add `evaluateWithCommand` for bash prefix matching

**File**: `packages/opencode/src/permission/index.ts`

Since bash command prefixes are now compiled into Rules (e.g., `{ permission: "bash", pattern: "docker*", action: "allow" }`), we need the evaluation to match bash patterns against the command string rather than the file path.

```ts
const COMMAND_TOOLS = new Set(["bash"])

export function evaluateWithCommand(
  permission: string,
  path: string,
  command: string | undefined,
  ruleset: Ruleset,
): Rule {
  // For bash, match pattern against the command string
  if (command && COMMAND_TOOLS.has(permission)) {
    const cmdPrefix = command.trim().split(/\s+/)[0]
    return evaluate(permission, cmdPrefix, ruleset)
  }
  // For everything else, match pattern against the file path (existing behavior)
  return evaluate(permission, path, ruleset)
}
```

This is much simpler than the previous `evaluateWithScopeAndCommand` proposal. The key insight: **bash patterns use the command string as the "pattern target" instead of the file path**. The `evaluate` function already does wildcard matching — we just need to pass the command string instead of the file path for bash tools.

### What Discipline retains after refactor

Discipline keeps its shortcut fields for user/LLM convenience, but they are **purely syntactic sugar** — they compile to Rules and never touch the runtime directly:

```ts
export const Discipline = z.object({
  mode: z.enum(["serial", "concurrent", "background"]).default("serial"),
  delegation_depth: z.number().int().min(0).max(3).default(0),

  // Convenience shortcuts — compiled by compileDiscipline() into Permission.Ruleset
  permission_override: z.record(z.string(), z.string().array()).optional(),
  file_scope: z.string().array().optional(),
  env_scope: EnvScope.optional(),

  // Non-permission fields — remain as-is
  max_steps: z.number().int().min(1).max(50).optional(),
  timeout_seconds: z.number().int().min(30).max(600).default(300),
  return_format: z.enum(["text", "structured", "raw"]).default("text"),
})
```

The `compileDiscipline()` function is the bridge from shortcut format to runtime format. It's called once at session creation and never again.

### What this enables for later changes

With this refactor done:

- **Change 1 (env_scope)**: `allowed_commands` compiles to bash rules — no separate enforcement path needed
- **Change 2 (bash patterns)**: `evaluateWithCommand` uses the same `evaluate` engine — no separate `COMMAND_TOOLS` logic
- **Agent definitions** can use `permission` with bash patterns directly (e.g., `{ bash: { "docker*": "allow", "*": "deny" } }`) instead of needing `env_scope.allowed_commands`
- **No `Session.fileScope` field** — all scope constraints live in `Session.permission`

### Files Changed

| File                         | Change                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/session/discipline.ts`  | Add `compileDiscipline()`, expand `EnvScope` schema, keep shortcut fields                                                   |
| `src/session/session.sql.ts` | Remove `file_scope` column                                                                                                  |
| `src/session/index.ts`       | Remove `fileScope` from `Session.Info`, compile discipline into permission at create                                        |
| `src/session/schema.ts`      | Remove `fileScope` from session schemas                                                                                     |
| `src/permission/index.ts`    | Add `evaluateWithCommand()`, remove/simplify `evaluateWithScope()`                                                          |
| `src/session/prompt.ts`      | Use `compileDiscipline()` when computing effective permission for subagents; compile output_dir scope into agent permission |
| `src/tool/task.ts`           | Use `compileDiscipline()` instead of `fromOverride()` + separate `fileScope`                                                |
| `src/tool/mode-switch.ts`    | Compile output_dir scope into agent permission instead of using `evaluateWithScope`                                         |
| `migration/`                 | New migration to drop `file_scope` column                                                                                   |

---

## Change 1: Environment Isolation (`env_scope`)

### Goal

Add `env_scope` to Discipline schema, constraining an agent's executable environment. The `allowed_commands` field compiles to bash permission Rules via `compileDiscipline()`. The `path_prefix` and `env_vars` fields affect the process environment, not permissions — they remain as direct session-level configuration.

### Schema Change

**File**: `packages/opencode/src/session/discipline.ts`

```ts
export const EnvScope = z.object({
  path_prefix: z.string().array().describe("Directories prepended to PATH.").optional(),
  env_vars: z
    .record(z.string(), z.string())
    .describe("Environment variables injected into session process.")
    .optional(),
  npm_prefix: z.string().describe("Pin npm global prefix to this directory.").optional(),
  allowed_commands: z
    .string()
    .array()
    .describe("Command prefixes allowed for bash. Compiled to bash permission rules via compileDiscipline().")
    .optional(),
})
```

`allowed_commands` is a **shortcut** — `compileDiscipline()` turns `["docker", "curl"]` into `{ permission: "bash", pattern: "docker*", action: "allow" }` + `{ permission: "bash", pattern: "curl*", action: "allow" }` + `{ permission: "bash", pattern: "*", action: "deny" }`.

**File**: `packages/opencode/src/agent/agent.ts` — add `envScope` to `Agent.Info`:

```ts
envScope: EnvScope.optional(),
```

**File**: `packages/opencode/src/config/config.ts` — add `env_scope` to agent config schema.

### Runtime Enforcement

**File**: `packages/opencode/src/session/prompt.ts`

Merge envScope from agent + discipline (discipline overrides agent defaults):

```ts
function resolveEnvScope(agentEnvScope: EnvScope, disciplineEnvScope: EnvScope): EnvScope | undefined {
  if (!agentEnvScope && !disciplineEnvScope) return undefined
  return {
    path_prefix: disciplineEnvScope?.path_prefix ?? agentEnvScope?.path_prefix,
    env_vars: { ...agentEnvScope?.env_vars, ...disciplineEnvScope?.env_vars },
    npm_prefix: disciplineEnvScope?.npm_prefix ?? agentEnvScope?.npm_prefix,
    allowed_commands: disciplineEnvScope?.allowed_commands ?? agentEnvScope?.allowed_commands,
  }
}
```

Note: `allowed_commands` IS included in this merge function. While `compileDiscipline()` handles the compilation of `allowed_commands` into permission Rules, the merge must happen first — `resolveEnvScope` is called to merge agent + discipline env_scope before creating the Discipline object that gets passed to `compileDiscipline`. If `allowed_commands` were excluded from the merge, agent-level `allowed_commands` defaults would never be compiled into Rules, requiring a separate code path to handle agent defaults. Including it keeps the merge logic simple and consistent.

### Bash Command Evaluation

**File**: `packages/opencode/src/permission/index.ts`

Bash commands are evaluated via `evaluateWithCommand()` (from Change 0). When the bash tool calls `evaluateWithCommand("bash", filePath, commandString, effectivePermission)`, it matches `commandString` against patterns like `docker*`, `curl*`, etc.

If the command doesn't match any allow pattern, the blanket `deny` rule `{ bash: "*", deny }` blocks it. The user approval flow (Permission.ask) works naturally — if the rule evaluates to `ask`, the user can approve, and the approval adds an `allow` rule for that command prefix.

### Files Changed

| File                        | Change                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `src/session/discipline.ts` | Add `EnvScope` schema + `env_scope` field (allowed_commands compiles via `compileDiscipline`) |
| `src/agent/agent.ts`        | Add `envScope` to `Agent.Info`, propagate from config                                         |
| `src/config/config.ts`      | Add `env_scope` to agent config schema                                                        |
| `src/session/prompt.ts`     | `resolveEnvScope()` for process-level env vars + PATH                                         |
| `src/permission/index.ts`   | `evaluateWithCommand()` for bash prefix matching (from Change 0)                              |

---

## Change 2: Bash Command Prefix Patterns (Absorbed into Change 0+1)

### Status: No longer a separate change

The original Change 2 proposed adding `evaluateWithScopeAndCommand` as a new function. After the Permission unification refactor (Change 0), this is no longer needed:

- `permission_override` with bash patterns (e.g., `{ bash: ["allow", "docker*"] }`) compiles via `compileDiscipline()` → `fromOverride()` → Rules
- Bash command evaluation uses `evaluateWithCommand()` which just calls `evaluate()` with the command string instead of the file path
- Agent definitions can use `Permission.fromConfig({ bash: { "docker*": "allow", "*": "deny" } })` directly — no separate shortcut needed

**The only remaining work from original Change 2**: ensure the bash tool calls `evaluateWithCommand()` instead of `evaluate()`. This is a one-line change in the bash tool implementation.

### Config Example (direct permission, no shortcut needed)

```json
{
  "agent": {
    "docker-sandbox": {
      "permission": {
        "bash": { "docker*": "allow", "docker-compose*": "allow", "*": "deny" }
      }
    }
  }
}
```

Or using the Discipline shortcut:

```json
{
  "permission_override": {
    "bash": ["allow", "docker*", "docker-compose*"]
  }
}
```

Both produce the same Ruleset via `compileDiscipline()`.

### Files Changed

| File                               | Change                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `src/tool/bash.ts` (or equivalent) | Call `evaluateWithCommand()` instead of `evaluate()` for bash permission checks |

---

## Change 3: Enhanced `structured` Return Format for File Handoff

### Goal

Make the existing `structured` return format support file-based handoff without adding new modes. Subagent writes artifacts to its `output_dir`; the parent receives a concise summary + file paths instead of full content.

### Current State

- `return_format: "text"` — inline `<task_result>` with full text
- `return_format: "structured"` — adds prompt instruction for JSON/Markdown output
- `return_format: "raw"` — full conversation trace
- Background mode already does file-like handoff: parent gets task_id, retrieves later

### Change

**File**: `packages/opencode/src/tool/task.ts`

When `return_format === "structured"` and the agent has an `output_dir`, modify the prompt_append to instruct the subagent:

```ts
if (discipline.return_format === "structured" && agent.outputDir) {
  const outputDir = normalizeOutputDir(agent.outputDir)
  promptParts.push({
    type: "text",
    text: `IMPORTANT: Write your primary output to files in ${outputDir}. Your final response must be a concise summary (≤200 words) with: (1) key findings, (2) paths to written artifacts. Do NOT dump full content into your final response — the parent agent will read the files directly.`,
  })
}
```

Then, in the result extraction, when `return_format === "structured"` and agent has `outputDir`, verify artifacts exist on disk:

```ts
if (discipline.return_format === "structured" && agent.outputDir) {
  const outputDir = normalizeOutputDir(agent.outputDir)
  const fullDir = Instance.project.vcs ? path.join(Instance.worktree, outputDir) : outputDir
  const artifacts = await Glob.scan("**/*.{md,json,txt}", { cwd: fullDir }).catch(() => [] as string[])
  const artifactNote =
    artifacts.length > 0
      ? `\n\nArtifacts written to ${outputDir}:\n${artifacts.map((f) => `- ${f}`).join("\n")}`
      : `\n\nWARNING: No artifacts found in output directory ${outputDir}.`
  output = [`task_id: ${session.id}`, "", "<task_result>", text, artifactNote, "</task_result>"].join("\n")
}
```

This achieves the file handoff effect without a new mode:

- Parent context only gets a ≤200 word summary + file paths
- Parent reads artifacts on demand with `read` tool
- No change to background mode (it already works this way)

### Files Changed

| File                              | Change                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `src/tool/task.ts`                | Modify structured mode prompt_append, add artifact verification                   |
| `src/tool/task.txt` (description) | Document that `structured` mode supports file handoff when agent has `output_dir` |

---

## Change 4: Verifier Agent + Provenance Sidecar

### Goal

Add a native `verifier` subagent that anchors citations, verifies source URLs, removes unsourced claims, and produces a `.provenance.md` sidecar. This is a general-purpose subagent (like `explore`, `general`), built into the software.

### Verifier Agent Definition

**File**: `packages/opencode/src/agent/agent.ts`

Add to the native agents section. Note: bash permission uses the unified pattern format — `curl*` matches both `curl` and `curl -sL ...`:

```ts
verifier: {
  name: "verifier",
  description: "Post-process a draft to add inline citations, verify every source URL, remove unsourced claims, and produce a provenance sidecar.",
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      read: "allow",
      write: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      bash: { "curl*": "allow", "wget*": "allow", "*": "deny" },
      websearch: "allow",
      webfetch: "allow",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
    }),
    user,
  ),
  options: {},
  mode: "subagent",
  native: true,
  prompt: PROMPT_VERIFIER,
},
```

The bash permission `{ "curl*": "allow", "wget*": "allow", "*": "deny" }` is a standard Permission config. It compiles to Rules via `Permission.fromConfig()`. At runtime, `evaluateWithCommand()` matches the command string against these patterns. No separate `allowed_commands` or env_scope needed for this agent.

### Verifier Prompt

**File**: `packages/opencode/src/agent/prompt/verifier.txt` (new)

Core integrity rules, modeled after Feynman's verifier but adapted for Aether:

````
You are Aether's verifier agent.

You receive a draft document and the research files it was built from. Your job is to:

1. **Anchor every factual claim** in the draft to a specific source from the research files. Insert inline citations [1], [2], etc. directly after each claim.
2. **Verify every source URL** — use webfetch to confirm each URL resolves and contains the claimed content. Flag dead links.
3. **Build the final Sources section** — a numbered list at the end where every number matches at least one inline citation.
4. **Remove unsourced claims** — if a factual claim cannot be traced to any source in the research files, either find a source for it or remove it. Do not leave unsourced factual claims.
5. **Verify meaning, not just topic overlap.** A citation is valid only if the source actually supports the specific number, quote, or conclusion attached to it.
6. **Refuse fake certainty.** Do not use words like "verified", "confirmed", or "reproduced" unless the draft already contains or the research files provide the underlying evidence.

## Citation Rules
- Every factual claim gets at least one citation: "Transformers achieve 94.2% on MMLU [3]."
- No orphan citations — every [N] in the body must appear in Sources.
- No orphan sources — every entry in Sources must be cited at least once.
- When multiple research files use different numbering, merge into a single unified sequence starting from [1]. Deduplicate sources that appear in multiple files.

## Source Verification
For each source URL:
- **Live:** keep as-is.
- **Dead/404:** search for an alternative URL. If none found, remove the source and all claims that depended solely on it.
- **Redirects to unrelated content:** treat as dead.

## Provenance Sidecar
After verification, write a `.provenance.md` file next to the output file:

```markdown
# Provenance: [topic]

- **Date:** [date]
- **Sources consulted:** [count]
- **Sources accepted:** [count + list]
- **Sources rejected:** [dead, unverifiable, or removed + reasons]
- **Verification:** PASS / PASS WITH NOTES / BLOCKED
- **Checks performed:** [list of checks]
- **Issues found:** [FATAL / MAJOR / MINOR findings]
````

## Output Contract

- Save the complete final document with inline citations added throughout and a verified Sources section.
- Write the `.provenance.md` sidecar alongside the output file.
- Do not change the intended structure of the draft, but you may delete or soften unsupported factual claims.
- Before finishing, verify on disk that both the cited file and the provenance file exist. Use `glob` or `grep` to confirm.

````

### Provenance Sidecar Schema

**File**: `packages/opencode/src/session/provenance.ts` (new)

```ts
import z from "zod"

export const Provenance = z.object({
  topic: z.string(),
  date: z.string(),
  sources_consulted: z.number(),
  sources_accepted: z.array(z.object({ id: z.number(), url: z.string(), status: z.string() })),
  sources_rejected: z.array(z.object({ id: z.number(), url: z.string(), reason: z.string() })),
  verification: z.enum(["PASS", "PASS_WITH_NOTES", "BLOCKED"]),
  checks_performed: z.string().array(),
  issues: z.array(z.object({
    severity: z.enum(["FATAL", "MAJOR", "MINOR"]),
    description: z.string(),
    location: z.string().optional(),
  })),
})
export type Provenance = z.infer<typeof Provenance>
````

This schema is for reference and potential programmatic use (e.g., verification status badges in UI). The actual output is a Markdown file written by the verifier agent.

### Agent Config Example

In `opencode.json`:

```json
{
  "agent": {
    "verifier": {
      "env_scope": {
        "allowed_commands": ["curl", "wget"]
      },
      "output_dir": "outputs"
    }
  }
}
```

### Files Changed

| File                            | Change                                                    |
| ------------------------------- | --------------------------------------------------------- |
| `src/agent/agent.ts`            | Add `verifier` native agent definition                    |
| `src/agent/prompt/verifier.txt` | New file — verifier integrity rules + provenance template |
| `src/session/provenance.ts`     | New file — `Provenance` schema                            |
| `src/tool/task.ts`              | Register verifier as accessible subagent                  |

---

## Change 5: Scale Decision Table

### Recommendation: Agent Definition Parameter

The Scale Decision Table should be a **parameter on the agent definition** (`Agent.Info`), not a Discipline or skill-level concept. Reasoning:

1. **Scale is about the agent's character, not the session's discipline** — a researcher agent always has scale rules; they're part of its identity.
2. **Different agents have different scale thresholds** — a verifier never spawns subagents; a researcher might spawn 4-6. The scale decision belongs to the agent, not the call site.
3. **Agent definitions already have `steps`, `fallbackModels`, `domain`** — scale decision fits the same pattern of "operational parameters that define how this agent behaves."
4. **It's simpler than a skill-level concept** — if it were in the skill, the same agent would need different scale rules depending on which skill invoked it, which is confusing.

### Schema

**File**: `packages/opencode/src/agent/agent.ts`

Add `scaleDecision` to `Agent.Info`:

```ts
scaleDecision: z
  .object({
    direct_threshold: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("Maximum tool calls for direct (no-subagent) mode. Topics below this are handled by the agent alone.")
      .optional(),
    rules: z
      .array(z.object({
        condition: z.string().describe("When this rule applies. E.g. 'narrow question', '2-3 item comparison', 'broad survey'."),
        subagent_count: z.number().int().min(0).max(8).describe("Number of subagents to spawn."),
        subagent_type: z.string().describe("Agent type for subagents. E.g. 'explore', 'general'."),
        mode: z.enum(["serial", "concurrent", "background"]).describe("Execution mode for subagents."),
      }))
      .describe("Ordered rules for subagent allocation. First matching rule wins.")
      .optional(),
    never_spawn_for: z
      .string()
      .array()
      .describe("Intent categories that must NEVER spawn subagents. E.g. ['quick-lookup', 'explainer'].")
      .optional(),
  })
  .optional(),
```

**File**: `packages/opencode/src/config/config.ts`

Add `scale_decision` to agent config schema:

```ts
scale_decision: z.object({
  direct_threshold: z.number().int().min(1).max(20).optional(),
  rules: z.array(z.object({
    condition: z.string(),
    subagent_count: z.number().int().min(0).max(8),
    subagent_type: z.string(),
    mode: z.enum(["serial", "concurrent", "background"]),
  })).optional(),
  never_spawn_for: z.string().array().optional(),
}).optional(),
```

### Prompt Injection

**File**: `packages/opencode/src/session/prompt.ts`

When `buildAgentDeclarations` finds `scaleDecision`, inject it:

```ts
if (agent.scaleDecision) {
  sections.push(`## Scale Decision Rules`)
  sections.push(
    `- Direct mode (no subagents) for topics needing ≤${agent.scaleDecision.direct_threshold ?? 10} tool calls.`,
  )
  if (agent.scaleDecision.never_spawn_for?.length) {
    sections.push(`- NEVER spawn subagents for: ${agent.scaleDecision.never_spawn_for.join(", ")}.`)
  }
  if (agent.scaleDecision.rules?.length) {
    sections.push(`- Subagent allocation rules (first match wins):`)
    for (const rule of agent.scaleDecision.rules) {
      sections.push(`  - "${rule.condition}" → ${rule.subagent_count} ${rule.subagent_type} subagents (${rule.mode})`)
    }
  }
  sections.push(`Do not inflate simple questions into multi-agent surveys. If the topic is narrow, handle it directly.`)
}
```

### Config Example

In `.aether/agent/research.md`:

```yaml
scale_decision:
  direct_threshold: 10
  never_spawn_for:
    - quick-lookup
    - explainer
  rules:
    - condition: "2-3 item comparison"
      subagent_count: 2
      subagent_type: explore
      mode: concurrent
    - condition: "broad survey or multi-faceted topic"
      subagent_count: 3
      subagent_type: explore
      mode: concurrent
    - condition: "complex multi-domain research"
      subagent_count: 5
      subagent_type: explore
      mode: background
```

### Files Changed

| File                    | Change                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `src/agent/agent.ts`    | Add `scaleDecision` to `Agent.Info`, propagate from config |
| `src/config/config.ts`  | Add `scale_decision` to agent config schema                |
| `src/session/prompt.ts` | Inject scale decision rules in `buildAgentDeclarations`    |

---

## Change 6: Reviewer Agent — Subagent vs Primary

### Recommendation: Subagent

The reviewer should be a **subagent** (like verifier), not a primary agent alongside research. Reasoning:

1. **Review is a post-processing step, not a standalone workflow** — in Feynman, reviewer is always called by a lead agent after draft/citation. Users don't enter "review mode" and then stay there.
2. **Review follows research, not parallels it** — the sequence is always research → draft → verify → review. Making reviewer primary would imply it's an independent mode users switch into, which doesn't match the workflow.
3. **Reviewer needs the draft artifact as input** — it reads a file produced by another agent. A primary agent would need to ask the user to provide the file, creating unnecessary friction.
4. **Feynman's reviewer is also a subagent** — it's defined in `.feynman/agents/reviewer.md` with `mode: subagent` (implicit — it's invoked via the `subagent` tool, not a standalone mode).

The **peer-review skill** (`/review` slash command) already provides the user-facing entry point. The user types `/review <file>` and the lead agent (or research agent) dispatches the reviewer subagent. This matches Feynman's pattern exactly.

### Reviewer Agent Definition

**File**: `packages/opencode/src/agent/agent.ts`

```ts
reviewer: {
  name: "reviewer",
  description: "Simulate a skeptical but constructive peer review with severity-graded feedback and inline annotations.",
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      bash: { "rg*": "allow", "grep*": "allow", "diff*": "allow", "wc*": "allow", "stat*": "allow", "*": "deny" },
      websearch: "allow",
      webfetch: "allow",
      write: "allow",
      edit: "allow",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
    }),
    user,
  ),
  options: {},
  mode: "subagent",
  native: true,
  prompt: PROMPT_REVIEWER,
},
```

Key design choices:

- `bash` uses unified pattern format: `rg*` matches `rg`, `rg -l`, etc. Evaluated via `evaluateWithCommand()` — no separate enforcement path
- `websearch` + `webfetch` allowed — reviewer may need to verify external claims
- `write` + `edit` allowed — reviewer writes the review artifact and may fix minor issues

### Reviewer Prompt

**File**: `packages/opencode/src/agent/prompt/reviewer.txt` (new)

```
You are Aether's reviewer agent.

Your job is to act like a skeptical but fair reviewer. You receive a cited draft and research files. You must:

1. **Identify unsupported claims** — every factual claim must trace to a source. Flag any that don't.
2. **Check logical gaps** — missing baselines, missing ablations, evaluation mismatches, claims that outrun experiments.
3. **Grade severity** — FATAL (must fix before delivery), MAJOR (should fix, note in open questions), MINOR (acceptable).
4. **Keep looking after finding the first problem** — do not stop at one issue if others remain visible.
5. **Verify on disk** — after noting an issue, use rg/grep/diff/stat to confirm it actually exists in the file. Do not claim an issue exists unless you can point to the exact text.

## Review Output Format

### Part 1: Structured Review
- Summary (1-2 paragraphs)
- Strengths (with specific evidence references)
- Weaknesses (FATAL / MAJOR / MINOR, each referencing a specific passage)
- Questions for the author
- Verdict + confidence score
- Revision Plan (prioritized concrete steps)

### Part 2: Inline Annotations
Quote specific passages and annotate them:
> "We achieve state-of-the-art results on all benchmarks"
**[W1] FATAL:** Table 3 shows underperformance on 2 of 5 benchmarks.

Reference weakness IDs from Part 1 so annotations link back.

## Integrity Rules
- Every weakness must reference a specific passage or section.
- Do not praise vaguely. Every positive claim tied to specific evidence.
- Preserve uncertainty. If the draft might pass, say so explicitly.
- Never say "verified" or "confirmed" unless you performed the check and can show the command/output.

## Output Contract
- Write the review to the specified output path (default: review.md).
- The review must contain both structured review AND inline annotations.
- Before finishing, verify the output file exists on disk using glob or grep.
```

### Files Changed

| File                            | Change                                              |
| ------------------------------- | --------------------------------------------------- |
| `src/agent/agent.ts`            | Add `reviewer` native agent definition              |
| `src/agent/prompt/reviewer.txt` | New file — reviewer integrity rules + output format |
| `src/tool/task.ts`              | Register reviewer as accessible subagent            |

---

## Change 7: Research Workflow Definition

### Goal

Define the complete research agent with Feynman-inspired workflow: Plan → Scale → Gather → Draft → Cite → Review → Deliver, with integrity commandments and provenance tracking.

### Research Agent Definition

**File**: `.aether/agent/research.md` (update existing)

The existing research.md has a good foundation (Intent Gate, 5 phases, notepad structure). We update it to incorporate the Feynman-inspired improvements:

Key changes:

1. Add **Integrity Commandments** per Feynman's pattern
2. Add **Plan Gate** — deep research requires user confirmation before gathering
3. Add **Scale Decision** — reference `scaleDecision` parameter
4. Add **File Handoff instructions** — subagents write to output_dir, lead reads from files
5. Add **Verifier + Reviewer post-processing** — mandatory cite then review steps
6. Add **Provenance Sidecar** requirement
7. Add **On-disk verification** instructions
8. Add **Slug naming convention**

The full updated agent definition (frontmatter + prompt) will be written as part of implementation. Here's the structural outline:

```yaml
---
description: Deep research, literature search, and analysis mode
color: "#7C3AED"
mode: primary
permission:
  edit: allow
  bash: deny
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  research_exit: allow
  plan_enter: allow
  task: allow
  skill: allow
  read: allow
  glob: allow
  grep: allow
enter_description: Use when the user's request would benefit from deep research, literature search, or knowledge analysis
exit_description: Use when research is complete and findings are ready to move to planning or implementation
exit_options:
  - label: Plan
    agent: plan
    description: Switch to plan agent to create an implementation plan based on research findings
  - label: Build
    agent: build
    description: Switch to build agent to start implementing directly based on research findings
  - label: Stay
    agent: research
    description: Continue researching
fallback_models:
  - openai/gpt-5.4
  - model: anthropic/claude-sonnet-4-5
    variant: high
  - zai-coding-plan/glm-5
mcp:
  arxiv-search: true
output_dir: research
scale_decision:
  direct_threshold: 10
  never_spawn_for:
    - quick-lookup
    - explainer
  rules:
    - condition: "2-3 item comparison"
      subagent_count: 2
      subagent_type: explore
      mode: concurrent
    - condition: "broad survey or multi-faceted topic"
      subagent_count: 3
      subagent_type: explore
      mode: concurrent
    - condition: "complex multi-domain research"
      subagent_count: 5
      subagent_type: explore
      mode: background
outputs:
  - cited-brief
  - provenance
env_scope:
  path_prefix:
    - node_modules/.bin
  env_vars:
    AETHER_SESSION_DIR: "{{session_dir}}"
  # allowed_commands NOT needed here — bash is already denied in permission.
  # If research agent needs bash for specific tools, add via permission config:
  # permission:
  #   bash: { "alpha*": "allow", "curl*": "allow", "rg*": "allow", "*": "deny" }
  # Or use env_scope.allowed_commands shortcut which compiles to the same Rules.
---
```

### Research Workflow Prompt Structure

The `prompt_append` section will be restructured into 7 phases (Feynman-inspired but adapted for Aether):

#### Integrity Commandments (embedded in every research agent invocation)

```
## Integrity Commandments
1. Never fabricate a source. Every named tool, project, paper, or dataset must have a verifiable URL.
2. URL or it didn't happen. Every entry in your evidence must include a direct, checkable URL.
3. Read before you summarize. Do not infer contents from title or abstract fragments when direct access is possible.
4. Mark status honestly. Distinguish between claims read directly, claims inferred, and unresolved questions.
5. Never say "verified" or "confirmed" unless you performed the check and can show the command/output.
6. Do not invent experimental results, scores, datasets, or quantitative comparisons. If data is missing, write "TODO" or "blocked".
7. Every quantitative claim must trace to a source URL, research note, or artifact path. No provenance = not included.
```

#### Phase 0: Intent Gate + Scale Decision

```
### Phase 0: Intent Gate

Classify the user's intent:
| Intent | Strategy | Subagents |
|--------|----------|-----------|
| quick-lookup | Direct search, inline answer | 0 |
| explainer | Direct search, structured answer | 0 |
| knowledge-survey | Broad overview | 2-3 explore |
| methodology-comparison | Compare 2-5 approaches | 2-3 explore |
| feasibility-study | Evaluate viability | 3 explore |
| literature-review | Systematic academic review | 3-4 explore |
| deep-research | Comprehensive investigation | 4-5 explore |

NEVER spawn subagents for quick-lookup or explainer intents.

Derive a slug from the topic (lowercase, hyphens, ≤5 words). All files use this slug as prefix.
```

#### Phase 1: Plan Gate

```
### Phase 1: Plan

Write outputs/.plans/<slug>.md with:
- Key questions
- Evidence needed
- Scale decision (which intent category, how many subagents)
- Task ledger (question → owner → status)
- Verification log

For deep-research and literature-review intents:
STOP and ask user for confirmation before gathering.
"Proceed with this research plan? Reply 'yes' to continue, or tell me what to change."

For quick-lookup, explainer, and knowledge-survey:
Continue immediately. Do not ask for confirmation.
```

#### Phase 2: Gather

```
### Phase 2: Gather

If scale decision is direct (0 subagents):
- Search and fetch sources yourself.
- Minimum 3 distinct queries covering different angles.
- Write notes to outputs/<slug>-research-direct.md.
- Continue to Phase 3.

If scale decision requires subagents:
- Write per-researcher briefs: outputs/.plans/<slug>-T1.md, etc.
- Dispatch explore subagents with structured prompts:
  - Include learnings.md context for forward-passing
  - Set return_format: "structured" for file handoff
  - Set failFast: false equivalent (Aether task tool already handles)
- After subagents complete, read their output files.
- Update task ledger and verification log in plan file.
```

#### Phase 3: Draft

```
### Phase 3: Draft

Write the report yourself. Do not delegate synthesis.

Save to outputs/<slug>-draft.md.

Include:
- Executive summary
- Findings organized by question/theme
- Inline source references [1], [2], etc.
- Evidence-backed caveats and disagreements
- Open questions
- No invented sources, results, figures, or benchmarks

Before proceeding, sweep the draft:
- Every critical claim must map to a source URL, research note, or artifact path.
- Remove or downgrade unsupported claims.
- Mark inferences as inferences.
```

#### Phase 4: Cite (Verifier)

```
### Phase 4: Cite

For direct-search runs (0 subagents):
- Do citation yourself. Verify reachable URLs with webfetch.
- Copy draft to outputs/<slug>-cited.md with inline citations and Sources section.

For subagent runs:
- Dispatch the verifier subagent:
  {
    "subagent_type": "verifier",
    "prompt": "Add inline citations to outputs/<slug>-draft.md using the research files as source material. Verify every URL. Write the complete cited brief to outputs/<slug>-cited.md. Write provenance to outputs/<slug>.provenance.md.",
    "return_format": "structured"
  }

After verifier returns, verify on disk that outputs/<slug>-cited.md exists.
```

#### Phase 5: Review

```
### Phase 5: Review

For direct-search runs:
- Review the cited draft yourself.
- Write outputs/<slug>-verification.md with FATAL/MAJOR/MINOR findings.
- Fix FATAL issues before delivery.

For subagent runs:
- Dispatch the reviewer subagent (only AFTER cited.md exists):
  {
    "subagent_type": "reviewer",
    "prompt": "Review outputs/<slug>-cited.md for unsupported claims, logical gaps, and overstated confidence. This is a verification pass. Write review to outputs/<slug>-review.md.",
    "return_format": "structured"
  }

If reviewer flags FATAL issues:
- Fix them in the draft.
- Run one more review pass.
- Verify fixes on disk using grep/rg to confirm old text removed and new text exists.

Note MAJOR issues in Open Questions. Accept MINOR issues.
```

#### Phase 6: Deliver

```
### Phase 6: Deliver

Copy final artifact to outputs/<slug>.md.
Ensure provenance sidecar exists: outputs/<slug>.provenance.md.

Before responding:
1. Verify on disk that outputs/<slug>.md exists (use glob).
2. Verify that outputs/<slug>.provenance.md exists (use glob).
3. If verification could not be completed, set Verification: BLOCKED.
4. Do not claim fixes were applied unless grep/rg confirms them on disk.

Final response: brief — link the output file, provenance file, and any blocked checks.

Then call research_exit.
```

### Notepad Structure Update

The existing notepad (sources.md, findings.md, gaps.md, learnings.md, report.md) remains, but `report.md` is replaced by the phased file approach:

- `outputs/.plans/<slug>.md` — plan + task ledger + verification log
- `outputs/<slug>-research-direct.md` — direct research notes
- `outputs/<slug>-draft.md` — draft
- `outputs/<slug>-cited.md` — cited draft (after verifier)
- `outputs/<slug>.md` — final deliverable
- `outputs/<slug>.provenance.md` — provenance sidecar

The notepad files (sources.md, findings.md, gaps.md, learnings.md) continue to serve as the lead agent's working memory, updated after each phase.

### Files Changed

| File                        | Change                                                                     |
| --------------------------- | -------------------------------------------------------------------------- |
| `.aether/agent/research.md` | Complete rewrite — frontmatter + 7-phase workflow + integrity commandments |
| `src/tool/mode-switch.ts`   | Update notepad creation for research mode to include slug support          |

---

## Implementation Order

| Priority | Change                                        | Dependencies                                                | Estimated Effort |
| -------- | --------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| 0        | Change 0: Unify Discipline → Permission model | None (prerequisite refactor)                                | Medium           |
| 1        | Change 1: Environment isolation (`env_scope`) | Change 0 (uses `compileDiscipline` + `evaluateWithCommand`) | Small            |
| 2        | Change 5: Scale Decision Table                | None (pure Agent.Info extension)                            | Small            |
| 3        | Change 3: Enhanced structured return format   | None (task.ts modification)                                 | Small            |
| 4        | Change 4: Verifier agent                      | Change 0 (unified bash patterns), Change 3 (file handoff)   | Medium           |
| 5        | Change 6: Reviewer agent                      | Change 0 (unified bash patterns), Change 3 (file handoff)   | Medium           |
| 6        | Change 7: Research workflow definition        | Changes 0-6 all needed                                      | Large            |

Change 0 must come first — it refactors the Permission/Discipline model that all other changes depend on. Changes 1-2 can run in parallel after Change 0. Changes 4-5 can also run in parallel.

**Recommended commit strategy**:

- Commit 0: Change 0 (Permission unification refactor — remove `file_scope` from Session, add `compileDiscipline`, add `evaluateWithCommand`, simplify `evaluateWithScope`)
- Commit 1: Change 1 + 5 (env_scope + scaleDecision — both schema-only, no runtime impact beyond what Change 0 enables)
- Commit 2: Change 3 (structured return format — task.ts changes)
- Commit 3: Changes 4 + 6 (verifier + reviewer agents — new agent definitions + prompts)
- Commit 4: Change 7 (research workflow — the big integration)

Each commit should pass `bun typecheck` in `packages/opencode`.

---

## Testing Strategy

| Change   | Tests Needed                                                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change 0 | `compileDiscipline()` test: verify `permission_override`, `file_scope`, `env_scope.allowed_commands` all compile to correct Rules; `evaluateWithCommand()` test: bash patterns match command strings; verify `file_scope` removal from Session doesn't break existing sessions; migration test for `file_scope` column drop |
| Change 1 | `EnvScope` schema parse test; `resolveEnvScope()` merge test (agent default + discipline override); bash command denied/allowed via compiled Rules                                                                                                                                                                          |
| Change 2 | (Absorbed — covered by Change 0's `evaluateWithCommand` tests)                                                                                                                                                                                                                                                              |
| Change 3 | `structured` mode with `output_dir` test: verify prompt_append includes file handoff instruction; artifact verification test: confirm output files are checked on disk                                                                                                                                                      |
| Change 4 | Verifier agent registration test; provenance schema test; verifier prompt content test                                                                                                                                                                                                                                      |
| Change 5 | `scaleDecision` schema test; `buildAgentDeclarations` injection test                                                                                                                                                                                                                                                        |
| Change 6 | Reviewer agent registration test; bash command restriction test via unified pattern format                                                                                                                                                                                                                                  |
| Change 7 | End-to-end research workflow test; plan gate confirmation test; slug naming test                                                                                                                                                                                                                                            |

Test location: `packages/opencode/test/agent/`

---

## Implementation Deviations from Original Plan

During implementation, several deviations from this design plan were found to be necessary or superior. The plan has been updated to reflect these corrections, but they are documented here for traceability.

### 1. Rule ordering in `compileDiscipline` — deny-before-allow (CRITICAL)

**Original plan code**: allow rules first, then blanket deny rules.

```ts
// WRONG — original plan code
for (const scopePattern of discipline.file_scope) {
  ruleset.push({ permission: tool, pattern: scopePattern, action: "allow" })
}
ruleset.push({ permission: tool, pattern: "*", action: "deny" })
```

**Implementation**: deny rules first, then allow rules.

```ts
// CORRECT — deny-before-allow
ruleset.push({ permission: tool, pattern: "*", action: "deny" })
for (const scopePattern of discipline.file_scope) {
  ruleset.push({ permission: tool, pattern: scopePattern, action: "allow" })
}
```

**Why**: `evaluate()` uses `findLast` — the last matching rule wins. If allow rules came before deny rules, `findLast` would always match the deny `*` pattern (since `*` matches everything), making all allow rules ineffective and denying ALL paths. The text explanation in the original plan correctly described "deny-first, allow-second" ordering but the code snippet had the opposite. The same ordering issue applied to `env_scope.allowed_commands` compilation. The plan has been updated to correct the code and explain the ordering requirement explicitly.

### 2. `allowed_commands` in `resolveEnvScope` merge function

**Original plan**: Excluded `allowed_commands` from `resolveEnvScope`, stating "allowed_commands handled by compileDiscipline — not needed here".

**Implementation**: Included `allowed_commands` in the merge function:

```ts
allowed_commands: disciplineEnvScope?.allowed_commands ?? agentEnvScope?.allowed_commands,
```

**Why**: `resolveEnvScope` is called to merge agent + discipline env_scope _before_ creating the Discipline object that gets passed to `compileDiscipline`. If `allowed_commands` were excluded from the merge, agent-level `allowed_commands` defaults would never be compiled into Rules, requiring a separate code path to handle agent defaults. Including it keeps the merge logic simple and ensures the compiled Rules reflect both agent and discipline settings.

### 3. Artifact verification — listing specific files vs directory check

**Original plan**: Used `glob(["*.md", "*.json"])` to list individual artifact filenames.

**Initial implementation**: Only checked if the output directory exists (`fs.stat`).

**Current (updated to match plan)**: Uses `Glob.scan("**/*.{md,json,txt}")` to list individual artifact files:

```ts
const artifacts = await Glob.scan("**/*.{md,json,txt}", { cwd: fullDir }).catch(() => [] as string[])
const artifactNote =
  artifacts.length > 0
    ? `\n\nArtifacts written to ${outputDir}:\n${artifacts.map((f) => `- ${f}`).join("\n")}`
    : `\n\nWARNING: No artifacts found in output directory ${outputDir}.`
```

**Why**: Listing specific artifact filenames is more useful for the parent agent — it can immediately see which files are available to read rather than needing to glob the directory itself. The original plan's approach was correct here. The implementation was updated to match.

### 4. `output_dir` value: `research` instead of `outputs`

**Original plan**: `output_dir: outputs`

**Implementation**: `output_dir: research`

**Why**: `research` is more semantically specific — it describes the agent's output type (research artifacts) rather than the generic concept of "outputs". The value is only used as a directory name prefix under `.aether/`, so `research` produces `.aether/research/notepads/...` which is clearer than `.aether/outputs/notepads/...`. The prompt-level path references (`outputs/<slug>-draft.md`) are instructional text in the prompt template, not filesystem paths — the agent receives the actual notepad directory path from `mode-switch.ts` at runtime.

---

## Open Design Questions

1. **Should `env_scope.allowed_commands` always compile to a blanket deny?** Current design: `allowed_commands: ["docker"]` compiles to `{ bash: "docker*", allow } + { bash: "*", deny }`. This means if the agent definition also has `bash: allow` generally, the blanket deny from `allowed_commands` would override it via `findLast`. Alternative: only add the blanket deny if `allowed_commands` is explicitly set, and leave bash permission unchanged if `allowed_commands` is absent. Recommendation: add blanket deny only when `allowed_commands` is present — this matches the semantic intent ("restrict bash to only these commands").

2. **Should the reviewer have a primary mode variant?** Some users may want to enter "review mode" and stay there for extended peer review work. Recommendation: start as subagent only. If demand emerges, add a `peer-review` primary agent later via config (same definition, `mode: primary`).

3. **Should provenance be a structured JSON file or Markdown?** Recommendation: Markdown (like Feynman) for human readability, with the `Provenance` schema available for future programmatic consumption (UI badges, CI checks).

4. **Should the plan gate (Phase 1 confirmation) be configurable?** Recommendation: yes — add `confirm_plan: boolean` to `Agent.Info` / config. Default `true` for research agent, `false` for quick workflows.

5. **Should `compileDiscipline` run at agent-definition time or session-creation time?** Recommendation: session-creation time. Agent definitions store the shortcut format (readable, editable). The compilation happens once when the session is created, producing the final `effectivePermission`. This keeps agent definitions human-friendly and the runtime efficient.

6. **Migration strategy for `file_scope` column removal?** The `file_scope` column in `SessionTable` must be dropped. Existing sessions that have `file_scope` data need their scope patterns migrated into the `permission` JSON column before the drop. The migration should: (a) read each session's `file_scope`, (b) compile it into Permission Rules, (c) append those rules to the session's `permission` JSON, (d) drop the column.
