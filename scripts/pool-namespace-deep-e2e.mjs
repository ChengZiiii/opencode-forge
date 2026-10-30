// Deep live E2E for the pool-namespace-contract era (npm-published dist is the
// system under test — plugin channel `npm:@sorenllm/opencode-forge`). Drives a
// hermetic sandbox host (OPENCODE_CONFIG_DIR + XDG triple redirect +
// FORGE_TEST_FORGE_HOME) with a catch-server scripted fake Anthropic; zero
// real model calls. Assertions (openspec change pool-namespace-contract):
//   a. ORIGINAL INCIDENT: one serve, wsA {pool:"plugindev"} + wsB
//      {pool:"sorenunitylabs"}, both with agents.coder -> /config has
//      forge-plugindev-coder AND forge-sorenunitylabs-coder, NO bare
//      forge-coder (the roster pollution that started the change).
//   b. HOST-HISTORY INDEPENDENCE: second fresh serve, workspaces driven in the
//      OPPOSITE order -> sorted forge-* agent key set byte-identical.
//   c. CROSS-POOL DISPATCH REFUSAL (live, real tool belt): task
//      {subagent_type:"forge-plugindev-coder"} from a wsB session -> tool_result
//      contains "not dispatchable from this session" + the wsA pool file path.
//   g. OWN-POOL DISPATCH SUCCESS (live, real tool belt — the positive twin of
//      (c) added after the 0.18.0 live incident): task
//      {subagent_type:"forge-plugindev-coder"} from a wsA session -> the
//      worker RUNS (its report returns as the tool_result) and NO pool
//      refusal appears anywhere in the turn.
//   d. CREW COMPLIANCE GATE (live, real tool surface): wsC forge.json without
//      `pool` -> crew_begin refused ("Pool compliance refused" + file path +
//      suggested ns); after hot-applying "pool":"deepc" -> "Crew record" +
//      "PENDING".
//   e. GLOBAL FALLBACK (live): FORGE_TEST_FORGE_HOME sandbox global layer
//      {agents:{reviewer}}; wsD (no forge.json anywhere up its chain) ->
//      /config contains forge-global-reviewer with the global-origin
//      provenance description.
//   f. PROVENANCE DESCRIPTIONS: forge-plugindev-coder's description carries
//      "Pool 'plugindev' — origin" + the wsA forge.json path + the
//      session-domain dispatchability clause.
// Evidence dump: %TEMP%/poolns-deep-evidence-<ts>.json. Exit non-zero on any
// FAIL; honest NOT-VERIFIED with obstacle when a surface cannot be driven.
// Usage: node scripts/pool-namespace-deep-e2e.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

