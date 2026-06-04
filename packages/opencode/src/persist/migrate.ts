import fs from "fs/promises"
import os from "os"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { existsSync, statSync } from "fs"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { CFG, LEGACY_CFG, Persist, legacyPlatformDir, platformDir } from "./naming"
import { AETHER_HOME } from "@/util/python"

const log = Log.create({ service: "migrate" })

const MARK = "migration-v1.json"
const LOCK = ".migrate.lock"
const STALE = 1000 * 60 * 5

let user: Promise<void> | undefined
const project = new Map<string, Promise<void>>()

type Result = "copied" | "skipped"
type State = {
  copied: string[]
  skipped: string[]
}

async function stat(file: string) {
  return fs.stat(file).catch(() => undefined)
}

async function exists(file: string) {
  return !!(await stat(file))
}

function lock(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && ["EBUSY", "EPERM"].includes(String(err.code))
}

async function copy(src: string, dst: string) {
  if (process.platform !== "win32") {
    await fs.copyFile(src, dst)
    return
  }

  for (let n = 0; n < 10; n++) {
    try {
      await fs.copyFile(src, dst)
      return
    } catch (err) {
      if (!lock(err) || n >= 9) throw err
      Bun.gc(true)
      await sleep(100)
    }
  }
}

function aetherdb(name: string) {
  return /^aether.*\.db$/i.test(name)
}

function opencodedb(name: string) {
  return /^opencode.*\.db$/i.test(name)
}

function target() {
  const file = Flag.OPENCODE_DB
  if (!file || file === ":memory:") return "aether-prod.db"
  return path.basename(file)
}

async function atomic(src: string, dst: string) {
  if (!(await exists(src))) return "skipped" as const
  if (await exists(dst)) return "skipped" as const
  await fs.mkdir(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`
  await copy(src, tmp)
  await fs.rename(tmp, dst).catch(async (err) => {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  })
  return "copied" as const
}

async function atomicDir(src: string, dst: string) {
  if (!(await exists(src))) return "skipped" as const
  if (await exists(dst)) return "skipped" as const
  await fs.mkdir(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`
  await fs.cp(src, tmp, { recursive: true })
  await fs.rename(tmp, dst).catch(async (err) => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  })
  return "copied" as const
}

function push(state: State, file: string, result: Result) {
  const list = result === "copied" ? state.copied : state.skipped
  list.push(file)
}

async function copyFile(state: State, src: string, dst: string, label: string) {
  push(state, label, await atomic(src, dst))
}

async function copyDir(state: State, src: string, dst: string, label: string) {
  push(state, label, await atomicDir(src, dst))
}

async function copyDb(state: State) {
  const rows = await fs.readdir(Persist.legacy.data, { withFileTypes: true }).catch(() => [])
  const dbs = rows.filter((row) => row.isFile() && aetherdb(row.name)).map((row) => row.name)
  for (const name of dbs) {
    const src = path.join(Persist.legacy.data, name)
    const dst = path.join(Persist.current.data, name)
    await copyFile(state, src, dst, `data/${name}`)
    await copyFile(state, `${src}-wal`, `${dst}-wal`, `data/${name}-wal`)
    await copyFile(state, `${src}-shm`, `${dst}-shm`, `data/${name}-shm`)
  }
}

async function seedDb(state: State) {
  const rows = await fs.readdir(Persist.legacy.data, { withFileTypes: true }).catch(() => [])
  if (rows.some((row) => row.isFile() && aetherdb(row.name))) return

  const name = target()
  const dst = path.join(Persist.current.data, name)
  if (await exists(dst)) return

  const files = await Promise.all(
    rows
      .filter((row) => row.isFile() && opencodedb(row.name))
      .map(async (row) => {
        const file = path.join(Persist.legacy.data, row.name)
        return {
          name: row.name,
          file,
          time: (await stat(file))?.mtimeMs ?? 0,
        }
      }),
  )
  const pick = files.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name))[0]
  if (!pick) return

  await copyFile(state, pick.file, dst, `data/${name}`)
  await copyFile(state, `${pick.file}-wal`, `${dst}-wal`, `data/${name}-wal`)
  await copyFile(state, `${pick.file}-shm`, `${dst}-shm`, `data/${name}-shm`)
}

