import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("Permission.intersection — uncovered edge cases", () => {
  test("parent deny overrides child ask", () => {
    const parent = Permission.fromConfig({ bash: "deny" })
    const child = Permission.fromConfig({ bash: "ask" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
  })

  test("parent allow + child ask → ask preserved", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: "ask" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("ask")
  })

  test("parent ask + child allow → parent ask wins (downgrade)", () => {
    const parent = Permission.fromConfig({ bash: "ask" })
    const child = Permission.fromConfig({ bash: "allow" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("ask")
  })

  test("parent ask + child deny → child deny wins", () => {
    const parent = Permission.fromConfig({ bash: "ask" })
    const child = Permission.fromConfig({ bash: "deny" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
  })

  test("parent ask + child ask → ask", () => {
    const parent = Permission.fromConfig({ bash: "ask" })
    const child = Permission.fromConfig({ bash: "ask" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("ask")
  })

  test("intersection with wildcard patterns: specific child pattern under parent wildcard deny", () => {
    const parent = Permission.fromConfig({ bash: "deny" })
    const child = Permission.fromConfig({ bash: { "git*": "allow" } })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "git*", result).action).toBe("deny")
  })

  test("intersection with wildcard patterns: specific child deny under parent wildcard allow", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: { "rm*": "deny" } })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "rm*", result).action).toBe("deny")
  })
})
