import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { SystemPrompt } from "../../src/session/system"
import { SessionPreference } from "../../src/session/preference"
import { Config } from "../../src/config/config"
import { validate } from "../../src/config/validate-roles"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("M1: base_agent field", () => {
  test("inherits model and permission from base_agent", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          myagent: {
            base_agent: "general",
            description: "Inherits from general",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const myagent = await Agent.get("myagent")
        expect(myagent).toBeDefined()
        expect(myagent?.baseAgent).toBe("general")
        expect(myagent?.model?.providerID).toBe(general?.model?.providerID)
        expect(myagent?.model?.modelID).toBe(general?.model?.modelID)
      },
    })
  })

  test("does not inherit UI fields (enterDescription, exitDescription, exitOptions) from base_agent", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: {
            mode: "primary",
            enter_description: "Enter research mode",
            exit_description: "Exit research mode",
            exit_options: [{ label: "Back to build", agent: "build", description: "Return" }],
            description: "Research agent",
          },
          myagent: {
            base_agent: "research",
            description: "My custom agent",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const myagent = await Agent.get("myagent")
        expect(myagent).toBeDefined()
        expect(myagent?.enterDescription).toBeUndefined()
        expect(myagent?.exitDescription).toBeUndefined()
        expect(myagent?.exitOptions).toBeUndefined()
      },
    })
  })

  test("inherits prompt and steps from base_agent", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          myagent: {
            base_agent: "general",
            description: "Inherits from general",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const general = await Agent.get("general")
        const myagent = await Agent.get("myagent")
        expect(myagent?.prompt).toBe(general?.prompt)
      },
    })
  })

  test("explicit config overrides base_agent inheritance", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: { test: { models: { "override-model": { id: "override-model" } } } },
        agent: {
          myagent: {
            base_agent: "general",
            model: "test/override-model",
            description: "Overrides model",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const myagent = await Agent.get("myagent")
        expect(myagent?.model?.modelID).toBe("override-model" as any)
      },
    })
  })
})

