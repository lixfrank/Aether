import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"
import { Config } from "../../src/config/config"

afterEach(async () => {
  await Instance.disposeAll()
})

// ── Permission.intersection ──
// Core security fix: parent deny must block child allow.
// Layer 2 research agents run as subagents — parent (build/general) has broad permissions,
// child (research-explorer/research-verifier) may have narrower permissions.
// The intersection must ensure parent deny always wins so a restricted parent
// cannot be bypassed by a permissive child.

describe("Permission.intersection — subagent permission safety", () => {
  test("parent deny blocks child allow (security fix)", () => {
    const parent = Permission.fromConfig({ bash: "deny" })
    const child = Permission.fromConfig({ bash: "allow" })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "*", result).action).toBe("deny")
  })

  test("child deny is preserved even when parent allows", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: { "secret*": "deny" } })
    const result = Permission.intersection(parent, child)
    expect(Permission.evaluate("bash", "secret/file", result).action).toBe("deny")
    // "public/file" is not covered by any result rule; evaluate defaults to "ask".
    // At runtime, Permission.merge(agent.permission, session.permission) provides
    // the broad bash:allow from agent defaults, so "public/file" effectively becomes allow.
    expect(Permission.evaluate("bash", "public/file", result).action).toBe("ask")
    // Verify runtime merge produces allow
    const runtime = Permission.merge(parent, result)
    expect(Permission.evaluate("bash", "public/file", runtime).action).toBe("allow")
  })

  test("general→explore intersection preserves explore restrictions", () => {
    const general = Permission.fromConfig({
      "*": "allow",
      todowrite: "deny",
    })
    const explore = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      read: "allow",
    })
    const result = Permission.intersection(general, explore)
    // explore's wildcard deny is preserved (child deny)
    expect(Permission.evaluate("edit", "*", result).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", result).action).toBe("deny")
    // explore's explicit allows are kept since general also allows
    expect(Permission.evaluate("bash", "*", result).action).toBe("allow")
    expect(Permission.evaluate("read", "*", result).action).toBe("allow")
  })

  test("intersection with discipline override: env_scope whitelist", () => {
    const parent = Permission.fromConfig({ bash: "allow" })
    const child = Permission.fromConfig({ bash: "allow" })
    const override = Discipline.compile({
      env_scope: { allowed_commands: ["docker", "alpha"] },
    })
    const result = Permission.intersection(parent, child, override)
    // blanket deny from override, but specific allows
    expect(Permission.evaluate("bash", "docker run nginx", result).action).toBe("allow")
    expect(Permission.evaluate("bash", "alpha test", result).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", result).action).toBe("deny")
  })

  test("intersection with discipline override: delegation_depth=0 blocks task", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    const child = Permission.fromConfig({ "*": "allow" })
    const override = Discipline.compile({ delegation_depth: 0 })
    const result = Permission.intersection(parent, child, override)
    expect(Permission.evaluate("task", "*", result).action).toBe("deny")
  })

  test("intersection without override preserves v0.6.0 behavior", () => {
    const parent = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const child = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const result = Permission.intersection(parent, child, [])
    expect(Permission.evaluate("bash", "*", result).action).toBe("allow")
    expect(Permission.evaluate("todowrite", "*", result).action).toBe("deny")
  })

  test("parent deny propagates to uncovered permissions", () => {
    const parent = Permission.fromConfig({ "*": "allow", task: "deny" })
    const child = Permission.fromConfig({ bash: "allow" })
    const result = Permission.intersection(parent, child)
    // task deny from parent covers a permission the child doesn't declare
    expect(Permission.evaluate("task", "*", result).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", result).action).toBe("allow")
  })
})

// ── Discipline.compile ──
// Layer 2-3 research agents use env_scope to restrict bash commands,
// file_scope to restrict file tool access, delegation_depth to prevent
// nested task spawning. The deny-before-allow ordering is critical for
// findLast semantics.

