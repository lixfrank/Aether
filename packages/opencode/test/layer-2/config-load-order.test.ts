import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { ModelID } from "../../src/provider/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Config load order — jsonc in .opencode/ overrides .md agent definitions", () => {
  test("opencode.json in .opencode/ dir overrides .md agent definition", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".opencode", "agent")
        await Bun.write(
          path.join(agentDir, "override-test.md"),
          `---
model: anthropic/claude-opus-4
steps: 10
---

Original .md prompt.
`,
        )
        await Bun.write(
          path.join(dir, ".opencode", "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              "override-test": {
                model: "anthropic/claude-sonnet-4-5",
                steps: 20,
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("override-test")
        expect(agent).toBeDefined()
        expect(agent?.model?.modelID).toBe(ModelID.make("claude-sonnet-4-5"))
        expect(agent?.steps).toBe(20)
      },
    })
  })

  test(".md agent definition alone works without jsonc override", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".opencode", "agent")
        await Bun.write(
          path.join(agentDir, "md-only.md"),
          `---
model: anthropic/claude-opus-4
steps: 5
---

Only .md definition.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("md-only")
        expect(agent).toBeDefined()
        expect(agent?.model?.modelID).toBe(ModelID.make("claude-opus-4"))
        expect(agent?.steps).toBe(5)
      },
    })
  })

  test("project root opencode.json (low priority) is overridden by .md agent", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".opencode", "agent")
        await Bun.write(
          path.join(agentDir, "priority-test.md"),
          `---
model: anthropic/claude-opus-4
steps: 5
---

.md agent overrides root jsonc.
`,
        )
      },
      config: {
        agent: {
          "priority-test": {
            model: "anthropic/claude-sonnet-4-5",
            steps: 50,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("priority-test")
        expect(agent).toBeDefined()
        expect(agent?.model?.modelID).toBe(ModelID.make("claude-opus-4"))
        expect(agent?.steps).toBe(5)
      },
    })
  })

  test("jsonc-only agent in project root works (no .md file)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          "jsonc-only-agent": {
            model: "openai/gpt-4o",
            steps: 15,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("jsonc-only-agent")
        expect(agent).toBeDefined()
        expect(agent?.model?.modelID).toBe(ModelID.make("gpt-4o"))
        expect(agent?.steps).toBe(15)
      },
    })
  })

  test(".opencode/ jsonc overrides .md for research-specific fields", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".opencode", "agent")
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
model: anthropic/claude-opus-4
skill_refs:
  - arxiv-search
output_dir: research
---

Research agent prompt from .md.
`,
        )
        await Bun.write(
          path.join(dir, ".opencode", "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              research: {
                skill_refs: ["alpha-research", "deep-research"],
                output_dir: "research-output",
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("research")
        expect(agent).toBeDefined()
        expect(agent?.skillRefs).toEqual(["alpha-research", "deep-research"])
        expect(agent?.outputDir).toBe("research-output")
      },
    })
  })

  test("root jsonc + .opencode/ jsonc: .opencode/ jsonc has highest precedence", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            agent: {
              "precedence-test": { steps: 30 },
            },
          }),
        )
      },
      config: {
        agent: {
          "precedence-test": {
            steps: 3,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("precedence-test")
        expect(agent).toBeDefined()
        expect(agent?.steps).toBe(30)
      },
    })
  })
})

describe("Config load order — mergeDeep semantics for agent fields", () => {
  test("root jsonc overrides native agent defaults", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            steps: 50,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.steps).toBe(50)
      },
    })
  })

  test("root jsonc fields preserved when .md agent does not define same name", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          "unique-name": {
            model: "anthropic/claude-opus-4",
            steps: 15,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("unique-name")
        expect(agent).toBeDefined()
        expect(agent?.model?.modelID).toBe(ModelID.make("claude-opus-4"))
        expect(agent?.steps).toBe(15)
      },
    })
  })
})
