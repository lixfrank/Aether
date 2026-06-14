import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { Discipline } from "../../src/session/discipline"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("Discipline.compile — schema validation & edge cases", () => {
  test("Discipline.Schema validates max_steps range [1, 50]", () => {
    const valid = Discipline.Schema.safeParse({ max_steps: 25 })
    expect(valid.success).toBe(true)
    const tooLow = Discipline.Schema.safeParse({ max_steps: 0 })
    expect(tooLow.success).toBe(false)
    const tooHigh = Discipline.Schema.safeParse({ max_steps: 51 })
    expect(tooHigh.success).toBe(false)
  })

  test("Discipline.Schema validates delegation_depth range [0, 3]", () => {
    const valid0 = Discipline.Schema.safeParse({ delegation_depth: 0 })
    expect(valid0.success).toBe(true)
    const valid3 = Discipline.Schema.safeParse({ delegation_depth: 3 })
    expect(valid3.success).toBe(true)
    const tooLow = Discipline.Schema.safeParse({ delegation_depth: -1 })
    expect(tooLow.success).toBe(false)
    const tooHigh = Discipline.Schema.safeParse({ delegation_depth: 4 })
    expect(tooHigh.success).toBe(false)
  })

  test("Discipline.Schema validates timeout_seconds range [30, 600]", () => {
    const valid = Discipline.Schema.safeParse({ timeout_seconds: 120 })
    expect(valid.success).toBe(true)
    const tooLow = Discipline.Schema.safeParse({ timeout_seconds: 29 })
    expect(tooLow.success).toBe(false)
    const tooHigh = Discipline.Schema.safeParse({ timeout_seconds: 601 })
    expect(tooHigh.success).toBe(false)
  })

  test("Discipline.Schema validates return_format enum", () => {
    const text = Discipline.Schema.safeParse({ return_format: "text" })
    expect(text.success).toBe(true)
    const structured = Discipline.Schema.safeParse({ return_format: "structured" })
    expect(structured.success).toBe(true)
    const raw = Discipline.Schema.safeParse({ return_format: "raw" })
    expect(raw.success).toBe(true)
    const invalid = Discipline.Schema.safeParse({ return_format: "html" })
    expect(invalid.success).toBe(false)
  })

  test("Discipline.compile does not produce rules for max_steps, timeout_seconds, return_format", () => {
    const rules = Discipline.compile({
      max_steps: 10,
      timeout_seconds: 120,
      return_format: "structured",
    })
    expect(rules.length).toBe(0)
  })

  test("Discipline.compile delegation_depth: 1, 2, 3 do not deny task (only 0 does)", () => {
    const r1 = Discipline.compile({ delegation_depth: 1 })
    const r2 = Discipline.compile({ delegation_depth: 2 })
    const r3 = Discipline.compile({ delegation_depth: 3 })
    expect(r1.some((r) => r.permission === "task")).toBe(false)
    expect(r2.some((r) => r.permission === "task")).toBe(false)
    expect(r3.some((r) => r.permission === "task")).toBe(false)
  })

  test("Discipline.compile permission_override: null array value is skipped", () => {
    const rules = Discipline.compile({
      permission_override: { bash: undefined as any },
    })
    expect(rules.length).toBe(0)
  })

  test("Discipline.compile env_scope: empty allowed_commands produces bash deny-all only", () => {
    const rules = Discipline.compile({
      env_scope: { allowed_commands: [] },
    })
    expect(rules.length).toBe(1)
    expect(rules[0]).toEqual({ permission: "bash", pattern: "*", action: "deny" })
  })

  test("Discipline.compile file_scope: empty array denies all write tools with no allows", () => {
    const rules = Discipline.compile({
      file_scope: [],
    })
    const writeTools = ["edit", "write", "apply_patch", "multiedit"]
    for (const tool of writeTools) {
      expect(rules.some((r) => r.permission === tool && r.pattern === "*" && r.action === "deny")).toBe(true)
    }
    expect(rules.every((r) => r.action !== "allow")).toBe(true)
  })

  test("Discipline.compile file_scope: read/glob/grep are NOT in FILE_TOOLS set", () => {
    const rules = Discipline.compile({ file_scope: ["src/**"] })
    expect(rules.some((r) => r.permission === "read")).toBe(false)
    expect(rules.some((r) => r.permission === "glob")).toBe(false)
    expect(rules.some((r) => r.permission === "grep")).toBe(false)
  })

  test("Discipline.compile combined: all constraint types produce correct total rule count", () => {
    const rules = Discipline.compile({
      permission_override: { bash: ["allow"], edit: ["deny"] },
      env_scope: { allowed_commands: ["docker"] },
      file_scope: ["src/**"],
      delegation_depth: 0,
    })
    expect(rules.some((r) => r.permission === "bash" && r.pattern === "*" && r.action === "allow")).toBe(true)
    expect(rules.some((r) => r.permission === "edit" && r.pattern === "*" && r.action === "deny")).toBe(true)
    expect(rules.some((r) => r.permission === "bash" && r.pattern === "*" && r.action === "deny")).toBe(true)
    expect(rules.some((r) => r.permission === "bash" && r.pattern === "docker*" && r.action === "allow")).toBe(true)
    expect(rules.some((r) => r.permission === "edit" && r.pattern === "src/**" && r.action === "allow")).toBe(true)
    expect(rules.some((r) => r.permission === "task" && r.pattern === "*" && r.action === "deny")).toBe(true)
  })
})
