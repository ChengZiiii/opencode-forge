// crew_close completion gate — PURE cross-check logic (task 4.2, design D13).
// The ledger is the single source of truth (D13): a subtask verdict must
// reference dispatchIds that exist in the ledger, and every dispatch the crew
// submitted (ledger rows for this session since the crew started) must have a
// verdict in the report — nothing silently dropped. Honest FAILs are allowed;
// refusal is for missing or dropped results.

export type CrewSubtaskReport = {
  title: string
  verdict: string
  evidence: string
  attempts?: string[]
}

export type CrewLedgerRow = {
  ts: string
  event: string
  dispatchId?: string
  parentSessionID?: string
  outcome?: string
}

export type CrewSession = { objective: string; startedAt: string; sessionID: string }

const CREW_DISPATCH_EVENTS = new Set(["completed", "timeout", "error", "killed", "empty-response"])
const DISPATCH_ID = /bg-\d+/g

export function validateCrewReport(
  report: CrewSubtaskReport[],
  ledgerRows: CrewLedgerRow[],
  crew: CrewSession,
): { ok: boolean; gaps: string[]; dispatchIds: string[] } {
  const gaps: string[] = []
  if (!Array.isArray(report) || report.length === 0) {
    return { ok: false, gaps: ["the report lists no subtasks — a crew completion report must cover every subtask"], dispatchIds: [] }
  }

  const rowById = new Map<string, CrewLedgerRow>()
  for (const row of ledgerRows) {
    if (row.parentSessionID !== crew.sessionID) continue
    if (row.ts < crew.startedAt) continue
    if (row.event === "validation" || row.event === "resolve-error" || row.event === "refused-cap" || row.event === "models-dev-degraded" || row.event === "retry-excluded" || row.event === "lost-on-exit" || row.event === "kill-late-completion") continue
    if (CREW_DISPATCH_EVENTS.has(row.event) && row.dispatchId) rowById.set(row.dispatchId, row)
  }

  const referenced = new Set<string>()
  report.forEach((sub, i) => {
    const label = sub?.title?.trim() || `subtask #${i + 1}`
    const verdict = String(sub?.verdict ?? "").toUpperCase()
    if (!sub?.title?.trim()) gaps.push(`${label}: missing title`)
    if (verdict !== "PASS" && verdict !== "FAIL") gaps.push(`${label}: verdict must be PASS or FAIL (got "${sub?.verdict ?? ""}")`)
    const ids = [...String(sub?.evidence ?? "").matchAll(DISPATCH_ID)].map((m) => m[0])
    if (!String(sub?.evidence ?? "").trim()) gaps.push(`${label}: missing evidence reference`)
    else if (ids.length === 0) gaps.push(`${label}: evidence must reference a dispatch id (bg-N) that exists in the dispatch ledger`)
    for (const id of ids) {
      if (referenced.has(id)) gaps.push(`${label}: dispatch ${id} is already cited by another subtask — each dispatch belongs to exactly one verdict`)
      referenced.add(id)
      const row = rowById.get(id)
      if (!row) gaps.push(`${label}: dispatch ${id} has no ledger row for this crew (fabricated, stale, or pre-crew)`)
      else if (verdict === "PASS" && row.event !== "completed") {
        gaps.push(`${label}: marked PASS but dispatch ${id} ended ${row.event} — a subtask whose attempt and retry both failed must be marked FAIL with both reports visible`)
      }
    }
    if (verdict === "FAIL" && (!Array.isArray(sub?.attempts) || sub!.attempts!.length < 2)) {
      gaps.push(`${label}: FAIL requires both failure reports (the attempt and the one retry) in attempts[]`)
    }
  })

  for (const [id, row] of rowById) {
    if (!referenced.has(id)) gaps.push(`dispatch ${id} (${row.event}, ${row.ts}) has no verdict in the report — a dispatched subtask was silently dropped`)
  }

  return { ok: gaps.length === 0, gaps, dispatchIds: [...rowById.keys()] }
}
