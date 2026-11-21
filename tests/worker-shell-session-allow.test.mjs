import test from "node:test"
import assert from "node:assert/strict"

// worker-shell-session-allow (tasks 2.1–2.4) — the session-rule rescue for
// the host's cross-anchor deny-all (evidence: reports/probe-native-worker-
// shell-denial.md §6, reports/research-plugin-tool-permission.md §1 —
// v2.3.2 permission.ts resolves the assert's agent at the PLUGIN HOST's
// location; native worker mds register only at the project location, so
// the assert falls back to a literal deny-all BEFORE any rule is
// consulted). Design D2 (session rules merge last, findLast wins),
// D3 (dual-shape posture, deny is sacred), D4 (read-back-merge injection,
// idempotent, primary inheritance + worker belt), D5 (worker-scoped
// fallback belt, disclosed once per session).

import { resolveForgeShellPosture, v2Setup, __workerShellRescueTestSurface as S } from "../plugin.ts"

const BARE_DENY = new Error("Permission denied: forge_shell")

function fakeAsk(behavior) {
  return (input) => {
    const b = typeof behavior === "function" ? behavior(input) : behavior
    if (b instanceof Error) throw b
    return Promise.resolve(b ?? {})
  }
}

// ---------------------------------------------------------------------------
// 2.1 Posture dual-shape matrix (pure core)
// ---------------------------------------------------------------------------

test("posture: no/empty/broken documents resolve undefined (fail-soft)", () => {
  assert.equal(resolveForgeShellPosture([]), undefined)
  assert.equal(resolveForgeShellPosture([null]), undefined)
  assert.equal(resolveForgeShellPosture([""]), undefined)
  assert.equal(resolveForgeShellPosture(["{ not jsonc {{{"]), undefined)
})

test("posture: legacy v1 permission map resolves all three values", () => {
  for (const v of ["allow", "deny", "ask"]) {
    assert.equal(resolveForgeShellPosture([`{ "permission": { "forge_shell": "${v}" } }`]), v)
  }
  assert.equal(resolveForgeShellPosture([`{ "permission": { "forge_shell": "bogus" } }`]), undefined)
})

test("posture: v2 permissions array — exact action, wildcard action, resource gating", () => {
  const doc = (rules) => JSON.stringify({ permissions: rules })
  assert.equal(resolveForgeShellPosture([doc([{ action: "forge_shell", resource: "*", effect: "deny" }])]), "deny")
  assert.equal(resolveForgeShellPosture([doc([{ action: "*", resource: "*", effect: "allow" }])]), "allow")
  // a non-* resource never matches our assert shape (resource "*")
  assert.equal(resolveForgeShellPosture([doc([{ action: "forge_shell", resource: "git *", effect: "deny" }])]), undefined)
  // a foreign action never matches
  assert.equal(resolveForgeShellPosture([doc([{ action: "edit", resource: "*", effect: "deny" }])]), undefined)
  // '?' wildcard matches
  assert.equal(resolveForgeShellPosture([doc([{ action: "forge_shel?", resource: "*", effect: "ask" }])]), "ask")
})

test("posture: v2 array resolves LAST-match-wins (host findLast parity)", () => {
  const doc = JSON.stringify({
    permissions: [
      { action: "forge_shell", resource: "*", effect: "deny" },
      { action: "*", resource: "*", effect: "allow" },
    ],
  })
  assert.equal(resolveForgeShellPosture([doc]), "allow")
  const docReversed = JSON.stringify({
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "forge_shell", resource: "*", effect: "deny" },
    ],
  })
  assert.equal(resolveForgeShellPosture([docReversed]), "deny")
})

test("posture: v2 array wins within a document over the legacy map", () => {
  const doc = JSON.stringify({
    permissions: [{ action: "forge_shell", resource: "*", effect: "deny" }],
    permission: { forge_shell: "allow" },
  })
  assert.equal(resolveForgeShellPosture([doc]), "deny")
  // array present but no matching rule → the legacy map still speaks
  const docFallthrough = JSON.stringify({
    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
    permission: { forge_shell: "ask" },
  })
  assert.equal(resolveForgeShellPosture([docFallthrough]), "ask")
})

