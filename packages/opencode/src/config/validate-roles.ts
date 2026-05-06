import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Config } from "./config"
import { Log } from "../util/log"

const log = Log.create({ service: "validate-roles" })

export interface ValidationWarning {
  type: "missing_skill_ref" | "unknown_pack_role" | "flow_not_covered" | "empty_prompt"
  agent?: string
  pack?: string
  detail: string
}

export async function validate(): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []
  const cfg = await Config.get()
  const agents = await Agent.list()
  const allSkills = await Skill.all()
  const skillNames = new Set(allSkills.map((s) => s.name))
  const agentNames = new Set(agents.map((a) => a.name))
  const agentMap = new Map(agents.map((a) => [a.name, a]))

  for (const agent of agents) {
    if (agent.skillRefs?.length) {
      for (const ref of agent.skillRefs) {
        if (!skillNames.has(ref)) {
          warnings.push({
            type: "missing_skill_ref",
            agent: agent.name,
            detail: `skill "${ref}" not found in skill library`,
          })
        }
      }
    }

    if (!agent.prompt && !agent.native) {
      warnings.push({
        type: "empty_prompt",
        agent: agent.name,
        detail: `agent "${agent.name}" has no system prompt defined`,
      })
    }
  }

  if (cfg.role_packs) {
    for (const [packName, packDef] of Object.entries(cfg.role_packs)) {
      if (!packDef?.roles) continue

      for (const [alias, roleId] of Object.entries(packDef.roles as Record<string, string>)) {
        if (!agentNames.has(roleId)) {
          warnings.push({
            type: "unknown_pack_role",
            pack: packName,
            detail: `alias "${alias}" maps to unknown agent "${roleId}"`,
          })
        }
      }

      if (packDef.default_flow) {
        const roleValues = new Set(Object.values(packDef.roles as Record<string, string>))
        for (const roleId of packDef.default_flow) {
          if (!roleValues.has(roleId)) {
            warnings.push({
              type: "flow_not_covered",
              pack: packName,
              detail: `flow entry "${roleId}" not covered by pack roles`,
            })
          }
        }
      }
    }
  }

  for (const w of warnings) {
    log.warn("validation warning", w)
  }

  return warnings
}