const SERVE_PORT = Number(process.env.DEEP_SERVE_PORT ?? 43270)
const SERVE_PORT2 = Number(process.env.DEEP_SERVE_PORT2 ?? 43272)
const CATCH_PORT = Number(process.env.DEEP_CATCH_PORT ?? 43271)
const MODEL_ID = "claude-opus-4-8-sandbox"
// Plugin channel under test: the published npm artifact by default; override
// with DEEP_PLUGIN (e.g. "git+file:///<abs repo>") to verify a pre-publish
// build through the official install channel.
const PLUGIN = process.env.DEEP_PLUGIN ?? "npm:@sorenllm/opencode-forge"
const log = (...a) => console.log(`[poolns-deep ${new Date().toISOString()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fold = (p) => p.replaceAll("\\", "/").toLowerCase()
// Lower-case-only matcher for substring containment against live body text:
// descriptions/refusals carry BACKSLASH Windows paths, so slash-folding
// (fold) must never be used to match them (0.18.0 first-run finding).
const lc = (p) => p.toLowerCase()
// Containment of a filesystem path inside a captured HTTP body: the body is
// raw JSON, so the path may appear with JSON-escaped backslashes ("C:\\Users")
// — match the plain OR the escaped variant, case-folded.
const bodyHasPath = (body, p) => {
  const h = body.toLowerCase()
  const n = lc(p)
  return h.includes(n) || h.includes(n.replaceAll("\\", "\\\\"))
}
const excerpt = (s, needle, pad = 220) => {
  const i = s.indexOf(needle)
  return i < 0 ? `(no occurrence of ${JSON.stringify(needle.slice(0, 40))})` : s.slice(Math.max(0, i - pad), i + needle.length + pad)
}

// --- catch server: content-routed fake Anthropic ----------------------------------
// Routing (deterministic, body-keyed): count_tokens -> token JSON; a worker
// sub-session system prompt -> closing text; a follow-up carrying tool_result
// -> closing text (the assertion surface — the tool_result body IS the
// evidence); otherwise route by the user-text marker of the scripted turn.
const catches = []
const http = await import("node:http")
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    catches.push({ at: Date.now(), method: req.method, url: req.url, body })
    if (!req.url?.includes("messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ input_tokens: 16 }))
      return
    }
    const sse = (events) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""))
    }
    const textTurn = (id, text) => [
      { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
    const toolTurn = (id, name, input) => [
      { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]
    // tool_result follow-ups FIRST: scripted-turn bodies also carry the user
    // marker text, so the marker branches must not shadow this one.
    if (body.includes('"tool_result"')) {
      sse(textTurn("msg_end", "ok — tool result observed"))
      return
    }
    if (body.includes("You are forge-")) {
      sse(textTurn("msg_worker", "worker closing (no work expected in this harness)"))
      return
    }
    if (body.includes("CROSSPOOL_PROBE")) {
      sse(toolTurn("toolu_crosspool", "task", { subagent_type: "forge-plugindev-coder", description: "cross-pool refusal probe", prompt: "Report the workspace root contents." }))
      return
    }
    if (body.includes("OWNPOOL_PROBE")) {
      sse(toolTurn("toolu_ownpool", "task", { subagent_type: "forge-plugindev-coder", description: "own-pool success probe", prompt: "Report the workspace root contents." }))
      return
    }
    if (body.includes("CREWPROBE_ONE") || body.includes("CREWPROBE_TWO")) {
      sse(toolTurn("toolu_crew", "crew_begin", { objective: "deep e2e compliance probe", subtasks: [{ title: "probe" }] }))
      return
    }
    sse(textTurn("msg_warm", "warm-up acknowledged"))
  })
})
await new Promise((r) => srv.listen(CATCH_PORT, "127.0.0.1", r))
log(`catch on :${CATCH_PORT}`)

// --- sandbox layout ----------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "poolns-deep-"))
for (const d of ["config", "xdg", "data", "cache", "forgehome/.config/opencode", "wsA/.opencode", "wsB/.opencode", "wsC/.opencode", "wsD"]) {
  mkdirSync(join(root, d), { recursive: true })
}
const cfgDir = join(root, "config")
const forgeHome = join(root, "forgehome")
const wsA = join(root, "wsA")
const wsB = join(root, "wsB")
const wsC = join(root, "wsC")
const wsD = join(root, "wsD")
const forgeJsonA = join(wsA, ".opencode", "forge.json")
const forgeJsonB = join(wsB, ".opencode", "forge.json")
const forgeJsonC = join(wsC, ".opencode", "forge.json")
writeFileSync(
  join(cfgDir, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: [PLUGIN],
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
// The ORIGINAL INCIDENT shape: two workspaces, same agent id "coder", distinct
// pools. Pre-change these collided as one plain "forge-coder".
writeFileSync(forgeJsonA, JSON.stringify({ pool: "plugindev", agents: { coder: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "low", shape: "write", prompt: "coder for the plugindev pool" } } }, null, 2))
writeFileSync(forgeJsonB, JSON.stringify({ pool: "sorenunitylabs", agents: { coder: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "low", shape: "write", prompt: "coder for the sorenunitylabs pool" } } }, null, 2))
// wsC: agents but NO pool field (compliance-gate probe; hot-applied later).
writeFileSync(forgeJsonC, JSON.stringify({ agents: { research: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "low", shape: "readonly", prompt: "research worker" } } }, null, 2))
// Global fallback layer (reached via FORGE_TEST_FORGE_HOME — the resolver
// reads homedir() otherwise).
writeFileSync(join(forgeHome, ".config", "opencode", "forge.json"), JSON.stringify({ agents: { reviewer: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "low", shape: "readonly", prompt: "global reviewer" } } }, null, 2))
// wsD: sibling OUTSIDE the other workspaces, no forge.json anywhere up its
// chain (the temp root carries none) -> global fallback territory.
log("sandbox:", root)

const results = {}
const evidence = { root, catches: catches, excerpts: {}, keys: {} }
const verdict = (name, pass, detail) => {
  results[name] = { result: pass === null ? "NOT-VERIFIED" : pass ? "PASS" : "FAIL", detail }
  log(`${name}: ${results[name].result} — ${detail}`)
}

// --- serve driver -------------------------------------------------------------------
const startServe = (port) => {
  const serve = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: root, // neutral launch anchor: the temp root has no forge.json
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: cfgDir,
      XDG_CONFIG_HOME: join(root, "xdg"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      FORGE_TEST_FORGE_HOME: forgeHome,
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let serveLog = ""
  serve.stdout.on("data", (d) => (serveLog += d))
  serve.stderr.on("data", (d) => (serveLog += d))
  return { serve, getLog: () => serveLog }
}
const killServeTree = (port) => {
  spawn(
    "powershell",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -like '*--port ${port}*' } | ForEach-Object { taskkill /pid $_.ProcessId /T /F }`],
    { stdio: "ignore" },
  )
}
const makeApi = (port) => {
  const BASE = `http://127.0.0.1:${port}`
  return async (path, init) => {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
    const text = await res.text()
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : undefined
  }
}
const waitUp = async (port, getLog) => {
  for (let i = 0; i < 150; i++) {
    await sleep(1000)
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/app`)
      if (probe.ok) return true
    } catch {}
  }
  log(`serve :${port} never came up:\n` + getLog().slice(-2000))
  return false
}

// SSE watcher + scripted-turn driver (per serve).
const makeTurnDriver = (port, api) => {
  const events = []
  let watchSession = null
  let idleSeen = false
  const controller = new AbortController()
  ;(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/event`, { signal: controller.signal })
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
  const runTurn = async (dir, text, expectCatches = 1) => {
    const DIR = dir.replaceAll("\\", "/")
    const created = await api(`/session?directory=${encodeURIComponent(DIR)}`, { method: "POST", body: JSON.stringify({ agent: "forge" }) })
    watchSession = created.id
    idleSeen = false
    const catchCountBefore = catches.length
    await api(`/session/${created.id}/message?directory=${encodeURIComponent(DIR)}`, {
      method: "POST",
      body: JSON.stringify({ model: { providerID: "anthropic", modelID: MODEL_ID }, parts: [{ type: "text", text }] }),
    })
    // Completion signal is CATCH-COUNT driven (deterministic, host-shape
    // agnostic): the scripted turn is done when the expected model calls
    // have reached the catch server. The SSE idle watcher is only an
    // accelerator — on some host builds the /event stream dies early
    // (swallowed connect error) and idle never arrives, which burned the
    // full 90s budget on EVERY turn in the first run.
    for (let i = 0; i < 90 && !idleSeen && catches.length < catchCountBefore + expectCatches; i++) await sleep(1000)
    await sleep(2000)
    return { sid: created.id, newCatches: catches.slice(catchCountBefore), idleSeen }
  }
  return { events, runTurn, close: () => controller.abort() }
}

