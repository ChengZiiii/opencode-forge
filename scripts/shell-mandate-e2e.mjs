// Shell-mandate E2E (forge-shell-mandate, 0.8.0): run against a real
// `opencode serve` in npm plugin mode, default partition.
//
// A benign three-command task must flow straight through forge_shell:
//   - >= 3 forge_shell tool calls
//   - ZERO builtin shell/bash tool calls
//   - ZERO "[forge:partition]" refusal lines anywhere in the transcript
//   - all three command outputs reach the model
//
// The keepBuiltinShell escape-hatch leg is carried by unit coverage
// (tests/job-wiring.test.mjs pins tools-shell retention + preference
// wording per gate); a model choosing the builtin tool is not
// deterministic enough to assert.
//
// Usage: node scripts/shell-mandate-e2e.mjs <baseUrl> <absWorkspace>
import { appendFileSync } from "node:fs"

const BASE = process.argv[2] ?? "http://127.0.0.1:43122"
const WS = process.argv[3]
const MODEL = { providerID: "opencode", modelID: "ling-3.0-flash-fin-free" }
const PERM_LOG = "C:/tmp/forge-perm-events-mandate.log"
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
            log("permission approved:", pid)
          }
        } else if (ev.type === "message.part.updated") {
          const part = ev.properties?.part
          if (part?.sessionID !== sid) continue
          if (part.type === "tool") {
            const name = part.tool ?? part.name ?? "?"
            const status = part.state?.status ?? "?"
            const last = toolCalls[toolCalls.length - 1]
            if (last && last.tool === name && last.status === "running" && status === "running") continue
            toolCalls.push({ tool: name, status })
            log(`tool: ${name} (${status})`)
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

await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, {
  method: "POST",
  body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: "Reply with the single word: ok" }] }),
})
log("bootstrap:", await waitForIdle())
await sleep(2000)

const textLenBefore = texts.length
await api(`/session/${sid}/message?directory=${encodeURIComponent(WS)}`, {
  method: "POST",
  body: JSON.stringify({
    model: MODEL,
    parts: [
      {
        type: "text",
        text: 'Run these three commands one after another, each as its own separate tool call, and report each command\'s output: node -e "console.log(11*11)"  |  node -e "console.log(\'second-cmd\')"  |  node -e "console.log(\'third-cmd\')". Then stop.',
      },
    ],
  }),
})
if ((await waitForIdle()) === "timeout") fail("the task turn never idled")
await sleep(3000)

const allText = texts.join("\n")
const taskText = texts.slice(textLenBefore).join("\n")
const names = toolCalls.map((t) => t.tool)
const forgeShellCalls = names.filter((n) => n === "forge_shell").length
const builtinCalls = names.filter((n) => n === "shell" || n === "bash").length
log(`tool calls: ${names.join(", ") || "(none)"}`)
log(`forge_shell=${forgeShellCalls} builtin=${builtinCalls} partition-refusals=${allText.split("[forge:partition]").length - 1}`)

if (builtinCalls > 0) fail(`the model called a builtin shell tool ${builtinCalls} time(s)`)
if (allText.includes("[forge:partition]")) fail("a belt refusal fired — the model tried the builtin shell")
if (forgeShellCalls < 3) fail(`expected >= 3 forge_shell calls, got ${forgeShellCalls}`)
for (const marker of ["121", "second-cmd", "third-cmd"]) {
  if (!taskText.includes(marker)) fail(`command output "${marker}" never reached the model`)
}

controller.abort()
log("PASS: every command went straight through forge_shell — zero builtin attempts, zero belt refusals, all outputs delivered.")
process.exit(0)
