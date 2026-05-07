import z from "zod"
import { Permission } from "@/permission"

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
export type EnvScope = z.infer<typeof EnvScope>

export function resolveEnvScope(
  agentEnvScope: EnvScope | undefined,
  disciplineEnvScope: EnvScope | undefined,
): EnvScope | undefined {
  if (!agentEnvScope && !disciplineEnvScope) return undefined
  return {
    path_prefix: disciplineEnvScope?.path_prefix ?? agentEnvScope?.path_prefix,
    env_vars: { ...agentEnvScope?.env_vars, ...disciplineEnvScope?.env_vars },
    npm_prefix: disciplineEnvScope?.npm_prefix ?? agentEnvScope?.npm_prefix,
    allowed_commands: disciplineEnvScope?.allowed_commands ?? agentEnvScope?.allowed_commands,
  }
}

export const Discipline = z.object({
  mode: z
    .enum(["serial", "concurrent", "background"])
    .describe(
      "serial: await result before proceeding. concurrent: start with other tasks, await all together. background: spawn immediately, main agent continues.",
    )
    .default("serial"),

  delegation_depth: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("How many more delegation levels this sub-agent is allowed. 0 = cannot delegate at all.")
    .default(0),

  permission_override: z
    .record(z.string(), z.string().array())
    .describe(
      "Dynamic permission overrides. Keys are permission names, values are action + optional path patterns. Example: { edit: ['allow'], bash: ['deny'], glob: ['allow', 'src/auth/**'] }. Overrides are capped by parent permissions via intersection.",
    )
    .optional(),

  max_steps: z.number().int().min(1).max(50).describe("Maximum loop iterations for this sub-agent session.").optional(),

  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(600)
    .describe("Maximum execution time in seconds. On timeout, partial results are saved.")
    .default(300),

  file_scope: z
    .string()
    .array()
    .describe("Glob patterns restricting file-affecting tools. Compiled into Permission Rules via compileDiscipline().")
    .optional(),

  env_scope: EnvScope.describe(
    "Environment isolation for the sub-agent session. Process-level and permission-level constraints.",
  ).optional(),

  return_format: z
    .enum(["text", "structured", "raw"])
    .describe("text: final assistant text. structured: enforce JSON/Markdown output. raw: full conversation trace.")
    .default("text"),
})
export type Discipline = z.infer<typeof Discipline>

const VALID_ACTIONS = new Set(["allow", "deny", "ask"])
const FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]

export function compileDiscipline(discipline: Discipline): Permission.Ruleset {
  const ruleset: Permission.Ruleset = []

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

  if (discipline.file_scope?.length) {
    for (const tool of FILE_TOOLS) {
      ruleset.push({ permission: tool, pattern: "*", action: "deny" })
      for (const scopePattern of discipline.file_scope) {
        ruleset.push({ permission: tool, pattern: scopePattern, action: "allow" })
      }
    }
  }

  if (discipline.env_scope?.allowed_commands?.length) {
    ruleset.push({ permission: "bash", pattern: "*", action: "deny" })
    for (const cmd of discipline.env_scope.allowed_commands) {
      ruleset.push({ permission: "bash", pattern: `${cmd}*`, action: "allow" })
    }
  }

  return ruleset
}

export function fromOverride(override: Record<string, string[]>): Permission.Ruleset {
  return compileDiscipline({
    mode: "serial",
    delegation_depth: 0,
    timeout_seconds: 300,
    permission_override: override,
    return_format: "text",
  })
}
