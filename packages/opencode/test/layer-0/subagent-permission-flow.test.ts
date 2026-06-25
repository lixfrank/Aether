import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("Subagent session permission flow — Layer 2 research agent scenario", () => {
  test("primary_tools deny appended after intersection", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const childPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const sessionPerm = Permission.intersection(parentPerm, childPerm)
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
    const sessionPerm = Permission.intersection(parentPerm, generalPerm)

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
