import { afterEach, describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

afterEach(async () => {
  await Instance.disposeAll()
})

describe.skipIf(skip)("Layer 1.4 — declarative permission", () => {
  test("edit: {*:deny, path:allow} keeps edit visible and restricts writes to path", () => {
    const rules = Permission.fromConfig({
      edit: { "*": "deny", ".aether/research/**": "allow" },
    })
    // Assembly-time: edit (and the other write tools, all mapped to "edit") stay visible
    // because the last matching rule has pattern !== "*".
    const hidden = Permission.disabled(["edit", "write", "apply_patch", "multiedit"], rules)
    expect(hidden.has("edit")).toBe(false)
    expect(hidden.has("write")).toBe(false)
    // Execution-time: writes inside the scope allowed, outside denied.
    expect(Permission.evaluate("edit", ".aether/research/foo.md", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "/etc/passwd", rules).action).toBe("deny")
  })

  test("TaskTool parameters no longer expose discipline fields", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await TaskTool.init()
        const keys = Object.keys((info.parameters as { shape: Record<string, unknown> }).shape)
        for (const removed of [
          "mode",
          "permission_override",
          "file_scope",
          "delegation_depth",
          "max_steps",
          "timeout_seconds",
        ]) {
          expect(keys).not.toContain(removed)
        }
        expect(keys).toContain("subagent_type")
        expect(keys).toContain("prompt")
      },
    })
  })

  test("file_scope in config no longer compiles into permission rules", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: { file_scope: ["src/**"] },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        // file_scope is no longer compiled: edit is NOT restricted to src/**.
        // general inherits the default edit:allow, so both paths are allowed.
        expect(Permission.evaluate("edit", "src/main.ts", general!.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "/etc/x", general!.permission).action).toBe("allow")
        // The now-unknown key is harmlessly routed into options (no consumer).
        expect(general!.options["file_scope"]).toEqual(["src/**"])
      },
    })
  })

  test("research env_scope denied_commands migrated to permission.bash semantics", () => {
    // Mirrors the bash block now declared in .aether/agent/research.md frontmatter.
    const rules = Permission.fromConfig({
      bash: {
        "*": "allow",
        "git push --force*": "deny",
        "git push -f*": "deny",
        "git reset --hard*": "deny",
        "git rebase -i*": "deny",
        "git clean -fd": "deny",
        "git checkout * -- .": "deny",
      },
    })
    // Destructive git commands are denied (findLast lets deny win over the leading *:allow).
    expect(Permission.evaluate("bash", "git push --force origin", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git reset --hard HEAD~1", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git clean -fd", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git rebase -i main", rules).action).toBe("deny")
    // Non-destructive commands still allowed.
    expect(Permission.evaluate("bash", "ls", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", rules).action).toBe("allow")
  })
})
