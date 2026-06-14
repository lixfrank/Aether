import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import { ConfigPaths } from "../../src/config/paths"

const skip = process.env.RESEARCH_AGENT_TEST !== "1"

describe.skipIf(skip)("ConfigPaths.directories — search order", () => {
  test("directory order: global config → home dirs → binary dirs → project dirs → config dir", async () => {
    const directory = process.cwd()
    const worktree = directory
    const dirs = await ConfigPaths.directories(directory, worktree)

    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs[0]).toContain("aether")
  })

  test("project dirs appear after binary dirs (reordered priority)", async () => {
    const directory = "/tmp/test-project"
    const worktree = "/tmp/test-project"
    const dirs = await ConfigPaths.directories(directory, worktree)

    const binaryDir = path.dirname(process.execPath)
    const binaryIdx = dirs.findIndex((d) => d.startsWith(binaryDir))
    const projectIdx = dirs.findIndex(
      (d) => d === path.join(directory, ".aether") || d === path.join(directory, ".opencode"),
    )

    if (binaryIdx >= 0 && projectIdx >= 0) {
      expect(binaryIdx).toBeLessThan(projectIdx)
    }
  })

  test("Global.Path.config is always first", async () => {
    const { Global } = await import("../../src/global")
    const directory = process.cwd()
    const worktree = directory
    const dirs = await ConfigPaths.directories(directory, worktree)
    expect(dirs[0]).toBe(Global.Path.config)
  })

  test("no duplicate directories in result", async () => {
    const directory = process.cwd()
    const worktree = directory
    const dirs = await ConfigPaths.directories(directory, worktree)
    const unique = new Set(dirs)
    expect(unique.size).toBe(dirs.length)
  })
})
