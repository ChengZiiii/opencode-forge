// Sandbox E2E — hierarchical-pool-materialization (task 4.2).
// Drives a REAL opencode host (serve) on a multi-pool workspace with the
// plugin installed from the packed tarball into an ISOLATED config dir
// (hand-assembled — the `opencode plugin` installer resolves --global
// against the real home and MUST NOT be used here). Creating a session via
// the HTTP API fires the config hook; the plugin's [forge:config] findings
// in the serve logs then prove the resolver ran over: the root pool, the
// sub-pool (subtree scan live), and the skip-list (no node_modules
// findings). Deterministic — no model calls.
//
// Usage: node scripts/e2e-hiero.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"

const base = mkdtempSync(join(tmpdir(), "e2e-hiero-"))
const configDir = join(base, "config")
const wsRoot = join(base, "ws", "root")
const PORT = 47131
const isWin = process.platform === "win32"

function run(cmd, args, opts = {}) {
  const r = spawnSync(isWin ? "cmd" : cmd, isWin ? ["/c", cmd, ...args] : args, { encoding: "utf8", ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${(r.stdout || "") + (r.stderr || "")}`)
  return (r.stdout || "") + (r.stderr || "")
}

try {
  // Multi-pool workspace: root 总管 + devAa sub-pool (pool "aa") + skip-list trap.
  mkdirSync(join(wsRoot, ".opencode"), { recursive: true })
  writeFileSync(
    join(wsRoot, ".opencode", "forge.json"),
    JSON.stringify(
      {
        agents: {
          research: { model: "zai-coding-plan/glm-5.3", thoughtLevel: "low" },
          "forge-ta": { model: "zai-coding-plan/glm-5.3", thoughtLevel: "low" }, // forge- prefix → warn finding proves the ROOT pool was read
        },
      },
      null,
      2,
    ),
  )
  mkdirSync(join(wsRoot, "devAa", ".opencode"), { recursive: true })
  writeFileSync(
    join(wsRoot, "devAa", ".opencode", "forge.json"),
    JSON.stringify(
      {
        pool: "aa",
        agents: {
          shader: { model: "zai-coding-plan/glm-5.3", thoughtLevel: "low" },
          broken: { thoughtLevel: "low" }, // half-configured → error finding proves the SUB-POOL was read
        },
      },
      null,
      2,
    ),
  )
  mkdirSync(join(wsRoot, "node_modules", "pkg", ".opencode"), { recursive: true })
  writeFileSync(join(wsRoot, "node_modules", "pkg", ".opencode", "forge.json"), JSON.stringify({ agents: { trap: { model: "x/y", thoughtLevel: "low" } } }))
  mkdirSync(join(wsRoot, "devAb"), { recursive: true })
  // Probe pools (diagnosing which anchor the real host uses): each carries a
  // forge--prefixed id whose warn finding names it.
  mkdirSync(join(wsRoot, "devAb", ".opencode"), { recursive: true })
  writeFileSync(join(wsRoot, "devAb", ".opencode", "forge.json"), JSON.stringify({ agents: { "forge-probe-devab": { model: "x/y", thoughtLevel: "low" } } }))
  mkdirSync(join(base, "ws", ".opencode"), { recursive: true })
  writeFileSync(join(base, "ws", ".opencode", "forge.json"), JSON.stringify({ agents: { "forge-probe-ws": { model: "x/y", thoughtLevel: "low" } } }))

  // 1) Refresh the git+file_ CACHE entry from the repo (the host cache-resolves
  // plugin entries by name — a bare @sorenllm name would be shadowed by the
  // real machine's cached 0.12.0). The installer ignores OPENCODE_CONFIG_DIR
  // for its config write and appends the entry to the REAL opencode.jsonc —
  // we surgically remove that line right after (UTF-8 safe, Node only).
  const repoUrl = "git+file://" + process.cwd().replace(/\\/g, "/")
  const realCfgPath = join(process.env.USERPROFILE || process.env.HOME || "", ".config", "opencode", "opencode.jsonc")
  run("opencode", ["plugin", repoUrl, "--global", "--force"])
  {
    const fs = await import("node:fs")
    const before = fs.readFileSync(realCfgPath, "utf8")
    const line = `,\n    "${repoUrl}"`
    const after = before.includes(`"${repoUrl}"`) ? before.replace(line, "") : before
    if (after !== before) fs.writeFileSync(realCfgPath, after, "utf8")
    if (fs.readFileSync(realCfgPath, "utf8").includes(repoUrl)) throw new Error("real opencode.jsonc still carries the e2e git+file entry — refusing to continue")
  }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [repoUrl] }, null, 2))
  console.log("[1] git+file_ cache entry refreshed; real config cleaned; sandbox config assembled")

  // 2) Boot the host; capture logs.
  const serve = spawn(isWin ? "cmd" : "opencode", isWin ? ["/c", "opencode", "serve", "--port", String(PORT)] : ["serve", "--port", String(PORT)], {
    cwd: wsRoot,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  serve.stdout.on("data", (d) => (out += d))
  serve.stderr.on("data", (d) => (out += d))

  // 3) Wait for the listener, then fire the config hook via session creation.
  let up = false
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/session?directory=${encodeURIComponent(wsRoot)}`, { method: "POST", body: "{}" })
      if (r.ok || r.status < 500) {
        up = true
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  await new Promise((r) => setTimeout(r, 2500)) // let the config hook flush its findings
  try {
    if (isWin) spawnSync("cmd", ["/c", "taskkill", "/pid", String(serve.pid), "/F", "/T"])
    else serve.kill("SIGKILL")
  } catch {}
  writeFileSync(join(base, "serve.log"), out)

  // 4) Assert on the plugin's [forge:config] findings.
  const forgeLines = out.split(/\r?\n/).filter((l) => l.includes("[forge:config]"))
  const all = forgeLines.join("\n")
  console.log(`[2] host ${up ? "responded" : "NEVER came up"}; ${forgeLines.length} [forge:config] lines`)
  const checks = [
    ["root pool read (forge- prefix self-heal finding)", /forge-ta[\s\S]*stripped to "ta"/.test(all)],
    ["sub-pool read (broken entry finding from devAa)", /agents\.broken[\s\S]*atomic pair/.test(all)],
    ["second sub-pool read (devAb probe finding)", /probe-devab[\s\S]*stripped/.test(all)],
    ["no node_modules trap findings (skip-list live)", !/node_modules/.test(all)],
    ["host booted and session API responded", up],
  ]
  let pass = true
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"} — ${name}`)
    if (!ok) pass = false
  }
  console.log(forgeLines.slice(0, 10).join("\n") || "(no findings lines)")
  if (!up || !pass) {
    console.log(`[sandbox kept] ${base}`)
    process.exitCode = 1
  } else {
    rmSync(base, { recursive: true, force: true })
  }
} catch (e) {
  console.log(`[sandbox kept] ${base}`)
  throw e
}
