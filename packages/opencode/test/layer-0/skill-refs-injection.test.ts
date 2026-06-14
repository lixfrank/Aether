import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

afterEach(async () => {
  await Instance.disposeAll()
})

describe.skipIf(skip)("skill_refs injection — research agent skill whitelist", () => {
  test("agent with skillRefs gets only injected content (replaces broadcast)", async () => {
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
        const skillDir2 = path.join(dir, ".aether", "skills", "deep-research")
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: deep-research
description: Comprehensive research assistant.
---

# Deep Research
Conduct comprehensive research with citations.
`,
        )
      },
      config: {
        agent: {
          general: {
            skill_refs: ["arxiv-search", "deep-research"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const output = await SystemPrompt.skills(general!)

        expect(output).toContain("Skills (mandatory)")
        expect(output).toContain("Skill: arxiv-search")
        expect(output).toContain("Skill: deep-research")
        expect(output).toContain("# ArXiv Search")
        expect(output).toContain("# Deep Research")

        expect(output).not.toContain("<available_skills>")
      },
    })
  })

  test("agent without skillRefs gets only broadcast (v0.6.0 unchanged)", async () => {
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
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const output = await SystemPrompt.skills(build!)
        expect(output).toContain("<available_skills>")
        expect(output).toContain("arxiv-search")
        expect(output).not.toContain("Skills (mandatory)")
      },
    })
  })

  test("skillRefs referencing nonexistent skill shows warning", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          general: {
            skill_refs: ["nonexistent-skill"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const output = await SystemPrompt.skills(general!)
        expect(output).toContain("referenced but not found")
        expect(output).toContain("nonexistent-skill")
      },
    })
  })
})
