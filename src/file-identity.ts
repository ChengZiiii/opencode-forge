// Lossless file-identity sampling shared by the edit kernel and the RPC
// host. Every identity sample takes exactly ONE bigint stat:
//
// - dev/ino are carried as canonical decimal STRINGS. Real inodes exceed
//   the safe-integer range (Windows: ino 72902018970278429; Number()
//   silently rounds it to 72902018970278432 — a loss that later refuses
//   the identity as non-integer on the RPC wire), so the string is the
//   only honest representation. Canonical decimal strings compare
//   numerically under strict equality (no appearance aliasing).
// - mtimeMs is DERIVED from the same sample by splitting seconds and
//   nanoseconds — the whole nanosecond count itself exceeds 2^53 and must
//   never be Number()-converted as a whole:
//
//     mtimeMs = Number(mtimeNs / 1e9n) * 1000 + Number(mtimeNs % 1e9n) / 1e6
//
//   Both sides of a snapshot→commit pair sample through THIS helper, so an
//   unchanged file yields the identical double on both sides and the
//   existing fractional `!==` comparison stays exact. (The truncating
//   BigIntStats.mtimeMs shortcut would drop the sub-millisecond decimals
//   and manufacture post-lstat false conflicts — never used.)
//
// No @opencode-ai imports; the type stays protocol-clean and the sampler
// is injectable through each caller's existing stat seams.

import { statSync } from "node:fs"

// Canonical identity shape: what the kernel, the RPC wire schema
// (dev/ino as JSON-schema strings) and the TUI disclosure all carry.
export type FileIdentity = { mtimeMs: number; size: number; dev?: string; ino?: string }

// Seam input: injected fs doubles and test seams may still hand over
// safe numbers. Everything is normalized to the canonical string form at
// the seam entry, so downstream comparisons only ever see one shape.
export type FileIdentityInput = { mtimeMs: number; size: number; dev?: string | number; ino?: string | number }

// Refusal for an identity that cannot be represented losslessly. It is
// thrown OUTSIDE every stat catch: an unsafe identity must refuse the
// operation loudly — it is never disguised as "file absent" (null) and
// never precision-repaired via String(unsafeNumber).
export class UnsafeIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeIdentityError"
  }
}

export function isUnsafeIdentityError(err: unknown): err is UnsafeIdentityError {
  return err instanceof UnsafeIdentityError
}

// Canonical non-negative decimal integer: "0" or no leading zero.
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/

function canonicalIdComponent(value: string | number | undefined, label: "dev" | "ino"): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number") {
    // NaN/±Infinity/out-of-safe-range refuse explicitly: a failed number
    // conversion must not silently become "component absent" (which would
    // downgrade the swap guard) and must never be String()-repaired.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UnsafeIdentityError(`${label} ${String(value)} is not a non-negative safe integer — refusing the identity`)
    }
    return String(value)
  }
  if (typeof value !== "string") {
    // Runtime non-string/non-number (a loose seam's bigint, an object):
    // refuse explicitly — the digit regexes below would coerce it and let
    // a non-string reach the canonical wire shape.
    throw new UnsafeIdentityError(`${label} must be a non-negative decimal string or a safe integer, got ${typeof value} — refusing the identity`)
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new UnsafeIdentityError(`${label} must be a non-negative decimal string, got ${JSON.stringify(value)}`)
  }
  // Digit strings of any appearance canonicalize losslessly via BigInt
  // ("007" and "7" are numerically the same id — equality is numeric,
  // never spelling).
  if (!CANONICAL_DECIMAL.test(value)) return BigInt(value).toString()
  return value
}

// Normalize one seam input to the canonical identity. Numbers must be
// non-negative safe integers, strings must be decimal digits — anything
// else throws (fail closed, never coerced to absent).
export function normalizeFileIdentity(id: FileIdentityInput): FileIdentity {
  if (typeof id.mtimeMs !== "number" || !Number.isFinite(id.mtimeMs)) {
    throw new UnsafeIdentityError(`mtimeMs ${String(id.mtimeMs)} is not a finite number — refusing the identity`)
  }
  if (typeof id.size !== "number" || !Number.isSafeInteger(id.size) || id.size < 0) {
    throw new UnsafeIdentityError(`size ${String(id.size)} is not a non-negative safe integer — refusing the identity`)
  }
  return {
    mtimeMs: id.mtimeMs,
    size: id.size,
    dev: canonicalIdComponent(id.dev, "dev"),
    ino: canonicalIdComponent(id.ino, "ino"),
  }
}

// Exact conversion of a non-negative bigint that must cross a number seam
// (size, nlink): silent Number() of an oversized value would round and
// then compare unequal — refuse instead.
export function safeBigintNumber(value: bigint, label: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new UnsafeIdentityError(`${label} ${value.toString()} is not a non-negative safe integer — refusing the identity`)
  }
  return n
}

// Convert ONE BigIntStats sample — the only raw material of an identity.
export function identityFromBigintStats(st: { mtimeNs: bigint; size: bigint; dev: bigint; ino: bigint }): FileIdentity {
  const mtimeNs = st.mtimeNs
  const seconds = mtimeNs / 1_000_000_000n
  const nanos = mtimeNs % 1_000_000_000n
  // Seconds (< 2^53 for any real timestamp) and the sub-millisecond
  // remainder convert independently and exactly; the fractional decimals
  // survive into the derived double.
  return normalizeFileIdentity({
    mtimeMs: Number(seconds) * 1000 + Number(nanos) / 1e6,
    size: safeBigintNumber(st.size, "size"),
    dev: st.dev.toString(),
    ino: st.ino.toString(),
  })
}

// The single default sampler behind every identity reading path (edit
// kernel defaults and the RPC host adapter): one bigint stat, one sample.
// Stat failures (ENOENT and friends) return null; an identity that DID
// sample but cannot be represented losslessly throws from OUTSIDE the
// catch — never null, never rounded.
export function defaultIdentityStat(path: string): FileIdentity | null {
  let st
  try {
    st = statSync(path, { bigint: true })
  } catch {
    return null
  }
  return identityFromBigintStats(st)
}

// Snapshot→commit identity comparison (unchanged semantics over the new
// representation): mtimeMs/size must match — both sides were sampled by
// the unified bigint helper, so the derived fractional decimals agree;
// when BOTH sides carry dev/ino, a device/inode change refuses even at
// equal mtime/size (an external delete+recreate swap). Canonical decimal
// strings make strict equality numeric equality.
export function identityMatches(a: FileIdentity, b: FileIdentity): boolean {
  if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) return false
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined && (a.dev !== b.dev || a.ino !== b.ino)) return false
  return true
}
