import test from "node:test"
import assert from "node:assert/strict"

// dispatch-async core (async-dispatch wave 1): child-session create body
// (parentID link + question-deny seal + native title format), prompt send
// args, status polling to terminal (completed / error / honest timeout),
// final assistant message fetch, abort — all against a fake structural
// client, clock and sleeper fully injected (no real timers).

import {
  QUESTION_DENY_PERMISSION,
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
} from "../src/dispatch-async.ts"

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
  assert.equal(QUESTION_DENY_PERMISSION.length, 1)
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
