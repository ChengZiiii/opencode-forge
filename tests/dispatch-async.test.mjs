import test from "node:test"
import assert from "node:assert/strict"

// dispatch-async core (async-dispatch wave 1): child-session create body
// (parentID link + question-deny seal + native title format), prompt send
// args, status polling to terminal (completed / error / honest timeout),
// final assistant message fetch, abort — all against a fake structural
// client, clock and sleeper fully injected (no real timers).

import {
  QUESTION_DENY_PERMISSION,
  QUESTION_DENY_PERMISSIONS_V2,
  TASK_DENY_PERMISSIONS_V2,
  TASK_CREATE_SEAM_ABSENT,
  childSessionTitle,
  createChildSession,
  sendPrompt,
  buildPromptArgs,
  pollChild,
  fetchFinalMessage,
  abortChild,
  resolvePollTimeoutMs,
  resolveNotifyIntervalMs,
  DEFAULT_POLL_TIMEOUT_MS,
  MAX_POLL_TIMEOUT_MS,
  TERMINAL_STABILITY_TICKS,
  // fold B (dispatch-resilience): session.get probe + stale knobs + sweep helpers
  sessionGet,
  resolveStaleMs,
  resolveStaleMode,
  resolveStaleFloorMs,
  staleThresholdCrossed,
  decideStaleSweep,
  applyStaleProbe,
  staleSilentMinutes,
  DEFAULT_STALE_MS,
  MIN_STALE_RUNTIME_MS,
} from "../src/dispatch-async.ts"
import {
  classifyDispatchError,
  buildRetryPrompt,
  RESUME_PREAMBLE,
  resolveMaxAttempts,
  resolveRetryBackoffMs,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
} from "../src/dispatch-retry.ts"

// ---------------------------------------------------------------------------
// Fake client: records every call; each endpoint's reply is scripted per
// test through mutable state the poller advances tick by tick.

function fakeClient(script = {}) {
  const calls = {
    create: [],
    promptAsync: [],
    prompt: [],
    status: [],
    messages: [],
    abort: [],
  }
  const client = {
    session: {
      create: async (args) => {
        calls.create.push(args)
        return script.create?.() ?? { data: { id: "ses_child_1" } }
      },
      promptAsync: async (args) => {
        calls.promptAsync.push(args)
        return script.promptAsync?.()
      },
      prompt: async (args) => {
        calls.prompt.push(args)
        return script.prompt?.()
      },
      status: async () => {
        calls.status.push({})
        return script.status?.() ?? { data: {} }
      },
      messages: async (args) => {
        calls.messages.push(args)
        return { data: script.messages?.() ?? [] }
      },
      abort: async (args) => {
        calls.abort.push(args)
        return true
      },
    },
  }
  return { client, calls }
}

// Deterministic clock: starts at T0, each sleep(1 tick) advances 1ms of the
// poller's interval budget; now() reads the virtual clock.
function fakeTime() {
  let t = 0
  const slept = []
  return {
    seams: {
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms)
        t += ms
      },
    },
    slept,
    advance: (ms) => {
      t += ms
    },
  }
}

const assistantMsg = (over = {}) => ({
  info: { id: "msg_2", role: "assistant", finish: "stop", time: { created: 2 }, ...over.info },
  parts: [{ type: "text", text: "final report" }, ...(over.parts ?? [])],
})

// ---------------------------------------------------------------------------

test("createChildSession: parentID + native title + parent directory; question-deny is MODE-KEYED (task-shadow)", async () => {
  const { client, calls } = fakeClient()
  // Sync dispatch (native parity): NO question-deny seal in the create body.
  const result = await createChildSession(client, {
    parentSessionID: "ses_parent",
    parentDirectory: "C:/repo",
    agentID: "forge-wiki-reviewer",
    description: "audit the docs",
  })
  assert.equal(result.ok, true)
  assert.equal(result.sessionID, "ses_child_1")
  const create = calls.create[0]
  assert.equal(create.body.parentID, "ses_parent")
  assert.equal(create.body.permission, undefined, "sync create body carries no permission seal (questions available)")
  assert.equal(create.body.title, "audit the docs (@forge-wiki-reviewer subagent)")
  assert.deepEqual(create.query, { directory: "C:/repo" })

  // Async dispatch: the session-wide question-deny seal rides the body.
  const { client: c2, calls: calls2 } = fakeClient()
  const r2 = await createChildSession(c2, {
    parentSessionID: "ses_parent",
    parentDirectory: "C:/repo",
    agentID: "forge-wiki-reviewer",
    description: "audit the docs",
    questionDeny: true,
  })
  assert.equal(r2.ok, true)
  assert.deepEqual(calls2.create[0].body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "async create body carries the question-deny seal")
  // harden-dispatch-resilience 4.1/5.3 (probe-1.1): the v2 array spelling
  // rides the SAME create body — the legacy spelling alone is silently
  // dropped on 2.3.2, so the effective seal is the `permissions` array.
  assert.deepEqual(calls2.create[0].body.permissions, [{ action: "question", resource: "*", effect: "deny" }], "async create body carries the v2 permissions array spelling")
  assert.deepEqual([...QUESTION_DENY_PERMISSIONS_V2], [{ action: "question", resource: "*", effect: "deny" }])
  assert.equal(QUESTION_DENY_PERMISSION.length, 1)
})