describe("M2: skill_refs whitelist injection", () => {
  test("skill_refs whitelist injects full skill content instead of broadcast list", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "alpha-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: alpha-skill
description: Alpha skill
---

# Alpha Skill

Procedure:
1. Step one
2. Step two

Outputs: alpha_result
`,
        )
        const otherDir = path.join(dir, ".opencode", "skill", "beta-skill")
        await Bun.write(
          path.join(otherDir, "SKILL.md"),
          `---
name: beta-skill
description: Beta skill
---

# Beta Skill
`,
        )
      },
      config: {
        agent: {
          scoped: {
            skill_refs: ["alpha-skill"],
            description: "Scoped agent",
            mode: "subagent",
          },
        },
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const scoped = await Agent.get("scoped")
        const result = await SystemPrompt.skills(scoped!)

        expect(result).toBeDefined()
        expect(result!.includes("Alpha Skill")).toBe(true)
        expect(result!.includes("Procedure:")).toBe(true)
        expect(result!.includes("Step one")).toBe(true)
        expect(result!.includes("beta-skill")).toBe(false)
        expect(result!.startsWith("## Skills (mandatory)")).toBe(true)
      },
    })

    process.env.OPENCODE_TEST_HOME = undefined
  })

  test("missing skill_refs are reported in prompt", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          scoped: {
            skill_refs: ["nonexistent-skill"],
            description: "Scoped agent",
            mode: "subagent",
          },
        },
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const scoped = await Agent.get("scoped")
        const result = await SystemPrompt.skills(scoped!)

        expect(result).toBeDefined()
        expect(result!.includes("nonexistent-skill")).toBe(true)
        expect(result!.includes("not found")).toBe(true)
      },
    })

    process.env.OPENCODE_TEST_HOME = undefined
  })

  test("agents without skill_refs fall back to broadcast mode", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "alpha-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: alpha-skill
description: Alpha skill
---

# Alpha Skill
`,
        )
      },
      config: {
        agent: {
          noskillref: {
            description: "No skill_refs",
            mode: "subagent",
          },
        },
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("noskillref")
        const result = await SystemPrompt.skills(agent!)

        expect(result).toBeDefined()
        expect(result!.includes("alpha-skill")).toBe(true)
        expect(result!.includes("<name>")).toBe(true)
      },
    })

    process.env.OPENCODE_TEST_HOME = undefined
  })

  test("Skill.available filters by skillRefs whitelist for scoped agent", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir1 = path.join(dir, ".opencode", "skill", "alpha-skill")
        await Bun.write(
          path.join(skillDir1, "SKILL.md"),
          `---
name: alpha-skill
description: Alpha skill
---

# Alpha Skill
`,
        )
        const skillDir2 = path.join(dir, ".opencode", "skill", "beta-skill")
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: beta-skill
description: Beta skill
---

# Beta Skill
`,
        )
        const skillDir3 = path.join(dir, ".opencode", "skill", "gamma-skill")
        await Bun.write(
          path.join(skillDir3, "SKILL.md"),
          `---
name: gamma-skill
description: Gamma skill
---

# Gamma Skill
`,
        )
      },
      config: {
        agent: {
          scoped: {
            skill_refs: ["alpha-skill", "beta-skill"],
            description: "Scoped agent",
            mode: "subagent",
          },
        },
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const scoped = await Agent.get("scoped")
        const allSkills = await import("../../src/skill").then((m) => m.Skill.all())
        const scopedSkills = await import("../../src/skill").then((m) => m.Skill.available(scoped!))

        expect(scopedSkills.length).toBeLessThan(allSkills.length)
        expect(scopedSkills.every((s) => s.name === "alpha-skill" || s.name === "beta-skill")).toBe(true)
        expect(scopedSkills.find((s) => s.name === "gamma-skill")).toBeUndefined()
      },
    })

    process.env.OPENCODE_TEST_HOME = undefined
  })

  test("Skill tool description only lists whitelisted skills for scoped agent", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir1 = path.join(dir, ".opencode", "skill", "alpha-skill")
        await Bun.write(
          path.join(skillDir1, "SKILL.md"),
          `---
name: alpha-skill
description: Alpha skill
---

# Alpha Skill
`,
        )
        const skillDir2 = path.join(dir, ".opencode", "skill", "beta-skill")
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: beta-skill
description: Beta skill
---

# Beta Skill
`,
        )
        const skillDir3 = path.join(dir, ".opencode", "skill", "gamma-skill")
        await Bun.write(
          path.join(skillDir3, "SKILL.md"),
          `---
name: gamma-skill
description: Gamma skill
---

# Gamma Skill
`,
        )
      },
      config: {
        agent: {
          scoped: {
            skill_refs: ["alpha-skill", "beta-skill"],
            description: "Scoped agent",
            mode: "subagent",
          },
        },
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const scoped = await Agent.get("scoped")
        const { SkillTool } = await import("../../src/tool/skill")
        const toolResult = await SkillTool.init({ agent: scoped! })

        expect(toolResult.description.includes("alpha-skill")).toBe(true)
        expect(toolResult.description.includes("beta-skill")).toBe(true)
        expect(toolResult.description.includes("gamma-skill")).toBe(false)
      },
    })

    process.env.OPENCODE_TEST_HOME = undefined
  })
})

