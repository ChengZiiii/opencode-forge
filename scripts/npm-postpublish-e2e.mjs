// Postpublish behavioral E2E (catalog-driven-depth-shapes + allow-readonly-recon
// verification): drive a sandbox host whose plugin comes from the npm REGISTRY
// (npm:@sorenllm/opencode-forge — the freshly published version) and verify:
//   A. thoughtLevel "XHigh" normalizes and reaches the anthropic wire as
//      output_config.effort:"xhigh" (boundary normalization + adaptive key,
//      both through the published dist).
//   B. with a draft plan on disk, a scripted task dispatch to forge-scout
//      (readonly) physically passes the shape gate — the scout sub-session
//      really runs (its own catch request) and the refusal wording never
//      appears.
// Usage: node scripts/npm-postpublish-e2e.mjs   (expects dist-tags.latest ==
// the published version; check before running)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { renderPlan } from "../src/plan-file.ts"

const SERVE_PORT = Number(process.env.POSTPUB_SERVE_PORT ?? 43260)
const CATCH_PORT = Number(process.env.POSTPUB_CATCH_PORT ?? 43261)
const MODEL_ID = "claude-opus-4-8-sandbox"
const log = (...a) => console.log(`[postpub ${new Date().toISOString()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- catch server: content-routed fake Anthropic (shape proven by the recon
// E2E driver) ---------------------------------------------------------------------
// Routing keys off the request BODY (deterministic, no queue to desync):
//   count_tokens URL -> token-count JSON (the host calls it; replying SSE here
//                       stalls the SDK turn — the bug this replaced)
//   scout system     -> deterministic scout conclusion
//   tool_result      -> closing text turn
//   otherwise        -> scripted task tool_use dispatching forge-scout
const SCOUT_MARKER = "You are forge-scout"
const SCOUT_TEXT = "Scout report (npm postpublish probe): the workspace root contains .opencode/ and README.md."
const catches = []
const http = await import("node:http")
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    const at = Date.now()
    catches.push({ at, method: req.method, url: req.url, body })
    if (!req.url?.includes("messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ input_tokens: 16 }))
      return
    }
    const sse = (events) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""))
    }
    if (body.includes(SCOUT_MARKER)) {
      sse([
        { type: "message_start", message: { id: "msg_scout", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SCOUT_TEXT } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ])
      return
    }
    if (body.includes('"tool_result"')) {
      sse([
        { type: "message_start", message: { id: "msg_end", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok — dispatch verified" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ])
      return
    }
    sse([
      { type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_postpub", name: "task", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ subagent_type: "forge-scout", description: "postpublish recon probe", prompt: "List the files in the workspace root and report." }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ])
  })
})
await new Promise((r) => srv.listen(CATCH_PORT, "127.0.0.1", r))
log(`catch on :${CATCH_PORT}`)

// --- sandbox: plugin from the npm registry --------------------------------------
const root = mkdtempSync(join(tmpdir(), "postpub-"))
for (const d of ["config", "xdg", "data", "cache", "ws/.opencode"]) mkdirSync(join(root, d), { recursive: true })
const cfgDir = join(root, "config")
const ws = join(root, "ws")
// file:// plugin entries must be PACKAGES (a directory with package.json) —
// a bare .mjs path is silently ignored (archive FINDINGS + today's micro-test).
// Stage the diagnostic probe into a temp package dir when CHATPARAMS_PROBE=1:
// it logs every chat.params input (agent presence per session) to
// %TEMP%/chatparams-probe.log and injects adaptive-key candidate markers
// (top-level effort=low / anthropic.output_config.effort=medium).
let probeEntry = null
if (process.env.CHATPARAMS_PROBE) {
  const probePkg = join(root, "probe-pkg")
  mkdirSync(probePkg, { recursive: true })
  writeFileSync(join(probePkg, "package.json"), JSON.stringify({ name: "chatparams-probe", type: "module", main: "index.mjs" }))
  copyFileSync(join(process.cwd(), "scripts", "chatparams-probe-plugin.mjs"), join(probePkg, "index.mjs"))
  probeEntry = `file://${probePkg.replaceAll("\\", "/")}`
}
writeFileSync(
  join(cfgDir, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: process.env.CHATPARAMS_PROBE
        ? [`file://${process.cwd().replaceAll("\\", "/")}`]
        : ["npm:@sorenllm/opencode-forge"],
      provider: {
        anthropic: {
          npm: "@ai-sdk/anthropic",
          options: { apiKey: "sk-ant-sandbox-dummy", baseURL: `http://127.0.0.1:${CATCH_PORT}/v1` },
          models: { [MODEL_ID]: { name: "Sandbox Adaptive Claude", limit: { context: 200000, output: 8192 } } },
        },
      },
    },
    null,
    2,
  ),
)
// XHigh (mixed case) on purpose: behavior A proves boundary normalization.
writeFileSync(
  join(ws, ".opencode", "forge.json"),
  JSON.stringify({ agents: { scout: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "XHigh" } } }, null, 2),
)
log("sandbox:", root)

