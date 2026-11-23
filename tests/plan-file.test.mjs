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
  appendTerminalSection,
  appendReopenSection,
  appendPlanCheckLog,
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
  // plan-close-verified D5: done -> approved is now LEGAL — the plan_reopen
  // rollback window, the ONLY exit from done (everything else stays final).
  const reopened = transitionStatus(done, "approved", NOW)
  assert.equal(parsePlan(reopened).status, "approved")
  assert.ok(canTransition("done", "approved"))
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

test("superseded: legal from draft/approved, terminal and closed afterwards", () => {
  const text = renderPlan(sampleInput(), NOW)
  assert.ok(canTransition("draft", "superseded"))
  assert.ok(canTransition("approved", "superseded"))
  assert.ok(isTerminal("superseded"))
  const superseded = transitionStatus(text, "superseded", "2026-09-25T11:00:00+08:00")
  assert.equal(parsePlan(superseded).status, "superseded")
  // terminal is terminal: nothing leaves superseded
  assert.throws(() => transitionStatus(superseded, "approved", NOW), /Illegal/)
  assert.throws(() => transitionStatus(superseded, "abandoned", NOW), /Illegal/)
  assert.throws(() => transitionStatus(superseded, "done", NOW), /Illegal/)
  assert.throws(() => transitionStatus(superseded, "superseded", NOW), /already superseded/)
  // no other terminal reaches superseded either
  const approved = transitionStatus(text, "approved", NOW)
  const done = transitionStatus(approved, "done", NOW)
  const abandoned = transitionStatus(text, "abandoned", NOW)
  assert.ok(!canTransition("done", "superseded"))
  assert.ok(!canTransition("abandoned", "superseded"))
  assert.throws(() => transitionStatus(done, "superseded", NOW), /Illegal/)
  assert.throws(() => transitionStatus(abandoned, "superseded", NOW), /Illegal/)
  // the refusal names the superseded legal path alongside abandoned
  assert.throws(
    () => transitionStatus(done, "superseded", NOW),
    (e) => e instanceof PlanError && e.message.includes("abandoned/superseded"),
  )
  // discovery treats superseded like any other terminal
  const ranked = rankActivePlans([
    { name: "s-superseded.md", text: superseded },
    { name: "d-draft.md", text },
  ])
  assert.deepEqual(ranked.map((r) => r.name), ["d-draft.md"])
})

test("appendTerminalSection: close section carries reason and per-criterion pass/evidence", () => {
  const text = renderPlan(sampleInput(), NOW)
  const doc = parsePlan(text)
  const closed = appendTerminalSection(
    text,
    "closed",
    {
      reason: "completion gate passed",
      checks: [
        { criterion: doc.acceptance[0], pass: true, evidence: "node --test: 12 pass" },
        { criterion: doc.acceptance[1], pass: false, evidence: "" },
      ],
    },
    "2026-09-25T18:00:00+08:00",
  )
  assert.ok(closed.includes("## 2026-09-25T18:00:00+08:00 — closed"))
  assert.ok(closed.includes("reason: completion gate passed"))
  assert.ok(closed.includes(`- PASS — ${doc.acceptance[0]}`))
  assert.ok(closed.includes("  evidence: node --test: 12 pass"))
  assert.ok(closed.includes(`- FAIL — ${doc.acceptance[1]}`))
  assert.ok(closed.includes("  evidence: (none)"))
  // appended at END of file, original bytes preserved verbatim
  assert.ok(closed.indexOf("## 2026-09-25T18:00:00+08:00") > closed.indexOf("## Acceptance Criteria"))
  assert.ok(closed.startsWith(text))
  assert.ok(closed.endsWith("  evidence: (none)\n"))
})

