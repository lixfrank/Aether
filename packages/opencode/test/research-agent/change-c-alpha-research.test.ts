import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const skillPath = path.join(rootDir, ".opencode/skills/alpha-research/SKILL.md")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1]
}

const raw = fs.readFileSync(skillPath, "utf-8")
const fm = parseFrontmatter(raw)
const body = raw.slice(raw.indexOf("---", 3) + 3).trim()

test("SKILL.md file exists", () => {
  expect(fs.existsSync(skillPath), "alpha-research/SKILL.md must exist").toBe(true)
})

test("frontmatter has name: alpha-research", () => {
  const nameMatch = fm.match(/^name:\s*(.+)$/m)
  expect(nameMatch, "Must have name field").toBeTruthy()
  expect(nameMatch![1].trim()).toBe("alpha-research")
})

test("frontmatter description contains 'alpha CLI' and 'alphaXiv'", () => {
  const descMatch = fm.match(/^description:\s*(.+)$/m)
  expect(descMatch, "Must have description field").toBeTruthy()
  expect(descMatch![1].includes("alpha CLI"), "description must mention 'alpha CLI'").toBe(true)
  expect(descMatch![1].includes("alphaXiv"), "description must mention 'alphaXiv'").toBe(true)
})

test("Auth Check section exists and is marked CRITICAL", () => {
  expect(
    body.includes("## Auth Check (CRITICAL — do this FIRST)"),
    "Must have Auth Check section with CRITICAL marker",
  ).toBe(true)
})

test("Auth check instructs to run alpha status first", () => {
  expect(body.includes("alpha status"), "Auth check must instruct running 'alpha status'").toBe(true)
})

test("Contains explicit-decline-only fallback instruction", () => {
  expect(body.includes("Do NOT silently skip alpha"), "Must have 'Do NOT silently skip alpha' instruction").toBe(true)
})

test("Commands table has 8 entries", () => {
  const cmdRows = [...body.matchAll(/^\|\s*`alpha\s/gm)]
  expect(cmdRows.length, "Commands table must have exactly 8 entries").toBe(8)
})

test("Commands table contains all required commands", () => {
  const required = [
    "`alpha search",
    "`alpha get",
    "`alpha get --full-text",
    "`alpha ask",
    "`alpha code",
    "`alpha annotate",
    "`alpha annotate --clear",
    "`alpha annotate --list",
  ]
  for (const cmd of required) {
    expect(body.includes(cmd), `Must have command: ${cmd}`).toBe(true)
  }
})

test("Auth Setup section with alpha login", () => {
  expect(body.includes("## Auth Setup"), "Must have Auth Setup section").toBe(true)
  expect(body.includes("alpha login"), "Auth Setup must mention 'alpha login'").toBe(true)
})

test("Examples section has at least 5 commands", () => {
  const exampleBlock = body.match(/## Examples\s*\n```bash\n([\s\S]*?)```/)
  expect(exampleBlock, "Must have Examples section with bash block").toBeTruthy()
  const examples = exampleBlock![1].split("\n").filter((l) => l.trim().startsWith("alpha"))
  expect(examples.length, "Must have at least 5 example commands").toBeGreaterThanOrEqual(5)
})

test("When to use section has 3 items", () => {
  const wtuSection = body.match(/## When to use\s*\n((?:- .+\n?)+)/)
  expect(wtuSection, "Must have When to use section").toBeTruthy()
  const items = wtuSection![1].split("\n").filter((l) => l.trim().startsWith("-"))
  expect(items.length, "When to use must have exactly 3 items").toBe(3)
})

test("Fallback Behavior section lists arxiv-search skill", () => {
  expect(body.includes("## Fallback Behavior"), "Must have Fallback Behavior section").toBe(true)
  expect(body.includes("arxiv-search"), "Fallback must mention arxiv-search skill").toBe(true)
})

test("Fallback Behavior lists webfetch arxiv", () => {
  expect(body.includes("webfetch"), "Fallback must mention webfetch").toBe(true)
  expect(body.includes("arxiv.org/abs"), "Fallback must mention arxiv.org/abs").toBe(true)
})

test("Fallback Behavior lists webfetch html", () => {
  expect(body.includes("arxiv.org/html"), "Fallback must mention arxiv.org/html").toBe(true)
})

test("Fallback Behavior says Q&A NOT available", () => {
  const fallbackSection = body.match(/## Fallback Behavior[\s\S]*?(?=##|$)/)
  expect(fallbackSection, "Must have Fallback Behavior section").toBeTruthy()
  expect(fallbackSection![0].includes("NOT available"), "Must state Q&A NOT available").toBe(true)
})

test("Fallback Behavior says annotations NOT available", () => {
  const fallbackSection = body.match(/## Fallback Behavior[\s\S]*?(?=##|$)/)
  expect(fallbackSection, "Must have Fallback Behavior section").toBeTruthy()
  expect(
    fallbackSection![0].match(/annotations.*NOT available|NOT available.*annotations/i),
    "Must state annotations NOT available",
  ).toBeTruthy()
})
