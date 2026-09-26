// Stage-C battle driver: drives a real forge session over HTTP and makes it
// call forge_dispatch (E-layer probes B06/B14/B26/B27/B29/B31/E-flavor of
// S6/S7/S8/S12/S18/S19). Usage:
//   node scripts/dispatch-probe-c.mjs <baseUrl> <workspace> <task> [model]
// The parent session runs the forge agent; we send one instruction turn, then
// poll messages + the dispatch ledger until the dispatch completes or times
// out. Permission asks (plan gates etc.) are auto-approved "once".
import { appendFileSync, readFileSync, existsSync } from "node:fs"

const BASE = process.argv[2] ?? "http://127.0.0.1:43931"
const WS = process.argv[3]
const TASK = process.argv[4] ?? "Use forge_dispatch to check for TODOs"
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS ?? 240_000)
const LEDGER = process.env.PROBE_LEDGER ?? ""

const log = (...a) => console.log(`[probe ${new Date().toISOString()}]`, ...a)
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await api(`/session?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({}) })
const sid = created.id
log("session:", sid)

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
            // Sandbox posture: answer every ask (dispatch child sessions ask
            // under their own sessionID; a hang here is the B31 signature).
            console.log(`[probe] ask RAW: session=${p.sessionID ?? ev.sessionID ?? p.session} type=${JSON.stringify(p.type ?? p.permission ?? "?")} title=${JSON.stringify(p.title ?? p.metadata?.title ?? "?").slice(0, 120)}`)
            if (pid) {
              const askSession = p.sessionID ?? ev.sessionID ?? p.session
              const out = await api(`/session/${askSession}/permissions/${pid}`, { method: "POST", body: JSON.stringify({ response: "once" }) })
              log("permission approved:", pid, JSON.stringify(out).slice(0, 80))
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    log("sse ended:", e.message)
  }
})()

await api(`/session/${sid}/message`, { method: "POST", body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: TASK }] }) })
log("task sent; polling for completion...")

const start = Date.now()
let lastCount = 0
let lastText = ""
let stable = 0
while (Date.now() - start < DEADLINE_MS) {
  await sleep(3000)
  let msgs = []
  try {
    msgs = await api(`/session/${sid}/message`)
  } catch {
    continue
  }
  const assistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
  const text = assistant ? (assistant.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n") : ""
  if (msgs.length === lastCount && text === lastText) stable++
  else stable = 0
  lastCount = msgs.length
  lastText = text
  if (stable >= 2 && msgs.length > 1) break
}
controller.abort()

log("=== final assistant text ===")
console.log(lastText)
log("=== dispatch ledger ===")
if (LEDGER && existsSync(LEDGER)) {
  for (const l of readFileSync(LEDGER, "utf8").trim().split("\n")) console.log(l)
} else {
  log("(ledger missing or empty)")
}