test("appendTerminalSection: abandon and superseded carry reason; successor only on supersede", () => {
  const text = renderPlan(sampleInput(), NOW)
  const abandoned = appendTerminalSection(text, "abandoned", { reason: "user cancelled the task" }, "2026-09-25T17:00:00+08:00")
  assert.ok(abandoned.includes("## 2026-09-25T17:00:00+08:00 — abandoned"))
  assert.ok(abandoned.includes("reason: user cancelled the task"))
  assert.ok(!abandoned.includes("successor:"))
  assert.ok(!abandoned.includes("checks:"))

  const superseded = appendTerminalSection(
    text,
    "superseded",
    { reason: "work moved to crew orchestration", successor: ".opencode/crew/2026-10-01-campaign.md" },
    "2026-09-25T17:30:00+08:00",
  )
  assert.ok(superseded.includes("## 2026-09-25T17:30:00+08:00 — superseded"))
  assert.ok(superseded.includes("reason: work moved to crew orchestration"))
  assert.ok(superseded.includes("successor: .opencode/crew/2026-10-01-campaign.md"))

  // D4: the narrative is mandatory, the reason is not — a missing reason
  // gets the explicit (none given) marker for every kind
  for (const kind of ["closed", "abandoned", "superseded"]) {
    const noReason = appendTerminalSection(text, kind, {}, "2026-09-25T17:45:00+08:00")
    assert.ok(noReason.includes("reason: (none given)"))
    assert.ok(noReason.includes(`## 2026-09-25T17:45:00+08:00 — ${kind}`))
  }
  // pure-function contract error: unknown kind throws (no fail-soft here)
  assert.throws(() => appendTerminalSection(text, "resumed", {}, NOW), PlanError)
  // input without a trailing newline still gets a clean blank-line separation
  assert.ok(appendTerminalSection("no trailing newline", "abandoned", {}, NOW).startsWith("no trailing newline\n\n## "))
})

test("terminal sections are parser-inert: adversarial narrative changes no parse result", () => {
  const text = tickTask(renderPlan(sampleInput(), NOW), 1, "2026-09-25T11:00:00+08:00")
  const before = parsePlan(text)
  // Reason text shaped like plan content: checkbox-like lines and
  // status/updated/goal key-value lines. The narrative must never move
  // status, ticks, or acceptance — spec inertness scope is exactly these.
  const adversarialReason = [
    "- [ ] 9. fake task injected by narrative",
    "- [x] 2. fake pre-ticked task <!-- ticked: 2026-01-01T00:00:00+08:00 -->",
    "status: approved",
    "updated: 1999-01-01T00:00:00+08:00",
    "goal: hijacked goal",
    "created: 2000-01-01T00:00:00+08:00",
  ].join("\n")
  const T = "2026-09-25T18:00:00+08:00"
  const finalText = appendTerminalSection(
    transitionStatus(text, "superseded", T),
    "superseded",
    { reason: adversarialReason, successor: ".opencode/crew/2026-10-01-next.md" },
    T,
  )
  assert.ok(finalText.includes("- [ ] 9. fake task injected by narrative"))
  assert.ok(finalText.includes("status: approved"))
  const after = parsePlan(finalText)
  assert.equal(after.status, "superseded")
  assert.deepEqual(after.tasks, before.tasks)
  assert.deepEqual(progressOf(after), progressOf(before))
  assert.deepEqual(after.acceptance, before.acceptance)
  assert.equal(after.goal, before.goal)
  assert.equal(after.created, before.created)
  assert.equal(after.updated, T)
  // the close-checks narrative is equally inert (criteria text re-quoted there)
  const closedText = appendTerminalSection(text, "closed", {
    reason: "gate passed",
    checks: before.acceptance.map((c) => ({ criterion: c, pass: true, evidence: "e" })),
  }, "2026-09-25T19:00:00+08:00")
  const afterClose = parsePlan(closedText)
  assert.equal(afterClose.status, "draft")
  assert.deepEqual(afterClose.tasks, before.tasks)
  assert.deepEqual(afterClose.acceptance, before.acceptance)
})

