import test from "node:test"
import assert from "node:assert/strict"

import {
  slugify,
  localDate,
  planFileName,
  renderPlan,
  parsePlan,
  parsePlanLoose,
  tickTask,
  transitionStatus,
  progressOf,
  closeCheckFailures,
  rankActivePlans,
  isTerminal,
  canTransition,
  PlanError,
} from "../src/plan-file.ts"

const NOW = "2026-09-25T10:00:00+08:00"

function sampleInput(overrides = {}) {
  return {
    goal: "Fix the login timeout",
    context: "src/auth/login.ts:42: the timeout does not cover the retry path; repro: three wrong passwords in a row.",
    approach: "Chosen: add a 3s timeout to the retry branch with tests; rejected: a global timeout middleware (blast radius too large).",
    tasks: ["Locate the retry branch", "Add the timeout logic", "Add unit tests"],
    risks: "Promise timeout compatibility on older browsers.",
    acceptance: ["The login retry path has timeout protection", "Unit tests cover the retry-timeout scenario"],
    nonGoals: ["No changes to the registration flow"],
    ...overrides,
  }
}

test("slugify: English goal becomes kebab-case", () => {
  assert.equal(slugify("Fix the Login Timeout Bug!!"), "fix-the-login-timeout-bug")
})

test("slugify: CJK goal keeps contiguous CJK runs", () => {
  assert.equal(slugify("修复登录超时"), "修复登录超时")
  assert.equal(slugify("修复 登录: 超时/重试"), "修复-登录-超时-重试")
})

test("slugify: empty result falls back to plan; long goals truncate", () => {
  assert.equal(slugify("!!!???"), "plan")
  assert.ok(slugify("a".repeat(60)).length <= 32)
})

test("planFileName: same-day slug collisions get a suffix", () => {
  const date = localDate(new Date("2026-09-25T00:00:00"))
  const existing = [`${date}-fix-login.md`]
  assert.equal(planFileName(date, "fix-login", existing), `${date}-fix-login-2.md`)
  assert.equal(planFileName(date, "fix-login", [...existing, `${date}-fix-login-2.md`]), `${date}-fix-login-3.md`)
  assert.equal(planFileName(date, "other", existing), `${date}-other.md`)
})

test("renderPlan -> parsePlan roundtrip: sections, tasks, acceptance intact", () => {
  const text = renderPlan(sampleInput(), NOW)
  const doc = parsePlan(text)
  assert.equal(doc.status, "draft")
  assert.equal(doc.created, NOW)
  assert.equal(doc.goal, "Fix the login timeout")
  assert.equal(doc.tasks.length, 3)
  assert.deepEqual(doc.tasks.map((t) => t.done), [false, false, false])
  assert.equal(doc.acceptance.length, 2)
  for (const key of ["Goal", "Non-Goals", "Context Findings", "Approach and Alternatives", "Task List", "Risks", "Acceptance Criteria"]) {
    assert.ok(doc.sections.has(key), `missing section ${key}`)
  }
})

test("legacy plans with Chinese section headers still parse", () => {
  const legacy = [
    "---",
    "status: draft",
    `created: ${NOW}`,
    `updated: ${NOW}`,
    "goal: 修复登录超时",
    "---",
    "",
    "## 目标",
    "",
    "修复登录超时",
    "",
    "## 非目标",
    "",
    "（本次任务未声明非目标）",
    "",
    "## 上下文发现",
    "",
    "src/auth/login.ts:42 未覆盖重试路径。",
    "",
    "## 方案与备选",
    "",
    "给 retry 分支补 3s 超时并测试。",
    "",
    "## 任务清单",
    "",
    "- [ ] 1. 定位重试分支",
    "- [x] 2. 补超时逻辑 <!-- ticked: 2026-09-25T11:00:00+08:00 -->",
    "",
    "## 风险",
    "",
    "旧浏览器兼容性。",
    "",
    "## 验收标准",
    "",
    "1. 登录重试路径有超时保护",
    "2. 单测覆盖重试超时场景",
    "",
  ].join("\n")
  const doc = parsePlan(legacy)
  assert.equal(doc.status, "draft")
  assert.equal(doc.goal, "修复登录超时")
  assert.equal(doc.tasks.length, 2)
  assert.equal(doc.tasks[1].done, true)
  assert.equal(doc.tasks[1].tickedAt, "2026-09-25T11:00:00+08:00")
  assert.equal(doc.acceptance.length, 2)
  // Tick and transition work on legacy documents too (same canonical keys).
  const ticked = tickTask(legacy, 1, "2026-09-25T11:30:00+08:00")
  assert.equal(parsePlan(ticked).tasks[0].done, true)
  const approved = transitionStatus(legacy, "approved", "2026-09-25T11:31:00+08:00")
  assert.equal(parsePlan(approved).status, "approved")
})

