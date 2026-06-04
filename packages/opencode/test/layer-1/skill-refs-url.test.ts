import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("skill_refs injection — skill directory URL (pathToFileURL)", () => {
  test("skill directory URL contains file:// scheme and skill directory path", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: A test skill.
---

# Test Skill
This is a test skill.
`,
        )
      },
      config: {
        agent: {
          general: {
            skill_refs: ["test-skill"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const output = await SystemPrompt.skills(general!)
        expect(output).toContain("file://")
        expect(output).toContain("Skill directory:")
        expect(output).toContain("Relative paths in this skill")
      },
    })
  })

  test("skill directory URL is constructed from path.dirname(location) via pathToFileURL", () => {
    const location = "/tmp/test-project/.opencode/skill/test-skill/SKILL.md"
    const dir = path.dirname(location)
    const url = pathToFileURL(dir).href
    expect(url.startsWith("file://")).toBe(true)
    expect(url).toContain("/test-project/.opencode/skill/test-skill")
  })

  test("pathToFileURL handles paths with spaces", () => {
    const location = "/tmp/my project/.opencode/skill/test-skill/SKILL.md"
    const dir = path.dirname(location)
    const url = pathToFileURL(dir).href
    expect(url).toContain("file://")
    expect(url).toContain("/my%20project/.opencode/skill/test-skill")
  })

  test("skill_refs with found skill: output contains Skill directory + content", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "demo-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: demo-skill
description: Demo skill for testing.
---

# Demo Skill
Content of the demo skill.
`,
        )
      },
      config: {
        agent: {
          general: {
            skill_refs: ["demo-skill"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const output = await SystemPrompt.skills(general!)
        expect(output).toContain("Skill: demo-skill")
        expect(output).toContain("Skill directory:")
        expect(output).toContain("# Demo Skill")
        expect(output).toContain("Content of the demo skill")
        expect(output).not.toContain("<available_skills>")
      },
    })
  })

  test("skill_refs with partial missing: found skills injected, missing listed in warning", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "found-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: found-skill
description: A found skill.
---

# Found Skill
`,
        )
      },
      config: {
        agent: {
          general: {
            skill_refs: ["found-skill", "missing-skill"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const output = await SystemPrompt.skills(general!)
        expect(output).toContain("Skill: found-skill")
        expect(output).toContain("missing-skill referenced but not found")
        expect(output).not.toContain("<available_skills>")
      },
    })
  })
})
