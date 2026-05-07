import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("evaluateWithCommand", () => {
  test("bash tool matches command prefix against patterns (deny-before-allow)", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "docker*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/usr/bin/docker", "docker build --tag foo .", ruleset)
    expect(result.action).toBe("allow")
  })

  test("bash tool matches exact command without args", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "git*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/usr/bin/git", "git status", ruleset)
    expect(result.action).toBe("allow")
  })

  test("bash tool denies command not matching allowed prefix", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "docker*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/usr/bin/rm", "rm -rf /", ruleset)
    expect(result.action).toBe("deny")
  })

  test("non-bash tool ignores command and matches path", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "src/**", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("edit", "src/main.ts", "some command string", ruleset)
    expect(result.action).toBe("allow")
  })

  test("non-bash tool falls through to path matching without command", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "read", pattern: "*", action: "deny" },
      { permission: "read", pattern: "docs/**", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("read", "docs/api.md", undefined, ruleset)
    expect(result.action).toBe("allow")
  })

  test("bash tool with undefined command falls through to path matching", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "/usr/bin/*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/usr/bin/ls", undefined, ruleset)
    expect(result.action).toBe("allow")
  })

  test("bash tool extracts first token as command prefix", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "npm*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/path", "npm run build --watch", ruleset)
    expect(result.action).toBe("allow")
  })

  test("bash tool with multiple rulesets", () => {
    const base: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const compiled: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "git*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/usr/bin/git", "git push", base, compiled)
    expect(result.action).toBe("allow")
  })

  test("bash tool with leading whitespace trimmed", () => {
    const ruleset: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "ls*", action: "allow" },
    ]
    const result = Permission.evaluateWithCommand("bash", "/bin/ls", "  ls -la", ruleset)
    expect(result.action).toBe("allow")
  })

  test("bash tool without command string defaults to ask when no rules match path", () => {
    const ruleset: Permission.Ruleset = []
    const result = Permission.evaluateWithCommand("bash", "/usr/bin/ls", undefined, ruleset)
    expect(result.action).toBe("ask")
  })

  test("bash tool with command string defaults to ask when no rules match", () => {
    const ruleset: Permission.Ruleset = []
    const result = Permission.evaluateWithCommand("bash", "/path", "some-cmd arg1", ruleset)
    expect(result.action).toBe("ask")
  })
})