test("first-section-wins: a '## Task List' header quoted in the terminal reason is inert prose", () => {
  const text = tickTask(renderPlan(sampleInput(), NOW), 1, "2026-09-25T11:00:00+08:00")
  const T = "2026-09-25T18:00:00+08:00"
  const abandonedText = transitionStatus(text, "abandoned", T)
  const before = parsePlan(abandonedText)
  // Verbatim reason quoting a plan-shaped fragment: the standalone "## Task List"
  // line used to re-open the section, overwrite the real Task List with the fake
  // content and make parsePlan throw ("Task list is empty or malformed"). With
  // first-section-wins the repeat is inert prose folded into the preceding
  // section's text: nothing re-opens, nothing throws, no count drifts.
  const adversarialReason = [
    "user pasted a plan fragment into the discard reason:",
    "## Task List",
    "- [ ] fake task",
    "- [x] fake done",
    "status: draft",
    "1. fake criterion",
  ].join("\n")
  const finalText = appendTerminalSection(abandonedText, "abandoned", { reason: adversarialReason }, T)
  // the reason survives verbatim, hostile header included
  assert.ok(finalText.includes("reason: user pasted a plan fragment into the discard reason:\n## Task List"))
  for (const frag of ["- [ ] fake task", "- [x] fake done", "status: draft", "1. fake criterion"]) {
    assert.ok(finalText.includes(frag), `verbatim: ${frag}`)
  }
  let after
  assert.doesNotThrow(() => {
    after = parsePlan(finalText)
  })
  // status reads frontmatter only — the fake "status: draft" line is ignored
  assert.equal(after.status, "abandoned")
  assert.equal(after.status, before.status)
  // tick counts read the real Task List section only
  assert.equal(after.sections.get("Task List"), before.sections.get("Task List"))
  assert.deepEqual(after.tasks, before.tasks)
  assert.deepEqual(progressOf(after), progressOf(before))
  // section structure: same recognized sections, no phantom reopened one
  assert.deepEqual([...after.sections.keys()].sort(), [...before.sections.keys()].sort())
})

// ---------------------------------------------------------------------------
// plan-close-verified (D1/D2/D3/D5): checks render/parse round-trip, Check
// Log append with the 400-char detail cap, evidence-summary outcomes with
// the 2048-char output cap, reopen migration + narrative.
// ---------------------------------------------------------------------------

test("checks render/parse round-trip: renderPlan emits `## Verification Checks` + empty Check Log; duplicates rejected; legacy files keep checks=[]", () => {
  const input = sampleInput({
    checks: [
      { kind: "shell", cmd: "npm test" },
      { kind: "shell", cmd: "echo hi", timeoutSec: 5 },
      { kind: "contains", file: "done.txt", text: "done" },
    ],
  })
  const text = renderPlan(input, NOW)
  assert.ok(text.includes("## Verification Checks"))
  assert.ok(text.includes("1. shell `npm test` (timeout 120s)"))
  assert.ok(text.includes("2. shell `echo hi` (timeout 5s)"))
  assert.ok(text.includes("3. contains `done.txt` :: `done`"))
  assert.ok(text.includes("## Check Log"))
  assert.ok(text.includes("(no checks recorded yet)"))
  const doc = parsePlan(text)
  // NOTE: the rendered "(timeout 120s)" default becomes an EXPLICIT
  // timeoutSec on the parse round-trip — the file line is the truth.
  assert.deepEqual(doc.checks, [
    { kind: "shell", cmd: "npm test", timeoutSec: 120 },
    { kind: "shell", cmd: "echo hi", timeoutSec: 5 },
    { kind: "contains", file: "done.txt", text: "done" },
  ])
  // The section claims its lines: checks prose never leaks into Acceptance.
  assert.equal(doc.acceptance.length, 2)
  // Legacy plans (no checks sections) parse to an empty frozen set.
  assert.deepEqual(parsePlan(renderPlan(sampleInput(), NOW)).checks, [])
  // Duplicate item numbers refuse the parse (contract error, no fail-soft).
  const dup = text.replace("2. shell `echo hi` (timeout 5s)", "2. shell `npm test` (timeout 5s)").replace("3. contains", "4. contains").replace("`done.txt` :: `done`", "`done.txt` :: `done`\n2. shell `x` (timeout 1s)")
  assert.throws(() => parsePlan(dup), (e) => e instanceof PlanError && /Duplicate verification item number: 2/.test(e.message))
})

