import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"
import { resolveHeadlessMode } from "../src/headless.ts"

// Headless ask liveness (dispatch-resilience fold A, spec tool-partition —
// "Headless ask liveness on the exec surface"): unit coverage of the pure
// host-property resolver + wiring coverage of the 8 delta scenarios at the
// gate/config-hook/belt seams, in the exec-seal-wiring / job-wiring style.

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-headless-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

const worktree = mkdtempSync(join(tmpdir(), "forge-headless-wiring-"))
process.on("exit", () => {
  for (const d of [worktree, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Unit: the pure resolver
// ---------------------------------------------------------------------------

test("headless unit: serve argv token is headless; run and TUI argv are not", () => {
  assert.equal(resolveHeadlessMode({}, ["/usr/bin/opencode", "serve"]), true, "single-binary serve")
  assert.equal(resolveHeadlessMode({}, ["bun", "/opt/opencode/bin/opencode", "serve"]), true, "bun serve")
  assert.equal(resolveHeadlessMode({}, ["node", "/opt/opencode/bin/opencode", "serve"]), true, "node serve")
  assert.equal(resolveHeadlessMode({}, ["/usr/bin/opencode", "run", "-m", "x"]), false, "run mode is NOT headless")
  assert.equal(resolveHeadlessMode({}, ["/usr/bin/opencode"]), false, "TUI is not headless")
  assert.equal(resolveHeadlessMode({}, ["/usr/bin/serve", "run"]), false, "argv[0] named serve does not trip (skipped)")
  assert.equal(resolveHeadlessMode({}, ["/usr/bin/opencode", "/srv/serve/x.ts"]), false, "path token is not a serve token")
})

test("headless unit: FORGE_HEADLESS forces both directions; invalid values fall back to auto", () => {
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "1" }, ["/usr/bin/opencode"]), true)
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "0" }, ["/usr/bin/opencode", "serve"]), false)
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "true" }, []), true)
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "false" }, ["/bin/opencode", "serve"]), false)
  // Invalid values fall back to the default (auto-detect) — env-knob tolerance.
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "yes" }, ["/bin/opencode", "serve"]), true)
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "yes" }, ["/bin/opencode", "run"]), false)
  assert.equal(resolveHeadlessMode({ FORGE_HEADLESS: "" }, ["/bin/opencode", "run"]), false)
})

// ---------------------------------------------------------------------------
// Wiring: the gate, the config snapshot, the belt
// ---------------------------------------------------------------------------

const input = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: worktree,
  worktree,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

let lastHost = null
async function hooks() {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(input(), {})
  return lastHost
}

const toolCtx = (sessionID, askImpl) => ({
  sessionID,
  worktree: mkdtempSync(join(tmpdir(), `forge-headless-ctx-${sessionID}-`)),
  ask: askImpl,
  metadata: () => {},
  message: async () => {},
})

// FORGE_HEADLESS save/restore + snapshot isolation per test.
const withHeadless = async (t, value, fn) => {
  const prev = process.env.FORGE_HEADLESS
  if (value === undefined) delete process.env.FORGE_HEADLESS
  else process.env.FORGE_HEADLESS = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.FORGE_HEADLESS
    else process.env.FORGE_HEADLESS = prev
    t && (await null)
  }
}

const READ_CMD = `node -e "console.log('headless-ok')"`
const WRITE_CMD = "npm install left-pad" // pkg-mutation indicator, head "npm"

test("headless gate: READ-class proceeds with NO dialog awaited (the previously-hanging shape)", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  await withHeadless(t, "1", async () => {
    const asks = []
    const ctx = toolCtx("ses_hl_read", async (req) => {
      asks.push(req)
      return { status: "allow" }
    })
    const res = await h.tool.forge_shell.execute({ command: READ_CMD, idle_ms: 8000, max_wait_ms: 20000 }, ctx)
    assert.equal(asks.length, 0, "no ask is ever awaited headlessly")
    assert.match(res.output, /headless-ok/)
    assert.match(res.output, /exit=0/)
  })
})

test("headless gate: WRITE-class refuses with [forge:headless-denied] naming the command head; nothing spawns", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  await withHeadless(t, "1", async () => {
    const asks = []
    const ctx = toolCtx("ses_hl_write", async (req) => {
      asks.push(req)
      return { status: "allow" }
    })
    await assert.rejects(
      () => h.tool.forge_shell.execute({ command: WRITE_CMD }, ctx),
      (err) => {
        const m = err instanceof Error ? err.message : String(err)
        assert.match(m, /^\[forge:headless-denied\]/, "the honest error prefix")
        assert.match(m, /Command head: npm/, "the command head is named")
        assert.match(m, /pkg-mutation/, "the classified indicator is named")
        assert.match(m, /VERBATIM/, "the worker is told to report verbatim")
        return true
      },
    )
    assert.equal(asks.length, 0, "no dialog was awaited")
    const listed = await h.tool.forge_jobs.execute({ action: "list" }, ctx)
    assert.ok(!String(listed.output).includes("left-pad"), "the refused command never became a job")
  })
})

