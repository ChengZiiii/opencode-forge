// Pure goal-file core for the forge goal harness.
//
// No @opencode-ai imports and (deliberately) no plan-file imports — the goal
// discipline is decoupled from the plan harness, so this module is
// self-contained (slug/date helpers are local copies, not shared). Every
// function maps strings to strings or throws GoalError; the only fs touch is
// the atomic-write helper (tests exercise it against temp dirs).
//
// Document shape (rendered by renderGoal, parsed by parseGoal):
//
//   ---
//   status: queued | active | paused | completed | abandoned
//   created: <ISO>
//   updated: <ISO>
//   revision: 1            # edits bump this; evidence is stamped with it
//   session: <owner id>    # empty while queued; set on arm/promote/resume
//   max_turns: 25
//   turns_used: 0
//   max_minutes: 60
//   stop_reason: blocker   # only meaningful while paused
//   ---
//   ## Goal / ## Success Criteria / ## Verification Checks /
//   ## Constraints / ## Non-Goals / ## Check Log / ## Turn Ledger
//
// Verification Checks items (numbered, two kinds):
//   1. shell `npm test` (timeout 120s)
//   2. contains `src/config.ts` :: `PORT from env`
//
// Check Log lines (append-only audit; runId makes re-appends idempotent):
//   - <ISO> rev1 #1 OK (213ms) `npm test` :: <truncated output>
// Turn Ledger lines (one per continuation turn; keyed by turn number):
//   - turn 3 rev1 <ISO> activity=yes (writes=2 checks=1)
//
// State machine: queued -> active (arm/promote gate); active <-> paused;
// active -> completed (completion gate); queued/active/paused -> abandoned.

import { renameSync, writeFileSync } from "node:fs"

export class GoalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GoalError"
  }
}

export type GoalStatus = "queued" | "active" | "paused" | "completed" | "abandoned"

export type StopReason =
  | "user"
  | "blocker"
  | "no-progress"
  | "budget-turns"
  | "budget-time"
  | "draft-conflict"
  | "transport-failures"

export type CheckItem =
  | { kind: "shell"; cmd: string; timeoutSec?: number }
  | { kind: "contains"; file: string; text: string }

export type GoalInput = {
  goal: string
  criteria: string[]
  checks: CheckItem[]
  constraints: string
  nonGoals?: string[]
  maxTurns?: number
  maxMinutes?: number
}

export type LedgerEntry = { turn: number; revision: number; at: string; activity: boolean; writes: number; checks: number }

export type GoalDoc = {
  status: GoalStatus
  created: string
  updated: string
  revision: number
  session: string
  maxTurns: number
  turnsUsed: number
  maxMinutes: number
  stopReason?: StopReason
  goal: string
  criteria: string[]
  checks: CheckItem[]
  constraints: string
  nonGoals: string[]
  log: string[]
  ledger: LedgerEntry[]
}

// Budgets, thresholds, and hard ceilings (spec: goal-harness).
export const DEFAULT_MAX_TURNS = 25
export const DEFAULT_MAX_MINUTES = 60
export const HARD_MAX_TURNS = 200
export const HARD_MAX_MINUTES = 480
export const DEFAULT_TIMEOUT_SEC = 120
export const MAX_TIMEOUT_SEC = 600
export const TRANSPORT_FAILURE_LIMIT = 3
export const NO_PROGRESS_LIMIT = 2

const TERMINAL: GoalStatus[] = ["completed", "abandoned"]

const LEGAL_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  queued: ["active", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "abandoned"],
  completed: [],
  abandoned: [],
}

const SECTION_ORDER = [
  "Goal",
  "Success Criteria",
  "Verification Checks",
  "Constraints",
  "Non-Goals",
  "Check Log",
  "Turn Ledger",
] as const

