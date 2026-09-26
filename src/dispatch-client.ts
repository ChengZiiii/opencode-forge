// Pure client-side logic for the forge dispatch suite: completion detection
// for polled child sessions, token aggregation, and self-computed cost
// (spec: dispatch — forge_dispatch tool contract, cost reporting; design
// D1/D5). The host layer (plugin.ts) owns fetch/client I/O; these functions
// are pure so the exact code that decides "is the worker done" and "what did
// it cost" is unit-testable without a server.
//
// Completion detection is stability-based polling: the driver records
// { messageCount, lastAssistantText } snapshots; a session counts as complete
// when the count is non-zero and both fields stay identical across
// CONSECUTIVE_STABLE_POLLS polls. A session whose count grows but whose text
// stays empty is reported as "empty" — the known keyless-Zen quirk (any
// toolset reduction yields a 0-token, parts-less assistant message) — and
// must surface as an honest error, never as a successful empty result.
//
// Cost follows opencode's own formula: reasoning tokens are billed as
// output; cache read/write at their snapshot prices. Everything is USD per
// million tokens (models.dev shape). A missing price is reported as null
// with a note — never approximated, never 0.

export const CONSECUTIVE_STABLE_POLLS = 2

export type PollSample = { count: number; text: string }

export type PollState = {
  stablePolls: number
  verdict: "waiting" | "complete" | "empty"
  last?: PollSample
}

export function completionVerdict(prev: PollState | null, cur: PollSample): PollState {
  if (!prev) {
    // Baseline poll: record and wait (stablePolls counts consecutive
    // unchanged transitions after the baseline).
    return { stablePolls: 0, verdict: "waiting", last: { ...cur } }
  }
  const unchanged = cur.count === prev.last!.count && cur.text === prev.last!.text
  const stablePolls = unchanged ? prev.stablePolls + 1 : 0
  if (stablePolls >= CONSECUTIVE_STABLE_POLLS && cur.count > 0) {
    // Empty final text with messages present is the keyless-Zen dead-session
    // signature — a distinct verdict so the tool reports it honestly.
    return { stablePolls, verdict: cur.text.trim() === "" ? "empty" : "complete", last: { ...cur } }
  }
  return { stablePolls, verdict: "waiting", last: { ...cur } }
}

export type TokenCount = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

// Sum of per-message info.tokens across the child session's assistant
// messages (host-reported values only — never fabricated).
export function sumTokens(list: Array<Partial<TokenCount> & { cache?: Partial<TokenCount["cache"]> }>): TokenCount {
  const total: TokenCount = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  for (const t of list) {
    total.input += t.input ?? 0
    total.output += t.output ?? 0
    total.reasoning += t.reasoning ?? 0
    total.cache.read += t.cache?.read ?? 0
    total.cache.write += t.cache?.write ?? 0
  }
  return total
}

// Price spec, USD per million tokens (models.dev snapshot slice).
export type PriceSpec = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export type CostResult = { costUsd: number | null; note?: string }

export function computeCost(tokens: TokenCount, price: PriceSpec | null): CostResult {
  if (!price || typeof price.input !== "number" || typeof price.output !== "number") {
    return { costUsd: null, note: "price unavailable for this identity (no snapshot price)" }
  }
  if (tokens.cache.read > 0 && typeof price.cacheRead !== "number") {
    return { costUsd: null, note: "price unavailable: cache-read price missing from snapshot" }
  }
  if (tokens.cache.write > 0 && typeof price.cacheWrite !== "number") {
    return { costUsd: null, note: "price unavailable: cache-write price missing from snapshot" }
  }
  const usd =
    (tokens.input * price.input +
      (tokens.output + tokens.reasoning) * price.output +
      tokens.cache.read * (price.cacheRead ?? 0) +
      tokens.cache.write * (price.cacheWrite ?? 0)) /
    1_000_000
  return { costUsd: usd }
}
