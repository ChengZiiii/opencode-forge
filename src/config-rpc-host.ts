// Server-side host adapter for the forge-config RPC commit protocol (change
// forge-tui-subagent-config, tasks 6.1/6.2 wiring, design D2/D4/D7).
//
// OWNERSHIP (explicit, review-fixed 2026-11-27): this module does NOT
// implement the protocol store — snapshot handles, preview tokens, receipts,
// the per-target commit lock and the prepare/commit/receipt logic live in
// src/config-rpc-protocol.ts (createConfigRpcStore). This file is exactly the
// three host-facing pieces the store requires from the plugin's authoritative
// state:
//
//   1. THE EPOCH — the only server-provable epoch (the server has no client
//      identity): a per-process boot id plus the RPC registration generation.
//      The VALUE lives here; plugin.ts rotates it at every registration and
//      cleanup, and the store reads it through deps.epoch(), so a changed
//      generation refuses every previously issued handle/token.
//   2. THE AUTHORITATIVE SCOPE RESOLVER — workspace/global target resolution
//      over the plugin's own state (host anchor registry, sessionMovedAnchors,
//      known workspace families, pool resolver). Synchronous by the store's
//      contract: the commit path re-runs it inside the commit lock with no
//      await in between, so a session.moved event cannot land between
//      resolution and publish.
//      Session anchors resolve LIVE-MAP-FIRST (session.moved record → live
//      session map → persisted ledger with its pool-ownership re-check) and
//      NEVER call the async session.get seam INSIDE this synchronous chain —
//      the plugin-facing session record can lag a real move (live-probe
//      fact, fix-v2-crew-surface-drift 4.1), and a stale get must never
//      outweigh the host's own moved event. The async seam's place is the
//      PRE-LOAD at the wiring boundary (plugin.ts wraps every RPC handler:
//      resolveSessionAnchorForPools awaited OUTSIDE any lock, so a resumed
//      session's authoritative record/ledger seed is warm before the
//      synchronous moved-first resolution — review 7a); the lock interior
//      stays synchronous with no await gap.
//      Unresolvable session/null-location scope REFUSES (scope-unresolved):
//      no guessed process directory, no wildcard home (a null sessionID means
//      exactly the home scope of THIS registration's server-observed location,
//      with that location itself part of the binding).
//   3. THE FS ADAPTER — the strict stat/read seams the store and the atomic
//      kernel consume. Write seams are deliberately NOT injected: the
//      kernel's own real-fs path (exclusive-create temp + rename/hardlink
//      publication) is the probe-proven write discipline.
//
// Also assembled here: the complete ConfigRpcStoreDeps object, so plugin.ts
// wiring stays a two-call composition (createConfigRpcHostDeps →
// createConfigRpcStore).

import { defaultIdentityStat, type FileIdentity } from "./file-identity.ts"
import { randomUUID } from "node:crypto"
import { forgeConfigPaths } from "./forge-config.ts"
import type { ConfigRpcEpoch, ConfigRpcStoreDeps, ConfigRpcFsSeams, ScopeResolved, ScopeResolver, CommitReverify } from "./config-rpc-protocol.ts"
import type { Scope } from "../rpc.ts"

// ---------------------------------------------------------------------------
// 1. Epoch: per-process boot id + registration generation
// ---------------------------------------------------------------------------

const configRpcEpochState: ConfigRpcEpoch = { epoch: randomUUID(), generation: 0 }

// The live epoch the store compares every binding against.
export function currentConfigRpcEpoch(): ConfigRpcEpoch {
  return { ...configRpcEpochState }
}

// A registration-generation change (register OR dispose): every previously
// issued handle/token must refuse afterwards (server-provable; tasks 6.5).
export function rotateConfigRpcEpoch(): ConfigRpcEpoch {
  configRpcEpochState.generation += 1
  return { ...configRpcEpochState }
}

// Test seam only: reseed the epoch identity (a fresh process boot).
export function resetConfigRpcEpochForTests(seed?: { epoch?: string; generation?: number }): void {
  configRpcEpochState.epoch = seed?.epoch ?? randomUUID()
  configRpcEpochState.generation = seed?.generation ?? 0
}

// ---------------------------------------------------------------------------
// 2. Authoritative scope resolution over the plugin's own state
// ---------------------------------------------------------------------------

