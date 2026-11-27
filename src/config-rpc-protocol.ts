// Server-side config RPC protocol kernel (change forge-tui-subagent-config,
// tasks 6.2/6.3/6.5; design D4/D6/D7).
//
// Pure prepare→preview→confirm→commit state machine for the server plugin's
// config RPC. Every external dependency is injectable (clock, ids, hash,
// live epoch, authoritative sync ScopeResolver, fs seams) and the write path
// reuses the proven src/forge-config-edit.ts atomic kernel — no second
// resolver, no second registry.
//
// Hard contract points:
//   - editOpen/prepare are PURE READ. The edit-start snapshot is read once
//     at editor open and is the immovable baseline; freshness probes DO read
//     current bytes but only to REFUSE on mismatch ("conflict reload") — a
//     fresh read is never substituted for the baseline. The editOpen read is
//     guarded first (no symlink/junction on the path, no hard-linked file,
//     realpath folding to the requested path) — raw bytes are never
//     disclosed for a target the write path would refuse.
//   - Tokens are bounded, short-lived, SINGLE-USE, bound to target, scope +
//     sessionID (null = home scope of the server-observed location — the
//     observed location is part of the binding), server-issued target
//     identity, anchor, snapshot bytes + identity, patch + preview hash, and
//     the server epoch/registration generation. Preview sizes are bounded
//     (maxOps, maxDraftBytes) alongside the bounded entry stores.
//   - commit: ONE lock per actual target (withCommitLock, folded path only —
//     shared across locations for a global target). In-lock, synchronously:
//     epoch → expiry → spent → still-registered → scope re-resolution
//     (sync resolver; no await gap for a moved event) → baseline freshness
//     → spend → atomic publish (recheckOwnership runs before the temp write
//     and immediately before the publish; creation eligibility re-checked at
//     every resolution).
//   - Multi-entry batches plan sequentially over accumulated text; an absent
//     baseline ALWAYS yields a create-file write kind (never the last
//     entry's patch kind). Rejected entries are never written, always listed
//     (preview AND no-op verdicts); siblings continue.
//   - All-no-op prepares issue no token; cancel and no-op never write.
//   - Receipts are same-epoch, in-memory, bounded, looked up by TOKEN.
//     found:false = UNKNOWN — bytes never adjudicate an old commit; clients
//     re-prepare and re-confirm, never replay. Epoch/registration-generation
//     changes refuse pre-rotation entries ON TOUCH (honest "epoch-stale",
//     not a misleading unknown) and purge then; sweep TTLs receipts only
//     (expired handles/tokens must stay answerable: "snapshot-expired" /
//     "token-expired", deleted on that touch).
//   - The server never accepts an arbitrary path or arbitrary write text:
//     request shapes carry ids/drafts only (strict key guard mirrors the
//     closed schemas), and every write is covered by an unspent token bound
//     to a server-resolved target.
//   - Optional deps.beforeCommit (sync) captures the host's authoritative
//     baseline INSIDE the lock after all verification and BEFORE the
//     publish; a failed/oversized capture fails the commit closed
//     (write-failed receipt, token consumed). The baseline rides the
//     receipt (getCommitContext by commitId; written/no-op only) and lives
//     and dies with it — same epoch/limits/TTL, no registry.

