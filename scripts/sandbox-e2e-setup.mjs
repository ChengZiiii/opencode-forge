// Sandbox E2E bootstrap: fixed config dir + file:// plugin entry.
// Usage: node scripts/sandbox-e2e-setup.mjs
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const cfgDir = resolve("/tmp/forge-goal-e2e-config")
rmSync(cfgDir, { recursive: true, force: true })
mkdirSync(cfgDir, { recursive: true })
const repo = process.cwd().replaceAll("\\", "/")
const cfg = {
  $schema: "https://opencode.ai/config.json",
  plugin: [`file://${repo}`],
  permission: {},
}
writeFileSync(resolve(cfgDir, "opencode.json"), JSON.stringify(cfg, null, 2))
console.log(`sandbox config dir: ${cfgDir}`)
console.log(`plugin: file://${repo}`)
console.log(existsSync(resolve(cfgDir, "opencode.json")) ? "config written" : "FAILED")