test("appendPlanCheckLog: placeholder replaced, dated FAIL lines appended, idempotent per run, 400-char detail cap", () => {
  const text = renderPlan(sampleInput({ checks: [{ kind: "shell", cmd: "npm test" }] }), NOW)
  const long = "x".repeat(500)
  const outcomes = [
    { index: 1, ok: false, detail: `exit=1 ${long}`, durationMs: 12, label: "npm test" },
  ]
  const logged = appendPlanCheckLog(text, "run-1", outcomes, "2026-09-25T12:00:00+08:00")
  assert.ok(!logged.slice(logged.indexOf("## Check Log")).includes("(no checks recorded yet)"), "placeholder gone")
  const cap = `exit=1 ${"x".repeat(400 - "exit=1 ".length)}…`
  assert.ok(logged.includes(`- 2026-09-25T12:00:00+08:00 run=run-1 #1 FAIL (12ms) \`npm test\` :: ${cap}`), "detail clipped at 400 chars")
  assert.equal(parsePlan(logged).updated, "2026-09-25T12:00:00+08:00")
  // Idempotent: re-appending the SAME run adds nothing (updated-only write).
  const again = appendPlanCheckLog(logged, "run-1", outcomes, "2026-09-25T12:01:00+08:00")
  assert.equal(again.match(/run=run-1/g).length, 1, "one line per runId+item, never duplicated")
  assert.equal(parsePlan(again).updated, "2026-09-25T12:01:00+08:00")
  // A plan without a Check Log section (hand-written) refuses the append.
  assert.throws(() => appendPlanCheckLog(renderPlan(sampleInput(), NOW), "run-2", outcomes, NOW), /missing section: Check Log/)
})

test("appendTerminalSection outcomes: one `OK|FAIL (ms)` line per check, output clipped at the plugin-passed limit (2048)", () => {
  const text = renderPlan(sampleInput(), NOW)
  const long = "y".repeat(3000)
  const closed = appendTerminalSection(
    text,
    "closed",
    {
      reason: "completion gate passed (plugin-verified)",
      outcomes: [
        { index: 1, ok: true, label: "npm test", detail: `ok out ${long}`, durationMs: 42 },
        { index: 2, ok: false, label: "done.txt :: done", detail: "required text not found", durationMs: 7 },
      ],
      outcomeOutputLimit: 2048,
    },
    "2026-09-25T18:00:00+08:00",
  )
  assert.ok(closed.includes("- #1 OK (42ms) `npm test`"))
  assert.ok(closed.includes("- #2 FAIL (7ms) `done.txt :: done`"))
  assert.ok(closed.includes(`  output: ok out ${"y".repeat(2048 - "ok out ".length)}…`), "output clipped at exactly 2048 chars + ellipsis")
  assert.ok(closed.includes("  output: required text not found"))
  // Multi-line output is flattened before the cap (single line per check).
  const flat = appendTerminalSection(text, "closed", { outcomes: [{ index: 1, ok: true, label: "l", detail: "a\nb", durationMs: 1 }] }, NOW)
  assert.ok(flat.includes("  output: a b"))
})

test("reopen (D5): done -> approved is the only done exit; appendReopenSection is dated, verbatim, parser-inert; other terminal finals stay pinned", () => {
  const text = renderPlan(sampleInput(), NOW)
  const approved = transitionStatus(text, "approved", NOW)
  const done = transitionStatus(approved, "done", "2026-09-25T17:00:00+08:00")
  // The one legal exit from done.
  assert.ok(canTransition("done", "approved"))
  assert.equal(parsePlan(transitionStatus(done, "approved", "2026-09-25T17:30:00+08:00")).status, "approved")
  // Every OTHER done exit stays illegal (terminal-finality pins unchanged).
  for (const to of ["abandoned", "superseded", "done"]) {
    assert.ok(!canTransition("done", to))
  }
  // The narrative: dated `— reopened` heading, reason verbatim (or the
  // explicit (none given) marker), appended at END, parser-inert.
  const before = parsePlan(done)
  const reopened = appendReopenSection(done, "2026-09-25T17:30:00+08:00", "user read the close evidence")
  assert.ok(reopened.includes("## 2026-09-25T17:30:00+08:00 — reopened"))
  assert.ok(reopened.includes("reason: user read the close evidence"))
  assert.ok(reopened.startsWith(done.replace(/\n$/, "")))
  const noReason = appendReopenSection(done, NOW)
  assert.ok(noReason.includes("reason: (none given)"))
  const after = parsePlan(appendReopenSection(transitionStatus(done, "approved", "2026-09-25T17:31:00+08:00"), "2026-09-25T17:31:00+08:00", "r"))
  assert.deepEqual(after.tasks, before.tasks)
  assert.deepEqual(after.acceptance, before.acceptance)
  assert.equal(after.goal, before.goal)
})