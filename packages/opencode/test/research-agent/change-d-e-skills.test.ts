import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1]
}

function parseBody(content: string) {
  const secondDash = content.indexOf("---", 3)
  return content.slice(secondDash + 3).trim()
}

// ── Change D: source-comparison ──

const scPath = path.join(rootDir, ".opencode/skills/source-comparison/SKILL.md")
const scRaw = fs.readFileSync(scPath, "utf-8")
const scFm = parseFrontmatter(scRaw)
const scBody = parseBody(scRaw)

test("source-comparison SKILL.md exists", () => {
  expect(fs.existsSync(scPath)).toBe(true)
})

test("source-comparison frontmatter has name", () => {
  const m = scFm.match(/^name:\s*(.+)$/m)
  expect(m).toBeTruthy()
  expect(m![1].trim()).toBe("source-comparison")
})

test("source-comparison frontmatter has description", () => {
  const m = scFm.match(/^description:\s*(.+)$/m)
  expect(m).toBeTruthy()
  expect(m![1].includes("Compare")).toBe(true)
  expect(m![1].includes("comparison matrix")).toBe(true)
})

test("source-comparison has In Research Mode section with 6 steps", () => {
  const section = scBody.match(/## In Research Mode\s*\n([\s\S]*?)(?=## )/)
  expect(section).toBeTruthy()
  const steps = [...section![1].matchAll(/^\d+\.\s/gm)]
  expect(steps.length).toBe(6)
})

test("source-comparison Research Mode mentions researcher subagents", () => {
  const section = scBody.match(/## In Research Mode[\s\S]*?(?=## )/)
  expect(section).toBeTruthy()
  expect(section![0].includes("researcher subagents")).toBe(true)
})

test("source-comparison has In Other Modes section with 5 steps", () => {
  const section = scBody.match(/## In Other Modes\s*\n([\s\S]*?)(?=## )/)
  expect(section).toBeTruthy()
  const steps = [...section![1].matchAll(/^\d+\.\s/gm)]
  expect(steps.length).toBe(5)
})

test("source-comparison Other Modes mentions websearch/webfetch", () => {
  const section = scBody.match(/## In Other Modes[\s\S]*?(?=## )/)
  expect(section).toBeTruthy()
  expect(section![0].includes("websearch/webfetch")).toBe(true)
})

test("source-comparison has Comparison Matrix Format section", () => {
  expect(scBody.includes("## Comparison Matrix Format")).toBe(true)
})

test("source-comparison matrix table has required columns", () => {
  const tableHeader = scBody.match(/\| Source.*?\| Key Claim.*?\| Evidence Type.*?\| Caveats.*?\| Confidence.*?\|/)
  expect(tableHeader).toBeTruthy()
})

test("source-comparison mentions charts", () => {
  expect(scBody.includes("charts")).toBe(true)
})

test("source-comparison mentions Mermaid diagrams", () => {
  expect(scBody.includes("Mermaid")).toBe(true)
})

test("source-comparison ends with Sources section directive", () => {
  expect(scBody.includes("Sources section")).toBe(true)
  expect(scBody.includes("direct URLs")).toBe(true)
})

// ── Change E: paper-code-audit ──

const pcaPath = path.join(rootDir, ".opencode/skills/paper-code-audit/SKILL.md")
const pcaRaw = fs.readFileSync(pcaPath, "utf-8")
const pcaFm = parseFrontmatter(pcaRaw)
const pcaBody = parseBody(pcaRaw)

test("paper-code-audit SKILL.md exists", () => {
  expect(fs.existsSync(pcaPath)).toBe(true)
})

test("paper-code-audit frontmatter has name", () => {
  const m = pcaFm.match(/^name:\s*(.+)$/m)
  expect(m).toBeTruthy()
  expect(m![1].trim()).toBe("paper-code-audit")
})

test("paper-code-audit frontmatter has description", () => {
  const m = pcaFm.match(/^description:\s*(.+)$/m)
  expect(m).toBeTruthy()
  expect(m![1].includes("mismatches")).toBe(true)
  expect(m![1].includes("reproducibility")).toBe(true)
})

test("paper-code-audit has In Research Mode section with 7 steps", () => {
  const section = pcaBody.match(/## In Research Mode\s*\n([\s\S]*?)(?=## )/)
  expect(section).toBeTruthy()
  const steps = [...section![1].matchAll(/^\d+\.\s/gm)]
  expect(steps.length).toBe(7)
})

test("paper-code-audit has In Other Modes section with 4 steps", () => {
  const section = pcaBody.match(/## In Other Modes\s*\n([\s\S]*?)(?=## )/)
  expect(section).toBeTruthy()
  const steps = [...section![1].matchAll(/^\d+\.\s/gm)]
  expect(steps.length).toBe(4)
})

test("paper-code-audit has Audit Dimensions section", () => {
  expect(pcaBody.includes("## Audit Dimensions")).toBe(true)
})

test("paper-code-audit has all 6 audit dimensions", () => {
  const dims = [
    "Method match",
    "Default divergence",
    "Metric consistency",
    "Data handling",
    "Missing code",
    "Reproduction risk",
  ]
  const section = pcaBody.match(/## Audit Dimensions[\s\S]*?(?=##|$)/)
  expect(section).toBeTruthy()
  for (const d of dims) {
    expect(section![0].includes(d), `Must include dimension: ${d}`).toBe(true)
  }
})

test("paper-code-audit ends with Sources section directive", () => {
  expect(pcaBody.includes("Sources section")).toBe(true)
  expect(pcaBody.includes("paper URL")).toBe(true)
  expect(pcaBody.includes("repository URL")).toBe(true)
})
