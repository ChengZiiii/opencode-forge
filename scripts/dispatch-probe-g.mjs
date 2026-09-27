// Stage-G E2E smoke driver (task 6.3): drives one real forge session over
// HTTP through three dispatch turns against the keyless endpoint and ASSERTS
// the acceptance criteria. Usage:
//   node scripts/dispatch-probe-g.mjs <baseUrl> <workspace>
// Turns: (1) sync scout/low readonly — asserts the honest empty-response
// failure (B27 quirk, never a silent success); (2) sync quick/low — asserts
// the full result-object fields; (3) background quick/low — asserts the
// handle, then the coalesced [forge:dispatch-complete] wake brief. Finally
// asserts the dispatch ledger rows on disk. Exit code 0 = PASS.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const BASE = process.argv[2] ?? "http://127.0.0.1:43932"
const WS = process.argv[3]
const LEDGER = process.env.PROBE_LEDGER ?? join(process.env.TMP ?? process.env.TEMP ?? "/tmp", "opencode-forge/dispatch/ledger.jsonl")
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

// SSE: auto-answer every permission ask (sandbox posture — dispatch children
// ask under their own sessionID; an unanswered ask is the B31 signature).
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
            console.log(`[smoke] ask: session=${askSession} type=${JSON.stringify(p.type ?? "?")}`)
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

// Drive one parent turn; resolves with the session's LAST assistant text
// once the turn is stable (no in-flight tool part, 3 stable polls).
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

const created = await api(`/session?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({}) })
const sid = created.id
log("session:", sid)
// The ledger rewrites the whole file per append and rotates at 200 entries,
// so a byte-offset delta is rotation-fragile — filter rows by ts instead.
const smokeStart = new Date().toISOString()
log("smoke start:", smokeStart)

// --- Turn 1: sync scout (readonly) on the keyless endpoint -----------------
log("turn 1: sync scout/low (keyless readonly)")
const t1 = await runTurn(sid, 'Call the forge_dispatch tool NOW with {"prompt": "List the file names in the current workspace directory and report them.", "profile": "scout", "depth": "low"} — NOT background. Then report the tool result verbatim (including any error).')
console.log("--- turn 1 text ---\n" + t1 + "\n---")
ok("scout sync failed honestly (empty-response quirk surfaced, never a fake success)", /empty/i.test(t1) && /(empty-response|known quirk|NOT counted|error|failed)/i.test(t1), t1.slice(0, 120))

// --- Turn 2: sync quick (write tier) ---------------------------------------
log("turn 2: sync quick/low")
const t2 = await runTurn(sid, 'Call the forge_dispatch tool NOW with {"prompt": "Create a file named smoke-sync.txt in the current workspace containing exactly: sync-ok. Then report the file you created.", "profile": "quick", "depth": "low"} — NOT background. Then report the tool\'s full result verbatim (model, depth, tokens, cost, session, report text).')
console.log("--- turn 2 text ---\n" + t2 + "\n---")
const syncFile = existsSync(join(WS, "smoke-sync.txt"))
ok("quick sync produced the full result report (actual model/depth + tokens/cost + worker report)", /(actual|model)/i.test(t2) && /(tokens|cost)/i.test(t2) && /smoke-sync\.txt/i.test(t2), t2.slice(0, 160))
ok("quick sync worker actually wrote the file", syncFile, syncFile ? "smoke-sync.txt exists" : "smoke-sync.txt MISSING")

// --- Turn 3: background + wake brief ----------------------------------------
log("turn 3: background quick/low + wake brief")
const t3 = await runTurn(sid, 'Call the forge_dispatch tool NOW with {"prompt": "Create a file named smoke-bg.txt in the current workspace containing exactly: bg-ok. Then report the file you created.", "profile": "quick", "depth": "low", "background": true}. Report the dispatchId/handle you got, then END YOUR TURN immediately.')
console.log("--- turn 3 text ---\n" + t3 + "\n---")
const bgMatch = t3.match(/\b(?:bg-\d+|d\d+)\b/)
ok("background submit returned a handle (dispatchId reported)", !!bgMatch, bgMatch ? bgMatch[0] : "no dispatchId in text")

// The parent is now idle; the child finishes and the wake brief must arrive
// as a NEW message on this session (terminal-driven, debounced, coalesced).
// Scan only messages AFTER the settled turn — the model's own reply quotes
// the [forge:dispatch-complete] marker in prose and must not count.
const afterTurn = (await api(`/session/${sid}/message`)).length
let briefText = ""
const briefStart = Date.now()
while (Date.now() - briefStart < 150_000) {
  await sleep(4000)
  let msgs = []
  try {
    msgs = await api(`/session/${sid}/message`)
  } catch {
    continue
  }
  if (msgs.length <= afterTurn) continue
  briefText = msgs
    .slice(afterTurn)
    .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text))
    .join("\n")
  if (/\[forge:dispatch-complete\]/.test(briefText)) break
}
ok("wake brief arrived on the idle parent ([forge:dispatch-complete])", /\[forge:dispatch-complete\]/.test(briefText), briefText.slice(0, 160))
ok("wake brief carries the worker result (smoke-bg.txt report)", /smoke-bg\.txt/i.test(briefText), briefText.slice(0, 240))
ok("background worker actually wrote the file", existsSync(join(WS, "smoke-bg.txt")), "smoke-bg.txt")

// --- Ledger assertions -------------------------------------------------------
controller.abort()
await sleep(200)
let ledgerRows = []
try {
  ledgerRows = readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((r) => r && typeof r.ts === "string" && r.ts >= smokeStart)
} catch {}
const ledgerDump = JSON.stringify(ledgerRows)
ok(`ledger: empty-response row for the scout attempt (${ledgerRows.length} rows this run)`, ledgerRows.some((r) => r.event === "empty-response"), "")
ok("ledger: completed rows carry tokens/cost/duration", ledgerRows.some((r) => r.event === "completed" && r.tokens && typeof r.costUsd === "number" && typeof r.durationMs === "number"), "")
ok("ledger: background rows carry dispatchId + parentSessionID attribution", ledgerRows.some((r) => r.dispatchId && r.parentSessionID), ledgerDump.slice(0, 200))

const failed = results.filter((r) => !r.pass)
const verdict = failed.length === 0 ? "PASS" : "FAIL"
console.log(`\nSMOKE-G ${verdict}: ${results.length - failed.length}/${results.length} assertions passed`)
writeFileSync(join(WS, "..", "smoke-result.json"), JSON.stringify({ verdict, results, at: new Date().toISOString(), session: sid }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