test("headless gate: unclassifiable commands flow headlessly (disclosed bypass surface)", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  await withHeadless(t, "1", async () => {
    // `node -e` writing a file internally: no indicator trips — READ-class.
    const res = await h.tool.forge_shell.execute(
      { command: `node -e "console.log('unclassified-ok')"`, idle_ms: 8000, max_wait_ms: 20000 },
      toolCtx("ses_hl_flow", async () => ({ status: "allow" })),
    )
    assert.match(res.output, /unclassified-ok/)
  })
})

test("snapshot: explicit allow skips the ask in headless AND interactive; the rule keeps allow", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cfg = { permission: { forge_shell: "allow" } }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "allow", "the carve-out keeps the explicit allow in the rule")
  assert.equal(h.__forgeSubagentsTest.gateSnapshot().forge_shell, "allow")
  // Headless + WRITE-class under explicit allow: runs, no ask.
  await withHeadless(t, "1", async () => {
    const asks = []
    const ctx = toolCtx("ses_allow_hl", async (req) => {
      asks.push(req)
      return { status: "allow" }
    })
    const res = await h.tool.forge_shell.execute(
      { command: `node -e "console.log('allow-hl')" > out.txt`, idle_ms: 8000, max_wait_ms: 20000 },
      ctx,
    )
    assert.equal(asks.length, 0, "explicit allow skips the ask headlessly")
    assert.match(res.output, /exit=0/, "the WRITE-class command RAN under explicit allow (redirected output)")
  })
  // Interactive (run mode's ask path alike — run mode is NOT headless) + WRITE-class: also no ask.
  await withHeadless(t, "0", async () => {
    const asks = []
    const res = await h.tool.forge_shell.execute(
      { command: `node -e "console.log('allow-tui')" > out.txt`, idle_ms: 8000, max_wait_ms: 20000 },
      toolCtx("ses_allow_tui", async (req) => {
        asks.push(req)
        return { status: "allow" }
      }),
    )
    assert.equal(asks.length, 0, "explicit allow skips the ask in interactive mode too")
    assert.match(res.output, /exit=0/, "the WRITE-class command RAN under explicit allow")
  })
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("snapshot: explicit deny refuses everywhere, before any ask", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cfg = { permission: { forge_shell: "deny" } }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "deny", "deny is never overridden")
  for (const mode of ["1", "0"]) {
    await withHeadless(t, mode, async () => {
      const asks = []
      await assert.rejects(
        () =>
          h.tool.forge_shell.execute(
            { command: READ_CMD },
            toolCtx(`ses_deny_${mode}`, async (req) => {
              asks.push(req)
              return { status: "allow" }
            }),
          ),
        /explicitly denied by user configuration/,
      )
      assert.equal(asks.length, 0, `deny refuses without an ask (FORGE_HEADLESS=${mode})`)
    })
  }
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("snapshot anti-recapture: a re-presented config carrying the plugin's own injected ask is never captured", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  // First pass: no explicit value — the hook injects "ask".
  const cfg = { permission: {} }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "ask")
  // Re-present the SAME mutated merged object (the host re-present trap).
  await h.config(cfg)
  assert.equal(h.__forgeSubagentsTest.gateSnapshot().forge_shell, undefined, "the injected ask is not recaptured as explicit")
  // Belt: a wildcard-ish allow output is still forced to a real ask (no snapshot entry).
  const out = { status: "allow" }
  await h["permission.ask"]({ id: "forge_shell" }, out)
  assert.equal(out.status, "ask")
  // A later genuine user allow IS captured (last explicit wins) and re-presentation keeps it.
  const cfg2 = { permission: { forge_shell: "allow" } }
  await h.config(cfg2)
  await h.config(cfg2)
  assert.equal(h.__forgeSubagentsTest.gateSnapshot().forge_shell, "allow")
  const out2 = { status: "ask" }
  await h["permission.ask"]({ id: "forge_shell" }, out2)
  assert.equal(out2.status, "allow", "the belt honors the explicit allow carve-out")
  // Doors are exempt: an explicit allow on a door is still rewritten to ask.
  const cfg3 = { permission: { plan_approve: "allow" } }
  await h.config(cfg3)
  assert.equal(cfg3.permission.plan_approve, "ask", "doors keep the full rewrite — they stay real dialogs")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("doors: plan_approve is never auto-resolved headlessly — the ask remains a real pending dialog", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  await withHeadless(t, "1", async () => {
    const planCtx = toolCtx("ses_door", async () => ({ status: "allow" }))
    await h.tool.plan_write.execute(
      { goal: "g", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] },
      planCtx,
    )
    const asks = []
    const rejectCtx = toolCtx("ses_door", async (req) => {
      asks.push(req)
      throw new Error("user denied")
    })
    await assert.rejects(
      () => h.tool.plan_approve.execute({}, rejectCtx),
      /user denied/,
      "the gate still awaits a real ask — the headless classifier does not touch doors",
    )
    assert.equal(asks.length, 1)
    assert.equal(asks[0].permission, "plan_approve")
  })
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("run mode keeps its ask auto-reject posture (default posture, FORGE_HEADLESS=0 interactive path)", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  await withHeadless(t, "0", async () => {
    // Default posture: the ask fires even for a WRITE-class command — the
    // classifier never bypasses it outside headless; a rejecting ask (run
    // mode auto-rejects asks) refuses the call.
    const asks = []
    const ctx = toolCtx("ses_runmode", async (req) => {
      asks.push(req)
      throw new Error("ask auto-rejected (run mode)")
    })
    await assert.rejects(() => h.tool.forge_shell.execute({ command: WRITE_CMD }, ctx), /ask auto-rejected/)
    assert.equal(asks.length, 1, "the two-piece ask dialog fired, unchanged")
  })
})

