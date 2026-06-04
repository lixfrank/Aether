import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Agent.Info extension fields — research agent config flow", () => {
  test("skill_refs from config populates Agent.Info.skillRefs", async () => {
    await using tmp = await tmpdir({
      git: true,
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
        expect(general?.skillRefs).toEqual(["arxiv-search", "deep-research"])
      },
    })
  })

  test("delegation_depth from config populates Agent.Info.delegationDepth", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            delegation_depth: 0,
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.delegationDepth).toBe(0)
      },
    })
  })

  test("env_scope from config compiles bash deny+allow into permission", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            env_scope: {
              allowed_commands: ["docker", "git"],
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(Permission.evaluate("bash", "docker build .", general!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git commit -m fix", general!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "rm -rf /", general!.permission).action).toBe("deny")
      },
    })
  })

  test("file_scope from config populates Agent.Info.fileScope", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            file_scope: ["src/**", "test/**"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.fileScope).toEqual(["src/**", "test/**"])
      },
    })
  })

  test("new fields do not leak into options (knownKeys whitelist)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            skill_refs: ["arxiv-search"],
            delegation_depth: 1,
            file_scope: ["src/**"],
            env_scope: { allowed_commands: ["docker"] },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.options["skill_refs"]).toBeUndefined()
        expect(general?.options["delegation_depth"]).toBeUndefined()
        expect(general?.options["file_scope"]).toBeUndefined()
        expect(general?.options["env_scope"]).toBeUndefined()
        expect(general?.skillRefs).toEqual(["arxiv-search"])
        expect(general?.delegationDepth).toBe(1)
      },
    })
  })

  test("undefined new fields = v0.6.0 behavior unchanged", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const general = await Agent.get("general")
        const explore = await Agent.get("explore")
        expect(build?.skillRefs).toBeUndefined()
        expect(build?.delegationDepth).toBeUndefined()
        expect(build?.fileScope).toBeUndefined()
        expect(build?.envScope).toBeUndefined()
        expect(general?.skillRefs).toBeUndefined()
        expect(explore?.skillRefs).toBeUndefined()
        expect(Permission.evaluate("edit", "*", build!.permission).action).toBe("allow")
        expect(Permission.evaluate("todowrite", "*", general!.permission).action).toBe("deny")
      },
    })
  })
})