test("posture: workspace document overrides global (order = lowest→highest)", () => {
  const globalDoc = JSON.stringify({ permission: { forge_shell: "deny" } })
  const wsDoc = JSON.stringify({ permissions: [{ action: "forge_shell", resource: "*", effect: "allow" }] })
  assert.equal(resolveForgeShellPosture([globalDoc, wsDoc]), "allow")
  assert.equal(resolveForgeShellPosture([wsDoc, globalDoc]), "deny")
})

// ---------------------------------------------------------------------------
// 2.2 Injection helper matrix
// ---------------------------------------------------------------------------

function fakeSessionApi(existing) {
  const updates = []
  return {
    updates,
    api: {
      get: async (sessionID) => ({ id: sessionID, permissions: structuredClone(existing) }),
      update: async (input) => {
        updates.push(input)
        existing = input.permissions
      },
    },
  }
}

test("injection: appends the rescue rule into empty rules; exact rule shape", async () => {
  S.resetState()
  S.setPosture(undefined)
  S.setHostSeen(true)
  const { api, updates } = fakeSessionApi([])
  S.setSessionRuleApi(api)
  assert.equal(await S.ensure("s1"), true)
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0], {
    sessionID: "s1",
    permissions: [{ action: "forge_shell", resource: "*", effect: "allow" }],
  })
})

test("injection: read-back-merge — unknown existing rules survive byte-for-byte", async () => {
  S.resetState()
  S.setPosture(undefined)
  const existing = [
    { action: "edit", resource: "secrets/*", effect: "deny" },
    { action: "webfetch", resource: "https://x/*", effect: "ask" },
  ]
  const { api, updates } = fakeSessionApi(existing)
  S.setSessionRuleApi(api)
  await S.ensure("s2")
  assert.deepEqual(updates[0].permissions, [
    ...existing,
    { action: "forge_shell", resource: "*", effect: "allow" },
  ])
})

test("injection: idempotent — identical rule already present → no update; second call → no update", async () => {
  S.resetState()
  S.setPosture(undefined)
  const rule = { action: "forge_shell", resource: "*", effect: "allow" }
  const { api, updates } = fakeSessionApi([{ ...rule }])
  S.setSessionRuleApi(api)
  assert.equal(await S.ensure("s3"), true)
  assert.equal(await S.ensure("s3"), true)
  assert.equal(updates.length, 0)
})

test("injection: explicit deny disables the rescue (no update, returns false)", async () => {
  S.resetState()
  S.setPosture("deny")
  const { api, updates } = fakeSessionApi([])
  S.setSessionRuleApi(api)
  assert.equal(await S.ensure("s4"), false)
  assert.equal(updates.length, 0)
})

test("injection: fail-soft — api absent → false; get throws → false; update throws → false", async () => {
  S.resetState()
  S.setPosture(undefined)
  S.setSessionRuleApi(null)
  assert.equal(await S.ensure("s5"), false)
  S.setSessionRuleApi({
    get: async () => {
      throw new Error("boom")
    },
    update: async () => {},
  })
  assert.equal(await S.ensure("s5"), false)
  S.setSessionRuleApi({
    get: async () => ({ permissions: [] }),
    update: async () => {
      throw new Error("boom")
    },
  })
  assert.equal(await S.ensure("s5"), false)
})

// ---------------------------------------------------------------------------
// 2.3 Fallback belt matrix (forgeShellGate) + disclosure
// ---------------------------------------------------------------------------

test("worker family predicate: forge-* is a worker; bare 'forge' and unknown are not", () => {
  S.setFamily("w1", "forge-plugindev-coder")
  S.setFamily("w2", "forge-global-scout")
  S.setFamily("p1", "forge")
  S.setFamily("u1", undefined)
  S.setFamily("g1", "general")
  assert.equal(S.isWorker("w1"), true)
  assert.equal(S.isWorker("w2"), true)
  assert.equal(S.isWorker("p1"), false)
  assert.equal(S.isWorker("u1"), false)
  assert.equal(S.isWorker("g1"), false)
  assert.equal(S.isWorker(undefined), false)
})

test("belt: bare cross-anchor deny on a worker session proceeds + discloses once", async () => {
  S.resetState()
  S.setPosture(undefined)
  S.setHostSeen(true)
  S.setFamily("bw", "forge-plugindev-coder")
  let asked = 0
  await S.gate(fakeAsk(() => (asked++, Promise.reject(BARE_DENY))), "echo ok", "bw")
  assert.equal(asked, 1)
  const note = S.takeDisclosure("bw")
  assert.match(note, /^\[forge:session-rescue\]/)
  assert.equal(S.takeDisclosure("bw"), null, "disclosure attaches once per session")
})