test("createChildSession taskDeny (harden-dispatch-resilience D2): the v2 task deny rides the permissions array; merged when the question seal is set; absent when unset", async () => {
  // taskDeny alone (sync guard case): exactly the task entry, nothing else.
  const { client: c1, calls: calls1 } = fakeClient()
  const r1 = await createChildSession(c1, {
    parentSessionID: "ses_parent",
    parentDirectory: "C:/repo",
    agentID: "general",
    description: "guarded",
    taskDeny: true,
  })
  assert.equal(r1.ok, true)
  assert.deepEqual(calls1.create[0].body.permissions, [{ action: "task", resource: "*", effect: "deny" }], "taskDeny alone → exactly the v2 task entry")
  assert.equal(calls1.create[0].body.permission, undefined, "no v1 seal rides the task-only case")

  // Both seals (async guard case): ONE permissions key, question first then
  // task (merge order is contract: the question seal precedes the guard).
  const { client: c2, calls: calls2 } = fakeClient()
  const r2 = await createChildSession(c2, {
    parentSessionID: "ses_parent",
    parentDirectory: "C:/repo",
    agentID: "general",
    description: "guarded async",
    questionDeny: true,
    taskDeny: true,
  })
  assert.equal(r2.ok, true)
  assert.deepEqual(calls2.create[0].body.permissions, [{ action: "question", resource: "*", effect: "deny" }, { action: "task", resource: "*", effect: "deny" }], "both seals merge into one permissions array")
  assert.deepEqual(calls2.create[0].body.permission, [{ permission: "question", action: "deny", pattern: "*" }], "the v1 question spelling still rides")

  // Neither seal: the create body carries no permission keys at all.
  const { client: c3, calls: calls3 } = fakeClient()
  const r3 = await createChildSession(c3, {
    parentSessionID: "ses_parent",
    parentDirectory: "C:/repo",
    agentID: "general",
    description: "unsealed",
  })
  assert.equal(r3.ok, true)
  assert.equal(calls3.create[0].body.permissions, undefined, "no permissions key without seals")
  assert.equal(calls3.create[0].body.permission, undefined, "no permission key without seals")
  assert.deepEqual([...TASK_DENY_PERMISSIONS_V2], [{ action: "task", resource: "*", effect: "deny" }])
})

test("childSessionTitle matches host-native child title format", () => {
  assert.equal(childSessionTitle("x", "forge-a"), "x (@forge-a subagent)")
})

test("createChildSession: error and missing-id branches are honest", async () => {
  const a = fakeClient({ create: () => ({ error: "boom" }) })
  const ra = await createChildSession(a.client, {
    parentSessionID: "p", parentDirectory: "d", agentID: "g", description: "x",
  })
  assert.equal(ra.ok, false)
  assert.match(ra.error, /boom/)

  const b = fakeClient({ create: () => ({ data: {} }) })
  const rb = await createChildSession(b.client, {
    parentSessionID: "p", parentDirectory: "d", agentID: "g", description: "x",
  })
  assert.equal(rb.ok, false)
  assert.match(rb.error, /no session id/)

  const c = fakeClient()
  c.client.session.create = async () => {
    throw new Error("network down")
  }
  const rc = await createChildSession(c.client, {
    parentSessionID: "p", parentDirectory: "d", agentID: "g", description: "x",
  })
  assert.equal(rc.ok, false)
  assert.match(rc.error, /threw/)
})

// fix-v2-crew-surface-drift task 3.2 (design D2): the guarded shape probe.
test("createChildSession seam guard (fix-v2-crew-surface-drift): absent session.create → the TASK_CREATE_SEAM_ABSENT sentinel (no raw TypeError); the 2.3.2 BARE-record response resolves", async () => {
  // The 2.3.2 live-failure shape: a client whose session object has NO
  // create method (the v2 adapter before this change dropped it). The
  // guarded probe returns the honest sentinel — never a TypeError.
  const noSeam = await createChildSession({ session: {} }, {
    parentSessionID: "p", parentDirectory: "d", agentID: "g", description: "x",
  })
  assert.equal(noSeam.ok, false)
  assert.equal(noSeam.error, TASK_CREATE_SEAM_ABSENT, "the absent-seam sentinel, exact")

  const nullish = await createChildSession(null, {
    parentSessionID: "p", parentDirectory: "d", agentID: "g", description: "x",
  })
  assert.equal(nullish.ok, false)
  assert.equal(nullish.error, TASK_CREATE_SEAM_ABSENT, "a null client is the same honest verdict")

  // Sandbox-probed 2.3.2 promise-layer create returns the BARE session
  // record ({id, location:{directory}, ...}) — no {data,error} envelope.
  const bare = await createChildSession({ session: { create: async () => ({ id: "ses_v2_child", location: { directory: "C:/ws" } }) } }, {
    parentSessionID: "p", parentDirectory: "d", agentID: "g", description: "x",
  })
  assert.equal(bare.ok, true)
  assert.equal(bare.sessionID, "ses_v2_child", "the bare record's id resolves as the child session id")
})

test("sendPrompt: promptAsync endpoint with agent id + text part + directory", async () => {
  const { client, calls } = fakeClient()
  const r = await sendPrompt(client, {
    sessionID: "ses_child_1",
    agentID: "forge-wiki-reviewer",
    prompt: "go audit",
    directory: "C:/repo",
  })
  assert.equal(r.ok, true)
  assert.equal(calls.promptAsync.length, 1)
  const args = calls.promptAsync[0]
  assert.equal(args.path.id, "ses_child_1")
  assert.equal(args.body.agent, "forge-wiki-reviewer")
  assert.deepEqual(args.body.parts, [{ type: "text", text: "go audit" }])
  assert.deepEqual(args.query, { directory: "C:/repo" })
  assert.equal(calls.prompt.length, 0)
})

test("sendPrompt: falls back to sync prompt endpoint when promptAsync is absent", async () => {
  const { client, calls } = fakeClient()
  delete client.session.promptAsync
  const r = await sendPrompt(client, { sessionID: "s", agentID: "g", prompt: "p" })
  assert.equal(r.ok, true)
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].body.agent, "g")
  // no directory → no query key at all
  assert.equal(calls.prompt[0].query, undefined)
})

test("buildPromptArgs: no directory yields no query key", () => {
  const args = buildPromptArgs({ sessionID: "s", agentID: "g", prompt: "p" })
  assert.equal(args.query, undefined)
})

test("pollChild: busy → completed, then fetchFinalMessage returns the assistant text", async () => {
  const statusSeq = [{ type: "busy" }, { type: "busy" }, { type: "idle" }]
  let i = 0
  const { client, calls } = fakeClient({
    status: () => ({ data: { ses_child_1: statusSeq[Math.min(i++, statusSeq.length - 1)] } }),
    messages: () => (i >= 2 ? [assistantMsg()] : []),
  })
  const time = fakeTime()
  const poll = await pollChild(client, { sessionID: "ses_child_1", intervalMs: 10, timeoutMs: 1000 }, time.seams)
  assert.equal(poll.status, "completed")
  // Soundness depth 3: the candidate (idle + finished textful message)
  // first holds at tick 3 and must stay stable through ticks 4-5 — the
  // verdict lands exactly on the 3rd consecutive candidate tick, not the 1st.
  assert.equal(poll.polls, 5)
  assert.deepEqual(time.slept, [10, 10, 10, 10, 10])
  // every poll round fetched messages with limit
  assert.ok(calls.messages.every((m) => m.path.id === "ses_child_1" && m.query.limit === 100))

  const final = await fetchFinalMessage(client, "ses_child_1")
  assert.equal(final.ok, true)
  assert.equal(final.text, "final report")
})

