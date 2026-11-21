import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

// dispatch-cancel-lifecycle: ① the gated-ask watchdog (gate() choke point —
// timeout resolves as a DISCLOSED REJECTION, fail-closed, nothing
// auto-approved; a decision inside the window wins; 0 disables; a late
// reply after rejection is harmless); ② the cancel engine (unknown id
// refuses with the flight list; a real cancel kills the registry job,
// CONFIRMS the child idle, marks the id never-retried; a resisting child is
// disclosed; "all" cancels the flight serially); ③ the retry guard
// (recovery refuses to respawn a cancelled id); ④ parent-interrupt
// disclosure (disclose-only, deduped per flight composition); ⑤ orphan
// child disclosure (streaming forge-* child with no row — once per child).
// (Plain JS — .mjs files are not type-stripped; the imported .ts core is.)

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "10"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "20"
process.env.FORGE_DISPATCH_RETRY_BACKOFF_MS = "20"
process.env.FORGE_DISPATCH_NOTIFY_INTERVAL_MS = "150"
// The resisted-cancel leg needs a short assertion window (module-level const).
process.env.FORGE_CANCEL_IDLE_ASSERTION_MS = "500"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-cancel-home-"))

import {
  gate,
  resolveGateAskWatchdogMs,
  cancelDispatch,
  cancelAllDispatches,
  isDispatchCancelled,
  discloseInterruptedParent,
  disclosedInterruptFlights,
  detectOrphanDispatchChildren,
  observedOrphanDispatches,
  recoverOneDispatchRecord,
  v2WiringSeam,
} from "../plugin.ts"

const tmpDirs = []
const newWs = () => {
  const d = mkdtempSync(join(tmpdir(), "forge-cancel-ws-"))
  tmpDirs.push(d)
  return d
}
process.on("exit", () => {
  for (const d of [...tmpDirs, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

const { dispatchTasks, jobManager } = v2WiringSeam

// Seed a REAL running registry job + dispatch handle (the cancel engine's
// bookkeeping); the killTree records the abort (no real process exists).
let aborts = 0
function seedDispatch(taskId, childId, over = {}) {
  aborts = 0
  jobManager.create({
    id: taskId,
    cmd: `dispatch agent-x: ${taskId}`,
    worktree: "/w",
    ownerSession: "ses_owner",
    logPath: join(process.env.FORGE_TEST_FORGE_HOME, `${taskId}.txt`),
    notify: true,
    killTree: () => {
      aborts++
    },
  })
  dispatchTasks.set(taskId, {
    jobId: taskId,
    childSessionID: childId,
    agentID: "forge-ns-worker",
    ownerSession: over.ownerSession ?? "ses_owner",
    description: over.description ?? "cancel leg",
  })
}

function cleanupDispatch(taskId) {
  const job = jobManager.get(taskId)
  if (job && job.state === "running") jobManager.kill(job)
  jobManager.clear(taskId)
  dispatchTasks.delete(taskId)
}

// A cancel client: the status map is the streaming classifier — by default
// the child is ABSENT (= idle, the proven field reality). `activeMap` opts
// into a custom active map.
function cancelClient(over = {}) {
  return {
    session: {
      status: async () => {
        if (over.status) return over.status()
        if (over.activeMap) return { data: over.activeMap }
        return { data: {} }
      },
      get: async () => ({ data: { id: "ses_x", time: { updated: Date.now() } } }),
      messages: async () => ({ data: [] }),
      abort: async () => ({ ok: true }),
      list: async () => ({ data: over.list ?? [] }),
    },
  }
}

// ---------------------------------------------------------------------------
// ① Gated-ask watchdog

test("watchdog resolver: default 300s; env-tunable; 0 disables; invalid falls back; 1h clamp", () => {
  assert.equal(resolveGateAskWatchdogMs({}), 300_000)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "250" }), 250)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "0" }), 0)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "nope" }), 300_000)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "-5" }), 300_000)
  assert.equal(resolveGateAskWatchdogMs({ FORGE_GATE_ASK_WATCHDOG_MS: "99999999" }), 3_600_000)
})

test("watchdog: a never-answered gate resolves as a disclosed fail-closed rejection", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "120"
  const start = Date.now()
  await assert.rejects(
    gate(
      () => new Promise(() => {}), // no adjudication, ever (the TUI wedge)
      "goal_write",
      "Arm goal: wedge-leg",
    ),
    (e) => {
      const msg = String(e?.message ?? e)
      assert.match(msg, /gate-watchdog/, "the finding names the watchdog")
      assert.match(msg, /goal_write/, "the finding names the gate")
      assert.match(msg, /REFUSED|fail-closed/, "the finding states the fail-closed refusal")
      assert.match(msg, /state is unchanged|nothing was approved/, "the finding promises state safety")
      assert.match(msg, /re-run/, "the finding carries the retry contract")
      return true
    },
  )
  const waited = Date.now() - start
  assert.ok(waited >= 100, `the rejection waited for the window (waited ${waited}ms)`)
  assert.ok(waited < 5000, "the watchdog fired inside the configured window (not the 300s default)")
})

