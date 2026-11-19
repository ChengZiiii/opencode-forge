// V2 mock-context harness (change v2-plugin-api-port, task 1.1).
//
// Mirrors the goal-mode stub-client pattern: one factory builds a mock V2
// plugin context whose domains record every registration into inspectable
// state. Every domain exists in a WIRED shape mirroring the REAL SDK 2.3.2
// surfaces (W6a field realities — promise/plugin.d.ts Context domains;
// previous SANDBOX-PENDING guesses are gone) and can be DRIFTED per-domain
// (missing / method-not-a-function / bad-editor-shape) to exercise the
// structural-typing no-op contract.
//
// W6a shapes: event.subscribe(options?) returns an ASYNC ITERABLE of
// {id, type, data} envelopes (state.emit(type, data) feeds it);
// session.prompt takes the FLAT root-level {sessionID, text} (live shape
// matrix 2026-11-19: prompt:{text}/{path,body} spellings throw SchemaError
// on the 2.3.2 promise layer; recorded in state.prompts); session.hook
// returns {dispose}; permission.hook("evaluate") captures the MUTABLE
// PermissionEvaluation and permission.assert records decisions; the tool
// editor keys entries by id (effective name).

export const V2_DOMAINS = ["agent", "tool", "permission", "session", "command", "event", "skill"]

// Drift modes every domain understands:
//   "missing"       — the domain key is absent from ctx
//   "not-function"  — the domain exists but its registration method is not callable
//   "bad-shape"     — the method is callable but hands the plugin a garbage
//                     draft/editor (get: 5, add: null, ...) — the guard contract
export const V2_DRIFT_MODES = ["missing", "not-function", "bad-shape"]

