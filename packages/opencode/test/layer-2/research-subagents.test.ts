import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import {
  evalPerm,
  makeResearchExplorerConfig,
  makeResearchVerifierConfig,
  makeGpdVerifierConfig,
  makeGpdReviewerConfig,
} from "./fixture"

describe("Layer 2 — research-explorer subagent", () => {
  test("T2.6/T2.7: research-explorer subagent with Integrity Commandments prompt", async () => {
    await using tmp = await tmpdir({ config: { agent: { "research-explorer": makeResearchExplorerConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const e = await Agent.get("research-explorer")
        expect(e?.mode).toBe("subagent")
        expect(e?.skillRefs).toEqual(["alpha-research", "arxiv-search"])
        expect(evalPerm(e!, "grep")).toBe("allow")
        expect(evalPerm(e!, "list")).toBe("allow")
        expect(evalPerm(e!, "websearch")).toBe("allow")
        expect(evalPerm(e!, "codesearch")).toBe("allow")
        expect(evalPerm(e!, "external_directory")).toBe("ask")
      },
    })
  })

  test("research-explorer intersection with parent", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const explorerPerm = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      read: "allow",
      webfetch: "allow",
    })
    const session = Permission.intersection(parentPerm, explorerPerm)
    expect(Permission.evaluate("grep", "*", session).action).toBe("allow")
    expect(Permission.evaluate("edit", "*", session).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", session).action).toBe("deny")
  })
})

describe("Layer 2 — research-verifier subagent", () => {
  test("T2.8/T2.10: research-verifier with MCP wildcard + only research-verification skill", async () => {
    await using tmp = await tmpdir({ config: { agent: { "research-verifier": makeResearchVerifierConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const v = await Agent.get("research-verifier")
        expect(v?.mode).toBe("subagent")
        expect(v?.skillRefs).toEqual(["research-verification"])
        expect(Permission.evaluate("research_conventions_convention_lock_status", "*", v!.permission).action).toBe(
          "allow",
        )
        expect(Permission.evaluate("research_state_get_state", "*", v!.permission).action).toBe("allow")
        expect(evalPerm(v!, "webfetch")).toBe("allow")
        expect(evalPerm(v!, "codesearch")).toBe("allow")
        expect(evalPerm(v!, "external_directory")).toBe("ask")
        expect(v?.mcp).toEqual({ "research-conventions": true, "research-state": true })
      },
    })
  })
})

describe("Layer 2 — gpd-verifier subagent", () => {
  test("T2.9/T2.11: gpd-verifier inherits research-verifier + 4 gpd skills", async () => {
    await using tmp = await tmpdir({ config: { agent: { "gpd-verifier": makeGpdVerifierConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const g = await Agent.get("gpd-verifier")
        expect(g?.skillRefs).toEqual([
          "research-verification",
          "gpd-verification",
          "gpd-errors",
          "gpd-domain-check",
          "gpd-conventions",
        ])
        expect(Permission.evaluate("research_conventions_convention_lock_status", "*", g!.permission).action).toBe(
          "allow",
        )
        expect(g?.mcp).toEqual({ "research-conventions": true, "research-state": true })
      },
    })
  })
})

describe("Layer 2 — gpd-reviewer subagent", () => {
  test("T2.14: gpd-reviewer with gpd skill_refs", async () => {
    await using tmp = await tmpdir({ config: { agent: { "gpd-reviewer": makeGpdReviewerConfig() } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rev = await Agent.get("gpd-reviewer")
        expect(rev?.mode).toBe("subagent")
        expect(rev?.skillRefs).toEqual(["gpd-errors", "gpd-conventions", "gpd-domain-check"])
        expect(evalPerm(rev!, "bash")).toBe("allow")
        expect(evalPerm(rev!, "webfetch")).toBe("allow")
        expect(rev?.mcp).toEqual({ "research-conventions": true, "research-state": true })
      },
    })
  })
})