// The plugin-side accessors. ALL reads are synchronous and authoritative —
// they read the plugin's in-process maps and the shared pool resolver, never
// a network seam and never the process cwd as a substitute for an anchor.
export type ConfigScopeAccessors = {
  // Live authoritative session anchor: sessionMovedAnchors FIRST (the host's
  // own session.moved statement), then the live session map, then the
  // persisted session-anchor ledger (pool-ownership re-checked). Returns
  // null when nothing authoritative exists — the caller refuses.
  sessionAnchorOf(sessionID: string): string | null
  // Walk-up NEAREST owning pool file for an anchor (the shared resolver's
  // workspacePoolOf); null = the workspace has no pool (global fallback).
  workspacePoolOf(anchor: string): string | null
  // The server's own global recipe path (test-home aware).
  globalPoolPath(): string
  // Whether the host authoritatively initialized this workspace root (the
  // host anchor registry) — the "server-verified workspace root" a creation
  // may land on.
  knownWorkspaceRoot(anchor: string): boolean
  // Folded path identity (win32 case/separator folding) for comparisons.
  samePath(a: string, b: string): boolean
  // Fail-soft existence (a stat that never throws).
  pathExists(path: string): boolean
}

export type ResolveConfigTargetResult =
  | { ok: true; target: ScopeResolved }
  | { ok: false; reason: "scope-unresolved"; message: string }

// Resolve the authoritative target for a scope/session request.
//
//   sessionID !== null → the session's live anchor (moved-first); its home
//     scope. observedLocation = that anchor: the binding moves with the
//     session's live location, so a token prepared while the session was at
//     location A refuses after the session moved to B — even when the global
//     target path would be identical.
//   sessionID === null → exactly the home scope of the SERVER-OBSERVED
//     location of the registration that owns this resolver (fixed at wiring
//     time). Never a wildcard: another location's registration carries its
//     own resolver, and the generation bump at every registration refuses
//     cross-registration tokens outright.
//
// Workspace scope: the anchor's walk-up owning pool file; an absent pool is
// `creatable` only when the server authoritatively anchors the workspace root
// (host anchor registry). Global scope: the server's own global recipe path,
// creatable when absent (explicit first creation). Both are pure reads.
export function resolveConfigTarget(acc: ConfigScopeAccessors, observedLocation: string | null, req: { scope: Scope; sessionID: string | null }): ResolveConfigTargetResult {
  let anchor: string | null
  let location: string | null
  if (req.sessionID !== null) {
    const live = acc.sessionAnchorOf(req.sessionID)
    if (live === null || live.trim() === "") {
      return { ok: false, reason: "scope-unresolved", message: `no authoritative anchor for session ${req.sessionID} — the server has no live workspace statement for it (session.moved / live map / ledger all empty); scope stays unresolved rather than guessed` }
    }
    anchor = live
    location = live
  } else {
    if (observedLocation === null || observedLocation.trim() === "") {
      return { ok: false, reason: "scope-unresolved", message: "this registration has no server-observed location — a null-session (home) scope is not resolvable here; refuse rather than widen to a wildcard" }
    }
    anchor = observedLocation
    location = observedLocation
  }
  if (req.scope === "global") {
    const globalPath = acc.globalPoolPath()
    return {
      ok: true,
      target: {
        path: globalPath,
        observedLocation: location,
        // The global layer has no workspace anchor of its own; the observed
        // location stays in the binding (part of the target identity).
        anchor: null,
        creatable: !acc.pathExists(globalPath),
      },
    }
  }
  // Workspace scope. An EXISTING owning pool file anchors itself — it is
  // editable regardless of whether the root is host-registered (the file is
  // the authority). A CREATION (no pool file) is only ever anchored at a
  // server-verified workspace root: the gate is UNIFORM over sessionID
  // (review 7b — a session-scoped first-creation must not bypass the root
  // registration check just because it carries a session identity).
  const pool = acc.workspacePoolOf(anchor)
  if (pool !== null && pool.trim() !== "") {
    return { ok: true, target: { path: pool, observedLocation: location, anchor, creatable: false } }
  }
  if (!acc.knownWorkspaceRoot(anchor)) {
    return { ok: false, reason: "scope-unresolved", message: `${anchor} has no owning pool file and is not a host-initialized workspace root — creation cannot be authoritatively anchored here${req.sessionID !== null ? " (a session identity does not substitute for the host's root registration)" : ""}` }
  }
  // No pool file at a registered root: the explicit-creation candidate is
  // this anchor's own project recipe path (never a deeper guessed path;
  // nested files below the owning workspace do not participate).
  return { ok: true, target: { path: forgeConfigPaths({ projectDir: anchor }).project, observedLocation: location, anchor, creatable: true } }
}

