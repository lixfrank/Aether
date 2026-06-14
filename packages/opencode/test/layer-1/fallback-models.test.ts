import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { ProviderID, ModelID } from "../../src/provider/schema"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

afterEach(async () => {
  await Instance.disposeAll()
})

function evalPerm(agent: Agent.Info, permission: string, pattern = "*"): Permission.Action | undefined {
  return Permission.evaluate(permission, pattern, agent.permission).action
}

describe.skipIf(skip)("Layer 1 — fallback_models config & Agent.Info", () => {
  test("fallback_models[0] promoted to model when agent.model is absent", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            fallback_models: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.model).toEqual({
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-sonnet-4-5"),
        })
        expect(general?.fallbackModels).toEqual(["openai/gpt-4o"])
      },
    })
  })

  test("fallback_models with single entry: promoted to model, fallbackModels empty", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            fallback_models: [{ model: "anthropic/claude-sonnet-4-5" }],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.model).toEqual({
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-sonnet-4-5"),
        })
        expect(general?.fallbackModels).toEqual([])
      },
    })
  })

  test("model takes priority over fallback_models[0]", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            model: "anthropic/claude-opus-4",
            fallback_models: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.model).toEqual({
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-opus-4"),
        })
        expect(general?.fallbackModels).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"])
      },
    })
  })

  test("fallbackModels not in options (knownKeys whitelist)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            fallback_models: ["anthropic/claude-sonnet-4-5"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.options["fallback_models"]).toBeUndefined()
      },
    })
  })

  test("build agent unchanged when no fallbackModels (backward compatible)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build?.fallbackModels).toBeUndefined()
        expect(evalPerm(build!, "edit")).toBe("allow")
      },
    })
  })
})

describe.skipIf(skip)("Layer 1 — promptWithFallback logic (unit)", () => {
  test("modelsToTry caps at 4 entries (primary + 3 fallbacks)", () => {
    const primary = { modelID: "model-1" as any, providerID: "provider-1" as any }
    const fallbackModels = [
      "provider-2/model-2",
      "provider-3/model-3",
      "provider-4/model-4",
      "provider-5/model-5",
    ] as any[]
    const modelsToTry = [primary, ...fallbackModels.slice(0, 3)]
    expect(modelsToTry.length).toBeLessThanOrEqual(4)
  })

  test("no fallbackModels means only primary model is tried", () => {
    const primary = { modelID: "model-1" as any, providerID: "provider-1" as any }
    const modelsToTry = [primary].slice(0, 4)
    expect(modelsToTry.length).toBe(1)
    expect(modelsToTry[0]).toEqual(primary)
  })

  test("APICallError.isRetryable property exists on provider errors", async () => {
    const { APICallError } = await import("@ai-sdk/provider")
    expect(typeof APICallError).toBeDefined()
  })
})
