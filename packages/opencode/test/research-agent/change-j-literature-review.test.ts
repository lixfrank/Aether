import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const skillDir = path.join(rootDir, ".opencode/skills/literature-review")
const skillMdPath = path.join(skillDir, "SKILL.md")
const skillRaw = fs.readFileSync(skillMdPath, "utf-8")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1]
}

function getBody(content: string) {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  if (!match) throw new Error("No body after frontmatter")
  return match[1].trim()
}

const fm = parseFrontmatter(skillRaw)
const body = getBody(skillRaw)
const lineCount = skillRaw.split("\n").length

const removedTools = ["gget", "bioservices", "datacommons-client", "scientific-schematics"]
const removedScripts = ["search_databases.py", "verify_citations.py", "generate_pdf.py"]

test("SKILL.md is ≤80 lines (lean routing skill)", () => {
  expect(lineCount, `SKILL.md has ${lineCount} lines, must be ≤80`).toBeLessThanOrEqual(80)
})

test("frontmatter name is literature-review", () => {
  const nameMatch = fm.match(/^name:\s*(.+)$/m)
  expect(nameMatch, "Must have name field").toBeTruthy()
  expect(nameMatch![1].trim()).toBe("literature-review")
})

test("frontmatter description contains 'systematic' and 'PICO' and 'PRISMA'", () => {
  const descMatch = fm.match(/^description:\s*(.+)$/m)
  expect(descMatch, "Must have description field").toBeTruthy()
  const desc = descMatch![1].trim()
  expect(desc.includes("systematic"), "description must contain 'systematic'").toBe(true)
  expect(desc.includes("PICO"), "description must contain 'PICO'").toBe(true)
  expect(desc.includes("PRISMA"), "description must contain 'PRISMA'").toBe(true)
})

test("frontmatter does NOT have allowed-tools field", () => {
  expect(fm.match(/^allowed-tools:/m), "Must NOT have allowed-tools field").toBeNull()
})

test("SKILL.md contains 'In Research Mode' section with Deep Tier workflow", () => {
  expect(body.includes("## In Research Mode"), "Must have 'In Research Mode' section").toBe(true)
  const researchSection = body.match(/## In Research Mode[\s\S]*?(?=## |\n$)/)
  expect(researchSection, "Research Mode section must have content").toBeTruthy()
  const phase0 = researchSection![0].includes("Phase 0")
  const phase6 = researchSection![0].includes("Phase 6") || researchSection![0].includes("7.")
  expect(phase0, "Must reference Phase 0 (Intent Gate)").toBe(true)
  expect(phase6, "Must have phases through at least 6/Deliver").toBe(true)
})

test("SKILL.md contains 'In Other Modes' section with 6-step inline workflow", () => {
  expect(body.includes("## In Other Modes"), "Must have 'In Other Modes' section").toBe(true)
  const otherSection = body.match(/## In Other Modes[\s\S]*?(?=## |\n$)/)
  expect(otherSection, "Other Modes section must have content").toBeTruthy()
  const steps = [...otherSection![0].matchAll(/^\d+\.\s/gm)]
  expect(steps.length, "Must have exactly 6 steps").toBe(6)
})

test("SKILL.md has Review Structure section with all 6 sub-items", () => {
  expect(body.includes("## Review Structure"), "Must have Review Structure section").toBe(true)
  expect(body.includes("Abstract"), "Must have Abstract").toBe(true)
  expect(body.includes("Introduction"), "Must have Introduction").toBe(true)
  expect(body.includes("Methods"), "Must have Methods").toBe(true)
  expect(body.includes("Results"), "Must have Results").toBe(true)
  expect(body.includes("Discussion"), "Must have Discussion").toBe(true)
  expect(body.includes("References"), "Must have References").toBe(true)
})

test("SKILL.md has Source Quality section with 3 tiers", () => {
  expect(body.includes("## Source Quality"), "Must have Source Quality section").toBe(true)
  expect(body.includes("Prefer"), "Must have Prefer tier").toBe(true)
  expect(body.includes("Accept with caveats"), "Must have 'Accept with caveats' tier").toBe(true)
  expect(body.includes("Reject"), "Must have Reject tier").toBe(true)
})

test("SKILL.md does NOT reference removed tools (gget, bioservices, datacommons-client, scientific-schematics)", () => {
  for (const tool of removedTools) {
    expect(!skillRaw.includes(tool), `Must NOT reference '${tool}'`).toBe(true)
  }
})

test("SKILL.md does NOT reference removed scripts (search_databases.py, verify_citations.py, generate_pdf.py)", () => {
  for (const script of removedScripts) {
    expect(!skillRaw.includes(script), `Must NOT reference '${script}'`).toBe(true)
  }
})

test("SKILL.md does NOT have mandatory figure generation requirement", () => {
  expect(!body.includes("generate figures"), "Must NOT require figure generation").toBe(true)
  expect(!body.includes("figure generation"), "Must NOT require figure generation").toBe(true)
  expect(!body.includes("mandatory figure"), "Must NOT require figure generation").toBe(true)
})

test("SKILL.md ends with 'End with a Sources section containing direct URLs'", () => {
  const lastLine = body
    .split("\n")
    .filter((l) => l.trim())
    .pop()!
  expect(
    lastLine.includes("End with a Sources section containing direct URLs"),
    "Last meaningful line must be the Sources instruction",
  ).toBe(true)
})

test("references/methodology.md exists and contains PICO, PRISMA, quality assessment", () => {
  const methodologyPath = path.join(skillDir, "references", "methodology.md")
  expect(fs.existsSync(methodologyPath), "references/methodology.md must exist").toBe(true)
  const methodology = fs.readFileSync(methodologyPath, "utf-8")
  expect(methodology.includes("PICO"), "methodology.md must contain PICO").toBe(true)
  expect(methodology.includes("PRISMA"), "methodology.md must contain PRISMA").toBe(true)
  expect(methodology.includes("Quality Assessment"), "methodology.md must contain quality assessment").toBe(true)
})

test("old scripts still exist in scripts/ but are NOT referenced in SKILL.md", () => {
  const scriptsDir = path.join(skillDir, "scripts")
  expect(fs.existsSync(scriptsDir), "scripts/ directory must still exist").toBe(true)
  for (const script of removedScripts) {
    expect(fs.existsSync(path.join(scriptsDir, script)), `scripts/${script} must still exist`).toBe(true)
    expect(!skillRaw.includes(script), `SKILL.md must NOT reference ${script}`).toBe(true)
  }
})
