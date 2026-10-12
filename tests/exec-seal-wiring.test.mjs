import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"

// readonly-exec-seal wiring suite (spec: tool-partition — "Readonly workers
// execute on a sealed supervised-exec channel"): hook-level three-state
// coverage — explicit-readonly denied with the finding shape / write and
// absent shapes pass / primary never sealed — plus draft-posture composition
// and the per-session per-indicator finding bound.

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-seal-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

const worktree = mkdtempSync(join(tmpdir(), "forge-seal-wiring-"))
process.on("exit", () => {
  for (const d of [worktree, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const input = (dir = worktree) => ({
  client: { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const emptyCfg = () => ({ agent: {}, command: {}, permission: {} })
let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts)
  return lastHost
}

function projectWithForgeJson(t, json) {
  const dir = mkdtempSync(join(tmpdir(), "forge-seal-proj-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), json)
  return dir
}

// readonly / write / absent-shape roster + a namespaced readonly worker.
const ROSTER = JSON.stringify({
  agents: {
    reviewer: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" },
    builder: { model: "zai/glm", thoughtLevel: "low", shape: "write" },
    "ta-tool": { model: "zai/glm", thoughtLevel: "low" }, // absent shape — shape-default-open
  },
})

async function sealHost(t, json = ROSTER) {
  const dir = projectWithForgeJson(t, json)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  return h
}

// Seed the sessionID->agent family map (chat.message is the primary source).
const seed = (h, sessionID, agent) => h["chat.message"]({ sessionID, agent })

const shell = (command) => ({ tool: "forge_shell", sessionID: "ses_s", callID: "c1" }, { args: { command } })

// ---------------------------------------------------------------------------

test("seal: an explicit readonly worker's WRITE-CLASS call is denied with the full finding shape", async (t) => {
  const h = await sealHost(t)
  await seed(h, "ses_ro", "forge-reviewer")

  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_ro", callID: "c1" }, { args: { command: "node build.js > out.txt" } }),
    (err) => {
      const m = String(err)
      assert.match(m, /forge-reviewer/, "the worker is named")
      assert.match(m, /readonly/, "the readonly shape is named")
      assert.match(m, /redirect/, "the classified write indicator is named")
      assert.match(m, /"shape": "write"/, "the remedy points at shape: write")
      assert.match(m, /VERBATIM/, "the worker is told to report the refusal verbatim, not work around it")
      return true
    },
  )
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_ro"), ["redirect"], "the bounded finding is recorded")

  // A mutating cmdlet is denied with its own indicator.
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_ro", callID: "c2" }, { args: { command: "Set-Content -Path notes.md -Value x" } }),
    /mutating-cmdlet/,
  )
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_ro"), ["redirect", "mutating-cmdlet"], "a second indicator class adds exactly one finding")
})

test("seal: READ-CLASS commands flow for an explicit readonly worker — no finding", async (t) => {
  const h = await sealHost(t)
  await seed(h, "ses_read", "forge-reviewer")
  for (const command of ["rg TODO src/", "git log --oneline -10", "node -e \"console.log(1)\""]) {
    await h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_read", callID: "c3" }, { args: { command } })
  }
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_read"), [])
})

test("seal: write-shaped and absent-shaped workers are never sealed", async (t) => {
  const h = await sealHost(t)
  await seed(h, "ses_w", "forge-builder")
  await seed(h, "ses_abs", "forge-ta-tool")
  for (const sid of ["ses_w", "ses_abs"]) {
    await h["tool.execute.before"]({ tool: "forge_shell", sessionID: sid, callID: "c4" }, { args: { command: "node build.js > out.txt" } })
    await h["tool.execute.before"]({ tool: "forge_shell", sessionID: sid, callID: "c5" }, { args: { command: "git commit -m x" } })
    assert.deepEqual(h.__forgeSubagentsTest.sealFindings(sid), [], `${sid} collects no seal findings`)
  }
})

test("seal: the primary forge session is never sealed", async (t) => {
  const h = await sealHost(t)
  await seed(h, "ses_primary", "forge")
  await h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_primary", callID: "c6" }, { args: { command: "node build.js > out.txt" } })
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_primary"), [])
})

test("seal: an unknown session fails open (WRITE-CLASS flows, disclosed once)", async (t) => {
  const h = await sealHost(t)
  // No chat.message seeding: the session's agent is unknown.
  await h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_unknown", callID: "c7" }, { args: { command: "node build.js > out.txt" } })
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_unknown"), [], "fail-open: nothing recorded against an unknown session")
})

test("seal: the finding is bounded per session per indicator — the denial itself never softens", async (t) => {
  const h = await sealHost(t)
  await seed(h, "ses_bound", "forge-reviewer")
  for (const callID of ["b1", "b2", "b3"]) {
    await assert.rejects(
      () => h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_bound", callID }, { args: { command: "npm install" } }),
      /pkg-mutation/,
      `call ${callID} is still denied`,
    )
  }
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_bound"), ["pkg-mutation"], "one finding entry regardless of repeat calls")
})

test("seal: session.deleted evicts the finding bound", async (t) => {
  const h = await sealHost(t)
  await seed(h, "ses_gone", "forge-reviewer")
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_gone", callID: "g1" }, { args: { command: "git push" } }),
    /git-mutation/,
  )
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_gone"), ["git-mutation"])
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_gone" } } } })
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_gone"), [], "the bound dies with the session")
})

test("seal: composes with the draft posture — draft semantics unchanged, seal neither weakens nor replaces them", async (t) => {
  const dir = projectWithForgeJson(t, ROSTER)
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  const ctx = (sessionID) => ({ sessionID, ask: async () => ({ status: "allow" }), metadata: () => {}, message: async () => {} })

  // Draft on the governed session's worktree.
  await h.tool.plan_write.execute(
    { goal: "planning", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] },
    ctx("ses_draft"),
  )

  // The draft write ban on ordinary write tools is unchanged (the seal did
  // not touch it)...
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "write", sessionID: "ses_draft", callID: "d1" }, { args: { filePath: "x.ts", content: "y" } }),
    /plan is in draft/,
  )
  // ...and forge_shell's own posture during draft is unchanged for a
  // write-shaped worker: the before-hook adds nothing (the channel's ask
  // gate lives in the tool execute, not here).
  await seed(h, "ses_draft_w", "forge-builder")
  await h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_draft_w", callID: "d2" }, { args: { command: "node build.js > out.txt" } })

  // The readonly seal still binds ON TOP of the draft posture — its message
  // is the seal's, and the draft neither weakens nor replaces it.
  await seed(h, "ses_draft_ro", "forge-reviewer")
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_draft_ro", callID: "d3" }, { args: { command: "node build.js > out.txt" } }),
    (err) => {
      assert.match(String(err), /forge:seal/)
      return true
    },
  )
})

test("seal: a readonly shape with a lifted mutating permission is NOT effective-readonly — unsealed", async (t) => {
  // effectiveReadonlyShape fail-closed direction: a permission override that
  // lifts any mutating tool off deny disqualifies the explicit shape.
  const h = await sealHost(
    t,
    JSON.stringify({ agents: { leaker: { model: "zai/glm", thoughtLevel: "low", shape: "readonly", permission: { bash: "allow" } } } }),
  )
  await seed(h, "ses_leak", "forge-leaker")
  await h["tool.execute.before"]({ tool: "forge_shell", sessionID: "ses_leak", callID: "c8" }, { args: { command: "node build.js > out.txt" } })
  assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_leak"), [])
})