test("belt: explicit deny refuses BEFORE the ask, with the verbatim refusal", async () => {
  S.resetState()
  S.setPosture("deny")
  S.setHostSeen(true)
  S.setFamily("bd", "forge-plugindev-coder")
  let asked = 0
  await assert.rejects(
    S.gate(fakeAsk(() => (asked++, Promise.resolve({}))), "echo ok", "bd"),
    /explicitly denied by user configuration/,
  )
  assert.equal(asked, 0)
  assert.equal(S.takeDisclosure("bd"), null)
})

test("belt: explicit allow skips the ask entirely", async () => {
  S.resetState()
  S.setPosture("allow")
  let asked = 0
  await S.gate(fakeAsk(() => (asked++, Promise.resolve({}))), "echo ok", "any")
  assert.equal(asked, 0)
})

test("belt: bare deny OUTSIDE worker sessions propagates (primary 'forge' + unknown)", async () => {
  S.resetState()
  S.setPosture(undefined)
  S.setHostSeen(true)
  S.setFamily("prim", "forge")
  S.setFamily("unk", undefined)
  await assert.rejects(S.gate(fakeAsk(() => Promise.reject(BARE_DENY)), "echo ok", "prim"), /Permission denied: forge_shell/)
  await assert.rejects(S.gate(fakeAsk(() => Promise.reject(BARE_DENY)), "echo ok", "unk"), /Permission denied: forge_shell/)
})

test("belt: any OTHER rejection message propagates verbatim (never misidentified)", async () => {
  S.resetState()
  S.setPosture(undefined)
  S.setHostSeen(true)
  S.setFamily("bo", "forge-plugindev-coder")
  const other = new Error("Permission forge_shell needs approval, and nobody is present to give it")
  await assert.rejects(S.gate(fakeAsk(() => Promise.reject(other)), "echo ok", "bo"), /nobody is present/)
  const reasoned = new Error("Permission denied: forge_shell (rule: user deny git push *)")
  await assert.rejects(S.gate(fakeAsk(() => Promise.reject(reasoned)), "echo ok", "bo"), /rule: user deny/)
  assert.equal(S.takeDisclosure("bo"), null)
})

test("v1 regression guard: host not v2 → bare deny on a worker session still propagates (belt inert)", async () => {
  S.resetState()
  S.clearPosture()
  S.setHostSeen(false)
  S.setFamily("v1w", "forge-plugindev-coder")
  await assert.rejects(S.gate(fakeAsk(() => Promise.reject(BARE_DENY)), "echo ok", "v1w"), /Permission denied: forge_shell/)
})

// ---------------------------------------------------------------------------
// 2.4 Wiring — v2Setup captures the session-rule surface; the context hook
// seeds the PRIMARY session (inheritance channel)
// ---------------------------------------------------------------------------

test("wiring: v2Setup captures session.get/update and the context hook seeds the forge primary", async () => {
  S.resetState()
  S.clearPosture()
  const updates = []
  const hooks = {}
  const ctx = {
    session: {
      hook: (name, cb) => {
        hooks[name] = cb
        return { dispose() {} }
      },
      get: async ({ sessionID }) => ({ id: sessionID, permissions: [] }),
      update: async (input) => {
        updates.push(input)
      },
    },
  }
  await v2Setup(ctx, { anchors: [], homeDir: "C:\\nonexistent-home-for-test", readFile: () => null, stat: () => null })
  try {
    assert.equal(typeof hooks.context, "function", "context hook registered")
    // agent "forge" = the primary → seeding fires (fire-and-forget; wait a tick)
    hooks.context({ sessionID: "prim-ws", agent: "forge" })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(updates.length, 1, "primary session seeded exactly once")
    assert.deepEqual(updates[0], {
      sessionID: "prim-ws",
      permissions: [{ action: "forge_shell", resource: "*", effect: "allow" }],
    })
    // a non-forge agent never seeds
    hooks.context({ sessionID: "other-ws", agent: "general" })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(updates.length, 1)
  } finally {
    S.resetState()
    S.setSessionRuleApi(null)
    S.setHostSeen(false)
    S.clearPosture()
  }
})
