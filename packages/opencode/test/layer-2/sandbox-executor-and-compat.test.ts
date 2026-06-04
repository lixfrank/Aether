import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { evalPerm, makeSandboxExecutorConfig } from "./fixture"

describe("Layer 2.1 — sandbox-executor subagent", () => {
  test("T2.1.5: sandbox-executor subagent definition loads correctly", async () => {
    await using tmp = await tmpdir({ config: { agent: { "sandbox-executor": makeSandboxExecutorConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const s = await Agent.get("sandbox-executor")
        expect(s?.mode).toBe("subagent")
        expect(s?.description).toContain("sandbox")
      },
    })
  })

  test("T2.1.6: sandbox-executor skill_refs = docker + research-verification", async () => {
    await using tmp = await tmpdir({ config: { agent: { "sandbox-executor": makeSandboxExecutorConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const s = await Agent.get("sandbox-executor")
        expect(s?.skillRefs).toEqual(["docker", "research-verification"])
      },
    })
  })

  test("T2.1.7: sandbox-executor env_scope restricts bash to docker/uv/python/pip/curl/git", async () => {
    await using tmp = await tmpdir({ config: { agent: { "sandbox-executor": makeSandboxExecutorConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const s = await Agent.get("sandbox-executor")
        expect(Permission.evaluate("bash", "docker run nginx", s!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "uv run script.py", s!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "python train.py", s!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "pip install numpy", s!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "rm -rf /", s!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "npm install", s!.permission).action).toBe("deny")
      },
    })
  })

  test("T2.1.8: sandbox-executor MCP = research-conventions (read-only) + research-state", async () => {
    await using tmp = await tmpdir({ config: { agent: { "sandbox-executor": makeSandboxExecutorConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const s = await Agent.get("sandbox-executor")
        expect(s?.mcp).toEqual({ "research-conventions": true, "research-state": true })
        expect(Permission.evaluate("research_conventions_convention_lock_status", "*", s!.permission).action).toBe(
          "allow",
        )
        expect(Permission.evaluate("research_state_get_state", "*", s!.permission).action).toBe("allow")
      },
    })
  })
})

describe("Layer 2 — backward compatibility", () => {
  test("T2.16/T2.17: native agents unchanged when research not defined", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const plan = await Agent.get("plan")
        const general = await Agent.get("general")
        const explore = await Agent.get("explore")
        expect(evalPerm(build!, "edit")).toBe("allow")
        expect(evalPerm(build!, "bash")).toBe("allow")
        expect(evalPerm(plan!, "edit", ".aether/plans/foo.md")).toBe("allow")
        expect(evalPerm(plan!, "edit")).toBe("deny")
        expect(evalPerm(general!, "todowrite")).toBe("deny")
        expect(evalPerm(explore!, "edit")).toBe("deny")
        const agents = await Agent.list()
        expect(agents.map((a) => a.name)).not.toContain("research")
      },
    })
  })

  test("T2.18: non-physics users can use research-verifier without gpd-* skills", () => {
    const vSkills = ["research-verification"]
    expect(vSkills).not.toContain("gpd-verification")
    expect(vSkills).not.toContain("gpd-errors")
  })
})