const forgeKeysOf = (cfg) => Object.keys(cfg?.agent ?? {}).filter((k) => k.startsWith("forge")).sort()
const agentEntry = (cfg, id) => cfg?.agent?.[id]

// driveWorkspace: a session must EXIST (and a chat turn run) in the workspace
// before its pool anchors materialize on this host build; then /config?directory
// reflects the host-wide union from that workspace's viewpoint.
const driveWorkspace = async (api, turn, dir, marker) => {
  const t = await turn.runTurn(dir, `WARMUP ${marker}`)
  if (!t.idleSeen) log(`WARN: warm-up turn in ${marker} never went idle (continuing; obstacle noted)`)
  const DIR = dir.replaceAll("\\", "/")
  const cfg = await api(`/config?directory=${encodeURIComponent(DIR)}`)
  return { turn: t, cfg }
}

// ============================ RUN 1 (order: A B C D) ============================
const s1 = startServe(SERVE_PORT)
const api1 = makeApi(SERVE_PORT)
let run1Keys = null
try {
  if (!(await waitUp(SERVE_PORT, s1.getLog))) throw new Error("serve 1 never came up")
  log("serve 1 up")
  const drv1 = makeTurnDriver(SERVE_PORT, api1)

  const a = await driveWorkspace(api1, drv1, wsA, "WSA")
  const b = await driveWorkspace(api1, drv1, wsB, "WSB")
  evidence.keys.afterAB = forgeKeysOf(b.cfg)

  // (a) THE ORIGINAL INCIDENT SCENARIO — read from the POST-B snapshot
  // (b.cfg, fetched after BOTH workspaces drove; the first run read the
  // pre-wsB a.cfg and "lost" sorenunitylabs to a stale snapshot).
  const keysAB = evidence.keys.afterAB
  const hasPlugindev = keysAB.includes("forge-plugindev-coder")
  const hasSorenunity = keysAB.includes("forge-sorenunitylabs-coder")
  const noBare = !keysAB.includes("forge-coder")
  verdict("a", hasPlugindev && hasSorenunity && noBare, `keys=[${keysAB.join(", ")}] hasPlugindev:${hasPlugindev} hasSorenunitylabs:${hasSorenunity} bare forge-coder absent:${noBare}`)

  // (f) PROVENANCE DESCRIPTIONS (from the post-B snapshot)
  const desc = String(agentEntry(b.cfg, "forge-plugindev-coder")?.description ?? "")
  const fOrigin = desc.includes("Pool 'plugindev' — origin")
  const fPath = desc.toLowerCase().includes(lc(forgeJsonA))
  const fClause = desc.includes("dispatchable only from sessions whose workspace pool is this file")
  evidence.excerpts.f = desc
  verdict("f", fOrigin && fPath && fClause, `origin:${fOrigin} path:${fPath} clause:${fClause} desc="${desc}"`)

  // (g) OWN-POOL DISPATCH SUCCESS (live, through the real tool belt) — the
  // POSITIVE twin of (c) that the first release gate lacked: dispatching the
  // session's OWN workspace-pool agent must go through (worker runs, its
  // report returns as the tool_result, NO pool refusal anywhere).
  const gTurn = await drv1.runTurn(wsA, "OWNPOOL_PROBE: dispatch the plugindev coder now.", 2)
  const gBody = gTurn.newCatches.map((c) => c.body).find((x) => x.includes('"tool_result"')) ?? ""
  const gRan = gBody.includes("worker closing")
  const gNoRefusal = !gBody.includes("not dispatchable from this session") && !gBody.includes("[forge:pool]")
  evidence.excerpts.g = gBody ? excerpt(gBody, "worker closing") : "(no tool_result body captured)"
  verdict("g", gRan && gNoRefusal, `workerRan:${gRan} noPoolRefusal:${gNoRefusal} catches:${gTurn.newCatches.length}`)

  // (c) CROSS-POOL DISPATCH REFUSAL (live, through the real tool belt)
  const cTurn = await drv1.runTurn(wsB, "CROSSPOOL_PROBE: dispatch the plugindev coder now.", 2)
  const cBody = cTurn.newCatches.map((c) => c.body).find((x) => x.includes('"tool_result"')) ?? ""
  const cRefusal = cBody.includes("not dispatchable from this session")
  // The catch body is RAW JSON — Windows backslashes arrive JSON-ESCAPED
  // ("C:\\Users\\…"), so containment needs the escaped variant too (plain
  // single-backslash needles never match; first two runs' c/d1 finding).
  const cPath = bodyHasPath(cBody, forgeJsonA)
  evidence.excerpts.c = cBody ? excerpt(cBody, "not dispatchable from this session") : "(no tool_result body captured)"
  verdict("c", cRefusal && cPath, `refusal:${cRefusal} namesPlugindevPoolPath:${cPath} idle:${cTurn.idleSeen}`)

  // (d) CREW COMPLIANCE GATE (live, through the real tool surface)
  const d1Turn = await drv1.runTurn(wsC, "CREWPROBE_ONE: register the crew now.", 2)
  const d1Body = d1Turn.newCatches.map((c) => c.body).find((x) => x.includes('"tool_result"')) ?? ""
  const d1Lead = d1Body.includes("Pool compliance refused")
  const d1Path = bodyHasPath(d1Body, forgeJsonC)
  const d1Fix = d1Body.includes("Minimal fix")
  evidence.excerpts.d1 = d1Body ? excerpt(d1Body, "Pool compliance refused") : "(no tool_result body captured)"
  verdict("d1", d1Lead && d1Path && d1Fix, `refused:${d1Lead} namesWsCFile:${d1Path} minimalFix:${d1Fix}`)

  // hot-apply "pool":"deepc" into wsC's forge.json, then crew_begin again
  writeFileSync(forgeJsonC, JSON.stringify({ pool: "deepc", agents: { research: { model: `anthropic/${MODEL_ID}`, thoughtLevel: "low", shape: "readonly", prompt: "research worker" } } }, null, 2))
  const cfgC2 = await api1(`/config?directory=${encodeURIComponent(wsC.replaceAll("\\", "/"))}`)
  evidence.keys.wsCAfterHotApply = forgeKeysOf(cfgC2)
  const d2Turn = await drv1.runTurn(wsC, "CREWPROBE_TWO: register the crew now.", 2)
  const d2Body = d2Turn.newCatches.map((c) => c.body).find((x) => x.includes('"tool_result"')) ?? ""
  const d2Record = d2Body.includes("Crew record")
  const d2Pending = d2Body.includes("PENDING")
  evidence.excerpts.d2 = d2Body ? excerpt(d2Body, "Crew record") : "(no tool_result body captured)"
  verdict("d2", d2Record && d2Pending, `crewRecord:${d2Record} pending:${d2Pending} wsC-keys-after-hot-apply=[${evidence.keys.wsCAfterHotApply.join(", ")}]`)

  // (e) GLOBAL FALLBACK (live)
  const eProbe = await driveWorkspace(api1, drv1, wsD, "WSD")
  const eKeys = forgeKeysOf(eProbe.cfg)
  const hasGlobal = eKeys.includes("forge-global-reviewer")
  const eDesc = String(agentEntry(eProbe.cfg, "forge-global-reviewer")?.description ?? "")
  const eProv = eDesc.includes("Pool 'global' — origin: the global fallback layer")
  evidence.keys.wsD = eKeys
  evidence.excerpts.e = eDesc
  verdict("e", hasGlobal && eProv, `forge-global-reviewer:${hasGlobal} provenance:${eProv} keys=[${eKeys.join(", ")}]`)

  // run-1 key set for (b): the PEAK-STATE view — all four workspaces have
  // live sessions at this moment (the e-probe's wsD view, fetched while
  // every anchor is fresh). The serve reaps stale sessions and the union
  // follows, so a run-1 END query from the oldest workspace (wsA) compares
  // a reaped state against run 2's fresh one — apples to oranges. Both runs
  // now compare views taken with all anchors live.
  run1Keys = eKeys
  evidence.keys.run1 = run1Keys
  drv1.close()
} catch (err) {
  verdict("a", false, `run 1 obstacle: ${String(err).slice(0, 400)}`)
  log("run 1 error:", err)
} finally {
  killServeTree(SERVE_PORT)
  await sleep(3000)
}

