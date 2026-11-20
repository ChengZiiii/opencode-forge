import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// harden-dispatch-resilience block B (design D2, tasks 4.2/5.3): the
// nested-dispatch guard matrix, wired through the real task tool —
// non-forge target ∧ anthropic family → the task-tool deny rides the
// create body (v2 array spelling); non-forge ∧ other family → untouched;
// forge-* targets → untouched by THIS guard (their depth cap is the
// materialized permission-map deny, not this create-body entry).

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "20"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-guard-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

import { server } from "../plugin.ts"

const worktreeRoot = mkdtempSync(join(tmpdir(), "forge-guard-"))
process.on("exit", () => {
  for (const d of [worktreeRoot, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const input = (dir, client) => ({
  client,
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const allowCtx = (sessionID, dir) => ({
  sessionID,
  worktree: dir,
  directory: dir,
  ask: async () => ({ status: "allow" }),
  metadata: () => {},
  message: async () => {},
  abort: undefined,
})

const emptyCfg = () => ({ agent: {}, command: {}, permission: {} })

function projectWithForgeJson(t, json) {
  const dir = mkdtempSync(join(tmpdir(), "forge-guard-proj-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), json)
  return dir
}

/** Scriptable client; create bodies are captured for the guard assertions. */
function makeClient() {
  const calls = { create: [], promptAsync: [] }
  const children = new Map()
  const client = {
    session: {
      get: async (a) => {
        const c = children.get(a.path?.id)
        if (!c) return { data: null }
        return { time: { updated: Date.now() } }
      },
      create: async (a) => {
        calls.create.push(a)
        const id = `ses_child_${calls.create.length}`
        children.set(id, { state: "busy" })
        return { data: { id } }
      },
      promptAsync: async (a) => {
        calls.promptAsync.push(a)
        return {}
      },
      prompt: async () => ({}),
      status: async () => {
        const map = {}
        for (const [id, c] of children) map[id] = { type: c.state === "busy" ? "busy" : "idle" }
        return { data: map }
      },
      messages: async (a) => {
        const c = children.get(a.path?.id)
        if (!c || c.state === "busy") return { data: [] }
        return { data: [{ info: { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "text", text: "guard report" }] }] }
      },
      abort: async () => true,
    },
  }
  return { client, calls, children }
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const TASK_DENY = { action: "task", resource: "*", effect: "deny" }
const QUESTION_DENY_V2 = { action: "question", resource: "*", effect: "deny" }

const anthropicPool = JSON.stringify({ pool: "g", agents: { scout: { model: "anthropic/claude-sonnet-4-5", thoughtLevel: "low" } } })

test("guard matrix (D2): non-forge + anthropic → the task deny RIDES the create body (both modes)", async (t) => {
  const dir = projectWithForgeJson(t, anthropicPool)
  const { client, calls, children } = makeClient()
  const h = await server(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  // The dispatching owner's captured model is anthropic — the guard's
  // resolution input (the dispatchModelIdentity fallback chain).
  h.__forgeSubagentsTest.setSessionModel("ses_g1", { provider: "anthropic", model: "claude-sonnet-4-5" })
  t.after(() => h.__forgeSubagentsTest.setSessionModel("ses_g1", null))

  // SYNC mode: questionDeny false, so permissions carries ONLY the task deny.
  const syncDone = h.tool.task.execute(
    { subagent_type: "general", prompt: "guard me (sync)", description: "guard sync" },
    allowCtx("ses_g1", dir),
  )
  await waitFor(() => calls.create.length === 1, "the sync child created")
  children.get("ses_child_1").state = "done"
  await syncDone
  assert.deepEqual(calls.create[0].body.permissions, [TASK_DENY], "sync non-forge anthropic create body carries exactly the v2 task deny")
  assert.equal(calls.create[0].body.permission, undefined, "no v1 question seal on the sync path")

  // ASYNC mode: questionDeny true → ONE permissions key with BOTH entries
  // (merged), plus the v1 permission spelling for older hosts.
  await h.tool.task.execute(
    { subagent_type: "general", prompt: "guard me (async)", description: "guard async", run_in_background: true },
    allowCtx("ses_g1", dir),
  )
  await waitFor(() => calls.create.length === 2, "the async child created")
  assert.deepEqual(calls.create[1].body.permissions, [QUESTION_DENY_V2, TASK_DENY], "async non-forge anthropic create body merges question + task denies in the v2 array")
  assert.deepEqual(calls.create[1].body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "the v1 question spelling still rides alongside")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_g1" } } } })
})

test("guard matrix (D2): non-forge + NON-anthropic family → the create body is UNTOUCHED", async (t) => {
  const dir = projectWithForgeJson(t, anthropicPool)
  const { client, calls } = makeClient()
  const h = await server(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  h.__forgeSubagentsTest.setSessionModel("ses_g2", { provider: "zai", model: "glm-4.7" })
  t.after(() => h.__forgeSubagentsTest.setSessionModel("ses_g2", null))

  await h.tool.task.execute(
    { subagent_type: "general", prompt: "no guard for zai", description: "zai target", run_in_background: true },
    allowCtx("ses_g2", dir),
  )
  await waitFor(() => calls.create.length === 1, "the child created")
  const body = calls.create[0].body
  assert.ok(!body.permissions?.some((p) => p.action === "task"), "no task deny for a non-anthropic family target")
  assert.deepEqual(body.permissions, [QUESTION_DENY_V2], "async carries only the question seal (the guard added nothing)")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_g2" } } } })
})

test("guard matrix (D2): forge-* targets are untouched by THIS guard (even when the pinned model is anthropic)", async (t) => {
  const dir = projectWithForgeJson(t, anthropicPool)
  const { client, calls } = makeClient()
  const h = await server(input(dir, client), {})
  t.after(() => h.dispose?.())
  await h.config(emptyCfg())
  h.__forgeSubagentsTest.setSessionModel("ses_g3", { provider: "anthropic", model: "claude-sonnet-4-5" })
  t.after(() => h.__forgeSubagentsTest.setSessionModel("ses_g3", null))

  await h.tool.task.execute(
    { subagent_type: "forge-g-scout", prompt: "forge worker, structural deny elsewhere", description: "forge target", run_in_background: true },
    allowCtx("ses_g3", dir),
  )
  await waitFor(() => calls.create.length === 1, "the child created")
  const body = calls.create[0].body
  assert.ok(!body.permissions?.some((p) => p.action === "task"), "the create-body guard never stacks on forge-* (their depth cap is the materialized permission map)")
  assert.deepEqual(body.permissions, [QUESTION_DENY_V2], "only the question seal rides")
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "ses_g3" } } } })
})