test("renderPlan: missing fields rejected wholesale with the missing list", () => {
  assert.throws(() => renderPlan({ ...sampleInput(), acceptance: [] }, NOW), PlanError)
  const bad = { ...sampleInput(), risks: "  " }
  assert.throws(
    () => renderPlan(bad, NOW),
    (e) => e instanceof PlanError && e.message.includes("risks"),
  )
  assert.throws(
    () => renderPlan({ ...sampleInput(), tasks: ["", "  "] }, NOW),
    (e) => e.message.includes("tasks"),
  )
})

test("parsePlan: missing section and duplicate task number rejected", () => {
  const text = renderPlan(sampleInput(), NOW)
  assert.throws(() => parsePlan(text.replace("## Risks", "## Other")), PlanError)
  const dup = text.replace("- [ ] 2. Add the timeout logic", "- [ ] 1. Add the timeout logic")
  assert.throws(() => parsePlan(dup), /Duplicate/)
  assert.equal(parsePlanLoose("not a plan at all"), null)
})

test("tickTask: successful tick stamps a timestamp and updates updated", () => {
  const text = renderPlan(sampleInput(), NOW)
  const next = tickTask(text, 2, "2026-09-25T11:00:00+08:00")
  const doc = parsePlan(next)
  assert.equal(doc.tasks[1].done, true)
  assert.equal(doc.tasks[1].tickedAt, "2026-09-25T11:00:00+08:00")
  assert.equal(doc.updated, "2026-09-25T11:00:00+08:00")
  assert.deepEqual(progressOf(doc), { total: 3, done: 1 })
})

test("tickTask: unknown number / duplicate tick both throw and change nothing", () => {
  const text = renderPlan(sampleInput(), NOW)
  assert.throws(() => tickTask(text, 9, NOW), /does not exist/)
  const ticked = tickTask(text, 1, NOW)
  assert.throws(() => tickTask(ticked, 1, NOW), /already ticked/)
  assert.equal(parsePlan(ticked).tasks[0].done, true)
})

test("transitionStatus: legal and illegal transitions", () => {
  const text = renderPlan(sampleInput(), NOW)
  const approved = transitionStatus(text, "approved", "2026-09-25T11:30:00+08:00")
  assert.equal(parsePlan(approved).status, "approved")
  const done = transitionStatus(approved, "done", "2026-09-25T12:00:00+08:00")
  assert.equal(parsePlan(done).status, "done")
  assert.ok(isTerminal("done") && isTerminal("abandoned"))
  assert.ok(!isTerminal("draft") && !isTerminal("approved"))
  assert.throws(() => transitionStatus(text, "done", NOW), /Illegal/)
  assert.throws(() => transitionStatus(done, "approved", NOW), /Illegal/)
  const abandoned = transitionStatus(text, "abandoned", NOW)
  assert.equal(parsePlan(abandoned).status, "abandoned")
  assert.throws(() => transitionStatus(abandoned, "approved", NOW), /Illegal/)
  assert.ok(canTransition("draft", "approved") && canTransition("approved", "abandoned"))
  assert.ok(!canTransition("done", "abandoned"))
})

test("closeCheckFailures: unticked, missing check, failing check, all-pass", () => {
  const text = renderPlan(sampleInput(), NOW)
  const doc = parsePlan(text)
  const [c1, c2] = doc.acceptance
  // unticked tasks remain
  assert.ok(closeCheckFailures(doc, []).some((f) => f.includes("Unticked")))
  // all ticked but a criterion has no self-check
  let ticked = text
  for (let i = 1; i <= 3; i++) ticked = tickTask(ticked, i, NOW)
  const docAll = parsePlan(ticked)
  assert.ok(closeCheckFailures(docAll, [{ criterion: c1, pass: true, evidence: "e1" }]).some((f) => f.includes("no self-check")))
  // a failing self-check
  const fail = closeCheckFailures(docAll, [
    { criterion: c1, pass: true, evidence: "e1" },
    { criterion: c2, pass: false, evidence: "not verified yet" },
  ])
  assert.ok(fail.some((f) => f.includes("failed")))
  // all pass
  assert.deepEqual(
    closeCheckFailures(docAll, [
      { criterion: c1, pass: true, evidence: "e1" },
      { criterion: c2, pass: true, evidence: "e2" },
    ]),
    [],
  )
})

test("rankActivePlans: non-terminal by updated desc; terminal and garbage excluded", () => {
  const mk = (status, updated, name) => {
    const base = renderPlan(sampleInput(), updated)
    return { name, text: base.replace(/^status: draft$/m, `status: ${status}`) }
  }
  const ranked = rankActivePlans([
    mk("done", "2026-09-25T09:00:00+08:00", "a-done.md"),
    mk("approved", "2026-09-25T08:00:00+08:00", "b-approved.md"),
    mk("draft", "2026-09-25T09:30:00+08:00", "c-draft.md"),
    mk("abandoned", "2026-09-25T09:59:00+08:00", "d-abandoned.md"),
    { name: "e-garbage.md", text: "junk" },
  ])
  assert.deepEqual(ranked.map((r) => r.name), ["c-draft.md", "b-approved.md"])
  assert.deepEqual(rankActivePlans([]), [])
})
