import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"
import { Permission } from "../../src/permission"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

afterEach(async () => {
  await Instance.disposeAll()
})

describe.skipIf(skip)("SystemPrompt.skills — lazy skill loading (no eager injection)", () => {
  test("agent with skill permission gets lazy available-skills list, not full content", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".aether", "skills", "arxiv-search")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: arxiv-search
description: Search arXiv papers.
---

# ArXiv Search
Search arXiv for preprints and academic papers.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const output = await SystemPrompt.skills(build!)

        expect(output).toContain("Use the skill tool to load a skill")
        expect(output).toContain("arxiv-search")
        expect(output).toContain("<available_skills>")

        // lazy branch: skill full content is NOT injected into system prompt
        expect(output).not.toContain("# ArXiv Search")
        expect(output).not.toContain("Skills (mandatory)")
        expect(output).not.toContain("do NOT use the skill tool")
      },
    })
  })

  test("agent with skill denied returns undefined (no skill list)", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          "no-skill-agent": {
            mode: "subagent",
            permission: { "*": "deny", read: "allow" },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("no-skill-agent")
        const output = await SystemPrompt.skills(agent!)
        expect(output).toBeUndefined()
      },
    })
  })

  test("*: deny + skill: allow yields skill list via SystemPrompt.skills (gpd-verifier path)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".aether", "skills", "gpd-verification")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: gpd-verification
description: Physics verification with SymPy.
---

# GPD Verification
Deterministic SymPy checks.
`,
        )
      },
      config: {
        agent: {
          "deny-with-skill-allow": {
            mode: "subagent",
            permission: { "*": "deny", read: "allow", skill: "allow" },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("deny-with-skill-allow")
        expect(Permission.disabled(["skill"], agent!.permission).has("skill")).toBe(false)
        expect(Permission.evaluate("skill", "*", agent!.permission).action).toBe("allow")
        const output = await SystemPrompt.skills(agent!)
        expect(output).toBeDefined()
        expect(output).toContain("<available_skills>")
        expect(output).toContain("gpd-verification")
        expect(output).not.toContain("# GPD Verification")
      },
    })
  })
})
