// Family-scoped synchronization selection (change forge-tui-subagent-config,
// design D5). Pure layer over the EXISTING roster compiler: the TUI's Save &
// Sync plans with planRosterSync (unchanged semantics, src/roster-compile.ts)
// and this module narrows the plan to the SELECTED family only — the TUI
// writes and GCs one family's projection (the global scope additionally
// carries the override plan), never touching unrelated families.
//
// Cross-family collisions (P1 review hardening 2026-11-27): the legacy
// check only inspected the AFTER resolution's materialized-id-collision
// findings, which misses winner changes with NO surviving collision —
// e.g. the winning family A(pool=a, worker=b-c) is deleted and family
// B(pool=a-b, worker=c) silently gains the same forge-a-b-c (nothing
// writes B's projection, the worker vanishes from the host). The 3-arg
// crossFamilyWinnerConflicts therefore diffs BEFORE vs AFTER resolutions —
// materializedId → owner plus each id's full serializable projection input
// — and flags every change that touches a family OTHER than the selected
// one, without ever writing it (host-wide sync stays the explicit lever).

import type { PoolFamilyOrigin, PoolResolution } from "./forge-config.ts"
import type { FamilySyncPlan } from "./roster-compile.ts"

// Narrow planRosterSync's all-families plan to the selected family file.
export function selectFamilyPlans(plans: FamilySyncPlan[], familyFile: string): { plans: FamilySyncPlan[] } {
  return { plans: plans.filter((p) => p.family.file === familyFile) }
}

// The selected family's PoolFamilyOrigin (identity check is the absolute
// file path, matching the resolver's pool identity rule).
export function findFamily(resolution: PoolResolution, familyFile: string): PoolFamilyOrigin | null {
  return resolution.families.find((f) => f.file === familyFile) ?? null
}

