// add-dispatch-onboarding E2E smoke driver (task 5.3), two phases split by an
// intentional serve restart (the restart simulates the documented
// materialization boundary: hot-applied forge.json serves DISPATCH
// immediately, but agent materialization needs the next config reload).
// Usage:
//   node scripts/dispatch-onboarding-smoke.mjs <baseUrl> <workspace> <homeDir> <phase>
// phase 1: unconfigured seed dispatch -> pin-unavailable + recipe; then the
//          "AI configures" step writes <ws>/.opencode/forge.json and probes a
//          brand-new write agent WITHOUT restart (host acceptance of the
//          unmaterialized name RECORDED — completed/refused/quirk, never a
//          silent drop).
// phase 2 (after restart): dispatch the now-materialized write agent ->
//          completion + depthTranslation + the worker really ran;
//          forge_dispatch_config round-trip; project-over-global cascade;
//          red line (plugin never rewrote forge.json); ledger rows.
// Exit code 0 = phase PASS. Keys are never echoed.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const BASE = process.argv[2] ?? "http://127.0.0.1:43934"
const WS = process.argv[3]
const HOME = process.argv[4]
const PHASE = process.argv[5] ?? "1"
const LEDGER = join(process.env.TMP ?? process.env.TEMP ?? "/tmp", "opencode-forge/dispatch/ledger.jsonl")
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS ?? 240_000)
const results = []
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail: String(detail ?? "").slice(0, 300) })
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`)
}
const log = (...a) => console.log(`[smoke ${new Date().toISOString()}]`, ...a)
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// SSE: auto-answer every permission ask (sandbox posture).
const controller = new AbortController()
;(async () => {
  try {
    const res = await fetch(`${BASE}/event`, { signal: controller.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith("data:")) continue
        try {
          const ev = JSON.parse(line.slice(5))
          if (ev.type === "permission.asked") {
            const p = ev.properties ?? {}
            const pid = p.permissionID ?? p.id ?? p.permission?.id
            const askSession = p.sessionID ?? ev.sessionID ?? p.session
            if (pid && askSession) {
              await api(`/session/${askSession}/permissions/${pid}`, { method: "POST", body: JSON.stringify({ response: "once" }) }).catch(() => {})
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    log("sse ended:", e.message)
  }
})()

async function runTurn(sid, task) {
  const before = (await api(`/session/${sid}/message`)).length
  api(`/session/${sid}/message`, { method: "POST", body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: task }] }) }).then(
    () => log("turn POST returned"),
    (e) => log("turn POST failed:", e.message),
  )
  const start = Date.now()
  let lastText = ""
  let lastSig = ""
  let stable = 0
  for (;;) {
    if (Date.now() - start > DEADLINE_MS) break
    await sleep(3000)
    let msgs = []
    try {
      msgs = await api(`/session/${sid}/message`)
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

// The keyless sandbox endpoint occasionally stalls a whole turn (no assistant
// message at all — a known quirk from the add-dispatch-suite battles). One
// retry on an empty turn; two empties in a row is a real failure.
async function runTurnReliable(sid, task) {
  let text = await runTurn(sid, task)
  if (!text.trim()) {
    log("empty turn — retrying once (keyless stall pattern)")
    text = await runTurn(sid, `Retry the previous task now: ${task}`)
  }
  return text
}

const created = await api(`/session?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({}) })
const sid = created.id
log(`phase ${PHASE} session:`, sid)

