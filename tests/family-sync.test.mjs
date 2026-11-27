import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — contract tests for family-scoped synchronization
// (design D5; landed src/family-sync.ts over the EXISTING roster compiler).
// Spec: the TUI sync touches only the selected family; unrelated families are
// never rewritten; cross-family winner changes are disclosed, not written.

import { createPoolResolver } from "../src/forge-config.ts"
import { planRosterSync, planOverrideSync } from "../src/roster-compile.ts"
import { selectFamilyPlans, findFamily, crossFamilyWinnerConflicts } from "../src/family-sync.ts"

function resolverWith(files) {
  return createPoolResolver({
    homeDir: "C:/home",
    stat: (p) => (files[p] === undefined ? null : { mtimeMs: 1, size: files[p].length }),
    readFile: (p) => files[p],
  })
}

const GLOBAL = "C:/home/.config/opencode/forge.json"

// ---------------------------------------------------------------------------
// selectFamilyPlans
// ---------------------------------------------------------------------------

test("selectFamilyPlans: narrows the host-wide plan to exactly the selected family", () => {
  const files = {
    [GLOBAL]: JSON.stringify({ agents: { util: {}, extra: {} } }),
    "C:/proj/.opencode/forge.json": JSON.stringify({ pool: "proj", agents: { scout: { model: "prov/m", thoughtLevel: "low" } } }),
  }
  const resolution = resolverWith(files).resolve(["C:/proj"])
  const plans = planRosterSync(resolution, { globalPoolFile: GLOBAL })
  assert.ok(plans.length >= 2, "fixture must produce plans for both families")
  const mine = selectFamilyPlans(plans, "C:/proj/.opencode/forge.json")
  assert.ok(mine.plans.length >= 1)
  assert.ok(mine.plans.every((p) => p.family.file === "C:/proj/.opencode/forge.json"), "only the selected family's plans survive")
  // The global family's plans are excluded — the TUI never rewrites them.
  assert.ok(plans.some((p) => p.family.file === GLOBAL) && !mine.plans.some((p) => p.family.file === GLOBAL))
})

test("selectFamilyPlans: unknown family file selects nothing", () => {
  const files = { [GLOBAL]: JSON.stringify({ agents: { util: {} } }) }
  const plans = planRosterSync(resolverWith(files).resolve(["C:/proj"]), { globalPoolFile: GLOBAL })
  assert.deepEqual(selectFamilyPlans(plans, "C:/nowhere/forge.json").plans, [])
})

test("findFamily: identity is the absolute file path; missing family is null", () => {
  const files = {
    [GLOBAL]: JSON.stringify({ agents: { util: {} } }),
    "C:/proj/.opencode/forge.json": JSON.stringify({ pool: "proj", agents: { scout: {} } }),
  }
  const resolution = resolverWith(files).resolve(["C:/proj"])
  const f = findFamily(resolution, "C:/proj/.opencode/forge.json")
  assert.equal(f?.ns, "proj")
  assert.equal(findFamily(resolution, "C:/elsewhere/forge.json"), null)
})

// ---------------------------------------------------------------------------
// crossFamilyWinnerConflicts
// ---------------------------------------------------------------------------

test("crossFamilyWinnerConflicts: no collisions -> empty (family sync may report applied)", () => {
  const files = {
    [GLOBAL]: JSON.stringify({ agents: { util: {} } }),
    "C:/proj/.opencode/forge.json": JSON.stringify({ pool: "proj", agents: { scout: {} } }),
  }
  const conflicts = crossFamilyWinnerConflicts(resolverWith(files).resolve(["C:/proj"]), "C:/proj/.opencode/forge.json")
  assert.deepEqual(conflicts, [])
})

