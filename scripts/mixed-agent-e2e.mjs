// Mixed-session agent-switch E2E: forge first, then Tab to build, then back.
// Run against a real `opencode serve` (npm plugin mode).
//
//   Turn 1 (default = forge): trivial command  -> forge_shell, no builtin
//   Turn 2 (agent: build):    trivial command  -> builtin shell, NO forge tools
//   Turn 3 (agent: build):    trivial command  -> builtin again; no belt refusal
//   Turn 4 (default = forge): trivial command  -> forge_shell again
//
// Usage: node scripts/mixed-agent-e2e.mjs <baseUrl> <absWorkspace>
import { appendFileSync } from "node:fs"

const BASE = process.argv[2] ?? "http://127.0.0.1:43123"
const WS = process.argv[3]
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const PERM_LOG = "C:/tmp/forge-perm-events-mixed.log"
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

const toolCalls = [] // { tool, status }
const texts = []
let idleWaiters = []
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
          }
        } else if (ev.type === "message.part.updated") {
          const part = ev.properties?.part
          if (part?.sessionID !== sid) continue
          if (part.type === "tool") {
            const name = part.tool ?? part.name ?? "?"
            const status = part.state?.status ?? "?"
            const last = toolCalls[toolCalls.length - 1]
            if (last && last.tool === name && last.status === status) continue
            toolCalls.push({ tool: name, status })
            log(`  tool: ${name} (${status})`)
          } else if (part.type === "text" && typeof part.text === "string") {
            texts.push(part.text)
          }
        }
      } catch {
        /* keepalive lines */
      }
    }
  }
})().catch((e) => log("sse ended:", e.message))
const waitForIdle = (timeoutMs = 240000) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs, "timeout")
    idleWaiters.push(() => {
      clearTimeout(t)
      resolve("idle")
    })
  })

// turn: { agent?: string, marker: string }
const runTurn = async ({ agent, marker }) => {
  const t0 = toolCalls.length
  const x0 = texts.length
  const body = {
    model: MODEL,
    parts: [{ type: "text", text: `Run exactly this one command and report its output, then stop: node -e "console.log('${marker}')"` }],
  }
  if (agent) body.agent = agent
  await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, { method: "POST", body: JSON.stringify(body) })
  if ((await waitForIdle()) === "timeout") fail(`turn ${marker} never idled`)
  await sleep(2500)
  const tools = toolCalls.slice(t0).map((t) => t.tool)
  const toolUniverse = [...new Set(tools)]
  const text = texts.slice(x0).join("\n")
  const outputReached = text.includes(marker) || (await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, { method: "GET" }).catch(() => "")).toString().includes(marker)
  return { tools: toolUniverse, text, outputReached }
}

// Bootstrap.
await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, {
  method: "POST",
  body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: "Reply with the single word: ok" }] }),
})
log("bootstrap:", await waitForIdle())
await sleep(2000)

const r1 = await runTurn({ marker: "turn1-forge" })
log(`turn1 (default=forge): tools=[${r1.tools}] outputReached=${r1.outputReached}`)
const r2 = await runTurn({ agent: "build", marker: "turn2-build" })
log(`turn2 (agent=build):  tools=[${r2.tools}] outputReached=${r2.outputReached}`)
const r3 = await runTurn({ agent: "build", marker: "turn3-build" })
log(`turn3 (agent=build):  tools=[${r3.tools}] outputReached=${r3.outputReached}`)
const r4 = await runTurn({ marker: "turn4-forge" })
log(`turn4 (default=forge): tools=[${r4.tools}] outputReached=${r4.outputReached}`)

const allText = texts.join("\n")
const checks = [
  [`turn1 used forge_shell`, r1.tools.includes("forge_shell")],
  [`turn1 used no builtin`, !r1.tools.includes("shell") && !r1.tools.includes("bash")],
  [`turn2 used builtin shell`, r2.tools.includes("shell") || r2.tools.includes("bash")],
  [`turn2 used no forge_shell`, !r2.tools.includes("forge_shell")],
  [`turn3 used builtin shell`, r3.tools.includes("shell") || r3.tools.includes("bash")],
  [`turn3 used no forge_shell`, !r3.tools.includes("forge_shell")],
  [`turn4 used forge_shell again`, r4.tools.includes("forge_shell")],
  [`no belt refusal anywhere`, !allText.includes("[forge:partition]")],
  [`all four outputs reached the model`, ["turn1-forge", "turn2-build", "turn3-build", "turn4-forge"].every((m) => allText.includes(m))],
]
let bad = 0
for (const [name, ok] of checks) {
  log(`${ok ? "PASS" : "FAIL"}: ${name}`)
  if (!ok) bad++
}
controller.abort()
if (bad > 0) process.exit(2)
log("PASS: tool surfaces follow the current speaker across mid-session agent switches.")
process.exit(0)