export function createV2MockContext(opts = {}) {
  const drift = opts.drift ?? {}
  const state = {
    // agent domain
    agents: new Map(),
    // tool domain
    tools: new Map(),
    toolHooks: [], // ctx.tool.hook(name, cb) registrations (W4 seam)
    // permission domain (W3/W6a seam)
    permissionHooks: [], // { name, cb }
    asserts: [], // permission.assert(input) decisions
    assertBehavior: null, // null = resolve (allow); "deny" = reject; (input) => void custom
    // session domain (W4/W6a seam)
    sessionHooks: [], // { name, cb, registration }
    sessionHookDisposed: [], // disposed hook names
    // session domain READS/SENDS (W5/W6a seam): the goal continuation engine
    // and the job-wake queue ride these (prompt = flat SessionPrompt).
    sessionRecords: new Map(), // get({path:{id}} | {sessionID}) -> record
    prompts: [], // session.prompt({sessionID, text}) sends (continuations AND wakes)
    // command domain (W4 seam)
    commands: new Map(),
    // event domain (W5/W6a seam): subscribe() returns an AsyncIterable;
    // emit() pushes {id, type, data} envelopes through every live one.
    subscriptions: [], // { options, closed } — live/closed subscriptions
    subscriptionsAborted: 0,
    eventSeq: 0,
    // skill domain
    skillSources: [],
    // raw record of which transform/hook callbacks actually ran
    calls: { agentTransform: 0, toolTransform: 0, commandTransform: 0, skillTransform: 0 },
  }

  const badDraft = { list: 5, get: null, update: "no", remove: {} }
  const badToolEditor = { add: null, list: 5, get: {} }

  // Emit an OpenCodeEvent envelope {id, type, data} through every live
  // subscription (the host's broadcast). Resolves once the envelopes are
  // handed to the iterators (the consumer loop may still be draining —
  // tests sleep/await as before).
  state.emit = async (type, data = {}) => {
    const envelope = { id: `evt_${++state.eventSeq}`, type, data }
    for (const sub of state.subscriptions) {
      if (sub.closed) continue
      sub.queue.push(envelope)
      sub.wake?.()
    }
  }

  const domains = {
    agent: {
      transform: async (cb) => {
        state.calls.agentTransform++
        await cb({
          list: () => [...state.agents.keys()].map((id) => ({ id })),
          get: (id) => state.agents.get(id),
          update: (id, fn) => {
            const a = state.agents.get(id) ?? {}
            fn(a)
            state.agents.set(id, a)
          },
          remove: (id) => state.agents.delete(id),
        })
      },
    },
    tool: {
      transform: async (cb) => {
        state.calls.toolTransform++
        await cb({
          add: (def) => {
            if (!def || typeof def.name !== "string") return
            // ToolEditor entries carry an id (effective name key).
            state.tools.set(def.name, { ...def, id: def.name })
          },
          list: () => [...state.tools.values()],
          get: (id) => state.tools.get(id),
          update: (id, fn) => {
            const t = state.tools.get(id)
            if (t) fn(t)
          },
          remove: (id) => state.tools.delete(id),
        })
      },
      hook: (name, cb) => {
        state.toolHooks.push({ name, cb })
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: (name, cb) => {
        state.permissionHooks.push({ name, cb })
        return { dispose: async () => {} }
      },
      // assert per permission.d.ts: resolves when allowed, rejects on deny.
      assert: async (input) => {
        state.asserts.push(input)
        if (state.assertBehavior === "deny") {
          throw Object.assign(new Error(`[mock] permission denied: ${input?.action}`), { name: "ToolError" })
        }
        if (typeof state.assertBehavior === "function") state.assertBehavior(input)
      },
    },
    session: {
      hook: (name, cb) => {
        const entry = { name, cb }
        state.sessionHooks.push(entry)
        return {
          registration: {
            dispose: async () => {
              state.sessionHookDisposed.push(name)
            },
          },
        }.registration
      },
      // W6a field reality: flat {sessionID, text} prompt in (blocking, no
      // promptAsync/status on the promise layer).
      get: async (opts) => state.sessionRecords.get(opts?.path?.id ?? opts?.sessionID),
      prompt: async (input) => {
        state.prompts.push(input)
        return { ok: true }
      },
      context: async (opts) => [],
    },
    command: {
      // W6a field reality: the v2 editor exposes ONLY add() — CommandDefinition
      // is EXECUTE-based {name, description?, execute({sessionID, prompt,
      // delivery})} (promise/command.d.ts); no get/list/remove on the editor.
      transform: async (cb) => {
        state.calls.commandTransform++
        await cb({
          add: (def) => {
            if (!def || typeof def.name !== "string") return
            state.commands.set(def.name, def)
          },
        })
      },
    },
    event: {
      // W6a: subscribe(options?) -> AsyncIterable of {id, type, data}.
      // options: { types?, signal? } (SubscribeOptions); the iterator
      // closes on signal abort or iterator.return().
      subscribe: (options = {}) => {
        const entry = { options, closed: false, queue: [], waiters: [], wake: null }
        state.subscriptions.push(entry)
        const signal = options?.signal
        const close = () => {
          if (entry.closed) return
          entry.closed = true
          state.subscriptionsAborted++
          for (const w of entry.waiters.splice(0)) w({ done: true, value: undefined })
          entry.wake = null
        }
        signal?.addEventListener?.("abort", close, { once: true })
        if (signal?.aborted) close()
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (entry.queue.length > 0) return Promise.resolve({ done: false, value: entry.queue.shift() })
              if (entry.closed) return Promise.resolve({ done: true, value: undefined })
              return new Promise((resolve) => {
                entry.waiters.push(resolve)
                entry.wake = () => {
                  entry.wake = null
                  const v = entry.queue.shift()
                  resolve(v !== undefined ? { done: false, value: v } : { done: true, value: undefined })
                }
              })
            },
            return: () => {
              close()
              return Promise.resolve({ done: true, value: undefined })
            },
          }),
        }
      },
    },
    skill: {
      transform: async (cb) => {
        state.calls.skillTransform++
        await cb({
          source: (src) => {
            state.skillSources.push(src)
          },
          list: () => state.skillSources.map((s, i) => ({ id: `skill-${i}`, ...s })),
        })
      },
    },
  }

  const ctx = {}
  for (const domain of V2_DOMAINS) {
    const mode = drift[domain]
    if (mode === "missing") continue // key absent entirely
    if (mode === "not-function") {
      // Shape drift: the method the plugin looks for is not callable.
      if (domain === "permission" || domain === "session") ctx[domain] = { hook: {} }
      else if (domain === "event") ctx[domain] = { subscribe: null }
      else ctx[domain] = { transform: 5 }
      continue
    }
    if (mode === "bad-shape") {
      // Method callable, hands over a garbage draft/editor (or, for the
      // hook/subscribe domains, still records — drift lives in the events
      // and payloads the tests feed).
      if (domain === "permission") {
        ctx[domain] = { hook: (name, cb) => state.permissionHooks.push({ name, cb, badShape: true }), assert: async () => {} }
      } else if (domain === "session") {
        ctx[domain] = { hook: (name, cb) => state.sessionHooks.push({ name, cb, badShape: true }) }
      } else if (domain === "event") {
        ctx[domain] = { subscribe: () => 5 }
      } else if (domain === "agent") {
        ctx[domain] = { transform: async (cb) => void (await cb(badDraft)) }
      } else if (domain === "tool") {
        ctx[domain] = { transform: async (cb) => void (await cb(badToolEditor)), hook: (name, cb) => state.toolHooks.push({ name, cb }) }
      } else if (domain === "command") {
        ctx[domain] = { transform: async (cb) => void (await cb(badDraft)) }
      } else if (domain === "skill") {
        ctx[domain] = { transform: async (cb) => void (await cb({ source: 5, list: null })) }
      }
      continue
    }
    ctx[domain] = domains[domain]
  }

  return { ctx, state }
}
