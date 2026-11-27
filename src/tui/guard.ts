// Enablement + RPC provability mapping (revised server-RPC contract).
//
// Thin mapping onto the safety core in src/host-guard.ts for the SERVER
// FORGE ROW check (static import — bundled into dist; the core owns the
// POLICY, this module maps shapes), plus the RPC transport provability
// verdict (echo nonce round-trip + epoch/generation comparison — the
// client-instance discipline of design D7).
//
// Fail-closed: an absent/failed/unverifiable server Forge row, an
// unprovable echo, or an epoch/generation mismatch refuses every write and
// sync, including retries. The deprecated TUI-side same-host gate and
// nonce channel are GONE (probe-proven unsatisfiable; superseded by the
// server adjudication — see design D2/D7).

import { forgeServerEnablement, writesPermitted, type ForgeServerEnablement } from "../host-guard.ts"
import type { EchoOutput } from "../../rpc.ts"
import type { PluginRow } from "./contracts.ts"

export function enablementOf(rows: unknown, forgeId: string): ForgeServerEnablement {
  return forgeServerEnablement(rows, forgeId)
}

export function writesPermittedOf(enablement: ForgeServerEnablement): boolean {
  try {
    return writesPermitted(enablement) === true
  } catch {
    return false // core contract drift must fail closed, never open
  }
}

// ---------------------------------------------------------------------------
// Echo verdict (transport provability + epoch observation, D7)
// ---------------------------------------------------------------------------

export type EchoVerdict =
  | {
      provable: true
      // The server epoch/registration generation observed NOW — compared
      // against the binding recorded at editOpen/prepare time. A change
      // refuses every in-flight token (server-provable invalidation).
      epoch: string
      generation: number
      pluginID: string
      appVersion: string
    }
  | { provable: false; reason: string }

// Validates the echo answer: nonce round-trip must match EXACTLY, and the
// payload must carry the epoch/generation binding. `expected` (the binding
// recorded when the editor session / preview token was issued) turns the
// verdict into an epoch check: any mismatch is a stale-epoch refusal.
export function echoVerdictOf(nonce: string, out: unknown, expected?: { epoch: string; generation: number }): EchoVerdict {
  if (out === null || typeof out !== "object") return { provable: false, reason: "echo returned no payload" }
  const rec = out as Record<string, unknown>
  if (rec.nonce !== nonce) return { provable: false, reason: "echo nonce mismatch — the transport answer is not from this request" }
  if (typeof rec.pluginID !== "string" || rec.pluginID === "") return { provable: false, reason: "echo payload carries no pluginID" }
  if (typeof rec.epoch !== "string" || rec.epoch === "" || typeof rec.generation !== "number" || !Number.isFinite(rec.generation)) {
    return { provable: false, reason: "echo payload carries no epoch/generation binding" }
  }
  if (expected !== undefined && (rec.epoch !== expected.epoch || rec.generation !== expected.generation)) {
    return {
      provable: false,
      reason: `server epoch/registration changed since this editor session opened (was ${expected.epoch}#${expected.generation}, now ${rec.epoch}#${rec.generation}) — in-flight previews are dropped and a fresh editor session is required`,
    }
  }
  return { provable: true, epoch: rec.epoch, generation: rec.generation, pluginID: rec.pluginID, appVersion: typeof rec.appVersion === "string" ? rec.appVersion : "unknown" }
}

// ---------------------------------------------------------------------------
// Safe error disclosure (change forge-tui-subagent-config, diagnosis branch)
// ---------------------------------------------------------------------------

// The real SDK may reject with PLAIN objects (not Error instances); the
// previous `err instanceof Error ? err.message : String(err)` rendered
// "[object Object]" and hid every useful field. This serializer is a
// WHITELIST reader, never a dump: only the `message` / `code` / `type` /
// `_tag` scalar fields are disclosed (type is an SDK candidate field per
// the real-SDK signature check); an unknown object yields a FIXED sentence
// (the object may carry request/token data that must never reach a toast).
// Every disclosed value is sensitive-fragment masked and length-bounded;
// fields are read one at a time under try/catch so throwing getters and
// cyclic structures cannot throw here. Fail-closed transport behavior is
// untouched — this only changes what a disclosure CAN contain.

const SAFE_ERROR_TEXT_LIMIT = 200