// In-lock ownership re-verification (the store's CommitReverify seam). Runs
// synchronously inside the commit lock — re-resolves the target from live
// state and demands exact folded equality with the binding. The creation
// gate mirrors the resolver UNIFORMLY (review 7b): a creatable candidate is
// refused when the root is not host-initialized, whatever sessionID the
// binding carries. Any throw fails closed (false).
export function reverifyConfigTarget(acc: ConfigScopeAccessors, observedLocation: string | null, req: { scope: Scope; sessionID: string | null; path: string; observedLocation: string | null; anchor: string | null }): boolean {
  try {
    const r = resolveConfigTarget(acc, observedLocation, { scope: req.scope, sessionID: req.sessionID })
    if (!r.ok) return false
    const t = r.target
    if (!acc.samePath(t.path, req.path)) return false
    if (!sameOptionalPath(t.observedLocation, req.observedLocation, acc)) return false
    if (!sameOptionalPath(t.anchor, req.anchor, acc)) return false
    // The creation gate is WORKSPACE-only: a global first-creation resolves
    // with anchor null and creatable = file-absent (no root registration
    // concept applies there) — demanding a workspace root here would reject
    // every legitimate global creation.
    if (req.scope === "workspace" && t.creatable && !acc.knownWorkspaceRoot(t.anchor ?? "")) return false
    return true
  } catch {
    return false
  }
}

function sameOptionalPath(a: string | null, b: string | null, acc: ConfigScopeAccessors): boolean {
  if (a === null || b === null) return a === b
  return acc.samePath(a, b)
}

// ---------------------------------------------------------------------------
// 3. FS adapter + deps assembly
// ---------------------------------------------------------------------------

// Real-fs stat carrying the FULL identity losslessly: one bigint stat per
// sample, dev/ino as canonical decimal strings (real inodes exceed the
// safe-integer range), mtimeMs derived seconds/nanoseconds split so the
// fractional decimals agree on both sides of a snapshot→commit pair. The
// delete+recreate swap guard needs both. An identity that samples but
// cannot be represented losslessly throws OUTSIDE the stat catch (never
// disguised as null = absent).
function hostStat(path: string): FileIdentity | null {
  return defaultIdentityStat(path)
}

export type CreateConfigRpcHostOpts = {
  // THIS registration's server-observed location (the first non-rootish
  // location candidate of the v2Setup that wires the store). It is the
  // binding anchor for every null-session (home) request.
  observedLocation?: string | null
  clock?: () => number
  randomId?: () => string
  hash?: (text: string) => string
  ttlMs?: ConfigRpcStoreDeps["ttlMs"]
  limits?: ConfigRpcStoreDeps["limits"]
  fs?: ConfigRpcFsSeams
  // Pre-write baseline capture (the commit protocol calls it inside the
  // commit lock, before the publish). The plugin wiring provides the sync
  // module's captureSyncBaseline over a FRESH authoritative resolution.
  beforeCommit?: ConfigRpcStoreDeps["beforeCommit"]
}

// Assemble the full ConfigRpcStoreDeps from the plugin's authoritative state.
// The epoch getter always reads the LIVE state (rotation at registration and
// cleanup is visible to the store without touching it); the resolver/reverify
// close over the accessors and this registration's observed location.
export function createConfigRpcHostDeps(acc: ConfigScopeAccessors, opts: CreateConfigRpcHostOpts = {}): ConfigRpcStoreDeps {
  const observedLocation = opts.observedLocation ?? null
  const resolver: ScopeResolver = (req) => resolveConfigTarget(acc, observedLocation, req)
  const reverify: CommitReverify = (req) => reverifyConfigTarget(acc, observedLocation, req)
  // Default fs seams: full-identity stat only. readFile stays UNDEFINED so
  // the kernel/protocol defaults apply (strict fatal UTF-8 Buffer decode —
  // never a lossy string read); the write seams stay UNDEFINED so the
  // kernel's real-fs atomic publication is the only write path.
  const fs: ConfigRpcFsSeams = { stat: hostStat, ...opts.fs }
  return {
    clock: opts.clock ?? (() => Date.now()),
    randomId: opts.randomId,
    hash: opts.hash,
    epoch: currentConfigRpcEpoch,
    resolver,
    reverify,
    ttlMs: opts.ttlMs,
    limits: opts.limits,
    fs,
    beforeCommit: opts.beforeCommit,
  }
}
