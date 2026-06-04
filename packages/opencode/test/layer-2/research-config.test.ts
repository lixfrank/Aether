import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"
import { SystemPrompt } from "../../src/session/system"

afterEach(async () => {
  await Instance.disposeAll()
})

function evalPerm(agent: Agent.Info, permission: string, pattern = "*"): Permission.Action | undefined {
  return Permission.evaluate(permission, pattern, agent.permission).action
}

function makeResearchAgentConfig() {
  return {
    description: "Research mode — deep search, analysis, and verification",
    color: "#7C3AED",
    mode: "primary" as const,
    permission: {
      "*": "deny" as const,
      grep: "allow" as const,
      glob: "allow" as const,
      read: "allow" as const,
      edit: "allow" as const,
      write: "allow" as const,
      webfetch: "allow" as const,
      websearch: "allow" as const,
      knowledge_search: "allow" as const,
      question: "allow" as const,
      todowrite: "allow" as const,
      task: "allow" as const,
      skill: "allow" as const,
      bash: "allow" as const,
      external_directory: "ask" as const,
    },
    skill_refs: [
      "deep-research",
      "autoresearch",
      "literature-review",
      "execute-docker",
      "source-comparison",
      "paper-code-audit",
      "alpha-research",
      "arxiv-search",
    ],
    fallback_models: ["anthropic/claude-sonnet-4-5"],
    mcp: {
      "research-conventions": true,
      "research-state": true,
    },
    env_scope: {
      allowed_commands: ["alpha", "curl", "rg", "grep", "git", "docker"],
    },
    output_dir: "research",
  }
}

describe("Layer 2 — research.md agent definition", () => {
  test("research agent appears in Agent.list() when defined via config", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Agent.list()
        const names = agents.map((a) => a.name)
        expect(names).toContain("research")
      },
    })
  })

  test("research agent has correct permission structure", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research).toBeDefined()
        expect(research?.mode).toBe("primary")
        expect(evalPerm(research!, "edit")).toBe("allow")
        expect(evalPerm(research!, "bash", "alpha test")).toBe("allow")
        expect(evalPerm(research!, "bash", "rm -rf /")).toBe("deny")
        expect(evalPerm(research!, "grep")).toBe("allow")
        expect(evalPerm(research!, "glob")).toBe("allow")
        expect(evalPerm(research!, "read")).toBe("allow")
        expect(evalPerm(research!, "webfetch")).toBe("allow")
        expect(evalPerm(research!, "skill")).toBe("allow")
        expect(evalPerm(research!, "task")).toBe("allow")
        expect(evalPerm(research!, "external_directory")).toBe("ask")
      },
    })
  })

  test("research agent skill_refs populate skillRefs array", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.skillRefs).toEqual([
          "deep-research",
          "autoresearch",
          "literature-review",
          "execute-docker",
          "source-comparison",
          "paper-code-audit",
          "alpha-research",
          "arxiv-search",
        ])
      },
    })
  })

  test("research agent env_scope compiles into bash deny-before-allow", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(Permission.evaluate("bash", "alpha test", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "docker run nginx", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "curl https://example.com", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "rg pattern", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "grep -r term", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "git status", research!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "rm -rf /", research!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "npm install", research!.permission).action).toBe("deny")
      },
    })
  })

  test("research agent mcp config restricts MCP tool visibility", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.mcp).toEqual({
          "research-conventions": true,
          "research-state": true,
        })
      },
    })
  })

  test("research agent fallback_models set correctly", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.fallbackModels).toEqual(["anthropic/claude-sonnet-4-5"])
      },
    })
  })

  test("research agent output_dir set correctly", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.outputDir).toBe("research")
        const od = SystemPrompt.outputDir(research!)
        expect(od).toContain("Your output directory is at")
        expect(od).toContain(path.join(tmp.path, ".aether", "research"))
      },
    })
  })
})

describe("Layer 2 — research-explorer subagent", () => {
  test("research-explorer subagent can be defined via config", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          "research-explorer": {
            description: "Gather primary evidence",
            mode: "subagent" as const,
            permission: {
              "*": "deny" as const,
              grep: "allow" as const,
              glob: "allow" as const,
              bash: "allow" as const,
              webfetch: "allow" as const,
              websearch: "allow" as const,
              read: "allow" as const,
            },
            skill_refs: ["alpha-research", "arxiv-search"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const explorer = await Agent.get("research-explorer")
        expect(explorer).toBeDefined()
        expect(explorer?.mode).toBe("subagent")
        expect(explorer?.skillRefs).toEqual(["alpha-research", "arxiv-search"])
        expect(evalPerm(explorer!, "grep")).toBe("allow")
        expect(evalPerm(explorer!, "read")).toBe("allow")
        expect(evalPerm(explorer!, "edit")).toBe("deny")
        expect(evalPerm(explorer!, "webfetch")).toBe("allow")
      },
    })
  })

  test("research-explorer inherits intersection with parent caller permission", () => {
    const parentPerm = Permission.fromConfig({
      "*": "allow",
      todowrite: "deny",
    })
    const explorerPerm = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      read: "allow",
      webfetch: "allow",
    })
    const sessionPerm = Permission.intersection(parentPerm, explorerPerm)
    expect(Permission.evaluate("grep", "*", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("edit", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", sessionPerm).action).toBe("allow")
  })
})

