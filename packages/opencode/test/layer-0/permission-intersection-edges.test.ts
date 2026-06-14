import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"

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

  test("intersection with Discipline env_scope: parent allow + child allow + override restricts", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: "allow" })
    const override = Discipline.compile({
      env_scope: { allowed_commands: ["python3"] },
    })
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("bash", "python3 script.py", result).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", result).action).toBe("deny")
  })

  test("intersection with Discipline file_scope: parent allow + child allow + override restricts write", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    const child = Permission.fromConfig({ "*": "allow" })
    const override = Discipline.compile({
      file_scope: ["docs/**"],
    })
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("edit", "docs/README.md", result).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/main.ts", result).action).toBe("deny")
    expect(Permission.evaluate("read", "src/main.ts", result).action).toBe("allow")
  })

  test("intersection with Discipline combined: env_scope + file_scope + delegation_depth=0", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    const child = Permission.fromConfig({ "*": "allow" })
    const override = Discipline.compile({
      env_scope: { allowed_commands: ["docker"] },
      file_scope: ["output/**"],
      delegation_depth: 0,
    })
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("bash", "docker run", result).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", result).action).toBe("deny")
    expect(Permission.evaluate("edit", "output/report.md", result).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/main.ts", result).action).toBe("deny")
    expect(Permission.evaluate("task", "*", result).action).toBe("deny")
  })
})
