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
  assert.equal(poll.polls, 3)
  assert.deepEqual(time.slept, [10, 10, 10])
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