test("watchdog: a decision inside the window wins and no rejection fires", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "5000"
  await gate(
    () => sleep(10).then(() => "approved"),
    "plan_approve",
    "Approve plan: fast-leg",
  )
})

test("watchdog: 0 disables — the gate waits indefinitely for adjudication", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "0"
  let resolveAsk
  const deferred = new Promise((resolve) => {
    resolveAsk = resolve
  })
  const pending = gate(() => deferred, "crew_close", "Close crew: disabled-leg")
  let settled = false
  pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await sleep(220)
  assert.equal(settled, false, "with the watchdog disabled the gate is still waiting past any plausible window")
  resolveAsk("user said yes")
  await pending // resolves with the user's decision, no rejection
})

test("watchdog: a late client reply after a rejection is harmless", async () => {
  process.env.FORGE_GATE_ASK_WATCHDOG_MS = "80"
  let resolveAsk
  const deferred = new Promise((resolve) => {
    resolveAsk = resolve
  })
  const refused = gate(() => deferred, "goal_complete", "Complete goal: late-leg")
  await assert.rejects(refused, /gate-watchdog/)
  // The stale dialog's late reply lands after the refusal — it must not
  // throw unhandled or mutate anything (the refused call stays refused).
  resolveAsk("too late")
  await sleep(50)
})

// ---------------------------------------------------------------------------
// ② Cancel engine

test("cancelDispatch refuses an unknown id with the (empty) flight list", async () => {
  const res = await cancelDispatch(cancelClient(), "task_does_not_exist")
  assert.equal(res.ok, false)
  assert.match(res.text, /not an in-flight async dispatch/)
  assert.match(res.text, /no async dispatches in flight/)
})

test("cancel: a real cancel kills the job, confirms the child idle, and marks never-retried", async (t) => {
  const taskId = "task_cancel_ok"
  const child = "ses_cancel_child"
  seedDispatch(taskId, child)
  t.after(() => cleanupDispatch(taskId))
  const res = await cancelDispatch(cancelClient(), taskId)
  assert.equal(res.ok, true)
  assert.equal(res.idle, "idle", "the child is CONFIRMED idle (real stop, not bookkeeping)")
  assert.equal(aborts, 1, "the kill fired the row's killTree (the abort engine)")
  assert.match(res.text, /confirmed idle/)
  assert.match(res.text, /never retried/)
  assert.equal(isDispatchCancelled(taskId), true, "the id is marked for every resilience path")
  assert.equal(jobManager.get(taskId)?.state, "killed", "the registry job is killed")
})

test("cancel: a resisting child is disclosed, not declared dead", async (t) => {
  const taskId = "task_cancel_resist"
  const child = "ses_resist_child"
  seedDispatch(taskId, child)
  t.after(() => cleanupDispatch(taskId))
  const res = await cancelDispatch(cancelClient({ activeMap: { [child]: { status: "running" } } }), taskId)
  assert.equal(res.ok, true)
  assert.equal(res.idle, "resisted", "the assertion window closed with the child still streaming")
  assert.match(res.text, /did NOT reach idle|resisted/)
  assert.match(res.text, /host TUI/)
})

test("cancel all: the whole flight cancels serially, each with the confirmed-abort contract", async (t) => {
  const a = "task_cancel_all_a"
  const b = "task_cancel_all_b"
  seedDispatch(a, "ses_all_child_a", { description: "first" })
  seedDispatch(b, "ses_all_child_b", { description: "second" })
  t.after(() => {
    cleanupDispatch(a)
    cleanupDispatch(b)
  })
  const { count, results } = await cancelAllDispatches(cancelClient())
  assert.equal(count, 2, "both in-flight dispatches were cancelled")
  assert.equal(results.length, 2)
  assert.match(results[0], /confirmed idle/)
  assert.match(results[1], /confirmed idle/)
  assert.equal(isDispatchCancelled(a), true)
  assert.equal(isDispatchCancelled(b), true)
})

// ---------------------------------------------------------------------------
// ③ Retry guard: recovery refuses a cancelled id

