import { afterEach, describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"

afterEach(async () => {})

describe("Permission.intersection — subagent permission safety", () => {
  test("parent deny blocks child allow (security fix)", () => {
    const parent = Permission.fromConfig({ bash: "deny" })
    const child = Permission.fromConfig({ bash: "allow" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
  })

  test("child deny is preserved even when parent allows", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: { "secret*": "deny" } })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "secret/file", result).action).toBe("deny")
    expect(Permission.evaluate("bash", "public/file", result).action).toBe("ask")
    const runtime = Permission.merge(parent, result)
    expect(Permission.evaluate("bash", "public/file", runtime).action).toBe("allow")
  })

  test("general→explore intersection preserves explore restrictions", () => {
    const general = Permission.fromConfig({
      "*": "allow",
      todowrite: "deny",
    })
    const explore = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      read: "allow",
    })
    const result = Permission.intersection(general, explore)
    expect(Permission.evaluate("edit", "*", result).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", result).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", result).action).toBe("allow")
    expect(Permission.evaluate("read", "*", result).action).toBe("allow")
  })

  test("intersection with discipline override: env_scope whitelist", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: "allow" })
    const override = Discipline.compile({
      env_scope: { allowed_commands: ["docker", "alpha"] },
    })
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("bash", "docker run nginx", result).action).toBe("allow")
    expect(Permission.evaluate("bash", "alpha test", result).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", result).action).toBe("deny")
  })

  test("intersection with discipline override: delegation_depth=0 blocks task", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    const child = Permission.fromConfig({ "*": "allow" })
    const override = Discipline.compile({ delegation_depth: 0 })
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("task", "*", result).action).toBe("deny")
  })

  test("intersection without override preserves v0.6.0 behavior", () => {
    const parent = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const child = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const result = Permission.intersection(parent, child, [])
    expect(Permission.evaluate("bash", "*", result).action).toBe("allow")
    expect(Permission.evaluate("todowrite", "*", result).action).toBe("deny")
  })

  test("parent deny propagates to uncovered permissions", () => {
    const parent = Permission.fromConfig({ "*": "allow", task: "deny" })
    const child = Permission.fromConfig({ bash: "allow" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("task", "*", result).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", result).action).toBe("allow")
  })
})
