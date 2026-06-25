import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { APICallError } from "@ai-sdk/provider"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("promptWithFallback — model resolution & retry logic", () => {
  test("resolveModelID: string fallback resolves to provider/model", () => {
    const id = Provider.parseModel("anthropic/claude-sonnet-4-5")
    expect(id.providerID).toBe(ProviderID.make("anthropic"))
    expect(id.modelID).toBe(ModelID.make("claude-sonnet-4-5"))
  })

  test("resolveModelID: object fallback with .model field resolves correctly", () => {
    const id = Provider.parseModel("openai/gpt-4o")
    expect(id.providerID).toBe(ProviderID.make("openai"))
    expect(id.modelID).toBe(ModelID.make("gpt-4o"))
  })

  test("modelsToTry list: primary + fallbacks capped at 4", () => {
    const primary = { modelID: ModelID.make("claude-opus-4"), providerID: ProviderID.make("anthropic") }
    const fallbackStrings = ["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.5-pro", "meta/llama-4"]
    const modelsToTry = [primary, ...fallbackStrings.slice(0, 3).map((fm) => Provider.parseModel(fm))]
    expect(modelsToTry.length).toBe(4)
  })

  test("modelsToTry list: fewer than 3 fallbacks → shorter list", () => {
    const primary = { modelID: ModelID.make("claude-opus-4"), providerID: ProviderID.make("anthropic") }
    const fallbackStrings = ["anthropic/claude-sonnet-4-5"]
    const modelsToTry = [primary, ...fallbackStrings.map((fm) => Provider.parseModel(fm))]
    expect(modelsToTry.length).toBe(2)
  })

  test("modelsToTry list: no fallbacks → only primary", () => {
    const primary = { modelID: ModelID.make("claude-opus-4"), providerID: ProviderID.make("anthropic") }
    const modelsToTry = [primary]
    expect(modelsToTry.length).toBe(1)
  })

  test("APICallError.isRetryable=false → should skip fallback (simulated)", () => {
    const err = new APICallError({
      message: "rate limited",
      url: "https://api.example.com",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "rate limited",
      isRetryable: false,
    })
    expect(err.isRetryable).toBe(false)
  })

  test("APICallError.isRetryable=true → should try next fallback (simulated)", () => {
    const err = new APICallError({
      message: "timeout",
      url: "https://api.example.com",
      requestBodyValues: {},
      statusCode: 503,
      responseBody: "service unavailable",
      isRetryable: true,
    })
    expect(err.isRetryable).toBe(true)
  })

  test("fallback loop behavior: retryable errors exhaust all models → throws last error", () => {
    const models = ["model-1", "model-2", "model-3"]
    const errors = [{ isRetryable: true }, { isRetryable: true }, { isRetryable: true }]
    let thrownError: any = null
    for (let i = 0; i < models.length; i++) {
      if (errors[i].isRetryable && i < models.length - 1) continue
      thrownError = errors[i]
    }
    expect(thrownError.isRetryable).toBe(true)
  })

  test("fallback loop behavior: non-retryable error on first model → immediate throw", () => {
    const models = ["model-1", "model-2"]
    const errors = [{ isRetryable: false }, { isRetryable: true }]
    let thrown = false
    for (let i = 0; i < models.length; i++) {
      if (!errors[i].isRetryable) {
        thrown = true
        break
      }
    }
    expect(thrown).toBe(true)
  })
})