test("retry guard: recovery terminalizes a cancelled id's record instead of respawning it", async (t) => {
  const ws = newWs()
  const taskId = "task_cancel_recover"
  const child = "ses_recover_child"
  seedDispatch(taskId, child)
  t.after(() => cleanupDispatch(taskId))
  assert.equal(await cancelDispatch(cancelClient(), taskId).then((r) => r.ok), true)
  // The handle/prune state must NOT short-circuit via the idempotence
  // guard: drop the handle and the registry entry first (a real process
  // would have pruned them at the watcher's next slice).
  cleanupDispatch(taskId)
  // A stale non-terminal journal record for the cancelled id (a retry
  // pending when the cancel landed) — at the journal's real location.
  const journalDir = join(ws, ".opencode", "forge")
  mkdirSync(journalDir, { recursive: true })
  writeFileSync(
    join(journalDir, "dispatch-log.jsonl"),
    `${JSON.stringify({
      id: taskId,
      agent: "forge-ns-worker",
      ownerSession: "ses_owner",
      state: "retry-pending",
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      prompt: "p",
    })}\n`,
  )
  // The client's create/prompt WOULD spawn a second child if the guard
  // were missing — a spawn attempt is the failure signal.
  let spawns = 0
  const guardClient = {
    session: {
      create: async () => {
        spawns++
        return { data: { id: "ses_should_not_exist" } }
      },
      prompt: async () => {
        spawns++
        return {}
      },
      get: async () => {
        throw new Error("not observed")
      },
      status: async () => {
        throw new Error("not observed")
      },
      list: async () => ({ data: [] }),
    },
  }
  await recoverOneDispatchRecord(guardClient, ws, {
    id: taskId,
    agent: "forge-ns-worker",
    ownerSession: "ses_owner",
    state: "retry-pending",
    attempts: 1,
    prompt: "p",
    description: "",
  })
  assert.equal(spawns, 0, "the recovery NEVER respawned the cancelled dispatch")
  // The journal terminalized the record as aborted.
  const lines = readFileSync(join(journalDir, "dispatch-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const last = lines[lines.length - 1]
  assert.equal(last.state, "terminal", "the stale record terminalized")
  assert.equal(last.outcome, "aborted", "the outcome is aborted")
  assert.match(String(last.reason ?? ""), /forge-cancel|cancelled by the user lever/)
})

// ---------------------------------------------------------------------------
// ④ Parent-interrupt disclosure

test("interrupt disclosure: disclose-only, deduped per flight composition", async (t) => {
  const taskId = "task_interrupt_flight"
  seedDispatch(taskId, "ses_interrupt_child")
  t.after(() => cleanupDispatch(taskId))
  const before = disclosedInterruptFlights()
  assert.equal(discloseInterruptedParent("ses_owner"), true, "the first interrupt discloses")
  assert.equal(disclosedInterruptFlights(), before + 1)
  assert.equal(discloseInterruptedParent("ses_owner"), false, "the SAME flight re-discloses nothing")
  assert.equal(discloseInterruptedParent("ses_child_too"), false, "a session with no flight is a no-op")
  // A NEW dispatch in the same session re-arms the disclosure.
  const taskId2 = "task_interrupt_flight2"
  seedDispatch(taskId2, "ses_interrupt_child2")
  t.after(() => cleanupDispatch(taskId2))
  assert.equal(discloseInterruptedParent("ses_owner"), true, "a changed flight composition discloses again")
})

// ---------------------------------------------------------------------------
// ⑤ Orphan-child disclosure

test("orphan: a streaming forge-* child with no row is disclosed once, with guidance", async (t) => {
  const ws = newWs()
  const child = "ses_orphan_child"
  const before = observedOrphanDispatches()
  const client = cancelClient({
    list: [{ id: child, agent: "forge-ns-worker", parentID: "ses_owner", time: { created: Date.now() } }],
    activeMap: { [child]: { status: "running" } }, // the status map holds the child → STREAMING
  })
  const found = await detectOrphanDispatchChildren(client, ws)
  assert.equal(found, 1, "the orphan is surfaced")
  assert.equal(observedOrphanDispatches(), before + 1)
  assert.equal(await detectOrphanDispatchChildren(client, ws), 0, "the SAME child never re-discloses")
})

test("orphan: non-forge agents, parentless sessions, idle children, and tracked children are NOT orphans", async (t) => {
  const ws = newWs()
  const taskId = "task_tracked_child"
  const child = "ses_tracked_child"
  seedDispatch(taskId, child)
  t.after(() => cleanupDispatch(taskId))
  const client = cancelClient({
    list: [
      { id: "ses_native_child", agent: "general", parentID: "ses_owner", time: { created: Date.now() } }, // non-forge
      { id: "ses_rootless", agent: "forge-ns-worker", time: { created: Date.now() } }, // no parentID
      { id: "ses_idle_forge", agent: "forge-ns-worker", parentID: "ses_owner", time: { created: Date.now() } }, // forge child, NOT streaming (absent from the map)
      { id: child, agent: "forge-ns-worker", parentID: "ses_owner", time: { created: Date.now() } }, // tracked → row live
    ],
    // The streaming map holds every candidate EXCEPT ses_idle_forge.
    activeMap: { ses_native_child: {}, ses_rootless: {}, [child]: {} },
  })
  assert.equal(await detectOrphanDispatchChildren(client, ws), 0, "none of these is an orphan")
})

test("orphan: an unreadable status view stays silent (never cry wolf)", async (t) => {
  const ws = newWs()
  const client = cancelClient({
    list: [{ id: "ses_stream_child", agent: "forge-ns-worker", parentID: "ses_owner", time: { created: Date.now() } }],
    status: () => {
      throw new Error("status unreadable")
    },
  })
  assert.equal(await detectOrphanDispatchChildren(client, ws), 0)
})
