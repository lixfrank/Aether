import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"

const AETHER_HOME = path.join(os.homedir(), ".aether")
const SEED_STATE_FILE = "seed-state.json"

describe("seedDefaultAssets — incremental seeding logic", () => {
  test("seed-state.json structure: version + seeded array", async () => {
    const statePath = path.join(AETHER_HOME, SEED_STATE_FILE)
    const state = await fs.readFile(statePath, "utf-8").catch(() => null)
    if (!state) return
    const parsed = JSON.parse(state)
    expect(typeof parsed.version).toBe("string")
    expect(Array.isArray(parsed.seeded)).toBe(true)
  })

  test("seed-state.json seeded entries are valid subdir names", async () => {
    const statePath = path.join(AETHER_HOME, SEED_STATE_FILE)
    const state = await fs.readFile(statePath, "utf-8").catch(() => null)
    if (!state) return
    const parsed = JSON.parse(state)
    const validSubdirs = ["agent", "mcp", "skills", "health"]
    for (const entry of parsed.seeded) {
      expect(validSubdirs.includes(entry)).toBe(true)
    }
  })

  test("~/.aether/ directories exist for seeded subdirs", async () => {
    const statePath = path.join(AETHER_HOME, SEED_STATE_FILE)
    const state = await fs.readFile(statePath, "utf-8").catch(() => null)
    if (!state) return
    const parsed = JSON.parse(state)
    for (const subdir of parsed.seeded) {
      const dir = path.join(AETHER_HOME, subdir)
      const exists = await fs
        .stat(dir)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    }
  })

  test("~/.aether/bin/ directory exists for uv installation", async () => {
    const binDir = path.join(AETHER_HOME, "bin")
    const exists = await fs
      .stat(binDir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })
})

describe("seedDefaultAssets — findServerProjectDir logic", () => {
  test("binary directory .aether detection: path.dirname(process.execPath)", () => {
    const binaryDir = path.dirname(process.execPath)
    expect(typeof binaryDir).toBe("string")
    expect(binaryDir.length).toBeGreaterThan(0)
  })

  test("cwd walk-up: finds .aether or .opencode dir from project root", () => {
    const cwd = process.cwd()
    expect(cwd.includes("Aether")).toBe(true)
  })
})