test("pollChild: terminal error on the latest assistant message wins even while busy", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [assistantMsg({ info: { finish: undefined, error: { name: "APIError", data: { message: "rate limited" } } } })],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 1, timeoutMs: 100 }, fakeTime().seams)
  assert.equal(poll.status, "error")
  assert.match(poll.error, /APIError/)
  assert.match(poll.error, /rate limited/)
})

test("pollChild: honest timeout names the child session id and timeout budget", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [],
  })
  const poll = await pollChild(client, { sessionID: "ses_stuck", intervalMs: 50, timeoutMs: 200 }, fakeTime().seams)
  assert.equal(poll.status, "timeout")
  assert.equal(poll.sessionID, "ses_stuck")
  assert.equal(poll.timeoutMs, 200)
  assert.ok(poll.polls >= 4)
})

test("pollChild: transient status failure keeps polling, later completion still lands", async () => {
  let round = 0
  const { client } = fakeClient({
    status: () => {
      round++
      if (round === 1) throw new Error("hiccup")
      return { data: { s: { type: "idle" } } }
    },
    messages: () => (round >= 2 ? [assistantMsg()] : []),
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 1, timeoutMs: 100 }, fakeTime().seams)
  assert.equal(poll.status, "completed")
})

test("fetchFinalMessage: picks the LATEST assistant message and joins only text parts", async () => {
  const { client } = fakeClient({
    messages: () => [
      { info: { id: "m1", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "text", text: "stale" }] },
      { info: { id: "m0", role: "user", time: { created: 0 } }, parts: [{ type: "text", text: "user prompt" }] },
      {
        info: { id: "m2", role: "assistant", finish: "stop", time: { created: 5 } },
        parts: [{ type: "reasoning", text: "thinking..." }, { type: "text", text: "line A" }, { type: "text", text: "line B" }],
      },
    ],
  })
  const r = await fetchFinalMessage(client, "s")
  assert.equal(r.ok, true)
  assert.equal(r.text, "line A\nline B")
})

test("fetchFinalMessage: honest failures for no assistant / no text", async () => {
  const none = fakeClient({ messages: () => [] })
  const rn = await fetchFinalMessage(none.client, "s")
  assert.equal(rn.ok, false)
  assert.match(rn.error, /no assistant response/)

  const toolOnly = fakeClient({
    messages: () => [{ info: { id: "m", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "tool", text: "ignored" }] }],
  })
  const rt = await fetchFinalMessage(toolOnly.client, "s")
  assert.equal(rt.ok, false)
  assert.match(rt.error, /no assistant text output/)
})

test("abortChild: calls session.abort with the child id; failure is honest", async () => {
  const { client, calls } = fakeClient()
  const ok = await abortChild(client, "ses_child_1")
  assert.equal(ok.ok, true)
  assert.deepEqual(calls.abort[0].path, { id: "ses_child_1" })

  const bad = fakeClient()
  bad.client.session.abort = async () => {
    throw new Error("gone")
  }
  const rb = await abortChild(bad.client, "s")
  assert.equal(rb.ok, false)
  assert.match(rb.error, /threw/)
})

// ---------------------------------------------------------------------------
// Sync abort parity (task-shadow design D4): pollChild watches the
// dispatching turn's abort signal and returns `aborted` — the caller aborts
// the child via the SDK and discloses.

test("pollChild: a signal already aborted before the first poll returns aborted immediately", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [],
  })
  const controller = new AbortController()
  controller.abort()
  const poll = await pollChild(client, { sessionID: "ses_c", intervalMs: 1, timeoutMs: 1000, signal: controller.signal }, fakeTime().seams)
  assert.equal(poll.status, "aborted")
  assert.equal(poll.sessionID, "ses_c")
  assert.equal(poll.polls, 1, "the abort was observed on the first poll slice")
})

test("pollChild: abort fired MID-POLL stops the loop with aborted (busy child never completes)", async () => {
  const controller = new AbortController()
  let round = 0
  const { client, calls } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [],
  })
  client.session.status = async () => {
    calls.status.push({})
    round++
    if (round === 2) controller.abort()
    return { data: { s: { type: "busy" } } }
  }
  const poll = await pollChild(client, { sessionID: "ses_mid", intervalMs: 5, timeoutMs: 10_000, signal: controller.signal }, fakeTime().seams)
  assert.equal(poll.status, "aborted")
  assert.equal(poll.sessionID, "ses_mid")
  assert.equal(poll.polls, 3, "aborted at the slice boundary after the signal fired, not after the timeout")
})

test("pollChild: no signal keeps the previous semantics (timeout stays honest)", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 20 }, fakeTime().seams)
  assert.equal(poll.status, "timeout")
})

// ---------------------------------------------------------------------------
// resolvePollTimeoutMs: the FORGE_DISPATCH_POLL_TIMEOUT_MS env knob
// (sync-timeout-notify tasks group 2) — default 600000 unchanged, honest
// fallback on junk (interval-knob tolerance posture), ceiling clamp.

test("resolvePollTimeoutMs: unset / empty env → default 600000", () => {
  assert.equal(resolvePollTimeoutMs({}), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: undefined }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "" }), DEFAULT_POLL_TIMEOUT_MS)
})

test("resolvePollTimeoutMs: a valid value takes effect", () => {
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "5000" }), 5000)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "123456.7" }), 123457, "fractional values round")
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "1" }), 1)
})

test("resolvePollTimeoutMs: junk / non-positive values fall back to the default", () => {
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "abc" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "10min" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "0" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "-5000" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "Infinity" }), DEFAULT_POLL_TIMEOUT_MS)
})

