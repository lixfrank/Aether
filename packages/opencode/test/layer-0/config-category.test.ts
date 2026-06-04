import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Config.Info category field — model routing for research agents", () => {
  test("category config loads without strict schema error", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        category: {
          quick: {
            model: "anthropic/claude-3-5-haiku",
            description: "Fast model for quick tasks",
          },
          deep: {
            model: "anthropic/claude-3-5-sonnet",
            description: "Capable model for deep research",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.category?.quick?.model).toBe("anthropic/claude-3-5-haiku")
        expect(cfg.category?.deep?.model).toBe("anthropic/claude-3-5-sonnet")
      },
    })
  })

  test("category routing: parseModel resolves config model string", () => {
    const { Provider } = require("../../src/provider/provider")
    const model = Provider.parseModel("anthropic/claude-3-5-haiku")
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.modelID)).toBe("claude-3-5-haiku")
  })

  test("no category config = undefined (v0.6.0 unchanged)", async () => {
    await using tmp = await tmpdir({
      git: true,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.category).toBeUndefined()
      },
    })
  })
})
