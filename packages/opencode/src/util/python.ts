import fs from "fs/promises"
import os from "os"
import path from "path"
import { which } from "./which"

const AETHER_HOME = path.join(os.homedir(), ".aether")
const AETHER_BIN = path.join(AETHER_HOME, "bin")
const UV_BINARY = path.join(AETHER_BIN, process.platform === "win32" ? "uv.exe" : "uv")

const UV_RELEASES_URL = "https://github.com/astral-sh/uv/releases/latest/download"

function platformArchive(): { name: string; extract: (archive: Buffer, dest: string) => Promise<void> } | null {
  const arch = process.arch
  const plat = process.platform
  if (plat === "darwin" && arch === "arm64") {
    return { name: "uv-aarch64-apple-darwin.tar.gz", extract: extractTarGz }
  }
  if (plat === "darwin" && arch === "x64") {
    return { name: "uv-x86_64-apple-darwin.tar.gz", extract: extractTarGz }
  }
  if (plat === "linux" && arch === "x64") {
    return { name: "uv-x86_64-linux-musl.tar.gz", extract: extractTarGz }
  }
  if (plat === "linux" && arch === "arm64") {
    return { name: "uv-aarch64-linux-musl.tar.gz", extract: extractTarGz }
  }
  if (plat === "win32" && arch === "x64") {
    return { name: "uv-x86_64-windows-msvc.zip", extract: extractZip }
  }
  return null
}

async function extractTarGz(archive: Buffer, dest: string) {
  const tmpDir = path.join(dest, "..", "uv-extract-tmp")
  await fs.mkdir(tmpDir, { recursive: true })
  const archivePath = path.join(tmpDir, "uv.tar.gz")
  await fs.writeFile(archivePath, archive)
  const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", tmpDir], {
    stderr: "pipe",
    stdout: "pipe",
  })
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`tar extract failed: exit ${proc.exitCode}`)
  const extracted = await fs.readdir(tmpDir)
  const uvDir = extracted.find((f) => f.startsWith("uv-"))
  if (!uvDir) throw new Error("uv directory not found in archive")
  const src = path.join(tmpDir, process.platform === "win32" ? "uv.exe" : "uv")
  const srcInDir = path.join(tmpDir, uvDir, process.platform === "win32" ? "uv.exe" : "uv")
  const uvSrc = await fs
    .access(srcInDir)
    .then(() => srcInDir)
    .catch(() => src)
  await fs.mkdir(dest, { recursive: true })
  await fs.copyFile(uvSrc, path.join(dest, process.platform === "win32" ? "uv.exe" : "uv"))
  await fs.rm(tmpDir, { recursive: true, force: true })
}

async function extractZip(archive: Buffer, dest: string) {
  const tmpDir = path.join(dest, "..", "uv-extract-tmp")
  await fs.mkdir(tmpDir, { recursive: true })
  const archivePath = path.join(tmpDir, "uv.zip")
  await fs.writeFile(archivePath, archive)
  const proc = Bun.spawn(["unzip", "-o", archivePath, "-d", tmpDir], {
    stderr: "pipe",
    stdout: "pipe",
  })
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`unzip failed: exit ${proc.exitCode}`)
  await fs.mkdir(dest, { recursive: true })
  const extracted = await fs.readdir(tmpDir)
  const uvFile = extracted.find((f) => f === "uv.exe" || f.startsWith("uv-"))
  if (!uvFile) throw new Error("uv binary not found in archive")
  const src = path.join(tmpDir, uvFile, "uv.exe")
  const srcFlat = path.join(tmpDir, "uv.exe")
  const uvSrc = await fs
    .access(src)
    .then(() => src)
    .catch(() => srcFlat)
  await fs.copyFile(uvSrc, path.join(dest, "uv.exe"))
  await fs.rm(tmpDir, { recursive: true, force: true })
}

async function executable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findOrInstallUv(): Promise<string | null> {
  if (await executable(UV_BINARY)) return UV_BINARY
  const pathUv = which("uv")
  if (pathUv) return pathUv

  const platform = platformArchive()
  if (!platform) return null

  try {
    await fs.mkdir(AETHER_BIN, { recursive: true })
    const url = `${UV_RELEASES_URL}/${platform.name}`
    const response = await fetch(url)
    if (!response.ok) return null
    const archive = Buffer.from(await response.arrayBuffer())
    await platform.extract(archive, AETHER_BIN)
    if (await executable(UV_BINARY)) return UV_BINARY
    return null
  } catch {
    return null
  }
}

export function aetherHome(): string {
  return AETHER_HOME
}

export function aetherBin(): string {
  return AETHER_BIN
}

export function aetherMcp(): string {
  return path.join(AETHER_HOME, "mcp")
}

export { UV_BINARY }
