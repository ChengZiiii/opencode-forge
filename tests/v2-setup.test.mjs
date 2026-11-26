import test from "node:test"
import assert from "node:assert/strict"

// plugin.ts pulls @opencode-ai/plugin (peer dep, installed in devDeps); under
// node --test with type stripping this import is fine.
import { v2Setup, isRootish, effectiveWorktree } from "../plugin.ts"

test("worktree resolution: global-project root falls back to the launch directory", () => {
  // degenerate worktrees (opencode's global project uses "/")
  assert.equal(isRootish("/"), true)
  assert.equal(isRootish("\\"), true)
  assert.equal(isRootish("C:"), true)
  assert.equal(isRootish("C:\\"), true)
  assert.equal(isRootish("C:/"), true)
  assert.equal(isRootish(""), true)
  assert.equal(isRootish(undefined), true)
  // real worktrees are untouched
  assert.equal(isRootish("C:/Users/Soren/Desktop/AgentWorkCommon"), false)
  assert.equal(isRootish("/home/user/repo"), false)
  // fallback chain: real worktree wins; rootish worktree defers to directory
  assert.equal(effectiveWorktree("C:/repo", "C:/dir"), "C:/repo")
  assert.equal(effectiveWorktree("/", "C:/Users/Soren/Desktop/AgentWorkCommon"), "C:/Users/Soren/Desktop/AgentWorkCommon")
  assert.equal(effectiveWorktree(undefined, "C:/dir"), "C:/dir")
  assert.equal(effectiveWorktree(undefined, undefined), "")
})

function makeCtx(opts = {}) {
  const agents = new Map()
  const calls = { update: [], default: [] }
  const draft = {
    list: () => [...agents.keys()].map((id) => ({ id })),
    get: (id) => agents.get(id),
    update: (id, fn) => {
      calls.update.push(id)
      const a = agents.get(id) ?? {}
      fn(a)
      agents.set(id, a)
    },
    remove: (id) => agents.delete(id),
  }
  if (!opts.noDefault) draft.default = (id) => {
    if (opts.throwDefault) throw new Error("default boom")
    calls.default.push(id)
  }
  return {
    agents,
    calls,
    ctx: {
      agent: {
        transform: async (cb) => {
          await cb(draft)
        },
      },
    },
  }
}

test("v2 setup: registers the forge agent", async () => {
  const { ctx, agents } = makeCtx()
  await v2Setup(ctx)
  assert.ok(agents.has("forge"))
  assert.equal(agents.get("forge").mode, "primary")
})
test("v2 setup: does not clobber an existing forge entry (create-only)", async () => {
  const { ctx, agents } = makeCtx()
  // simulate a pre-existing user-owned entry
  await ctx.agent.transform(async (draft) => {
    draft.update("forge", (a) => {
      a.system = "USER OWNED"
      a.mode = "subagent"
    })
  })
  await v2Setup(ctx)
  assert.equal(agents.get("forge").system, "USER OWNED")
  assert.equal(agents.get("forge").mode, "subagent")
})

test("v2 setup: silently skips on host shape drift without throwing", async () => {
  await assert.doesNotReject(v2Setup({}))
  await assert.doesNotReject(v2Setup({ agent: {}, skill: {} }))
  await assert.doesNotReject(
    v2Setup({
      agent: { transform: async (cb) => cb({ get: 5, update: null }) },
    }),
  )
})

test("v2 setup: rejected permission and tool hook registrations remain silent and siblings are attempted", async () => {
  const attempted = []
  const hook = async (name) => {
    attempted.push(name)
    await Promise.resolve()
    if (name !== "execute.after") throw new Error("registration rejected")
    return { dispose() {} }
  }
  await assert.doesNotReject(() => v2Setup({ permission: { hook }, tool: { hook } }))
  // Let node:test observe any unhandled rejection from the registration promises.
  await new Promise(setImmediate)
  assert.deepEqual(attempted, ["evaluate", "execute.before", "execute.after"])
})

