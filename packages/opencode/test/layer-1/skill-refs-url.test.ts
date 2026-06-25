import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import type { Tool } from "../../src/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe.skipIf(skip)("skill tool — base directory URL (lazy loading)", () => {
  test("skill directory URL is constructed from path.dirname(location) via pathToFileURL", () => {
    const location = "/tmp/test-project/.aether/skills/test-skill/SKILL.md"
    const dir = path.dirname(location)
    const url = pathToFileURL(dir).href
    expect(url.startsWith("file://")).toBe(true)
    expect(url).toContain("/test-project/.aether/skills/test-skill")
  })

  test("pathToFileURL handles paths with spaces", () => {
    const location = "/tmp/my project/.aether/skills/test-skill/SKILL.md"
    const dir = path.dirname(location)
    const url = pathToFileURL(dir).href
    expect(url).toContain("file://")
    expect(url).toContain("/my%20project/.aether/skills/test-skill")
  })

  test("skill tool execute returns base directory URL + content (lazy, not eager injection)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skills", "demo-skill")
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
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ name: "demo-skill" }, ctx)
          const dir = path.join(tmp.path, ".opencode", "skills", "demo-skill")

          expect(result.output).toContain(`<skill_content name="demo-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
          expect(result.output).toContain("Relative paths in this skill")
          expect(result.output).toContain("# Demo Skill")
          expect(result.output).toContain("Content of the demo skill")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("skill tool execute on missing skill throws with available list", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skills", "real-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: real-skill
description: A real skill.
---

# Real Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          await expect(tool.execute({ name: "missing-skill" }, ctx)).rejects.toThrow("not found")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
