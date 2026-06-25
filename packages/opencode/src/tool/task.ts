import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { Permission } from "@/permission"
import { Provider } from "../provider/provider"
import { ProviderID, ModelID } from "../provider/schema"
import { APICallError } from "@ai-sdk/provider"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

async function promptWithFallback(input: {
  sessionID: SessionID
  messageID: MessageID
  model: { modelID: ModelID; providerID: ProviderID }
  agent: Agent.Info
  promptParts: SessionPrompt.PromptInput["parts"]
  fallbackModels: Agent.Info["fallbackModels"]
}) {
  type FallbackModel = NonNullable<Agent.Info["fallbackModels"]>[number]
  const resolveModelID = (fm: FallbackModel): { modelID: ModelID; providerID: ProviderID } => {
    const id = typeof fm === "string" ? fm : fm.model
    return Provider.parseModel(id)
  }
  const modelsToTry: { modelID: ModelID; providerID: ProviderID }[] = [
    input.model,
    ...(input.fallbackModels ?? []).map(resolveModelID),
  ].slice(0, 4)

  for (const m of modelsToTry) {
    try {
      return await SessionPrompt.prompt({
        messageID: input.messageID,
        sessionID: input.sessionID,
        model: { modelID: m.modelID, providerID: m.providerID },
        agent: input.agent.name,
        parts: input.promptParts,
      })
    } catch (e) {
      const isRetryable = (e as APICallError)?.isRetryable ?? false
      if (!isRetryable || m === modelsToTry[modelsToTry.length - 1]) throw e
    }
  }
  throw new Error("Unreachable")
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = agents.filter((a) => {
    if (a.owner && !caller?.owns?.includes(a.owner)) return false
    if (caller && Permission.evaluate("task", a.name, caller.permission).action === "deny") return false
    return true
  })
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const callerAgent = ctx.agent ? await Agent.get(ctx.agent) : undefined

      if (agent.owner && !callerAgent?.owns?.includes(agent.owner))
        throw new Error(
          `Agent "${agent.name}" belongs to domain "${agent.owner}", not dispatchable by "${ctx.agent ?? "(none)"}"`,
        )

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

      const sessionPermission = Permission.intersection(callerAgent?.permission ?? [], agent.permission)

      // v0.6.0 fallback: deny task/todowrite for agents without explicit rules.
      // Intersection only propagates existing deny rules — it doesn't create new ones.
      // Agents with broad "*: allow" (like general) have no task/todowrite deny,
      // but v0.6.0 explicitly denied these in session permission for all subagents.
      const sessionDenyRules = [
        ...(hasTodoWritePermission
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(hasTaskPermission ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
      ]

      const finalPermission = [
        ...sessionPermission,
        ...sessionDenyRules,
        ...(config.experimental?.primary_tools ?? []).map((t) => ({
          permission: t,
          pattern: "*",
          action: "deny" as const,
        })),
      ]

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: finalPermission,
        })
      })

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = MessageID.ascending()

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      // Single-track permission contract: finalPermission is set on the session
      // via Session.create above and is the authoritative source. Do NOT pass
      // `tools` to prompt here — PromptInput.tools is @deprecated and uses
      // overwrite (not merge) semantics in prompt.ts:189-192; passing it would
      // silently clobber the intersection-derived finalPermission. task.ts
      // intentionally keeps permission on the session so the intersection results
      // survive.
      const result = await promptWithFallback({
        sessionID: session.id,
        messageID,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent,
        promptParts,
        fallbackModels: agent.fallbackModels ?? [],
      })

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})