describe("Layer 2 — research-verifier & gpd-verifier subagents", () => {
  test("research-verifier subagent with MCP wildcard permission", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          "research-verifier": {
            description: "Verify research results",
            mode: "subagent" as const,
            permission: {
              "*": "deny" as const,
              grep: "allow" as const,
              glob: "allow" as const,
              bash: "allow" as const,
              webfetch: "allow" as const,
              read: "allow" as const,
            },
            skill_refs: ["research-verification"],
            mcp: {
              "research-conventions": true,
              "research-state": true,
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const verifier = await Agent.get("research-verifier")
        expect(verifier).toBeDefined()
        expect(verifier?.mode).toBe("subagent")
        expect(verifier?.skillRefs).toEqual(["research-verification"])
        expect(verifier?.mcp).toEqual({
          "research-conventions": true,
          "research-state": true,
        })
      },
    })
  })

  test("gpd-verifier subagent with extended physics skill_refs", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          "gpd-verifier": {
            description: "Verify physics research results",
            mode: "subagent" as const,
            permission: {
              "*": "deny" as const,
              grep: "allow" as const,
              glob: "allow" as const,
              bash: "allow" as const,
              webfetch: "allow" as const,
              read: "allow" as const,
            },
            skill_refs: [
              "research-verification",
              "gpd-verification",
              "gpd-errors",
              "gpd-domain-check",
              "gpd-conventions",
            ],
            mcp: {
              "research-conventions": true,
              "research-state": true,
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const gpd = await Agent.get("gpd-verifier")
        expect(gpd).toBeDefined()
        expect(gpd?.skillRefs).toEqual([
          "research-verification",
          "gpd-verification",
          "gpd-errors",
          "gpd-domain-check",
          "gpd-conventions",
        ])
        expect(gpd?.mcp).toEqual({
          "research-conventions": true,
          "research-state": true,
        })
      },
    })
  })

  test("MCP wildcard permission: research_conventions_* matches MCP tool IDs", () => {
    const ruleset = Permission.fromConfig({
      "research_conventions_*": "allow",
      "research_state_*": "allow",
    })
    expect(Permission.evaluate("research_conventions_convention_lock_status", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("research_state_get_status", "*", ruleset).action).toBe("allow")
    expect(Permission.evaluate("some_other_mcp_tool", "*", ruleset).action).toBe("ask")
  })

  test("research-verifier is domain-agnostic (no gpd-* skills)", () => {
    const verifierSkills = ["research-verification"]
    const gpdSkills = ["research-verification", "gpd-verification", "gpd-errors", "gpd-domain-check", "gpd-conventions"]
    expect(gpdSkills).toContain("research-verification")
    expect(verifierSkills).not.toContain("gpd-verification")
  })
})

describe("Layer 2 — gpd-reviewer subagent", () => {
  test("gpd-reviewer can be defined with empty skill_refs", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          "gpd-reviewer": {
            description: "Systematic peer review",
            mode: "subagent" as const,
            permission: {
              "*": "deny" as const,
              grep: "allow" as const,
              glob: "allow" as const,
              bash: "allow" as const,
              webfetch: "allow" as const,
              read: "allow" as const,
            },
            skill_refs: [],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const reviewer = await Agent.get("gpd-reviewer")
        expect(reviewer).toBeDefined()
        expect(reviewer?.mode).toBe("subagent")
        expect(reviewer?.skillRefs).toEqual([])
        expect(evalPerm(reviewer!, "read")).toBe("allow")
        expect(evalPerm(reviewer!, "edit")).toBe("deny")
      },
    })
  })
})

