// Pure plan-file core for the forge plan harness.
//
// No @opencode-ai imports, no side effects: every function maps
// strings to strings (or throws PlanError). plugin.ts owns all fs I/O;
// tests import this module directly.
//
// Document shape (rendered by renderPlan, parsed by parsePlan):
//
//   ---
//   status: draft          # draft -> approved -> done; exits: abandoned, superseded
//   created: <ISO>
//   updated: <ISO>
//   goal: <one line>
//   ---
//   ## Goal / ## Non-Goals / ## Context Findings / ## Approach and
//   Alternatives / ## Task List / ## Risks / ## Acceptance Criteria
//
// Task lines:    "- [ ] 1. describe..."  ->  "- [x] 1. describe... <!-- ticked: ISO -->"
// Acceptance:    numbered "1. criterion" lines under Acceptance Criteria.
//
// Section headers match bilingually: English is canonical (renderPlan
// emits it); Chinese headers from plans written by earlier plugin
// versions still parse through SECTION_ALIASES.

export type PlanStatus = "draft" | "approved" | "done" | "abandoned" | "superseded"

export type PlanTask = {
  n: number
  done: boolean
  text: string
  tickedAt?: string
}

export type PlanDoc = {
  status: PlanStatus
  created: string
  updated: string
  goal: string
  sections: Map<string, string>
  tasks: PlanTask[]
  acceptance: string[]
  // Frozen verification checks (empty for legacy plans without the section);
  // the FILE is the frozen state — plan_close re-runs exactly these.
  checks: PlanCheck[]
}

export type PlanInput = {
  goal: string
  context: string
  approach: string
  tasks: string[]
  risks: string
  acceptance: string[]
  nonGoals?: string[]
  // plan-close-verified D1: optional structured verification checks,
  // goal-shaped but LOCALLY typed — this module shares nothing with
  // goal-file/run-check (decoupling red line); plugin.ts coerces the tool
  // rows and composes the runner. Structurally compatible with the goal
  // CheckItem so the plugin layer needs no mapping code.
  checks?: PlanCheck[]
}

// Rendered as `## Verification Checks` items (goal-file line format, local
// regex copies — no cross-harness import):
//   1. shell `npm test` (timeout 120s)
//   2. contains `src/a.ts` :: `export const A`
export type PlanCheck =
  | { kind: "shell"; cmd: string; timeoutSec?: number }
  | { kind: "contains"; file: string; text: string }

export type CloseCheck = {
  criterion: string
  pass: boolean
  evidence: string
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanError"
  }
}

const TERMINAL: PlanStatus[] = ["done", "abandoned", "superseded"]

// Legal status transitions. draft -> approved (user gate), approved -> done
// (plugin-verified completion gate), either active state -> abandoned
// (discard) or -> superseded (discard {supersede}: the work moved to another
// harness). done -> approved is the plan_reopen rollback window (the ONLY
// done exit; explicit user instruction, discipline layer — no modal).
const LEGAL_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ["approved", "abandoned", "superseded"],
  approved: ["done", "abandoned", "superseded"],
  done: ["approved"],
  abandoned: [],
  superseded: [],
}

const SECTION_ORDER = [
  "Goal",
  "Non-Goals",
  "Context Findings",
  "Approach and Alternatives",
  "Task List",
  "Risks",
  "Acceptance Criteria",
] as const

