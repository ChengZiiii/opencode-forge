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
// in file order and the capability-probe test (which latches stage 1) runs
// LAST so earlier assertions see the pristine stage-0 state.
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

test("4.2 config: builtin shell hidden on the plugin-created forge entry (stage 0)", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const cfg = freshCfg()
  await h.config(cfg)
  assert.equal(cfg.agent.forge.tools.shell, false)
  assert.equal(cfg.agent.forge.tools.bash, false)
  assert.equal(cfg.agent.build.disable, true)
  assert.equal(cfg.agent.forge.mode, "primary")
})

test("4.2 config: a user-defined forge entry is never touched", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const cfg = freshCfg({ forge: { prompt: "mine" } })
  await h.config(cfg)
  assert.equal(cfg.agent.forge.prompt, "mine")
  assert.equal(cfg.agent.forge.tools, undefined, "no shell-hide injected into a user-defined entry")
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

test("4.3 system.transform: job guidance reaches sessions not in the map (subagents)", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
  const out = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: "subagent-session-not-in-map" }, out)
  const guidance = out.system.find((s) => s.startsWith("[forge:job-guidance]"))
  assert.ok(guidance)
  assert.match(guidance, /forge_shell/)
  assert.match(guidance, /delegated agents.*poll/i)
})

test("5.2 probe: native run_in_background in the shell schema latches stage 1", async () => {
  const h = await hooks({ jobs: { mode: "auto" } })
  const desc = "native shell"
  const out = { description: desc, parameters: { properties: { command: {}, run_in_background: {} } } }
  await h["tool.definition"]({ toolID: "shell" }, out)
  assert.equal(out.description, desc, "probe is read-only")
  // Stage 1 evidence latched: the shell-hide stops applying on a fresh config.
  const cfg = freshCfg()
  await h.config(cfg)
  assert.equal(cfg.agent.forge.tools, undefined, "stage 1 stops hiding the builtin shell")
  assert.ok(h.tool.forge_shell, "stage 1 keeps forge_shell as the additive layer")
  // D10 stage-1 action on our own tool: the native-first note is prepended
  // (idempotently) to forge_shell's description.
  const mine = { description: "base description", parameters: { properties: {} } }
  await h["tool.definition"]({ toolID: "forge_shell" }, mine)
  assert.match(mine.description, /^Stage note: this host's builtin shell already offers/)
  const once = mine.description
  await h["tool.definition"]({ toolID: "forge_shell" }, mine)
  assert.equal(mine.description, once, "note is prepended exactly once")
  // Stage 2 retires forge_shell entirely, so no rewrite applies there.
  const h2 = await hooks({ jobs: { mode: "native" } })
  const late = { description: "base description", parameters: { properties: {} } }
  await h2["tool.definition"]({ toolID: "forge_shell" }, late)
  assert.equal(late.description, "base description")
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

test("4.3 system.transform: guidance injected exactly once per output (idempotent)", async () => {
  const h = await hooks({ jobs: { mode: "forge" } })
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
