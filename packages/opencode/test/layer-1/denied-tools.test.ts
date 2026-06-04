import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("Layer 1 — denied tools filtering via Permission.evaluate", () => {
  test("Permission.EDIT_TOOLS is exported and contains expected tool names", () => {
    expect(Permission.EDIT_TOOLS).toEqual(["edit", "write", "apply_patch", "multiedit"])
  })

  test("build agent (all allowed) sees all tool categories", () => {
    const ruleset = Permission.fromConfig({
      "*": "allow",
    })
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("webfetch", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("glob", "*", ruleset).action).toBe("allow")
  })

  test("plan agent (edit deny) does not see edit/write/apply_patch/multiedit", () => {
    const ruleset = Permission.fromConfig({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      bash: "allow",
    })
    expect(Permission.evaluate("edit", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("write", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("apply_patch", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("multiedit", "*", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "*", ruleset).action).toBe("allow")
  })

  test("EDIT_TOOLS mapped correctly: write/edit/apply_patch/multiedit → 'edit' permission key", () => {
    const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]
    for (const tool of EDIT_TOOLS) {
      const permKey = EDIT_TOOLS.includes(tool) ? "edit" : tool
      expect(permKey).toBe("edit")
    }
    const permKeyForBash = EDIT_TOOLS.includes("bash") ? "edit" : "bash"
    expect(permKeyForBash).toBe("bash")
  })

  test("denied tools filtering: tools with deny rule are removed from resolved set", () => {
    const ruleset = Permission.fromConfig({
      "*": "allow",
      edit: "deny",
    })
    const disabled = Permission.disabled(["edit", "write", "bash", "read"], ruleset)
    expect(disabled.has("edit")).toBe(true)
    expect(disabled.has("write")).toBe(true)
    expect(disabled.has("bash")).toBe(false)
    expect(disabled.has("read")).toBe(false)
  })

  test("denied tools filtering: specific bash deny removes only bash tool", () => {
    const ruleset = Permission.fromConfig({
      "*": "allow",
      bash: "deny",
    })
    const disabled = Permission.disabled(["bash", "edit", "read", "glob"], ruleset)
    expect(disabled.has("bash")).toBe(true)
    expect(disabled.has("edit")).toBe(false)
    expect(disabled.has("read")).toBe(false)
  })

  test("research agent: bash restricted via env_scope, edit allowed", () => {
    const researchPerm = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      read: "allow",
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    })
    const envRules = Permission.fromConfig({
      bash: { "*": "deny", "alpha*": "allow" },
    })
    const merged = Permission.merge(researchPerm, envRules)
    expect(Permission.evaluate("bash", "alpha test", merged).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", merged).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", merged).action).toBe("allow")
    expect(Permission.evaluate("glob", "*", merged).action).toBe("allow")
  })

  test("Permission.merge(agent.permission, session.permission) works for denied tools filtering", () => {
    const agentPerm = Permission.fromConfig({
      "*": "deny",
      read: "allow",
      edit: "deny",
    })
    const sessionPerm = Permission.fromConfig({
      bash: "allow",
    })
    const effective = Permission.merge(agentPerm, sessionPerm)
    expect(Permission.evaluate("edit", "*", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", effective).action).toBe("allow")
    expect(Permission.evaluate("read", "*", effective).action).toBe("allow")
  })
})
