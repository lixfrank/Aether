import { test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const rootDir = path.join(process.cwd(), "..", "..")
const autoresearchPath = path.join(rootDir, ".opencode/skills/autoresearch/SKILL.md")
const replicationPath = path.join(rootDir, ".opencode/skills/replication/SKILL.md")
const researchMdPath = path.join(rootDir, ".aether/agent/research.md")

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error("No YAML frontmatter found")
  return match[1] + "\n"
}

function extractYamlValue(frontmatter: string, key: string) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
  return match ? match[1].trim() : undefined
}

function extractYamlList(frontmatter: string, key: string) {
  const match = frontmatter.match(new RegExp(`^${key}:\\n((\\s+- .+\\n)+)`, "m"))
  if (!match) return []
  return match[1]
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^\s+-\s*/, "").trim())
}

function getBody(content: string) {
  const idx = content.indexOf("\n---\n")
  if (idx === -1) throw new Error("No closing frontmatter fence")
  return content.slice(idx + 5).trim()
}

function extractSection(body: string, title: string) {
  const pattern = new RegExp(`##\\s+${title}[\\s\\S]*?(?=\\n##\\s|\\n#\\s|$)`)
  const match = body.match(pattern)
  return match ? match[0] : undefined
}

function extractWorkflowStep(workflow: string, stepName: string) {
  const pattern = new RegExp(`\\d+\\.\\s+\\*\\*${stepName}\\*\\*[\\s\\S]*?(?=\\n\\d+\\.\\s+\\*\\*|$)`)
  const match = workflow.match(pattern)
  return match ? match[0] : undefined
}

const autoresearchRaw = fs.readFileSync(autoresearchPath, "utf-8")
const autoresearchFm = parseFrontmatter(autoresearchRaw)
const autoresearchBody = getBody(autoresearchRaw)

const replicationRaw = fs.readFileSync(replicationPath, "utf-8")
const replicationFm = parseFrontmatter(replicationRaw)
const replicationBody = getBody(replicationRaw)

const researchRaw = fs.readFileSync(researchMdPath, "utf-8")
const researchFm = parseFrontmatter(researchRaw)

// --- Autoresearch tests (requirements 1-5) ---

test("autoresearch SKILL.md exists and has YAML frontmatter", () => {
  expect(fs.existsSync(autoresearchPath)).toBe(true)
  expect(autoresearchRaw.startsWith("---\n")).toBe(true)
})

test("autoresearch frontmatter name is 'autoresearch'", () => {
  expect(extractYamlValue(autoresearchFm, "name")).toBe("autoresearch")
})

test("autoresearch description contains 'experiment loop' and 'limited to planning'", () => {
  const desc = extractYamlValue(autoresearchFm, "description")!
  expect(desc.includes("experiment loop")).toBe(true)
  expect(desc.includes("limited to planning")).toBe(true)
})

test("autoresearch has 'Current Limitations' section mentioning missing tools", () => {
  const section = extractSection(autoresearchBody, "Current Limitations")
  expect(section, "Must have Current Limitations section").toBeDefined()
  expect(section!.includes("experiment management tools")).toBe(true)
  expect(section!.includes("init_experiment")).toBe(true)
  expect(section!.includes("run_experiment")).toBe(true)
  expect(section!.includes("log_experiment")).toBe(true)
})

test("autoresearch states automated edit→commit→run→log→keep/revert loops are NOT yet available", () => {
  expect(
    autoresearchBody.includes("Automated edit → commit → run → log → keep/revert loops are NOT yet available"),
  ).toBe(true)
})

test("autoresearch workflow has 5 steps: Gather, Environment, Plan, Execute, Report", () => {
  const workflow = extractSection(autoresearchBody, "Workflow")
  expect(workflow, "Must have Workflow section").toBeDefined()
  const names = ["Gather", "Environment", "Plan", "Execute", "Report"]
  for (const name of names) {
    const step = extractWorkflowStep(workflow!, name)
    expect(step, `Workflow must have '${name}' step`).toBeDefined()
  }
  const stepNumbers = workflow!.match(/\d+\.\s+\*\*\w+\*\*/g)
  expect(stepNumbers!.length, "Workflow must have exactly 5 steps").toBe(5)
})

