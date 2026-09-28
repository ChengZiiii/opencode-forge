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

function makeCtx() {
  const agents = new Map()
  return {
    agents,
    ctx: {
      agent: {
        transform: async (cb) => {
          await cb({
            list: () => [...agents.keys()].map((id) => ({ id })),
            get: (id) => agents.get(id),
            update: (id, fn) => {
              const a = agents.get(id) ?? {}
              fn(a)
              agents.set(id, a)
            },
            remove: (id) => agents.delete(id),
          })
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

// Task 3.3 �� v2 parity (spec: forge-subagents): setup registers the static
// subagents create-only from forge.json (process cwd), degrading silently on
// any host-shape drift.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("v2 setup: registers forge subagents from the cwd forge.json (create-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-"))
  const prevCwd = process.cwd()
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
    process.chdir(dir)
    const { ctx, agents } = makeCtx()
    await v2Setup(ctx)
    assert.ok(agents.has("forge"), "the primary agent still registers")
    assert.ok(agents.has("forge-research"), "the subagent registers")
    const sub = agents.get("forge-research")
    assert.equal(sub.mode, "subagent")
    assert.equal(sub.model, "zai/glm")
    assert.equal(sub.permission.task, "deny")
    // Partition boundary (task 3.2): v2 has no tool domain — the materialized
    // subagent carries NO tools injection on this path.
    assert.equal(sub.tools, undefined, "v2 performs no partition injection")
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
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ agents: { research: { model: "zai/glm", thoughtLevel: "low" } } }))
    process.chdir(dir)
    const { ctx, agents } = makeCtx()
    await v2Setup(ctx)
    agents.get("forge-research").system = "USER OWNED"
    await v2Setup(ctx)
    assert.equal(agents.get("forge-research").system, "USER OWNED")
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
    writeFileSync(join(dir, ".opencode", "forge.json"), JSON.stringify({ agents: { scout: {} } }))
    process.chdir(dir)
    const { ctx, agents } = makeCtx()
    await v2Setup(ctx)
    const sub = agents.get("forge-scout")
    assert.ok(sub, "the Auto worker registers")
    assert.equal(false, "model" in sub, "no model key on the v2 path either")
    assert.equal(sub.mode, "subagent")
    assert.match(sub.description, /inherits the parent session's model/)
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