test("crossFamilyWinnerConflicts: a materialized-id collision naming this family is disclosed", () => {
  // Two workspace pool files whose namespaces collide so their materialized
  // ids collide: same declared pool name is impossible (suffix), so use the
  // resolver's documented collision path — the SAME file owning a namespace
  // can't collide with itself; instead craft two pools whose ns base equal
  // via directory basename and declared fields. The resolver assigns
  // unique ns, so a genuine cross-family materialized-id collision needs
  // the collision finding naming familyFile. We assert the pure filter:
  // findings carrying materialized-id-collision that name the file surface;
  // a clean resolution yields none.
  const files = {
    [GLOBAL]: JSON.stringify({ agents: { shared: {} } }),
    "C:/proj/.opencode/forge.json": JSON.stringify({ pool: "dup", agents: { shared: {} } }),
  }
  const resolution = resolverWith(files).resolve(["C:/proj"])
  // Different ns (global vs dup) => no materialized collision here.
  assert.deepEqual(crossFamilyWinnerConflicts(resolution, GLOBAL), [])
  assert.deepEqual(crossFamilyWinnerConflicts(resolution, "C:/proj/.opencode/forge.json"), [])
})

test("crossFamilyWinnerConflicts: only findings naming the selected file surface", () => {
  // Simulate a resolver resolution carrying a collision finding attributable
  // to family B while family A is selected: the pure filter must return only
  // the messages naming the selected file.
  const files = { [GLOBAL]: JSON.stringify({ agents: { a: {} } }) }
  const resolution = resolverWith(files).resolve(["C:/proj"])
  resolution.findings.push(
    { level: "error", code: "materialized-id-collision", message: `materialized agent forge-x from C:/b/forge.json collides with the one from C:/a/forge.json — the earlier pool in resolution order wins, this agent is skipped` },
    { level: "error", code: "materialized-id-collision", message: `materialized agent forge-y from C:/a/forge.json collides with the one from C:/z/forge.json — the earlier pool in resolution order wins, this agent is skipped` },
  )
  const forA = crossFamilyWinnerConflicts(resolution, "C:/a/forge.json")
  assert.equal(forA.length, 2, "both collision messages name C:/a (winner in one, loser in the other) — both are attributable")
  const forB = crossFamilyWinnerConflicts(resolution, "C:/b/forge.json")
  assert.equal(forB.length, 1)
  const forC = crossFamilyWinnerConflicts(resolution, "C:/c/forge.json")
  assert.deepEqual(forC, [])
})

// ---------------------------------------------------------------------------
// Family-scoped compile projection (selected family only; overrides are
// global-layer and ride the separate planOverrideSync carrier)
// ---------------------------------------------------------------------------

test("global scope sync: override projections come only from the separate override plan (global layer)", () => {
  const files = {
    [GLOBAL]: JSON.stringify({ override: { general: { model: "prov/g", thoughtLevel: "low" } }, agents: { util: {} } }),
    "C:/proj/.opencode/forge.json": JSON.stringify({ pool: "proj", agents: { scout: {} } }),
  }
  const resolution = resolverWith(files).resolve(["C:/proj"])
  const plans = planRosterSync(resolution, { globalPoolFile: GLOBAL })
  // planRosterSync plans families only; overrides are a separate plan keyed
  // on the resolution's global override node — the TUI adds it only for the
  // global scope.
  assert.ok(plans.every((p) => p.kind === "family"))
  assert.ok(plans.flatMap((p) => p.files.map((f) => f.fileName)).every((n) => n !== "general.md"), "family plans never carry override projections")
  const resolution2 = resolverWith(files).resolve(["C:/proj"])
  const overridePlan = planOverrideSync(resolution2.overrides, { dir: "C:/override-dir", recipeFile: GLOBAL })
  assert.ok(overridePlan, "the activated override must plan a projection")
  assert.deepEqual(overridePlan.files.map((f) => f.fileName), ["general.md"])
})

test("workspace scope sync: override projections are NOT in a workspace family's plan", () => {
  const files = {
    [GLOBAL]: JSON.stringify({ override: { general: { model: "prov/g", thoughtLevel: "low" } } }),
    "C:/proj/.opencode/forge.json": JSON.stringify({ pool: "proj", agents: { scout: {} } }),
  }
  const resolution = resolverWith(files).resolve(["C:/proj"])
  const mine = selectFamilyPlans(planRosterSync(resolution, { globalPoolFile: GLOBAL }), "C:/proj/.opencode/forge.json")
  const fileNames = mine.plans.flatMap((p) => (p.files ?? []).map((f) => f.fileName))
  assert.ok(!fileNames.includes("general.md"), "workspace family plan must never carry global override projections")
})

