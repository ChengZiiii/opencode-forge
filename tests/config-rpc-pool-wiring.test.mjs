import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — PERSISTENT MOCK WIRING REGRESSION for the
// parent-pool shape (2026-11-27 probe baseline, archive
// 2026-11-27-forge-tui-subagent-config-probes workspace-pool-wiring-repro-0362
// + workspace-pool-multireg-repro-0362b).
//
// *** THIS IS A MOCK-HOST WIRING TEST, NOT E2E ***
// It exercises the REAL plugin setup (v2Setup) and the REAL registered RPC
// handlers (echo/editOpen) against a REAL temp fs fixture, but the host
// around them is the repo's mock context (tests/lib/v2-mock-context.mjs) and
// handlers are invoked DIRECTLY — there is no real OpenCode server, no real
// wire, no schema stripping, no official client.rpc transport. E2E truth
// (real host wire behavior) is covered by separate live probes.
//
// Fixture (real temp fs, FORGE_TEST_FIXTURE_ROOT pins every recipe read —
// the real user config is NEVER touched):
//   <tmp>/parent/.opencode/forge.json   pool "plugindev", 5 workers
//   <tmp>/parent/child-repo/            child repo, no pool of its own
// anchors: parent AND child-repo; the session (and the registration
// location) live at the child repo; the walk-up discovery must hit the
// PARENT pool.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { v2Setup, v2WiringSeam } = await import("../plugin.ts")
const { createV2MockContext } = await import("./lib/v2-mock-context.mjs")
const { documentViewOf } = await import("../src/tui/entries.ts")

const SID = "sess-pool-wiring-1"

// The frozen EditOpenOk contract fields (rpc.ts editOpenOkSchema required —
// every field the wire MUST carry; asserted present with correct types so a
// fixture drift or an implementation relaxation cannot pass silently).
const EDIT_OPEN_OK_REQUIRED = [
  "ok", "snapshotId", "path", "targetIdentity", "scope", "sessionID", "observedLocation",
  "anchor", "epoch", "generation", "expiresAt", "exists", "readable", "creatable",
  "identity", "raw", "document", "parseError", "findings",
]

const POOL_JSON = {
  pool: "plugindev",
  agents: {
    "worker-one": { model: "anthropic/claude-sonnet-4-5", thoughtLevel: "high" },
    "worker-two": { prompt: "auto worker two" },
    "worker-three": { model: "openai/gpt-5.1-codex", thoughtLevel: "medium", prompt: "pinned three" },
    "worker-four": { prompt: "auto worker four", shape: "write" },
    "worker-five": { model: "google/gemini-3-pro", thoughtLevel: "low" },
  },
}

function makeFixture() {
  const home = mkdtempSync(path.join(tmpdir(), "forge-poolwiring-"))
  const parent = path.join(home, "parent")
  const child = path.join(parent, "child-repo")
  mkdirSync(path.join(parent, ".opencode"), { recursive: true })
  mkdirSync(child, { recursive: true })
  const poolFile = path.join(parent, ".opencode", "forge.json")
  writeFileSync(poolFile, JSON.stringify(POOL_JSON, null, 2))
  return { home, parent, child, poolFile, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch {} } }
}

// One wired registration over the real temp tree. `sessionAnswer` fixes what
// the host session.get seam reports for SID (the child repo in every healthy
// shape here).
async function wire(fixture, opts = {}) {
  const prevFixture = process.env.FORGE_TEST_FIXTURE_ROOT
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  const prevNoFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH
  process.env.FORGE_TEST_FIXTURE_ROOT = fixture.home
  process.env.FORGE_TEST_FORGE_HOME = fixture.home
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

  const ctx = createV2MockContext()
  const location = opts.location ?? fixture.child
  ctx.location = { directory: location, worktree: location }
  let handlers = null
  let registration = null
  ctx.rpc = {
    register: (_definition, registered) => {
      handlers = registered
      const reg = { disposed: false, dispose: async () => { reg.disposed = true } }
      registration = reg
      return reg
    },
  }
  ctx.session = {
    get: async ({ sessionID }) => ({ location: { directory: opts.sessionAnswer ?? fixture.child }, sessionID }),
  }
  await v2Setup(ctx, { anchors: opts.anchors ?? [fixture.parent, fixture.child], homeDir: path.join(fixture.home, "fg-home") })
  const cleanup = async () => {
    try { await registration?.dispose() } catch {}
    try { v2WiringSeam.sessionMovedAnchors.delete(SID) } catch {}
    try { v2WiringSeam.sessions?.delete?.(SID) } catch {}
    try { v2WiringSeam.resetHostAnchors?.() } catch {}
    process.env.FORGE_TEST_FIXTURE_ROOT = prevFixture
    process.env.FORGE_TEST_FORGE_HOME = prevHome
    process.env.FORGE_TEST_NO_DISPATCH_FETCH = prevNoFetch
  }
  return { handlers, cleanup }
}

function assertEditOpenContractShape(out, label) {
  for (const key of EDIT_OPEN_OK_REQUIRED) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, key), `${label}: the editOpen ok answer carries the frozen contract field "${key}" — got keys: ${Object.keys(out).join(",")}`)
  }
  assert.equal(out.ok, true, `${label}: ok:true`)
  assert.equal(typeof out.snapshotId, "string", `${label}: snapshotId is a string handle`)
  assert.equal(typeof out.exists, "boolean", `${label}: exists is a REAL boolean from the server stat (never undefined/falsy-by-shape)`)
  assert.equal(out.parseError, null, `${label}: parseError null on a parsed document`)
}

