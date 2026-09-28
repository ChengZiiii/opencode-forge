import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"

// No real fence watcher inside wiring tests: its stdin pipe holds the event
// loop open and the test process would never exit (fence semantics live in
// job-fence.test.mjs and the live 4.1b check).
process.env.FORGE_TEST_NO_FENCE = "1"

// Module-level supervisor state is shared across server() calls; tests run
// in file order. The partition made `auto` and `forge` modes equivalent, so
// no capability-probe ordering trick is needed anymore.
const fakeInput = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: "/w",
  worktree: "/w",
  serverUrl: new URL("http://127.0.0.1:1"),
  $: (() => {}) ,
})

async function hooks(opts) {
  return server(fakeInput(), opts)
}

function freshCfg(agent = undefined) {
  return { ...(agent !== undefined ? { agent } : {}) }
}

test("4.1 tools: forge_shell/forge_jobs registered at stage 0, retired at stage 2", async () => {
  const h0 = await hooks({ jobs: { mode: "forge" } })
  assert.ok(h0.tool.forge_shell, "stage 0 registers forge_shell")
  assert.ok(h0.tool.forge_jobs, "stage 0 registers forge_jobs")
  const h2 = await hooks({ jobs: { mode: "native" } })
  assert.equal(h2.tool.forge_shell, undefined, "stage 2 retires forge_shell")
  assert.equal(h2.tool.forge_jobs, undefined, "stage 2 retires forge_jobs")
})

test("partition config: builtin shell hidden on the forge entry in auto mode; build/plan alive and isolated", async () => {
  const h = await hooks({ jobs: { mode: "auto" } })
  const cfg = freshCfg()
  await h.config(cfg)
  assert.equal(cfg.agent.forge.tools.shell, false)
  assert.equal(cfg.agent.forge.tools.bash, false)
  assert.equal(cfg.agent.forge.mode, "primary")
  // build/plan are no longer disabled; they are isolated from forge tools.
  assert.equal(cfg.agent.build?.disable, undefined)
  assert.equal(cfg.agent.build.tools.forge_shell, false)
  assert.equal(cfg.agent.build.tools.bash, undefined, "builtin shell stays available on build")
  assert.equal(cfg.agent.plan.tools.forge_shell, false)
  // native fallback agents materialized as minimal partition entries
  assert.equal(cfg.agent.general.tools.forge_shell, false)
  assert.equal(cfg.agent.explore.tools.forge_shell, false)
})

test("partition config: a user-defined forge entry gets the exec partition as a key merge", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const cfg = freshCfg({ forge: { prompt: "mine", tools: { write: true, shell: true } } })
  await h.config(cfg)
  assert.equal(cfg.agent.forge.prompt, "mine", "user fields stand")
  assert.equal(cfg.agent.forge.tools.write, true, "unrelated tool entries stand")
  assert.equal(cfg.agent.forge.tools.shell, false, "builtin shell forced off (the single escape hatch is keepBuiltinShell)")
  assert.equal(cfg.agent.forge.tools.bash, false)
})

test("4.2 config: keepBuiltinShell and stage 2 both retain the builtin shell", async () => {
  const h = await hooks({ jobs: { mode: "forge", keepBuiltinShell: true } })
  const cfg = freshCfg()
  await h.config(cfg)
  assert.equal(cfg.agent.forge.tools, undefined)
  const h2 = await hooks({ jobs: { mode: "native" } })
  const cfg2 = freshCfg()
  await h2.config(cfg2)
  assert.equal(cfg2.agent.forge.tools, undefined)
})

test("4.1 config: forge_shell permission rule injected as ask, explicit deny wins", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const cfg = freshCfg()
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "ask")
  const cfg2 = freshCfg()
  cfg2.permission = { forge_shell: "deny" }
  await h.config(cfg2)
  assert.equal(cfg2.permission.forge_shell, "deny")
})

test("4.1 permission.ask belt: forge_shell stays a real ask unless explicitly denied", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const out1 = { status: "allow" }
  await h["permission.ask"]({ id: "forge_shell" }, out1)
  assert.equal(out1.status, "ask")
  const out2 = { status: "deny" }
  await h["permission.ask"]({ id: "forge_shell" }, out2)
  assert.equal(out2.status, "deny")
})

test("partition: system.transform job guidance reaches forge-family sessions, never unknown ones", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  // A delegated forge-* worker session: seeded through chat.message.
  await h["chat.message"]({ sessionID: "subagent-session", agent: "forge-research" }, { message: {}, parts: [] })
  const out = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: "subagent-session" }, out)
  const guidance = out.system.find((s) => s.startsWith("[forge:job-guidance]"))
  assert.ok(guidance)
  assert.match(guidance, /forge_shell/)
  assert.match(guidance, /delegated agents.*poll/i)
  // Unknown sessions carry no forge-authored text at all.
  const out2 = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: "unknown-session" }, out2)
  assert.ok(!out2.system.some((s) => s.startsWith("[forge:")), "unknown session receives no forge text")
})

