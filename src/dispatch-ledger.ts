// Bounded JSONL ledger for the dispatch suite (spec: dispatch — "Draft-plan
// interop and dispatch ledger"). Same bounded-append style as the watchdog /
// job ledgers: capped entry count, capped bytes (newest half kept on
// overflow), and a read-only/full disk can never break the caller.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { DispatchLedgerEvent } from "./dispatch-engine.ts"

export const DISPATCH_LEDGER_MAX_ENTRIES = 200
export const DISPATCH_LEDGER_MAX_BYTES = 1_000_000

// Ledger rows are open-ended (validation findings, config fallbacks, engine
// events) — DispatchLedgerEvent plus optional extras.
export type DispatchLedgerRow = DispatchLedgerEvent & { level?: string; code?: string; dispatchId?: string; parentSessionID?: string; dispatchIds?: string[]; subtasks?: Array<{ title: string; verdict: string; evidence: string }> }

export type DispatchFileLedger = {
  append: (entry: DispatchLedgerRow) => void
  entries: () => DispatchLedgerRow[]
  path: string
}

export function createDispatchLedger(logPath: string, maxEntries = DISPATCH_LEDGER_MAX_ENTRIES, maxBytes = DISPATCH_LEDGER_MAX_BYTES): DispatchFileLedger {
  const append = (entry: DispatchLedgerEvent): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      let lines: string[] = []
      try {
        lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0)
      } catch {
        // First write.
      }
      if (lines.length >= maxEntries) lines = lines.slice(lines.length - maxEntries + 1)
      lines.push(JSON.stringify(entry))
      let text = lines.join("\n") + "\n"
      if (text.length > maxBytes) {
        const keep = Math.max(1, Math.floor(maxEntries / 2))
        text = lines.slice(-keep).join("\n") + "\n"
      }
      writeFileSync(logPath, text, "utf8")
    } catch {
      // Ledgering must never break dispatching.
    }
  }
  const entries = (): DispatchLedgerEvent[] => {
    try {
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as DispatchLedgerRow)
    } catch {
      return []
    }
  }
  return { append, entries, path: logPath }
}
