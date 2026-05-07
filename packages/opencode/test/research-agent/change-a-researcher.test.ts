import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const researcherMdPath = path.join(rootDir, ".aether/agent/researcher.md")
const researchMdPath = path.join(rootDir, ".aether/agent/research.md")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1]
}

function getPromptAppend(frontmatter: string) {
  const startIdx = frontmatter.indexOf("prompt_append: |")
  if (startIdx === -1) throw new Error("No prompt_append found in frontmatter")
  const afterHeader = frontmatter.indexOf("\n", startIdx) + 1
  const remaining = frontmatter.slice(afterHeader)
  const nextKeyMatch = remaining.match(/^(\S+):/m)
  const endIdx = nextKeyMatch ? nextKeyMatch.index! : remaining.length
  const raw = remaining.slice(0, endIdx)
  const lines = raw.split("\n")
  const dedented = lines.map((l) => l.replace(/^  /, ""))
  return dedented.join("\n").trim()
}

const researcherRaw = fs.readFileSync(researcherMdPath, "utf-8")
const researcherFm = parseFrontmatter(researcherRaw)
const researcherPrompt = getPromptAppend(researcherFm)

const researchRaw = fs.readFileSync(researchMdPath, "utf-8")
const researchFm = parseFrontmatter(researchRaw)
const researchPrompt = getPromptAppend(researchFm)

const integrityCommandments = [
  "Never fabricate a source",
  "Never claim a project exists without checking",
  "Never extrapolate details you haven't read",
  "URL or it didn't happen",
  "Read before you summarize",
  "Mark status honestly",
]

test("researcher.md frontmatter has description", () => {
  expect(researcherFm.match(/^description:/), "Must have description field").toBeTruthy()
})

test("researcher.md mode is subagent", () => {
  const modeMatch = researcherFm.match(/^mode:\s*(.+)$/m)
  expect(modeMatch, "Must have mode field").toBeTruthy()
  expect(modeMatch![1].trim(), "mode must be 'subagent'").toBe("subagent")
})

test("researcher.md base_agent is explore", () => {
  const baseMatch = researcherFm.match(/^base_agent:\s*(.+)$/m)
  expect(baseMatch, "Must have base_agent field").toBeTruthy()
  expect(baseMatch![1].trim(), "base_agent must be 'explore'").toBe("explore")
})

test("researcher.md skill_refs contains exactly alpha-research and arxiv-search", () => {
  const skillSection = researcherFm.match(/skill_refs:\s*\n((\s+- .+\n)+)/)
  expect(skillSection, "Must have skill_refs section").toBeTruthy()
  const skills = skillSection![1]
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^\s+-\s*/, "").trim())
  expect(skills.length, "Must have exactly 2 skill_refs").toBe(2)
  expect(skills, "skill_refs must be alpha-research and arxiv-search").toEqual(["alpha-research", "arxiv-search"])
})

test("researcher.md env_scope.allowed_commands contains alpha, curl, rg, grep, git", () => {
  const cmdSection = researcherFm.match(/allowed_commands:\s*\n((\s+- .+\n?)+)/)
  expect(cmdSection, "Must have allowed_commands section").toBeTruthy()
  const cmds = cmdSection![1]
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^\s+-\s*/, "").trim())
  expect(cmds, "allowed_commands must match expected set").toEqual(["alpha", "curl", "rg", "grep", "git"])
})

test("researcher.md prompt_append contains all 6 Integrity Commandments", () => {
  for (const cmd of integrityCommandments) {
    expect(researcherPrompt.includes(cmd), `Must include commandment: ${cmd}`).toBe(true)
  }
})

test("researcher.md prompt_append contains Search Strategy section", () => {
  expect(researcherPrompt.includes("## Search Strategy"), "Must have Search Strategy section").toBe(true)
})

test("researcher.md prompt_append contains Source Quality section", () => {
  expect(researcherPrompt.includes("## Source Quality"), "Must have Source Quality section").toBe(true)
})

test("researcher.md prompt_append contains ML Recipe Mode section", () => {
  expect(researcherPrompt.includes("## ML Recipe Mode"), "Must have ML Recipe Mode section").toBe(true)
})

test("researcher.md prompt_append Output Format has Evidence Table, Findings, Sources, Coverage Status", () => {
  expect(researcherPrompt.includes("## Output Format"), "Must have Output Format section").toBe(true)
  expect(researcherPrompt.includes("### Evidence Table"), "Must have Evidence Table subsection").toBe(true)
  expect(researcherPrompt.includes("### Findings"), "Must have Findings subsection").toBe(true)
  expect(researcherPrompt.includes("### Sources"), "Must have Sources subsection").toBe(true)
  expect(researcherPrompt.includes("### Coverage Status"), "Must have Coverage Status subsection").toBe(true)
})

test("researcher.md prompt_append contains Context Hygiene section", () => {
  expect(researcherPrompt.includes("## Context Hygiene"), "Must have Context Hygiene section").toBe(true)
})

test("researcher.md prompt_append contains Output Contract section", () => {
  expect(researcherPrompt.includes("## Output Contract"), "Must have Output Contract section").toBe(true)
})

test("research.md: ALL 3 scale_decision rules have subagent_type: researcher", () => {
  const rulesSection = researchFm.match(
    /rules:\s*\n((\s+- .+\n|\s+condition:.*\n|\s+subagent_count:.*\n|\s+subagent_type:.*\n|\s+mode:.*\n)+)/,
  )
  expect(rulesSection, "Must have scale_decision rules").toBeTruthy()
  const typeLines = [...researchFm.matchAll(/subagent_type:\s*(\S+)/g)].map((m) => m[1])
  expect(typeLines.length, "Must have exactly 3 subagent_type entries").toBe(3)
  for (const t of typeLines) {
    expect(t, "Each subagent_type must be 'researcher'").toBe("researcher")
  }
})

test("research.md: Phase 2 references 'researcher subagents' not 'explore subagents'", () => {
  const phase2Match = researchPrompt.match(/####\s+Phase\s+2[\s\S]*?(?=####\s+Phase\s+3)/)
  expect(phase2Match, "Phase 2 section must exist").toBeTruthy()
  expect(phase2Match![0].includes("researcher subagents"), "Phase 2 must reference 'researcher subagents'").toBe(true)
  expect(!phase2Match![0].includes("explore subagents"), "Phase 2 must NOT reference 'explore subagents'").toBe(true)
})

test("research.md: HARD CONSTRAINTS references 'researcher' in task dispatch", () => {
  const hardMatch = researchPrompt.match(/HARD CONSTRAINTS[\s\S]*?(?=##|$)/)
  expect(hardMatch, "Must have HARD CONSTRAINTS section").toBeTruthy()
  const taskLine = hardMatch![0].match(/task\s*—\s*dispatch\s+(.+)/i)
  expect(taskLine, "Must have task dispatch line").toBeTruthy()
  expect(taskLine![1].includes("researcher"), "task dispatch must mention 'researcher'").toBe(true)
})

test("research.md: skill line references correct skills", () => {
  const skillLine = researchPrompt.match(/skill\s*—\s*invoke\s+(.+)/i)
  expect(skillLine, "Must have skill line").toBeTruthy()
  const skills = skillLine![1]
  expect(skills.includes("alpha-research"), "Must mention alpha-research skill").toBe(true)
  expect(skills.includes("arxiv-search"), "Must mention arxiv-search skill").toBe(true)
})
