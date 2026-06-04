import { Permission } from "@/permission"
import z from "zod"

export namespace Discipline {
  export const Schema = z.object({
    permission_override: z.record(z.string(), z.string().array().optional()).optional(),
    env_scope: z
      .object({
        allowed_commands: z.string().array().optional(),
      })
      .optional(),
    file_scope: z.string().array().optional(),
    delegation_depth: z.number().int().min(0).max(3).optional(),
    max_steps: z.number().int().min(1).max(50).optional(),
    timeout_seconds: z.number().int().min(30).max(600).optional(),
    return_format: z.enum(["text", "structured", "raw"]).optional(),
  })

  export function compile(d: z.infer<typeof Schema>): Permission.Ruleset {
    const rules: Permission.Ruleset = []

    if (d.permission_override) {
      for (const [perm, actions] of Object.entries(d.permission_override)) {
        if (!actions) continue
        for (const action of actions) {
          if (action === "allow" || action === "deny" || action === "ask") {
            rules.push({ permission: perm, pattern: "*", action })
          } else {
            rules.push({ permission: perm, pattern: action, action: "allow" })
          }
        }
      }
    }

    if (d.env_scope?.allowed_commands) {
      rules.push({ permission: "bash", pattern: "*", action: "deny" })
      for (const cmd of d.env_scope.allowed_commands) {
        rules.push({ permission: "bash", pattern: cmd + "*", action: "allow" })
      }
    }

    if (d.file_scope) {
      const WRITE_TOOLS = ["edit", "write", "apply_patch", "multiedit"]
      for (const tool of WRITE_TOOLS) {
        rules.push({ permission: tool, pattern: "*", action: "deny" })
      }
      for (const scopePattern of d.file_scope) {
        for (const tool of WRITE_TOOLS) {
          rules.push({ permission: tool, pattern: scopePattern, action: "allow" })
        }
      }
      for (const scopePattern of d.file_scope) {
        if (scopePattern.endsWith("/**")) {
          const base = scopePattern.slice(0, -3)
          const nestedPattern = `${base}/${base}/**`
          for (const tool of WRITE_TOOLS) {
            rules.push({ permission: tool, pattern: nestedPattern, action: "deny" })
          }
        }
      }
    }

    if (d.delegation_depth === 0) {
      rules.push({ permission: "task", pattern: "*", action: "deny" })
    }

    return rules
  }
}
