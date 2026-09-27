// crew_close completion gate — PURE cross-check logic (spec: crew-harness —
// "crew_close completion gate", change simplify-dispatch-to-static-agents).
// The source of truth is the DECLARED SUBTASK PLAN registered at crew_begin:
// every declared subtask must carry a verdict with an evidence statement,
// nothing silently dropped; a report entry that was never declared is
// renegade work and refuses the close; honest FAILs are allowed (refusal is
// for missing, dropped, or undeclared results). Title matching is
// case-insensitive trim.

export type CrewSubtask = { title: string; agent?: string }

export type CrewSubtaskReport = {
  title: string
  verdict: string
  evidence: string
  attempts?: string[]
}

export type CrewSession = { objective: string; startedAt: string; sessionID: string; subtasks: CrewSubtask[] }

function normTitle(t: unknown): string {
  return String(t ?? "")
    .trim()
    .toLowerCase()
}

export function validateCrewReport(
  report: CrewSubtaskReport[],
  declared: CrewSubtask[],
): { ok: boolean; gaps: string[] } {
  const gaps: string[] = []
  if (!Array.isArray(report) || report.length === 0) {
    return { ok: false, gaps: ["the report lists no subtasks — a crew completion report must cover every declared subtask"] }
  }

  const declaredTitles = new Set<string>()
  for (const s of Array.isArray(declared) ? declared : []) {
    const t = normTitle(s?.title)
    if (t) declaredTitles.add(t)
  }

  const covered = new Set<string>()
  report.forEach((sub, i) => {
    const label = sub?.title?.trim() || `subtask #${i + 1}`
    const key = normTitle(sub?.title)
    if (!sub?.title?.trim()) gaps.push(`${label}: missing title`)
    else if (covered.has(key)) gaps.push(`${label}: duplicate report entry for the same title`)
    covered.add(key)
    const verdict = String(sub?.verdict ?? "").toUpperCase()
    if (verdict !== "PASS" && verdict !== "FAIL") gaps.push(`${label}: verdict must be PASS or FAIL (got "${sub?.verdict ?? ""}")`)
    if (!String(sub?.evidence ?? "").trim()) gaps.push(`${label}: missing evidence statement`)
    if (verdict === "FAIL" && (!Array.isArray(sub?.attempts) || sub!.attempts!.length < 2)) {
      gaps.push(`${label}: FAIL requires both failure reports (the attempt and the one retry) in attempts[]`)
    }
    if (key && declaredTitles.size > 0 && !declaredTitles.has(key)) {
      gaps.push(`${label}: not part of the plan registered at crew_begin (renegade work) — fold discoveries into an existing subtask's verdict notes, or discard and re-crew with the full plan`)
    }
  })

  for (const t of declaredTitles) {
    if (!covered.has(t)) {
      const original = (Array.isArray(declared) ? declared : []).find((s) => normTitle(s?.title) === t)?.title ?? t
      gaps.push(`"${original}": declared at crew_begin but has no verdict in the report — a declared subtask was silently dropped`)
    }
  }

  return { ok: gaps.length === 0, gaps }
}
