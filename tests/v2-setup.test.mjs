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
