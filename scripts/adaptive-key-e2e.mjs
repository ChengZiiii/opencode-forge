// Adaptive-effort key empirical probe (catalog-driven-depth-shapes task 3.2).
//
// Question: which options key does the REAL host (opencode + its patched
// @ai-sdk/anthropic) actually transport to the wire for an adaptive-era
// Claude model when the plugin injects it via chat.params?
//
// Setup: sandbox OPENCODE_CONFIG_DIR; provider id "anthropic" overridden with
// a dummy key and baseURL pointing at a local catch server; a catalog-silent
// model id (claude-opus-4-8-sandbox) that the plugin's prefix-family fallback
// classifies as adaptive-era (major 4, minor 8 >= 4.7); a workspace forge.json
// pinning scout thoughtLevel xhigh. Drive one chat turn as forge-scout; the
// catch server records every POST body. The wire body is ground truth.
//
// Usage: node scripts/adaptive-key-e2e.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const SERVE_PORT = Number(process.env.ADAPT_PROBE_SERVE_PORT ?? 43140)
const CATCH_PORT = Number(process.env.ADAPT_PROBE_CATCH_PORT ?? 43141)
const REPO = process.cwd().replaceAll("\\", "/")
const MODEL_ID = "claude-opus-4-8-sandbox"
const log = (...a) => console.log(`[probe ${new Date().toISOString()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 1. catch server: log every request, answer like Anthropic ----------------
const catches = []
const http = await import("node:http")
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    const entry = { ts: new Date().toISOString(), method: req.method, url: req.url, body }
    catches.push(entry)
    log(`catch: ${req.method} ${req.url} (${body.length}B)`)
    if (!req.url?.includes("messages")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { type: "not_found" } }))
      return
    }
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {}
    if (parsed.stream === false || parsed.stream === undefined) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "msg_sandbox", type: "message", role: "assistant", model: MODEL_ID,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 },
        }),
      )
      return
    }
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_sandbox", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("")
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(sse)
  })
})
await new Promise((r) => srv.listen(CATCH_PORT, "127.0.0.1", r))
log(`catch server on http://127.0.0.1:${CATCH_PORT}`)

// --- 2. sandbox config + workspace -------------------------------------------
const root = mkdtempSync(join(tmpdir(), "adapt-probe-"))
const cfgDir = join(root, "config")
const ws = join(root, "ws")
for (const d of [cfgDir, ws, join(root, "xdg"), join(root, "data"), join(root, "cache")]) mkdirSync(d, { recursive: true })
// The workspace forge.json lives in ws (probe runs with cwd=ws).
mkdirSync(join(ws, ".opencode"), { recursive: true })
const cfg = {
  $schema: "https://opencode.ai/config.json",
  // The forge plugin (file:// repo, reads dist/) PLUS the micro probe plugin
  // that injects candidate option keys (effort / anthropic.output_config).
  plugin: [`file://${REPO}`, `file://${join(REPO, "scripts", "adaptive-key-probe-plugin.mjs")}`],
  provider: {
    anthropic: {
      npm: "@ai-sdk/anthropic",
      options: { apiKey: "sk-ant-sandbox-dummy", baseURL: `http://127.0.0.1:${CATCH_PORT}/v1` },
      models: { [MODEL_ID]: { name: "Sandbox Adaptive Claude", limit: { context: 200000, output: 8192 } } },
    },
  },
}
writeFileSync(join(cfgDir, "opencode.json"), JSON.stringify(cfg, null, 2))
writeFileSync(
  join(ws, ".opencode", "forge.json"),
  JSON.stringify({ agents: { scout: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "xhigh" } } }, null, 2),
)
log("sandbox:", root)

// --- 3. drive the host ---------------------------------------------------------
const serve = spawn("opencode", ["serve", "--port", String(SERVE_PORT), "--hostname", "127.0.0.1"], {
  cwd: ws,
  env: {
    ...process.env,
    OPENCODE_CONFIG_DIR: cfgDir,
    // OPENCODE_CONFIG_DIR alone does NOT isolate the plugin/provider list on
    // opencode 1.18.x (global ~/.config/opencode leaks in) — pin the XDG trio
    // into the sandbox too (empirical finding from the recon E2E wave).
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  },
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
})
const killServeTree = () => {
  if (!serve.pid) return serve.kill()
  if (process.platform === "win32") {
    // shell:true detaches the real opencode.exe from the shell pid, so kill
    // by command-line marker (our port) via CIM, then the shell tree too.
    spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -like '*--port ${SERVE_PORT}*' } | ForEach-Object { taskkill /pid $_.ProcessId /T /F }`,
      ],
      { stdio: "ignore" },
    )
    spawn("taskkill", ["/pid", String(serve.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    serve.kill("SIGKILL")
  }
}
let serveLog = ""
serve.stdout.on("data", (d) => (serveLog += d))
serve.stderr.on("data", (d) => (serveLog += d))

const BASE = `http://127.0.0.1:${SERVE_PORT}`
const DIR = ws.replaceAll("\\", "/") // the API rejects backslash paths (400)
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

let sid = null
for (let i = 0; i < 90 && !sid; i++) {
  await sleep(1000)
  try {
    const probe = await fetch(`${BASE}/app`)
    if (probe.ok) sid = "up"
  } catch {}
}
if (!sid) {
  log("serve never came up:\n" + serveLog.slice(-2000))
  srv.close(); killServeTree(); process.exit(1)
}
log("serve is up")

// SSE idle watcher for our session
let realSid = null
let idleSeen = false
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
        if (ev.type === "session.idle" && ev.properties?.sessionID === realSid) {
          idleSeen = true
          log("session.idle for our session")
        }
      } catch {}
    }
  }
})().catch(() => {})

// Session bound to the forge-scout agent (the materialized worker with the
// pinned thoughtLevel). Agent on session create; model on the message.
const created = await api(`/session?directory=${encodeURIComponent(DIR)}`, {
  method: "POST",
  body: JSON.stringify({ agent: "forge-scout" }),
})
realSid = created.id
log("session:", realSid, "agent=forge-scout")

await api(`/session/${realSid}/message?directory=${encodeURIComponent(DIR)}`, {
  method: "POST",
  body: JSON.stringify({
    model: { providerID: "anthropic", modelID: MODEL_ID },
    parts: [{ type: "text", text: "Reply with the single word: ok" }],
  }),
})
for (let i = 0; i < 60 && !idleSeen; i++) await sleep(1000)
await sleep(2000)
controller.abort()
killServeTree()
await sleep(2500) // let the detached taskkill sweeps finish before exit
srv.close()

// --- 4. report ----------------------------------------------------------------
log(`caught ${catches.length} request(s)`)
const dumpPath = join(tmpdir(), `adaptive-key-catch-${Date.now()}.json`)
writeFileSync(dumpPath, JSON.stringify(catches, null, 2))
for (const [i, c] of catches.entries()) {
  log(`--- catch #${i}: ${c.method} ${c.url}`)
  const probe = c.body.length > 1400 ? c.body.slice(0, 700) + "\n    [...mid omitted...]  " + c.body.slice(-700) : c.body
  log("    body:", probe)
}
log("full dump:", dumpPath)
log("workspace:", ws, "(kept for inspection)")
log("sandbox cfg:", cfgDir, "(kept for inspection)")
if (catches.length === 0) {
  log("NO REQUESTS reached the catch server — check serve log:\n" + serveLog.slice(-2000))
  process.exit(1)
}