import { createHash, randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import {
  commitRecipeEdit,
  planOverrideEdit,
  planWorkerEdit,
  snapshotRecipe,
  withCommitLock,
  type CommitErrReason,
  type FileIdentity,
  type PlanKind,
  type PlanOp,
  type RecipeSnapshot,
} from "./forge-config-edit.ts"
import { identityFromBigintStats, isUnsafeIdentityError, normalizeFileIdentity, safeBigintNumber, type FileIdentityInput } from "./file-identity.ts"
import { parseForgeJsonc } from "./forge-config.ts"
import type {
  CommitEntryOutcome,
  CommitInput,
  CommitOutput,
  CommitReceipt,
  EchoInput,
  EchoOutput,
  EditOpenInput,
  EditOpenOutput,
  EntryDraft,
  Finding,
  Op,
  PrepareInput,
  PrepareOutput,
  Preview,
  PreviewEntry,
  PreviewRejected,
  ReceiptInput,
  ReceiptOutput,
  Scope,
} from "../rpc.ts"

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export type ConfigRpcEpoch = { epoch: string; generation: number }

// The authoritative scope resolution — provided by the server wiring from
// the plugin's own state (host anchor registry, sessionMovedAnchors, known
// workspace families, pool resolver). Sync by contract: the commit path
// re-runs it inside the commit lock with no await in between, so a
// session.moved event cannot land between resolution and publish.
export type ScopeResolved = {
  path: string
  observedLocation: string | null
  anchor: string | null
  // Absent file: whether the server authoritatively anchors creation here
  // (server-verified workspace root / its own global home).
  creatable: boolean
}

export type ScopeResolver = (
  req: { scope: Scope; sessionID: string | null },
) => { ok: true; target: ScopeResolved } | { ok: false; reason: "scope-unresolved"; message: string }

// Ownership/anchor revalidation inside the commit lock (runs sync, also as
// commitRecipeEdit's recheckOwnership before AND after the temp write).
// Default when omitted: the resolver equality re-check alone.
export type CommitReverify = (req: {
  scope: Scope
  sessionID: string | null
  path: string
  observedLocation: string | null
  anchor: string | null
}) => boolean

// fs seams with the SAME shapes as the forge-config-edit core (default:
// the real node:fs implementations inside that module). `recheckOwnership`
// is deliberately NOT injectable here — the kernel reserves that seam for
// its own in-lock scope re-verification. Tests inject a memory fs to drive
// the exact write discipline (temp writer + rename publisher + exclusive
// link for creations).
export type ConfigRpcFsSeams = {
  // Seam input (safe-number dev/ino allowed); normalized at the protocol's
  // statOf entry — an unsafe identity refuses (never becomes a null
  // savedIdentity).
  stat?: (path: string) => FileIdentityInput | null
  readFile?: (path: string) => string
  writeFile?: (path: string, data: string) => void
  rename?: (from: string, to: string) => void
  link?: (from: string, to: string) => void
  unlink?: (path: string) => void
  mkdir?: (path: string) => void
  // Read-guard seams (editOpen's one read is guarded before it happens).
  // lstat: ENOENT → { exists: false }, ANY other failure throws (the guard
  // refuses — only proven absence is ever treated as absent). realpath:
  // returns the resolved path or throws.
  lstat?: (path: string) => LstatInfo
  realpath?: (path: string) => string
}

export type ConfigRpcStoreDeps = {
  // Epoch ms clock (inject for expiry tests; no auto-renewal anywhere).
  clock: () => number
  randomId?: () => string // default: crypto randomUUID
  hash?: (text: string) => string // default: sha256 hex
  // Live epoch/registration-generation getter. A changed value refuses every
  // previously issued handle/token (server-provable invalidation).
  epoch: () => ConfigRpcEpoch
  resolver: ScopeResolver
  reverify?: CommitReverify
  // Bounded lifetimes (ms). Defaults: snapshot handle 6h, preview token
  // 5min, receipt 6h — implementation parameters, not contract values.
  ttlMs?: { snapshot?: number; token?: number; receipt?: number }
  // Bounded memory. Defaults: 64 snapshot handles, 128 tokens, 256 receipts;
  // the OLDEST entry is evicted first — an evicted unspent token simply
  // becomes unknown (fail-closed: the client must re-prepare).
  limits?: { snapshots?: number; tokens?: number; receipts?: number }
  // Bounded PREVIEW sizes (the contract's size bound — the entry counts
  // above do not bound request sizes). Defaults: 32 ops per prepare,
  // 262144 UTF-8 bytes per serialized draft (a normal prompt is far below
  // this; an oversized draft rejects ITS op only — siblings continue).
  maxOps?: number // default 32
  maxDraftBytes?: number // default 262144
  fs?: ConfigRpcFsSeams
  // Sync-baseline capture (server-owned; opaque to this kernel). Called
  // INSIDE the commit lock, after every verification and BEFORE the publish
  // — the recipe bytes on disk are still pre-write, so the captured full
  // host resolution is the true "before" (winner flips caused by this very
  // write and post-commit owner moves stay out of it). SYNC by contract
  // (no await gap inside the lock). A throw — or a non-object / oversized
  // return — fails the commit closed: no publish, receipt outcome
  // "write-failed", token consumed. The kernel never interprets the
  // context's fields; the sync handlers compare pre/post themselves.
  beforeCommit?: (req: {
    scope: Scope
    sessionID: string | null
    path: string
    binding: { path: string; observedLocation: string | null; anchor: string | null; targetIdentity: string }
    newText: string
  }) => Record<string, unknown>
  // Bounded context payload: serialized UTF-8 byte cap. Default 1 MiB.
  maxContextBytes?: number
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type Binding = {
  path: string
  targetIdentity: string
  scope: Scope
  sessionID: string | null
  observedLocation: string | null
  anchor: string | null
}

type SnapshotEntry = {
  snapshotId: string
  binding: Binding
  // THE baseline: read exactly once at editor open, never replaced.
  snapshot: RecipeSnapshot
  epoch: ConfigRpcEpoch
  createdAt: number
  expiresAt: number
}

type PlannedEntry = {
  opId: string
  id: string
  kind: "worker" | "override"
  action: "create" | "update" | "delete"
  entryKind: PlanKind
  summary: string[]
  findings: Finding[]
}

// A validator/protocol-rejected op, kept with its declared kind/action so
// the receipt can list it faithfully.
type RejectedEntry = PreviewRejected & {
  kind: "worker" | "override"
  action: Op["action"]
}

type TokenEntry = {
  token: string
  binding: Binding
  snapshotId: string
  // Bound content: the baseline bytes + identity and the canonical patch.
  raw: string | null
  identity: FileIdentity | null
  newText: string
  previewHash: string
  createFile: boolean
  writeKind: "create-file" | "patch"
  entries: PlannedEntry[]
  rejected: RejectedEntry[]
  epoch: ConfigRpcEpoch
  createdAt: number
  expiresAt: number
  spent: boolean
}

type ReceiptStoreEntry = {
  receipt: CommitReceipt
  epoch: ConfigRpcEpoch
  createdAt: number
  expiresAt: number
  // The pre-write host baseline captured by deps.beforeCommit (null when no
  // hook ran or the capture failed). Lives and dies with the receipt: same
  // epoch/limits/TTL — no registry, no persistence.
  context: Record<string, unknown> | null
}

// Sync handlers look the baseline up by receipt.commitId.
export type CommitContextLookup =
  | { found: true; context: Record<string, unknown>; commitId: string; token: string; epoch: string; generation: number }
  | { found: false; epoch: string; generation: number }

// Defaults (bounded implementation parameters; documented, not contract).
const DEFAULT_TTL = { snapshot: 6 * 60 * 60 * 1000, token: 5 * 60 * 1000, receipt: 6 * 60 * 60 * 1000 }
const DEFAULT_LIMITS = { snapshots: 64, tokens: 128, receipts: 256 }

const defaultHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

// parseForgeJsonc → RecipeSnapshot.parse shape adapter (message carries the
// parse location when the JSONC scanner reports one).
function parseOf(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const p = parseForgeJsonc(text)
  return p.ok
    ? { ok: true, value: p.config }
    : { ok: false, message: `${p.error.message}${p.error.line !== undefined ? ` (line ${p.error.line}, column ${p.error.column})` : ""}` }
}

// Read guard for the raw-disclosure point (editOpen): the requested recipe
// path is only snapshotable when the ACTUAL target is the plain file the
// write path would accept — no symlink/junction at any component, no
// hard-linked file (nlink > 1), realpath folding to exactly the requested
// path. Absent finals are fine (explicit creation); absent parents too, but
// every EXISTING component must be a real directory. Without this, a
// legitimate recipe path pointing through a link would leak the link
// target's bytes as `raw`.
function foldPath(p: string): string {
  return process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p
}

type ReadGuardVerdict = { ok: true } | { ok: false; message: string }

// lstat seam contract: ENOENT → { exists: false }; ANY other failure THROWS
// (the guard refuses on throw — only a proven-absent path is ever treated as
// absent, never an uninspectable one).
type LstatInfo = { exists: true; isSymlink: boolean; isDirectory: boolean; isFile: boolean; nlink: number; mtimeMs: number; size: number } | { exists: false }

function defaultLstat(p: string): LstatInfo {
  try {
    // ONE bigint lstat, the SAME seconds/nanoseconds derivation as every
    // identity sample: mtimeMs here agrees with the snapshot/commit sampler
    // (no fractional false conflicts); nlink/size refuse instead of
    // silently rounding past the safe range. Unsafe identities rethrow
    // below — refused, never treated as absent.
    const st = lstatSync(p, { bigint: true })
    const identity = identityFromBigintStats(st)
    return { exists: true, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), isFile: st.isFile(), nlink: safeBigintNumber(st.nlink, "nlink"), mtimeMs: identity.mtimeMs, size: identity.size }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw err
  }
}

function defaultRealpath(p: string): string {
  return realpathSync(p) // throws on failure — the guard refuses
}

function guardReadableTarget(
  path: string,
  seams: { lstat?: ConfigRpcFsSeams["lstat"]; realpath?: ConfigRpcFsSeams["realpath"] },
): ReadGuardVerdict {
  const lstat = seams.lstat ?? defaultLstat
  const realpath = seams.realpath ?? defaultRealpath
  const resolved = path.replace(/\//g, "\\")
  // Ancestor chain (existing components only): symlinked/junction or
  // non-directory ancestors refuse — an ENOENT level is acceptable only for
  // a still-absent target about to be created.
  const parts = resolved.split(/\\/).filter(Boolean)
  let walk = parts[0] ?? ""
  // Stop BEFORE the final component — that one is checked as the target
  // file below (including its symlink/hardlink/realpath policy). An
  // ancestor that cannot be INSPECTED refuses (only a proven ENOENT level
  // is acceptable — nothing above a missing level can be a link target).
  for (let i = 1; i < parts.length - 1; i++) {
    walk = `${walk}\\${parts[i]}`.replace(/^\\+/, "\\")
    let st: LstatInfo
    try {
      st = lstat(walk)
    } catch (err) {
      return { ok: false, message: `unsafe target: cannot inspect ${walk}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!st.exists) break // proven ENOENT — acceptable for a creation target
    if (st.isSymlink) return { ok: false, message: `unsafe target: ${walk} is a symlink/junction — refusing to read or write through it` }
    if (!st.isDirectory) return { ok: false, message: `unsafe target: ${walk} is not a directory` }
  }
  let finalSt: LstatInfo
  try {
    finalSt = lstat(path)
  } catch (err) {
    return { ok: false, message: `unsafe target: cannot inspect ${path}: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (finalSt.exists) {
    if (finalSt.isSymlink) return { ok: false, message: `unsafe target: ${path} is a symlink — replace the link target's real file instead` }
    if (!finalSt.isFile) return { ok: false, message: `unsafe target: ${path} is not a regular file` }
    if (finalSt.nlink > 1) return { ok: false, message: `unsafe target: ${path} is hard-linked (${finalSt.nlink} names) — the write would leak across identities` }
    // realpath must SUCCEED for an existing target and fold to exactly the
    // requested path; a failure refuses (never silently treated as safe).
    let real: string
    try {
      real = realpath(path)
    } catch (err) {
      return { ok: false, message: `unsafe target: cannot resolve ${path}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (foldPath(real) !== foldPath(path)) {
      return { ok: false, message: `unsafe target: ${path} resolves to ${real}` }
    }
  }
  return { ok: true }
}

// The immovable baseline shape shared by snapshot handles and spent tokens
// (the token carries its own bound copy so a bounds-evicted handle cannot
// revive or replace it).
type Baseline = { path: string; exists: boolean; readable: boolean; raw: string | null; stat: FileIdentity | null }

// Freshness refusals (prepare/commit): the current bytes/identity are read
// ONLY to refuse on a mismatch — never as plan input, never a replacement.
type PrepareRefusal = { ok: false; reason: "conflict-reload" | "unreadable"; message: string }

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createConfigRpcStore(deps: ConfigRpcStoreDeps) {
  const randomId = deps.randomId ?? (() => randomUUID())
  const hash = deps.hash ?? defaultHash
  const ttl = { ...DEFAULT_TTL, ...deps.ttlMs }
  const limits = { ...DEFAULT_LIMITS, ...deps.limits }
  const maxOps = deps.maxOps ?? 32
  const maxDraftBytes = deps.maxDraftBytes ?? 262144
  const maxContextBytes = deps.maxContextBytes ?? 1024 * 1024
  const fs = deps.fs ?? {}

  const snapshots = new Map<string, SnapshotEntry>()
  const tokens = new Map<string, TokenEntry>()
  const receipts = new Map<string, ReceiptStoreEntry>() // key: token id

  // Test seam for epoch/registration-generation changes without touching the
  // injected getter: when set, it IS the epoch. Rotation does NOT purge
  // eagerly — pre-rotation entries are refused lazily, ON TOUCH, with the
  // honest reason ("epoch-stale", not a misleading "unknown"), and removed
  // at that touch; receipts of a dead epoch simply answer found:false
  // (UNKNOWN) until their TTL sweeps them. Nothing survives as serviceable
  // state across the rotation — the bounded store just remembers enough to
  // disclose WHY it refuses.
  let epochOverride: ConfigRpcEpoch | null = null
  const epochNow = (): ConfigRpcEpoch => epochOverride ?? deps.epoch()

  const now = (): number => deps.clock()

  // Same-epoch guard: false when the bound epoch/generation is no longer
  // current (server-provable invalidation, task 6.5). Purging is the
  // caller's lazy on-touch decision, never a blind bulk clear.
  const epochLive = (bound: ConfigRpcEpoch): boolean => {
    const cur = epochNow()
    return cur.epoch === bound.epoch && cur.generation === bound.generation
  }

  const insertBounded = <V>(map: Map<string, V>, key: string, value: V, max: number): void => {
    if (map.size >= max && !map.has(key)) {
      const oldest = map.keys().next()
      if (!oldest.done) map.delete(oldest.value)
    }
    map.set(key, value)
  }

  const sweep = (): { evictedSnapshots: number; evictedTokens: number; evictedReceipts: number } => {
    const t = now()
    let evictedReceipts = 0
    // Receipts are the ONLY TTL-swept kind here. Expired snapshot handles
    // and tokens must stay ANSWERABLE — a commit against an expired token
    // discloses "token-expired" (and drops it on that touch), never a
    // misleading "unknown"; bulk-purging them in sweep would turn honest
    // expiry verdicts into unknowns. Pre-rotation entries likewise stay
    // answerable as "epoch-stale" until touched. Unbounded growth is
    // impossible regardless: every insert is bounds-capped (oldest evicted),
    // and touched entries self-delete.
    for (const [id, entry] of receipts) {
      if (t > entry.expiresAt) {
        receipts.delete(id)
        evictedReceipts++
      }
    }
    return { evictedSnapshots: 0, evictedTokens: 0, evictedReceipts }
  }

  // Deterministic, server-issued target identity over the full binding
  // (scope, path, observed location, anchor) — disclosed in every preview
  // and receipt and bound into the token. NOT a path alias: changing any
  // binding component changes the identity.
  const targetIdentityOf = (binding: Omit<Binding, "targetIdentity">): string =>
    `cfgt-${hash(`${binding.scope}\n${binding.path}\n${binding.observedLocation ?? ""}\n${binding.anchor ?? ""}`).slice(0, 32)}`

  const bindingOf = (base: Omit<Binding, "targetIdentity">): Binding => ({ ...base, targetIdentity: targetIdentityOf(base) })

  // Valid sessionID: exactly string or null — anything else is a malformed
  // request. The INVALID sentinel is compared by identity (`=== INVALID`).
  const INVALID: unique symbol = Symbol("config-rpc-invalid-session")
  const asSessionID = (v: unknown): string | null | typeof INVALID => {
    if (v === null) return null
    if (typeof v === "string") return v
    return INVALID
  }

  // -------------------------------------------------------------------------
  // Strict request-shape guard: the JSON Schemas already close every input
  // (additionalProperties:false), but the handler is the enforcement point
  // — an unknown top-level key refuses as malformed instead of being
  // silently ignored. (sync is deliberately exempt: its envelope is frozen
  // here but its fields belong to the sync handlers.)
  // -------------------------------------------------------------------------
  const onlyKeys = (input: unknown, keys: readonly string[]): boolean => {
    if (typeof input !== "object" || input === null) return false
    return Object.keys(input).every((k) => keys.includes(k))
  }

  // -------------------------------------------------------------------------
  // echo — transport provability + epoch observation (NOT correctness)
  // -------------------------------------------------------------------------

  const echo = (input: EchoInput, ctx: { pluginID: string; appVersion: string }): EchoOutput => {
    const cur = epochNow()
    return {
      nonce: typeof input?.nonce === "string" ? input.nonce : "",
      pluginID: ctx.pluginID,
      appVersion: ctx.appVersion,
      epoch: cur.epoch,
      generation: cur.generation,
    }
  }

  // -------------------------------------------------------------------------
  // editOpen — authoritative resolve + the edit-start snapshot handle
  // (pure read; the file is read EXACTLY once here)
  // -------------------------------------------------------------------------

  const editOpen = (input: EditOpenInput): EditOpenOutput => {
    sweep()
    if (!onlyKeys(input, ["scope", "sessionID"])) {
      return { ok: false, reason: "malformed-request", message: "malformed editOpen request — unexpected top-level field(s) are refused" }
    }
    const sessionID = asSessionID(input?.sessionID)
    if (sessionID === INVALID || (input?.scope !== "workspace" && input?.scope !== "global")) {
      return { ok: false, reason: "scope-unresolved", message: "malformed editOpen request — scope must be \"workspace\"|\"global\" and sessionID a string or exactly null" }
    }
    const resolved = deps.resolver({ scope: input.scope, sessionID })
    if (!resolved.ok) {
      return { ok: false, reason: "scope-unresolved", message: resolved.message }
    }
    // Fail closed: the binding MUST carry server-observed location evidence
    // (the resolver type still allows null for compatibility, but a null
    // observation would hand out write eligibility with no location proof —
    // the runtime refuses instead of binding null).
    if (resolved.target.observedLocation === null || resolved.target.observedLocation === undefined) {
      return { ok: false, reason: "scope-unresolved", message: "the server cannot observe a location for this target right now — no snapshot is issued (fail closed)" }
    }
    // The ONE read of the target for this editor session — after this, the
    // stored snapshot is the immovable baseline (freshness probes compare,
    // they never replace). Guarded FIRST: no raw bytes are returned for a
    // target the write path itself would refuse (symlink/junction anywhere
    // on the path, hard-linked file, redirected realpath).
    const guard = guardReadableTarget(resolved.target.path, fs)
    if (!guard.ok) {
      return { ok: false, reason: "scope-unresolved", message: `${guard.message} — no snapshot is issued` }
    }
    const snapshot = snapshotRecipe({ path: resolved.target.path, stat: fs.stat, readFile: fs.readFile })
    // Workspace-only conflict guard: the resolver found an OWNING pool
    // (creatable:false) but the one read came back ABSENT — deleted/renamed
    // after discover, or a stat failure. An absent non-creatable workspace
    // target is a conflicted resolution: NO snapshot handle is issued (fail
    // closed) and the client reloads. Global absent stays legal
    // (first-creation candidate — the target-not-creatable warn below still
    // discloses its resolve/read races).
    if (input.scope === "workspace" && !resolved.target.creatable && !snapshot.exists) {
      return { ok: false, reason: "scope-unresolved", message: `the owning workspace pool ${resolved.target.path} reads back absent while its creation is not authoritatively anchored — conflicted resolution; no snapshot handle is issued, reopen to re-resolve` }
    }
    // Post-read identity re-verification: the guard and the read are NOT one
    // atomic operation — a swap between them is detected here (the read's
    // stat must still match the live lstat) and fails closed with no bytes
    // disclosed. Honest residual: this NARROWS the race to a same-instant
    // swap; it does not eliminate it (lstat/read are separate syscalls; an
    // fd-level nofollow design is host-side hardening and is deliberately
    // NOT claimed — it is not portable to this platform matrix).
    if (snapshot.exists && snapshot.stat !== null) {
      let post: LstatInfo
      try {
        post = (fs.lstat ?? defaultLstat)(resolved.target.path)
      } catch (err) {
        return { ok: false, reason: "scope-unresolved", message: `unsafe target: ${resolved.target.path} changed while being read (inspect failed: ${err instanceof Error ? err.message : String(err)}) — no snapshot is issued` }
      }
      const st0 = snapshot.stat
      const swapped = !post.exists
        || post.isSymlink
        || !post.isFile
        || post.mtimeMs === undefined
        || post.mtimeMs !== st0.mtimeMs
        || (post.size !== undefined && post.size !== st0.size)
      if (swapped) {
        return { ok: false, reason: "scope-unresolved", message: `unsafe target: ${resolved.target.path} changed while being read — refusing (no bytes disclosed); reload` }
      }
    }
    const t = now()
    const cur = epochNow()
    const binding = bindingOf({
      path: resolved.target.path,
      scope: input.scope,
      sessionID,
      observedLocation: resolved.target.observedLocation,
      anchor: resolved.target.anchor,
    })
    const snapshotId = randomId()
    const entry: SnapshotEntry = {
      snapshotId,
      binding,
      snapshot,
      epoch: { ...cur },
      createdAt: t,
      expiresAt: t + ttl.snapshot,
    }
    insertBounded(snapshots, snapshotId, entry, limits.snapshots)
    const findings: Finding[] = []
    if (!snapshot.exists && !resolved.target.creatable) {
      findings.push({ level: "warn", code: "target-not-creatable", message: `no recipe at ${binding.path} and the server cannot authoritatively anchor a creation here — browsing only, writes unavailable` })
    }
    if (snapshot.exists && !snapshot.readable) {
      findings.push({ level: "warn", code: "target-unreadable", message: `the recipe at ${binding.path} exists but cannot be decoded (strict UTF-8) — every edit is refused` })
    }
    return {
      ok: true,
      snapshotId,
      path: binding.path,
      targetIdentity: binding.targetIdentity,
      scope: binding.scope,
      sessionID: binding.sessionID,
      observedLocation: binding.observedLocation,
      anchor: binding.anchor,
      epoch: cur.epoch,
      generation: cur.generation,
      expiresAt: entry.expiresAt,
      exists: snapshot.exists,
      readable: snapshot.readable,
      creatable: resolved.target.creatable === true,
      identity: snapshot.stat,
      raw: snapshot.raw,
      document: snapshot.parse && snapshot.parse.ok ? snapshot.parse.value : null,
      parseError: snapshot.parse && !snapshot.parse.ok ? { message: snapshot.parse.message } : null,
      findings,
    }
  }

  // -------------------------------------------------------------------------
  // prepare — canonical patch + bounded single-use preview token (pure read)
  // -------------------------------------------------------------------------

  // Sequential batch planning against the accumulated text. The baseline
  // snapshot object is NEVER mutated: chaining happens through fresh
  // intermediate snapshots whose `raw`/`parse` carry the accumulated text
  // (stat identity stays the baseline's — only the baseline's identity is
  // ever compared at commit). Rejected ops never contribute text; siblings
  // continue (fail-soft).
  function planBatch(entry: SnapshotEntry, ops: Op[]): {
    accText: string
    entries: PlannedEntry[]
    rejected: RejectedEntry[]
    findings: Finding[]
  } {
    const baseline = entry.snapshot
    const entries: PlannedEntry[] = []
    const rejected: RejectedEntry[] = []
    const findings: Finding[] = []
    let acc = baseline.raw ?? ""
    let createdFile = false
    for (const op of ops) {
      // Immutable-id discipline (freeze v1): ANY renameTo presence refuses
      // the op outright.
      if (op.renameTo !== undefined) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: "invalid-id", message: "renaming an existing entry id is not supported — create the new id explicitly and delete the old one", findings: [] })
        continue
      }
      if (op.kind !== "worker" && op.kind !== "override") {
        rejected.push({ opId: op.opId, id: op.id, kind: "worker", action: op.action, reason: "invalid-op", message: `op kind must be "worker" or "override"`, findings: [] })
        continue
      }
      if (op.action !== "create" && op.action !== "update" && op.action !== "delete") {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: "create", reason: "invalid-op", message: `op action must be "create", "update" or "delete"`, findings: [] })
        continue
      }
      const draft: EntryDraft | undefined = op.draft
      if (draft !== undefined && Buffer.byteLength(JSON.stringify(draft), "utf8") > maxDraftBytes) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: "invalid-op", message: `the draft exceeds the bounded preview size (${maxDraftBytes} UTF-8 bytes) — refusing this op only`, findings: [] })
        continue
      }
      const planOp: PlanOp = { action: op.action, id: op.id, draft }
      const opts = { scope: entry.binding.scope, pool: op.pool }
      const result = op.kind === "worker"
        ? planWorkerEdit(currentSnapshot(baseline, acc, createdFile || baseline.exists), planOp, opts)
        : planOverrideEdit(currentSnapshot(baseline, acc, createdFile || baseline.exists), planOp, opts)
      findings.push(...result.findings)
      if (!result.ok) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: result.reason, message: result.message, findings: result.findings.filter((f) => f.level === "error") })
        continue
      }
      // Kernel discipline: a plan never drifts off its snapshot's path
      // (commitRecipeEdit would honor a plan.path verbatim — the protocol
      // refuses any drift here instead).
      if (result.plan.path !== entry.binding.path) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: "invalid-op", message: "internal: planned path drifted from the resolved binding — refusing the op", findings: [] })
        continue
      }
      acc = result.plan.newText
      if (result.plan.kind === "create-file") createdFile = true
      entries.push({
        opId: op.opId,
        id: result.plan.id,
        kind: op.kind,
        action: op.action,
        entryKind: result.plan.kind,
        summary: result.plan.summary,
        findings: result.findings,
      })
    }
    return { accText: acc, entries, rejected, findings }
  }

  // Intermediate snapshot for chained planning: the accumulated text with a
  // fresh parse. exists flips true once a create-file plan produced the
  // initial document (its kind stays recorded per entry; the FILE write kind
  // is derived from the ORIGINAL baseline below). stat stays the baseline's
  // (null for an absent file) — it is never compared mid-batch.
  function currentSnapshot(baseline: RecipeSnapshot, acc: string, exists: boolean): RecipeSnapshot {
    if (exists && baseline.exists) return { ...baseline, raw: acc, parse: parseOf(acc) }
    if (exists && !baseline.exists) {
      return { path: baseline.path, exists: true, readable: true, raw: acc, stat: null, parse: parseOf(acc) }
    }
    return baseline
  }

  const prepare = (input: PrepareInput): PrepareOutput => {
    sweep()
    if (!onlyKeys(input, ["snapshotId", "scope", "sessionID", "ops"])) {
      return { ok: false, reason: "malformed-request", message: "malformed prepare request — unexpected top-level field(s) are refused" }
    }
    const entry = typeof input?.snapshotId === "string" ? snapshots.get(input.snapshotId) : undefined
    if (entry === undefined) {
      return { ok: false, reason: "snapshot-unknown", message: "unknown snapshot handle — open the editor (editOpen) again" }
    }
    if (!epochLive(entry.epoch)) {
      snapshots.delete(entry.snapshotId) // purge on touch: the stale handle is answered honestly, then dropped
      return { ok: false, reason: "epoch-stale", message: "the server epoch or RPC registration generation changed — every handle and token issued before it is refused; reopen the editor" }
    }
    const t = now()
    if (t > entry.expiresAt) {
      snapshots.delete(entry.snapshotId)
      return { ok: false, reason: "snapshot-expired", message: "the edit-start snapshot handle expired — reopen the editor (no auto-renewal)" }
    }
    const sessionID = asSessionID(input?.sessionID)
    if (sessionID === INVALID || (input?.scope !== entry.binding.scope) || input.sessionID !== entry.binding.sessionID) {
      return { ok: false, reason: "scope-mismatch", message: "stated scope/sessionID do not exactly match the snapshot binding (null against null)" }
    }
    if (!Array.isArray(input.ops)) {
      return { ok: false, reason: "invalid-op", message: "ops must be an array" }
    }
    if (input.ops.length > maxOps) {
      return { ok: false, reason: "invalid-op", message: `a prepare carries at most ${maxOps} ops (bounded previews) — got ${input.ops.length}` }
    }
    // Authoritative re-resolution NOW: the target must still resolve under
    // the SAME binding (path, observed location AND anchor — the binding is
    // the location, not the server home path: a token prepared under
    // location A is refused when the target resolves under B even at an
    // identical global path).
    const resolved = deps.resolver({ scope: entry.binding.scope, sessionID: entry.binding.sessionID })
    if (!resolved.ok) {
      return { ok: false, reason: "scope-unresolved", message: resolved.message }
    }
    if (
      resolved.target.path !== entry.binding.path ||
      resolved.target.observedLocation !== entry.binding.observedLocation ||
      resolved.target.anchor !== entry.binding.anchor
    ) {
      return { ok: false, reason: "scope-mismatch", message: "the target no longer resolves under the edit-start binding (owner, path or observed location changed) — reopen the editor" }
    }
    // Freshness probe of the baseline: current bytes/identity are READ only
    // to REFUSE on a mismatch — never as plan input, never a baseline
    // replacement. An external edit between form open and Save is refused
    // (reload), not swallowed.
    const fresh = freshnessOf(baselineOf(entry.snapshot))
    if (fresh !== null) return fresh
    // An absent target the server cannot authoritatively anchor a creation
    // on is browse-only.
    if (!entry.snapshot.exists && resolved.target.creatable !== true) {
      return { ok: false, reason: "scope-unresolved", message: `no recipe at ${entry.binding.path} and the server cannot authoritatively anchor a creation here — writes unavailable` }
    }
    // An undecodable baseline refuses EVERY edit (never a lossy rewrite
    // source) — refused here, not per-op.
    if (entry.snapshot.exists && !entry.snapshot.readable) {
      return { ok: false, reason: "unreadable", message: `the recipe at ${entry.binding.path} was unreadable when the editor opened (invalid UTF-8) — refusing every edit; reload after fixing the encoding` }
    }
    // A broken document is never planned over: refuse early with the parse
    // location (each op would otherwise reject with the same verdict).
    if (entry.snapshot.exists && entry.snapshot.readable && entry.snapshot.parse !== null && !entry.snapshot.parse.ok) {
      return { ok: false, reason: "unparseable", message: `${entry.binding.path}: ${entry.snapshot.parse.message} — broken documents are never edited in place; fix the syntax first` }
    }

    const batch = planBatch(entry, input.ops)
    const allFindings = [...batch.findings]
    if (batch.entries.length === 0) {
      const first = batch.rejected[0]
      return {
        ok: false,
        reason: "no-valid-entries",
        message: first !== undefined
          ? `${batch.rejected.length} of ${input.ops.length} entries rejected — ${first.message}`
          : "no entries to save",
        findings: allFindings,
      }
    }
    const createFile = !entry.snapshot.exists
    const anyChange = batch.entries.some((e) => e.entryKind !== "no-op")
    if (!anyChange) {
      // Zero-writable verdict: NO token exists for this prepare — nothing
      // can write (cancel and no-op never write). Rejected entries are
      // still DISCLOSED here — a no-op verdict never silently swallows a
      // rejected sibling.
      return {
        ok: true,
        outcome: "no-op",
        summary: batch.entries.flatMap((e) => e.summary),
        rejected: batch.rejected.map(({ opId, id, reason, message, findings }) => ({ opId, id, reason, message, findings })),
        findings: allFindings,
      }
    }
    const cur = epochNow()
    const token = randomId()
    const expiresAt = t + ttl.token
    const newText = batch.accText
    const tokenEntry: TokenEntry = {
      token,
      binding: entry.binding,
      snapshotId: entry.snapshotId,
      raw: entry.snapshot.raw,
      identity: entry.snapshot.stat,
      newText,
      previewHash: hash(newText),
      createFile,
      writeKind: createFile ? "create-file" : "patch",
      entries: batch.entries,
      rejected: batch.rejected,
      epoch: { ...cur },
      createdAt: t,
      expiresAt,
      spent: false,
    }
    insertBounded(tokens, token, tokenEntry, limits.tokens)
    const preview: Preview = {
      path: entry.binding.path,
      targetIdentity: entry.binding.targetIdentity,
      scope: entry.binding.scope,
      sessionID: entry.binding.sessionID,
      oldText: entry.snapshot.raw,
      newText,
      previewHash: tokenEntry.previewHash,
      createFile,
      identity: entry.snapshot.stat,
      entries: batch.entries.map((e) => ({
        opId: e.opId,
        id: e.id,
        kind: e.kind,
        action: e.action,
        entryKind: e.entryKind,
        summary: e.summary,
        findings: e.findings,
      })),
      rejected: batch.rejected.map(({ opId, id, reason, message, findings }) => ({ opId, id, reason, message, findings })),
    }
    return {
      ok: true,
      outcome: "token",
      token: { token, expiresAt, epoch: cur.epoch, generation: cur.generation },
      preview,
      findings: allFindings,
    }
  }

  // Baseline freshness: null when current bytes AND identity still match the
  // edit-start snapshot; a PrepareOutput refusal otherwise. Full stat+read —
  // identityMatches inside the core only weighs dev/ino when BOTH sides
  // carry them, so this probe always reads the bytes too (the stronger
  // guard); the real fs stat default carries dev/ino.
  function freshnessOf(baseline: Baseline): PrepareRefusal | null {
    const stat = fs.stat
    const readFile = fs.readFile
    const path = baseline.path
    const st = snapshotRecipe({ path, stat, readFile })
    if (baseline.exists) {
      if (!st.exists) {
        return { ok: false, reason: "conflict-reload", message: `${path} no longer exists — the edit-start snapshot is stale; reload` }
      }
      if (!st.readable) {
        return { ok: false, reason: "unreadable", message: `${path} cannot be decoded since the editor opened — refusing (never a lossy rewrite source); reload` }
      }
      if (baseline.raw !== null && st.raw !== baseline.raw) {
        return { ok: false, reason: "conflict-reload", message: `${path} changed since the editor opened — refusing to overwrite newer contents; reload` }
      }
      if (baseline.stat !== null && st.stat !== null) {
        const a = baseline.stat
        const b = st.stat
        if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) {
          return { ok: false, reason: "conflict-reload", message: `${path}'s identity changed since the editor opened — refusing; reload` }
        }
        if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined && (a.dev !== b.dev || a.ino !== b.ino)) {
          return { ok: false, reason: "conflict-reload", message: `${path} was deleted and recreated since the editor opened — refusing; reload` }
        }
      }
      return null
    }
    // Creation baseline: the file must STILL be absent.
    if (st.exists) {
      return { ok: false, reason: "conflict-reload", message: `${path} appeared since the editor opened — reload before creating` }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // commit — confirmed single-use atomic publish under the per-target lock
  // -------------------------------------------------------------------------

  const commit = async (input: CommitInput): Promise<CommitOutput> => {
    sweep()
    if (!onlyKeys(input, ["token", "confirm", "scope", "sessionID"])) {
      return { ok: false, reason: "malformed-request", message: "malformed commit request — unexpected top-level field(s) are refused" }
    }
    // Explicit human confirmation is handler-enforced, exactly true.
    if (input?.confirm !== true) {
      return { ok: false, reason: "confirm-required", message: "commit requires confirm === true — an unconfirmed preview is never written" }
    }
    const entry = typeof input?.token === "string" ? tokens.get(input.token) : undefined
    if (entry === undefined) {
      return { ok: false, reason: "token-unknown", message: "unknown preview token — an earlier attempt under this id cannot be confirmed (it may or may not have written); do not replay, prepare fresh against current content" }
    }
    // Refusal order: spent BEFORE expiry/epoch so a spent-then-expired
    // token answers "token-spent" (the receipt may exist) rather than an
    // expiry verdict that could read as denying an earlier WRITE. Every
    // refusal below guarantees only THIS attempt wrote nothing — it never
    // adjudicates an earlier attempt (that is what the receipt lookup is
    // for; found:false stays UNKNOWN).
    if (entry.spent) {
      return { ok: false, reason: "token-spent", message: "the token was already used — at most one write per token; look the receipt up by token instead of replaying" }
    }
    if (!epochLive(entry.epoch)) {
      tokens.delete(entry.token) // purge on touch
      return { ok: false, reason: "epoch-stale", message: "the server epoch or RPC registration generation changed — this attempt wrote nothing; any earlier attempt under this token is NOT adjudicated here (query the receipt; found:false = UNKNOWN)" }
    }
    const t = now()
    if (t > entry.expiresAt) {
      tokens.delete(entry.token)
      return { ok: false, reason: "token-expired", message: "the preview token expired — this attempt wrote nothing; any earlier attempt under this token is NOT adjudicated here (query the receipt; found:false = UNKNOWN). Run a fresh prepare (no auto-renewal)" }
    }
    const sessionID = asSessionID(input?.sessionID)
    // The client re-states the CURRENT scope/sessionID (the server cannot
    // observe the TUI router's session→home migration); both must match the
    // binding EXACTLY, null against null. No client identity is invented.
    // (The token is verified unspent above, so it truly never wrote.)
    if (sessionID === INVALID || input?.scope !== entry.binding.scope || input.sessionID !== entry.binding.sessionID) {
      return { ok: false, reason: "scope-mismatch", message: "stated scope/sessionID do not exactly match the token binding (null against null) — this attempt wrote nothing and the unspent token stays usable for the correct binding" }
    }
    // Early authoritative resolution for disclosure; the binding re-verify
    // runs AGAIN inside the lock (below) immediately before the write.
    const pre = resolveBinding(entry)
    if (pre !== null) return pre

    // ONE lock per actual target — withCommitLock keys on the folded path
    // only, so a global target reached from different locations shares the
    // same lock. The callback body is fully SYNCHRONOUS from verification
    // through publish: no await gap exists for a session.moved event (or
    // any other event) to slip through.
    return withCommitLock(entry.binding.path, (): CommitOutput => {
      // Re-verify EVERYTHING that could have drifted while awaiting the
      // lock. Order: spent → epoch → expiry → registered → scope →
      // freshness → write (spent first: a spent token must answer with its
      // receipt-pointer, never with a verdict that could read as denying
      // the earlier write; all refusals guarantee only THIS attempt).
      if (entry.spent) {
        return { ok: false, reason: "token-spent", message: "the token was used by a competing commit while this attempt waited — at most one write per token; look the receipt up by token" }
      }
      if (!epochLive(entry.epoch)) {
        tokens.delete(entry.token) // purge on touch
        return { ok: false, reason: "epoch-stale", message: "the server epoch or registration generation changed while the commit was pending — this attempt wrote nothing" }
      }
      const t2 = now()
      if (t2 > entry.expiresAt) {
        tokens.delete(entry.token)
        return { ok: false, reason: "token-expired", message: "the preview token expired while the commit was pending — this attempt wrote nothing (no auto-renewal)" }
      }
      // Still registered? The captured object may be a bounds-evicted
      // leftover (a newer prepare evicted it while this commit awaited the
      // lock) — a stale object must never reach the write.
      if (tokens.get(entry.token) !== entry) {
        return { ok: false, reason: "token-unknown", message: "the token is no longer registered (bounded-store eviction while the commit was pending) — its earlier outcome cannot be confirmed from here; re-prepare against current content" }
      }
      const inLockScope = resolveBinding(entry)
      if (inLockScope !== null) return inLockScope
      // In-lock baseline freshness (defense in depth — commitRecipeEdit
      // re-verifies again immediately before publish).
      const fresh = freshnessOf(baselineOfToken(entry))
      if (fresh !== null) {
        // The baseline is stale: spend the token (single-use holds) and
        // record a same-epoch receipt so a client that lost this response
        // can see the refusal instead of guessing from bytes.
        entry.spent = true
        const receipt = buildReceipt(entry, "conflict", fresh.message, { at: t2, savedIdentity: null, bytes: 0 })
        recordReceipt(receipt, entry.epoch, t2, null)
        return { ok: true, receipt }
      }
      // Pre-write baseline capture (deps.beforeCommit): the disk still holds
      // pre-write bytes here. A failed/oversized/non-object capture fails
      // the commit closed — no publish, receipt "write-failed", token
      // consumed (the attempt reached the write stage). Only written/no-op
      // receipts ever carry a context.
      let context: Record<string, unknown> | null = null
      if (deps.beforeCommit !== undefined) {
        let captureError: string | null = null
        try {
          const captured = deps.beforeCommit({
            scope: entry.binding.scope,
            sessionID: entry.binding.sessionID,
            path: entry.binding.path,
            binding: { path: entry.binding.path, observedLocation: entry.binding.observedLocation, anchor: entry.binding.anchor, targetIdentity: entry.binding.targetIdentity },
            newText: entry.newText,
          })
          if (captured === null || typeof captured !== "object" || Array.isArray(captured)) {
            captureError = "beforeCommit returned a non-object baseline"
          } else if (Buffer.byteLength(JSON.stringify(captured), "utf8") > maxContextBytes) {
            captureError = `beforeCommit baseline exceeds the bounded context size (${maxContextBytes} UTF-8 bytes)`
          } else {
            context = captured
          }
        } catch (err) {
          captureError = `beforeCommit failed: ${err instanceof Error ? err.message : String(err)}`
        }
        if (captureError !== null) {
          entry.spent = true
          const at0 = now()
          const receipt = buildReceipt(entry, "write-failed", `${captureError} — refusing before the publish`, { at: at0, savedIdentity: null, bytes: 0 })
          recordReceipt(receipt, entry.epoch, at0, null)
          return { ok: true, receipt }
        }
      }
      // Spend INSIDE the lock, after every verification, immediately before
      // the write: same-token commits all funnel into this same lock (the
      // binding — hence the path — is identical), so the spend is atomic
      // and exactly one caller can reach the publish.
      entry.spent = true

      // Sync ownership/anchor re-verification seam for the atomic kernel:
      // runs before the temp write AND again immediately before the
      // publish (commitRecipeEdit's recheckOwnership). Sync by contract —
      // the resolver runs inline; any throw fails closed.
      const recheckOwnership = (): boolean => {
        try {
          const r = deps.resolver({ scope: entry.binding.scope, sessionID: entry.binding.sessionID })
          if (!r.ok) return false
          if (r.target.path !== entry.binding.path || r.target.observedLocation !== entry.binding.observedLocation || r.target.anchor !== entry.binding.anchor) return false
          // Creation eligibility again at the last possible moment (this runs
          // before the temp write AND immediately before the publish).
          if (entry.createFile && r.target.creatable !== true) return false
          if (deps.reverify !== undefined && !deps.reverify({ scope: entry.binding.scope, sessionID: entry.binding.sessionID, path: entry.binding.path, observedLocation: entry.binding.observedLocation, anchor: entry.binding.anchor })) return false
          return true
        } catch {
          return false
        }
      }

      let result: { ok: true; outcome: "written" | "no-op"; bytes: number } | { ok: false; reason: CommitErrReason; message: string }
      try {
        result = commitRecipeEdit(
          baselineSnapshotFor(entry),
          { kind: entry.writeKind, path: entry.binding.path, newText: entry.newText },
          {
            stat: fs.stat,
            readFile: fs.readFile,
            writeFile: fs.writeFile,
            rename: fs.rename,
            link: fs.link,
            unlink: fs.unlink,
            mkdir: fs.mkdir,
            recheckOwnership,
          },
        )
      } catch (err) {
        result = { ok: false, reason: "write-failed", message: `write failed: ${err instanceof Error ? err.message : String(err)}` }
      }

      const at = now()
      if (!result.ok) {
        // Refusal verdicts (conflict / ownership-lost / write-failed / missing
        // / unreadable / unparseable): the token is consumed (single-use
        // holds even for failures — no revival), and the receipt records the
        // refusal so an ambiguous outcome resolves by lookup, never by bytes.
        const receipt = buildReceipt(entry, result.reason, result.message, { at, savedIdentity: null, bytes: 0 })
        recordReceipt(receipt, entry.epoch, at, null) // refusals never carry a baseline
        return { ok: true, receipt }
      }
      if (result.outcome === "written") {
        // Real receipt bytes: the kernel's `bytes` counts UTF-16 chars —
        // the receipt reports the true UTF-8 byte length plus the
        // post-publish stat identity.
        const post = postWriteIdentity(entry.binding.path)
        const receipt = buildReceipt(
          entry,
          "written",
          post.unsafe ? "saved — the write succeeded, but the post-write identity could not be sampled losslessly (unsafe identity; receipt carries no saved identity)" : "saved",
          { at, savedIdentity: post.identity, bytes: Buffer.byteLength(entry.newText, "utf8") },
        )
        recordReceipt(receipt, entry.epoch, at, context)
        return { ok: true, receipt }
      }
      const post = postWriteIdentity(entry.binding.path)
      const receipt = buildReceipt(
        entry,
        "no-op",
        post.unsafe ? "no changes — nothing written — the post-write identity could not be sampled losslessly (unsafe identity; receipt carries no saved identity)" : "no changes — nothing written",
        { at, savedIdentity: post.identity, bytes: 0 },
      )
      recordReceipt(receipt, entry.epoch, at, context)
      return { ok: true, receipt }
    })
  }

  // Early/in-lock authoritative binding re-resolution. Returns a refusal
  // CommitOutput when the target no longer resolves under the binding;
  // null when it does. SYNC (resolver contract) — safe inside the lock.
  function resolveBinding(entry: TokenEntry): CommitOutput | null {
    let r: ReturnType<ScopeResolver>
    try {
      r = deps.resolver({ scope: entry.binding.scope, sessionID: entry.binding.sessionID })
    } catch (err) {
      return { ok: false, reason: "scope-unresolved", message: `authoritative resolution failed: ${err instanceof Error ? err.message : String(err)} — nothing was written` }
    }
    if (!r.ok) return { ok: false, reason: "scope-unresolved", message: r.message }
    if (r.target.path !== entry.binding.path || r.target.observedLocation !== entry.binding.observedLocation || r.target.anchor !== entry.binding.anchor) {
      return { ok: false, reason: "scope-mismatch", message: "the target no longer resolves under the token binding (owner, path or observed location changed) — nothing was written" }
    }
    // Creation eligibility is re-checked at EVERY resolution, including in
    // the commit lock immediately before the write: a resolver that revokes
    // `creatable` between prepare and commit must stop the first-creation
    // write, not just the prepare.
    if (entry.createFile && r.target.creatable !== true) {
      return { ok: false, reason: "scope-unresolved", message: "the server no longer anchors a creation at the bound target — nothing was written" }
    }
    return null
  }

  // Baseline views (see the Baseline type): a snapshot handle projects its
  // RecipeSnapshot; a token projects its OWN bound copy (raw + identity +
  // createFile), so a bounds-evicted handle cannot replace or revive it.
  function baselineOf(snap: RecipeSnapshot): Baseline {
    return { path: snap.path, exists: snap.exists, readable: snap.readable, raw: snap.raw, stat: snap.stat }
  }

  function baselineOfToken(entry: TokenEntry): Baseline {
    return { path: entry.binding.path, exists: !entry.createFile, readable: !entry.createFile, raw: entry.raw, stat: entry.identity }
  }

  // The immovable baseline for the atomic kernel: the edit-start bytes and
  // identity exactly as bound into the token at prepare (read once at
  // editor open, never replaced, never re-read). The live snapshot entry is
  // deliberately NOT consulted here — the token's bound copy is the single
  // source of truth, so bounds eviction cannot swap or revive a baseline.
  function baselineSnapshotFor(entry: TokenEntry): RecipeSnapshot {
    return {
      path: entry.binding.path,
      exists: !entry.createFile,
      readable: !entry.createFile,
      raw: entry.raw,
      stat: entry.identity,
      parse: entry.raw !== null ? parseOf(entry.raw) : null,
    }
  }

  function statOf(path: string): FileIdentity | null {
    try {
      const st = fs.stat !== undefined ? fs.stat(path) : snapshotRecipe({ path }).stat
      return st === null ? null : normalizeFileIdentity(st)
    } catch (err) {
      // Only a FAILED STAT is "no identity"; an unsafe identity must not be
      // swallowed into a null savedIdentity (a written file would be
      // misreported as identity-less) — it refuses loudly instead.
      if (isUnsafeIdentityError(err)) throw err
      return null
    }
  }

  // Post-write receipt identity. The kernel verdict (written/no-op) is
  // already final at this point: an UNSAFE post-write identity must not
  // erase the true outcome by throwing before the receipt is recorded (the
  // receipt lookup would then report UNKNOWN for a file that WAS written).
  // The real outcome stands with savedIdentity null and an explicit
  // receipt message; pre-write unsafe identities still refuse upstream.
  function postWriteIdentity(path: string): { identity: FileIdentity | null; unsafe: boolean } {
    try {
      return { identity: statOf(path), unsafe: false }
    } catch (err) {
      if (!isUnsafeIdentityError(err)) throw err
      return { identity: null, unsafe: true }
    }
  }

  function buildReceipt(
    entry: TokenEntry,
    outcome: CommitReceipt["outcome"],
    message: string,
    extra: { at: number; savedIdentity: FileIdentity | null; bytes: number },
  ): CommitReceipt {
    const cur = epochNow()
    const entries: CommitEntryOutcome[] = [
      ...entry.entries.map((e): CommitEntryOutcome => {
        const reasonField =
          outcome === "written" || outcome === "no-op"
            ? undefined
            // Refused commit: no entry landed (validator-rejected entries
            // share the outcome slot with entries the refusal stopped).
            : outcome
        return {
          opId: e.opId,
          id: e.id,
          kind: e.kind,
          action: e.action,
          entryKind: e.entryKind,
          outcome:
            outcome === "written"
              ? e.entryKind === "no-op" ? "no-op" : "written"
              : outcome === "no-op"
                ? "no-op"
                : "rejected",
          // An absent reason stays ABSENT (no `reason: undefined` key — the
          // receipt must match its schema exactly, not just post-JSON).
          ...(reasonField !== undefined ? { reason: reasonField } : {}),
          summary: e.summary,
          findings: e.findings,
        }
      }),
      ...entry.rejected.map((r): CommitEntryOutcome => ({
        opId: r.opId,
        id: r.id,
        kind: r.kind,
        action: r.action,
        entryKind: "no-op",
        outcome: "rejected",
        reason: r.reason,
        summary: [],
        findings: r.findings,
      })),
    ]
    return {
      commitId: randomId(),
      token: entry.token,
      outcome,
      message,
      path: entry.binding.path,
      targetIdentity: entry.binding.targetIdentity,
      scope: entry.binding.scope,
      sessionID: entry.binding.sessionID,
      savedIdentity: extra.savedIdentity,
      bytes: extra.bytes,
      entries,
      epoch: cur.epoch,
      generation: cur.generation,
      at: extra.at,
      sync: null,
    }
  }

  function recordReceipt(receipt: CommitReceipt, epoch: ConfigRpcEpoch, at: number, context: Record<string, unknown> | null): void {
    const store: ReceiptStoreEntry = { receipt, epoch: { ...epoch }, createdAt: at, expiresAt: at + ttl.receipt, context }
    insertBounded(receipts, receipt.token, store, limits.receipts)
  }

  // -------------------------------------------------------------------------
  // receipt — same-epoch lookup by token (ambiguous-outcome resolution)
  // -------------------------------------------------------------------------

  const receipt = (input: ReceiptInput): ReceiptOutput => {
    sweep()
    if (!onlyKeys(input, ["token"])) {
      // A malformed query changes no state; found:false is the honest
      // "nothing confirmable from this request" answer for a pure read.
      const cur0 = epochNow()
      return { found: false, epoch: cur0.epoch, generation: cur0.generation }
    }
    const cur = epochNow()
    const hit = typeof input?.token === "string" ? receipts.get(input.token) : undefined
    if (hit === undefined || hit.epoch.epoch !== cur.epoch || hit.epoch.generation !== cur.generation) {
      // UNKNOWN: a missing receipt never means "not written" — current bytes
      // never adjudicate an old commit. The client re-prepares against
      // current content and re-confirms; it never replays.
      return { found: false, epoch: cur.epoch, generation: cur.generation }
    }
    return { found: true, receipt: hit.receipt, epoch: cur.epoch, generation: cur.generation }
  }

  // Sync-outcome annotation for the server sync handlers: attaches the
  // family-sync result to the saved receipt WITHOUT reviving anything — a
  // failed sync after a successful save keeps the saved receipt and the
  // token stays consumed. Returns false when the receipt is unknown/gone.
  const attachSyncOutcome = (commitId: string, sync: Record<string, unknown>): boolean => {
    sweep()
    for (const entry of receipts.values()) {
      if (entry.receipt.commitId === commitId) {
        entry.receipt.sync = sync
        return true
      }
    }
    return false
  }

  // The pre-write host baseline for a commit, looked up by receipt.commitId.
  // Only SAME-EPOCH, UNEXPIRED receipts with a "written"/"no-op" verdict AND
  // an actually-captured context resolve; everything else is found:false —
  // the sync handlers must refuse on it (never reconstruct a "before" after
  // the write). No registry, no persistence: bounds eviction or an epoch
  // rotation honestly loses the baseline.
  const getCommitContext = (commitId: string): CommitContextLookup => {
    sweep()
    const cur = epochNow()
    if (typeof commitId !== "string" || commitId.length === 0) {
      return { found: false, epoch: cur.epoch, generation: cur.generation }
    }
    for (const entry of receipts.values()) {
      if (entry.receipt.commitId !== commitId) continue
      if (entry.epoch.epoch !== cur.epoch || entry.epoch.generation !== cur.generation) break
      if (entry.receipt.outcome !== "written" && entry.receipt.outcome !== "no-op") break
      if (entry.context === null) break
      return { found: true, context: entry.context, commitId, token: entry.receipt.token, epoch: cur.epoch, generation: cur.generation }
    }
    return { found: false, epoch: cur.epoch, generation: cur.generation }
  }

  const handlers = (plugin: { pluginID: string; appVersion: string }) => ({
    echo: (input: EchoInput) => echo(input, plugin),
    editOpen: (input: EditOpenInput) => editOpen(input),
    prepare: (input: PrepareInput) => prepare(input),
    commit: (input: CommitInput) => commit(input),
    receipt: (input: ReceiptInput) => receipt(input),
  })

  return {
    echo,
    editOpen,
    prepare,
    commit,
    receipt,
    handlers,
    attachSyncOutcome,
    getCommitContext,
    sweep,
    size: () => ({ snapshots: snapshots.size, tokens: tokens.size, receipts: receipts.size }),
    rotateEpoch: (next: ConfigRpcEpoch): void => {
      epochOverride = { ...next }
    },
  }
}

export type ConfigRpcStore = ReturnType<typeof createConfigRpcStore>