// ============================ RUN 2 (order: D C B A) ============================
const s2 = startServe(SERVE_PORT2)
const api2 = makeApi(SERVE_PORT2)
let run2Keys = null
try {
  if (!(await waitUp(SERVE_PORT2, s2.getLog))) throw new Error("serve 2 never came up")
  log("serve 2 up (opposite drive order: D C B A)")
  const drv2 = makeTurnDriver(SERVE_PORT2, api2)
  await driveWorkspace(api2, drv2, wsD, "WSD-r2")
  await driveWorkspace(api2, drv2, wsC, "WSC-r2")
  await driveWorkspace(api2, drv2, wsB, "WSB-r2")
  await driveWorkspace(api2, drv2, wsA, "WSA-r2")
  const finalCfg2 = await api2(`/config?directory=${encodeURIComponent(wsA.replaceAll("\\", "/"))}`)
  run2Keys = forgeKeysOf(finalCfg2)
  evidence.keys.run2 = run2Keys
  drv2.close()
} catch (err) {
  log("run 2 error:", err)
} finally {
  killServeTree(SERVE_PORT2)
  await sleep(3000)
}

// (b) HOST-HISTORY INDEPENDENCE
if (run1Keys && run2Keys) {
  const identical = run1Keys.join("\n") === run2Keys.join("\n")
  evidence.orderComparison = { run1: run1Keys, run2: run2Keys, identical }
  verdict("b", identical, `run1(A,B,C,D)=[${run1Keys.join(", ")}] run2(D,C,B,A)=[${run2Keys.join(", ")}] byte-identical(sorted):${identical}`)
} else {
  verdict("b", null, `NOT-VERIFIED — obstacle: ${run1Keys ? "run 2" : "run 1"} never produced a key set (see log above)`)
}

// --- teardown + evidence ------------------------------------------------------------
srv.close()
await sleep(1000)
const dumpPath = join(tmpdir(), `poolns-deep-evidence-${Date.now()}.json`)
writeFileSync(
  dumpPath,
  JSON.stringify(
    {
      result: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.result])),
      details: results,
      keys: evidence.keys,
      orderComparison: evidence.orderComparison ?? null,
      excerpts: evidence.excerpts,
      catches: catches.map((c) => ({ at: c.at, url: c.url, size: c.body.length, head: c.body.slice(0, 200) })),
    },
    null,
    2,
  ),
)
log(`evidence: ${dumpPath}`)
const allOk = Object.values(results).every((r) => r.result === "PASS")
log(`POOLNS_DEEP ${Object.entries(results).map(([k, v]) => `${k}=${v.result}`).join(" ")}`)
rmSync(root, { recursive: true, force: true })
process.exit(allOk ? 0 : 1)
