import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// fix-unknown-session-anchor-seed (design D1–D4) — on a host that has
// initialized the plugin in MORE THAN ONE directory (one process, one module,
// N initializations — the 2.4.0 service reality) the plugin's session map
// starts empty after every restart, and a session the map does not know used
// to be bound to the LAST-INITIALIZED directory by the first check that
// looked it up (stateForBan seeded from hostWorktree). From then on every
// forge call followed the wrong directory. The tool bodies were fixed in
// 0.33.1 (host session record); this change moves the CHECKS onto the same
// source:
//
//   D1  the launch-directory seed exists on a single-directory process only;
//   D2  every seam that can await resolves an unknown session from the host's
//       own session record first (stateForCheck); the synchronous permission
//       belt keeps its lookup but no longer seeds;
//   D3  the state-file boundary has no base directory for an unbound session
//       on a multi-directory process;
//   D4  the task tool body resolves the caller BEFORE any gate can refuse.
//
// Levels under test, numbered as tasks.md 1.x. A = the session's own
// directory, initialized FIRST; B = another directory, initialized after it
// (so it is "the last initialized directory").

// Must precede the plugin import (evaluated first).
import "./lib/test-env-home.mjs"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_DISPATCH_POLL_INTERVAL_MS = "5"
process.env.FORGE_DISPATCH_POLL_SLICE_MS = "10"
process.env.FORGE_DISPATCH_RECONCILE_FLOOR_MS = "0"

import { __sessionAnchorTestSurface, recoverOneDispatchRecord, v2Setup } from "../plugin.ts"