test("autoresearch Environment step mentions Local, git branch, Docker, Plan only", () => {
  const workflow = extractSection(autoresearchBody, "Workflow")!
  const envStep = extractWorkflowStep(workflow, "Environment")!
  expect(envStep.includes("Local")).toBe(true)
  expect(envStep.includes("git branch")).toBe(true)
  expect(envStep.includes("Docker")).toBe(true)
  expect(envStep.includes("Plan only")).toBe(true)
})

// --- Replication tests (requirements 6-10) ---

test("replication SKILL.md exists and has YAML frontmatter", () => {
  expect(fs.existsSync(replicationPath)).toBe(true)
  expect(replicationRaw.startsWith("---\n")).toBe(true)
})

test("replication frontmatter name is 'replication'", () => {
  expect(extractYamlValue(replicationFm, "name")).toBe("replication")
})

test("replication description contains 'replication' and 'planning and partial execution'", () => {
  const desc = extractYamlValue(replicationFm, "description")!
  expect(desc.includes("replication")).toBe(true)
  expect(desc.includes("planning and partial execution")).toBe(true)
})

test("replication workflow has 6 steps: Extract, Recipe pass, Plan, Environment, Execute, Report", () => {
  const workflow = extractSection(replicationBody, "Workflow")
  expect(workflow, "Must have Workflow section").toBeDefined()
  const names = ["Extract", "Recipe pass", "Plan", "Environment", "Execute", "Report"]
  for (const name of names) {
    const step = extractWorkflowStep(workflow!, name)
    expect(step, `Workflow must have '${name}' step`).toBeDefined()
  }
  const stepNumbers = workflow!.match(/\d+\.\s+\*\*\w[\w\s]*?\*\*/g)
  expect(stepNumbers!.length, "Workflow must have exactly 6 steps").toBe(6)
})

test("replication Environment step mentions Local, Docker, Plan only (no git branch)", () => {
  const workflow = extractSection(replicationBody, "Workflow")!
  const envStep = extractWorkflowStep(workflow, "Environment")!
  expect(envStep.includes("Local")).toBe(true)
  expect(envStep.includes("Docker")).toBe(true)
  expect(envStep.includes("Plan only")).toBe(true)
  expect(envStep.includes("git branch")).toBe(false)
})

test("replication Execute step references docker skill and alpha code", () => {
  const workflow = extractSection(replicationBody, "Workflow")!
  const execStep = extractWorkflowStep(workflow, "Execute")!
  expect(execStep.toLowerCase().includes("docker skill")).toBe(true)
  expect(execStep.toLowerCase().includes("alpha code")).toBe(true)
})

test("replication Report step asks 'Did the replication succeed?'", () => {
  const workflow = extractSection(replicationBody, "Workflow")!
  const reportStep = extractWorkflowStep(workflow, "Report")!
  expect(reportStep.includes("Did the replication succeed")).toBe(true)
})

// --- research.md skill_refs test (requirement 11) ---

test("research.md skill_refs has 8 entries including autoresearch and replication", () => {
  const refs = extractYamlList(researchFm, "skill_refs")
  expect(refs.length, "skill_refs must have exactly 8 entries").toBe(8)
  expect(refs.includes("autoresearch")).toBe(true)
  expect(refs.includes("replication")).toBe(true)
})

test("research.md skill_refs contains all expected skills", () => {
  const refs = extractYamlList(researchFm, "skill_refs")
  const expected = [
    "alpha-research",
    "arxiv-search",
    "source-comparison",
    "paper-code-audit",
    "literature-review",
    "docker",
    "autoresearch",
    "replication",
  ]
  for (const skill of expected) {
    expect(refs.includes(skill), `skill_refs must include '${skill}'`).toBe(true)
  }
})
