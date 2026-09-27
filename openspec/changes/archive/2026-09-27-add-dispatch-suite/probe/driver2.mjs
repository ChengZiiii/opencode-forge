// P3 permission-composition probe (+ P4-lite). Completion detection by polling
// GET /session/:id/message (correct path — /messages 404s into HTML).
// Usage: node driver2.mjs [baseUrl]
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const BASE = process.argv[2] ?? "http://127.0.0.1:43917"
const ROOT = join(tmpdir(), "forge-dispatch-probe")
const WS = join(ROOT, "ws")
const LOGS = join(ROOT, "logs")
mkdirSync(WS, { recursive: true })
mkdirSync(LOGS, { recursive: true })
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const q = () => `?directory=${encodeURIComponent(WS)}`
const log = (...a) => console.log(`[probe ${new Date().toISOString()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

// SSE: permission events only (capture + auto-approve for our sessions).
const mySessions = new Set()
const controller = new AbortController()
;(async () => {
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
        if (!ev.type?.startsWith("permission.")) continue
        const p = ev.properties ?? {}
        const sid = p.sessionID ?? p.session ?? ev.sessionID
        const pid = p.permissionID ?? p.id ?? p.permission?.id
        appendFileSync(join(LOGS, "sse-permissions.log"), JSON.stringify({ type: ev.type, sid, pid, raw: JSON.stringify(p).slice(0, 400) }) + "\n")
        log("PERMISSION EVENT:", ev.type, "sid=", String(sid).slice(0, 12), "pid=", String(pid).slice(0, 14))
        if (ev.type === "permission.asked" && sid && mySessions.has(sid) && pid) {
          try {
            await api(`/session/${sid}/permissions/${pid}?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({ response: "once" }) })
            log("auto-approved:", String(sid).slice(0, 12), String(pid).slice(0, 14))
          } catch (e) {
            log("approve failed:", e.message)
          }
        }
      } catch {}
    }
  }
})().catch((e) => log("sse ended:", e.message))

// readiness
{
  let ok = false
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      await api(`/session${q()}`)
      ok = true
    } catch {
      await sleep(1000)
    }
  }
  if (!ok) {
    log("FATAL: server not ready")
    process.exit(1)
  }
  log("server ready")
}

const readMsgs = async (sid) => {
  try {
    return await api(`/session/${sid}/message${q()}`)
  } catch {
    return []
  }
}
const assistantText = (msgs) => {
  let out = ""
  for (const m of msgs) if (m.info?.role === "assistant") for (const p of m.parts ?? []) if (p.type === "text") out += (p.text ?? "") + " "
  return out.trim()
}
const toolCalls = (msgs) => {
  const out = []
  for (const m of msgs) for (const p of m.parts ?? []) if (p.type === "tool") out.push({ tool: p.tool, state: p.state })
  return out
}

async function waitDone(sid, deadlineMs = 100000) {
  const start = Date.now()
  let prevLen = -1
  let prevText = ""
  let stable = 0
  while (Date.now() - start < deadlineMs) {
    await sleep(2500)
    const msgs = await readMsgs(sid)
    const text = assistantText(msgs)
    if (msgs.length === prevLen && text === prevText && text.length > 0) {
      stable++
      if (stable >= 2) return { done: true, text, toolCalls: toolCalls(msgs) }
    } else {
      stable = 0
    }
    prevLen = msgs.length
    prevText = text
  }
  const msgs = await readMsgs(sid)
  return { done: false, text: assistantText(msgs), toolCalls: toolCalls(msgs) }
}

const results = []
async function runCase(name, { create = {}, agent, text, expectFiles = [] }) {
  log(`--- ${name}`)
  let sid
  try {
    const created = await api(`/session${q()}`, { method: "POST", body: JSON.stringify(create) })
    sid = created.id
  } catch (e) {
    log(`${name}: session create FAILED: ${e.message}`)
    results.push({ name, error: `create: ${e.message}` })
    return
  }
  mySessions.add(sid)
  log(`${name}: sid=${sid}`)
  const body = { model: MODEL, parts: [{ type: "text", text }], ...(agent ? { agent } : {}) }
  try {
    await api(`/session/${sid}/message${q()}`, { method: "POST", body: JSON.stringify(body) })
  } catch (e) {
    log(`${name}: message send FAILED: ${e.message}`)
  }
  const fin = await waitDone(sid)
  const done = fin.done
  const toolCalls = fin.toolCalls
  const replyText = fin.text
  const files = expectFiles.map((f) => ({ f, exists: existsSync(join(WS, f)) }))
  log(`${name}: done=${done} files=${JSON.stringify(files)} tools=${JSON.stringify(toolCalls)}`)
  log(`${name}: reply="${replyText.slice(0, 300)}"`)
  results.push({ name, sid, done, files, toolCalls, reply: replyText.slice(0, 500) })
}

await runCase("P3-a-agent-deny-only", {
  agent: "probe-scout",
  text: "Create a file named p3-a.txt at the workspace root containing the letter a. If the write tool is refused, reply with the refusal text verbatim. Then reply DONE.",
  expectFiles: ["p3-a.txt"],
})
await runCase("P3-b-create-allow-vs-agent-deny", {
  create: { permission: { write: "allow" } },
  agent: "probe-scout",
  text: "Create a file named p3-b.txt at the workspace root containing the letter b. If the write tool is refused, reply with the refusal text verbatim. Then reply DONE.",
  expectFiles: ["p3-b.txt"],
})
await runCase("P3-c-create-deny-vs-agent-allow", {
  create: { permission: { write: "deny" } },
  agent: "probe-builder",
  text: "Create a file named p3-c.txt at the workspace root containing the letter c. If the write tool is refused, reply with the refusal text verbatim. Then reply DONE.",
  expectFiles: ["p3-c.txt"],
})
await runCase("P3-d-agent-allow-baseline", {
  agent: "probe-builder",
  text: "Create a file named p3-d.txt at the workspace root containing the letter d. If the write tool is refused, reply with the refusal text verbatim. Then reply DONE.",
  expectFiles: ["p3-d.txt"],
})

try {
  const list = await api(`/session${q()}`)
  appendFileSync(join(LOGS, "session-list.json"), JSON.stringify(list, null, 2))
  log("P4-lite: session list length:", Array.isArray(list) ? list.length : typeof list)
} catch (e) {
  log("P4-lite list failed:", e.message)
}

const readLog = (f) => {
  const p = join(LOGS, f)
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
}
appendFileSync(
  join(LOGS, "findings2.json"),
  JSON.stringify({ cases: results, ssePermissions: readLog("sse-permissions.log"), permissionAskHook: readLog("permission-ask.log"), toolBefore: readLog("tool-before.log") }, null, 2),
)
log("findings2 written")
controller.abort()
process.exit(0)
