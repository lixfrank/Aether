import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"

describe("Subagent session permission flow — Layer 2 research agent scenario", () => {
  test("research-explorer subagent: env_scope + file_scope + delegation_depth=0", () => {
    const parentPerm = Permission.fromConfig({
      "*": "allow",
      todowrite: "deny",
    })

    const explorerPerm = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      read: "allow",
      webfetch: "allow",
    })

    const disciplineRules = Discipline.compile({
      env_scope: { allowed_commands: ["docker", "python3"] },
      file_scope: ["src/**", "docs/**"],
      delegation_depth: 0,
    })

    const sessionPerm = Permission.intersection(parentPerm, explorerPerm, disciplineRules)

    expect(Permission.evaluate("bash", "docker run", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("bash", "python3 script.py", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", sessionPerm).action).toBe("deny")

    expect(Permission.evaluate("read", "src/main.ts", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("read", "docs/README.md", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("read", "secrets/.env", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/main.ts", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("edit", "docs/README.md", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("write", "secrets/.env", sessionPerm).action).toBe("deny")

    expect(Permission.evaluate("grep", "src/**", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("grep", "docs/**", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("grep", "secrets/**", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("glob", "secrets/**", sessionPerm).action).toBe("allow")

    expect(Permission.evaluate("task", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("webfetch", "*", sessionPerm).action).toBe("allow")
  })

  test("research-verifier subagent: delegation_depth=0 + permission_override", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const verifierPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const disciplineRules = Discipline.compile({
      delegation_depth: 0,
      permission_override: { bash: ["deny"] },
    })

    const sessionPerm = Permission.intersection(parentPerm, verifierPerm, disciplineRules)
    expect(Permission.evaluate("task", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("read", "*", sessionPerm).action).toBe("allow")
  })

  test("primary_tools deny appended after intersection", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const childPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const sessionPerm = Permission.intersection(parentPerm, childPerm, [])
    const primaryToolsDeny = [{ permission: "bash", pattern: "*", action: "deny" as const }]
    const finalPerm = [...sessionPerm, ...primaryToolsDeny]

    const disabled = Permission.disabled(["bash", "read", "edit"], finalPerm)
    expect(disabled.has("bash")).toBe(true)
    expect(disabled.has("read")).toBe(false)
    expect(disabled.has("edit")).toBe(false)
  })

  test("general subagent without explicit task rule gets session-level task deny", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const generalPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const sessionPerm = Permission.intersection(parentPerm, generalPerm, [])

    const hasTaskRule = sessionPerm.some((r) => r.permission === "task" && r.action === "deny")
    expect(hasTaskRule).toBe(false)

    const hasTaskPermission = generalPerm.some((r) => r.permission === "task")
    const hasTodoWritePermission = generalPerm.some((r) => r.permission === "todowrite")
    expect(hasTaskPermission).toBe(false)
    expect(hasTodoWritePermission).toBe(true)

    const sessionDenyRules = [
      ...(hasTodoWritePermission
        ? []
        : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
      ...(hasTaskPermission ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ]
    const finalPerm = [...sessionPerm, ...sessionDenyRules]

    expect(Permission.evaluate("task", "*", finalPerm).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", finalPerm).action).toBe("deny")

    const disabled = Permission.disabled(["task", "todowrite", "bash", "read"], finalPerm)
    expect(disabled.has("task")).toBe(true)
    expect(disabled.has("todowrite")).toBe(true)
    expect(disabled.has("bash")).toBe(false)
  })
})
