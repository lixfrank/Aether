import { test, expect } from "bun:test"
import fs from "fs"
import path from "path"

function mergeSkillRefs(base: string[], config: string[] | undefined): string[] {
  if (!config) return base
  const extras = config.filter((ref) => !base.includes(ref))
  return [...base, ...extras]
}

const agentSrc = fs.readFileSync(path.join(process.cwd(), "src/agent/agent.ts"), "utf-8")

test("no skill_refs in config → existing skillRefs unchanged", () => {
  expect(mergeSkillRefs(["alpha", "arxiv"], undefined)).toEqual(["alpha", "arxiv"])
})

test("config skill_refs with overlapping items → deduplicated", () => {
  expect(mergeSkillRefs(["alpha", "arxiv"], ["arxiv", "docker"])).toEqual(["alpha", "arxiv", "docker"])
})

test("config skill_refs with entirely new items → all appended", () => {
  expect(mergeSkillRefs(["alpha"], ["docker", "deep-research"])).toEqual(["alpha", "docker", "deep-research"])
})

test("empty base skillRefs + config skill_refs → config becomes the result", () => {
  expect(mergeSkillRefs([], ["arxiv", "docker"])).toEqual(["arxiv", "docker"])
})

test("config skill_refs identical to base → no duplicates", () => {
  expect(mergeSkillRefs(["alpha", "arxiv"], ["alpha", "arxiv"])).toEqual(["alpha", "arxiv"])
})

test("agent.ts uses append logic (not ?? replacement) for skill_refs", () => {
  expect(agentSrc.includes("if (value.skill_refs) {"), "must guard with value.skill_refs").toBe(true)
  expect(agentSrc.includes("const base = item.skillRefs ?? []"), "must capture base refs").toBe(true)
  expect(agentSrc.includes("const extras = value.skill_refs.filter"), "must filter extras not in base").toBe(true)
  expect(agentSrc.includes("!base.includes(ref)"), "must dedup by name").toBe(true)
  expect(agentSrc.includes("item.skillRefs = [...base, ...extras]"), "must append extras to base").toBe(true)
})

test("agent.ts does NOT use ?? for skill_refs assignment", () => {
  const badPattern = /item\.skillRefs\s*=\s*value\.skill_refs\s*\?\?/
  expect(badPattern.test(agentSrc), "must not use ?? replacement for skillRefs").toBe(false)
})