test("resolvePollTimeoutMs: oversized values clamp to the 1h ceiling", () => {
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "999999999999" }), MAX_POLL_TIMEOUT_MS)
  assert.equal(MAX_POLL_TIMEOUT_MS, 3_600_000)
})

// ---------------------------------------------------------------------------
// resolveNotifyIntervalMs: the FORGE_DISPATCH_NOTIFY_INTERVAL_MS knob
// (sync-timeout-notify fold #2, design D6) — the [forge:dispatch-progress]
// cadence + textless-idle floor window. Independent of the sync-wait knob.

test("resolveNotifyIntervalMs: unset / empty env → default 600000", () => {
  assert.equal(resolveNotifyIntervalMs({}), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: undefined }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "" }), DEFAULT_POLL_TIMEOUT_MS)
})

test("resolveNotifyIntervalMs: a valid value takes effect (test-friendly minimum)", () => {
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "50" }), 50)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "5000" }), 5000)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "123456.7" }), 123457, "fractional values round")
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "1" }), 1)
})

test("resolveNotifyIntervalMs: junk / non-positive values fall back to the default", () => {
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "abc" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "10min" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "0" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "-5000" }), DEFAULT_POLL_TIMEOUT_MS)
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "Infinity" }), DEFAULT_POLL_TIMEOUT_MS)
})

test("resolveNotifyIntervalMs: oversized values clamp to the 1h ceiling", () => {
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "999999999999" }), MAX_POLL_TIMEOUT_MS)
})

test("resolveNotifyIntervalMs: independent of FORGE_DISPATCH_POLL_TIMEOUT_MS (each knob reads its own key)", () => {
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_POLL_TIMEOUT_MS: "123" }), DEFAULT_POLL_TIMEOUT_MS, "the sync-wait knob does not feed the notify interval")
  assert.equal(resolvePollTimeoutMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "456" }), DEFAULT_POLL_TIMEOUT_MS, "the notify knob does not feed the sync wait")
  assert.equal(resolveNotifyIntervalMs({ FORGE_DISPATCH_NOTIFY_INTERVAL_MS: "70", FORGE_DISPATCH_POLL_TIMEOUT_MS: "9" }), 70)
})

// ---------------------------------------------------------------------------
// Terminal-inference soundness matrix (sync-timeout-notify tasks group 4):
// transient/unreadable status readings never terminate; completed needs the
// candidate stable across TERMINAL_STABILITY_TICKS consecutive ticks with a
// truthy finish AND non-empty text parts; busy flaps reset the run.

test("soundness: status fetch FAILING every tick (throw + error envelope) never terminates despite a finished message — honest timeout", async () => {
  // (a) throw branch
  const thr = fakeClient({ status: () => { throw new Error("endpoint down") }, messages: () => [assistantMsg()] })
  const pt = await pollChild(thr.client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(pt.status, "timeout", "status failure is treated as ACTIVE — no completion, no error verdict")

  // (a') {error} envelope branch (statusMap stays undefined)
  const env = fakeClient({ status: () => ({ error: "boom" }), messages: () => [assistantMsg()] })
  const pe = await pollChild(env.client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(pe.status, "timeout")
})

test("soundness: session MISSING from a fetched status map is the host's IDLE signal — completes at stability depth (host 1.19.5 empirics: the map lists only active sessions; a completed session is removed)", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { some_other_session: { type: "busy" } } }),
    messages: () => [assistantMsg()],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000 }, fakeTime().seams)
  assert.equal(poll.status, "completed", "missing-from-map = not-active (idle signal) — the stability depth makes it safe")
  assert.equal(poll.polls, TERMINAL_STABILITY_TICKS)
})

test("soundness: transient MISSING flake on a running child resets the run when it re-appears busy (texture-forge receipt-bug shape)", async () => {
  // Host 1.19.5 semantics: the map holds only active sessions. A running
  // child that blinks OUT of the map for a tick or two (server flake) looks
  // like a candidate (missing = idle signal) — but the stability run resets
  // the moment it re-appears busy, so the receipt observed during the flake
  // can never reach depth 3. Completed lands only on the stable tail.
  const seq = [{ s: { type: "busy" } }, {}, { s: { type: "busy" } }, { s: { type: "idle" } }, { s: { type: "idle" } }, { s: { type: "idle" } }]
  let tick = 0
  const { client, calls } = fakeClient({ messages: () => [assistantMsg()] })
  client.session.status = async () => {
    calls.status.push({})
    const entry = seq[Math.min(tick++, seq.length - 1)]
    return { data: Object.keys(entry).length ? entry : { other: { type: "busy" } } }
  }
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000 }, fakeTime().seams)
  assert.equal(poll.status, "completed", "the flake resets the run; completion only on the stable tail")
  assert.equal(poll.polls, 6, "tick1 busy → tick2 flake-candidate(run=1) → tick3 busy RESET → ticks 4-6 rebuild to depth 3")
})

test("soundness: receipt-then-busy resets the stability run — completed lands exactly at depth 3 after the reset", async () => {
  const statusSeq = ["idle", "busy", "idle", "idle", "idle"]
  let tick = 0
  const { client, calls } = fakeClient({ messages: () => [assistantMsg()] })
  client.session.status = async () => {
    calls.status.push({})
    return { data: { s: { type: statusSeq[Math.min(tick++, statusSeq.length - 1)] } } }
  }
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000 }, fakeTime().seams)
  assert.equal(poll.status, "completed")
  // tick1 candidate (run=1) → tick2 busy RESETS → ticks 3,4,5 rebuild the run
  // to depth 3 → the verdict lands exactly on tick 5 (not tick 3, not tick 4).
  assert.equal(poll.polls, 5, `completed exactly at the ${TERMINAL_STABILITY_TICKS}rd stable tick after the reset`)
  assert.equal(TERMINAL_STABILITY_TICKS, 3)
})

test("soundness: stable idle + finished textful message completes at EXACTLY tick 3 (regression: not tick 1)", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "idle" } } }),
    messages: () => [assistantMsg()],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000 }, fakeTime().seams)
  assert.equal(poll.status, "completed")
  assert.equal(poll.polls, TERMINAL_STABILITY_TICKS, "a clean run needs the full stability depth — the 1st observation is never a verdict")
})