// --- serve ----------------------------------------------------------------------
const serve = spawn("opencode", ["serve", "--port", String(SERVE_PORT), "--hostname", "127.0.0.1"], {
  cwd: ws,
  env: {
    ...process.env, // FORGE_DEPTH_PROBE rides through when set
    OPENCODE_CONFIG_DIR: cfgDir,
    XDG_CONFIG_HOME: join(root, "xdg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  },
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
})
let serveLog = ""
serve.stdout.on("data", (d) => (serveLog += d))
serve.stderr.on("data", (d) => (serveLog += d))
const killServeTree = () => {
  spawn(
    "powershell",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -like '*--port ${SERVE_PORT}*' } | ForEach-Object { taskkill /pid $_.ProcessId /T /F }`],
    { stdio: "ignore" },
  )
}
const BASE = `http://127.0.0.1:${SERVE_PORT}`
const DIR = ws.replaceAll("\\", "/")
const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}
let up = false
for (let i = 0; i < 120 && !up; i++) {
  await sleep(1000)
  try {
    const probe = await fetch(`${BASE}/app`)
    if (probe.ok) up = true
  } catch {}
}
if (!up) {
  log("serve never came up:\n" + serveLog.slice(-2000))
  killServeTree(); srv.close(); process.exit(1)
}
log("serve up (npm plugin install may have taken a while on first boot)")

// SSE watcher
const events = []
let watchSession = null
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
        events.push(`${ev.type} ${JSON.stringify(ev.properties ?? {}).slice(0, 400)}`)
        if (ev.type === "session.idle" && ev.properties?.sessionID === watchSession) idleSeen = true
      } catch {}
    }
  }
})().catch(() => {})

const runTurn = async (agent, parts) => {
  const created = await api(`/session?directory=${encodeURIComponent(DIR)}`, { method: "POST", body: JSON.stringify({ agent }) })
  watchSession = created.id
  idleSeen = false
  await api(`/session/${created.id}/message?directory=${encodeURIComponent(DIR)}`, {
    method: "POST",
    body: JSON.stringify({ model: { providerID: "anthropic", modelID: MODEL_ID }, parts }),
  })
  for (let i = 0; i < 90 && !idleSeen; i++) await sleep(1000)
  await sleep(1500)
  return created.id
}

// --- One dispatch, two behaviors --------------------------------------------------
// The /session {agent} field does not bind the session agent on this host
// build (empirically: the request carried the PRIMARY forge prompt), so the
// scout must ride a REAL task dispatch — which is exactly the point:
//   B. the dispatch happens WITH a draft on disk and physically passes the
//      readonly shape gate (scout sub-session runs; refusal never appears);
//   A. that same scout sub-session carries the pinned thoughtLevel "XHigh"
//      and its wire body must show effort:"xhigh" — boundary normalization
//      + adaptive key, both through the published npm dist.
const now = new Date().toISOString()
mkdirSync(join(ws, ".opencode", "plan"), { recursive: true })
writeFileSync(
  join(ws, ".opencode", "plan", "2026-10-10-npm-postpublish-probe.md"),
  renderPlan(
    {
      goal: "npm postpublish behavioral probe",
      context: "hand-written draft resolved via directory fallback",
      approach: "scripted tool_use through the catch server",
      tasks: ["one"],
      risks: "none",
      acceptance: ["scout dispatch completes"],
      nonGoals: [],
    },
    now,
  ),
)
const catchCountBefore = catches.length
const eventsBefore = events.length
const sid = await runTurn("forge", [{ type: "text", text: "Dispatch the scout now." }])
const newCatches = catches.slice(catchCountBefore)
const newEvents = events.slice(eventsBefore).join("\n")
const scoutBodies = newCatches.filter((c) => c.body.includes("You are forge-scout"))
const scoutRan = scoutBodies.length > 0
const refusal = newEvents.includes("dispatch is denied for this target") || newCatches.some((c) => c.body.includes("dispatch is denied"))
const passB = scoutRan && !refusal
const wireA = scoutBodies[0]?.body ?? ""
const passA = wireA.includes('"effort":"xhigh"') && !wireA.includes("XHigh") && wireA.includes(MODEL_ID)
log(`B: scoutRan:${scoutRan} refusalSeen:${refusal}`)
log(`A: scout wire (${wireA.length}B) effort=xhigh:${wireA.includes('"effort":"xhigh"')} rawXHigh:${wireA.includes("XHigh")}`)

// --- teardown + evidence ----------------------------------------------------------
controller.abort()
killServeTree()
await sleep(2500)
srv.close()
const dumpPath = join(tmpdir(), `npm-postpub-evidence-${Date.now()}.json`)
writeFileSync(
  dumpPath,
  JSON.stringify(
    {
      result: { A: passA ? "PASS" : "FAIL", B: passB ? "PASS" : "FAIL" },
      session: sid,
      wireAScoutTurnHead: wireA.slice(0, 600),
      events: events.slice(eventsBefore),
      catches: catches.map((c) => ({ at: c.at, url: c.url, size: c.body.length, head: c.body.slice(0, 300) })),
    },
    null,
    2,
  ),
)
log(`evidence: ${dumpPath}`)
log(`NPM_POSTPUB A=${passA ? "PASS" : "FAIL"} B=${passB ? "PASS" : "FAIL"}`)
rmSync(root, { recursive: true, force: true })
process.exit(passA && passB ? 0 : 1)
