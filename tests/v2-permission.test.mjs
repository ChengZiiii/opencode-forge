import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Task 3.1 (W6a field realities) — the v2 permission belt:
// ctx.permission.hook("evaluate") hands a MUTABLE PermissionEvaluation
// ({sessionID, agent?, action, resources, metadata?, source?, effect,
// message?}); the belt signals by MUTATING input.effect — the
// @opencode/schema Permission.Effect union is exactly "allow" | "deny" |
// "ask". Same decision table as the v1 permission.ask hook (ported
// matrix: doors forced to a REAL ask, explicit-deny precedence, draft
// write-freeze deny, forge_shell pass-through, the metadata.tool → action
// name chain). The decision-RETURNING gates map to ctx.permission.assert
// (the AskFn adapter in v2ToolContext) — asserted at the bottom.

import { createV2MockContext } from "./lib/v2-mock-context.mjs"

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"

import { v2Setup } from "../plugin.ts"

const HOME = join(tmpdir(), "forge-v2-perm-home")
process.env.FORGE_TEST_FORGE_HOME = HOME

// One belt setup bound to its own worktree (hostWorktree = anchor ⇒
// stateForBan binds unknown sessions to this dir, like a v1 host launch).
async function beltSetup() {
  const dir = mkdtempSync(join(tmpdir(), "forge-v2-perm-ws-"))
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [dir] })
  return { dir, state, ctx, cb: state.permissionHooks[0]?.cb }
}

// A real-shaped PermissionEvaluation: effect is the mutable slot.
const ev = (fields) => ({ sessionID: "ses_x", action: "read", resources: ["*"], effect: "allow", ...fields })

test("v2 permission: the belt registers exactly one evaluate hook", async () => {
  const { state } = await beltSetup()
  assert.deepEqual(state.permissionHooks.map((h) => h.name), ["evaluate"])
  assert.equal(typeof state.permissionHooks[0].cb, "function")
})

test("v2 permission: drifted domain — missing/not-function register nothing; bad-shape hook never throws on garbage events", async () => {
  const missing = createV2MockContext({ drift: { permission: "missing" } })
  await v2Setup(missing.ctx, { anchors: [join(tmpdir(), "forge-v2-perm-none")] })
  assert.equal(missing.state.permissionHooks.length, 0)
  const notFn = createV2MockContext({ drift: { permission: "not-function" } })
  await v2Setup(notFn.ctx, { anchors: [join(tmpdir(), "forge-v2-perm-none")] })
  assert.equal(notFn.state.permissionHooks.length, 0)
  const bad = createV2MockContext({ drift: { permission: "bad-shape" } })
  await v2Setup(bad.ctx, { anchors: [join(tmpdir(), "forge-v2-perm-none")] })
  assert.equal(bad.state.permissionHooks.length, 1, "bad-shape still hands over the hook; drift lives in the events")
  for (const garbage of [5, null, "x", [], {}, { effect: 5 }, { effect: "allow" }]) {
    await assert.doesNotReject(bad.state.permissionHooks[0].cb(garbage), `garbage ${JSON.stringify(garbage)} must not throw`)
  }
})

test("v2 permission: doors forced to a REAL ask; explicit deny stands (precedence)", async () => {
  const { cb } = await beltSetup()
  for (const door of ["plan_approve", "plan_close", "goal_write", "goal_complete", "goal_resume", "goal_discard"]) {
    const a = ev({ action: door })
    await cb(a)
    assert.equal(a.effect, "ask", `${door}: allow rewritten to ask`)
    const k = ev({ action: door, effect: "ask" })
    await cb(k)
    assert.equal(k.effect, "ask", `${door}: ask stays ask`)
    const d = ev({ action: door, effect: "deny" })
    await cb(d)
    assert.equal(d.effect, "deny", `${door}: explicit deny is never lifted`)
  }
})

test("v2 permission: forge_shell passes through untouched in every direction", async () => {
  const { cb } = await beltSetup()
  for (const effect of ["allow", "ask", "deny"]) {
    const e = ev({ action: "forge_shell", effect })
    await cb(e)
    assert.equal(e.effect, effect, `forge_shell ${effect} is never rewritten`)
  }
})