test("soundness: idle + finished but TEXTLESS message polls to the honest timeout (a receipt is not a final report)", async () => {
  // (e) finish truthy, but the only text part is empty.
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "idle" } } }),
    messages: () => [{ info: { id: "m", role: "assistant", finish: "stop", time: { created: 1 } }, parts: [{ type: "text", text: "" }] }],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(poll.status, "timeout", "finished-but-textless keeps polling — covered upstream by the armed wake")

  // (e') FALSY finish ("") with text — not a finished message either.
  const falsy = fakeClient({
    status: () => ({ data: { s: { type: "idle" } } }),
    messages: () => [assistantMsg({ info: { finish: "" } })],
  })
  const pf = await pollChild(falsy.client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(pf.status, "timeout", 'finish must be TRUTHY — "" no longer passes (was `!== undefined` before)')
})

test("soundness: caller-owned stability state survives across pollChild calls (the async poll-slice seam)", async () => {
  // The async wiring runs pollChild in slices; sharing one stability object
  // keeps the consecutive run alive across slice timeouts.
  const stability = { stableTicks: 0 }
  let tick = 0
  const mk = () =>
    fakeClient({
      status: () => ({ data: { s: { type: "idle" } } }),
      messages: () => [assistantMsg()],
    })
  // Force re-read of tick via a shared counter across both clients.
  const first = mk()
  first.client.session.status = async () => {
    first.calls.status.push({})
    tick++
    return { data: { s: { type: "idle" } } }
  }
  const second = mk()
  second.client.session.status = async () => {
    second.calls.status.push({})
    tick++
    return { data: { s: { type: "idle" } } }
  }
  // Slice 1: timeout budget covers exactly ONE candidate observation.
  const p1 = await pollChild(first.client, { sessionID: "s", intervalMs: 5, timeoutMs: 5, stability }, fakeTime().seams)
  assert.equal(p1.status, "timeout", "slice 1 expires after one candidate tick")
  assert.equal(stability.stableTicks, 1, "the candidate observation survived the slice boundary in the shared state")
  // Slice 2: two more candidate ticks reach depth 3.
  const p2 = await pollChild(second.client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000, stability }, fakeTime().seams)
  assert.equal(p2.status, "completed")
  assert.equal(p2.polls, 2, "only the two remaining stable ticks were needed — the run was NOT reset by the slice timeout")
})

// ---------------------------------------------------------------------------
// sessionGet (dispatch-resilience fold B 2.1): the activity/existence probe.
// One session.get call serves the refresh rail (time.updated) and the
// existence probe (missing → finalize; fetch error → unresolved → skip).

function probeClient(get) {
  return { session: { get } }
}

test("sessionGet: envelope data with time.updated → exists + timestamp", async () => {
  const c = probeClient(async () => ({ data: { id: "s", time: { created: 1, updated: 1234 } } }))
  assert.deepEqual(await sessionGet(c, "s"), { exists: true, timeUpdated: 1234 })
})

test("sessionGet: bare record shape + time_updated fallback (omo parity)", async () => {
  const c = probeClient(async () => ({ time: { updated: 99 } }))
  assert.deepEqual(await sessionGet(c, "s"), { exists: true, timeUpdated: 99 })
  const c2 = probeClient(async () => ({ time_updated: 77 }))
  assert.deepEqual(await sessionGet(c2, "s"), { exists: true, timeUpdated: 77 })
})

test("sessionGet: record without any time field → exists, timeUpdated null", async () => {
  const c = probeClient(async () => ({ data: { directory: "d" } }))
  assert.deepEqual(await sessionGet(c, "s"), { exists: true, timeUpdated: null })
})

test("sessionGet: fetch errors are UNRESOLVED (exists null); not-found signals prove missing", async () => {
  const boom = probeClient(async () => { throw new Error("endpoint down") })
  assert.deepEqual(await sessionGet(boom, "s"), { exists: null, timeUpdated: null }, "generic throw → unresolved, never a verdict")
  const envelope = probeClient(async () => ({ error: "boom" }))
  assert.deepEqual(await sessionGet(envelope, "s"), { exists: null, timeUpdated: null })
  const notFoundThrow = probeClient(async () => { throw new Error("session not found") })
  assert.deepEqual(await sessionGet(notFoundThrow, "s"), { exists: false, timeUpdated: null }, "404/not-found text proves gone")
  const notFoundStatus = probeClient(async () => { const e = new Error("x"); e.status = 404; throw e })
  assert.deepEqual(await sessionGet(notFoundStatus, "s"), { exists: false, timeUpdated: null })
})

test("sessionGet: envelope with data null → missing; absent endpoint → unresolved", async () => {
  const c = probeClient(async () => ({ data: null }))
  assert.deepEqual(await sessionGet(c, "s"), { exists: false, timeUpdated: null })
  assert.deepEqual(await sessionGet({ session: {} }, "s"), { exists: null, timeUpdated: null }, "no session.get on the client → unresolved, sweeps skip")
})

// ---------------------------------------------------------------------------
// Stale knobs (fold B 2.2/2.3): tolerance convention + the 60 s floor clamp.

test("resolveStaleMs: unset/empty/junk/non-positive → default 2700000", () => {
  assert.equal(DEFAULT_STALE_MS, 2_700_000)
  assert.equal(resolveStaleMs({}), DEFAULT_STALE_MS)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "" }), DEFAULT_STALE_MS)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "abc" }), DEFAULT_STALE_MS)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "0" }), DEFAULT_STALE_MS)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "-5" }), DEFAULT_STALE_MS)
})

test("resolveStaleMs: valid values take effect but NEVER below the 60 s floor (clamp UP)", () => {
  assert.equal(MIN_STALE_RUNTIME_MS, 60_000)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "300000" }), 300000)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "3600000" }), 3_600_000)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "5" }), 60_000, "sub-floor values clamp up")
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "59999" }), 60_000)
  assert.equal(resolveStaleMs({ FORGE_DISPATCH_STALE_MS: "60000" }), 60_000)
})