test("seal-before-headless: a readonly worker's WRITE-class call gets the seal finding, not the headless denial", async (t) => {
  // The readonly-exec-seal lives in tool.execute.before — structurally
  // BEFORE the tool execute (where the headless branch lives), so the seal
  // finding lands first. This test drives the before-hook the same order
  // the host does: before, then execute.
  const dir = mkdtempSync(join(tmpdir(), "forge-headless-seal-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir, ".opencode", "forge.json"),
    JSON.stringify({ pool: "hlseal", agents: { reviewer: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" } } }),
  )
  const serverInput = { ...input(), directory: dir, worktree: dir }
  const h = await server(serverInput, {})
  t.after(() => h.dispose?.())
  await h.config({ agent: {}, command: {}, permission: {} })
  h.__forgeSubagentsTest.resetGateSnapshot()
  await h["chat.message"]({ sessionID: "ses_seal_hl", agent: "forge-hlseal-reviewer" })
  await withHeadless(t, "1", async () => {
    // The host order: tool.execute.before first — it throws the seal finding
    // and the execute (with the headless branch) is never reached.
    await assert.rejects(
      () =>
        h["tool.execute.before"](
          { tool: "forge_shell", sessionID: "ses_seal_hl", callID: "sh1" },
          { args: { command: "node build.js > out.txt" } },
        ),
      (err) => {
        const m = String(err)
        assert.match(m, /forge:seal/, "the seal finding is the surfaced error")
        assert.ok(!m.includes("forge:headless-denied"), "not the headless denial")
        return true
      },
    )
    // READ-class through the same seal: passes the before-hook, and the
    // headless gate then proceeds it without a dialog (compose, both green).
    await h["tool.execute.before"](
      { tool: "forge_shell", sessionID: "ses_seal_hl", callID: "sh2" },
      { args: { command: READ_CMD } },
    )
    const asks = []
    const res = await h.tool.forge_shell.execute(
      { command: READ_CMD, idle_ms: 8000, max_wait_ms: 20000 },
      toolCtx("ses_seal_hl", async (req) => {
        asks.push(req)
        return { status: "allow" }
      }),
    )
    assert.equal(asks.length, 0)
    assert.match(res.output, /headless-ok/)
  })
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("env override wiring: FORGE_HEADLESS flips the gate behavior both directions", async (t) => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  // Forced interactive (argv here has no serve token anyway): default
  // posture asks — the ask fires and must be answered.
  await withHeadless(t, "0", async () => {
    const asks = []
    await h.tool.forge_shell.execute(
      { command: READ_CMD, idle_ms: 8000, max_wait_ms: 20000 },
      toolCtx("ses_flip0", async (req) => {
        asks.push(req)
        return { status: "allow" }
      }),
    )
    assert.equal(asks.length, 1, "FORGE_HEADLESS=0 → the dialog fires")
  })
  // Forced headless: no dialog.
  await withHeadless(t, "1", async () => {
    const asks = []
    await h.tool.forge_shell.execute(
      { command: READ_CMD, idle_ms: 8000, max_wait_ms: 20000 },
      toolCtx("ses_flip1", async (req) => {
        asks.push(req)
        return { status: "allow" }
      }),
    )
    assert.equal(asks.length, 0, "FORGE_HEADLESS=1 → resolved without any dialog")
  })
  h.__forgeSubagentsTest.resetGateSnapshot()
})
