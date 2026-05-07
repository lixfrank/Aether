import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const researchMdPath = path.join(rootDir, ".aether/agent/research.md")
const dockerSkillPath = path.join(rootDir, ".opencode/skills/docker/SKILL.md")

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

const researchRaw = fs.readFileSync(researchMdPath, "utf-8")
const researchFm = parseFrontmatter(researchRaw)
const researchPrompt = getPromptAppend(researchFm)

const dockerRaw = fs.readFileSync(dockerSkillPath, "utf-8")
const dockerFm = parseFrontmatter(dockerRaw)
const dockerBody = dockerRaw.slice(dockerRaw.indexOf("---", 3) + 3).trim()

test("research.md permission section has bash: allow", () => {
  const bashLine = researchFm.match(/^\s*bash:\s*(\S+)/m)
  expect(bashLine, "Must have bash permission field").toBeTruthy()
  expect(bashLine![1], "bash must be 'allow' (not 'deny')").toBe("allow")
})

test("research.md env_scope.allowed_commands contains all 6 commands", () => {
  const cmdSection = researchFm.match(/allowed_commands:\s*\n((\s+- .+\n?)+)/)
  expect(cmdSection, "Must have allowed_commands section").toBeTruthy()
  const cmds = cmdSection![1]
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^\s+-\s*/, "").trim())
  expect(cmds, "allowed_commands must match expected set").toEqual(["alpha", "curl", "rg", "grep", "git", "docker"])
})

test("research.md FORBIDDEN section does NOT contain 'bash — execute any shell command'", () => {
  const forbiddenMatch = researchPrompt.match(/FORBIDDEN[\s\S]*?(?=##|$)/)
  expect(forbiddenMatch, "Must have FORBIDDEN section").toBeTruthy()
  expect(
    !forbiddenMatch![0].includes("bash — execute any shell command"),
    "Must NOT have old blanket bash denial",
  ).toBe(true)
})

test("research.md FORBIDDEN section DOES contain 'bash commands not in allowed_commands'", () => {
  const forbiddenMatch = researchPrompt.match(/FORBIDDEN[\s\S]*?(?=##|$)/)
  expect(forbiddenMatch, "Must have FORBIDDEN section").toBeTruthy()
  expect(
    forbiddenMatch![0].includes("bash commands not in allowed_commands"),
    "Must have scoped bash denial referencing allowed_commands",
  ).toBe(true)
})

test("research.md FORBIDDEN section lists the 6 allowed commands", () => {
  const forbiddenMatch = researchPrompt.match(/FORBIDDEN[\s\S]*?(?=##|$)/)
  expect(forbiddenMatch, "Must have FORBIDDEN section").toBeTruthy()
  const forbiddenBlock = forbiddenMatch![0]
  for (const cmd of ["alpha", "curl", "rg", "grep", "git", "docker"]) {
    expect(forbiddenBlock.includes(cmd), `FORBIDDEN section must list '${cmd}'`).toBe(true)
  }
})

test("docker/SKILL.md has proper YAML frontmatter with name and description", () => {
  expect(dockerFm.match(/^name:\s*docker/m), "Must have name field").toBeTruthy()
  expect(dockerFm.match(/^description:/m), "Must have description field").toBeTruthy()
})

test("docker/SKILL.md contains GPU support section (--gpus all)", () => {
  expect(dockerBody.includes("--gpus all"), "Must have --gpus all for GPU support").toBe(true)
})

test("docker/SKILL.md contains persistent containers section (docker create, docker exec)", () => {
  expect(dockerBody.includes("docker create"), "Must have docker create").toBe(true)
  expect(dockerBody.includes("docker exec"), "Must have docker exec").toBe(true)
})

test("docker/SKILL.md contains base image selection guide with 6 research types", () => {
  expect(dockerBody.includes("## Choosing the base image"), "Must have base image section").toBe(true)
  const imageRows = dockerBody.match(/\|.*\|.*\|/g)
  const headerSeparatorIdx = imageRows?.findIndex((r) => r.match(/^\|[-\s|]+\|$/))
  const dataRows = imageRows?.filter((r, i) => i > (headerSeparatorIdx ?? 0) && !r.match(/^\|[-\s|]+\|$/))
  expect(dataRows?.length, "Must have 6 research type rows").toBe(6)
})

test("docker/SKILL.md contains network isolation (--network none)", () => {
  expect(dockerBody.includes("--network none"), "Must have --network none for isolation").toBe(true)
})

test("docker/SKILL.md contains cleanup instructions (docker stop && docker rm)", () => {
  expect(dockerBody.includes("docker stop"), "Must have docker stop").toBe(true)
  expect(dockerBody.includes("docker rm"), "Must have docker rm").toBe(true)
})

test("docker/SKILL.md contains 'When to use' section", () => {
  expect(dockerBody.includes("## When to use"), "Must have When to use section").toBe(true)
})
