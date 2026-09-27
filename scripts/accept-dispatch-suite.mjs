// One-shot acceptance run for add-dispatch-suite (task 6.5): clean-room
// re-verification — typecheck → full test suite → bundle → brand-new sandbox
// E2E smoke. Prints a per-stage summary and ONE final verdict line
// ("ACCEPTANCE PASS/FAIL"); exit code 0 only on PASS.
//
// Sandbox posture (dispatch-tdd-process §3): the smoke serve runs with a
// dedicated OPENCODE_CONFIG_DIR under a fresh temp sandbox dir, bound to a
// free port in 43930-43939; the sandbox dir is removed on exit. No user
// opencode config is ever read or written; keys are never echoed.
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const REPO = resolve(import.meta.dirname, "..")
const sandboxRoot = join(tmpdir(), `forge-accept-${Date.now()}`)
const stages = []
const verdictOf = (name, pass, detail = "") => {
  stages.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  return pass
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", shell: true, ...opts })

let ok = true
console.log(`[accept] repo: ${REPO}`)
console.log(`[accept] sandbox: ${sandboxRoot}`)

// --- Stage 1: typecheck ------------------------------------------------------
{
  const r = run("npx", ["tsc", "--noEmit"])
  ok &= verdictOf("typecheck (tsc --noEmit)", r.status === 0, r.status === 0 ? "0 errors" : (r.stdout + r.stderr).slice(0, 400))
}

// --- Stage 2: full test suite -------------------------------------------------
{
  const r = run("node", ["--test", "tests/*.test.mjs"])
  const m = (r.stdout + r.stderr).match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/)
  const pass = m ? Number(m[1]) : 0
  const fail = m ? Number(m[2]) : 1
  ok &= verdictOf("full test suite", r.status === 0 && fail === 0, `${pass} pass / ${fail} fail`)
}

// --- Stage 3: bundle ----------------------------------------------------------
{
  const r = run("bun", ["run", "bundle"])
  ok &= verdictOf("bundle (bun run bundle)", r.status === 0 && existsSync(join(REPO, "dist", "index.js")), r.status === 0 ? "dist/index.js rebuilt" : String(r.stderr).slice(0, 300))
}

// --- Stage 4: fresh sandbox E2E smoke ------------------------------------------
let serve = null
let port = 0
try {
  for (const p of [43934, 43935, 43936, 43937, 43938, 43939]) {
    const free = await new Promise((res) => {
      const probe = createServer()
      probe.once("error", () => res(false))
      probe.once("listening", () => probe.close(() => res(true)))
      probe.listen(p, "127.0.0.1")
    })
    if (free) { port = p; break }
  }
  if (!port) throw new Error("no free port in 43930-43939")
  const cfgDir = join(sandboxRoot, "config")
  const ws = join(sandboxRoot, "ws")
  mkdirSync(cfgDir, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const repoUrl = REPO.replaceAll("\\", "/")
  writeFileSync(join(cfgDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [["file://" + repoUrl, { dispatch: { timeoutMs: 60000, roster: [{ model: "opencode/ling-3.0-flash-fin-free", expose: ["low"], profiles: ["scout", "quick"] }] } }]],
    provider: { opencode: { models: { "ling-3.0-flash-fin-free": {} } } },
    permission: {},
  }, null, 2))

  serve = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: sandboxRoot,
    env: { ...process.env, OPENCODE_CONFIG_DIR: cfgDir },
    shell: true,
    stdio: "ignore",
    detached: true,
  })
  const base = `http://127.0.0.1:${port}`
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const res = await fetch(`${base}/project`)
      if (res.ok) { up = true; break }
    } catch {}
  }
  if (!up) throw new Error(`serve did not come up on ${base}`)
  console.log(`  serve up: ${base} (config dir ${cfgDir})`)

  const r = run("node", [join(REPO, "scripts", "dispatch-probe-g.mjs"), base, ws], { timeout: 600_000 })
  const out = r.stdout + r.stderr
  const m = out.match(/SMOKE-G (PASS|FAIL): (\d+)\/(\d+)/)
  const verdict = m ? m[1] : "FAIL"
  const detail = m ? `${m[2]}/${m[3]} assertions` : out.slice(-400)
  if (verdict !== "PASS") {
    for (const line of out.split("\n")) if (line.includes("FAIL ")) console.log("    " + line.trim().slice(0, 240))
  }
  ok &= verdictOf("sandbox E2E smoke (dispatch-probe-g)", verdict === "PASS" && r.status === 0, detail)
} catch (e) {
  ok &= verdictOf("sandbox E2E smoke (dispatch-probe-g)", false, String(e).slice(0, 400))
} finally {
  if (serve?.pid) {
    try { process.kill(-serve.pid) } catch {}
    try { spawnSync("taskkill", ["/PID", String(serve.pid), "/T", "/F"], { shell: true }) } catch {}
  }
  await new Promise((r) => setTimeout(r, 1500))
  try { rmSync(sandboxRoot, { recursive: true, force: true }) } catch {}
}

// --- Verdict -------------------------------------------------------------------
const passed = stages.filter((s) => s.pass).length
console.log(`\n[accept] stages: ${stages.map((s) => `${s.pass ? "PASS" : "FAIL"} ${s.name}`).join(" | ")}`)
console.log(`ACCEPTANCE ${ok ? "PASS" : "FAIL"}: ${passed}/${stages.length} stages`)
try { writeFileSync(join(REPO, "openspec", "changes", "add-dispatch-suite", "verify", "accept-run.json"), JSON.stringify({ ok, stages, at: new Date().toISOString() }, null, 2)) } catch {}
process.exit(ok ? 0 : 1)