const surface = __sessionAnchorTestSurface
const dirs = []
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// One plugin initialization for one directory = one directory activation on a
// multi-directory host. The module-level state is shared between them,
// exactly as on the real host (the plugin module is evaluated once).
async function init(dir) {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [dir] })
  return { ctx, state, dir }
}
const beforeOf = (state) => state.toolHooks.find((h) => h.name === "execute.before")?.cb
const evaluateOf = (state) => state.permissionHooks.find((h) => h.name === "evaluate")?.cb
// A fresh process: the module's set of initialized directories starts empty.
const freshProcess = () => surface.resetInitializedDirectories()
// The set holds each directory in its normalized form (real path; on win32
// backslashes + case-folding), so two spellings of one directory never count
// as two.
const dirKey = (d) => (process.platform === "win32" ? realpathSync(d).replace(/\//g, "\\").toLowerCase() : realpathSync(d))
// Two directories initialized, B last — "the last initialized directory" is B.
async function multiDirectoryHost(prefix) {
  freshProcess()
  const a = await init(mk(`${prefix}-a-`))
  const b = await init(mk(`${prefix}-b-`))
  assert.deepEqual(surface.initializedDirectories(), [a.dir, b.dir].map(dirKey), "the process knows both directories, in order")
  return { a, b, latest: b }
}
// The host's own session record, as the mock's session.get returns it.
const hostRecord = (initd, sessionID, directory = initd.dir) =>
  initd.state.sessionRecords.set(sessionID, { sessionID, location: { directory } })
const realCtx = (sessionID) => ({ sessionID, agent: "forge", messageID: "msg_1", id: "call_1" })
const writeEvent = (sessionID, filePath = "notes.md", agent = "forge") => ({ tool: "write", sessionID, agent, messageID: "msg_1", id: "call_1", input: { filePath } })
const PLAN_WRITE_ARGS = (slug) => ({ goal: `draft ${slug}`, context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["a1"] })
// An active DRAFT plan in `dir`, written through the plugin's own tool.
async function draftIn(initd, dir, slug) {
  const owner = `ses-owner-${slug}`
  await initd.state.tools.get("plan_write").execute(PLAN_WRITE_ARGS(slug), { sessionID: owner, worktree: dir })
  return owner
}
// <ws>\.opencode\plan-drafts — from here "../plan/y.md" lands INSIDE the
// state directory <ws>\.opencode\plan\; from a plain directory it lands
// outside any state directory. The boundary verdict of that relative path
// therefore names the base directory it was resolved against.
const nested = (prefix) => {
  const d = join(mk(prefix), ".opencode", "plan-drafts")
  mkdirSync(d, { recursive: true })
  return d
}
const outcome = async (body) => {
  try {
    await body()
    return null
  } catch (err) {
    return err
  }
}
const DRAFT_WRITE = /plan is in draft; write operations are denied \(write\)/

// The dispatch journal: <workspace>\.opencode\forge\dispatch-log.jsonl, one
// JSON record per line (latest line per id wins).
const journalPath = (dir) => join(dir, ".opencode", "forge", "dispatch-log.jsonl")
const seedJournal = (dir, rec) => {
  mkdirSync(dirname(journalPath(dir)), { recursive: true })
  writeFileSync(journalPath(dir), JSON.stringify(rec) + "\n")
}
const journalRecords = (dir) =>
  readFileSync(journalPath(dir), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

test("1.1 multi-directory process: a write-class call from an unknown session binds it to the HOST RECORD's directory, never the last-initialized one", async () => {
  const { a, b, latest } = await multiDirectoryHost("forge-seed-11")
  const sid = "ses-11"
  hostRecord(a, sid)
  await assert.doesNotReject(beforeOf(a.state)(writeEvent(sid)))
  assert.equal(surface.worktreeOf(sid), a.dir, "bound to the record's directory A")

  // The record is the host's, so it reads the same through another
  // directory's initialization.
  const sid2 = "ses-11-via-b"
  hostRecord(b, sid2, a.dir)
  await assert.doesNotReject(beforeOf(latest.state)(writeEvent(sid2)))
  assert.equal(surface.worktreeOf(sid2), a.dir)

  // A session the map already knows is returned as is — the in-memory
  // binding keeps precedence over the record (the pre-existing contract).
  surface.bindChildToDirectory("ses-11-known", b.dir)
  hostRecord(a, "ses-11-known", a.dir)
  assert.equal((await surface.stateForCheck("ses-11-known", { session: a.ctx.session }))?.worktree, b.dir)
})

test("1.2 host record unresolvable (no session / the read throws): no binding is written and the call is not refused", async () => {
  const { a } = await multiDirectoryHost("forge-seed-12")
  const before = beforeOf(a.state)
  const sid = "ses-12-missing"
  await assert.doesNotReject(before(writeEvent(sid)))
  assert.equal(surface.worktreeOf(sid), null, "a session the host has no record for stays unbound — never a guess")
  assert.equal(surface.boundaryBaseOf(sid), "", "and has no base directory")

  // The registering initialization's own client fails on entry (its
  // directory evicted): the same two facts.
  const sid2 = "ses-12-dead"
  const realGet = a.state.sessionRecords.get
  a.state.sessionRecords.get = () => {
    throw new Error("declined (instance closed)")
  }
  try {
    await assert.doesNotReject(before(writeEvent(sid2)))
    assert.equal(await surface.stateForCheck(sid2, { session: a.ctx.session }), null)
  } finally {
    a.state.sessionRecords.get = realGet
  }
  assert.equal(surface.worktreeOf(sid2), null)
})

test("1.3 single-directory process: an unknown session is still seeded from the launch directory — exactly as before", async () => {
  freshProcess()
  const only = await init(mk("forge-seed-13-only-"))
  assert.deepEqual(surface.initializedDirectories(), [dirKey(only.dir)])
  const sid = "ses-13"
  // No host record at all: the launch directory is the one and only directory.
  await assert.doesNotReject(beforeOf(only.state)(writeEvent(sid)))
  assert.equal(surface.worktreeOf(sid), only.dir)

  // The same directory initialized again (evicted, then booted afresh) is
  // still ONE directory: the process does not turn multi-directory.
  const again = await init(only.dir)
  assert.deepEqual(surface.initializedDirectories(), [dirKey(only.dir)])
  const sidAgain = "ses-13-again"
  await assert.doesNotReject(beforeOf(again.state)(writeEvent(sidAgain)))
  assert.equal(surface.worktreeOf(sidAgain), only.dir)

  // Both resolvers, record or no record, and the boundary base.
  const sid2 = "ses-13-norecord"
  assert.equal((await surface.stateForCheck(sid2, { session: only.ctx.session }))?.worktree, only.dir)
  const sid3 = "ses-13-record"
  hostRecord(only, sid3)
  assert.equal((await surface.stateForCheck(sid3, { session: only.ctx.session }))?.worktree, only.dir)
  assert.equal(surface.stateForBan("ses-13-ban")?.worktree, only.dir)
  assert.equal(surface.boundaryBaseOf("ses-13-base"), only.dir, "the launch directory is still the boundary base")
})

test("1.3b single-directory process: the synchronous permission belt still denies an unknown session's write during a draft (the seed, v1 parity), with the exits in the message", async () => {
  freshProcess()
  const only = await init(mk("forge-seed-13b-only-"))
  await draftIn(only, only.dir, "13b")
  const evaluation = { sessionID: "ses-13b-unknown", agent: "build", action: "edit", resources: ["x.ts"], metadata: { tool: "edit" }, effect: "allow", message: undefined }
  await evaluateOf(only.state)(evaluation)
  assert.equal(evaluation.effect, "deny")
  assert.match(String(evaluation.message), /plan_approve/)
  assert.equal(surface.worktreeOf("ses-13b-unknown"), only.dir, "bound by the seed — to the one and only directory")
})

test("1.4 multi-directory process: another directory's draft does not refuse a session; its OWN draft (via the host record) still does, with the plan_approve / discard exits", async () => {
  const { a, b, latest } = await multiDirectoryHost("forge-seed-14")
  await draftIn(a, a.dir, "14") // the draft lives in A
  const before = beforeOf(latest.state)

  const sidB = "ses-14-own-b"
  hostRecord(b, sidB) // its own directory B holds no draft
  await assert.doesNotReject(before(writeEvent(sidB)))
  assert.equal(surface.worktreeOf(sidB), b.dir)

  const sidA = "ses-14-own-a"
  hostRecord(b, sidA, a.dir) // its own directory A holds the draft
  await assert.rejects(before(writeEvent(sidA)), (err) => {
    assert.match(String(err), DRAFT_WRITE)
    assert.match(String(err), /plan_approve/)
    assert.match(String(err), /\/plan discard/)
    return true
  })
  assert.equal(surface.worktreeOf(sidA), a.dir, "refused by — and bound to — its own directory")

  // The dispatch shape of the same gate.
  const sidTask = "ses-14-task"
  hostRecord(b, sidTask, a.dir)
  await assert.rejects(
    before({ tool: "task", sessionID: sidTask, agent: "forge", messageID: "msg_1", id: "call_1", input: { subagent_type: "general", prompt: "p" } }),
    /A plan is in draft; dispatch is denied for this target/,
  )
  assert.equal(surface.worktreeOf(sidTask), a.dir)
})

test("1.5 state-file boundary: a relative path is resolved against the HOST RECORD's directory; an unresolvable session has no base and is never joined onto another directory's", async () => {
  freshProcess()
  const dirA = nested("forge-seed-15-a-")
  const dirB = mk("forge-seed-15-b-")
  const a = await init(dirA)
  const b = await init(dirB) // last initialized
  const REL = "../plan/y.md"
  const REFUSED = /Write refused: "\.\.\/plan\/y\.md" is inside the forge state directories/

  // Resolved against the session's own directory A: the file lands in a
  // state directory → refused.
  const sidA = "ses-15-own-a"
  hostRecord(b, sidA, dirA)
  await assert.rejects(beforeOf(b.state)(writeEvent(sidA, REL, "build")), REFUSED)
  assert.equal(surface.worktreeOf(sidA), dirA)

  // The same relative path against B (no state directory there) passes.
  const sidB = "ses-15-own-b"
  hostRecord(b, sidB)
  await assert.doesNotReject(beforeOf(b.state)(writeEvent(sidB, REL, "build")))
  assert.equal(surface.worktreeOf(sidB), dirB)

  // Now the LAST-initialized directory is one where that path would land in
  // a state directory. A session the host cannot resolve has no base at all:
  // the path is judged as given and is NOT refused on another directory's
  // behalf.
  const dirC = nested("forge-seed-15-c-")
  const c = await init(dirC)
  const sidNone = "ses-15-unresolved"
  await assert.doesNotReject(beforeOf(c.state)(writeEvent(sidNone, REL, "build")))
  assert.equal(surface.worktreeOf(sidNone), null, "no binding was written")
  assert.equal(surface.boundaryBaseOf(sidNone), "", "no base directory on a multi-directory process")
  assert.equal(surface.stateForBan(sidNone), null)
  // ... but a relative path that names a state directory by its OWN spelling
  // is refused whatever directory it is relative to — that needs no base, and
  // joining it onto another directory's is not what refuses it.
  for (const ownShape of [".opencode/plan/x.md", ".opencode/goal/y.md", "notes/../.opencode/plan/z.md"]) {
    await assert.rejects(beforeOf(c.state)(writeEvent("ses-15-ownshape", ownShape, "build")), /Write refused: .* is inside the forge state directories/)
  }
  await assert.doesNotReject(beforeOf(c.state)(writeEvent("ses-15-plain", "src/x.ts", "build")))
  assert.equal(surface.worktreeOf("ses-15-plain"), null, "an ordinary relative path writes no binding either")

  // An absolute path needs no base and is judged as before.
  await assert.rejects(beforeOf(c.state)(writeEvent("ses-15-abs", join(dirB, ".opencode", "goal", "x.md"), "build")), /Write refused: .* is inside the forge state directories/)
  await assert.doesNotReject(beforeOf(c.state)(writeEvent("ses-15-abs-ok", join(dirB, "notes.md"), "build")))
})

test("1.6 task tool body: a dispatch refused by a gate leaves the caller bound to the HOST RECORD's directory — with the belt in front, and without it", async () => {
  const { a, latest } = await multiDirectoryHost("forge-seed-16")
  const task = latest.state.tools.get("task")
  const ARGS = { subagent_type: "forge-seed-nope", prompt: "anchor probe" }
  const NOT_MATERIALIZED = /is not a materialized forge subagent/

  // The belt runs first (the host fires execute.before), then the body refuses.
  const sidBelt = "ses-16-belt"
  hostRecord(latest, sidBelt, a.dir)
  await assert.doesNotReject(beforeOf(latest.state)({ tool: "task", sessionID: sidBelt, agent: "forge", messageID: "msg_1", id: "call_1", input: ARGS }))
  assert.equal(surface.worktreeOf(sidBelt), a.dir, "bound by the belt's resolution")
  await assert.rejects(task.execute(ARGS, realCtx(sidBelt)), NOT_MATERIALIZED)
  assert.equal(surface.worktreeOf(sidBelt), a.dir)

  // The body alone (design D4): resolved BEFORE the refusing gate.
  const sidBody = "ses-16-body"
  hostRecord(latest, sidBody, a.dir)
  await assert.rejects(task.execute(ARGS, realCtx(sidBody)), NOT_MATERIALIZED)
  assert.equal(surface.worktreeOf(sidBody), a.dir, "a refused dispatch bound the caller to its own directory only")

  // A caller the host cannot resolve is refused all the same and stays unbound.
  const sidNone = "ses-16-unresolved"
  await assert.rejects(task.execute(ARGS, realCtx(sidNone)), NOT_MATERIALIZED)
  assert.equal(surface.worktreeOf(sidNone), null)
})

test("1.7 crew_begin: an unknown session's draft verdict comes from the host record's directory", async () => {
  const { a, b, latest } = await multiDirectoryHost("forge-seed-17")
  await draftIn(a, a.dir, "17")
  const crewBegin = latest.state.tools.get("crew_begin")
  const ARGS = { objective: "seed probe", subtasks: [{ title: "one" }] }
  const DRAFT_CREW = /crew orchestration is denied during planning/

  const sidB = "ses-17-own-b"
  hostRecord(latest, sidB)
  const errB = await outcome(() => crewBegin.execute(ARGS, realCtx(sidB)))
  assert.ok(!(errB && DRAFT_CREW.test(String(errB))), `another directory's draft must not refuse; got: ${errB}`)

  const sidA = "ses-17-own-a"
  hostRecord(latest, sidA, a.dir)
  const errA = await outcome(() => crewBegin.execute(ARGS, realCtx(sidA)))
  assert.match(String(errA), DRAFT_CREW, "its own directory's draft refuses")
  assert.equal(surface.worktreeOf(sidA), a.dir)
})

test("P1 the synchronous permission belt never seeds on a multi-directory process; the execute.before seam is the authoritative draft gate", async () => {
  const { a, latest } = await multiDirectoryHost("forge-seed-p1")
  await draftIn(a, a.dir, "p1")
  const sid = "ses-p1"
  hostRecord(latest, sid, a.dir)
  const evaluate = evaluateOf(latest.state)
  const evaluation = { sessionID: sid, agent: "forge", action: "write", resources: ["notes.md"], metadata: { tool: "write" }, effect: "allow", message: undefined }

  await evaluate(evaluation)
  assert.equal(evaluation.effect, "allow", "unknown to the map → the belt neither denies nor guesses")
  assert.equal(surface.worktreeOf(sid), null, "the belt wrote no binding")

  // The seam that fires first (host 2.4.0) resolves and refuses.
  await assert.rejects(beforeOf(latest.state)(writeEvent(sid)), DRAFT_WRITE)
  assert.equal(surface.worktreeOf(sid), a.dir)

  // Once the map knows the session, the belt denies on its own again.
  const again = { ...evaluation }
  await evaluate(again)
  assert.equal(again.effect, "deny")
  assert.match(String(again.message), /plan_approve/)
})

test("1.8 recovery of a retry-pending record: an owner the map does not know is judged by the HOST RECORD's directory — its own draft refuses the respawn, and the owner ends bound to that directory", async () => {
  const { a } = await multiDirectoryHost("forge-seed-18")
  await draftIn(a, a.dir, "18")
  const owner = "ses-18-own-a"
  hostRecord(a, owner, a.dir)
  // A forge target that resolves nowhere: with no draft verdict the chain
  // would stop at "does not resolve in the live roster" and never respawn.
  const rec = { id: "j-seed-18", agent: "forge-seed-nope", ownerSession: owner, workspace: a.dir, state: "retry-pending", attempts: 1, createdAt: 1, updatedAt: 1, prompt: "resume me", questionDeny: true }
  seedJournal(a.dir, rec)
  await recoverOneDispatchRecord(a.ctx, a.dir, rec)
  const last = journalRecords(a.dir).at(-1)
  assert.equal(last.id, rec.id)
  assert.equal(last.state, "terminal")
  assert.equal(last.outcome, "error")
  assert.match(String(last.reason), /retry refused at recovery: \[forge\] A plan is in draft/)
  assert.equal(surface.worktreeOf(owner), a.dir, "resolved through the recovery's own client — to the record's directory")
})

test("1.9 the queue pump: a queued wish whose owner the map does not know is refused by its OWN directory's draft (host record), read through whichever initialization runs the recovery", async () => {
  const { a, b } = await multiDirectoryHost("forge-seed-19")
  await draftIn(a, a.dir, "19") // the draft lives in A; B (last initialized) has none
  const owner = "ses-19-own-a"
  hostRecord(b, owner, a.dir) // the host record is host-global: B's initialization reads it too
  const rec = { id: "j-seed-19", agent: "general", ownerSession: owner, workspace: a.dir, state: "queued", attempts: 1, createdAt: 1, updatedAt: 1, prompt: "run me", questionDeny: true }
  seedJournal(a.dir, rec)
  // A queued record re-enters the queue for a live owner and is pumped at once.
  await recoverOneDispatchRecord(b.ctx, a.dir, rec)
  const last = journalRecords(a.dir).at(-1)
  assert.equal(last.id, rec.id)
  assert.equal(last.state, "terminal")
  assert.equal(last.outcome, "error")
  assert.match(String(last.reason), /spawn refused at queue pump: \[forge\] A plan is in draft/)
  assert.equal(surface.worktreeOf(owner), a.dir)
})
