// One-shot acceptance run for add-dispatch-onboarding (task 5.3): clean-room
// re-verification — typecheck → full test suite → bundle → sandbox E2E
// (onboarding smoke on a fresh agents-path serve) → legacy inline-roster
// serve compatibility leg. Prints per-stage summaries and ONE final verdict
// line; exit code 0 only on PASS.
//
// Sandbox posture: dedicated OPENCODE_CONFIG_DIR + FORGE_TEST_FORGE_HOME under
// a fresh temp sandbox dir, ports in 43930-43939, sandbox removed on exit. No
// user opencode config is ever read or written; keys are never echoed.
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const REPO = resolve(import.meta.dirname, "..")
const sandboxRoot = join(tmpdir(), `forge-onboarding-accept-${Date.now()}`)
const stages = []
const verdictOf = (name, pass, detail = "") => {
  stages.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  return pass
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", shell: true, ...opts })

const freePort = async (candidates) => {
  for (const p of candidates) {
    const free = await new Promise((res) => {
      const probe = createServer()
      probe.once("error", () => res(false))
      probe.once("listening", () => probe.close(() => res(true)))
      probe.listen(p, "127.0.0.1")
    })
    if (free) return p
  }
  return 0
}

const startServe = async (port, cfgDir, cwd, extraEnv = {}) => {
  const serve = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd,
    // extraEnv rides the SERVE process (the plugin reads it there) — e.g.
    // FORGE_TEST_FORGE_HOME redirects the global forge.json path into the
    // sandbox so the cascade test never touches the real user home.
    env: { ...process.env, OPENCODE_CONFIG_DIR: cfgDir, ...extraEnv },
    shell: true,
    stdio: "ignore",
    detached: true,
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const res = await fetch(`${base}/project`)
      if (res.ok) return { serve, base }
    } catch {}
  }
  throw new Error(`serve did not come up on ${base}`)
}

const killServe = async (serve) => {
  if (!serve?.pid) return
  try { process.kill(-serve.pid) } catch {}
  try { spawnSync("taskkill", ["/PID", String(serve.pid), "/T", "/F"], { shell: true }) } catch {}
  await new Promise((r) => setTimeout(r, 1200))
}

let ok = true
console.log(`[accept] repo: ${REPO}`)
console.log(`[accept] sandbox: ${sandboxRoot}`)

// --- Stage 1-3: typecheck, suite, bundle --------------------------------------
{
  const r = run("npx", ["tsc", "--noEmit"])
  ok &= verdictOf("typecheck (tsc --noEmit)", r.status === 0, r.status === 0 ? "0 errors" : (r.stdout + r.stderr).slice(0, 400))
}
{
  const r = run("node", ["--test", "tests/*.test.mjs"])
  const m = (r.stdout + r.stderr).match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/)
  const pass = m ? Number(m[1]) : 0
  const fail = m ? Number(m[2]) : 1
  ok &= verdictOf("full test suite", r.status === 0 && fail === 0, `${pass} pass / ${fail} fail`)
}
{
  const r = run("npm", ["run", "bundle"])
  ok &= verdictOf("bundle (npm run bundle)", r.status === 0 && existsSync(join(REPO, "dist", "index.js")), r.status === 0 ? "dist/index.js rebuilt" : String(r.stderr).slice(0, 300))
}

// --- Stage 4: fresh sandbox E2E — onboarding story (two phases, restart between)
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const api = async (base, path, init) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}
const runPhase = async (phase, base, ws, home) => {
  const verifyDir = join(REPO, "openspec", "changes", "add-dispatch-onboarding", "verify")
  const env = { ...process.env, SMOKE_OUT: join(verifyDir, `smoke-phase${phase}.json`), PROBE_DEADLINE_MS: "180000" }
  const r = spawnSync("node", [join(REPO, "scripts", "dispatch-onboarding-smoke.mjs"), base, ws, home, phase], { cwd: REPO, encoding: "utf8", env, timeout: 900_000 })
  const out = r.stdout + r.stderr
  // Full driver log (turn texts, stall retries) goes to verify/ for diagnosis;
  // only FAIL/PASS lines echo to the acceptance console.
  try {
    mkdirSync(verifyDir, { recursive: true })
    writeFileSync(join(verifyDir, `smoke-phase${phase}.log`), out)
  } catch {}
  const m = out.match(new RegExp(`SMOKE-ONBOARDING-${phase} (PASS|FAIL): (\\d+)/(\\d+)`))
  if (!m || m[1] !== "PASS") {
    for (const line of out.split("\n")) if (line.includes("FAIL ") || line.startsWith("  PASS")) console.log("    " + line.trim().slice(0, 240))
  }
  return m ? { pass: m[1] === "PASS" && r.status === 0, detail: `${m[2]}/${m[3]} assertions` } : { pass: false, detail: out.slice(-400) }
}

// Minimal single-turn driver for the legacy leg.
const runTurn = async (base, sid, task, deadlineMs = 240_000) => {
  const before = (await api(base, `/session/${sid}/message`)).length
  api(base, `/session/${sid}/message`, { method: "POST", body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: task }] }) }).catch(() => {})
  const start = Date.now()
  let lastText = ""
  let lastSig = ""
  let stable = 0
  for (;;) {
    if (Date.now() - start > deadlineMs) break
    await new Promise((r) => setTimeout(r, 3000))
    let msgs = []
    try {
      msgs = await api(base, `/session/${sid}/message`)
    } catch {
      continue
    }
    const assistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
    const text = assistant ? (assistant.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n") : ""
    const runningTool = assistant ? (assistant.parts ?? []).some((p) => p.type === "tool" && p.state?.status !== "completed" && p.state?.status !== "error") : true
    const sig = `${msgs.length}|${text}`
    if (sig === lastSig && !runningTool) stable++
    else stable = 0
    lastSig = sig
    lastText = text
    if (stable >= 3 && msgs.length > before && !runningTool) break
  }
  return lastText
}

