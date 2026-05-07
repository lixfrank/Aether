import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const researchMdPath = path.join(process.cwd(), "..", "..", ".aether/agent/research.md")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1]
}

function getPromptAppend(frontmatter: string) {
  const match = frontmatter.match(/prompt_append:\s*\|[\s\S]*$/)
  if (!match) throw new Error("No prompt_append found in frontmatter")
  const raw = match[0].replace(/^prompt_append:\s*\|\n/, "")
  const lines = raw.split("\n")
  const dedented = lines.map((l) => l.replace(/^  /, ""))
  return dedented.join("\n").trim()
}

const raw = fs.readFileSync(researchMdPath, "utf-8")
const frontmatter = parseFrontmatter(raw)
const promptAppend = getPromptAppend(frontmatter)

test("Phase 0 title is 'Intent Gate' (not 'Intent Gate + Scale Decision')", () => {
  const phase0Pattern = /###\s+Phase\s+0:\s+Intent\s+Gate/
  expect(phase0Pattern.test(promptAppend), "Phase 0 header must be 'Intent Gate' only").toBe(true)
  const wrongPattern = /###\s+Phase\s+0:\s+Intent\s+Gate\s+.*Scale/
  expect(wrongPattern.test(promptAppend), "Phase 0 header must NOT include 'Scale Decision'").toBe(false)
})

test("Intent classification table has a 'Tier' column with Lightweight and Deep values", () => {
  const tierColumn = /\|\s*Tier\s*\|/
  expect(tierColumn.test(promptAppend), "Table must have a 'Tier' column header").toBe(true)
  const lightweight = /\|\s*Lightweight\s*\|/
  expect(lightweight.test(promptAppend), "Table must contain 'Lightweight' tier values").toBe(true)
  const deep = /\|\s*Deep\s*\|/
  expect(deep.test(promptAppend), "Table must contain 'Deep' tier values").toBe(true)
})

test("Lightweight Tier section exists with 4 steps", () => {
  const section = /###\s+Lightweight\s+Tier/
  expect(section.test(promptAppend), "Must have 'Lightweight Tier' section header").toBe(true)
  const lwMatch = promptAppend.match(/###\s+Lightweight\s+Tier[\s\S]*?(?=###|Stop here|$)/)
  expect(lwMatch, "Lightweight Tier section must have content").toBeTruthy()
  const body = lwMatch![0]
  expect(body.includes("Search"), "Step 1: Search").toBe(true)
  expect(body.includes("Answer directly"), "Step 2: Answer directly").toBe(true)
  expect(body.includes("Update notepad"), "Step 3: Update notepad").toBe(true)
  expect(body.includes("Integrity Commandments still apply"), "Step 4: Integrity Commandments still apply").toBe(true)
})

test("'Stop here. Do not proceed to Deep Tier phases.' instruction exists after Lightweight Tier", () => {
  expect(
    promptAppend.includes("Stop here. Do not proceed to Deep Tier phases."),
    "Must have explicit stop instruction after Lightweight Tier",
  ).toBe(true)
})

test("Deep Tier section has Phase 1-6 #### headers", () => {
  for (const phase of ["Phase 1", "Phase 2", "Phase 3", "Phase 4", "Phase 5", "Phase 6"]) {
    const pattern = new RegExp(`####\\s+${phase}`)
    expect(pattern.test(promptAppend), `Deep Tier must have '${phase}' #### header`).toBe(true)
  }
})

test("Deep Tier references 'researcher subagents' in Phase 2 (not 'explore subagents')", () => {
  const phase2Match = promptAppend.match(/####\s+Phase\s+2[\s\S]*?(?=####\s+Phase\s+3)/)
  expect(phase2Match, "Phase 2 section must exist").toBeTruthy()
  expect(phase2Match![0].includes("researcher subagents"), "Phase 2 must reference 'researcher subagents'").toBe(true)
  expect(!phase2Match![0].includes("explore subagents"), "Phase 2 must NOT reference 'explore subagents'").toBe(true)
})

test("Only deep-research and literature-review require confirmation in Phase 1", () => {
  const phase1Match = promptAppend.match(/####\s+Phase\s+1[\s\S]*?(?=####\s+Phase\s+2)/)
  expect(phase1Match, "Phase 1 section must exist").toBeTruthy()
  const body = phase1Match![0]
  expect(
    body.includes("deep-research") && body.includes("confirmation"),
    "Phase 1 must mention deep-research requires confirmation",
  ).toBe(true)
  expect(
    body.includes("literature-review") && body.includes("confirmation"),
    "Phase 1 must mention literature-review requires confirmation",
  ).toBe(true)
  expect(
    !body.includes("knowledge-survey") || !body.match(/knowledge-survey.*confirmation/),
    "knowledge-survey must NOT be in the confirmation list",
  ).toBe(true)
})

test("Escape clause exists for reclassifying if topic is more complex", () => {
  expect(
    promptAppend.includes("more complex than initially assessed"),
    "Must have escape clause about reclassifying",
  ).toBe(true)
  expect(promptAppend.includes("reclassify"), "Escape clause must mention 'reclassify'").toBe(true)
})

test("NEVER spawn subagents instruction applies only to Lightweight intents", () => {
  const neverSpawnPattern = /NEVER\s+spawn\s+subagents\s+for\s+Lightweight\s+intents/
  expect(neverSpawnPattern.test(promptAppend), "'NEVER spawn subagents' must specify 'for Lightweight intents'").toBe(
    true,
  )
  const contextMatch = promptAppend.match(/NEVER\s+spawn\s+subagents[\s\S]*?(?=###|$)/)
  expect(contextMatch, "NEVER spawn instruction must have surrounding context").toBeTruthy()
  const ctx = contextMatch![0]
  expect(ctx.length < 200, "NEVER spawn instruction must be scoped narrowly (not blanket)").toBe(true)
})
