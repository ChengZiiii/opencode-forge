// Dispatch journal core (dispatch-resilience fold E): append-only JSONL at
// <workspace>/.opencode/forge/dispatch-log.jsonl — the persisted memory that
// makes host restarts recoverable.
//
// Pure logic, no @opencode-ai imports (mirror of src/proc.ts /
// src/job-manager.ts): the fs seams are injectable so tests drive the
// journal in-memory, and every fs operation is FAIL-SOFT (a broken journal
// must never take a dispatch down).
//
// Record contract (spec: forge-subagents "Dispatch resilience"):
//   • one line per state transition (dispatched / queued / started /
//     retry-pending / terminal); loading dedupes by id keeping the LATEST
//     line per id (append-only log, latest-state-wins view);
//   • `prompt` is RETAINED while a record is non-terminal — after a restart
//     the journal is the ONLY prompt source for queued / retry-pending
//     recovery — and is REDACTED (dropped) on the terminal record;
//   • rotation compacts TERMINAL records only, oldest first, and NEVER
//     removes a non-terminal record; if compaction cannot reach the bound
//     (everything left is live) the journal OVERFLOWS rather than lose live
//     state;
//   • corrupt lines are tolerated (skipped) without aborting the load.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** Dispatch lifecycle states as journaled (spec: Dispatch resilience). */
export type DispatchJournalState = "dispatched" | "queued" | "started" | "retry-pending" | "terminal"

export type DispatchJournalRecord = {
  /** The dispatch task id (the registry job id — stable across retries). */
  id: string
  agent: string
  ownerSession: string
  workspace: string
  state: DispatchJournalState
  /** The live child session id (present once spawned; absent on queued/dispatched). */
  childSessionId?: string
  /**
   * The ORIGINAL dispatch prompt — retained while non-terminal (the journal
   * is the only prompt source after a restart); dropped on terminal records.
   */
  prompt?: string
  /** Attempt number this state describes (1 = the original). */
  attempts: number
  createdAt: number
  updatedAt: number
  /** Mode-keyed question policy — re-applied on recovery respawns. */
  questionDeny?: boolean
  description?: string
  /**
   * Terminal-only outcome: completed | error | stale | aborted |
   * stream-lost/unknown (the dispatch view broke before a final report —
   * child state UNKNOWN, never a death certificate).
   */
  outcome?: string
  /** Terminal-only human reason. */
  reason?: string
}

/** Default journal bound: 200 records (FORGE_DISPATCH_JOURNAL_MAX). */
export const DEFAULT_JOURNAL_MAX = 200

/** Resolve FORGE_DISPATCH_JOURNAL_MAX (default 200; invalid → default). */
export function resolveJournalMax(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.FORGE_DISPATCH_JOURNAL_MAX
  if (raw === undefined || raw === "") return DEFAULT_JOURNAL_MAX
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_JOURNAL_MAX
  return Math.round(parsed)
}

/** Injectable fs seams (tests run the journal fully in-memory). */
export type JournalFs = {
  /** Full file text, or null when the file does not exist. */
  read: () => string | null
  /** Append one line (the caller supplies no trailing newline). */
  append: (line: string) => void
  /** Rewrite the whole file with the given lines (rotation compaction). */
  rewrite: (lines: string[]) => void
}

/** Production fs: real file at `filePath`, directories created lazily. */
export function defaultJournalFs(filePath: string): JournalFs {
  return {
    read: () => {
      try {
        return readFileSync(filePath, "utf8")
      } catch {
        return null
      }
    },
    append: (line) => {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        appendFileSync(filePath, line + "\n")
      } catch {
        // Fail-soft: a broken journal never takes the dispatch down.
      }
    },
    rewrite: (lines) => {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, lines.length === 0 ? "" : lines.map((l) => l + "\n").join(""))
      } catch {
        // Fail-soft.
      }
    },
  }
}

/**
 * Parse one journal file body: JSON per line; corrupt lines are SKIPPED
 * (tolerated, never fatal); dedupe by id keeping the LATEST record per id
 * (an append-only transition log reads as latest-state-wins).
 */
export function parseJournalLines(text: string | null): DispatchJournalRecord[] {
  if (!text) return []
  const byId = new Map<string, DispatchJournalRecord>()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // corrupt line: skip + continue (spec scenario)
    }
    if (!parsed || typeof parsed !== "object") continue
    const rec = parsed as Partial<DispatchJournalRecord>
    if (typeof rec.id !== "string" || rec.id === "") continue
    if (
      rec.state !== "dispatched" &&
      rec.state !== "queued" &&
      rec.state !== "started" &&
      rec.state !== "retry-pending" &&
      rec.state !== "terminal"
    ) {
      continue
    }
    byId.set(rec.id, rec as DispatchJournalRecord)
  }
  return [...byId.values()]
}

/**
 * Rotation decision (pure): given the latest-per-id records, when the count
 * exceeds `max`, drop TERMINAL records oldest-first (by updatedAt) until
 * under the bound; NEVER drop a non-terminal record — if all survivors are
 * non-terminal the journal overflows rather than lose live state.
 */
export function compactJournalRecords(records: DispatchJournalRecord[], max: number): DispatchJournalRecord[] {
  if (records.length <= max) return records
  const kept = [...records]
  const terminals = kept
    .filter((r) => r.state === "terminal")
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
  let drop = kept.length - max
  const dropped = new Set<string>()
  for (const t of terminals) {
    if (drop <= 0) break
    // Drop ONE terminal record per id (ids are unique in `records`).
    dropped.add(t.id)
    drop--
  }
  return kept.filter((r) => !dropped.has(r.id))
}

export type DispatchJournal = {
  /** Append one transition record (fail-soft); rotates when over the bound. */
  append: (record: DispatchJournalRecord) => void
  /** Latest-per-id records (corrupt lines skipped). */
  load: () => DispatchJournalRecord[]
  /** Latest-per-id records that are NOT terminal. */
  nonTerminal: () => DispatchJournalRecord[]
  /** The underlying fs seam (test visibility). */
  fs: JournalFs
}

export function createDispatchJournal(
  filePath: string,
  opts: { fs?: JournalFs; maxRecords?: number; now?: () => number } = {},
): DispatchJournal {
  const fs = opts.fs ?? defaultJournalFs(filePath)
  const max = opts.maxRecords ?? DEFAULT_JOURNAL_MAX

  const load = (): DispatchJournalRecord[] => parseJournalLines(fs.read())

  return {
    fs,
    append: (record) => {
      fs.append(JSON.stringify(record))
      // Rotation: compact terminal records only, never a non-terminal one.
      const records = load()
      if (records.length > max) {
        const kept = compactJournalRecords(records, max)
        if (kept.length < records.length) {
          fs.rewrite(kept.map((r) => JSON.stringify(r)))
        }
        // kept.length === records.length (all non-terminal): overflow —
        // live state beats the bound.
      }
    },
    load,
    nonTerminal: () => load().filter((r) => r.state !== "terminal"),
  }
}