const SECTION_HEADERS: Record<string, RegExp> = {
  Goal: /^(#*)\s*goal\s*$/i,
  "Success Criteria": /^(#*)\s*success criteria\s*$/i,
  "Verification Checks": /^(#*)\s*verification checks\s*$/i,
  Constraints: /^(#*)\s*constraints\s*$/i,
  "Non-Goals": /^(#*)\s*non-goals?\s*$/i,
  "Check Log": /^(#*)\s*check log\s*$/i,
  "Turn Ledger": /^(#*)\s*turn ledger\s*$/i,
}

const SHELL_LINE_RE = /^\s*(\d+)[.、)]\s*shell\s+`([^`]*)`(?:\s+\(timeout\s+(\d+)s?\))?$/i
const CONTAINS_LINE_RE = /^\s*(\d+)[.、)]\s*contains\s+`([^`]*)`\s*::\s*`([^`]*)`$/i
const NUMBERED_RE = /^\s*(\d+)[.、)]\s+(.+)$/
const LEDGER_RE = /^-\s*turn\s+(\d+)\s+rev(\d+)\s+(\S+)\s+activity=(yes|no)\s+\(writes=(\d+)\s+checks=(\d+)\)$/

export function isGoalTerminal(status: string): boolean {
  return (TERMINAL as string[]).includes(status)
}

export function isGoalLive(status: string): boolean {
  return status === "active" || status === "paused"
}

export function canTransitionGoal(from: string, to: string): boolean {
  const legal = LEGAL_TRANSITIONS[from as GoalStatus]
  return Array.isArray(legal) && legal.includes(to as GoalStatus)
}

// Local copies of the plan-file helpers (slug/date/filename): the goal core
// intentionally shares no module with the plan core.
export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "")
  return slug || "goal"
}

export function localDateNow(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function goalFileName(date: string, slug: string, existingNames: string[] = []): string {
  const taken = new Set(existingNames)
  let base = `${date}-${slug}`
  let name = `${base}.md`
  let i = 2
  while (taken.has(name)) {
    name = `${base}-${i}.md`
    i++
  }
  return name
}

// Atomic file replace: a crash mid-write leaves either the old or the new
// complete document, never a hybrid (goal files are rewritten every
// continuation turn, so the crash window matters more than for plans).
export function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export function validateGoalInput(input: Partial<GoalInput>): string[] {
  const missing: string[] = []
  const reqStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0
  if (!reqStr(input.goal)) missing.push("goal")
  if (!Array.isArray(input.criteria) || input.criteria.length === 0 || !input.criteria.every(reqStr)) {
    missing.push("criteria (at least one success criterion)")
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    missing.push("checks (at least one verification item)")
  } else {
    for (const c of input.checks) {
      if (c.kind === "shell" && !reqStr(c.cmd)) {
        missing.push("checks (a shell item has an empty command)")
        break
      }
      if (c.kind === "contains" && (!reqStr(c.file) || !reqStr(c.text))) {
        missing.push("checks (a contains item has an empty file or text)")
        break
      }
    }
  }
  if (!reqStr(input.constraints)) missing.push("constraints")
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > HARD_MAX_TURNS)) {
    missing.push(`maxTurns (integer 1-${HARD_MAX_TURNS})`)
  }
  if (input.maxMinutes !== undefined && (!Number.isInteger(input.maxMinutes) || input.maxMinutes < 1 || input.maxMinutes > HARD_MAX_MINUTES)) {
    missing.push(`maxMinutes (integer 1-${HARD_MAX_MINUTES})`)
  }
  return missing
}

function renderCheck(item: CheckItem): string {
  if (item.kind === "shell") {
    const t = item.timeoutSec ?? DEFAULT_TIMEOUT_SEC
    return `shell \`${item.cmd}\` (timeout ${t}s)`
  }
  return `contains \`${item.file}\` :: \`${item.text}\``
}

function frontmatterBlock(meta: {
  status: GoalStatus
  created: string
  updated: string
  revision: number
  session?: string
  maxTurns: number
  turnsUsed: number
  maxMinutes: number
  stopReason?: StopReason
}): string {
  const lines = [
    "---",
    `status: ${meta.status}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `revision: ${meta.revision}`,
  ]
  if (meta.session) lines.push(`session: ${meta.session}`)
  lines.push(`max_turns: ${meta.maxTurns}`, `turns_used: ${meta.turnsUsed}`, `max_minutes: ${meta.maxMinutes}`)
  if (meta.status === "paused" && meta.stopReason) lines.push(`stop_reason: ${meta.stopReason}`)
  lines.push("---", "")
  return lines.join("\n")
}

export function renderGoal(
  input: GoalInput,
  meta: {
    now: string
    status: GoalStatus
    created?: string
    revision?: number
    session?: string
    turnsUsed?: number
    stopReason?: StopReason
  },
): string {
  const missing = validateGoalInput(input)
  if (missing.length > 0) {
    throw new GoalError(`Goal contract incomplete; missing: ${missing.join(", ")}`)
  }
  const goal = input.goal.trim()
  const nonGoals = (input.nonGoals ?? []).filter((s) => s.trim().length > 0)
  const parts: string[] = [
    frontmatterBlock({
      status: meta.status,
      created: meta.created ?? meta.now,
      updated: meta.now,
      revision: meta.revision ?? 1,
      session: meta.session,
      maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
      turnsUsed: meta.turnsUsed ?? 0,
      maxMinutes: input.maxMinutes ?? DEFAULT_MAX_MINUTES,
      ...(meta.status === "paused" && meta.stopReason ? { stopReason: meta.stopReason } : {}),
    }),
    "## Goal",
    "",
    goal,
    "",
    "## Success Criteria",
    "",
    input.criteria.map((c, i) => `${i + 1}. ${c.trim()}`).join("\n"),
    "",
    "## Verification Checks",
    "",
    input.checks.map((c, i) => `${i + 1}. ${renderCheck(c)}`).join("\n"),
    "",
    "## Constraints",
    "",
    input.constraints.trim(),
    "",
    "## Non-Goals",
    "",
    nonGoals.length > 0 ? nonGoals.map((s) => `- ${s.trim()}`).join("\n") : "(no non-goals declared)",
    "",
    "## Check Log",
    "",
    "(no checks recorded yet)",
    "",
    "## Turn Ledger",
    "",
    "(no continuation turns yet)",
    "",
  ]
  return parts.join("\n")
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) throw new GoalError("goal file is missing frontmatter")
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return { fm, body: text.slice(m[0].length) }
}

function matchSectionHeader(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("#")) return null
  for (const key of Object.keys(SECTION_HEADERS)) {
    if (SECTION_HEADERS[key].test(trimmed)) return key
  }
  return null
}

function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current: string | null = null
  const buf: string[] = []
  const flush = () => {
    if (current !== null) sections.set(current, buf.join("\n").trim())
    buf.length = 0
  }
  for (const line of body.split(/\r?\n/)) {
    const header = matchSectionHeader(line)
    if (header !== null) {
      flush()
      current = header
    } else if (current !== null) {
      buf.push(line)
    }
  }
  flush()
  return sections
}

export function parseGoal(text: string): GoalDoc {
  const { fm, body } = parseFrontmatter(text)
  const status = (fm.status ?? "queued") as GoalStatus
  if (!["queued", "active", "paused", "completed", "abandoned"].includes(status)) {
    throw new GoalError(`Unknown goal status: ${fm.status}`)
  }
  const sections = splitSections(body)
  for (const key of SECTION_ORDER) {
    if (!sections.has(key)) {
      throw new GoalError(`Goal is missing section: ${key}`)
    }
  }
  const criteria: string[] = []
  const seenCriterion = new Set<number>()
  for (const line of (sections.get("Success Criteria") ?? "").split(/\r?\n/)) {
    const m = line.match(NUMBERED_RE)
    if (!m) continue
    if (seenCriterion.has(Number(m[1]))) throw new GoalError(`Duplicate success criterion number: ${m[1]}`)
    seenCriterion.add(Number(m[1]))
    criteria.push(m[2].trim())
  }
  if (criteria.length === 0) throw new GoalError("Success criteria are empty or malformed")

  const checks: CheckItem[] = []
  const seenCheck = new Set<number>()
  for (const line of (sections.get("Verification Checks") ?? "").split(/\r?\n/)) {
    const shell = line.match(SHELL_LINE_RE)
    if (shell) {
      if (seenCheck.has(Number(shell[1]))) throw new GoalError(`Duplicate verification item number: ${shell[1]}`)
      seenCheck.add(Number(shell[1]))
      checks.push({ kind: "shell", cmd: shell[2], ...(shell[3] ? { timeoutSec: Number(shell[3]) } : {}) })
      continue
    }
    const contains = line.match(CONTAINS_LINE_RE)
    if (contains) {
      if (seenCheck.has(Number(contains[1]))) throw new GoalError(`Duplicate verification item number: ${contains[1]}`)
      seenCheck.add(Number(contains[1]))
      checks.push({ kind: "contains", file: contains[2], text: contains[3] })
    }
  }
  if (checks.length === 0) throw new GoalError("Verification checks are empty or malformed")

  const log = (sections.get("Check Log") ?? "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("- "))

  const ledger: LedgerEntry[] = []
  for (const line of (sections.get("Turn Ledger") ?? "").split(/\r?\n/)) {
    const m = line.match(LEDGER_RE)
    if (m) {
      ledger.push({ turn: Number(m[1]), revision: Number(m[2]), at: m[3], activity: m[4] === "yes", writes: Number(m[5]), checks: Number(m[6]) })
    }
  }

  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt
  }
  return {
    status,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    revision: Math.max(1, num(fm.revision, 1)),
    session: fm.session ?? "",
    maxTurns: Math.max(1, num(fm.max_turns, DEFAULT_MAX_TURNS)),
    turnsUsed: num(fm.turns_used, 0),
    maxMinutes: Math.max(1, num(fm.max_minutes, DEFAULT_MAX_MINUTES)),
    ...(status === "paused" && fm.stop_reason ? { stopReason: fm.stop_reason as StopReason } : {}),
    goal: (sections.get("Goal") ?? "").split(/\r?\n/)[0]?.trim() ?? "",
    criteria,
    checks,
    constraints: sections.get("Constraints") ?? "",
    nonGoals: (sections.get("Non-Goals") ?? "")
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(1).trim()),
    log,
    ledger,
  }
}

export function parseGoalLoose(text: string): GoalDoc | null {
  try {
    return parseGoal(text)
  } catch {
    return null
  }
}

function setFm(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:.*$`, "m")
  if (re.test(text)) return text.replace(re, `${key}: ${value}`)
  return text.replace(/^---\r?\n/, `---\n${key}: ${value}\n`)
}

function setUpdated(text: string, now: string): string {
  return setFm(text, "updated", now)
}

// State transition with side fields: entering `active` rebinds the owner
// session and clears any stop_reason; entering `paused` requires one.
export function transitionGoal(
  text: string,
  to: GoalStatus,
  now: string,
  opts: { session?: string; stopReason?: StopReason } = {},
): string {
  const { fm } = parseFrontmatter(text)
  const from = (fm.status ?? "queued") as GoalStatus
  if (from === to) throw new GoalError(`Goal is already ${to}`)
  if (!canTransitionGoal(from, to)) {
    throw new GoalError(
      `Illegal goal status transition: ${from} -> ${to} (legal paths: queued -> active; active <-> paused; active -> completed; queued/active/paused -> abandoned)`,
    )
  }
  let next = text.replace(/^status:.*$/m, `status: ${to}`)
  if (to === "paused") {
    if (!opts.stopReason) throw new GoalError("Pausing requires a stop reason (user/blocker/no-progress/budget-turns/budget-time/draft-conflict/transport-failures)")
    next = setFm(next, "stop_reason", opts.stopReason)
  }
  if (to === "active") {
    if (!opts.session) throw new GoalError("Arming/resuming requires the owning session id")
    next = setFm(next, "session", opts.session)
    next = next.replace(/^stop_reason:.*$\r?\n?/m, "")
  }
  return setUpdated(next, now)
}

export function incTurns(text: string, now: string): string {
  const doc = parseGoal(text)
  const next = setFm(text, "turns_used", String(doc.turnsUsed + 1))
  return setUpdated(next, now)
}

export function bumpBudget(text: string, addTurns: number, now: string): string {
  const doc = parseGoal(text)
  const capped = Math.min(doc.maxTurns + addTurns, HARD_MAX_TURNS)
  const next = setFm(text, "max_turns", String(capped))
  return setUpdated(next, now)
}

// "ok" while both budget tracks have room; the first exhausted track wins.
export function budgetState(doc: GoalDoc): "ok" | "budget-turns" | "budget-time" {
  if (doc.turnsUsed >= doc.maxTurns) return "budget-turns"
  const start = Date.parse(doc.created)
  if (Number.isFinite(start) && Date.now() - start > doc.maxMinutes * 60_000) return "budget-time"
  return "ok"
}

// Signature of an existing log line, for idempotency: "run=<id> revN #M".
const LOG_SIG_RE = /^-\s*\S+\s+run=(\S+)\s+(rev\d+)\s+(#\d+)\s+/

// Append one audit line per outcome under Check Log, stamped with the run
// id, the goal's current revision, and the item number. Idempotent per
// (runId, revision, index): re-appending the same run (e.g. a retried tool
// call) does not duplicate lines, while a later run in the same revision
// appends normally (the log is an audit trail).
export function appendCheckLog(
  text: string,
  runId: string,
  outcomes: Array<{ index: number; ok: boolean; detail: string; durationMs?: number; label: string }>,
  now: string,
): string {
  const doc = parseGoal(text)
  const existing = new Set(
    doc.log
      .map((l) => l.match(LOG_SIG_RE))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => `${m[1]} ${m[2]} ${m[3]}`),
  )
  const add = outcomes
    .filter((o) => !existing.has(`${runId} rev${doc.revision} #${o.index}`))
    .map((o) => {
      const label = o.label.replace(/\r?\n/g, " ")
      const flat = (o.detail || "(no output)").replace(/\r?\n/g, " ")
      const detail = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat
      return `- ${now} run=${runId} rev${doc.revision} #${o.index} ${o.ok ? "OK" : "FAIL"} (${o.durationMs ?? 0}ms) \`${label}\` :: ${detail}`
    })
  if (add.length === 0) return setUpdated(text, now)
  const lines = text.split(/\r?\n/)
  const logHeaderIdx = lines.findIndex((l) => SECTION_HEADERS["Check Log"].test(l.trim()))
  if (logHeaderIdx === -1) throw new GoalError("Goal is missing section: Check Log")
  const placeholderIdx = lines.indexOf("(no checks recorded yet)", logHeaderIdx)
  if (placeholderIdx !== -1) lines.splice(placeholderIdx, 1)
  let lastLog = -1
  for (let i = logHeaderIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) lastLog = i
    else if (lines[i].trim() !== "") break
  }
  const at = lastLog === -1 ? logHeaderIdx + 2 : lastLog + 1
  lines.splice(at, 0, ...add)
  return setUpdated(lines.join("\n"), now)
}

// One Turn Ledger line per continuation turn, keyed by turn number: appending
// the same turn again replaces the previous line for that turn.
export function appendLedger(text: string, entry: LedgerEntry, now: string): string {
  const lines = text.split(/\r?\n/)
  const line = `- turn ${entry.turn} rev${entry.revision} ${entry.at} activity=${entry.activity ? "yes" : "no"} (writes=${entry.writes} checks=${entry.checks})`
  const headerIdx = lines.findIndex((l) => SECTION_HEADERS["Turn Ledger"].test(l.trim()))
  if (headerIdx === -1) throw new GoalError("Goal is missing section: Turn Ledger")
  const phIdx = lines.indexOf("(no continuation turns yet)", headerIdx)
  if (phIdx !== -1) lines.splice(phIdx, 1)
  const re = new RegExp(`^-\\s*turn\\s+${entry.turn}\\s+rev\\d+\\s+`)
  const existingIdx = lines.findIndex((l, i) => i > headerIdx && re.test(l))
  if (existingIdx !== -1) {
    lines[existingIdx] = line
  } else {
    let lastLedger = -1
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("- ")) lastLedger = i
      else if (lines[i].trim() !== "") break
    }
    const at = lastLedger === -1 ? headerIdx + 2 : lastLedger + 1
    lines.splice(at, 0, line)
  }
  return setUpdated(lines.join("\n"), now)
}

