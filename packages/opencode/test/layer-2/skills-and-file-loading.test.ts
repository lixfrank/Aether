import path from "path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

const projectRoot = path.resolve(__dirname, "../../../../.aether/skills")

describe.skipIf(skip)("Layer 2.1 — skill file existence", () => {
  test("T2.1.1: paper-search SKILL.md exists with arXiv mode design", async () => {
    const content = await Bun.file(path.join(projectRoot, "paper-search", "SKILL.md")).text()
    expect(content).toContain("name: paper-search")
    expect(content).toContain("arXiv Search")
    expect(content).toContain("arxiv_search.py")
    expect(content).not.toContain("category:")
  })

  test("T2.1.3: source-comparison SKILL.md exists with mode-aware design", async () => {
    const content = await Bun.file(path.join(projectRoot, "source-comparison", "SKILL.md")).text()
    expect(content).toContain("name: source-comparison")
    expect(content).toContain("In Research Mode")
    expect(content).toContain("In Other Modes")
    expect(content).not.toContain("category:")
  })

  test("T2.1.4: paper-code-audit SKILL.md exists with mode-aware design", async () => {
    const content = await Bun.file(path.join(projectRoot, "paper-code-audit", "SKILL.md")).text()
    expect(content).toContain("name: paper-code-audit")
    expect(content).toContain("Audit Dimensions")
    expect(content).toContain("In Research Mode")
    expect(content).not.toContain("category:")
  })

  test("T2.1.10: no category field in any ported skill frontmatter", async () => {
    const skillDirs = ["paper-search", "source-comparison", "paper-code-audit"]
    for (const dir of skillDirs) {
      const content = await Bun.file(path.join(projectRoot, dir, "SKILL.md")).text()
      expect(content).not.toContain("category:")
    }
  })
})

describe("Layer 2 — .aether/agent/ file loading", () => {
  test("research.md from .aether/agent/ creates primary agent with env_scope", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "agent")
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Research mode
color: "#7C3AED"
mode: primary
permission:
  "*": deny
  grep: allow
  glob: allow
  read: allow
  bash: allow
mcp:
  research-conventions: true
  research-state: true
env_scope:
  allowed_commands:
    - uv
    - curl
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
          const r = await Agent.get("research")
          expect(r?.mode).toBe("primary")
          expect(r?.mcp).toEqual({ "research-conventions": true, "research-state": true })
          expect(r?.prompt).toContain("Research Mode")
          expect(
            Permission.evaluate("bash", "uv run .aether/skills/paper-search/arxiv_search.py test", r!.permission)
              .action,
          ).toBe("allow")
          expect(Permission.evaluate("bash", "curl https://example.com", r!.permission).action).toBe("allow")
          expect(Permission.evaluate("bash", "rm -rf /", r!.permission).action).toBe("deny")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("research-explorer.md from .aether/agent/ creates subagent with Integrity Commandments", async () => {
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
          const e = await Agent.get("research-explorer")
          expect(e?.mode).toBe("subagent")
          expect(e?.prompt).toContain("Integrity Commandments")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("local-executor.md supports local_compile strategy", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "agent")
        await Bun.write(
          path.join(agentDir, "local-executor.md"),
          `---
description: Execute research tasks in local environment
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  read: allow
  bash: allow
mcp:
  research-conventions: true
fallback_models:
  - alibaba-cn/glm-5.1
---

# Local Executor
Supports uv_venv, local, local_compile strategies.
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
          const e = await Agent.get("local-executor")
          expect(e?.mode).toBe("subagent")
          expect(e?.prompt).toContain("local_compile")
          expect(e?.fallbackModels).toBeDefined()
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("removing .aether/agent/ files removes all research agents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Agent.list()
        const names = agents.map((a) => a.name)
        expect(names).not.toContain("research")
        expect(names).not.toContain("research-explorer")
        expect(names).not.toContain("sandbox-executor")
      },
    })
  })
})
