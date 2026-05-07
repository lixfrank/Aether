import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const agentDir = path.join(rootDir, ".aether/agent")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1]
}

function extractYamlList(yaml: string, key: string): string[] {
  const block = yaml.match(new RegExp(`^${key}:\\n((?:  - .+\\n)+)`, "m"))
  if (!block) return []
  return [...block[1].matchAll(/- (.+)/g)].map((m) => m[1].trim())
}

// ── Change F: Skill Isolation via skill_refs ──

// 1. research.md skill_refs
const researchPath = path.join(agentDir, "research.md")
const researchRaw = fs.readFileSync(researchPath, "utf-8")
const researchFm = parseFrontmatter(researchRaw)
const researchRefs = extractYamlList(researchFm, "skill_refs")

const requiredResearchRefs = [
  "alpha-research",
  "arxiv-search",
  "source-comparison",
  "paper-code-audit",
  "literature-review",
  "docker",
  "autoresearch",
  "replication",
]

test("research.md skill_refs has exactly 8 entries", () => {
  expect(researchRefs.length).toBe(8)
})

test("research.md skill_refs matches required list", () => {
  expect(researchRefs).toEqual(requiredResearchRefs)
})

// 2. researcher.md skill_refs
const researcherPath = path.join(agentDir, "researcher.md")
const researcherRaw = fs.readFileSync(researcherPath, "utf-8")
const researcherFm = parseFrontmatter(researcherRaw)
const researcherRefs = extractYamlList(researcherFm, "skill_refs")

const requiredResearcherRefs = ["alpha-research", "arxiv-search"]

test("researcher.md skill_refs has exactly 2 entries", () => {
  expect(researcherRefs.length).toBe(2)
})

test("researcher.md skill_refs matches required list", () => {
  expect(researcherRefs).toEqual(requiredResearcherRefs)
})

// 3. verifier.md and reviewer.md do NOT exist (native subagents)
test("verifier.md does not exist in .aether/agent/", () => {
  expect(fs.existsSync(path.join(agentDir, "verifier.md"))).toBe(false)
})

test("reviewer.md does not exist in .aether/agent/", () => {
  expect(fs.existsSync(path.join(agentDir, "reviewer.md"))).toBe(false)
})

// 4. skill filtering source code pattern
const skillSrc = fs.readFileSync(path.join(process.cwd(), "src/skill/index.ts"), "utf-8")

test("skill/index.ts checks skillRefs presence before filtering", () => {
  expect(skillSrc.includes("agent.skillRefs?.length")).toBe(true)
})

test("skill/index.ts uses Set for skill_refs lookup", () => {
  expect(skillSrc.includes("new Set(agent.skillRefs)")).toBe(true)
})

test("skill/index.ts filters by refs.has(skill.name) when skillRefs set", () => {
  expect(skillSrc.includes("refs.has(skill.name)")).toBe(true)
})

test("skill/index.ts falls back to Permission.evaluate when no skillRefs", () => {
  const fallback = skillSrc.match(
    /return list\.filter\(\(skill\) => Permission\.evaluate\("skill", skill\.name, agent\.permission\)/,
  )
  expect(fallback).toBeTruthy()
})
