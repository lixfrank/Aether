import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"
import path from "path"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

afterEach(async () => {
  await Instance.disposeAll()
})

describe.skipIf(skip)("Layer 1 — output_dir config & SystemPrompt injection", () => {
  test("output_dir from config populates Agent.Info.outputDir", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            output_dir: "research",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.outputDir).toBe("research")
      },
    })
  })

  test("SystemPrompt.outputDir returns prompt when agent has outputDir", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          general: {
            output_dir: "research",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const result = SystemPrompt.outputDir(general!)
        expect(result).toContain("Your output directory is at")
        expect(result).toContain(path.join(tmp.path, ".aether", "research"))
        expect(result).toContain("Write findings to this directory")
      },
    })
  })

  test("SystemPrompt.outputDir strips .aether/ prefix to prevent double nesting", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          general: {
            output_dir: ".aether/research",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const result = SystemPrompt.outputDir(general!)
        const expected = path.join(tmp.path, ".aether", "research")
        expect(result).toContain(expected)
        expect(result).not.toContain(path.join(tmp.path, ".aether", ".aether", "research"))
      },
    })
  })

  test("SystemPrompt.outputDir returns undefined when agent has no outputDir", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build?.outputDir).toBeUndefined()
        expect(SystemPrompt.outputDir(build!)).toBeUndefined()
      },
    })
  })

  test("outputDir not in options (knownKeys whitelist)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            output_dir: "research",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.options["output_dir"]).toBeUndefined()
        expect(general?.outputDir).toBe("research")
      },
    })
  })

  test("build agent unchanged when no outputDir (backward compatible)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build?.outputDir).toBeUndefined()
        expect(SystemPrompt.outputDir(build!)).toBeUndefined()
      },
    })
  })
})