// Revision history carry-over: a revision re-renders the document, but the
// Check Log and Turn Ledger are an audit trail and MUST survive (spec:
// entries remain visible, stamped with the revision they were produced
// under). Replaces the fresh placeholders with the carried lines.
export function carryHistory(newText: string, oldDoc: GoalDoc): string {
  let out = newText
  if (oldDoc.log.length > 0) {
    out = out.replace("(no checks recorded yet)", oldDoc.log.join("\n"))
  }
  if (oldDoc.ledger.length > 0) {
    const lines = oldDoc.ledger.map((e) => `- turn ${e.turn} rev${e.revision} ${e.at} activity=${e.activity ? "yes" : "no"} (writes=${e.writes} checks=${e.checks})`)
    out = out.replace("(no continuation turns yet)", lines.join("\n"))
  }
  return out
}

// Live-goal discovery (active/paused), newest `updated` first — crash
// recovery re-binds the session to the freshest live goal.
export function rankLiveGoals(entries: Array<{ name: string; text: string }>): Array<{ name: string; doc: GoalDoc }> {
  return entries
    .map((e) => ({ name: e.name, doc: parseGoalLoose(e.text) }))
    .filter((e): e is { name: string; doc: GoalDoc } => e.doc !== null && isGoalLive(e.doc.status))
    .sort((a, b) => (a.doc.updated < b.doc.updated ? 1 : a.doc.updated > b.doc.updated ? -1 : a.name.localeCompare(b.name)))
}

