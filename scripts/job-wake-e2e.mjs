// Job wake E2E (job-terminal-evidence, 0.7.0): run against a real
// `opencode serve` in npm plugin mode.
//
// Phase A (negative): a foreground quick command delivers everything inline
//   — assert NO [forge:job-complete] arrives and `forge_jobs list` shows no
//   litter afterwards.
// Phase B (positive): a background job whose caller polled it to completion
//   still wakes the idled session exactly once.
//
// Usage: node scripts/job-wake-e2e.mjs <baseUrl> <absWorkspace>
import { appendFileSync } from "node:fs"
import { join } from "node:path"

const BASE = process.argv[2] ?? "http://127.0.0.1:43121"
const WS = process.argv[3]
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const PERM_LOG = "C:/tmp/forge-perm-events-jobwake.log"
const log = (...a) => console.log(`[e2e ${new Date().toISOString()}]`, ...a)
const fail = (msg) => {
  log("FAIL:", msg)
  process.exit(2)
}

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

// SSE: idles, permission auto-approval, and every assistant text part.
let idleWaiters = []
const texts = [] // { role, text }
let wakes = 0
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
        if (ev.type === "session.idle" && ev.properties?.sessionID === sid) {
          log("session.idle")
          idleWaiters.splice(0).forEach((r) => r())
        } else if (ev.type?.startsWith("permission.")) {
          appendFileSync(PERM_LOG, JSON.stringify(ev) + "\n")
          const p = ev.properties ?? {}
          const pid = p.permissionID ?? p.id ?? p.permission?.id ?? ev.permissionID
          if (ev.type === "permission.asked" && pid && (p.sessionID ?? p.session ?? ev.sessionID) === sid) {
            await api(`/session/${sid}/permissions/${pid}?directory=${encodeURIComponent(WS)}`, {
              method: "POST",
              body: JSON.stringify({ response: "once" }),
            }).catch((e) => log("approve failed:", e.message))
            log("permission approved:", pid)
          }
        } else if ((ev.type === "message.part.updated" || ev.type === "message.updated") && (ev.properties?.part?.sessionID ?? ev.properties?.info?.sessionID ?? ev.properties?.part?.messageID) && (ev.properties?.part?.sessionID ?? ev.properties?.info?.id) === sid) {
          const part = ev.properties?.part
          if (part?.type === "text" && typeof part.text === "string") {
            texts.push({ role: part.role ?? "assistant", text: part.text })
            if (part.text.includes("[forge:job-complete]")) wakes++
          }
        }
      } catch {
        /* keepalive lines */
      }
    }
  }
})().catch((e) => log("sse ended:", e.message))
const waitForIdle = (timeoutMs = 180000) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs, "timeout")
    idleWaiters.push(() => {
      clearTimeout(t)
      resolve("idle")
    })
  })

const send = async (text) => {
  await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, {
    method: "POST",
    body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text }] }),
  })
}

// Bootstrap (title-gen noise).
await send("Reply with the single word: ok")
log("bootstrap:", await waitForIdle())
await sleep(2000)

// ---- Phase A: foreground quick command — no wake, no registry litter ----
const aTextsBefore = texts.length
await send(
  'Use forge_shell (foreground, defaults) to run exactly: node -e "console.log(\'quick-e2e-ok\')". Then report the tool result verbatim, then stop.',
)
if ((await waitForIdle()) === "timeout") fail("phase A never idled")
await sleep(3000)
const aTexts = texts.slice(aTextsBefore).map((t) => t.text).join("\n")
log("phase A assistant text (tail):", aTexts.slice(-500).replace(/\n+/g, " | "))
if (!aTexts.includes("quick-e2e-ok")) fail("phase A: the quick command output never reached the model")
const aWakes = wakes
log(`phase A wakes so far: ${aWakes}`)

await send("Now call forge_jobs with action list and report its output verbatim, then stop.")
if ((await waitForIdle()) === "timeout") fail("phase A list never idled")
await sleep(2000)
const listText = texts.slice().map((t) => t.text).join("\n")
const aListTail = texts.slice(texts.length - 4).map((t) => t.text).join("\n")
log("phase A list (tail):", aListTail.slice(-400).replace(/\n+/g, " | "))
if (aListTail.includes("[forge:job-complete]")) fail("phase A: a completion wake fired for a synchronously consumed command")
if (!/\(no jobs\)|no jobs/i.test(aListTail) && !aListTail.includes("(no jobs)")) fail("phase A: registry not clean — the consumed job lingered: " + aListTail.slice(-200))

// ---- Phase B: background job polled to completion still wakes once ----
await send(
  'Use forge_shell with run_in_background=true to run: node -e "setTimeout(()=>{console.log(\'bg-e2e-done\')},8000)". Then call forge_jobs poll {jobId, waitMs:30000} repeatedly until it reports exited, and report the final poll verbatim. Then stop.',
)
if ((await waitForIdle()) === "timeout") fail("phase B never idled")
log("phase B turn done; waiting for the deferred wake on idle...")
let woke = false
for (let i = 0; i < 30 && !woke; i++) {
  await sleep(3000)
  const joined = texts.map((t) => t.text).join("\n")
  woke = joined.split("[forge:job-complete]").length - 1 > aWakes
}
if (!woke) fail("phase B: no completion wake for the background job within the bound")
const allText = texts.map((t) => t.text).join("\n")
const wakeCount = allText.split("[forge:job-complete]").length - 1
log(`total wakes observed: ${wakeCount}`)
if (!allText.includes("bg-e2e-done")) fail("phase B: wake arrived but without the job output")
if (wakeCount !== aWakes + 1) fail(`phase B: expected exactly ONE new wake, total now ${wakeCount}`)

controller.abort()
log("PASS: negative path clean (no wake, no litter), positive path woke exactly once with output.")
process.exit(0)