test("forge-shell-mandate: prompt and guidance compose per config gate", async () => {
  // Default partition: hard refusal wording in both the prompt and the guidance.
  const h = await hooks({ jobs: { mode: "forge" } })
  const cfg = freshCfg()
  await h.config(cfg)
  assert.match(cfg.agent.forge.prompt, /every shell command — quick ones included/)
  assert.match(cfg.agent.forge.prompt, /refused on this agent/)
  await h["chat.message"]({ sessionID: "mandate-ses", agent: "forge" }, { message: {}, parts: [] })
  const out = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: "mandate-ses" }, out)
  const g = out.system.find((s) => s.startsWith("[forge:job-guidance]"))
  assert.match(g, /Every shell command — quick ones included/)
  assert.match(g, /refused on this agent/)
  assert.match(g, /delegated agents.*poll/i)
  // Escape hatch: preference wording; no false refusal claim anywhere.
  const h2 = await hooks({ jobs: { mode: "forge", keepBuiltinShell: true } })
  const cfg2 = freshCfg()
  await h2.config(cfg2)
  assert.match(cfg2.agent.forge.prompt, /prefer the forge_shell tool/)
  assert.ok(!/refused on this agent/.test(cfg2.agent.forge.prompt), "the builtin tool is legitimately present under keepBuiltinShell")
  await h2["chat.message"]({ sessionID: "mandate-ses2", agent: "forge" }, { message: {}, parts: [] })
  const out2 = { system: [] }
  await h2["experimental.chat.system.transform"]({ sessionID: "mandate-ses2" }, out2)
  const g2 = out2.system.find((s) => s.startsWith("[forge:job-guidance]"))
  assert.match(g2, /Long-running or possibly non-exiting/)
  assert.ok(!/refused on this agent/.test(g2))
  // Supervisor retirement: the mandate vanishes with the tool.
  const h3 = await hooks({ jobs: { mode: "native" } })
  const cfg3 = freshCfg()
  await h3.config(cfg3)
  assert.ok(!/forge_shell/.test(cfg3.agent.forge.prompt ?? ""), "no exec-surface mandate under retirement")
  assert.equal(cfg3.agent.forge.tools, undefined)
})

test("partition: capability probe and stage-1 note are retired (no tool.definition hook)", async () => {
  const h = await hooks({ jobs: { mode: "auto" } })
  assert.equal(h["tool.definition"], undefined, "the probe/STAGE1 hook is gone")
  // auto mode hides just like forge mode (equivalent by design).
  const cfg = freshCfg()
  await h.config(cfg)
  assert.equal(cfg.agent.forge.tools.shell, false)
  assert.ok(h.tool.forge_shell, "forge_shell stays registered")
})

test("5.1 events: session.deleted routes to job ownership cleanup without throwing", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_x" } } } })
  await h.event({ event: { type: "session.deleted", properties: {} } })
  assert.ok(true)
})

test("dispose clears job state without throwing", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  await h.dispose()
  assert.ok(true)
})

const toolCtx = (sessionID, askImpl) => ({
  sessionID,
  worktree: mkdtempSync(join(tmpdir(), `forge-wire-${sessionID}-`)),
  ask: askImpl,
  metadata: () => {},
})

test("4.1 forge_shell execute: ask posture gates every run; deny short-circuits", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const asks = []
  const allowCtx = toolCtx("ses_ask", async (req) => {
    asks.push(req)
    return { status: "allow" }
  })
  const res = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "console.log('wired-ok')"`, idle_ms: 8000, max_wait_ms: 15000 },
    allowCtx,
  )
  assert.equal(asks.length, 1, "exactly one ask per run")
  assert.equal(asks[0].permission, "forge_shell")
  assert.match(res.output, /wired-ok/)
  assert.match(res.output, /exit=0/)
  // Deny posture: the ask rejects, the tool rejects, nothing is spawned.
  const denyCtx = toolCtx("ses_deny", async () => {
    throw new Error("user denied")
  })
  await assert.rejects(
    () => h.tool.forge_shell.execute({ command: `"${process.execPath}" -e "console.log('must-not-run')"` }, denyCtx),
    /denied/,
  )
  const listed = await h.tool.forge_jobs.execute({ action: "list" }, denyCtx)
  assert.ok(!String(listed.output).includes("must-not-run"), "denied command never became a job")
})

test("partition: guidance injected exactly once per output (idempotent, family-seeded)", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  await h["chat.message"]({ sessionID: "sub-session", agent: "forge" }, { message: {}, parts: [] })
  const out = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: "sub-session" }, out)
  const first = out.system.filter((s) => s.startsWith("[forge:job-guidance]")).length
  await h["experimental.chat.system.transform"]({ sessionID: "sub-session" }, out)
  const second = out.system.filter((s) => s.startsWith("[forge:job-guidance]")).length
  assert.equal(first, 1)
  assert.equal(second, 1, "re-running the transform on the same output does not duplicate")
})

test("5.1 wake engine: exit queues, only session.idle delivers, exactly once", async () => {
  const sent = []
  const client = {
    session: {
      promptAsync: async (req) => {
        sent.push(req)
      },
      get: async () => ({}),
    },
  }
  const h = await server({ ...fakeInput(), client }, { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses_wake", async () => ({ status: "allow" }))
  const started = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "setTimeout(()=>console.log('done'),150)"`, run_in_background: true },
    ctx,
  )
  assert.match(started.output, /jobId: j-/)
  assert.match(started.output, /logPath: /)
  // Completion rides exit + a short pipe-flush grace; wait until the job is
  // actually terminal (bounded), then assert nothing was delivered while the
  // session was busy.
  const jobId = /jobId: (j-\S+)/.exec(started.output)[1]
  const lineOf = (txt) => String(txt).split("\n").find((l) => l.startsWith(jobId)) ?? ""
  let terminal = false
  for (let i = 0; i < 40 && !terminal; i++) {
    const l = await h.tool.forge_jobs.execute({ action: "list" }, ctx)
    terminal = /\b(exited|killed|succeeded)\b/.test(lineOf(l.output))
    if (!terminal) await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(terminal, "job reached a terminal state within the bound")
  assert.equal(sent.length, 0, "no delivery before the session goes idle")
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_wake" } } })
  assert.equal(sent.length, 1, "exactly one wake on idle")
  assert.equal(sent[0].path.id, "ses_wake")
  assert.match(sent[0].body.parts[0].text, /\[forge:job-complete\]/)
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_wake" } } })
  assert.equal(sent.length, 1, "no duplicate delivery on a second idle")
})