async function copyRoots(state: State) {
  await Promise.all([
    fs.mkdir(Persist.current.data, { recursive: true }),
    fs.mkdir(Persist.current.config, { recursive: true }),
    fs.mkdir(Persist.current.state, { recursive: true }),
  ])

  await copyDb(state)
  await seedDb(state)

  await Promise.all([
    copyFile(
      state,
      path.join(Persist.legacy.data, "auth.json"),
      path.join(Persist.current.data, "auth.json"),
      "data/auth.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.data, "mcp-auth.json"),
      path.join(Persist.current.data, "mcp-auth.json"),
      "data/mcp-auth.json",
    ),
    copyDir(
      state,
      path.join(Persist.legacy.data, "reading-mode"),
      path.join(Persist.current.data, "reading-mode"),
      "data/reading-mode",
    ),
    copyDir(
      state,
      path.join(Persist.legacy.data, "storage"),
      path.join(Persist.current.data, "storage"),
      "data/storage",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "config.json"),
      path.join(Persist.current.config, "config.json"),
      "config/config.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, `${LEGACY_CFG}.json`),
      path.join(Persist.current.config, `${CFG}.json`),
      `config/${CFG}.json`,
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, `${LEGACY_CFG}.jsonc`),
      path.join(Persist.current.config, `${CFG}.jsonc`),
      `config/${CFG}.jsonc`,
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "AGENTS.md"),
      path.join(Persist.current.config, "AGENTS.md"),
      "config/AGENTS.md",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "tui.json"),
      path.join(Persist.current.config, "tui.json"),
      "config/tui.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "tui.jsonc"),
      path.join(Persist.current.config, "tui.jsonc"),
      "config/tui.jsonc",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "model.json"),
      path.join(Persist.current.state, "model.json"),
      "state/model.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "kv.json"),
      path.join(Persist.current.state, "kv.json"),
      "state/kv.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "prompt-history.jsonl"),
      path.join(Persist.current.state, "prompt-history.jsonl"),
      "state/prompt-history.jsonl",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "prompt-stash.jsonl"),
      path.join(Persist.current.state, "prompt-stash.jsonl"),
      "state/prompt-stash.jsonl",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "frecency.jsonl"),
      path.join(Persist.current.state, "frecency.jsonl"),
      "state/frecency.jsonl",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "legacy-db.json"),
      path.join(Persist.current.state, "legacy-db.json"),
      "state/legacy-db.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "legacy-db-merge.json"),
      path.join(Persist.current.state, "legacy-db-merge.json"),
      "state/legacy-db-merge.json",
    ),
  ])
}

async function copySpecial(state: State) {
  await Promise.all([
    copyFile(
      state,
      path.join(legacyPlatformDir("wechat"), "session.json"),
      path.join(platformDir("wechat"), "session.json"),
      "wechat/session.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("wechat"), "accounts.json"),
      path.join(platformDir("wechat"), "accounts.json"),
      "wechat/accounts.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("feishu"), "config.json"),
      path.join(platformDir("feishu"), "config.json"),
      "feishu/config.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("feishu"), "sessions.json"),
      path.join(platformDir("feishu"), "sessions.json"),
      "feishu/sessions.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("feishu"), "hidden_projects.json"),
      path.join(platformDir("feishu"), "hidden_projects.json"),
      "feishu/hidden_projects.json",
    ),
    copyDir(state, legacyPlatformDir("wechat-bridge"), platformDir("wechat-bridge"), "wechat-bridge"),
  ])
}

async function writeMark(state: State) {
  await Filesystem.writeJson(path.join(Persist.current.state, MARK), {
    copied: state.copied,
    skipped: state.skipped,
    time: Date.now(),
  })
}

async function acquire(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  while (true) {
    try {
      const handle = await fs.open(file, "wx")
      await handle.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }))
      return handle
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err
      const info = await stat(file)
      if (info && Date.now() - info.mtimeMs > STALE) {
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      await sleep(100)
    }
  }
}