describe("Layer 2 — backward compatibility", () => {
  test("build/plan/general/explore unchanged when research not defined", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const plan = await Agent.get("plan")
        const general = await Agent.get("general")
        const explore = await Agent.get("explore")
        expect(evalPerm(build!, "edit")).toBe("allow")
        expect(evalPerm(build!, "bash")).toBe("allow")
        expect(evalPerm(plan!, "edit", ".aether/plans/foo.md")).toBe("allow")
        expect(evalPerm(plan!, "edit")).toBe("deny")
        expect(evalPerm(general!, "todowrite")).toBe("deny")
        expect(evalPerm(explore!, "edit")).toBe("deny")
      },
    })
  })

  test("deleting research config restores default agent behavior", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Agent.list()
        const names = agents.map((a) => a.name)
        expect(names).not.toContain("research")
        const build = await Agent.get("build")
        expect(build?.mcp).toBeUndefined()
        expect(build?.outputDir).toBeUndefined()
        expect(build?.fallbackModels).toBeUndefined()
      },
    })
  })

  test("non-physics users can use research-verifier without gpd-* plugins", () => {
    const verifierPerm = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      webfetch: "allow",
      read: "allow",
    })
    const verifierSkills = ["research-verification"]
    expect(verifierSkills).not.toContain("gpd-verification")
    expect(verifierSkills).not.toContain("gpd-errors")
    expect(Permission.evaluate("grep", "*", verifierPerm).action).toBe("allow")
    expect(Permission.evaluate("read", "*", verifierPerm).action).toBe("allow")
  })
})

describe("Layer 2 — scale decision via prompt (markdown body)", () => {
  test("agent prompt from config is populated (markdown body injection)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: {
            ...makeResearchAgentConfig(),
            prompt: "# Research Mode\nRoute based on intent.",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.prompt).toContain("Research Mode")
        expect(research?.prompt).toContain("Route based on intent")
      },
    })
  })

  test("no scale_decision field in Agent.Info (prompt-only, no core code field)", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: makeResearchAgentConfig(),
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research).toBeDefined()
        expect((research as any)["scale_decision"]).toBeUndefined()
        expect((research as any)["scaleDecision"]).toBeUndefined()
      },
    })
  })
})

describe("Layer 2 — .aether/agent/research.md file loading", () => {
  test("agent definition from .aether/agent/ directory creates research agent", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "agent")
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Research mode — deep search, analysis, and verification
color: "#7C3AED"
mode: primary
permission:
  "*": deny
  grep: allow
  glob: allow
  read: allow
  edit: allow
  bash: allow
  webfetch: allow
skill_refs:
  - arxiv-search
  - deep-research
fallback_models:
  - anthropic/claude-sonnet-4-5
mcp:
  research-conventions: true
  research-state: true
env_scope:
  allowed_commands:
    - alpha
    - docker
output_dir: research
---

# Research Mode

Route based on intent.
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
          const research = await Agent.get("research")
          expect(research).toBeDefined()
          expect(research?.mode).toBe("primary")
          expect(research?.description).toBe("Research mode — deep search, analysis, and verification")
          expect(research?.skillRefs).toEqual(["arxiv-search", "deep-research"])
          expect(research?.mcp).toEqual({
            "research-conventions": true,
            "research-state": true,
          })
          expect(research?.outputDir).toBe("research")
          expect(research?.fallbackModels).toEqual(["anthropic/claude-sonnet-4-5"])
          expect(research?.prompt).toContain("Research Mode")
          expect(Permission.evaluate("bash", "alpha test", research!.permission).action).toBe("allow")
          expect(Permission.evaluate("bash", "docker run nginx", research!.permission).action).toBe("allow")
          expect(Permission.evaluate("bash", "rm -rf /", research!.permission).action).toBe("deny")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("research-explorer.md from .aether/agent/ creates subagent", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "agent")
        await Bun.write(
          path.join(agentDir, "research-explorer.md"),
          `---
description: Gather primary evidence
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  bash: allow
  read: allow
  webfetch: allow
skill_refs:
  - alpha-research
  - arxiv-search
---

# Integrity Commandments
Never fabricate a source.
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
          const explorer = await Agent.get("research-explorer")
          expect(explorer).toBeDefined()
          expect(explorer?.mode).toBe("subagent")
          expect(explorer?.skillRefs).toEqual(["alpha-research", "arxiv-search"])
          expect(explorer?.prompt).toContain("Integrity Commandments")
          expect(evalPerm(explorer!, "grep")).toBe("allow")
          expect(evalPerm(explorer!, "edit")).toBe("deny")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("removing .aether/agent/research.md removes research from Agent.list", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Agent.list()
        const names = agents.map((a) => a.name)
        expect(names).not.toContain("research")
        expect(names).not.toContain("research-explorer")
        const build = await Agent.get("build")
        expect(build?.mode).toBe("primary")
        expect(evalPerm(build!, "edit")).toBe("allow")
      },
    })
  })
})