// Masks the credential shapes that show up in echoed request errors
// (Authorization/Bearer/Basic headers, token/key assignments, raw JWTs)
// BEFORE bounding — a secret split by truncation must not leak its head.
// NO word-shape guessing and NO length/word-form exemption: an
// Authorization header's COMPLETE value (any scheme, any case, any length)
// is masked to the end of its line, and a standalone Basic/Bearer
// credential is masked conservatively ("basic attention" loses the next
// word too — conservatively over-masking prose is the accepted cost).
function maskSecrets(text: string): string {
  return text
    .replace(/(authorization\s*[=:]\s*)[^\n]*/gi, "$1[masked]")
    .replace(/\b(basic|bearer|token)(\s+)\S+/gi, "$1$2[masked]")
    .replace(/(token|api[-_]?key|secret|password|credential)(\s*[=:]\s*)\S+/gi, "$1$2[masked]")
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, "[masked-jwt]")
}

function disclosedText(value: unknown): string | undefined {
  let text: string | undefined
  if (typeof value === "string") text = value
  else if (typeof value === "number" || typeof value === "bigint") text = String(value)
  else return undefined
  const masked = maskSecrets(text)
  return masked.length > SAFE_ERROR_TEXT_LIMIT ? `${masked.slice(0, SAFE_ERROR_TEXT_LIMIT)}…` : masked
}

function readField(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key]
  } catch {
    return undefined // a throwing getter is not disclosure material
  }
}

// Final whole-disclosure bound (applied AFTER identity+message merge —
// per-field bounding alone would let three fields stack into 600 chars).
function boundedOnce(text: string): string {
  return text.length > SAFE_ERROR_TEXT_LIMIT ? `${text.slice(0, SAFE_ERROR_TEXT_LIMIT)}…` : text
}

export function safeErrorText(err: unknown): string {
  if (typeof err === "string") {
    const masked = maskSecrets(err)
    return masked.length > SAFE_ERROR_TEXT_LIMIT ? `${masked.slice(0, SAFE_ERROR_TEXT_LIMIT)}…` : masked
  }
  if (err === null || err === undefined || typeof err !== "object") {
    return disclosedText(err) ?? "no error detail was provided"
  }
  // ONE object path for Errors and plain rejections alike: instanceof can
  // be fooled by cross-realm/Proxy lookalikes, and .message/.name may be
  // getter traps — every field is read through readField, so nothing here
  // throws. The identity pair (code/type/_tag) is COMBINED with the
  // message (a message-only early return would drop the identity the
  // counter-examples assert), and the whole disclosure is bounded once.
  const message = disclosedText(readField(err, "message"))
  const parts: string[] = []
  const code = disclosedText(readField(err, "code"))
  if (code !== undefined && code !== "") parts.push(`code ${code}`)
  const type = disclosedText(readField(err, "type"))
  if (type !== undefined && type !== "") parts.push(`type ${type}`)
  const tag = disclosedText(readField(err, "_tag"))
  if (tag !== undefined && tag !== "") parts.push(`tag ${tag}`)
  let out: string
  if (message !== undefined && message !== "") {
    out = parts.length > 0 ? `${parts.join(", ")}: ${message}` : message
  } else if (parts.length > 0) {
    out = parts.join(", ")
  } else {
    // Whitelist exhausted (no message/code/type/_tag): the FIXED sentence
    // only — no name reading, no dump (the object may carry request/token
    // data).
    out = "an unrecognized error object was received (no disclosable message/code) — see the server-side Forge log for the actual failure"
  }
  return boundedOnce(out)
}

// ---------------------------------------------------------------------------
// Startup-scope anchorability (shared predicate — tui.ts wiring and flow
// re-verification must agree on the SAME legality rule)
// ---------------------------------------------------------------------------

// The ONLY legal startup scopes: home with a null sessionID, or a session
// with a non-blank sessionID — either way with a NON-BLANK directory anchor
// (trim-checked; the original route path is never rewritten). Safe against
// null/undefined/partial shapes (a wired caller may pass garbage — the
// verdict is false, never a throw).
export function anchorableStartupScope(
  scope: { kind?: string; sessionID?: string | null; anchor?: string | null } | null | undefined,
): boolean {
  if (scope === null || scope === undefined) return false
  if (scope.kind !== "home" && scope.kind !== "session") return false
  if (scope.kind === "home") {
    if (scope.sessionID !== null) return false
  } else {
    if (typeof scope.sessionID !== "string" || scope.sessionID.trim() === "") return false
  }
  return typeof scope.anchor === "string" && scope.anchor.trim() !== ""
}