// Deterministic deep-value serialization (object key order must never
// decide a conflict).
function canonicalJson(v: unknown): string {
  if (v === undefined) return "null"
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  const rec = v as Record<string, unknown>
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`
}

export type FamilyProjectionSnapshot = {
  // materialized id (WITHOUT the `forge-` prefix) -> owning family file.
  ownerByMatId: Record<string, string>
  // materialized id -> canonical serialization of its FULL projection
  // input (the resolution's agent record: def + shared + ns + file). The
  // compiled file content is a pure function of this plus the host-wide
  // sync options, so snapshot equality between two resolutions of the
  // same host == projection equality.
  contentByMatId: Record<string, string>
}

// Serializable projection view of one host-wide resolution — the diff
// material for cross-family winner tracking. Pure: no fs, no compiler.
export function familyProjectionSnapshot(resolution: PoolResolution): FamilyProjectionSnapshot {
  const ownerByMatId: Record<string, string> = {}
  const contentByMatId: Record<string, string> = {}
  for (const family of resolution.families) {
    for (const matId of family.materializedIds) {
      ownerByMatId[matId] = family.file
      contentByMatId[matId] = canonicalJson(resolution.agents[matId] ?? null)
    }
  }
  return { ownerByMatId, contentByMatId }
}

// A FULL pre-save baseline: the projection snapshot PLUS the collision
// findings at capture time (the vs-baseline diff must distinguish a NEW
// collision from a pre-existing one the resolver re-emits every resolve).
// JSON-safe by construction, so a commit protocol can retain it in memory
// alongside the receipt (review 2026-11-27: the before-side of the winner
// diff is the PRE-SAVE state — the state the human confirmed — never a
// post-save re-resolution, which would silently miss save-caused flips).
export type FamilyBaselineSnapshot = FamilyProjectionSnapshot & { collisionFindings: string[] }

export function baselineSnapshotOf(resolution: PoolResolution): FamilyBaselineSnapshot {
  return {
    ...familyProjectionSnapshot(resolution),
    collisionFindings: resolution.findings
      .filter((f) => f.code === "materialized-id-collision")
      .map((f) => f.message),
  }
}

// Collision-winner findings attributable to the selected family: the
// resolver's materialized-id-collision findings naming its file.
function collisionFindings(resolution: PoolResolution, familyFile: string): string[] {
  return resolution.findings
    .filter((f) => f.code === "materialized-id-collision" && f.message.includes(familyFile))
    .map((f) => f.message)
}

// Findings NEW in `after` (not present, byte-identical, in `before`).
// A collision finding the resolver re-emits on every resolve for an
// UNCHANGED pre-existing collision is disclosure material only — it must
// never block application as a NEW conflict (P2 review: editing family A's
// other worker while an old A/B collision stands must not unconfirm a
// family-scoped sync that left every other projection untouched).
function newCollisionFindings(before: PoolResolution, after: PoolResolution, familyFile: string): string[] {
  const seen = new Set(before.findings.map((f) => `${f.code}|${f.message}`))
  return after.findings
    .filter((f) => f.code === "materialized-id-collision" && f.message.includes(familyFile) && !seen.has(`${f.code}|${f.message}`))
    .map((f) => f.message)
}

// Cross-family winner conflicts attributable to the selected family.
//
//   3-arg form (REQUIRED for the TUI): diffs the BEFORE vs AFTER
//   resolutions and reports — as conflict messages, never as writes —
//   every projection change that touches a family OTHER than `familyFile`:
//   winner flips (the review's A-deleted → B-gains case), ids newly
//   materialized or no longer materialized by another family, content
//   changes inside another family, and collision findings that are NEW in
//   `after`. Collision findings UNCHANGED since `before` (a pre-existing
//   stale collision the resolver re-emits every time) are disclosure
//   material only — they are NOT returned here, so an edit that left every
//   other projection byte-identical does not block application.
//   `before: null` fails closed with an explicit disclosure (drift cannot
//   be ruled out). The selected family's own changes are normal sync work,
//   not conflicts.
//
//   Baseline form (review 2026-11-27): the BEFORE side as a retained
//   FamilyBaselineSnapshot — the PRE-SAVE full resolution the commit
//   protocol captures before publish — diffed against a live AFTER
//   resolution. Semantically identical to the 3-arg form; exists so a
//   commit-time baseline survives in memory and the sync diff never has to
//   substitute a post-save re-resolution for the confirmed pre-save state.
//
//   2-arg form (LEGACY, deprecated for verification flows): findings-only
//   over the single resolution — bit-identical to the original contract —
//   but it structurally CANNOT see winner changes with no surviving
//   collision finding, nor distinguish stale from new findings. Callers
//   that report application status must use the 3-arg form with a real
//   pre-edit resolution.
function projectionDiffConflicts(beforeSnap: FamilyProjectionSnapshot, after: PoolResolution, selected: string): string[] {
  const conflicts: string[] = []
  const afterSnap = familyProjectionSnapshot(after)
  const ids = new Set([...Object.keys(beforeSnap.ownerByMatId), ...Object.keys(afterSnap.ownerByMatId)])
  for (const matId of ids) {
    const beforeOwner = beforeSnap.ownerByMatId[matId]
    const afterOwner = afterSnap.ownerByMatId[matId]
    const beforeContent = beforeSnap.contentByMatId[matId]
    const afterContent = afterSnap.contentByMatId[matId]
    if (beforeOwner !== undefined && afterOwner === undefined) {
      if (beforeOwner !== selected) {
        conflicts.push(`materialized id "${matId}" (forge-${matId}) is no longer materialized — family ${beforeOwner}'s projection needs GC/reconciliation outside the selected family`)
      }
      continue
    }
    if (beforeOwner === undefined && afterOwner !== undefined) {
      if (afterOwner !== selected) {
        conflicts.push(`materialized id "${matId}" (forge-${matId}) is newly materialized by family ${afterOwner} — a family-scoped sync never writes another family's projection`)
      }
      continue
    }
    if (beforeOwner !== afterOwner) {
      const other = beforeOwner !== selected ? beforeOwner : afterOwner
      conflicts.push(`materialized id "${matId}" (forge-${matId}) winner moved from ${String(beforeOwner)} to ${String(afterOwner)} — family ${String(other)}'s projection needs reconciliation outside the selected family`)
      continue
    }
    if (beforeContent !== afterContent && afterOwner !== selected) {
      conflicts.push(`materialized id "${matId}" (forge-${matId}) projection content changed inside family ${afterOwner} — a family-scoped sync never rewrites another family's projection`)
    }
  }
  return conflicts
}

export function crossFamilyWinnerConflictsFromBaseline(before: FamilyBaselineSnapshot | null, after: PoolResolution, familyFile: string): string[] {
  if (before === null) {
    return [...collisionFindings(after, familyFile), "cross-family winner drift cannot be ruled out (no pre-save baseline to diff) — application must stay unconfirmed"]
  }
  // New collision findings: present in `after`, absent from the baseline's
  // own capture-time list.
  const seen = new Set(before.collisionFindings)
  const conflicts = after.findings
    .filter((f) => f.code === "materialized-id-collision" && f.message.includes(familyFile) && !seen.has(f.message))
    .map((f) => f.message)
  conflicts.push(...projectionDiffConflicts(before, after, familyFile))
  return conflicts
}

export function crossFamilyWinnerConflicts(before: PoolResolution | null, after: PoolResolution, familyFile: string): string[]
export function crossFamilyWinnerConflicts(resolution: PoolResolution, familyFile: string): string[]
export function crossFamilyWinnerConflicts(a: PoolResolution | null, b: PoolResolution | string, c?: string): string[] {
  if (typeof b === "string") {
    return collisionFindings(a as PoolResolution, b)
  }
  if (a === null) {
    return crossFamilyWinnerConflictsFromBaseline(null, b, c ?? "")
  }
  return crossFamilyWinnerConflictsFromBaseline(baselineSnapshotOf(a), b, c ?? "")
}
