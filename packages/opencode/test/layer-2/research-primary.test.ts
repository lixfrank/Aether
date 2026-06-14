import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { evalPerm, makeResearchConfig } from "./fixture"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("Layer 2 — research primary agent", () => {
  test("T2.1: research agent appears in Agent.list() when defined", async () => {
    await using tmp = await tmpdir({ config: { agent: { research: makeResearchConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Instance.provide({ directory: tmp.path, fn: async () => Agent.list() })
        expect(agents.map((a) => a.name)).toContain("research")
      },
    })
  })

  test("T2.2: research agent permission structure — deny default + specific allows", async () => {
    await using tmp = await tmpdir({ config: { agent: { research: makeResearchConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const r = await Instance.provide({ directory: tmp.path, fn: async () => Agent.get("research") })
        expect(r?.mode).toBe("primary")
        expect(evalPerm(r!, "grep")).toBe("allow")
        expect(evalPerm(r!, "read")).toBe("allow")
        expect(evalPerm(r!, "edit")).toBe("allow")
        expect(evalPerm(r!, "write")).toBe("allow")
        expect(evalPerm(r!, "webfetch")).toBe("allow")
        expect(evalPerm(r!, "websearch")).toBe("allow")
        expect(evalPerm(r!, "task")).toBe("allow")
        expect(evalPerm(r!, "skill")).toBe("allow")
        expect(evalPerm(r!, "external_directory")).toBe("ask")
        expect(evalPerm(r!, "knowledge_search")).toBe("allow")
        expect(evalPerm(r!, "todowrite")).toBe("allow")
      },
    })
  })

  test("T2.4: env_scope compiles to deny-before-allow bash rules", async () => {
    await using tmp = await tmpdir({ config: { agent: { research: makeResearchConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const r = await Agent.get("research")
        expect(
          Permission.evaluate("bash", "uv run .aether/skills/paper-search/arxiv_search.py search", r!.permission)
            .action,
        ).toBe("allow")
        expect(Permission.evaluate("bash", "curl https://example.com", r!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "curl https://example.com", r!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "rg pattern", r!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "grep -r term", r!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git status", r!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "rm -rf /", r!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "npm install", r!.permission).action).toBe("deny")
      },
    })
  })

  test("T2.13b: research_conventions_* wildcard matches MCP tool IDs", async () => {
    await using tmp = await tmpdir({ config: { agent: { research: makeResearchConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const r = await Agent.get("research")
        expect(Permission.evaluate("research_conventions_convention_lock_status", "*", r!.permission).action).toBe(
          "allow",
        )
        expect(Permission.evaluate("research_state_get_state", "*", r!.permission).action).toBe("allow")
      },
    })
  })

  test("T2.15: agent prompt from config is populated (markdown body)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: { ...makeResearchConfig(), prompt: "# Research Mode\n\nScale Decision: 10 words threshold." },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const r = await Agent.get("research")
        expect(r?.prompt).toContain("Research Mode")
        expect(r?.prompt).toContain("Scale Decision")
      },
    })
  })

  test("T2.15: no scale_decision field in Agent.Info (prompt-only)", async () => {
    await using tmp = await tmpdir({ config: { agent: { research: makeResearchConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const r = await Agent.get("research")
        expect((r as any)["scale_decision"]).toBeUndefined()
      },
    })
  })

  test("T2.24: bash controlled by env_scope, not manually declared", () => {
    const cfg = makeResearchConfig()
    expect(cfg.permission!["bash"]).toBe("allow")
    expect(cfg.env_scope?.allowed_commands).toBeDefined()
    expect(cfg.env_scope!.allowed_commands!.length).toBeGreaterThan(0)
  })

  test("research agent has no skill_refs (primary agent free access)", async () => {
    await using tmp = await tmpdir({ config: { agent: { research: makeResearchConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const r = await Agent.get("research")
        expect(r?.skillRefs ?? []).toEqual([])
      },
    })
  })
})