// Task 3.3 �� v2 parity (spec: forge-subagents): setup registers the static
// subagents create-only from forge.json (process cwd), degrading silently on
// any host-shape drift.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("v2 setup: registers forge subagents from the cwd forge.json (create-only, NAMESPACED with provenance)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-"))
  const prevCwd = process.cwd()
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "v2pool", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
    process.chdir(dir)
    const { ctx, agents } = makeCtx()
    // materialize:"runtime" — this test pins the DRAFT materialization path
    // (the v2 escape hatch); the native default has its own suite.
    await v2Setup(ctx, { materialize: "runtime" })
    assert.ok(agents.has("forge"), "the primary agent still registers")
    assert.ok(agents.has("forge-v2pool-research"), "the subagent registers NAMESPACED (forge-<ns>-<id>)")
    assert.equal(agents.has("forge-research"), false, "no plain-id agent exists on the v2 path")
    const sub = agents.get("forge-v2pool-research")
    assert.equal(sub.mode, "subagent")
    // W6 field reality (live bisect): the model pin is NOT written on the
    // v2 draft — any spelling breaks the host's agent encoder (drift).
    assert.equal("model" in sub, false)
    // v2 field reality (v2-single-agent-surface): `permissions` is an ARRAY
    // of {action, resource, effect} entries — the shape map (task:deny) and
    // the shell-deny front door both land there; the singular `permission`
    // spelling no longer exists on this path.
    assert.ok(Array.isArray(sub.permissions), "worker permissions are the v2 array form")
    assert.ok(sub.permissions.some((p) => p.action === "task" && p.resource === "*" && p.effect === "deny"), "task:deny recursion ban rides the array")
    assert.ok("permission" in sub === false, "the old singular permission key is not written")
    // Provenance (pool-namespace-contract D3/D5): the description names the
    // family namespace, the origin forge.json path, and the dispatchability
    // restriction.
    assert.match(sub.description, /Pool 'v2pool' — origin/)
    assert.ok(sub.description.includes(join(dir, ".opencode", "forge.json")), "the origin path rides the description")
    assert.match(sub.description, /dispatchable only from sessions whose workspace pool is this file/)
    // Partition boundary: v2 has no tool domain — the partition is delivered
    // permission-shaped (the shell deny above), never as a tools injection.
    assert.equal(sub.tools, undefined, "v2 performs no tools-map injection")
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 setup: never clobbers a user-defined forge-* entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-"))
  const prevCwd = process.cwd()
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "v2pool", agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
    process.chdir(dir)
    const { ctx, agents } = makeCtx()
    await v2Setup(ctx, { materialize: "runtime" })
    agents.get("forge-v2pool-research").system = "USER OWNED"
    await v2Setup(ctx)
    assert.equal(agents.get("forge-v2pool-research").system, "USER OWNED")
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 setup: an Auto worker registers without a model key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-"))
  const prevCwd = process.cwd()
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "v2pool", agents: { scout: {} } }))
    process.chdir(dir)
    const { ctx, agents } = makeCtx()
    await v2Setup(ctx, { materialize: "runtime" })
    const sub = agents.get("forge-v2pool-scout")
    assert.ok(sub, "the Auto worker registers (namespaced)")
    assert.equal(false, "model" in sub, "no model key on the v2 path either")
    assert.equal(sub.mode, "subagent")
    assert.match(sub.description, /inherits the parent session's model/)
    assert.match(sub.description, /Pool 'v2pool' — origin/, "Auto workers carry the provenance line too")
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 setup: unreadable config degrades to forge-only registration, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-empty-"))
  const prevCwd = process.cwd()
  const prevHome = process.env.FORGE_TEST_FORGE_HOME
  try {
    process.chdir(dir)
    // Redirect the global cascade away from the real user home (which may
    // legitimately carry a forge.json — that would be a config, not "none").
    process.env.FORGE_TEST_FORGE_HOME = join(dir, "home")
    const { ctx, agents } = makeCtx()
    await assert.doesNotReject(v2Setup(ctx))
    assert.ok(agents.has("forge"))
    assert.equal(agents.has("forge-research"), false, "no subagents without config")
  } finally {
    if (prevHome === undefined) delete process.env.FORGE_TEST_FORGE_HOME
    else process.env.FORGE_TEST_FORGE_HOME = prevHome
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- v2-single-agent-surface (tasks 2.1/2.2/2.3 + spec matrix 3.1) ----

// Isolated home so the REAL user's global forge.json cannot flip the
// hideNativeAgents knob under a test's feet.
function withIsolatedHome(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-v2-sas-"))
    const prevCwd = process.cwd()
    const prevHome = process.env.FORGE_TEST_FORGE_HOME
    try {
      process.chdir(dir)
      process.env.FORGE_TEST_FORGE_HOME = join(dir, "home")
      await fn(dir)
    } finally {
      if (prevHome === undefined) delete process.env.FORGE_TEST_FORGE_HOME
      else process.env.FORGE_TEST_FORGE_HOME = prevHome
      process.chdir(prevCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function shellDenyOf(rec) {
  return (rec.permissions ?? []).find((p) => p.action === "shell")
}

test("v2 setup: hides native build/plan primaries (hide-only, other fields and non-natives untouched)", withIsolatedHome(async () => {
  const { ctx, agents } = makeCtx()
  agents.set("build", { id: "build", mode: "primary", system: "NATIVE", hidden: false })
  agents.set("plan", { id: "plan", mode: "primary", system: "NATIVE", hidden: false })
  agents.set("general", { id: "general", mode: "primary", hidden: false })
  agents.set("explore", { id: "explore", mode: "subagent", hidden: false })
  await v2Setup(ctx)
  assert.equal(agents.get("build").hidden, true)
  assert.equal(agents.get("plan").hidden, true)
  assert.equal(agents.get("build").system, "NATIVE", "no other field is touched")
  assert.equal(agents.get("build").mode, "primary", "hide-only — never a demote")
  assert.equal(agents.get("general").hidden, false, "general stays visible")
  assert.equal(agents.get("explore").hidden, false, "explore stays visible")
}))

test("v2 setup: absent native records are skipped, never created", withIsolatedHome(async () => {
  const { ctx, agents, calls } = makeCtx()
  await v2Setup(ctx)
  assert.equal(agents.has("build"), false)
  assert.equal(agents.has("plan"), false)
  assert.equal(calls.update.includes("build"), false)
  assert.equal(calls.update.includes("plan"), false)
}))

test("v2 setup: an already-hidden native record is left untouched", withIsolatedHome(async () => {
  const { ctx, agents, calls } = makeCtx()
  agents.set("build", { id: "build", hidden: true, system: "ALREADY" })
  agents.set("plan", { id: "plan", hidden: false })
  await v2Setup(ctx)
  assert.equal(calls.update.includes("build"), false, "no update call for the already-hidden record")
  assert.equal(agents.get("build").system, "ALREADY")
  assert.equal(agents.get("plan").hidden, true, "the sibling still hides")
}))

test("v2 setup: one native record throwing never blocks the other (per-record fail-soft)", withIsolatedHome(async () => {
  const { ctx, agents } = makeCtx()
  agents.set("build", { id: "build", hidden: false })
  agents.set("plan", { id: "plan", hidden: false })
  const orig = ctx.agent.transform.bind(ctx.agent)
  ctx.agent.transform = async (cb) =>
    orig((draft) => {
      const upd = draft.update.bind(draft)
      draft.update = (id, fn) => {
        if (id === "build") throw new Error("update boom")
        return upd(id, fn)
      }
      return cb(draft)
    })
  await assert.doesNotReject(v2Setup(ctx))
  assert.equal(agents.get("build").hidden, false, "the throwing record is skipped")
  assert.equal(agents.get("plan").hidden, true, "the sibling still applies")
}))

test("v2 setup: hideNativeAgents:false in the GLOBAL forge.json leaves natives untouched", withIsolatedHome(async (dir) => {
  mkdirSync(join(dir, "home", ".config", "opencode"), { recursive: true })
  writeFileSync(join(dir, "home", ".config", "opencode", "forge.json"), JSON.stringify({ hideNativeAgents: false }))
  const { ctx, agents } = makeCtx()
  agents.set("build", { id: "build", hidden: false })
  agents.set("plan", { id: "plan", hidden: false })
  await v2Setup(ctx)
  assert.equal(agents.get("build").hidden, false)
  assert.equal(agents.get("plan").hidden, false)
  assert.ok(agents.has("forge"), "the forge primary still registers with the knob off")
}))

test("v2 setup: an unreadable global layer keeps the default (hide on)", withIsolatedHome(async (dir) => {
  mkdirSync(join(dir, "home", ".config", "opencode"), { recursive: true })
  writeFileSync(join(dir, "home", ".config", "opencode", "forge.json"), "{ broken jsonc !!!")
  const { ctx, agents } = makeCtx()
  agents.set("build", { id: "build", hidden: false })
  await v2Setup(ctx)
  assert.equal(agents.get("build").hidden, true)
}))

test("v2 setup: primary + worker records do not receive a blanket shell-deny front door", withIsolatedHome(async (dir) => {
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "sas", agents: { research: { model: "zai/glm", thoughtLevel: "low" }, scout: { shape: "readonly" } } }))
  const { ctx, agents } = makeCtx()
  await v2Setup(ctx, { materialize: "runtime" })
  const primary = shellDenyOf(agents.get("forge"))
  assert.equal(primary, undefined, "primary native shell is host-managed")
  for (const id of ["forge-sas-research", "forge-sas-scout"]) {
    const rec = agents.get(id)
    assert.ok(rec, `${id} materializes`)
    const deny = shellDenyOf(rec)
    assert.equal(deny, undefined, `${id} has no injected shell deny`)
    const effects = Object.fromEntries(rec.permissions.map(({ action, effect }) => [action, effect]))
    assert.equal(effects.bash, undefined, `${id} has no legacy bash rule`)
    assert.equal(effects.execute, id.endsWith("scout") ? "deny" : undefined)
    for (const tool of ["task", "subagent", "question", "plan_write", "plan_tick", "plan_approve", "plan_close", "plan_reopen", "plan_discard", "goal_write", "goal_check", "goal_complete", "goal_pause", "goal_resume", "goal_discard", "crew_begin", "crew_close", "forge_sync"]) {
      assert.equal(effects[tool], "deny", `${id} denies ${tool}`)
    }
  }
  // The readonly seal rides the same array.
  const scout = agents.get("forge-sas-scout")
  for (const tool of ["write", "edit", "patch", "applypatch", "apply", "multiedit"]) {
    assert.ok(scout.permissions.some((p) => p.action === tool && p.effect === "deny"), `scout seals ${tool}`)
  }
}))

test("v2 setup: a user-defined forge entry keeps its fields without an injected shell deny", withIsolatedHome(async () => {
  const { ctx, agents } = makeCtx()
  await ctx.agent.transform(async (draft) => {
    draft.update("forge", (a) => {
      a.system = "USER OWNED"
      a.mode = "subagent"
    })
  })
  await v2Setup(ctx)
  const rec = agents.get("forge")
  assert.equal(rec.system, "USER OWNED")
  assert.equal(rec.mode, "subagent")
  assert.equal(shellDenyOf(rec), undefined, "no permission injected into user-owned entry")
}))

test("v2 setup: default setter called with forge under the typeof guard", withIsolatedHome(async () => {
  const { ctx, calls } = makeCtx()
  await v2Setup(ctx)
  assert.deepEqual(calls.default, ["forge"])
}))

test("v2 setup: no default setter on the draft → silently skipped", withIsolatedHome(async () => {
  const { ctx } = makeCtx({ noDefault: true })
  await assert.doesNotReject(v2Setup(ctx))
}))

test("v2 setup: a throwing default setter never escapes", withIsolatedHome(async () => {
  const { ctx } = makeCtx({ throwDefault: true })
  await assert.doesNotReject(v2Setup(ctx))
}))

// Host-owned permissions are preserved, not normalized by Forge.

test("v2 setup: weird pre-set permissions shapes are left to the host", withIsolatedHome(async () => {
  const weirds = [
    null,
    "nope",
    42,
    {},
  ]
  for (const weird of weirds) {
    const { ctx, agents } = makeCtx()
    await ctx.agent.transform(async (draft) => {
      draft.update("forge", (a) => {
        a.system = "USER OWNED"
        a.permissions = weird
      })
    })
    await v2Setup(ctx)
    const rec = agents.get("forge")
    assert.equal(rec.system, "USER OWNED", "other fields survive the normalize")
    assert.deepEqual(rec.permissions, weird, "host-owned fields are not normalized by Forge")
  }
}))

test("v2 setup: pre-set permissions array survives verbatim", withIsolatedHome(async () => {
  const { ctx, agents } = makeCtx()
  const editEntry = { action: "edit", resource: "src/**", effect: "deny" }
  const nopeEntry = { nope: true } // an object, so it survives (only null/non-objects are dropped)
  await ctx.agent.transform(async (draft) => {
    draft.update("forge", (a) => {
      a.permissions = [null, 42, "x", undefined, nopeEntry, editEntry]
    })
  })
  await v2Setup(ctx)
  const perms = agents.get("forge").permissions
  assert.ok(Array.isArray(perms))
  assert.deepEqual(perms, [null, 42, "x", undefined, nopeEntry, editEntry])
}))

test("v2 setup: user permission order is unchanged", withIsolatedHome(async () => {
  const { ctx, agents } = makeCtx()
  await ctx.agent.transform(async (draft) => {
    draft.update("forge", (a) => {
      // a plausible user allow that precedes the plugin's append
      a.permissions = [{ action: "edit", resource: "*", effect: "allow" }]
    })
  })
  await v2Setup(ctx)
  const perms = agents.get("forge").permissions
  assert.deepEqual(perms, [{ action: "edit", resource: "*", effect: "allow" }])
}))

test("v2 setup: a record already carrying a shell entry keeps it verbatim (idempotent append, no duplicate)", withIsolatedHome(async () => {
  const { ctx, agents } = makeCtx()
  const userShell = { action: "shell", resource: "build.ts", effect: "allow" }
  await ctx.agent.transform(async (draft) => {
    draft.update("forge", (a) => {
      a.permissions = [userShell]
    })
  })
  await v2Setup(ctx)
  const perms = agents.get("forge").permissions
  assert.equal(perms.length, 1, "no second shell entry appended")
  assert.deepEqual(perms, [userShell], "the pre-existing shell entry is untouched (current idempotent-keep semantics)")
}))

test("v2 setup: readonly worker retains explicit mutation denies without a blanket shell deny", withIsolatedHome(async (dir) => {
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ pool: "harden", agents: { scout: { shape: "readonly" } } }))
  const { ctx, agents } = makeCtx()
  await v2Setup(ctx, { materialize: "runtime" })
  const perms = agents.get("forge-harden-scout").permissions
  assert.ok(Array.isArray(perms) && perms.length > 1)
  for (const action of ["write", "edit", "patch"]) assert.equal(perms.findLast((p) => p.action === action)?.effect, "deny")
  assert.equal(perms.findLast((p) => p.action === "shell"), undefined)
}))