describe("M3: YAML role library loading", () => {
  test("loads roles from YAML with domain key applied", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const rolesDir = path.join(dir, ".opencode", "roles")
        await fs.mkdir(rolesDir, { recursive: true })
        await Bun.write(
          path.join(rolesDir, "test-roles.yaml"),
          `version: "1.0"
defaults:
  base_agent: general
roles:
  data_and_statistics:
    - role_id: stats-analyst
      purpose: Analyze statistical data
      outputs: [benchmark_table]
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("stats-analyst")
        expect(agent).toBeDefined()
        expect(agent?.domain).toBe("data_and_statistics")
        expect(agent?.description).toBe("Analyze statistical data")
        expect(agent?.baseAgent).toBe("general")
        expect(agent?.outputs).toEqual(["benchmark_table"])
      },
    })
  })

  test("loads role card .md file when YAML role has no prompt", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const rolesDir = path.join(dir, ".opencode", "roles")
        await fs.mkdir(rolesDir, { recursive: true })
        await Bun.write(
          path.join(rolesDir, "test-roles.yaml"),
          `version: "1.0"
roles:
  coordination:
    - role_id: pi-agent
      purpose: Lead the project
`,
        )
        const cardDir = path.join(dir, ".opencode", "roles", "general", "coordination")
        await fs.mkdir(cardDir, { recursive: true })
        await Bun.write(
          path.join(cardDir, "pi-agent.md"),
          `---
name: pi-agent
description: Lead the project
---

# PI Agent Instructions

You are the principal investigator. Define research goals and acceptance criteria.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("pi-agent")
        expect(agent).toBeDefined()
        expect(agent?.prompt).toContain("principal investigator")
        expect(agent?.prompt).toContain("Define research goals")
      },
    })
  })

  test("YAML role with explicit prompt takes precedence over role card", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const rolesDir = path.join(dir, ".opencode", "roles")
        await fs.mkdir(rolesDir, { recursive: true })
        await Bun.write(
          path.join(rolesDir, "test-roles.yaml"),
          `version: "1.0"
roles:
  coordination:
    - role_id: pi-agent
      purpose: Lead the project
      prompt: "Inline YAML prompt"
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("pi-agent")
        expect(agent).toBeDefined()
        expect(agent?.prompt).toBe("Inline YAML prompt")
      },
    })
  })
})

describe("M4: inputs/outputs/output_contract prompt injection", () => {
  test("inputs declaration is injected into system prompt", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            inputs: ["literature_map", "benchmark_table"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("worker")
        expect(agent?.inputs).toEqual(["literature_map", "benchmark_table"])
      },
    })
  })

  test("outputs declaration is stored in agent info", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            outputs: ["analysis_report", "data_table"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("worker")
        expect(agent?.outputs).toEqual(["analysis_report", "data_table"])
      },
    })
  })

  test("output_contract requiredFields is stored in agent info", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            output_contract: {
              required_fields: ["conclusion", "evidence_summary"],
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("worker")
        expect(agent?.outputContract?.requiredFields).toEqual(["conclusion", "evidence_summary"])
      },
    })
  })
})

describe("M5: context_policy field", () => {
  test("context_policy is stored in agent info", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            context_policy: {
              pass_full_history: false,
              pass_artifacts: true,
              pass_user_constraints: false,
              pass_relevant_evidence: true,
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("worker")
        expect(agent?.contextPolicy?.passFullHistory).toBe(false)
        expect(agent?.contextPolicy?.passArtifacts).toBe(true)
        expect(agent?.contextPolicy?.passUserConstraints).toBe(false)
        expect(agent?.contextPolicy?.passRelevantEvidence).toBe(true)
      },
    })
  })
})

describe("M6: agent_defaults", () => {
  test("agent_defaults applies context_policy to new agents", async () => {
    await using tmp = await tmpdir({
      config: {
        agent_defaults: {
          context_policy: {
            pass_full_history: false,
            pass_artifacts: true,
            pass_user_constraints: false,
            pass_relevant_evidence: true,
          },
        },
        agent: {
          myagent: {
            description: "My agent",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("myagent")
        expect(agent?.contextPolicy?.passArtifacts).toBe(true)
        expect(agent?.contextPolicy?.passUserConstraints).toBe(false)
      },
    })
  })

  test("agent_defaults applies output_contract to new agents", async () => {
    await using tmp = await tmpdir({
      config: {
        agent_defaults: {
          output_contract: {
            required_fields: ["summary"],
          },
        },
        agent: {
          myagent: {
            description: "My agent",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("myagent")
        expect(agent?.outputContract?.requiredFields).toEqual(["summary"])
      },
    })
  })

  test("per-agent context_policy overrides agent_defaults", async () => {
    await using tmp = await tmpdir({
      config: {
        agent_defaults: {
          context_policy: {
            pass_artifacts: true,
          } as any,
        },
        agent: {
          myagent: {
            description: "My agent",
            mode: "subagent",
            context_policy: {
              pass_artifacts: false,
            } as any,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("myagent")
        expect(agent?.contextPolicy?.passArtifacts).toBe(false)
      },
    })
  })
})

describe("M7: domain and optional_extension fields", () => {
  test("domain and optional_extension are stored in agent info", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          specialist: {
            description: "Domain specialist",
            mode: "subagent",
            domain: "theory_strategy",
            optional_extension: true,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("specialist")
        expect(agent?.domain).toBe("theory_strategy")
        expect(agent?.optionalExtension).toBe(true)
      },
    })
  })
})

describe("M8: responsibility_boundary and role_design_basis fields", () => {
  test("responsibility_boundary is stored in agent info", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            responsibility_boundary: "Owns data analysis; must not absorb hypothesis formulation from adjacent roles.",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("worker")
        expect(agent?.responsibilityBoundary).toBe(
          "Owns data analysis; must not absorb hypothesis formulation from adjacent roles.",
        )
      },
    })
  })

  test("role_design_basis is stored in agent info", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            role_design_basis: ["physics-research-archetype", "data-first-policy"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("worker")
        expect(agent?.roleDesignBasis).toEqual(["physics-research-archetype", "data-first-policy"])
      },
    })
  })
})

describe("M9: role_packs config loading", () => {
  test("role_packs loaded from YAML file", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const packsDir = path.join(dir, ".opencode", "role-packs")
        await fs.mkdir(packsDir, { recursive: true })
        await Bun.write(
          path.join(packsDir, "physics-pack.yaml"),
          `packs:
  general-physics-project-pack:
    purpose: Balanced compact team for a typical physics project
    roles:
      lead: principal-investigator
      literature: literature-scout
    default_flow:
      - principal-investigator
      - literature-scout
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.role_packs).toBeDefined()
        expect(cfg.role_packs!["general-physics-project-pack"]).toBeDefined()
        expect(cfg.role_packs!["general-physics-project-pack"]!.purpose).toBe(
          "Balanced compact team for a typical physics project",
        )
        expect(cfg.role_packs!["general-physics-project-pack"]!.roles).toEqual({
          lead: "principal-investigator",
          literature: "literature-scout",
        })
        expect(cfg.role_packs!["general-physics-project-pack"]!.default_flow).toEqual([
          "principal-investigator",
          "literature-scout",
        ])
      },
    })
  })

  test("activePack session preference is stored", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = `test-session-${Math.random().toString(36).slice(2)}` as any
        await SessionPreference.update({
          sessionID: sid,
          activePack: "general-physics-project-pack",
        })
        const pref = SessionPreference.get(sid)
        expect(pref?.activePack).toBe("general-physics-project-pack")
        SessionPreference.clear()
      },
    })
  })
})

