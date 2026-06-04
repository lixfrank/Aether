import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import path from "path"
import os from "os"

export async function AetherBinPlugin(_input: PluginInput): Promise<Hooks> {
  const aetherBin = path.join(os.homedir(), ".aether", "bin")
  return {
    "shell.env": async (_input, output) => {
      const currentPath = output.env.PATH ?? process.env.PATH ?? ""
      if (currentPath.includes(aetherBin)) return
      output.env.PATH = aetherBin + path.delimiter + currentPath
    },
  }
}
