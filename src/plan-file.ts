// Pure plan-file core for the forge plan harness.
//
// No @opencode-ai imports, no side effects: every function maps
// strings to strings (or throws PlanError). plugin.ts owns all fs I/O;
// tests import this module directly.
//
// Document shape (rendered by renderPlan, parsed by parsePlan):
//
//   ---
//   status: draft          # draft -> approved -> done; exit: abandoned
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

export type PlanStatus = "draft" | "approved" | "done" | "abandoned"

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
}

export type PlanInput = {
  goal: string
  context: string
  approach: string
  tasks: string[]
  risks: string
  acceptance: string[]
  nonGoals?: string[]
}

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

const TERMINAL: PlanStatus[] = ["done", "abandoned"]

// Legal status transitions. draft -> approved (user gate), approved -> done
// (user gate after self-check), either active state -> abandoned (discard).
const LEGAL_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ["approved", "abandoned"],
  approved: ["done", "abandoned"],
  done: [],
  abandoned: [],
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
  return parts.join("\n")
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

const TASK_RE = /^-\s*\[([ xX])\]\s*(\d+)\.\s*(.*)$/
const TICKED_RE = /<!--\s*ticked:\s*([^>]*?)\s*-->/
const ACCEPT_RE = /^\s*(\d+)[.、)]\s*(.+)$/

export function parsePlan(text: string): PlanDoc {
  const { fm, body } = parseFrontmatter(text)
  const status = (fm.status ?? "draft") as PlanStatus
  if (!["draft", "approved", "done", "abandoned"].includes(status)) {
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
  return {
    status,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    goal: fm.goal ?? "",
    sections,
    tasks,
    acceptance,
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
      `Illegal status transition: ${from} -> ${to} (legal path: draft -> approved -> done; draft/approved -> abandoned)`,
    )
  }
  const next = text.replace(/^status:.*$/m, `status: ${to}`)
  return setUpdated(next, now)
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
