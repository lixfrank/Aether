import z from "zod"

export const Provenance = z.object({
  topic: z.string(),
  date: z.string(),
  sources_consulted: z.number(),
  sources_accepted: z.array(z.object({ id: z.number(), url: z.string(), status: z.string() })),
  sources_rejected: z.array(z.object({ id: z.number(), url: z.string(), reason: z.string() })),
  verification: z.enum(["PASS", "PASS_WITH_NOTES", "BLOCKED"]),
  checks_performed: z.string().array(),
  issues: z.array(
    z.object({
      severity: z.enum(["FATAL", "MAJOR", "MINOR"]),
      description: z.string(),
      location: z.string().optional(),
    }),
  ),
})
export type Provenance = z.infer<typeof Provenance>