test("terminal evidence: a foreground quick command self-clears — no wake, no registry litter, honest stale id", async () => {
  const sent = []
  const client = {
    session: {
      promptAsync: async (req) => {
        sent.push(req)
      },
      get: async () => ({}),
    },
  }
  const h = await server({ ...fakeInput(), client }, { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses_te", async () => ({ status: "allow" }))
  const res = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "console.log('te-ok')"`, idle_ms: 8000, max_wait_ms: 15000 },
    ctx,
  )
  assert.match(res.output, /te-ok/)
  assert.match(res.output, /self-cleared/, "the inline return announces its own consumption")
  const jobId = /jobId: (j-\S+)/.exec(res.output)[1]
  // A stale verb call self-describes instead of failing as unknown.
  await assert.rejects(() => h.tool.forge_jobs.execute({ action: "poll", jobId }, ctx), /already consumed/)
  // No registry litter: the list never shows the consumed job.
  const listed = await h.tool.forge_jobs.execute({ action: "list" }, ctx)
  assert.ok(!String(listed.output).includes(jobId), "no manual clear needed — the entry is gone")
  // And the idle event delivers nothing: the wake was never queued.
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_te" } } })
  assert.equal(sent.length, 0, "no completion wake for a synchronously consumed job")
})

test("read consumption: a background job polled to terminal self-clears — no wake fires", async () => {
  const sent = []
  const client = {
    session: {
      promptAsync: async (req) => {
        sent.push(req)
      },
      get: async () => ({}),
    },
  }
  const h = await server({ ...fakeInput(), client }, { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses_rc", async () => ({ status: "allow" }))
  const started = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "setTimeout(()=>console.log('rc-done'),120)"`, run_in_background: true },
    ctx,
  )
  const jobId = /jobId: (j-\S+)/.exec(started.output)[1]
  // Poll to completion (the live two-hop shape: output may arrive one poll
  // before the exit; either way the terminal poll consumes the entry).
  let terminal = false
  for (let i = 0; i < 10 && !terminal; i++) {
    const p = await h.tool.forge_jobs.execute({ action: "poll", jobId, waitMs: 30000 }, ctx)
    terminal = !/\brunning\b/.test(String(p.title))
  }
  assert.ok(terminal, "a poll observed the terminal state")
  // The consuming poll already removed the entry: stale verbs self-describe.
  const after = await h.tool.forge_jobs.execute({ action: "list" }, ctx)
  assert.ok(!String(after.output).includes(jobId), "the terminal poll consumed the entry — no manual clear")
  await assert.rejects(() => h.tool.forge_jobs.execute({ action: "poll", jobId }, ctx), /already consumed/)
  // And the idle event delivers nothing: the completion was already read.
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_rc" } } })
  assert.equal(sent.length, 0, "no wake for a poll-read completion")
})

test("read consumption era: a completion arriving during idle is pushed immediately (no further idle edge needed)", async () => {
  const sent = []
  const client = {
    session: {
      promptAsync: async (req) => {
        sent.push(req)
      },
      get: async () => ({}),
    },
  }
  const h = await server({ ...fakeInput(), client }, { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses_push", async () => ({ status: "allow" }))
  // The host fires session.idle when the starting turn ends — the session
  // is now believed idle.
  await h.event({ event: { type: "session.idle", properties: { sessionID: "ses_push" } } })
  const started = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "setTimeout(()=>console.log('push-done'),150)"`, run_in_background: true },
    ctx,
  )
  assert.match(started.output, /jobId: j-/)
  // NO further idle event follows: the wake must be pushed at completion
  // time instead of sitting queued until the delivery window abandons it.
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(sent.length, 1, "the wake fired without a subsequent idle transition")
  assert.equal(sent[0].path.id, "ses_push")
  assert.match(sent[0].body.parts[0].text, /\[forge:job-complete\]/)
})