test("v2 permission: name chain — metadata.tool > action (the only fields the real type carries)", async () => {
  const { cb } = await beltSetup()
  const viaMeta = ev({ metadata: { tool: "plan_approve" }, action: "edit" })
  await cb(viaMeta)
  assert.equal(viaMeta.effect, "ask", "metadata.tool wins")
  const viaAction = ev({ action: "plan_close" })
  await cb(viaAction)
  assert.equal(viaAction.effect, "ask", "action is the fallback")
  // No name (empty action, no metadata): untouched.
  const noname = ev({ action: "" })
  await cb(noname)
  assert.equal(noname.effect, "allow", "unnamed evaluation passes through")
})

test("v2 permission: draft write-freeze — write tools deny during draft, others pass", async () => {
  const { dir, state, cb } = await beltSetup()
  try {
    await state.tools.get("plan_write").execute(
      { goal: "v2 belt draft", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] },
      { sessionID: "ses_draft", worktree: dir },
    )
    for (const tool of ["edit", "write", "bash", "task"]) {
      const e = ev({ sessionID: "ses_draft", action: tool })
      await cb(e)
      assert.equal(e.effect, "deny", `${tool} denied during draft`)
      assert.ok(typeof e.message === "string" && e.message.includes("draft"), `${tool}: deny carries a message`)
    }
    const read = ev({ sessionID: "ses_draft", action: "read" })
    await cb(read)
    assert.equal(read.effect, "allow", "read tools untouched")
    // Another session, same worktree: the freeze is session-scoped by
    // state, but stateForBan binds unknown sessions to the same worktree —
    // the draft is directory-visible there too (v1 parity: the directory
    // fallback re-binds). A DIFFERENT worktree has no draft.
    const other = ev({ sessionID: "ses_elsewhere", action: "edit" })
    await cb(other)
    // same anchor dir ⇒ same plan dir ⇒ still denied (parity with v1
    // stateForBan seeding from hostWorktree)
    assert.equal(other.effect, "deny")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("v2 permission: approval lifts the freeze (phase-aware, not global)", async () => {
  const { dir, state, cb } = await beltSetup()
  try {
    await state.tools.get("plan_write").execute(
      { goal: "v2 belt approve", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] },
      { sessionID: "ses_ap", worktree: dir, ask: async () => ({ status: "allow" }), metadata: () => {} },
    )
    await state.tools.get("plan_approve").execute({}, {
      sessionID: "ses_ap",
      worktree: dir,
      ask: async () => ({ status: "allow" }),
      metadata: () => {},
    })
    const e = ev({ sessionID: "ses_ap", action: "edit" })
    await cb(e)
    assert.equal(e.effect, "allow", "approved plan no longer freezes writes")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The decision gates map to ctx.permission.assert (W6a): a gated tool
// running WITHOUT a v1-style context.ask gets one synthesized from the
// permission domain — assert resolves = allow, assert rejects = deny.
// ---------------------------------------------------------------------------

test("v2 permission: gates ride ctx.permission.assert — a no-ask tool context resolves through the assert seam", async () => {
  const { dir, state } = await beltSetup()
  try {
    // goal_write {arm:true} is a decision gate (gate(ask, "goal_write"))
    // and the tool context carries NO ask — v2ToolContext synthesizes it
    // from ctx.permission.assert.
    await state.tools.get("goal_write").execute(
      { goal: "assert gate", criteria: ["c"], checks: [{ shell: "node -v" }], constraints: "none", arm: true },
      { sessionID: "ses_assert", worktree: dir, agent: "forge" },
    )
    assert.equal(state.asserts.length, 1, "the arm gate called assert exactly once")
    const input = state.asserts[0]
    assert.equal(input.sessionID, "ses_assert")
    assert.equal(input.agent, "forge")
    assert.equal(input.action, "goal_write", "the v1 permission key maps to the assert action")
    assert.deepEqual(input.resources, ["*"], "v1 patterns map to resources")
    // A deny rejection propagates as the gate refusal (fresh worktree: the
    // arm gate runs before any goal file lands).
    const denyRun = await beltSetup()
    try {
      denyRun.state.assertBehavior = "deny"
      await assert.rejects(
        denyRun.state.tools.get("goal_write").execute(
          { goal: "deny path", criteria: ["c"], checks: [{ shell: "node -v" }], constraints: "none", arm: true },
          { sessionID: "ses_assert_deny", worktree: denyRun.dir, agent: "forge" },
        ),
        (err) => {
          assert.match(String(err), /permission denied/)
          return true
        },
      )
    } finally {
      rmSync(denyRun.dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
