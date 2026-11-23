import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Direct-run parity with the suite preload (these tests spawn real jobs).
import "./lib/test-runtime-namespace.mjs"

import { server } from "../plugin.ts"

// fix-shell-spawn-error-outcome (design D3). A command that never started
// is its own return form: title `not started`, first sentence NOT STARTED —
// none of the three sentences that describe a command that ran. The three
// forms that did run are byte-identical to before.

// No real fence watcher inside wiring tests (its stdin pipe holds the event
// loop open).
process.env.FORGE_TEST_NO_FENCE = "1"

const fakeInput = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: "/w",
  worktree: "/w",
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const dirs = []
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const toolCtx = (sessionID) => ({ sessionID, worktree: mk("forge-spawn-err-"), ask: async () => ({ status: "allow" }), metadata: () => {} })
const NEVER = `node -e "console.log('never-ran')"`

test("B1: foreground spawn failure (cwd does not exist) → NOT STARTED form; self-clear unchanged", async () => {
  const h = await server(fakeInput(), { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses-spawn-fg")
  const res = await h.tool.forge_shell.execute({ command: NEVER, workdir: "no-such-dir-fg", max_wait_ms: 15000 }, ctx)

  assert.equal(res.title, "not started")
  const lines = String(res.output).split("\n")
  assert.equal(lines[0], "[forge:job] NOT STARTED — spawn failed; nothing was executed.", "the first sentence says it never ran")
  assert.equal(lines.length, 4, "exactly four lines: verdict, cwd, jobId, spawn error")
  assert.ok(lines[1].startsWith("cwd: ") && lines[1].endsWith("no-such-dir-fg"), `the cwd line names the missing directory; got: ${lines[1]}`)
  assert.match(lines[2], /^jobId: j-/)
  assert.match(lines[3], /^spawn error: \S/)
  assert.doesNotMatch(String(res.output), /Command finished/, "a command that never ran did not finish")
  assert.doesNotMatch(String(res.output), /Output was delivered/, "no output was delivered")
  assert.doesNotMatch(String(res.output), /\noutput:/, "there is no output section")
  assert.doesNotMatch(String(res.output), /never-ran/, "the command text is not echoed as output")

  // Self-clear semantics are untouched: the foreground return delivered the
  // verdict inline, so a later poll reports "already consumed".
  const jobId = /^jobId: (\S+)$/m.exec(String(res.output))[1]
  await assert.rejects(h.tool.forge_jobs.execute({ action: "poll", jobId }, ctx), /already consumed/)
})

test("B2: a normal exit is byte-identical to before", async () => {
  const h = await server(fakeInput(), { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses-spawn-ok")
  const res = await h.tool.forge_shell.execute({ command: `node -e "console.log('ran-ok')"`, idle_ms: 8000, max_wait_ms: 15000 }, ctx)
  assert.equal(res.title, "exit 0")
  const text = String(res.output)
  assert.ok(text.startsWith("[forge:job] Command finished (exit=0).\ncwd: "), `the exited form opens as before; got: ${text.slice(0, 80)}`)
  assert.match(text, /\nOutput was delivered in full above — terminal evidence: the job self-cleared from the registry \(no wake fires, no forge_jobs clear needed\)\.\noutput:\n/)
  assert.match(text, /ran-ok/)
  assert.doesNotMatch(text, /NOT STARTED|spawn error/)
})

test("B3: forge_jobs poll on a job that never started names it in the first sentence", async () => {
  const h = await server(fakeInput(), { jobs: { mode: "forge" } })
  const ctx = toolCtx("ses-spawn-bg")
  const started = await h.tool.forge_shell.execute({ command: NEVER, workdir: "no-such-dir-bg", run_in_background: true }, ctx)
  const jobId = /^jobId: (\S+)$/m.exec(String(started.output))[1]

  // The spawn error reaches the runner asynchronously; poll until the job is
  // terminal (each poll on a running job is a normal window poll).
  let res = null
  for (let i = 0; i < 40 && res === null; i++) {
    const p = await h.tool.forge_jobs.execute({ action: "poll", jobId, waitMs: 1000 }, ctx)
    if (/NOT STARTED/.test(String(p.output))) res = p
    else assert.match(String(p.title), new RegExp(`^${jobId}: running$`), `before the spawn error arrives the job reads as running; got: ${p.title}`)
  }
  assert.ok(res, "the terminal poll names the spawn failure")
  assert.equal(res.title, `${jobId}: not started`)
  const text = String(res.output)
  assert.ok(text.startsWith(`[forge:job] ${jobId}: NOT STARTED — spawn failed; nothing was executed (terminal state: killed).\nspawn error: `), `first sentence + the raw error; got: ${text.slice(0, 200)}`)
  assert.match(text, /\nnew output:\n\(none in this window\)\nlogPath: /)
  assert.doesNotMatch(text, /never-ran/)
})