test("resolveStaleMode: kill default; observe recognized; junk → kill", () => {
  assert.equal(resolveStaleMode({}), "kill")
  assert.equal(resolveStaleMode({ FORGE_DISPATCH_STALE_MODE: "observe" }), "observe")
  assert.equal(resolveStaleMode({ FORGE_DISPATCH_STALE_MODE: "OBSERVE" }), "observe")
  assert.equal(resolveStaleMode({ FORGE_DISPATCH_STALE_MODE: "kill" }), "kill")
  assert.equal(resolveStaleMode({ FORGE_DISPATCH_STALE_MODE: "nonsense" }), "kill")
  assert.equal(resolveStaleMode({ FORGE_DISPATCH_STALE_MODE: "" }), "kill")
})

test("resolveStaleFloorMs: fixed 60 s default; internal test seam override; junk → default", () => {
  assert.equal(resolveStaleFloorMs({}), MIN_STALE_RUNTIME_MS)
  assert.equal(resolveStaleFloorMs({ FORGE_DISPATCH_STALE_FLOOR_MS: "50" }), 50)
  assert.equal(resolveStaleFloorMs({ FORGE_DISPATCH_STALE_FLOOR_MS: "abc" }), MIN_STALE_RUNTIME_MS)
  assert.equal(resolveStaleFloorMs({ FORGE_DISPATCH_STALE_FLOOR_MS: "-1" }), MIN_STALE_RUNTIME_MS)
})

// ---------------------------------------------------------------------------
// Stale sweep helpers (fold B): pure gate + decision + probe application.

test("staleThresholdCrossed: the 60 s runtime floor blocks early reap however silent", () => {
  const state = { lastActivity: null, staleNotified: false }
  const startedAt = 1_000_000
  // anchor silent for the FULL threshold, but the child is younger than the floor
  assert.equal(staleThresholdCrossed(state, startedAt + 2_700_000, startedAt, 2_700_000, 60_000), true, "floor met + threshold met → crossed")
  assert.equal(staleThresholdCrossed(state, startedAt + 2_700_000, startedAt, 2_700_000, 3_600_000), false, "floor NOT met → never crossed (however silent)")
  assert.equal(staleThresholdCrossed(state, startedAt + 59_999, startedAt, 1000, 60_000), false, "sub-floor runtime is untouchable")
})

test("staleThresholdCrossed: anchor = last observed time.updated, else dispatch start (no-message child)", () => {
  // No message ever → lastActivity null → anchor = dispatch start.
  const none = { lastActivity: null, staleNotified: false }
  assert.equal(staleThresholdCrossed(none, 5_000_000, 5_000_000 - 60_001, 60_000, 60_000), true)
  // Observed anchor in the past (clock-skew adoption) is honored — and
  // DISTINGUISHES from the start-time fallback anchor.
  const adopted = { lastActivity: 1_000, staleNotified: false }
  const startedAt = 5_000_000 - 3_600_000
  assert.equal(staleThresholdCrossed(adopted, 5_000_000, startedAt, 4_000_000, 60_000), true, "anchor adopted from time.updated, even before dispatch start")
  assert.equal(staleThresholdCrossed({ lastActivity: null, staleNotified: false }, 5_000_000, startedAt, 4_000_000, 60_000), false, "null anchor falls back to dispatch start (not yet silent long enough)")
})

test("applyStaleProbe: first observation ADOPTS the host timestamp; a refresh resets the notify flag", () => {
  const state = { lastActivity: null, staleNotified: true }
  applyStaleProbe(state, { exists: true, timeUpdated: 500 })
  assert.equal(state.lastActivity, 500, "first observation adopts the anchor")
  assert.equal(state.staleNotified, false, "adoption resets the observe-notify flag")
  applyStaleProbe(state, { exists: true, timeUpdated: 400 })
  assert.equal(state.lastActivity, 500, "an OLDER timestamp never moves the anchor")
  applyStaleProbe(state, { exists: true, timeUpdated: 900 })
  assert.equal(state.lastActivity, 900, "a refreshed timestamp advances the anchor (producing child)")
  applyStaleProbe(state, { exists: null, timeUpdated: null })
  assert.equal(state.lastActivity, 900, "unresolved probes change nothing")
  applyStaleProbe(state, { exists: true, timeUpdated: null })
  assert.equal(state.lastActivity, 900, "records without time.updated change nothing")
})

test("decideStaleSweep: the full decision matrix (skip / gone / notify / quiet / kill)", () => {
  const state = { lastActivity: 100, staleNotified: false }
  assert.deepEqual(decideStaleSweep({ exists: null, timeUpdated: null }, state, "kill"), { action: "skip" }, "unresolved → skip the sweep")
  assert.deepEqual(decideStaleSweep({ exists: false, timeUpdated: null }, state, "kill"), { action: "gone" }, "missing session → finalize")
  assert.deepEqual(decideStaleSweep({ exists: true, timeUpdated: 100 }, state, "kill"), { action: "kill" }, "silent child in kill mode → kill")
  assert.deepEqual(decideStaleSweep({ exists: true, timeUpdated: null }, state, "kill"), { action: "kill" }, "no timestamp + silent-since-start → kill")
  assert.deepEqual(decideStaleSweep({ exists: true, timeUpdated: 100 }, state, "observe"), { action: "notify" }, "observe crossing #1 → notify")
  const notified = { lastActivity: 100, staleNotified: true }
  assert.deepEqual(decideStaleSweep({ exists: true, timeUpdated: 100 }, notified, "observe"), { action: "quiet" }, "observe ticks after the notice stay quiet")
})

test("staleSilentMinutes: honest minute figure, minimum 1", () => {
  assert.equal(staleSilentMinutes({ lastActivity: null, staleNotified: false }, 60_000, 0), 1)
  assert.equal(staleSilentMinutes({ lastActivity: 0, staleNotified: false }, 45 * 60_000, 0), 45)
})

// ---------------------------------------------------------------------------
// Error classifier (fold C 3.1) — ported from omo's error-classifier.ts.

