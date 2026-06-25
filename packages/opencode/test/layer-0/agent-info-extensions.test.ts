import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

afterEach(async () => {
  await Instance.disposeAll()
})

describe.skipIf(skip)("Agent.Info extension fields — research agent config flow", () => {
  test("undefined new fields = v0.6.0 behavior unchanged", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const general = await Agent.get("general")
        expect(Permission.evaluate("edit", "*", build!.permission).action).toBe("allow")
        expect(Permission.evaluate("todowrite", "*", general!.permission).action).toBe("deny")
      },
    })
  })
})