// Canonical English headers; Chinese aliases keep plans written by earlier
// plugin versions (which rendered Chinese headers) loadable.
const SECTION_ALIASES: Record<string, RegExp> = {
  Goal: /^(#*)\s*(goal|目标)\s*$/i,
  "Non-Goals": /^(#*)\s*(non-goals?|out of scope|非目标)\s*$/i,
  "Context Findings": /^(#*)\s*(context( findings?)?|findings|上下文发现|上下文)\s*$/i,
  "Approach and Alternatives": /^(#*)\s*(approach( and alternatives)?|方案与备选|方案)\s*$/i,
  "Task List": /^(#*)\s*(tasks?|task list|任务清单|任务)\s*$/i,
  Risks: /^(#*)\s*(risks?|风险)\s*$/i,
  "Acceptance Criteria": /^(#*)\s*(acceptance criteria|验收标准|验收)\s*$/i,
  // plan-close-verified D1: optional sections, NOT in SECTION_ORDER (legacy
  // plans predate them) — claiming them here keeps their "- <ISO> run=..." /
  // "1. shell `...`" lines out of Acceptance Criteria (first-section-wins).
  "Verification Checks": /^(#*)\s*(verification checks|验证检查)\s*$/i,
  "Check Log": /^(#*)\s*(check log|检查日志)\s*$/i,
}

export function isTerminal(status: string): boolean {
  return (TERMINAL as string[]).includes(status)
}

export function canTransition(from: string, to: string): boolean {
  const legal = LEGAL_TRANSITIONS[from as PlanStatus]
  return Array.isArray(legal) && legal.includes(to as PlanStatus)
}

// kebab-case slug from the goal: keep [a-z0-9] and CJK runs as segments,
// everything else is a separator. Empty result falls back to "plan".
// Truncated to 32 chars so filenames stay reasonable.
export function slugify(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "")
  return slug || "plan"
}

export function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// "<date>-<slug>.md"; same-day slug collisions get -2, -3, ... appended.
export function planFileName(date: string, slug: string, existingNames: string[] = []): string {
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

export function validatePlanInput(input: Partial<PlanInput>): string[] {
  const missing: string[] = []
  const reqStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0
  if (!reqStr(input.goal)) missing.push("goal")
  if (!reqStr(input.context)) missing.push("context")
  if (!reqStr(input.approach)) missing.push("approach")
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || !input.tasks.every(reqStr)) {
    missing.push("tasks (at least one non-empty task)")
  }
  if (!reqStr(input.risks)) missing.push("risks")
  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0 || !input.acceptance.every(reqStr)) {
    missing.push("acceptance (at least one criterion)")
  }
  return missing
}

function frontmatterBlock(status: PlanStatus, created: string, updated: string, goal: string): string {
  const goalLine = goal.replace(/\r?\n/g, " ").trim()
  return [
    "---",
    `status: ${status}`,
    `created: ${created}`,
    `updated: ${updated}`,
    `goal: ${goalLine}`,
    "---",
    "",
  ].join("\n")
}

export function renderPlan(input: PlanInput, now: string, createdOverride?: string): string {
  const missing = validatePlanInput(input)
  if (missing.length > 0) {
    throw new PlanError(`Plan content incomplete; missing: ${missing.join(", ")}`)
  }
  const goal = input.goal.trim()
  const nonGoals = (input.nonGoals ?? []).filter((s) => s.trim().length > 0)
  const parts: string[] = [
    frontmatterBlock("draft", createdOverride ?? now, now, goal),
    "## Goal",
    "",
    goal,
    "",
    "## Non-Goals",
    "",
    nonGoals.length > 0 ? nonGoals.map((s) => `- ${s.trim()}`).join("\n") : "(no non-goals declared for this task)",
    "",
    "## Context Findings",
    "",
    input.context.trim(),
    "",
    "## Approach and Alternatives",
    "",
    input.approach.trim(),
    "",
    "## Task List",
    "",
    input.tasks.map((t, i) => `- [ ] ${i + 1}. ${t.trim()}`).join("\n"),
    "",
    "## Risks",
    "",
    input.risks.trim(),
    "",
    "## Acceptance Criteria",
    "",
    input.acceptance.map((a, i) => `${i + 1}. ${a.trim()}`).join("\n"),
    "",
  ]
  const checks = input.checks ?? []
  if (checks.length > 0) {
    parts.push(
      "## Verification Checks",
      "",
      checks.map((c, i) => `${i + 1}. ${renderPlanCheck(c)}`).join("\n"),
      "",
      "## Check Log",
      "",
      "(no checks recorded yet)",
      "",
    )
  }
  return parts.join("\n")
}

// Local render/parse copies of the goal check-line format (the plan core
// intentionally shares no module with the goal core — decoupling red line).
function renderPlanCheck(item: PlanCheck): string {
  if (item.kind === "shell") {
    const t = item.timeoutSec ?? 120
    return `shell \`${item.cmd}\` (timeout ${t}s)`
  }
  return `contains \`${item.file}\` :: \`${item.text}\``
}

const PLAN_SHELL_LINE_RE = /^\s*(\d+)[.、)]\s*shell\s+`([^`]*)`(?:\s+\(timeout\s+(\d+)s?\))?$/i
const PLAN_CONTAINS_LINE_RE = /^\s*(\d+)[.、)]\s*contains\s+`([^`]*)`\s*::\s*`([^`]*)`$/i

function parseChecksSection(section: string): PlanCheck[] {
  const checks: PlanCheck[] = []
  const seen = new Set<number>()
  for (const line of section.split(/\r?\n/)) {
    const shell = line.match(PLAN_SHELL_LINE_RE)
    if (shell) {
      if (seen.has(Number(shell[1]))) throw new PlanError(`Duplicate verification item number: ${shell[1]}`)
      seen.add(Number(shell[1]))
      checks.push({ kind: "shell", cmd: shell[2], ...(shell[3] ? { timeoutSec: Number(shell[3]) } : {}) })
      continue
    }
    const contains = line.match(PLAN_CONTAINS_LINE_RE)
    if (contains) {
      if (seen.has(Number(contains[1]))) throw new PlanError(`Duplicate verification item number: ${contains[1]}`)
      seen.add(Number(contains[1]))
      checks.push({ kind: "contains", file: contains[2], text: contains[3] })
    }
  }
  return checks
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) throw new PlanError("plan file is missing frontmatter")
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
  for (const key of Object.keys(SECTION_ALIASES)) {
    if (SECTION_ALIASES[key].test(trimmed)) return key
  }
  return null
}

function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  const claimed = new Set<string>()
  let current: string | null = null
  const buf: string[] = []
  const flush = () => {
    if (current !== null) sections.set(current, buf.join("\n").trim())
    buf.length = 0
  }
  // First-section-wins: a section key is owned by its FIRST header only.
  // A later header repeating an already-claimed key is inert prose: it folds
  // into the current section's text and never re-opens (or overwrites) the
  // section, so verbatim free text quoting plan-shaped headers (e.g. a
  // terminal-narrative reason containing "## Task List") can neither throw
  // parsePlan nor drift tick counts (parser-inertness contract).
  for (const line of body.split(/\r?\n/)) {
    const header = matchSectionHeader(line)
    if (header === null || claimed.has(header)) {
      if (current !== null) buf.push(line)
      continue
    }
    flush()
    claimed.add(header)
    current = header
  }
  flush()
  return sections
}

const TASK_RE = /^-\s*\[([ xX])\]\s*(\d+)\.\s*(.*)$/
const TICKED_RE = /<!--\s*ticked:\s*([^>]*?)\s*-->/
const ACCEPT_RE = /^\s*(\d+)[.、)]\s*(.+)$/

export function parsePlan(text: string): PlanDoc {
  const { fm, body } = parseFrontmatter(text)
  const status = (fm.status ?? "draft") as PlanStatus
  if (!["draft", "approved", "done", "abandoned", "superseded"].includes(status)) {
    throw new PlanError(`Unknown plan status: ${fm.status}`)
  }
  const sections = splitSections(body)
  for (const key of SECTION_ORDER) {
    if (!sections.has(key)) {
      throw new PlanError(`Plan is missing section: ${key}`)
    }
  }
  const tasks: PlanTask[] = []
  const seen = new Set<number>()
  for (const line of (sections.get("Task List") ?? "").split(/\r?\n/)) {
    const m = line.match(TASK_RE)
    if (!m) continue
    const n = Number(m[2])
    if (seen.has(n)) throw new PlanError(`Duplicate task number: ${n}`)
    seen.add(n)
    const ticked = m[3].match(TICKED_RE)
    tasks.push({
      n,
      done: m[1].toLowerCase() === "x",
      text: m[3].replace(TICKED_RE, "").trim(),
      ...(ticked ? { tickedAt: ticked[1] } : {}),
    })
  }
  if (tasks.length === 0) throw new PlanError("Task list is empty or malformed")
  const acceptance: string[] = []
  for (const line of (sections.get("Acceptance Criteria") ?? "").split(/\r?\n/)) {
    const m = line.match(ACCEPT_RE)
    if (m) acceptance.push(m[2].trim())
  }
  const checks = parseChecksSection(sections.get("Verification Checks") ?? "")
  return {
    status,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    goal: fm.goal ?? "",
    sections,
    tasks,
    acceptance,
    checks,
  }
}

export function parsePlanLoose(text: string): PlanDoc | null {
  try {
    return parsePlan(text)
  } catch {
    return null
  }
}

function setUpdated(text: string, now: string): string {
  if (/^updated:.*$/m.test(text)) {
    return text.replace(/^updated:.*$/m, `updated: ${now}`)
  }
  return text.replace(/^---\r?\n/, `---\nupdated: ${now}\n`)
}

// Ticks task n: [ ] -> [x] plus a ticked-timestamp comment on the same line.
// Throws when n is missing or already ticked; file changes only on success.
export function tickTask(text: string, n: number, now: string): string {
  const lines = text.split(/\r?\n/)
  let found = false
  const out = lines.map((line) => {
    if (found) return line
    const m = line.match(TASK_RE)
    if (!m || Number(m[2]) !== n) return line
    if (m[1].toLowerCase() === "x") {
      throw new PlanError(`Task ${n} is already ticked; refusing duplicate tick`)
    }
    found = true
    const body = m[3].replace(TICKED_RE, "").trim()
    return `- [x] ${n}. ${body} <!-- ticked: ${now} -->`
  })
  if (!found) throw new PlanError(`Task number ${n} does not exist`)
  return setUpdated(out.join("\n"), now)
}

export function transitionStatus(text: string, to: PlanStatus, now: string): string {
  const { fm } = parseFrontmatter(text)
  const from = (fm.status ?? "draft") as PlanStatus
  if (from === to) throw new PlanError(`Plan is already ${to}`)
  if (!canTransition(from, to)) {
    throw new PlanError(
      `Illegal status transition: ${from} -> ${to} (legal path: draft -> approved -> done; done -> approved via plan_reopen; draft/approved -> abandoned/superseded)`,
    )
  }
  const next = text.replace(/^status:.*$/m, `status: ${to}`)
  return setUpdated(next, now)
}

export type TerminalKind = "closed" | "abandoned" | "superseded"

export type TerminalSectionOptions = {
  reason?: string
  successor?: string
  checks?: CloseCheck[]
  // plan-close-verified D3: structured-path evidence summary — one
  // `OK|FAIL (ms)` line per re-run frozen check plus its truncated output
  // (limit passed by the plugin layer; the pure core imports nothing).
  outcomes?: Array<{ index: number; ok: boolean; label: string; detail: string; durationMs: number }>
  outcomeOutputLimit?: number
}

// Terminal lifecycle narrative (spec: "Terminal lifecycle narrative"): builds
// a dated `## <now> — <kind>` section and appends it at END of file, returning
// the new text. No fs here: the caller persists the returned text in the SAME
// write as the frontmatter status flip (one atomic file replacement).
//
// Parser-inertness contract: the section never emits lines the plan parser
// would misread (checkbox "- [x] N." / numbered "N." line starts, section
// alias headers), so status (frontmatter-only) and tick counts (Task
// List-only) stay unaffected no matter what the narrative carries.
//
// D4: the narrative is mandatory, the reason is best-effort — a missing
// reason lands as an explicit `reason: (none given)` marker; the transition
// never happens silently.
export function appendTerminalSection(
  text: string,
  kind: TerminalKind,
  opts: TerminalSectionOptions = {},
  now: string = new Date().toISOString(),
): string {
  if (!["closed", "abandoned", "superseded"].includes(kind)) {
    throw new PlanError(`Unknown terminal section kind: ${kind}`)
  }
  const lines: string[] = [`## ${now} — ${kind}`, ""]
  const reason = (opts.reason ?? "").trim()
  lines.push(`reason: ${reason.length > 0 ? reason : "(none given)"}`)
  const successor = (opts.successor ?? "").trim()
  if (successor.length > 0) lines.push(`successor: ${successor}`)
  if (opts.checks && opts.checks.length > 0) {
    lines.push("checks:")
    for (const c of opts.checks) {
      lines.push(`- ${c.pass ? "PASS" : "FAIL"} — ${c.criterion.trim()}`)
      lines.push(`  evidence: ${c.evidence.trim() || "(none)"}`)
    }
  }
  if (opts.outcomes && opts.outcomes.length > 0) {
    const limit = opts.outcomeOutputLimit ?? 2048
    lines.push("verification:")
    for (const o of opts.outcomes) {
      lines.push(`- #${o.index} ${o.ok ? "OK" : "FAIL"} (${o.durationMs}ms) \`${o.label.replace(/\r?\n/g, " ")}\``)
      const flat = (o.detail || "(no output)").replace(/\r?\n/g, " ")
      lines.push(`  output: ${flat.length > limit ? `${flat.slice(0, limit)}…` : flat}`)
    }
  }
  const base = text.replace(/\r?\n$/, "")
  return `${base}\n\n${lines.join("\n")}\n`
}

// plan-close-verified D5: dated reopen narrative — same shape/contract as
// appendTerminalSection (appended at END, parser-inert, persisted by the
// caller in the SAME atomic write as the done->approved frontmatter flip).
export function appendReopenSection(
  text: string,
  now: string = new Date().toISOString(),
  reason?: string,
): string {
  const lines: string[] = [`## ${now} — reopened`, ""]
  const r = (reason ?? "").trim()
  lines.push(`reason: ${r.length > 0 ? r : "(none given)"}`)
  const base = text.replace(/\r?\n$/, "")
  return `${base}\n\n${lines.join("\n")}\n`
}

// plan-close-verified D2/D3: append one audit line per outcome under the
// plan's `## Check Log` (the failing-run record of a refused close), the
// goal-file line format with a LOCAL detail cap — the pure core imports no
// goal constant. runId makes re-appends of the same run idempotent.
export function appendPlanCheckLog(
  text: string,
  runId: string,
  outcomes: Array<{ index: number; ok: boolean; detail: string; durationMs?: number; label: string }>,
  now: string,
  detailLimit = 400,
): string {
  const doc = parsePlan(text)
  const existing = new Set(
    (doc.sections.get("Check Log") ?? "")
      .split(/\r?\n/)
      .map((l) => l.match(/^-\s*\S+\s+run=(\S+)\s+(#\d+)\s+/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => `${m[1]} ${m[2]}`),
  )
  const add = outcomes
    .filter((o) => !existing.has(`${runId} #${o.index}`))
    .map((o) => {
      const label = o.label.replace(/\r?\n/g, " ")
      const flat = (o.detail || "(no output)").replace(/\r?\n/g, " ")
      const detail = flat.length > detailLimit ? `${flat.slice(0, detailLimit)}…` : flat
      return `- ${now} run=${runId} #${o.index} ${o.ok ? "OK" : "FAIL"} (${o.durationMs ?? 0}ms) \`${label}\` :: ${detail}`
    })
  if (add.length === 0) return setUpdated(text, now)
  const lines = text.split(/\r?\n/)
  const logHeaderIdx = lines.findIndex((l) => SECTION_ALIASES["Check Log"].test(l.trim()))
  if (logHeaderIdx === -1) throw new PlanError("Plan is missing section: Check Log")
  const placeholderIdx = lines.indexOf("(no checks recorded yet)", logHeaderIdx)
  if (placeholderIdx !== -1 && placeholderIdx < logHeaderIdx + 4) lines.splice(placeholderIdx, 1)
  let lastLog = -1
  for (let i = logHeaderIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) lastLog = i
    else if (lines[i].trim() !== "") break
  }
  const at = lastLog === -1 ? logHeaderIdx + 2 : lastLog + 1
  lines.splice(at, 0, ...add)
  return setUpdated(lines.join("\n"), now)
}

export function progressOf(doc: PlanDoc): { total: number; done: number } {
  return { total: doc.tasks.length, done: doc.tasks.filter((t) => t.done).length }
}

// Close verification: every task ticked, every acceptance criterion covered
// by a passing check (criterion text matched whitespace-insensitively).
// Returns the list of failures; empty list means the close may proceed.
export function closeCheckFailures(doc: PlanDoc, checks: CloseCheck[]): string[] {
  const failures: string[] = []
  const unticked = doc.tasks.filter((t) => !t.done).map((t) => t.n)
  if (unticked.length > 0) {
    failures.push(`Unticked tasks remain: ${unticked.join(", ")}`)
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const byCriterion = new Map(checks.map((c) => [norm(c.criterion), c]))
  doc.acceptance.forEach((criterion, i) => {
    const check = byCriterion.get(norm(criterion))
    if (!check) {
      failures.push(`Acceptance criterion ${i + 1} has no self-check: ${criterion}`)
    } else if (!check.pass) {
      failures.push(`Acceptance criterion ${i + 1} self-check failed: ${criterion} (evidence: ${check.evidence || "none"})`)
    }
  })
  return failures
}

// Active-plan discovery over in-memory {name, text} pairs (plugin.ts does fs):
// non-terminal plans, newest `updated` first.
export function rankActivePlans(entries: Array<{ name: string; text: string }>): Array<{ name: string; doc: PlanDoc }> {
  return entries
    .map((e) => ({ name: e.name, doc: parsePlanLoose(e.text) }))
    .filter((e): e is { name: string; doc: PlanDoc } => e.doc !== null && !isTerminal(e.doc.status))
    .sort((a, b) => (a.doc.updated < b.doc.updated ? 1 : a.doc.updated > b.doc.updated ? -1 : a.name.localeCompare(b.name)))
}