test("v2 setup: native suppression does not inject shell permissions", withIsolatedHome(async () => {
  const { ctx, agents, calls } = makeCtx()
  agents.set("build", { id: "build", mode: "primary", system: "NATIVE", hidden: false })
  agents.set("plan", { id: "plan", mode: "primary", system: "NATIVE", hidden: false })
  await v2Setup(ctx)
  // both effects of the one transform, in one assertion set
  assert.equal(agents.get("build").hidden, true, "build suppressed")
  assert.equal(agents.get("plan").hidden, true, "plan suppressed")
  assert.ok(agents.has("forge"), "forge primary registered")
  assert.equal(shellDenyOf(agents.get("forge")), undefined, "no shell-deny front door")
  assert.deepEqual(calls.default, ["forge"], "default setter still fired")
}))

test("v2 setup: hideNativeAgents JSONC boundary — comments/trailing commas honor the knob; bad shapes keep the default", withIsolatedHome(async (dir) => {
  const globalDir = join(dir, "home", ".config", "opencode")
  const cases = [
    // [content, expectedHidden] — fail-soft means anything unreadable/invalid keeps hide ON
    [`{ // line comment\n  /* block */ "hideNativeAgents": false }`, false],
    [`{ "hideNativeAgents": false, }`, false],
    [`["not", "an", "object"]`, true],
    [`{ "hideNativeAgents": "false" }`, true],
    [`{ "hideNativeAgents": 0 }`, true],
    [`{ "other": true, }`, true],
  ]
  for (const [content, expectedHidden] of cases) {
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, "forge.json"), content)
    const { ctx, agents } = makeCtx()
    agents.set("build", { id: "build", hidden: false })
    agents.set("plan", { id: "plan", hidden: false })
    await v2Setup(ctx)
    assert.equal(agents.get("build").hidden, expectedHidden, `build hidden=${expectedHidden} for config: ${JSON.stringify(content)}`)
    assert.equal(agents.get("plan").hidden, expectedHidden, `plan hidden=${expectedHidden} for config: ${JSON.stringify(content)}`)
  }
}))