async function withLock<T>(fn: () => Promise<T>) {
  const file = path.join(path.dirname(Persist.current.state), LOCK)
  const handle = await acquire(file)
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

async function migrateUser() {
  return withLock(async () => {
    const state: State = { copied: [], skipped: [] }
    await copyRoots(state)
    await copySpecial(state)
    await writeMark(state)
  })
}

export async function ensureUser() {
  user ??= migrateUser()
  await user
}

async function migrateProject(dir: string) {
  const next = path.join(dir, ".aether", "skills")
  const prev = path.join(dir, ".opencode", "skills")
  if (await exists(next)) return
  if (!(await exists(prev))) return
  await atomicDir(prev, next)
}

export async function ensureProject(dir: string, stop: string) {
  const key = `${dir}:${stop}`
  const run = project.get(key)
  if (run) return run
  const task = (async () => {
    let cur = dir
    while (true) {
      await migrateProject(cur)
      if (cur === stop) break
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  })()
  project.set(key, task)
  await task.finally(() => {
    project.delete(key)
  })
}

export async function status() {
  return {
    current: Persist.current,
    legacy: Persist.legacy,
    marker: path.join(Persist.current.state, MARK),
    marker_exists: await exists(path.join(Persist.current.state, MARK)),
  }
}

export function reset() {
  user = undefined
  project.clear()
}

const SEED_STATE_FILE = "seed-state.json"
const LEGACY_SEED_FILE = "seed-version.txt"
const CURRENT_SEED_VERSION = "1"

type SeedState = {
  version: string
  seeded: string[]
}

function findServerProjectDir(): string | undefined {
  const binaryDir = path.dirname(process.execPath)
  for (const root of [".aether", ".opencode"]) {
    const candidate = path.join(binaryDir, root)
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {}
  }
  let dir = process.cwd()
  while (true) {
    for (const root of [".aether", ".opencode"]) {
      const candidate = path.join(dir, root)
      try {
        if (statSync(candidate).isDirectory()) return candidate
      } catch {}
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

async function readSeedState(): Promise<SeedState> {
  const statePath = path.join(AETHER_HOME, SEED_STATE_FILE)
  const state = await Filesystem.readJson<SeedState>(statePath).catch(() => undefined)
  if (state && Array.isArray(state.seeded)) return state
  await fs.rm(path.join(AETHER_HOME, LEGACY_SEED_FILE), { force: true }).catch(() => {})
  return { version: "", seeded: [] }
}

export async function seedDefaultAssets(): Promise<void> {
  const sourceDir = findServerProjectDir()
  if (!sourceDir) {
    log.info("no source .aether dir found, skipping seed")
    return
  }

  const state = await readSeedState()

  const subdirs = ["agent", "mcp"]
  const skillsDir = path.join(sourceDir, "skills")
  if (existsSync(skillsDir)) subdirs.push("skills")

  const toSeed: string[] = []
  for (const subdir of subdirs) {
    const src = path.join(sourceDir, subdir)
    if (!(await Filesystem.isDir(src))) continue
    const dest = path.join(AETHER_HOME, subdir)
    if (!state.seeded.includes(subdir) || !(await Filesystem.isDir(dest))) {
      toSeed.push(subdir)
    }
  }

  if (toSeed.length === 0 && state.version === CURRENT_SEED_VERSION) {
    log.info("default assets already seeded, skipping")
    return
  }

  for (const subdir of toSeed) {
    const src = path.join(sourceDir, subdir)
    const dest = path.join(AETHER_HOME, subdir)
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(src, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "package.json" ||
        entry.name === "bun.lock" ||
        entry.name === "node_modules"
      )
        continue
      const entrySrc = path.join(src, entry.name)
      const entryDest = path.join(dest, entry.name)
      if (await Filesystem.isDir(entryDest)) continue
      if (entry.isDirectory()) {
        await fs.cp(entrySrc, entryDest, { recursive: true })
      } else {
        await fs.copyFile(entrySrc, entryDest)
      }
    }
  }

  const newState: SeedState = {
    version: CURRENT_SEED_VERSION,
    seeded: [...new Set([...state.seeded, ...toSeed])],
  }
  await fs.mkdir(AETHER_HOME, { recursive: true })
  await Filesystem.writeJson(path.join(AETHER_HOME, SEED_STATE_FILE), newState)
  log.info(`default assets seeded to ~/.aether/ (subdirs: ${toSeed.join(", ")})`)
}
