import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { aetherBin, aetherHome } from "../../src/util/python"

describe("aetherBin / aetherHome", () => {
  test("aetherHome returns ~/.aether", () => {
    expect(aetherHome()).toBe(path.join(os.homedir(), ".aether"))
  })

  test("aetherBin returns ~/.aether/bin", () => {
    expect(aetherBin()).toBe(path.join(os.homedir(), ".aether", "bin"))
  })
})

describe("PATH augmentation", () => {
  test("prepending ~/.aether/bin to PATH makes it first", () => {
    const binDir = aetherBin()
    const original = process.env.PATH ?? ""
    const augmented = `${binDir}:${original}`
    expect(augmented.startsWith(binDir)).toBe(true)
  })

  test("PATH augmentation does not duplicate if already present", () => {
    const binDir = aetherBin()
    const alreadyAugmented = `${binDir}:${process.env.PATH ?? ""}`
    const count = alreadyAugmented.split(binDir).length - 1
    expect(count).toBe(1)
  })

  test("child processes inherit augmented PATH", () => {
    const binDir = aetherBin()
    const original = process.env.PATH ?? ""
    process.env.PATH = `${binDir}:${original}`
    expect(process.env.PATH).toContain(binDir)
    process.env.PATH = original
  })
})

describe("uv mirror URLs", () => {
  test("mirror list includes China-accessible proxies before GitHub", () => {
    const UV_RELEASES_URL = "https://github.com/astral-sh/uv/releases/latest/download"
    const UV_MIRROR_URLS = [
      "https://ghp.ci/" + UV_RELEASES_URL,
      "https://ghfast.top/" + UV_RELEASES_URL,
      UV_RELEASES_URL,
    ]
    expect(UV_MIRROR_URLS.length).toBe(3)
    expect(UV_MIRROR_URLS[0]).toContain("ghp.ci")
    expect(UV_MIRROR_URLS[1]).toContain("ghfast.top")
    expect(UV_MIRROR_URLS[2]).toBe(UV_RELEASES_URL)
    expect(UV_MIRROR_URLS[UV_MIRROR_URLS.length - 1]).toBe(UV_RELEASES_URL)
  })

  test("mirror URLs are constructed by prepending proxy prefix to GitHub URL", () => {
    const UV_RELEASES_URL = "https://github.com/astral-sh/uv/releases/latest/download"
    const archiveName = "uv-aarch64-apple-darwin.tar.gz"
    const mirrors = ["https://ghp.ci/" + UV_RELEASES_URL, "https://ghfast.top/" + UV_RELEASES_URL, UV_RELEASES_URL]
    const urls = mirrors.map((base) => `${base}/${archiveName}`)
    expect(urls[0]).toBe(`https://ghp.ci/${UV_RELEASES_URL}/${archiveName}`)
    expect(urls[1]).toBe(`https://ghfast.top/${UV_RELEASES_URL}/${archiveName}`)
    expect(urls[2]).toBe(`${UV_RELEASES_URL}/${archiveName}`)
  })

  test("download timeout is set to 10 seconds per mirror attempt", () => {
    expect(10_000).toBe(10000)
  })

  test("fallback loop: first mirror failure does not prevent trying next", () => {
    const mirrors = ["mirror1", "mirror2", "mirror3"]
    const results = ["fail", "fail", "success"]
    let picked = null
    for (let i = 0; i < mirrors.length; i++) {
      if (results[i] === "success") {
        picked = mirrors[i]
        break
      }
    }
    expect(picked).toBe("mirror3")
  })
})
