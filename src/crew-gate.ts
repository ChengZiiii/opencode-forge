// crew_close completion gate — PURE cross-check logic (spec: crew-harness —
// "crew_close completion gate", change simplify-dispatch-to-static-agents).
// The source of truth is the DECLARED SUBTASK PLAN registered at crew_begin:
// every declared subtask must carry a verdict with an evidence statement,
// nothing silently dropped; a report entry that was never declared is
// renegade work and refuses the close; honest FAILs are allowed (refusal is
// for missing, dropped, or undeclared results). Title matching is
// case-insensitive trim.

export type CrewSubtask = { title: string; agent?: string }

export type CrewRound = { id: string; childID: string; agent: string; description: string; prompt: string }
const object = (x: unknown): Record<string, unknown> => x && typeof x === "object" ? x as Record<string, unknown> : {}

/** Host execute.after completion receipt, not an admission inferred from input. */
export function crewAcceptedRound(id: string | undefined, args: Record<string, unknown>, raw: unknown): CrewRound | null {
  const event = object(raw), result = object(event.result), metadata = object(result.metadata)
  if (!id || event.status !== "completed" || metadata.status !== "running" || typeof metadata.sessionID !== "string" || typeof args.agent !== "string") return null
  return { id, childID: metadata.sessionID, agent: args.agent, description: String(args.description ?? ""), prompt: String(args.prompt ?? "") }
}

export type CrewCloseEvidence = {
  rounds: CrewRound[]
  readable: boolean
  inFlight: string[]
  settled: { childID: string; outcome: string | null }[]
  context: unknown
}

/** A completion is tied to a tool receipt in the ordered parent transcript.
 * Never credit an older result of a reused session or a terminal row alone. */
export function crossCheckCrewEvidence(report: CrewSubtaskReport[], declared: CrewSubtask[], evidence: CrewCloseEvidence): string[] {
  const gaps: string[] = []
  if (!evidence.readable || evidence.inFlight.length) gaps.push("native session enumeration is incomplete or work remains in flight")
  const messages = object(evidence.context).data ?? evidence.context
  const rounds = evidence.rounds
  for (const sub of report) for (const id of sub.rounds ?? []) {
    if (!rounds.some(r => r.id === id)) gaps.push(`${sub.title}: unknown dispatch reference ${id}`)
  }
  if (!Array.isArray(messages)) return rounds.length ? [...gaps, "native result context unavailable"] : gaps
  const assigned = new Map<string, CrewRound[]>()
  for (const round of rounds) {
    const explicit = report.filter(s => s.rounds?.includes(round.id))
    const matches = explicit.length ? declared.filter(s => explicit.some(r => normTitle(r.title) === normTitle(s.title))) : declared.filter(s => normTitle(round.description) === normTitle(s.title) || round.prompt.toLowerCase().includes(`subtask: ${normTitle(s.title)}\n`))
    if (matches.length !== 1) { gaps.push(`dispatch ${round.id}: cannot associate a unique declared subtask`); continue }
    const key = normTitle(matches[0].title)
    assigned.set(key, [...(assigned.get(key) ?? []), round])
  }
  const results = new Map<string, { state: string; text: string }>()
  // Include historical accepted receipts as barriers, even when their crew
  // registration has ended. A late result must not settle a new reuse.
  const current = new Map<string, { id: string; childID: string }>()
  const seenNotifications = new Set<string>()
  const ambiguous = new Set<string>()
  const created = (raw: unknown) => object(object(raw).time).created
  const ordered = messages.every(m => typeof created(m) === "number")
    ? [...messages].sort((a, b) => Number(created(a)) - Number(created(b))) : messages
  for (const raw of ordered) {
    const m = object(raw)
    if (m.type === "assistant" && Array.isArray(m.content)) for (const rawPart of m.content) {
      const p = object(rawPart), state = object(p.state), metadata = object(state.metadata)
      const id = p.callID ?? p.id
      const childID = metadata.sessionID
      if (p.type === "tool" && p.name === "subagent" && state.status === "completed" && metadata.status === "running" && typeof id === "string" && typeof childID === "string") {
        const known = rounds.find(r => r.id === id)
        if (known && known.childID !== childID) { ambiguous.add(known.childID); continue }
        const previous = current.get(childID)
        if (previous && previous.id !== id && !results.has(previous.id)) ambiguous.add(childID)
        current.set(childID, { id, childID })
      }
    }
    if (m.type !== "synthetic") continue
    const meta = object(m.metadata), text = typeof m.text === "string" ? m.text : ""
    if (meta.source !== "subagent" || typeof meta.childID !== "string") continue
    if (typeof m.id === "string") {
      if (seenNotifications.has(m.id)) continue
      seenNotifications.add(m.id)
    }
    const round = current.get(meta.childID)
    const match = /^<background-result kind="subagent" sessionID="[^"]+" state="(completed|error|cancelled)" description="[^"]*">\s*([\s\S]*?)\s*<\/background-result>$/.exec(text)
    if (round && !ambiguous.has(round.childID) && match && meta.state === match[1] && !results.has(round.id)) results.set(round.id, { state: match[1], text: match[2] })
  }
  for (const sub of report) {
    const related = assigned.get(normTitle(sub.title)) ?? []
    if (!related.length) {
      // No observed dispatch: a local subtask remains the orchestrator's
      // evidence judgment, not a fabricated child result. An explicit claim
      // of native work must still be backed by an associated dispatch.
      if (sub.rounds?.length) gaps.push(`${sub.title}: referenced native dispatch evidence is missing`)
      continue
    }
    if (related.length > 2) { gaps.push(`${sub.title}: at most one retry`); continue }
    if (related.some(r => !r.agent.startsWith("forge-")) && !/\bnative\b/i.test(sub.evidence)) gaps.push(`${sub.title}: native fallback must be disclosed`)
    const last = related[related.length - 1], result = results.get(last.id)
    const row = evidence.settled.find(r => r.childID === last.childID)
    if (related.some(r => !evidence.settled.some(child => child.childID === r.childID))) gaps.push(`${sub.title}: accepted work is missing from the settled host view`)
    if (related.length === 2 && sub.attempts?.length !== 2) gaps.push(`${sub.title}: record both attempts`)
    if (sub.verdict.toUpperCase() === "PASS") {
      if (related.some(r => !results.has(r.id)) || result?.state !== "completed" || row?.outcome !== "succeeded" || !result.text.trim() || result.text === "Subagent completed without a text response.") gaps.push(`${sub.title}: PASS requires verified successful round evidence, not merely a terminal session`)
      // The orchestrator judges the acceptance statement from the result;
      // arbitrary natural-language words are not a structured host verdict.
    }
  }
  return gaps
}

export type CrewSubtaskReport = {
  title: string
  verdict: string
  evidence: string
  attempts?: string[]
  rounds?: string[]
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