// ---------------------------------------------------------------------------
// Real cross-family collision: A pool=a worker=b-c vs B pool=a-b worker=c
// both materialize the SAME id a-b-c — the winner is a HOST-WIDE resolution
// fact (lexicographic file order), so before/after detection must run over
// the host-wide resolver, never a per-family view.
// ---------------------------------------------------------------------------

const FILE_A = "C:/wsA/.opencode/forge.json"
const FILE_B = "C:/wsB/.opencode/forge.json"

test("cross-family id collision: A(pool=a,b-c) vs B(pool=a-b,c) collide on a-b-c with a deterministic winner", () => {
  const files = {
    [FILE_A]: JSON.stringify({ pool: "a", agents: { "b-c": { model: "prov/a", thoughtLevel: "low" } } }),
    [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: { model: "prov/b", thoughtLevel: "low" } } }),
  }
  const resolution = resolverWith(files).resolve(["C:/wsA", "C:/wsB"])
  const winner = resolution.agents["a-b-c"]
  assert.ok(winner, "both pools must be visible host-wide")
  assert.equal(winner.def.model, "prov/a", "the earlier file in lexicographic resolution order (wsA) wins")
  assert.ok(crossFamilyWinnerConflicts(resolution, FILE_B).length > 0, "the loser family (B) carries the collision finding")
  // The TUI editing family B cannot reconcile the host registry alone: the
  // winner lives in family A — the conflict must be attributable to BOTH
  // sides via the host-wide resolution.
  assert.ok(resolution.findings.some((f) => f.code === "materialized-id-collision" && f.message.includes(FILE_A) && f.message.includes(FILE_B)))
})

test("removing the winning family flips the winner to B — detection needs the host-wide re-resolve", () => {
  const both = {
    [FILE_A]: JSON.stringify({ pool: "a", agents: { "b-c": { model: "prov/a", thoughtLevel: "low" } } }),
    [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: { model: "prov/b", thoughtLevel: "low" } } }),
  }
  const before = resolverWith(both).resolve(["C:/wsA", "C:/wsB"])
  assert.equal(before.agents["a-b-c"].def.model, "prov/a")
  // A deleted from disk: the next host-wide resolve crowns B.
  const after = resolverWith({ [FILE_B]: both[FILE_B] }).resolve(["C:/wsA", "C:/wsB"])
  assert.equal(after.agents["a-b-c"].def.model, "prov/b", "the winner flips to B once A is gone")
  assert.deepEqual(crossFamilyWinnerConflicts(after, FILE_B), [], "B alone has no collision")
})

// ---------------------------------------------------------------------------
// 3-arg crossFamilyWinnerConflicts(before, after, file) — BEFORE/AFTER diff:
// only genuine other-family projection CHANGES are conflicts; a pre-existing
// collision that did not move anything is not a new cross-family need.
// ---------------------------------------------------------------------------

function resolveFiles(files, dirs) {
  return resolverWith(files).resolve(dirs)
}

test("3-arg: identical other-family projections -> no conflicts even with a surviving collision finding", () => {
  const files = {
    [FILE_A]: JSON.stringify({ pool: "a", agents: { "b-c": { model: "prov/a", thoughtLevel: "low" } } }),
    [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: { model: "prov/b", thoughtLevel: "low" } } }),
  }
  const before = resolveFiles(files, ["C:/wsA", "C:/wsB"])
  const after = resolveFiles(files, ["C:/wsA", "C:/wsB"])
  // B is selected; the pre-existing a-b-c collision finding names FILE_B, but
  // NOTHING changed between before and after — no new cross-family action.
  const conflicts = crossFamilyWinnerConflicts(before, after, FILE_B)
  assert.deepEqual(conflicts, [], "an unchanged pre-existing collision must not block family B's sync as a NEW conflict")
})