test("pool wiring (MOCK, not E2E): parent pool + child repo — echo round-trips, workspace editOpen binds the PARENT pool with 5 UI workers", { timeout: 60_000 }, async () => {
  const fx = makeFixture()
  const env = await wire(fx)
  try {
    // echo: the nonce round-trips EXACTLY (adjudication input; the output
    // contract carries nonce/pluginID/epoch/generation, no `ok` field).
    const echo = await env.handlers.echo({ nonce: "n-pool-wiring" })
    assert.equal(echo.nonce, "n-pool-wiring", "echo round-trips the nonce verbatim")
    assert.equal(echo.pluginID, "forge", "echo identifies the forge plugin")

    for (const [label, input] of [
      ["workspace+session(child)", { scope: "workspace", sessionID: SID }],
      ["workspace+null(home=child)", { scope: "workspace", sessionID: null }],
    ]) {
      const ed = await env.handlers.editOpen(input)
      assertEditOpenContractShape(ed, label)
      assert.equal(ed.scope, "workspace", `${label}: the answer echoes the requested scope`)
      assert.equal(ed.sessionID, input.sessionID, `${label}: the answer echoes the requested sessionID`)
      assert.equal(ed.exists, true, `${label}: the PARENT pool is found via walk-up (exists from the real stat)`)
      assert.equal(ed.creatable, false, `${label}: an owning pool is never "creatable"`)
      assert.ok(
        ed.path === fx.poolFile || ed.path.replace(/\\/g, "/") === fx.poolFile.replace(/\\/g, "/"),
        `${label}: the resolved path is the parent pool — got ${ed.path}`,
      )
      assert.equal(ed.observedLocation, fx.child, `${label}: the binding carries the child location`)
      assert.equal(ed.anchor, fx.child, `${label}: the workspace anchor is the child repo`)
      // The UI Document projection: 5 workers, no parse problems.
      const view = documentViewOf(ed)
      assert.equal(view.existed, true, `${label}: UI view marks the pool existing`)
      assert.equal(view.parseOk, true, `${label}: the pool parses for the UI`)
      assert.equal(view.workers.length, 5, `${label}: all five workers project into the UI document`)
      assert.deepEqual(
        view.workers.map((w) => w.id),
        ["worker-one", "worker-two", "worker-three", "worker-four", "worker-five"],
        `${label}: the worker ids survive into the UI view`,
      )
    }
  } finally {
    await env.cleanup()
    fx.cleanup()
  }
})

test("pool wiring (MOCK, not E2E): global scope answers anchor:null + observedLocation=child; missing global recipe is a legal creation target", { timeout: 60_000 }, async () => {
  const fx = makeFixture()
  const env = await wire(fx)
  try {
    const ed = await env.handlers.editOpen({ scope: "global", sessionID: null })
    assertEditOpenContractShape(ed, "global+null")
    assert.equal(ed.scope, "global")
    assert.equal(ed.anchor, null, "the global layer carries anchor:null")
    assert.equal(ed.observedLocation, fx.child, "the binding carries the server-observed location")
    assert.equal(ed.exists, false, "the test-home global recipe is absent")
    assert.equal(ed.creatable, true, "the absent global recipe is a legal explicit creation target")
  } finally {
    await env.cleanup()
    fx.cleanup()
  }
})

test("pool wiring (MOCK, not E2E): TWO registrations (parent + child setup domains) — both stores resolve the parent pool, null-session bindings stay per-location", { timeout: 60_000 }, async () => {
  const fx = makeFixture()
  const childEnv = await wire(fx)
  const parentEnv = await wire(fx, { location: fx.parent }) // second registration; epoch rotates again
  try {
    const fromChild = await childEnv.handlers.editOpen({ scope: "workspace", sessionID: null })
    assertEditOpenContractShape(fromChild, "child-reg null")
    assert.equal(fromChild.exists, true, "the child registration still serves after the second registration rotated the epoch")
    assert.equal(fromChild.observedLocation, fx.child, "child registration null-session binds the child location")
    assert.ok(fromChild.path.replace(/\\/g, "/") === fx.poolFile.replace(/\\/g, "/"), "child registration resolves the parent pool")

    const fromParent = await parentEnv.handlers.editOpen({ scope: "workspace", sessionID: null })
    assertEditOpenContractShape(fromParent, "parent-reg null")
    assert.equal(fromParent.observedLocation, fx.parent, "parent registration null-session binds the parent location")
    assert.ok(fromParent.path.replace(/\\/g, "/") === fx.poolFile.replace(/\\/g, "/"), "parent registration resolves the parent pool")

    // Session-scoped answers are location-independent: the session's live
    // anchor (child) decides, from both registrations.
    for (const [label, handlers] of [["child-reg", childEnv.handlers], ["parent-reg", parentEnv.handlers]]) {
      const ed = await handlers.editOpen({ scope: "workspace", sessionID: SID })
      assertEditOpenContractShape(ed, `session via ${label}`)
      assert.equal(ed.exists, true, `${label}: the session's walk-up hits the parent pool`)
      assert.equal(ed.anchor, fx.child, `${label}: the session anchor is the child repo`)
    }
  } finally {
    await childEnv.cleanup()
    await parentEnv.cleanup()
    fx.cleanup()
  }
})
