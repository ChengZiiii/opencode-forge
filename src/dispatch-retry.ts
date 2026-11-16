// Dispatch retry core (dispatch-resilience fold C): the child-terminal
// error classifier + the resume preamble + the attempt/backoff knobs.
//
// Pure logic, no @opencode-ai imports. Provenance: the pattern tables are
// ported from omo (oh-my-openagent,
// packages/omo-opencode/src/features/background-agent/error-classifier.ts) —
// TRANSPORT_UNREACHABLE_PATTERNS and TERMINAL_SESSION_ERROR_PATTERNS are
// reproduced VERBATIM below (marked), extended with the fold C vocabulary
// (5xx/429 codes, overload/rate-limit text, auth/contract classes).
//
// Classification policy (design decision 3): omo deliberately classifies
// provider-config errors as TERMINAL, never retryable — a broken config
// re-spawned is still broken. Anything unrecognized is DETERMINISTIC
// (fail-closed: never retried). Deterministic patterns win over retryable
// ones when both match.

export type DispatchErrorClass = "retryable" | "deterministic"

/**
 * RETRYABLE — transient transport patterns. The first nine are omo's
 * TRANSPORT_UNREACHABLE_PATTERNS verbatim (error-classifier.ts:9-19).
 */
const RETRYABLE_ERROR_PATTERNS: readonly RegExp[] = [
  // --- omo TRANSPORT_UNREACHABLE_PATTERNS (verbatim) ---
  /unable to connect/i,
  /econnrefused/i,
  /econnreset/i,
  /enotfound/i,
  /socket hang up/i,
  /fetch failed/i,
  /network(?:\s|_)?error/i,
  /not connected/i,
  /connection (?:closed|refused|reset)/i,
  // --- transient transport extras (fold C vocabulary) ---
  /etimedout/i,
  /timed?\s?-?out/i,
  /timeout/i,
  // --- overload / rate limit ---
  /overloaded/i,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  // --- 5xx text forms ---
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  // --- bare status codes in text (e.g. "APIError 503: ...") ---
  /\b(?:429|500|502|503|504)\b/,
]

const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504])

/**
 * DETERMINISTIC — provider-configuration / auth / model-not-supported /
 * contract patterns. The first twelve are omo's TERMINAL_SESSION_ERROR_PATTERNS
 * verbatim (error-classifier.ts:147-161) — omo's comment: "Terminal session
 * errors that mean a background subagent will NEVER produce output,
 * regardless of how long we wait... Kept deliberately narrow: transient
 * patterns (503, timeout, 'try again', 'temporarily unavailable', rate
 * limits) are NOT here."
 */
const DETERMINISTIC_ERROR_PATTERNS: readonly RegExp[] = [
  // --- omo TERMINAL_SESSION_ERROR_PATTERNS (verbatim) ---
  /no provider available/i,
  /provider not (?:available|found|configured)/i,
  /provider is forbidden/i,
  /selected provider is forbidden/i,
  /unknown provider/i,
  /model not supported/i,
  /model_not_supported/i,
  /model[_\s-]*not[_\s-]*found/i,
  /(?:no|missing)[_\s-]*(?:api|auth(?:entication)?)[_\s-]*key/i,
  /(?:api|auth(?:entication)?)[_\s-]*key(?:[_\s-]+is)?[_\s-]*(?:missing|not[_\s-]*(?:found|configured)|required)/i,
  /no models available/i,
  /no connected providers/i,
  /all providers (?:are )?(?:unavailable|disconnected|exhausted)/i,
  // --- auth (fold C vocabulary: unauthorized / 401 / 403) ---
  /unauthorized/i,
  /forbidden/i,
  // --- API-contract errors (400 invalid-request class) ---
  /invalid[\s_-]*(?:request|argument|parameter)/i,
  /bad request/i,
  // --- bare status codes in text ---
  /\b(?:400|401|403)\b/,
]

const DETERMINISTIC_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 409, 422])

