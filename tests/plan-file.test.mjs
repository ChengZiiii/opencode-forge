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
    goal: "修复登录超时",
    context: "src/auth/login.ts:42 的超时未覆盖重试路径；重现：连续输错三次密码。",
    approach: "首选：给 retry 分支补 3s 超时并测试；备选：全局中间件统一超时（被否：影响面过大）。",
    tasks: ["定位重试分支", "补超时逻辑", "补单测"],
    risks: "旧浏览器 Promise 超时兼容性。",
    acceptance: ["登录重试路径有超时保护", "单测覆盖重试超时场景"],
    nonGoals: ["不改注册流程"],
    ...overrides,
  }
}

test("slugify: 英文目标转 kebab", () => {
  assert.equal(slugify("Fix the Login Timeout Bug!!"), "fix-the-login-timeout-bug")
})

test("slugify: 中文目标保留 CJK 连续段", () => {
  assert.equal(slugify("修复登录超时"), "修复登录超时")
  assert.equal(slugify("修复 登录: 超时/重试"), "修复-登录-超时-重试")
})

test("slugify: 空结果回退 plan、超长截断", () => {
  assert.equal(slugify("!!!???"), "plan")
  assert.ok(slugify("a".repeat(60)).length <= 32)
})

test("planFileName: 同日同 slug 冲突追加序号", () => {
  const date = localDate(new Date("2026-09-25T00:00:00"))
  const existing = [`${date}-fix-login.md`]
  assert.equal(planFileName(date, "fix-login", existing), `${date}-fix-login-2.md`)
  assert.equal(planFileName(date, "fix-login", [...existing, `${date}-fix-login-2.md`]), `${date}-fix-login-3.md`)
  assert.equal(planFileName(date, "other", existing), `${date}-other.md`)
})

test("renderPlan -> parsePlan 往返：章节、任务、验收齐全", () => {
  const text = renderPlan(sampleInput(), NOW)
  const doc = parsePlan(text)
  assert.equal(doc.status, "draft")
  assert.equal(doc.created, NOW)
  assert.equal(doc.goal, "修复登录超时")
  assert.equal(doc.tasks.length, 3)
  assert.deepEqual(doc.tasks.map((t) => t.done), [false, false, false])
  assert.equal(doc.acceptance.length, 2)
  for (const key of ["目标", "非目标", "上下文发现", "方案与备选", "任务清单", "风险", "验收标准"]) {
    assert.ok(doc.sections.has(key), `缺少章节 ${key}`)
  }
})

test("renderPlan：缺字段整体拒绝并列出缺失项", () => {
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

test("parsePlan：章节缺失与任务编号重复被拒", () => {
  const text = renderPlan(sampleInput(), NOW)
  assert.throws(() => parsePlan(text.replace("## 风险", "## 其他")), PlanError)
  const dup = text.replace("- [ ] 2. 补超时逻辑", "- [ ] 1. 补超时逻辑")
  assert.throws(() => parsePlan(dup), /重复/)
  assert.equal(parsePlanLoose("not a plan at all"), null)
})

test("tickTask：成功打勾带时间戳并更新 updated", () => {
  const text = renderPlan(sampleInput(), NOW)
  const next = tickTask(text, 2, "2026-09-25T11:00:00+08:00")
  const doc = parsePlan(next)
  assert.equal(doc.tasks[1].done, true)
  assert.equal(doc.tasks[1].tickedAt, "2026-09-25T11:00:00+08:00")
  assert.equal(doc.updated, "2026-09-25T11:00:00+08:00")
  assert.deepEqual(progressOf(doc), { total: 3, done: 1 })
})

test("tickTask：编号不存在 / 重复打勾均报错且不改内容", () => {
  const text = renderPlan(sampleInput(), NOW)
  assert.throws(() => tickTask(text, 9, NOW), /不存在/)
  const ticked = tickTask(text, 1, NOW)
  assert.throws(() => tickTask(ticked, 1, NOW), /重复/)
  assert.equal(parsePlan(ticked).tasks[0].done, true)
})

test("transitionStatus：合法与非法迁移", () => {
  const text = renderPlan(sampleInput(), NOW)
  const approved = transitionStatus(text, "approved", "2026-09-25T11:30:00+08:00")
  assert.equal(parsePlan(approved).status, "approved")
  const done = transitionStatus(approved, "done", "2026-09-25T12:00:00+08:00")
  assert.equal(parsePlan(done).status, "done")
  assert.ok(isTerminal("done") && isTerminal("abandoned"))
  assert.ok(!isTerminal("draft") && !isTerminal("approved"))
  assert.throws(() => transitionStatus(text, "done", NOW), /非法/)
  assert.throws(() => transitionStatus(done, "approved", NOW), /非法/)
  const abandoned = transitionStatus(text, "abandoned", NOW)
  assert.equal(parsePlan(abandoned).status, "abandoned")
  assert.throws(() => transitionStatus(abandoned, "approved", NOW), /非法/)
  assert.ok(canTransition("draft", "approved") && canTransition("approved", "abandoned"))
  assert.ok(!canTransition("done", "abandoned"))
})

test("closeCheckFailures：未勾、缺自检项、自检不过、全过", () => {
  const text = renderPlan(sampleInput(), NOW)
  const doc = parsePlan(text)
  const [c1, c2] = doc.acceptance
  // 有未勾任务
  assert.ok(closeCheckFailures(doc, []).some((f) => f.includes("未勾选")))
  // 全勾但缺自检项
  let ticked = text
  for (let i = 1; i <= 3; i++) ticked = tickTask(ticked, i, NOW)
  const docAll = parsePlan(ticked)
  assert.ok(closeCheckFailures(docAll, [{ criterion: c1, pass: true, evidence: "e1" }]).some((f) => f.includes("缺少自检项")))
  // 自检含未过项
  const fail = closeCheckFailures(docAll, [
    { criterion: c1, pass: true, evidence: "e1" },
    { criterion: c2, pass: false, evidence: "尚未验证" },
  ])
  assert.ok(fail.some((f) => f.includes("未通过")))
  // 全过
  assert.deepEqual(
    closeCheckFailures(docAll, [
      { criterion: c1, pass: true, evidence: "e1" },
      { criterion: c2, pass: true, evidence: "e2" },
    ]),
    [],
  )
})

test("rankActivePlans：非终态按 updated 倒序，终态与坏文件排除", () => {
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