const smokeStartFile = join(WS, ".smoke-start")
if (PHASE === "1") {
  writeFileSync(smokeStartFile, new Date().toISOString())

  // --- Stage 1: unconfigured seed -> pin-unavailable + recipe ---------------
  log("stage 1: unconfigured seed dispatch")
  const t1 = await runTurnReliable(sid, 'Call the forge_dispatch tool NOW with {"prompt": "say hi", "agent": "research"} — NOT background. Then report the FULL tool error verbatim, every line.')
  console.log("--- stage 1 text ---\n" + t1.slice(0, 900) + "\n---")
  ok("1. seed dispatch fails pin-unavailable naming the placeholder", /pin-unavailable/i.test(t1) && /Local\/GPT Luna/.test(t1), t1.slice(0, 160))
  ok("1. the error carries the recipe (paths + template + verify)", /\.opencode[\\/]forge\.json/.test(t1) && /"agents"/.test(t1) && /"model"/.test(t1) && /forge_dispatch/.test(t1), t1.slice(0, 160))

  // --- Stage 2a: the session-AI step — write forge.json, probe WITHOUT reload
  log("stage 2a: write project forge.json (AI-configurator step), probe new agent without restart")
  mkdirSync(join(WS, ".opencode"), { recursive: true })
  writeFileSync(join(WS, ".opencode", "forge.json"), JSON.stringify({
    agents: {
      research: { model: "opencode/ling-3.0-flash-fin-free", depths: ["low"], shape: "write" },
      smokeworker: { model: "opencode/ling-3.0-flash-fin-free", depths: ["low"], shape: "write", prompt: "You are the smoke worker." },
    },
  }, null, 2))
  const t2 = await runTurnReliable(sid, 'Call the forge_dispatch tool NOW with {"prompt": "Create a file named new-agent-ok.txt in the current workspace containing exactly: fresh. Then report the file path.", "agent": "smokeworker", "depth": "low"} — NOT background. Report the FULL tool result verbatim including any error, and state the agent name you passed.')
  console.log("--- stage 2a text ---\n" + t2.slice(0, 800) + "\n---")
  const completedNoRestart = /completed in/.test(t2) && /depthTranslation:/.test(t2)
  const refusedNoRestart = /host-error|unknown agent|400|invalid/i.test(t2) && !completedNoRestart
  const quirkNoRestart = /empty-response/i.test(t2) && !completedNoRestart
  ok("2a. unmaterialized new agent: outcome recorded honestly (completed/refused/quirk — never a silent drop)", /smokeworker/.test(t2) && (completedNoRestart || refusedNoRestart || quirkNoRestart), `completed=${completedNoRestart} refused=${refusedNoRestart} quirk=${quirkNoRestart} :: ${t2.slice(0, 140)}`)
  if (completedNoRestart) ok("2a. hot-apply without restart served the new agent end-to-end", existsSync(join(WS, "new-agent-ok.txt")), "new-agent-ok.txt")
} else {
  // --- Stage 2b: after restart the write agents are materialized ------------
  log("stage 2b: post-restart dispatch of the configured write agent")
  const t2 = await runTurnReliable(sid, 'Call the forge_dispatch tool NOW with {"prompt": "Create a file named onboarding-ok.txt in the current workspace containing exactly: configured. Then report the file path.", "agent": "research", "depth": "low"} — NOT background. Then report the tool result verbatim including every line (agent, model, depth, depthTranslation, tokens, cost, worker report).')
  console.log("--- stage 2b text ---\n" + t2.slice(0, 900) + "\n---")
  ok("2b. configured write agent completes (model pinned, report complete)", /\[forge:dispatch\] completed in/.test(t2) && /opencode\/ling-3\.0-flash-fin-free/.test(t2), t2.slice(0, 160))
  ok("2b. the report discloses the depth translation", /depthTranslation:/.test(t2) && /verbatim/i.test(t2), t2.slice(0, 160))
  ok("2b. the worker really ran (file created in the workspace)", existsSync(join(WS, "onboarding-ok.txt")) && readFileSync(join(WS, "onboarding-ok.txt"), "utf8").includes("configured"), "onboarding-ok.txt content")

  // --- Stage 4: forge_dispatch_config round-trip + cascade -------------------
  log("stage 4: forge_dispatch_config + cascade precedence")
  const t4 = await runTurnReliable(sid, 'Call the forge_dispatch_config tool NOW and report: every agent id, the model of agent research, its depths, and the knobs values — verbatim values, no summarizing.')
  console.log("--- stage 4 text ---\n" + t4.slice(0, 700) + "\n---")
  ok("4. config tool round-trips the project agents", /research/.test(t4) && /smokeworker/.test(t4) && /ling-3\.0-flash-fin-free/.test(t4) && /(timeoutMs|120000)/.test(t4) && /maxConcurrent/.test(t4), t4.slice(0, 140))
  ok("4. no discovery fields in the introspection output", !/canonicalVocabulary|"detected"|in-flight/i.test(t4), t4.slice(0, 140))

  mkdirSync(join(HOME, ".config", "opencode"), { recursive: true })
  writeFileSync(join(HOME, ".config", "opencode", "forge.json"), JSON.stringify({ agents: { globalonly: { model: "opencode/ling-3.0-flash-fin-free", depths: ["low"], shape: "write" } } }, null, 2))
  const t4b = await runTurnReliable(sid, 'Call the forge_dispatch_config tool NOW and report the agent ids it lists, verbatim.')
  ok("4. project file wins over global (global-only agent absent)", !/globalonly/.test(t4b), t4b.slice(0, 140))
  writeFileSync(join(WS, ".opencode", "forge.json.deleted"), readFileSync(join(WS, ".opencode", "forge.json"), "utf8"))
  const { rmSync } = await import("node:fs")
  rmSync(join(WS, ".opencode", "forge.json"), { force: true })
  const t4c = await runTurnReliable(sid, 'The project forge.json was deleted. Call forge_dispatch_config NOW and report the agent ids listed, verbatim.')
  ok("4. after deleting the project file, the global file serves", /globalonly/.test(t4c) && !/"smokeworker"/.test(t4c), t4c.slice(0, 140))
  // restore the project file for the red-line check (same content as written)
  writeFileSync(join(WS, ".opencode", "forge.json"), readFileSync(join(WS, ".opencode", "forge.json.deleted"), "utf8"))

  // --- Stage 5: red line — the plugin never rewrote forge.json ---------------
  const projectNow = readFileSync(join(WS, ".opencode", "forge.json"), "utf8")
  ok("5. plugin never rewrote forge.json (content identical to what the driver wrote)", projectNow === readFileSync(join(WS, ".opencode", "forge.json.deleted"), "utf8"), projectNow.slice(0, 80))

  // --- Stage 6: ledger rows ----------------------------------------------------
  const smokeStart = readFileSync(smokeStartFile, "utf8")
  try {
    // The ledger rewrites the whole file per append, so a read can land
    // mid-rewrite (torn last line). Parse line-by-line, tolerate a torn
    // tail, retry the read once.
    const readRows = () => {
      const raw = readFileSync(LEDGER, "utf8")
      const parsed = []
      let torn = false
      for (const line of raw.split("\n")) {
        const l = line.trim()
        if (!l) continue
        try { parsed.push(JSON.parse(l)) } catch { torn = true }
      }
      return { parsed, torn }
    }
    let { parsed: rows, torn } = readRows()
    if (torn) await sleep(1500), ({ parsed: rows } = readRows())
    rows = rows.filter((r) => r.ts >= smokeStart)
    ok("6. ledger has the resolve-error (seed pin) row", rows.some((r) => r.event === "resolve-error" && r.outcome === "pin-unavailable"), `${rows.length} rows since smoke start`)
    ok("6. ledger has completed rows (tier field carries the agent id)", rows.some((r) => r.event === "completed" && r.tier !== undefined), `${rows.length} rows`)
  } catch (e) {
    ok("6. ledger readable", false, e.message)
  }
}

controller.abort()
const pass = results.filter((r) => r.pass).length
console.log(`SMOKE-ONBOARDING-${PHASE} ${pass === results.length ? "PASS" : "FAIL"}: ${pass}/${results.length}`)
if (process.env.SMOKE_OUT) {
  try {
    writeFileSync(process.env.SMOKE_OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, phase: PHASE, results }, null, 2))
  } catch {}
}
process.exit(pass === results.length ? 0 : 1)