// Queue order: oldest queued goal first (`/goal next` promotes this one).
export function rankQueuedGoals(entries: Array<{ name: string; text: string }>): Array<{ name: string; doc: GoalDoc }> {
  return entries
    .map((e) => ({ name: e.name, doc: parseGoalLoose(e.text) }))
    .filter((e): e is { name: string; doc: GoalDoc } => e.doc !== null && e.doc.status === "queued")
    .sort((a, b) => (a.doc.created > b.doc.created ? 1 : a.doc.created < b.doc.created ? -1 : a.name.localeCompare(b.name)))
}

// Completion self-attestation gate: one passing entry per criterion of the
// current document, matched verbatim (whitespace-insensitive). Returns the
// failure list; empty means the gate may proceed.
export function completeCheckFailures(
  doc: GoalDoc,
  attestations: Array<{ criterion: string; pass: boolean; evidence: string }>,
): string[] {
  const failures: string[] = []
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const byCriterion = new Map(attestations.map((a) => [norm(a.criterion), a]))
  doc.criteria.forEach((criterion, i) => {
    const a = byCriterion.get(norm(criterion))
    if (!a) {
      failures.push(`Success criterion ${i + 1} has no self-attestation: ${criterion}`)
    } else if (!a.pass) {
      failures.push(`Success criterion ${i + 1} attested as unmet: ${criterion} (evidence: ${a.evidence || "none"})`)
    }
  })
  if (attestations.length > doc.criteria.length) {
    failures.push(`${attestations.length - doc.criteria.length} attestation(s) do not match any criterion of revision ${doc.revision}`)
  }
  return failures
}