test("classifyDispatchError: RETRYABLE — transient transport / 5xx / overload / rate-limit patterns", () => {
  const retryable = [
    "fetch failed",
    "ECONNRESET while streaming",
    "ApiError: connection refused by peer",
    "socket hang up",
    "ETIMEDOUT after 30000ms",
    "request timeout",
    "provider overloaded — try again later",
    "rate limit exceeded for model glm",
    "Too Many Requests",
    "APIError 503: Service Unavailable",
    "internal server error",
    "bad gateway",
    "gateway timeout",
  ]
  for (const text of retryable) assert.equal(classifyDispatchError(text), "retryable", `expected retryable: ${text}`)
  // numeric status on the error OBJECT (statusCode/status/code keys)
  assert.equal(classifyDispatchError({ statusCode: 503, message: "upstream broke" }), "retryable")
  assert.equal(classifyDispatchError({ status: 429 }), "retryable")
  assert.equal(classifyDispatchError({ code: 500 }), "retryable")
  assert.equal(classifyDispatchError({ response: { status: 502 } }), "retryable")
})

test("classifyDispatchError: DETERMINISTIC — omo's terminal set + auth + contract classes", () => {
  const deterministic = [
    "no provider available",
    "provider not configured for this model",
    "unknown provider: zai",
    "model not supported: glm-unknown",
    "model_not_supported",
    "model not found",
    "missing API key for provider",
    "no api key configured",
    "authentication key is required",
    "no models available",
    "all providers are unavailable",
    "unauthorized",
    "403 Forbidden",
    "invalid_request_error: max_tokens too large",
    "bad request",
    "Error 400: malformed body",
  ]
  for (const text of deterministic) assert.equal(classifyDispatchError(text), "deterministic", `expected deterministic: ${text}`)
  assert.equal(classifyDispatchError({ statusCode: 401, message: "bad key" }), "deterministic")
  assert.equal(classifyDispatchError({ status: 403 }), "deterministic")
  assert.equal(classifyDispatchError({ code: 400 }), "deterministic")
})

test("classifyDispatchError: UNKNOWN classes are fail-closed deterministic; deterministic WINS overlaps", () => {
  assert.equal(classifyDispatchError("kaput"), "deterministic", "unrecognized → never retried")
  assert.equal(classifyDispatchError({}), "deterministic")
  assert.equal(classifyDispatchError(undefined), "deterministic")
  assert.equal(
    classifyDispatchError("no provider available (connection reset while probing)"),
    "deterministic",
    "a provider-config error is terminal even when transport words ride along",
  )
})

// ---------------------------------------------------------------------------
// Retry prompt + attempt/backoff knobs (fold C 3.2).

test("buildRetryPrompt: the inspect-then-continue preamble is PREPENDED, clearly separated, original intact", () => {
  const prompt = buildRetryPrompt("go audit the repo")
  assert.ok(prompt.startsWith(RESUME_PREAMBLE), "the preamble leads")
  assert.ok(prompt.includes("inspect the current workspace state"), "inspect instruction")
  assert.ok(prompt.includes("CONTINUE the work"), "continue-not-redo instruction")
  assert.ok(prompt.endsWith("go audit the repo"), "the ORIGINAL prompt rides verbatim at the end")
  assert.match(prompt, /--- Original task ---/, "clear separator between preamble and original")
})

test("resolveMaxAttempts: default 2; junk → default; ≥1 enforced with a ceiling", () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 2)
  assert.equal(resolveMaxAttempts({}), 2)
  assert.equal(resolveMaxAttempts({ FORGE_DISPATCH_MAX_ATTEMPTS: "" }), 2)
  assert.equal(resolveMaxAttempts({ FORGE_DISPATCH_MAX_ATTEMPTS: "abc" }), 2)
  assert.equal(resolveMaxAttempts({ FORGE_DISPATCH_MAX_ATTEMPTS: "0" }), 2)
  assert.equal(resolveMaxAttempts({ FORGE_DISPATCH_MAX_ATTEMPTS: "-3" }), 2)
  assert.equal(resolveMaxAttempts({ FORGE_DISPATCH_MAX_ATTEMPTS: "3" }), 3)
  assert.equal(resolveMaxAttempts({ FORGE_DISPATCH_MAX_ATTEMPTS: "99" }), 10, "sanity ceiling")
})

test("resolveRetryBackoffMs: fixed 10 s default; test-seam override; junk → default", () => {
  assert.equal(RETRY_BACKOFF_MS, 10_000)
  assert.equal(resolveRetryBackoffMs({}), 10_000)
  assert.equal(resolveRetryBackoffMs({ FORGE_DISPATCH_RETRY_BACKOFF_MS: "30" }), 30)
  assert.equal(resolveRetryBackoffMs({ FORGE_DISPATCH_RETRY_BACKOFF_MS: "abc" }), 10_000)
  assert.equal(resolveRetryBackoffMs({ FORGE_DISPATCH_RETRY_BACKOFF_MS: "-1" }), 10_000)
})

// ---------------------------------------------------------------------------
// dispatch-stream-loss-honesty task 1: the sustained view-loss detector —
// pollChild classifies a fully-unreadable poll view (status AND messages
// both failing) sustained across the streak as `stream-lost` — an honest
// UNKNOWN, never a terminal verdict on the child. Single unreadable ticks
// are noise (the existing active posture); a status-only failure is the
// SSE-cache-empty case (active, keep polling); any readable tick resets
// the streak.

const throwingStatus = () => {
  throw new Error("Connection reset")
}

test("stream-lost: a sustained FULLY-unreadable view (status AND messages) classifies stream-lost at the threshold", async () => {
  const { client } = fakeClient({
    status: throwingStatus,
    messages: () => {
      throw new Error("Connection reset")
    },
  })
  const { seams } = fakeTime()
  const result = await pollChild(
    client,
    { sessionID: "ses_vl1", intervalMs: 1, timeoutMs: 60_000, viewLossTicks: 3 },
    seams,
  )
  assert.equal(result.status, "stream-lost", "the sustained unreadable view classifies stream-lost")
  assert.equal(result.sessionID, "ses_vl1")
  assert.ok(result.polls >= 3, "the return carries the poll count")
})

test("stream-lost: a single unreadable tick is noise — recovery keeps polling to the honest timeout", async () => {
  let statusCalls = 0
  const { client } = fakeClient({
    status: () => {
      statusCalls++
      if (statusCalls === 1) throwingStatus()
      return { data: {} } // readable from tick 2: child idle-ish, no report
    },
    messages: () => {
      if (statusCalls === 1) throw new Error("Connection reset")
      return []
    },
  })
  const { seams } = fakeTime()
  const result = await pollChild(
    client,
    { sessionID: "ses_vl2", intervalMs: 1, timeoutMs: 50, viewLossTicks: 3 },
    seams,
  )
  assert.equal(result.status, "timeout", "one lost tick never classifies stream-lost — the honest timeout is the bound")
  assert.equal(result.sessionID, "ses_vl2")
})

