// Deterministic live-loop E2E driver (run against `opencode serve`).
//
// Sequencing (avoids the title-generation idle racing the bootstrap reply):
//   1. create session, send a trivial bootstrap message, wait for its idle
//   2. hand-craft the ACTIVE goal file bound to this session
//   3. send a second trivial message; its reply-end idle -> continuation
//      engine takes over: briefs -> model work -> gate ask -> approve ->
//      status completed. No further driver intervention besides approvals.
//
// Usage: node scripts/live-loop-e2e.mjs <baseUrl> <absWorkspace>
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { renderGoal, parseGoal } from "../src/goal-file.ts"

const BASE = process.argv[2] ?? "http://127.0.0.1:43120"
const WS = process.argv[3] ?? "C:/tmp/forge-goal-live-clean"
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const DEADLINE_MS = 6 * 60 * 1000
const PERM_LOG = "C:/tmp/forge-perm-events.log"

const log = (...a) => console.log(`[e2e ${new Date().toISOString()}]`, ...a)
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await api(`/session?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({}) })
const sid = created.id
log("session created:", sid)

// SSE consumer: count idles, dump raw permission events, auto-approve asks.
let idleCount = 0
const idleWaiters = []
const onIdle = () => {
  idleCount++
  log(`session.idle #${idleCount}`)
  idleWaiters.splice(0).forEach((r) => r())
}
const controller = new AbortController()
;(async () => {
  const res = await fetch(`${BASE}/event`, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith("data:")) continue
      try {
        const ev = JSON.parse(line.slice(5))
        if (ev.type === "session.idle" && ev.properties?.sessionID === sid) onIdle()
        else if (ev.type?.startsWith("permission.")) {
          const raw = JSON.stringify(ev)
          appendFileSync(PERM_LOG, raw + "\n")
          log("permission event RAW:", raw.slice(0, 600))
          const p = ev.properties ?? {}
          const pid = p.permissionID ?? p.id ?? p.permission?.id ?? ev.permissionID
          if (ev.type === "permission.asked" && pid && (p.sessionID ?? p.session ?? ev.sessionID) === sid) {
            const out = await api(`/session/${sid}/permissions/${pid}?directory=${encodeURIComponent(WS)}`, {
              method: "POST",
              body: JSON.stringify({ response: "once" }),
            })
            log("permission approved:", pid, "->", JSON.stringify(out))
          } else if (ev.type === "permission.asked") {
            log("permission.asked for another session or missing id — not answering")
          }
        }
      } catch {
        /* keepalive lines */
      }
    }
  }
})().catch((e) => log("sse ended:", e.message))
const waitForIdle = (timeoutMs = 120000) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs, "timeout")
    idleWaiters.push(() => {
      clearTimeout(t)
      resolve("idle")
    })
  })

// Phase 1: bootstrap reply to get past title-gen noise.
await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, {
  method: "POST",
  body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: "Reply with the single word: ok" }] }),
})
const r1 = await waitForIdle()
log("bootstrap phase done:", r1)
await sleep(3000)

// Phase 2: hand-craft the active goal bound to this session.
const now = new Date().toISOString()
const goalText = renderGoal(
  {
    goal: "Create done.txt containing exactly the word loopdone at the workspace root, then verify and complete",
    criteria: ["done.txt exists at the workspace root containing the word loopdone"],
    checks: [{ kind: "contains", file: "done.txt", text: "loopdone" }],
    constraints: "Touch nothing except done.txt; no network access",
    nonGoals: ["refactoring or creating any other file"],
    maxTurns: 3,
    maxMinutes: 10,
  },
  { now, status: "active", session: sid },
)
const goalDir = join(WS, ".opencode", "goal")
mkdirSync(goalDir, { recursive: true })
const goalPath = join(goalDir, "2026-09-25-live-loop.md")
writeFileSync(goalPath, goalText)
log("goal armed on disk:", goalPath, "status=active session=" + sid)

// Phase 3: second trivial message -> its idle starts the continuation loop.
const baseIdle = idleCount
await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, {
  method: "POST",
  body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: "Reply with the single word: ok" }] }),
})
const r2 = await waitForIdle()
log("second message done:", r2, "(idle #" + (baseIdle + 1) + " expected before continuation)")

// Phase 4: poll the goal file for a terminal state.
const start = Date.now()
let lastStatus = "active"
let finalDoc = null
while (Date.now() - start < DEADLINE_MS) {
  await sleep(3000)
  const files = readdirSync(goalDir).filter((f) => f.endsWith(".md"))
  for (const f of files) {
    const doc = parseGoal(readFileSync(join(goalDir, f), "utf8"))
    if (doc.status !== lastStatus) {
      log(`goal status: ${lastStatus} -> ${doc.status}${doc.stopReason ? ` (stop_reason: ${doc.stopReason})` : ""} turns=${doc.turnsUsed}/${doc.maxTurns}`)
      lastStatus = doc.status
    }
    if (doc.status === "completed" || doc.status === "abandoned" || doc.status === "paused") finalDoc = { file: f, doc }
  }
  if (finalDoc) break
}
controller.abort()

if (!finalDoc) {
  log("TIMEOUT: goal never reached a terminal state")
  process.exit(1)
}
const { file, doc } = finalDoc
log("FINAL:", file, "status=" + doc.status, "stop_reason=" + (doc.stopReason ?? "-"), `turns=${doc.turnsUsed}/${doc.maxTurns}`, `revision=${doc.revision}`)
log("check log lines:", doc.log.length)
for (const l of doc.log) log("  ", l)
log("ledger lines:", doc.ledger.length)
for (const l of doc.ledger) log("  ", `- turn ${l.turn} rev${l.revision} activity=${l.activity ? "yes" : "no"} (writes=${l.writes} checks=${l.checks})`)
const done = readFileSync(join(WS, "done.txt"), "utf8")
log("done.txt content:", JSON.stringify(done))
process.exit(doc.status === "completed" && done.includes("loopdone") ? 0 : 2)