describe("Discipline.compile — research agent constraint shortcuts", () => {
  test("env_scope compiles deny-before-allow for bash whitelist", () => {
    const rules = Discipline.compile({
      env_scope: { allowed_commands: ["docker", "git"] },
    })
    // deny comes before specific allows (findLast: allow wins for whitelisted commands)
    expect(Permission.evaluate("bash", "docker build .", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git commit -m fix", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", rules).action).toBe("deny")
  })

  test("file_scope compiles deny-before-allow for file tool restriction", () => {
    const rules = Discipline.compile({
      file_scope: ["src/**", "test/**"],
    })
    // FILE_TOOLS are blanket denied, then scope-specific allows
    expect(Permission.evaluate("read", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("read", "test/foo.test.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/main.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("read", "secrets/credentials.json", rules).action).toBe("deny")
    expect(Permission.evaluate("edit", "secrets/credentials.json", rules).action).toBe("deny")
  })

  test("delegation_depth=0 denies task, undefined produces no rule", () => {
    const withZero = Discipline.compile({ delegation_depth: 0 })
    expect(withZero.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)

    const without = Discipline.compile({})
    expect(without.some((r) => r.permission === "task")).toBe(false)
  })

  test("permission_override with mixed allow/pattern forms", () => {
    const rules = Discipline.compile({
      permission_override: {
        bash: ["allow", "docker*"],
        edit: ["deny"],
      },
    })
    expect(Permission.evaluate("bash", "*", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "docker*", rules).action).toBe("allow")
    expect(Permission.evaluate("edit", "*", rules).action).toBe("deny")
  })

  test("compile returns empty ruleset when no constraints set", () => {
    const rules = Discipline.compile({})
    expect(rules.length).toBe(0)
  })
})

// ── End-to-end: Task tool permission flow ──
// Simulates the scenario where a parent agent (general) creates a
// subagent session (research-explorer) with discipline constraints.
// This is what Layer 2 research agents will actually do.

describe("Subagent session permission flow — Layer 2 research agent scenario", () => {
  test("research-explorer subagent: env_scope + file_scope + delegation_depth=0", () => {
    // Simulate general agent as parent
    const parentPerm = Permission.fromConfig({
      "*": "allow",
      todowrite: "deny",
    })

    // Simulate research-explorer agent permission (like explore)
    const explorerPerm = Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      bash: "allow",
      read: "allow",
      webfetch: "allow",
    })

    // Task-level discipline: restrict bash to specific commands, files to src/**, block nested task
    const disciplineRules = Discipline.compile({
      env_scope: { allowed_commands: ["docker", "python3"] },
      file_scope: ["src/**", "docs/**"],
      delegation_depth: 0,
    })

    const sessionPerm = Permission.intersection(parentPerm, explorerPerm, disciplineRules)

    // Bash: only whitelisted commands allowed
    expect(Permission.evaluate("bash", "docker run", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("bash", "python3 script.py", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm -rf /", sessionPerm).action).toBe("deny")

    // File tools: only src/** and docs/** allowed (FILE_TOOLS includes grep/glob)
    expect(Permission.evaluate("read", "src/main.ts", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("read", "docs/README.md", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("read", "secrets/.env", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("grep", "src/**", sessionPerm).action).toBe("allow")
    expect(Permission.evaluate("grep", "docs/**", sessionPerm).action).toBe("allow")
    // grep/glob blanket deny from file_scope overrides child's blanket allow (findLast)
    expect(Permission.evaluate("grep", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("glob", "*", sessionPerm).action).toBe("deny")

    // Task: delegation_depth=0 blocks nested subagent creation
    expect(Permission.evaluate("task", "*", sessionPerm).action).toBe("deny")

    // Todowrite: denied from parent
    expect(Permission.evaluate("todowrite", "*", sessionPerm).action).toBe("deny")

    // webfetch: no file_scope restriction, so child's allow is preserved
    expect(Permission.evaluate("webfetch", "*", sessionPerm).action).toBe("allow")
  })

  test("research-verifier subagent: delegation_depth=0 + permission_override", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const verifierPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const disciplineRules = Discipline.compile({
      delegation_depth: 0,
      permission_override: { bash: ["deny"] },
    })

    const sessionPerm = Permission.intersection(parentPerm, verifierPerm, disciplineRules)
    expect(Permission.evaluate("task", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("todowrite", "*", sessionPerm).action).toBe("deny")
    expect(Permission.evaluate("read", "*", sessionPerm).action).toBe("allow")
  })

  test("primary_tools deny appended after intersection", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const childPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const sessionPerm = Permission.intersection(parentPerm, childPerm, [])
    const primaryToolsDeny = [{ permission: "bash", pattern: "*", action: "deny" as const }]
    const finalPerm = [...sessionPerm, ...primaryToolsDeny]

    // Permission.disabled correctly hard-deletes the denied tool
    const disabled = Permission.disabled(["bash", "read", "edit"], finalPerm)
    expect(disabled.has("bash")).toBe(true)
    expect(disabled.has("read")).toBe(false)
    expect(disabled.has("edit")).toBe(false)
  })

  // v0.6.0 fallback: agents without explicit task/todowrite rules get session-level deny.
  // Intersection alone doesn't produce these rules because the agent's broad "*: allow"
  // covers task/todowrite. Without the fallback, general subagent could ask to use task.
  test("general subagent without explicit task rule gets session-level task deny", () => {
    const parentPerm = Permission.fromConfig({ "*": "allow" })
    const generalPerm = Permission.fromConfig({ "*": "allow", todowrite: "deny" })
    const sessionPerm = Permission.intersection(parentPerm, generalPerm, [])

    // Intersection alone: general has "*: allow" so task is "allow" — no deny rule produced
    const hasTaskRule = sessionPerm.some((r) => r.permission === "task" && r.action === "deny")
    expect(hasTaskRule).toBe(false)

    // Fallback: add deny for agents without explicit task/todowrite permission rules
    const hasTaskPermission = generalPerm.some((r) => r.permission === "task")
    const hasTodoWritePermission = generalPerm.some((r) => r.permission === "todowrite")
    expect(hasTaskPermission).toBe(false) // general has no task rule
    expect(hasTodoWritePermission).toBe(true) // general has todowrite deny

    const sessionDenyRules = [
      ...(hasTodoWritePermission
        ? []
        : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
      ...(hasTaskPermission ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ]
    const finalPerm = [...sessionPerm, ...sessionDenyRules]

    // Now task is denied (v0.6.0 behavior preserved)
    expect(Permission.evaluate("task", "*", finalPerm).action).toBe("deny")
    // Todowrite deny from general's own permission + fallback (not duplicated)
    expect(Permission.evaluate("todowrite", "*", finalPerm).action).toBe("deny")

    // Permission.disabled correctly hard-deletes task and todowrite
    const disabled = Permission.disabled(["task", "todowrite", "bash", "read"], finalPerm)
    expect(disabled.has("task")).toBe(true)
    expect(disabled.has("todowrite")).toBe(true)
    expect(disabled.has("bash")).toBe(false)
  })
})

// ── Agent.Info extension fields via config ──
// Layer 2 research agents define skill_refs, env_scope, delegation_depth,
// scale_decision in their config. These must flow into Agent.Info correctly
// and not leak into the `options` catchall.

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

  test("scale_decision from config populates Agent.Info.scaleDecision", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            scale_decision: {
              direct_threshold: 50,
              never_spawn_for: ["quick lookup"],
              rules: [
                {
                  condition: "complex research",
                  subagent_count: 3,
                  subagent_type: "research-explorer",
                  mode: "concurrent",
                },
              ],
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(general?.scaleDecision?.direct_threshold).toBe(50)
        expect(general?.scaleDecision?.never_spawn_for).toEqual(["quick lookup"])
        expect(general?.scaleDecision?.rules?.length).toBe(1)
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
            scale_decision: { direct_threshold: 10 },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        // New fields should be on Agent.Info, not in options
        expect(general?.options["skill_refs"]).toBeUndefined()
        expect(general?.options["delegation_depth"]).toBeUndefined()
        expect(general?.options["file_scope"]).toBeUndefined()
        expect(general?.options["env_scope"]).toBeUndefined()
        expect(general?.options["scale_decision"]).toBeUndefined()
        // The actual values should be on the agent
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
        // All new fields should be undefined
        expect(build?.skillRefs).toBeUndefined()
        expect(build?.delegationDepth).toBeUndefined()
        expect(build?.fileScope).toBeUndefined()
        expect(build?.envScope).toBeUndefined()
        expect(build?.scaleDecision).toBeUndefined()
        expect(general?.skillRefs).toBeUndefined()
        expect(explore?.skillRefs).toBeUndefined()
        // Core permissions unchanged
        expect(Permission.evaluate("edit", "*", build!.permission).action).toBe("allow")
        expect(Permission.evaluate("todowrite", "*", general!.permission).action).toBe("deny")
      },
    })
  })
})

// ── skill_refs injection (append, not replace) ──
// Layer 2 research agents will have skill_refs like ["deep-research", "arxiv-search"].
// The skills() function must append the full content after the broadcast,
// preserving the broadcast so the agent still sees all available skills.

describe("skill_refs injection — research agent skill whitelist", () => {
  test("agent with skillRefs gets broadcast + injected content", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "arxiv-search")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: arxiv-search
description: Search arXiv papers.
---

# ArXiv Search
Search arXiv for preprints and academic papers.
`,
        )
        const skillDir2 = path.join(dir, ".opencode", "skill", "deep-research")
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: deep-research
description: Comprehensive research assistant.
---

# Deep Research
Conduct comprehensive research with citations.
`,
        )
      },
      config: {
        agent: {
          general: {
            skill_refs: ["arxiv-search", "deep-research"],
          },
        },
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const general = await Agent.get("general")
          const output = await SystemPrompt.skills(general!)

          // Must contain broadcast summary
          expect(output).toContain("<available_skills>")
          expect(output).toContain("<name>arxiv-search</name>")
          expect(output).toContain("<name>deep-research</name>")

          // Must contain injected mandatory section
          expect(output).toContain("Skills (mandatory)")
          expect(output).toContain("Skill: arxiv-search")
          expect(output).toContain("Skill: deep-research")
          expect(output).toContain("# ArXiv Search")
          expect(output).toContain("# Deep Research")

          // Injected content comes after broadcast
          const broadcastEnd = output!.indexOf("</available_skills>")
          const injectedStart = output!.indexOf("Skills (mandatory)")
          expect(injectedStart).toBeGreaterThan(broadcastEnd)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("agent without skillRefs gets only broadcast (v0.6.0 unchanged)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "arxiv-search")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: arxiv-search
description: Search arXiv papers.
---

# ArXiv Search
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
          const build = await Agent.get("build")
          const output = await SystemPrompt.skills(build!)
          // Only broadcast, no injection
          expect(output).toContain("<available_skills>")
          expect(output).not.toContain("Skills (mandatory)")
          expect(output).not.toContain("Skill: arxiv-search")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("skillRefs referencing nonexistent skill shows warning", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          general: {
            skill_refs: ["nonexistent-skill"],
          },
        },
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const general = await Agent.get("general")
          const output = await SystemPrompt.skills(general!)
          expect(output).toContain("referenced but not found")
          expect(output).toContain("nonexistent-skill")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})

// ── scale_decision injection ──
// Layer 2 research agents use scale_decision to control when to spawn
// subagents. It must appear in the system prompt as a behavioral guide.

describe("scale_decision injection — research agent scaling guide", () => {
  test("agent with scaleDecision produces system prompt section", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            scale_decision: {
              direct_threshold: 50,
              never_spawn_for: ["quick lookup"],
              rules: [
                {
                  condition: "complex research",
                  subagent_count: 3,
                  subagent_type: "research-explorer",
                  mode: "concurrent",
                },
              ],
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const sd = SystemPrompt.scaleDecision(general!)
        expect(sd).toContain("Scale Decision")
        expect(sd).toContain("50 words")
        expect(sd).toContain("quick lookup")
        expect(sd).toContain("complex research")
        expect(sd).toContain("3 research-explorer subagents (concurrent)")
      },
    })
  })

  test("agent without scaleDecision returns undefined", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(SystemPrompt.scaleDecision(build!)).toBeUndefined()
      },
    })
  })

  test("scaleDecision with empty rules returns undefined", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          general: {
            scale_decision: {
              direct_threshold: 100,
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        expect(SystemPrompt.scaleDecision(general!)).toBeUndefined()
      },
    })
  })
})

// ── Config.Info category field ──
// Layer 1 uses category routing for model selection in subagent sessions.
// The category field must be in the strict schema to avoid config load errors.

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