let serves = []
try {
  const cfgDir = join(sandboxRoot, "config")
  const home = join(sandboxRoot, "home")
  const ws = join(sandboxRoot, "ws")
  mkdirSync(cfgDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const repoUrl = REPO.replaceAll("\\", "/")
  // Agents-path serve: NO inline roster/tiers (the unconfigured seed state is
  // the starting point of the onboarding story).
  writeFileSync(join(cfgDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [["file://" + repoUrl, { dispatch: { timeoutMs: 120000 } }]],
    provider: { opencode: { models: { "ling-3.0-flash-fin-free": {} } } },
    permission: {},
  }, null, 2))

  const port1 = await freePort([43934, 43935, 43936, 43937, 43938, 43939])
  if (!port1) throw new Error("no free port in 43930-43939")
  const s1 = await startServe(port1, cfgDir, sandboxRoot, { FORGE_TEST_FORGE_HOME: home })
  serves.push(s1.serve)
  console.log(`  serve up: ${s1.base} (phase 1: unconfigured seed)`)
  const p1 = await runPhase("1", s1.base, ws, home)
  ok &= verdictOf("sandbox E2E phase 1 — seed recipe + no-restart probe", p1.pass, p1.detail)

  // The documented materialization boundary: hot-applied forge.json serves
  // dispatch immediately, but agent materialization needs the next config
  // reload. Restart the serve (same sandbox config; the project forge.json
  // written in phase 1 now materializes).
  await killServe(s1.serve)
  serves = serves.filter((s) => s !== s1.serve)
  const port2 = await freePort([43935, 43936, 43937, 43938, 43939, 43934])
  if (!port2) throw new Error("no free port in 43930-43939 (phase 2)")
  const s2 = await startServe(port2, cfgDir, sandboxRoot, { FORGE_TEST_FORGE_HOME: home })
  serves.push(s2.serve)
  console.log(`  serve up: ${s2.base} (phase 2: configured + materialized)`)
  const p2 = await runPhase("2", s2.base, ws, home)
  ok &= verdictOf("sandbox E2E phase 2 — completion + introspection + cascade + red line", p2.pass, p2.detail)
} catch (e) {
  ok &= verdictOf("sandbox E2E — onboarding story", false, String(e).slice(0, 400))
}

// --- Stage 5: legacy inline-roster serve still dispatches ---------------------
try {
  const port3 = await freePort([43936, 43937, 43938, 43939, 43934, 43935])
  if (!port3) throw new Error("no free port in 43930-43939 (legacy)")
  const cfgDir2 = join(sandboxRoot, "config-legacy")
  const ws2 = join(sandboxRoot, "ws-legacy")
  mkdirSync(cfgDir2, { recursive: true })
  mkdirSync(ws2, { recursive: true })
  const repoUrl = REPO.replaceAll("\\", "/")
  writeFileSync(join(cfgDir2, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [["file://" + repoUrl, { dispatch: { timeoutMs: 120000, roster: [{ model: "opencode/ling-3.0-flash-fin-free", expose: ["low"], profiles: ["scout", "quick"] }] } }]],
    provider: { opencode: { models: { "ling-3.0-flash-fin-free": {} } } },
    permission: {},
  }, null, 2))
  const s3 = await startServe(port3, cfgDir2, sandboxRoot)
  serves.push(s3.serve)
  console.log(`  serve up: ${s3.base} (legacy inline roster)`)
  const created = await api(s3.base, `/session?directory=${encodeURIComponent(ws2)}`, { method: "POST", body: JSON.stringify({}) })
  const text = await runTurn(s3.base, created.id, 'Call the forge_dispatch tool NOW with {"prompt": "Create a file named legacy-ok.txt containing exactly: legacy. Then report.", "agent": "quick", "depth": "low"} — NOT background. Report the tool result verbatim (model, depth, depthTranslation, worker report).')
  // NB: the model may markdown-bold the field name ("**depthTranslation**:")
  // — match the word, not word+colon.
  ok &= verdictOf(
    "legacy inline roster still dispatches (quick write tier via agent id)",
    /\[forge:dispatch\] completed in/.test(text) && /depthTranslation/.test(text),
    text.slice(0, 200),
  )
} catch (e) {
  ok &= verdictOf("legacy inline roster still dispatches (quick write tier via agent id)", false, String(e).slice(0, 400))
}

// --- Teardown + verdict ---------------------------------------------------------
for (const s of serves) await killServe(s)
try { rmSync(sandboxRoot, { recursive: true, force: true }) } catch {}

const passed = stages.filter((s) => s.pass).length
console.log(`\n[accept] stages: ${stages.map((s) => `${s.pass ? "PASS" : "FAIL"} ${s.name}`).join(" | ")}`)
console.log(`ACCEPTANCE ${ok ? "PASS" : "FAIL"}: ${passed}/${stages.length} stages`)
try {
  mkdirSync(join(REPO, "openspec", "changes", "add-dispatch-onboarding", "verify"), { recursive: true })
  writeFileSync(join(REPO, "openspec", "changes", "add-dispatch-onboarding", "verify", "accept-run.json"), JSON.stringify({ ok, stages, at: new Date().toISOString() }, null, 2))
} catch {}
process.exit(ok ? 0 : 1)