test("stream-lost: a status-ONLY failure is the active posture (SSE cache empty) — never stream-lost", async () => {
  const { client } = fakeClient({
    status: throwingStatus,
    // messages READABLE: the view is half-alive — the detector demands BOTH.
    messages: () => [],
  })
  const { seams } = fakeTime()
  const result = await pollChild(
    client,
    { sessionID: "ses_vl3", intervalMs: 1, timeoutMs: 50, viewLossTicks: 3 },
    seams,
  )
  assert.equal(result.status, "timeout", "a status-only failure keeps the active posture to the timeout")
})

test("stream-lost: the streak RESETS on any readable tick — broken-recover-broken never accumulates", async () => {
  let statusCalls = 0
  const { client } = fakeClient({
    status: () => {
      statusCalls++
      // Every THIRD tick readable: t1,t2 unreadable (2), t3 readable (reset),
      // t4,t5 unreadable (2), t6 readable... the streak never accumulates.
      if (statusCalls % 3 !== 0) throwingStatus()
      return { data: {} }
    },
    messages: () => {
      if (statusCalls % 3 !== 0) throw new Error("Connection reset")
      return []
    },
  })
  const { seams } = fakeTime()
  const result = await pollChild(
    client,
    { sessionID: "ses_vl4", intervalMs: 1, timeoutMs: 50, viewLossTicks: 3 },
    seams,
  )
  assert.equal(result.status, "timeout", "a resetting streak never reaches the threshold — timeout, not stream-lost")
})

test("stream-lost: the streak SURVIVES slice boundaries via the shared stability state", async () => {
  const { client } = fakeClient({
    status: throwingStatus,
    messages: () => {
      throw new Error("Connection reset")
    },
  })
  const { seams } = fakeTime()
  // Slice 1: threshold 8 — returns timeout (slice deadline) with the streak
  // carried in the SHARED state; slice 2 continues the SAME state object and
  // crosses the raised threshold after 4 more ticks (not 9).
  const stability = { stableTicks: 0 }
  const slice1 = await pollChild(client, { sessionID: "ses_vl5", intervalMs: 1, timeoutMs: 5, viewLossTicks: 8, stability }, seams)
  assert.equal(slice1.status, "timeout", "slice 1 ends at its slice deadline")
  assert.equal(stability.viewLossTicks, 5, "the shared state carries the sustained streak across slices")
  const slice2 = await pollChild(client, { sessionID: "ses_vl5", intervalMs: 1, timeoutMs: 60_000, viewLossTicks: 9, stability }, seams)
  assert.equal(slice2.status, "stream-lost", "slice 2 crosses the (raised) threshold by continuing the streak")
})

// ---------------------------------------------------------------------------
// Active-textful completion override (harden-dispatch-resilience D1): a
// status view stuck on active while the final assistant text is already out
// completes from the message stream alone, at the SAME 3-tick stability
// window, with via="active-textful". NO text ⇒ the override never fires
// (stuck-active stays honest — textless-idle/stale handling governs).
// ---------------------------------------------------------------------------

test("active-textful override: status stuck busy + finished textful message → COMPLETE at the same 3-tick window, via=active-textful", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [assistantMsg()],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000 }, fakeTime().seams)
  assert.equal(poll.status, "completed", "the message stream alone establishes completion")
  assert.equal(poll.via, "active-textful", "the override path is disclosed on the result")
  assert.equal(poll.polls, TERMINAL_STABILITY_TICKS, "the SAME 3-tick stability window — no fast path")
})

test("active-textful override: a flapped run resets — busy-with-text then busy-without-text never completes", async () => {
  let tick = 0
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => (tick++ < 2 ? [assistantMsg()] : []),
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(poll.status, "timeout", "two override ticks then a textless observation reset the run — no completion invented")
})

test("active-textful override: stuck-active with NO text stays honest (existing timeout semantics govern)", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "busy" } } }),
    messages: () => [],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(poll.status, "timeout", "no text ⇒ never a fabricated completion")
  assert.equal(poll.via, undefined)
})

test("active-textful override: the healthy not-active path is UNCHANGED (no via flag)", async () => {
  const { client } = fakeClient({
    status: () => ({ data: { s: { type: "idle" } } }),
    messages: () => [assistantMsg()],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 1000 }, fakeTime().seams)
  assert.equal(poll.status, "completed")
  assert.equal(poll.via, undefined, "an ordinary completion never claims the override")
  assert.equal(poll.polls, TERMINAL_STABILITY_TICKS)
})

test("active-textful override: an UNREADABLE status map never advances the run (soundness posture intact)", async () => {
  const { client } = fakeClient({
    status: () => {
      throw new Error("view down")
    },
    messages: () => [assistantMsg()],
  })
  const poll = await pollChild(client, { sessionID: "s", intervalMs: 5, timeoutMs: 30 }, fakeTime().seams)
  assert.equal(poll.status, "timeout", "a status we cannot read is never a completion signal — override or not")
})

test("active-textful override: the streak survives poll-slice boundaries via the shared stability state", async () => {
  // Slice 1 banks two active-textful ticks; slice 2 (fresh pollChild call,
  // SAME stability object — the async wiring's seam) supplies the third.
  const stability = { stableTicks: 0 }
  const mk = () =>
    fakeClient({
      status: () => ({ data: { s: { type: "busy" } } }),
      messages: () => [assistantMsg()],
    })
  const { seams } = fakeTime()
  const p1 = await pollChild(mk().client, { sessionID: "s", intervalMs: 1, timeoutMs: 1, stability }, seams)
  assert.equal(p1.status, "timeout", "slice 1 ends at its slice deadline")
  assert.equal(stability.activeTextfulTicks, 1)
  const p2 = await pollChild(mk().client, { sessionID: "s", intervalMs: 1, timeoutMs: 1000, stability }, seams)
  assert.equal(p2.status, "completed")
  assert.equal(p2.via, "active-textful", "the override run survived the slice boundary")
})