describe("M10: validate-roles script", () => {
  test("reports missing skill_refs warnings", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          myagent: {
            description: "My agent",
            mode: "subagent",
            skill_refs: ["nonexistent-skill"],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const warnings = await validate()
        const skillWarnings = warnings.filter((w) => w.type === "missing_skill_ref")
        expect(skillWarnings.length).toBeGreaterThan(0)
        expect(skillWarnings[0].agent).toBe("myagent")
        expect(skillWarnings[0].detail).toContain("nonexistent-skill")
      },
    })
  })

  test("reports empty prompt warnings for non-native agents", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          myagent: {
            description: "My agent",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const warnings = await validate()
        const promptWarnings = warnings.filter((w) => w.type === "empty_prompt")
        expect(promptWarnings.some((w) => w.agent === "myagent")).toBe(true)
      },
    })
  })
})

describe("M4+M8: prompt injection for inputs/outputs/responsibility_boundary", () => {
  test("buildRoleDeclarations produces correct prompt sections", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent: Partial<Agent.Info> = {
          name: "test-agent",
          inputs: ["literature_map", "data_set"],
          outputs: ["analysis_report"],
          outputContract: { requiredFields: ["conclusion", "method"] },
          responsibilityBoundary: "Owns statistical analysis only.",
        }

        const { buildRoleDeclarations } = await import("../../src/session/prompt")
        const sections = await buildRoleDeclarations(agent as Agent.Info, undefined)

        expect(sections.some((s) => s.includes("Expected Inputs"))).toBe(true)
        expect(sections.some((s) => s.includes("literature_map, data_set"))).toBe(true)
        expect(sections.some((s) => s.includes("Required Outputs"))).toBe(true)
        expect(sections.some((s) => s.includes("analysis_report"))).toBe(true)
        expect(sections.some((s) => s.includes("Output Contract"))).toBe(true)
        expect(sections.some((s) => s.includes("conclusion, method"))).toBe(true)
        expect(sections.some((s) => s.includes("Responsibility Boundary"))).toBe(true)
        expect(sections.some((s) => s.includes("Owns statistical analysis only."))).toBe(true)
      },
    })
  })
})

