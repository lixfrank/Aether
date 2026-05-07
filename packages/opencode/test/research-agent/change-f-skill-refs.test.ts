import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const agentDir = path.join(rootDir, ".aether/agent")
const srcDir = path.join(process.cwd(), "src")

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
const researchRaw = fs.readFileSync(path.join(agentDir, "research.md"), "utf-8")
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
const researcherRaw = fs.readFileSync(path.join(agentDir, "researcher.md"), "utf-8")
const researcherFm = parseFrontmatter(researcherRaw)
const researcherRefs = extractYamlList(researcherFm, "skill_refs")

test("researcher.md skill_refs has exactly 2 entries", () => {
  expect(researcherRefs.length).toBe(2)
})

test("researcher.md skill_refs matches required list", () => {
  expect(researcherRefs).toEqual(["alpha-research", "arxiv-search"])
})

// 3. verifier and reviewer subagents have no skill_refs
// They are native subagents defined in agent.ts, not separate .md files
const agentSrc = fs.readFileSync(path.join(srcDir, "agent/agent.ts"), "utf-8")

test("verifier agent definition has no skillRefs", () => {
  const verifierBlock = agentSrc.match(/verifier:\s*\{[^}]*name:\s*"verifier"[^}]*\}/s)
  expect(verifierBlock).toBeTruthy()
  expect(verifierBlock![0].includes("skillRefs")).toBe(false)
})

test("reviewer agent definition has no skillRefs", () => {
  const reviewerBlock = agentSrc.match(/reviewer:\s*\{[^}]*name:\s*"reviewer"[^}]*\}/s)
  expect(reviewerBlock).toBeTruthy()
  expect(reviewerBlock![0].includes("skillRefs")).toBe(false)
})

test("no verifier.md or reviewer.md files in .aether/agent/", () => {
  expect(fs.existsSync(path.join(agentDir, "verifier.md"))).toBe(false)
  expect(fs.existsSync(path.join(agentDir, "reviewer.md"))).toBe(false)
})

// 4. skill filtering logic in skill/index.ts lines 1131-1134
const skillSrc = fs.readFileSync(path.join(srcDir, "skill/index.ts"), "utf-8")

test("skill available() checks agent.skillRefs?.length first", () => {
  expect(skillSrc.includes("agent.skillRefs?.length")).toBe(true)
})

test("skill available() creates Set from skillRefs for filtering", () => {
  expect(skillSrc.includes("new Set(agent.skillRefs)")).toBe(true)
})

test("skill available() filters by refs.has(skill.name) when skillRefs is set", () => {
  expect(skillSrc.includes("refs.has(skill.name)")).toBe(true)
})

test("skill available() falls back to Permission.evaluate when skillRefs is empty", () => {
  const fallback = skillSrc.match(
    /return list\.filter\(\(skill\) => Permission\.evaluate\("skill", skill\.name, agent\.permission\)/,
  )
  expect(fallback).toBeTruthy()
})

test("skill available() returns all permission-filtered skills when agent is null", () => {
  expect(skillSrc.includes("if (!agent) return list")).toBe(true)
})

// 5. build agent has no skill_refs (gets all permission-filtered skills)
test("build agent definition has no skillRefs", () => {
  const buildBlock = agentSrc.match(/build:\s*\{[\s\S]*?name:\s*"build"[\s\S]*?\}/)
  expect(buildBlock).toBeTruthy()
  expect(buildBlock![0].includes("skillRefs")).toBe(false)
})