/**
 * Text extraction for classification: the poller feeds the describeError
 * STRING ("Name: message"), but object errors (statusCode/status/code keys,
 * nested data.message) classify too. Ported from omo's extractErrorMessage /
 * extractErrorStatusCode (error-classifier.ts:50-107), simplified to the
 * shapes this plugin produces.
 */
function classifyText(error: unknown): string {
  if (typeof error === "string") return error
  if (!error) return ""
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === "object") {
    const rec = error as Record<string, unknown>
    const parts: string[] = []
    if (typeof rec.name === "string") parts.push(rec.name)
    const data = rec.data
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>
      if (typeof d.message === "string") parts.push(d.message)
      if (typeof d.error === "string") parts.push(d.error)
    }
    if (typeof rec.message === "string") parts.push(rec.message)
    if (parts.length > 0) return parts.join(": ")
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/** Numeric status extraction (omo extractErrorStatusCode port): statusCode/status/code keys, string forms, response.status. */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const rec = error as Record<string, unknown>
  for (const key of ["statusCode", "status", "code"]) {
    const val = rec[key]
    if (typeof val === "number" && val >= 100 && val < 600) return val
    if (typeof val === "string" && /^\d{3}$/.test(val)) return Number(val)
  }
  const response = rec.response
  if (response && typeof response === "object") {
    const respStatus = (response as Record<string, unknown>).status
    if (typeof respStatus === "number" && respStatus >= 100 && respStatus < 600) return respStatus
    if (typeof respStatus === "string" && /^\d{3}$/.test(respStatus)) return Number(respStatus)
  }
  return undefined
}

/**
 * Classify a child-terminal error. DETERMINISTIC patterns/codes are checked
 * FIRST (fail-closed: a possibly-config error is never re-spawned); then
 * retryable; anything unrecognized → "deterministic" (never retried).
 */
export function classifyDispatchError(err: unknown): DispatchErrorClass {
  const text = classifyText(err)
  if (DETERMINISTIC_ERROR_PATTERNS.some((p) => p.test(text))) return "deterministic"
  const status = extractStatusCode(err)
  if (status !== undefined && DETERMINISTIC_STATUS_CODES.has(status)) return "deterministic"
  if (RETRYABLE_ERROR_PATTERNS.some((p) => p.test(text))) return "retryable"
  if (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) return "retryable"
  return "deterministic"
}

/**
 * The resume preamble prepended to the ORIGINAL prompt on every retry: the
 * fresh child shares the workspace with the dead attempt, so it must inspect
 * what already happened and CONTINUE rather than redo.
 */
export const RESUME_PREAMBLE =
  "Note: a previous attempt at this task may have partially completed the work. Before acting, inspect the current workspace state (files, git status) to see what is already done, then CONTINUE the work — do not redo what is already done."

/** Retry prompt = preamble (prepended, clearly separated) + the original task. */
export function buildRetryPrompt(originalPrompt: string): string {
  return `${RESUME_PREAMBLE}\n\n--- Original task ---\n${originalPrompt}`
}

/** Default total attempts per dispatch (2 = 1 original + 1 retry). */
export const DEFAULT_MAX_ATTEMPTS = 2

/** Upper sanity bound for FORGE_DISPATCH_MAX_ATTEMPTS. */
export const MAX_ATTEMPTS_CEILING = 10

/** Resolve FORGE_DISPATCH_MAX_ATTEMPTS (default 2; invalid → default). */
export function resolveMaxAttempts(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_MAX_ATTEMPTS
  if (raw === undefined || raw === "") return DEFAULT_MAX_ATTEMPTS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ATTEMPTS
  return Math.min(Math.round(parsed), MAX_ATTEMPTS_CEILING)
}

/** Fixed backoff between attempts (spec: 10 s). */
export const RETRY_BACKOFF_MS = 10_000

/**
 * Backoff test seam: FORGE_DISPATCH_RETRY_BACKOFF_MS overrides the fixed
 * 10 s for tests only (production semantics are the fixed default).
 */
export function resolveRetryBackoffMs(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_RETRY_BACKOFF_MS
  if (raw === undefined || raw === "") return RETRY_BACKOFF_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return RETRY_BACKOFF_MS
  return Math.round(parsed)
}
