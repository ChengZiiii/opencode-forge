import test from "node:test"
import assert from "node:assert/strict"

import { server } from "../plugin.ts"

// No real fence watcher here: its stdin pipe holds the event loop open
// (same escape hatch as job-wiring.test.mjs).
process.env.FORGE_TEST_NO_FENCE = "1"

// plugin.ts keeps module-level supervisor state across server() calls, so
// this file owns its own process: the FIRST server() call receives a real
// worktree and every return form below is exercised with live spawns.
const input = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: process.cwd(),
  worktree: process.cwd(),
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const allowCtx = (sessionID) => ({
  sessionID,
  ask: async () => ({ status: "allow" }),
  metadata: () => {},
  message: async () => {},
})

test("disclose-exec-cwd: every forge_shell return form carries the actual cwd line", async (t) => {
  const h = await server(input(), { jobs: { mode: "forge" } })
  t.after(() => h.dispose?.())

  const bg = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "setTimeout(()=>{},2000)"`, run_in_background: true },
    allowCtx("ses_cwd"),
  )
  assert.match(bg.output, /^cwd: /m, "background handle carries cwd")
  assert.ok(bg.output.includes(`cwd: ${process.cwd()}`), "cwd is the resolved absolute directory")

  const ex = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "console.log('done')"` },
    allowCtx("ses_cwd"),
  )
  assert.ok(ex.output.includes(`cwd: ${process.cwd()}`), "exited form carries cwd")

  const sr = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "setTimeout(()=>{},8000)"`, idle_ms: 100, max_wait_ms: 20000 },
    allowCtx("ses_cwd"),
  )
  assert.ok(sr.output.includes(`cwd: ${process.cwd()}`), "still-running form carries cwd")

  const sc = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "console.log('READY-42'); setInterval(()=>{},1000)"`, success_pattern: "READY-42", max_wait_ms: 20000 },
    allowCtx("ses_cwd"),
  )
  assert.ok(sc.output.includes(`cwd: ${process.cwd()}`), "succeeded form carries cwd")

  const rel = await h.tool.forge_shell.execute(
    { command: `"${process.execPath}" -e "console.log('r')"`, workdir: "." },
    allowCtx("ses_cwd"),
  )
  assert.ok(rel.output.includes(`cwd: ${process.cwd()}`), "workdir-relative resolves to the absolute disclosure")
})