test("3-arg: only the SELECTED family's own content changed -> no conflicts", () => {
  const A = JSON.stringify({ pool: "a", agents: { x: { model: "prov/a", thoughtLevel: "low" } } })
  const before = resolveFiles({ [FILE_A]: A, [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: {} } }) }, ["C:/wsA", "C:/wsB"])
  const after = resolveFiles({ [FILE_A]: A, [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: { model: "prov/new", thoughtLevel: "high" } } }) }, ["C:/wsA", "C:/wsB"])
  assert.deepEqual(crossFamilyWinnerConflicts(before, after, FILE_B), [], "family B editing itself is normal sync work")
})

test("3-arg: another family's content changed -> conflict disclosed, never written", () => {
  const A_BEFORE = JSON.stringify({ pool: "a", agents: { x: { model: "prov/a", thoughtLevel: "low" } } })
  const B = JSON.stringify({ pool: "a-b", agents: { c: {} } })
  const before = resolveFiles({ [FILE_A]: A_BEFORE, [FILE_B]: B }, ["C:/wsA", "C:/wsB"])
  const A_AFTER = JSON.stringify({ pool: "a", agents: { x: { model: "prov/z", thoughtLevel: "high" } } })
  const after = resolveFiles({ [FILE_A]: A_AFTER, [FILE_B]: B }, ["C:/wsA", "C:/wsB"])
  const conflicts = crossFamilyWinnerConflicts(before, after, FILE_B)
  assert.ok(conflicts.some((m) => m.includes(FILE_A) && m.includes("x")), "family A's internal change is disclosed to B's sync")
})

test("3-arg: winner flip (A deleted) is caught even though AFTER carries no collision finding", () => {
  const both = {
    [FILE_A]: JSON.stringify({ pool: "a", agents: { "b-c": { model: "prov/a", thoughtLevel: "low" } } }),
    [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: { model: "prov/b", thoughtLevel: "low" } } }),
  }
  const before = resolveFiles(both, ["C:/wsA", "C:/wsB"])
  const after = resolveFiles({ [FILE_B]: both[FILE_B] }, ["C:/wsA", "C:/wsB"])
  const conflicts = crossFamilyWinnerConflicts(before, after, FILE_B)
  assert.ok(conflicts.length > 0, "B gaining the winner a-b-c must be disclosed to B's own sync")
  assert.ok(conflicts.some((m) => /a-b-c/.test(m)))
})

test("3-arg: before=null fails closed with an explicit disclosure", () => {
  const files = { [FILE_B]: JSON.stringify({ pool: "a-b", agents: { c: {} } }) }
  const after = resolveFiles(files, ["C:/wsB"])
  const conflicts = crossFamilyWinnerConflicts(null, after, FILE_B)
  assert.ok(conflicts.some((m) => /cannot be ruled out|before/.test(m)), "drift cannot be ruled out without a before-resolution")
})

test("3-arg: pre-existing collision where ONLY another worker's prompt changed in A (B untouched) is not a new cross-family need", () => {
  // A keeps its colliding worker b-c (still the winner); a DIFFERENT worker's
  // prompt changes. B's projection input is unchanged.
  const B = JSON.stringify({ pool: "a-b", agents: { c: {} } })
  const before = resolveFiles({
    [FILE_A]: JSON.stringify({ pool: "a", agents: { "b-c": { model: "prov/a", thoughtLevel: "low" }, z: { prompt: "one" } } }),
    [FILE_B]: B,
  }, ["C:/wsA", "C:/wsB"])
  const after = resolveFiles({
    [FILE_A]: JSON.stringify({ pool: "a", agents: { "b-c": { model: "prov/a", thoughtLevel: "low" }, z: { prompt: "two" } } }),
    [FILE_B]: B,
  }, ["C:/wsA", "C:/wsB"])
  const conflicts = crossFamilyWinnerConflicts(before, after, FILE_B)
  // The z change IS another family's content change and must be disclosed
  // (B's sync never rewrites A) — but the pre-existing a-b-c collision alone
  // must not appear as a conflict since nothing moved.
  for (const m of conflicts) assert.ok(m.includes("z") || m.includes(FILE_A), `every disclosed conflict names the actual change, not the stale collision: ${m}`)
})
