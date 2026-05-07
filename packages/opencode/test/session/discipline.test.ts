import { describe, expect, test } from "bun:test"
import {
  compileDiscipline,
  EnvScope as EnvScopeSchema,
  fromOverride,
  resolveEnvScope,
} from "../../src/session/discipline"
import { Permission } from "../../src/permission"

const DISC_FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]

describe("fromOverride", () => {
  test("single action creates wildcard pattern", () => {
    const result = fromOverride({ edit: ["allow"], bash: ["deny"] })
    expect(result).toEqual([
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
  })

  test("action with path patterns creates scoped rules only", () => {
    const result = fromOverride({ edit: ["allow", "src/**"] })
    expect(result).toEqual([{ permission: "edit", pattern: "src/**", action: "allow" }])
  })

  test("empty override produces empty ruleset", () => {
    const result = fromOverride({})
    expect(result).toEqual([])
  })

  test("multiple path patterns create multiple rules", () => {
    const result = fromOverride({ glob: ["allow", "src/**", "test/**"] })
    expect(result).toContainEqual({ permission: "glob", pattern: "src/**", action: "allow" })
    expect(result).toContainEqual({ permission: "glob", pattern: "test/**", action: "allow" })
  })

  test("invalid action value is skipped", () => {
    const result = fromOverride({ edit: ["maybe"], bash: ["deny"] })
    expect(result).toEqual([{ permission: "bash", pattern: "*", action: "deny" }])
  })

  test("ask action is valid", () => {
    const result = fromOverride({ bash: ["ask"] })
    expect(result).toEqual([{ permission: "bash", pattern: "*", action: "ask" }])
  })
})

describe("compileDiscipline", () => {
  test("permission_override compilation matches fromOverride behavior", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      permission_override: { edit: ["allow", "src/**"], bash: ["deny"] },
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)
    expect(result).toEqual([
      { permission: "edit", pattern: "src/**", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
  })

  test("file_scope compiles to blanket deny per tool then allow rules per scope pattern (deny-before-allow for findLast)", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/auth/**", "package.json"],
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)

    for (const tool of DISC_FILE_TOOLS) {
      const toolRules = result.filter((r) => r.permission === tool)
      expect(toolRules[0]).toEqual({ permission: tool, pattern: "*", action: "deny" })
      expect(toolRules.slice(1).map((r) => r.action)).toEqual(["allow", "allow"])
      expect(toolRules.slice(1).map((r) => r.pattern)).toEqual(["src/auth/**", "package.json"])
    }

    expect(result.length).toBe(DISC_FILE_TOOLS.length * 3)
  })

  test("file_scope single pattern produces one deny + one allow per tool (deny first)", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      file_scope: ["src/**"],
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)
    const readRules = result.filter((r) => r.permission === "read")
    expect(readRules).toEqual([
      { permission: "read", pattern: "*", action: "deny" },
      { permission: "read", pattern: "src/**", action: "allow" },
    ])
  })

  test("env_scope.allowed_commands compiles to bash blanket deny then allow rules per prefix (deny-before-allow)", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      env_scope: { allowed_commands: ["docker", "git"] },
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)
    expect(result).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "docker*", action: "allow" },
      { permission: "bash", pattern: "git*", action: "allow" },
    ])
  })

  test("env_scope.allowed_commands single prefix", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      env_scope: { allowed_commands: ["npm"] },
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)
    expect(result).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "npm*", action: "allow" },
    ])
  })

  test("combined permission_override + file_scope + env_scope", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      permission_override: { task: ["deny"], read: ["allow", "docs/**"] },
      file_scope: ["src/**"],
      env_scope: { allowed_commands: ["git"] },
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)

    expect(result).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "read", pattern: "docs/**", action: "allow" })

    expect(result).toContainEqual({ permission: "bash", pattern: "git*", action: "allow" })
    expect(result).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })

    for (const tool of DISC_FILE_TOOLS) {
      expect(result).toContainEqual({ permission: tool, pattern: "src/**", action: "allow" })
      expect(result).toContainEqual({ permission: tool, pattern: "*", action: "deny" })
    }
  })

  test("rule order: permission_override first, then file_scope (deny→allow), then env_scope (deny→allow)", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      permission_override: { bash: ["deny"] },
      file_scope: ["src/**"],
      env_scope: { allowed_commands: ["docker"] },
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)

    const overrideIdx = result.findIndex(
      (r) => r.permission === "bash" && r.action === "deny" && r.pattern === "*" && !DISC_FILE_TOOLS.includes("bash"),
    )
    const fileScopeDenyIdx = result.findIndex(
      (r) => r.permission === "read" && r.pattern === "*" && r.action === "deny",
    )
    const fileScopeAllowIdx = result.findIndex((r) => r.permission === "read" && r.pattern === "src/**")
    const envScopeDenyIdx = result.findIndex(
      (r) => r.permission === "bash" && r.pattern === "*" && r.action === "deny" && result.indexOf(r) > overrideIdx,
    )
    const envScopeAllowIdx = result.findIndex((r) => r.pattern === "docker*")

    expect(overrideIdx).toBeLessThan(fileScopeDenyIdx)
    expect(fileScopeDenyIdx).toBeLessThan(fileScopeAllowIdx)
    expect(fileScopeAllowIdx).toBeLessThan(envScopeDenyIdx)
    expect(envScopeDenyIdx).toBeLessThan(envScopeAllowIdx)
  })

  test("empty discipline produces empty ruleset", () => {
    const result = compileDiscipline({
      mode: "serial",
      delegation_depth: 0,
      timeout_seconds: 300,
      return_format: "text",
    })
    expect(result).toEqual([])
  })

  test("discipline with only env_scope but no allowed_commands produces empty env rules", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      env_scope: { path_prefix: ["/usr/local/bin"] },
      return_format: "text" as const,
    }
    const result = compileDiscipline(discipline)
    expect(result).toEqual([])
  })
})

describe("EnvScope schema parse", () => {
  test("parses full EnvScope config", () => {
    const parsed = EnvScopeSchema.parse({
      path_prefix: ["/usr/local/bin", "/opt/bin"],
      env_vars: { NODE_ENV: "production", HOME: "/tmp/agent" },
      npm_prefix: "/tmp/npm-global",
      allowed_commands: ["docker", "git"],
    })
    expect(parsed.path_prefix).toEqual(["/usr/local/bin", "/opt/bin"])
    expect(parsed.env_vars).toEqual({ NODE_ENV: "production", HOME: "/tmp/agent" })
    expect(parsed.npm_prefix).toBe("/tmp/npm-global")
    expect(parsed.allowed_commands).toEqual(["docker", "git"])
  })

  test("parses partial EnvScope with only allowed_commands", () => {
    const parsed = EnvScopeSchema.parse({ allowed_commands: ["npm"] })
    expect(parsed.path_prefix).toBeUndefined()
    expect(parsed.env_vars).toBeUndefined()
    expect(parsed.npm_prefix).toBeUndefined()
    expect(parsed.allowed_commands).toEqual(["npm"])
  })

  test("parses empty object as all-optional EnvScope", () => {
    const parsed = EnvScopeSchema.parse({})
    expect(parsed.path_prefix).toBeUndefined()
    expect(parsed.env_vars).toBeUndefined()
    expect(parsed.npm_prefix).toBeUndefined()
    expect(parsed.allowed_commands).toBeUndefined()
  })
})

describe("resolveEnvScope merge", () => {
  test("discipline overrides agent path_prefix and npm_prefix; env_vars merge with discipline winning same keys", () => {
    const agentEnv = { path_prefix: ["/usr/bin"], env_vars: { A: "1", B: "2" }, npm_prefix: "/home/npm" }
    const discEnv = { path_prefix: ["/opt/bin"], env_vars: { B: "3", C: "4" }, npm_prefix: "/tmp/npm" }
    const result = resolveEnvScope(agentEnv, discEnv)
    expect(result!.path_prefix).toEqual(["/opt/bin"])
    expect(result!.npm_prefix).toBe("/tmp/npm")
    expect(result!.env_vars).toEqual({ A: "1", B: "3", C: "4" })
  })

  test("agent defaults apply when discipline has no env_scope", () => {
    const agentEnv = { path_prefix: ["/usr/bin"], env_vars: { X: "10" }, npm_prefix: "/home/npm" }
    const result = resolveEnvScope(agentEnv, undefined)
    expect(result).toEqual(agentEnv)
  })

  test("discipline applies when agent has no env_scope", () => {
    const discEnv = { allowed_commands: ["docker"], env_vars: { Y: "20" } }
    const result = resolveEnvScope(undefined, discEnv)
    expect(result!.env_vars).toEqual({ Y: "20" })
    expect(result!.allowed_commands).toEqual(["docker"])
  })

  test("both undefined returns undefined", () => {
    expect(resolveEnvScope(undefined, undefined)).toBeUndefined()
  })

  test("env_vars undefined on both sides yields empty object (spread semantics)", () => {
    const agentEnv = { path_prefix: ["/usr/bin"] }
    const discEnv = { npm_prefix: "/tmp/npm" }
    const result = resolveEnvScope(agentEnv, discEnv)
    expect(result!.path_prefix).toEqual(["/usr/bin"])
    expect(result!.npm_prefix).toBe("/tmp/npm")
    expect(result!.env_vars).toEqual({})
  })
})

describe("allowed_commands denied/allowed via compiled Rules", () => {
  test("allowed command is allowed, disallowed command is denied", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      env_scope: { allowed_commands: ["git", "docker"] },
      return_format: "text" as const,
    }
    const rules = compileDiscipline(discipline)
    const gitResult = Permission.evaluateWithCommand("bash", "", "git push origin main", rules)
    expect(gitResult.action).toBe("allow")
    const dockerResult = Permission.evaluateWithCommand("bash", "", "docker run -it ubuntu", rules)
    expect(dockerResult.action).toBe("allow")
    const npmResult = Permission.evaluateWithCommand("bash", "", "npm install", rules)
    expect(npmResult.action).toBe("deny")
    const curlResult = Permission.evaluateWithCommand("bash", "", "curl https://example.com", rules)
    expect(curlResult.action).toBe("deny")
  })

  test("single allowed_command denies all others", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      env_scope: { allowed_commands: ["bun"] },
      return_format: "text" as const,
    }
    const rules = compileDiscipline(discipline)
    expect(Permission.evaluateWithCommand("bash", "", "bun test", rules).action).toBe("allow")
    expect(Permission.evaluateWithCommand("bash", "", "npm test", rules).action).toBe("deny")
    expect(Permission.evaluateWithCommand("bash", "", "rm -rf /", rules).action).toBe("deny")
  })

  test("no allowed_commands leaves bash unrestricted by env_scope rules", () => {
    const discipline = {
      mode: "serial" as const,
      delegation_depth: 0,
      timeout_seconds: 300,
      env_scope: { path_prefix: ["/usr/bin"] },
      return_format: "text" as const,
    }
    const rules = compileDiscipline(discipline)
    expect(rules).toEqual([])
  })
})
