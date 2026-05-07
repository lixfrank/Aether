import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { compileDiscipline } from "../../src/session/discipline"

const FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]

describe("file_scope as compiled permission rules", () => {
  test("path inside compiled scope is allowed, path outside is denied", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/**"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)

    expect(Permission.evaluate("read", "src/foo.ts", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/main.ts", ruleset).action).toBe("allow")
    expect(Permission.evaluate("read", "lib/bar.ts", ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", "config/settings.json", ruleset).action).toBe("deny")
  })

  test("multiple scope patterns — inside any pattern is allowed", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/**", "package.json", "docs/**"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)

    expect(Permission.evaluate("read", "src/auth/login.ts", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "package.json", ruleset).action).toBe("allow")
    expect(Permission.evaluate("glob", "docs/api.md", ruleset).action).toBe("allow")
    expect(Permission.evaluate("read", "lib/external.ts", ruleset).action).toBe("deny")
  })

  test("compiled scope denies file tool for path outside all patterns via blanket deny", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/auth/**"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)

    expect(Permission.evaluate("edit", "src/main.ts", ruleset).action).toBe("deny")
  })

  test("non-file tool unaffected by compiled file_scope rules", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/**"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)

    const bashRules = ruleset.filter((r) => r.permission === "bash")
    expect(bashRules).toHaveLength(0)
  })

  test("compiled file_scope with existing permission_override allows override to coexist", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      permission_override: { bash: ["deny"] },
      file_scope: ["src/**"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)

    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/main.ts", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "outside.ts", ruleset).action).toBe("deny")
  })

  test("all FILE_TOOLS are subject to compiled scope", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/**"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)
    for (const tool of FILE_TOOLS) {
      const inside = Permission.evaluate(tool, "src/foo.ts", ruleset)
      expect(inside.action).toBe("allow")
      const outside = Permission.evaluate(tool, "lib/bar.ts", ruleset)
      expect(outside.action).toBe("deny")
    }
  })

  test("exact scope pattern match", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["package.json"],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)

    expect(Permission.evaluate("read", "package.json", ruleset).action).toBe("allow")
    expect(Permission.evaluate("read", "package-lock.json", ruleset).action).toBe("deny")
  })

  test("empty file_scope produces no scope rules", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: [],
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)
    expect(ruleset).toHaveLength(0)
  })

  test("undefined file_scope produces no scope rules", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      return_format: "text" as const,
    }
    const ruleset = compileDiscipline(discipline)
    expect(ruleset).toHaveLength(0)
  })
})
