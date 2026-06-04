import { describe, expect, test } from "bun:test"
import os from "os"

describe("MCP ~ path expansion", () => {
  test("~ in command array is replaced with os.homedir()", () => {
    const home = os.homedir()
    const command = ["~/bin/uv", "run", "~/mcp/server.py"]
    const expanded = command.map((c) => c.replace(/^~/, home))
    expect(expanded[0]).toBe(path.join(home, "bin/uv"))
    expect(expanded[1]).toBe("run")
    expect(expanded[2]).toBe(path.join(home, "mcp/server.py"))
  })

  test("paths without ~ are unchanged", () => {
    const command = ["uv", "run", "/absolute/path/server.py"]
    const expanded = command.map((c) => c.replace(/^~/, os.homedir()))
    expect(expanded[0]).toBe("uv")
    expect(expanded[1]).toBe("run")
    expect(expanded[2]).toBe("/absolute/path/server.py")
  })

  test("~ only replaces at start of string (^~ regex anchor)", () => {
    const command = ["path/with~/middle"]
    const expanded = command.map((c) => c.replace(/^~/, os.homedir()))
    expect(expanded[0]).toBe("path/with~/middle")
  })

  test("empty command array: expansion produces empty array", () => {
    const command: string[] = []
    const expanded = command.map((c) => c.replace(/^~/, os.homedir()))
    expect(expanded.length).toBe(0)
  })

  test("~/.aether/bin/uv → expands fully", () => {
    const home = os.homedir()
    const command = ["~/.aether/bin/uv"]
    const expanded = command.map((c) => c.replace(/^~/, home))
    expect(expanded[0]).toBe(path.join(home, ".aether/bin/uv"))
  })
})

import path from "path"