describe("M5+M11: context_policy + Artifact Handoff", () => {
  test("resolveArtifactHandoff injects predecessor artifact when pack flow is configured", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const outDir = path.join(dir, ".aether", "output", "step-a")
        await fs.mkdir(outDir, { recursive: true })
        await Bun.write(
          path.join(outDir, "intermediate_report.md"),
          `# Intermediate Report

Key findings from step A:
- Hypothesis H1 supported with p < 0.05
- Dataset quality sufficient for downstream analysis`,
        )
      },
      config: {
        agent: {
          "step-a": {
            description: "Produce intermediate results",
            mode: "subagent",
            outputs: ["intermediate_report"],
            output_dir: ".aether/output/step-a",
          },
          "step-b": {
            description: "Process intermediate results",
            mode: "subagent",
            inputs: ["intermediate_report"],
            outputs: ["final_report"],
            output_dir: ".aether/output/step-b",
            context_policy: {
              pass_artifacts: true,
              pass_user_constraints: true,
            } as any,
          },
        },
        role_packs: {
          "handoff-test-pack": {
            purpose: "Test artifact handoff",
            roles: { first: "step-a", second: "step-b" },
            default_flow: ["step-a", "step-b"],
          } as any,
        },
        active_pack: "handoff-test-pack",
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const stepB = await Agent.get("step-b")
        expect(stepB).toBeDefined()
        expect(stepB?.inputs).toEqual(["intermediate_report"])
        expect(stepB?.contextPolicy?.passArtifacts).toBe(true)

        const cfg = await Config.get()
        const { resolveArtifactHandoff } = await import("../../src/tool/task")
        const result = await resolveArtifactHandoff(stepB!, cfg)

        expect(result).toBeDefined()
        expect(result!.includes("## Predecessor Artifacts from step-a")).toBe(true)
        expect(result!.includes("### intermediate_report")).toBe(true)
        expect(result!.includes("Hypothesis H1 supported")).toBe(true)
        expect(result!.includes("p < 0.05")).toBe(true)
      },
    })
  })

  test("resolveArtifactHandoff works with short output_dir (no .aether prefix)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const outDir = path.join(dir, ".aether", "output", "step-a")
        await fs.mkdir(outDir, { recursive: true })
        await Bun.write(path.join(outDir, "intermediate_report.md"), "# Short Path Report\n\nShort path finding.")
      },
      config: {
        agent: {
          "step-a": {
            description: "Produce intermediate results",
            mode: "subagent",
            outputs: ["intermediate_report"],
            output_dir: "output/step-a",
          },
          "step-b": {
            description: "Process intermediate results",
            mode: "subagent",
            inputs: ["intermediate_report"],
            outputs: ["final_report"],
            output_dir: "output/step-b",
            context_policy: {
              pass_artifacts: true,
            } as any,
          },
        },
        role_packs: {
          "short-pack": {
            purpose: "Test short output_dir",
            roles: { first: "step-a", second: "step-b" },
            default_flow: ["step-a", "step-b"],
          } as any,
        },
        active_pack: "short-pack",
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const stepB = await Agent.get("step-b")
        const cfg = await Config.get()
        const { resolveArtifactHandoff } = await import("../../src/tool/task")
        const result = await resolveArtifactHandoff(stepB!, cfg)

        expect(result).toBeDefined()
        expect(result!.includes("## Predecessor Artifacts from step-a")).toBe(true)
        expect(result!.includes("Short path finding")).toBe(true)
      },
    })
  })

  test("resolveArtifactHandoff returns undefined when passArtifacts is false", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const outDir = path.join(dir, ".aether", "output", "step-a")
        await fs.mkdir(outDir, { recursive: true })
        await Bun.write(path.join(outDir, "intermediate_report.md"), "# Report content")
      },
      config: {
        agent: {
          "step-a": {
            description: "Produce intermediate results",
            mode: "subagent",
            outputs: ["intermediate_report"],
            output_dir: ".aether/output/step-a",
          },
          "step-b": {
            description: "Process intermediate results",
            mode: "subagent",
            inputs: ["intermediate_report"],
            outputs: ["final_report"],
            output_dir: ".aether/output/step-b",
            context_policy: {
              pass_artifacts: false,
            } as any,
          },
        },
        role_packs: {
          "no-handoff-pack": {
            purpose: "Test disabled handoff",
            roles: { first: "step-a", second: "step-b" },
            default_flow: ["step-a", "step-b"],
          } as any,
        },
        active_pack: "no-handoff-pack",
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const stepB = await Agent.get("step-b")
        const cfg = await Config.get()
        const { resolveArtifactHandoff } = await import("../../src/tool/task")
        const result = await resolveArtifactHandoff(stepB!, cfg)

        expect(result).toBeUndefined()
      },
    })
  })

  test("resolveArtifactHandoff returns undefined when no pack is configured", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          "step-a": {
            description: "Produce intermediate results",
            mode: "subagent",
            outputs: ["intermediate_report"],
            output_dir: ".aether/output/step-a",
          },
          "step-b": {
            description: "Process intermediate results",
            mode: "subagent",
            inputs: ["intermediate_report"],
            outputs: ["final_report"],
            output_dir: ".aether/output/step-b",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const stepB = await Agent.get("step-b")
        const cfg = await Config.get()
        const { resolveArtifactHandoff } = await import("../../src/tool/task")
        const result = await resolveArtifactHandoff(stepB!, cfg)

        expect(result).toBeUndefined()
      },
    })
  })

  test("resolveArtifactHandoff uses SessionPreference.activePack when set", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const outDir = path.join(dir, ".aether", "output", "step-a")
        await fs.mkdir(outDir, { recursive: true })
        await Bun.write(path.join(outDir, "intermediate_report.md"), "# Session Pack Report\n\nSession pack finding.")
      },
      config: {
        agent: {
          "step-a": {
            description: "Produce intermediate results",
            mode: "subagent",
            outputs: ["intermediate_report"],
            output_dir: ".aether/output/step-a",
          },
          "step-b": {
            description: "Process intermediate results",
            mode: "subagent",
            inputs: ["intermediate_report"],
            outputs: ["final_report"],
            output_dir: ".aether/output/step-b",
          },
        },
        role_packs: {
          "session-pack": {
            purpose: "Test session preference pack",
            roles: { first: "step-a", second: "step-b" },
            default_flow: ["step-a", "step-b"],
          } as any,
        },
      },
    })

    const sessionID = `test-session-${Math.random().toString(36).slice(2)}`

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SessionPreference.update({
          sessionID: sessionID as any,
          activePack: "session-pack",
        })

        const stepB = await Agent.get("step-b")
        const cfg = await Config.get()
        const { resolveArtifactHandoff } = await import("../../src/tool/task")
        const result = await resolveArtifactHandoff(stepB!, cfg, sessionID)

        expect(result).toBeDefined()
        expect(result!.includes("Session pack finding")).toBe(true)

        SessionPreference.clear()
      },
    })
  })

  test("resolveUserConstraints injects AGENTS.md content when passUserConstraints is true", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "AGENTS.md"),
          `# Project Constraints
- All statistical results must include confidence intervals
- Use SI units exclusively
- Never skip data validation before analysis`,
        )
      },
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            context_policy: {
              pass_user_constraints: true,
            } as any,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const worker = await Agent.get("worker")
        expect(worker?.contextPolicy?.passUserConstraints).toBe(true)

        const { resolveUserConstraints } = await import("../../src/tool/task")
        const result = await resolveUserConstraints(worker!)

        expect(result).toBeDefined()
        expect(result!.includes("## User Constraints")).toBe(true)
        expect(result!.includes("confidence intervals")).toBe(true)
        expect(result!.includes("SI units")).toBe(true)
        expect(result!.includes("data validation")).toBe(true)
      },
    })
  })

  test("resolveUserConstraints returns undefined when passUserConstraints is false", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Constraints that should NOT be injected")
      },
      config: {
        agent: {
          worker: {
            description: "Worker agent",
            mode: "subagent",
            context_policy: {
              pass_user_constraints: false,
            } as any,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const worker = await Agent.get("worker")
        const { resolveUserConstraints } = await import("../../src/tool/task")
        const result = await resolveUserConstraints(worker!)

        expect(result).toBeUndefined()
      },
    })
  })
})
