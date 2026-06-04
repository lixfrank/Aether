import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import path from "path"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) return [PROMPT_CODEX]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_DEFAULT]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(agent: Agent.Info) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    if (agent.skillRefs?.length) {
      const loaded = await Promise.all(agent.skillRefs.map((name) => Skill.get(name)))
      const found = loaded.filter((s): s is Skill.Info => s !== undefined)
      const missing = agent.skillRefs.filter((name) => !loaded.find((s) => s?.name === name))
      return [
        "## Skills (mandatory)",
        "You MUST follow these skills' instructions for every task they cover.",
        "The following skills have been fully injected — do NOT use the skill tool to load them again.",
        ...found.map((s) => [`### Skill: ${s.name}`, s.content].join("\n")),
        ...(missing.length ? [`Note: skills ${missing.join(", ")} referenced but not found.`] : []),
      ].join("\n")
    }

    const list = await Skill.available(agent)
    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }

  function normalizeOutputDir(dir: string): string {
    const projectDir = Instance.worktree
    const clean = dir.replace(/^\.aether\/+/, "")
    return path.join(projectDir, ".aether", clean)
  }

  export function outputDir(agent: Agent.Info): string | undefined {
    if (!agent.outputDir) return undefined
    return `Your output directory is at ${normalizeOutputDir(agent.outputDir)}. Write findings to this directory.`
  }
}
