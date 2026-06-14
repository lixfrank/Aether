import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("Discipline.compile — research agent constraint shortcuts", () => {
  test("env_scope compiles deny-before-allow for bash whitelist", () => {
    const rules = Discipline.compile({
      env_scope: { allowed_commands: ["docker", "git"] },
    })
    expect(Permission.evaluate("bash", "docker build .", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git commit -m fix", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", rules).action).toBe("deny")
  })

  test("file_scope compiles deny-before-allow for write tool restriction only (read tools unaffected)", () => {
    const rules = Discipline.compile({
      file_scope: ["src/**", "test/**"],
    })
    expect(Permission.evaluate("edit", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("write", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("apply_patch", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("multiedit", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "secrets/credentials.json", rules).action).toBe("deny")
    expect(Permission.evaluate("write", "secrets/credentials.json", rules).action).toBe("deny")
    expect(Permission.evaluate("read", "src/main.ts", rules).action).not.toBe("deny")
    expect(Permission.evaluate("read", "secrets/credentials.json", rules).action).not.toBe("deny")
    expect(Permission.evaluate("glob", "*", rules).action).not.toBe("deny")
    expect(Permission.evaluate("grep", "*", rules).action).not.toBe("deny")
  })

  test("delegation_depth=0 denies task, undefined produces no rule", () => {
    const withZero = Discipline.compile({ delegation_depth: 0 })
    expect(withZero.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)

    const without = Discipline.compile({})
    expect(without.some((r) => r.permission === "task")).toBe(false)
  })

  test("permission_override with mixed allow/pattern forms", () => {
    const rules = Discipline.compile({
      permission_override: {
        bash: ["allow", "docker*"],
        edit: ["deny"],
      },
    })
    expect(Permission.evaluate("bash", "*", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "docker*", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "*", rules).action).toBe("deny")
  })

  test("compile returns empty ruleset when no constraints set", () => {
    const rules = Discipline.compile({})
    expect(rules.length).toBe(0)
  })

  test("file_scope denies nested output_dir paths (e.g., .aether/research/.aether/research/**)", () => {
    const rules = Discipline.compile({
      file_scope: [".aether/research/**"],
    })
    expect(Permission.evaluate("write", ".aether/research/notepads/test.md", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", ".aether/research/persistence/ROADMAP.md", rules).action).toBe("allow")
    expect(Permission.evaluate("write", ".aether/research/.aether/research/notepads/test.md", rules).action).toBe(
      "deny",
    )
    expect(Permission.evaluate("edit", ".aether/research/.aether/research/persistence/ROADMAP.md", rules).action).toBe(
      "deny",
    )
    expect(Permission.evaluate("write", "secrets/credentials.json", rules).action).toBe("deny")
  })

  test("file_scope nested deny works for non-research scopes (e.g., src/src/**)", () => {
    const rules = Discipline.compile({
      file_scope: ["src/**"],
    })
    expect(Permission.evaluate("write", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("write", "src/src/main.ts", rules).action).toBe("deny")
  })
})
