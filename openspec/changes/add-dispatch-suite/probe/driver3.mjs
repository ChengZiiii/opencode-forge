// Focused P3 rerun: clean deny/allow baselines with explicit relative-path wording.
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const BASE = process.argv[2] ?? "http://127.0.0.1:43918"
const ROOT = join(tmpdir(), "forge-dispatch-probe")
const WS = join(ROOT, "ws")
mkdirSync(WS, { recursive: true })
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
const controller = new AbortController()
const mySessions = new Set()
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
        log("PERMISSION EVENT:", ev.type, "sid=", String(sid).slice(0, 12), "pid=", String(pid).slice(0, 14))
        if (ev.type === "permission.asked" && sid && mySessions.has(sid) && pid) {
          try {
            await api(`/session/${sid}/permissions/${pid}?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify({ response: "once" }) })
            log("auto-approved:", String(sid).slice(0, 12))
          } catch (e) {
            log("approve failed:", e.message)
          }
        }
      } catch {}
    }
  }
})().catch((e) => log("sse ended:", e.message))

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
const toolStates = (msgs) => {
  const out = []
  for (const m of msgs) for (const p of m.parts ?? []) if (p.type === "tool") out.push({ tool: p.tool, status: p.state?.status, input: JSON.stringify(p.state?.input ?? {}).slice(0, 120), error: p.state?.error })
  return out
}
async function waitDone(sid, deadlineMs = 90000) {
  const start = Date.now()
  let prevLen = -1
  let prevText = ""
  let stable = 0
  while (Date.now() - start < deadlineMs) {
    await sleep(2500)
    const msgs = await readMsgs(sid)
    const t = assistantText(msgs)
    if (msgs.length === prevLen && t === prevText && t.length > 0) {
      if (++stable >= 2) return { done: true, text: t, tools: toolStates(msgs) }
    } else stable = 0
    prevLen = msgs.length
    prevText = t
  }
  const msgs = await readMsgs(sid)
  return { done: false, text: assistantText(msgs), tools: toolStates(msgs) }
}
async function runCase(name, { agent, text, expectFiles }) {
  const created = await api(`/session${q()}`, { method: "POST", body: JSON.stringify({}) })
  const sid = created.id
  mySessions.add(sid)
  log(`--- ${name} sid=${sid}`)
  try {
    await api(`/session/${sid}/message${q()}`, { method: "POST", body: JSON.stringify({ model: MODEL, agent, parts: [{ type: "text", text }] }) })
  } catch (e) {
    log(`${name}: send failed: ${e.message}`)
  }
  const fin = await waitDone(sid)
  const files = expectFiles.map((f) => ({ f, exists: existsSync(join(WS, f)) }))
  log(`${name}: done=${fin.done} files=${JSON.stringify(files)} tools=${JSON.stringify(fin.tools)}`)
  log(`${name}: reply="${fin.text.slice(0, 350)}"`)
}

await runCase("P3-a2-scout-deny", {
  agent: "probe-scout",
  text: "Use the write tool to create the file p3-a.txt (this exact RELATIVE filename, no directories, no absolute path) in the current workspace with content a. If the tool call is refused or errors, reply with the exact refusal text. Otherwise reply DONE.",
  expectFiles: ["p3-a.txt"],
})
await runCase("P3-d2-builder-allow", {
  agent: "probe-builder",
  text: "Use the write tool to create the file p3-d.txt (this exact RELATIVE filename, no directories, no absolute path) in the current workspace with content d. If the tool call is refused or errors, reply with the exact refusal text. Otherwise reply DONE.",
  expectFiles: ["p3-d.txt"],
})
controller.abort()
process.exit(0)
