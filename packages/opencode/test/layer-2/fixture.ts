import { afterEach } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import type { Config } from "../../src/config/config"

afterEach(async () => {
  await Instance.disposeAll()
})

export function evalPerm(agent: Agent.Info, permission: string, pattern = "*"): Permission.Action | undefined {
  return Permission.evaluate(permission, pattern, agent.permission).action
}

export type PermValue = "allow" | "deny" | "ask"

export function makeResearchConfig(): Config.Agent {
  const permission: Record<string, PermValue> = {
    "*": "deny",
    grep: "allow",
    glob: "allow",
    list: "allow",
    read: "allow",
    edit: "allow",
    write: "allow",
    bash: "allow",
    webfetch: "allow",
    websearch: "allow",
    knowledge_search: "allow",
    question: "allow",
    todowrite: "allow",
    task: "allow",
    skill: "allow",
    external_directory: "ask",
  }
  permission["research_conventions_*"] = "allow"
  permission["research_state_*"] = "allow"
  return {
    description: "Research mode — deep search, analysis, and verification",
    color: "#7C3AED",
    mode: "primary",
    permission,
    fallback_models: ["anthropic/claude-sonnet-4-5"],
    mcp: { "research-conventions": true, "research-state": true },
    env_scope: { allowed_commands: ["uv", "curl", "rg", "grep", "git"] },
  }
}

export function makeResearchExplorerConfig(): Config.Agent {
  return {
    description:
      "Gather primary evidence across papers, web sources, repos, and local artifacts with integrity constraints",
    color: "#2563EB",
    mode: "subagent",
    permission: {
      "*": "deny",
      grep: "allow",
      glob: "allow",
      list: "allow",
      bash: "allow",
      webfetch: "allow",
      websearch: "allow",
      codesearch: "allow",
      read: "allow",
      external_directory: "ask",
    },
    fallback_models: ["anthropic/claude-sonnet-4-5"],
    mcp: { "research-state": true },
  }
}

export function makeResearchVerifierConfig(): Config.Agent {
  const permission: Record<string, PermValue> = {
    "*": "deny",
    grep: "allow",
    glob: "allow",
    list: "allow",
    read: "allow",
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
    skill: "allow",
    external_directory: "ask",
  }
  permission["research_conventions_*"] = "allow"
  permission["research_state_*"] = "allow"
  return {
    description: "General research verification",
    color: "#DC2626",
    mode: "subagent",
    permission,
    mcp: { "research-conventions": true, "research-state": true },
  }
}

export function makeGpdVerifierConfig(): Config.Agent {
  const permission: Record<string, PermValue> = {
    "*": "deny",
    grep: "allow",
    glob: "allow",
    list: "allow",
    read: "allow",
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
    skill: "allow",
    external_directory: "ask",
  }
  permission["research_conventions_*"] = "allow"
  permission["research_state_*"] = "allow"
  return {
    description: "Physics verification with deterministic SymPy computation",
    color: "#DC2626",
    mode: "subagent",
    permission,
    mcp: { "research-conventions": true, "research-state": true },
  }
}

export function makeGpdReviewerConfig(): Config.Agent {
  return {
    description: "Physics peer review",
    color: "#9333EA",
    mode: "subagent",
    permission: {
      "*": "deny",
      grep: "allow",
      glob: "allow",
      list: "allow",
      read: "allow",
      bash: "allow",
      skill: "allow",
      webfetch: "allow",
      websearch: "allow",
      codesearch: "allow",
      external_directory: "ask",
    },
    mcp: { "research-conventions": true, "research-state": true },
  }
}
