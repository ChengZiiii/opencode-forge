import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
const { server } = await import("../plugin.ts")
import { appendLedger, parseGoal } from "../src/goal-file.ts"
import { setShellRunnerForTests } from "../src/run-check.ts"

const NOW_PREFIX = "goal-mode-test"
let sidCounter = 0
const nextSid = () => `ses_${NOW_PREFIX}-${++sidCounter}`

const allowAsk = async () => {}
const denyAsk = async () => {
  throw new Error("denied by user (test)")
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeHarness(opts = {}) {
  const prompts = []
  const client = {
    session: {
      prompt:
        opts.prompt ??
        (async (body) => {
          prompts.push(body)
        }),
      get: opts.getSession ?? (async () => undefined),
      status: opts.status ?? (async (o) => ({ [o.path.id]: { type: "idle" } })),
    },
  }
  const serverPromise = server({
    client,
    project: { id: "p" },
    directory: opts.worktree,
    worktree: opts.worktree,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {},
    experimental_workspace: { register() {} },
  })
  return { client, prompts, serverPromise }
}

function toolCtx(sid, worktree, ask = allowAsk) {
  return { sessionID: sid, worktree, ask, metadata() {}, callID: "c", agent: "forge", messageID: "m" }
}

const fakeRunnerPass = async () => ({ code: 0, output: "ok", timedOut: false })
const fakeRunnerFail = async () => ({ code: 1, output: "boom", timedOut: false })

function goalArgs(overrides = {}) {
  return {
    goal: "make the suite green",
    criteria: ["npm test exits 0"],
    checks: [{ shell: "npm test" }, { containsFile: "done.txt", containsText: "done" }],
    constraints: "stay in the sandbox",
    ...overrides,
  }
}

async function armGoal(hooks, worktree, overrides = {}, ask = allowAsk) {
  const sid = nextSid()
  await hooks.tool.goal_write.execute({ ...goalArgs(overrides), arm: true }, toolCtx(sid, worktree, ask))
  return sid
}

function goalFiles(worktree) {
  const dir = join(worktree, ".opencode", "goal")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }))
}

function liveDoc(worktree) {
  const files = goalFiles(worktree)
  assert.ok(files.length > 0, "expected a goal file")
  return { name: files[0].name, doc: parseGoal(files[0].text) }
}

// ---------------------------------------------------------------------------
// config / registration surface
// ---------------------------------------------------------------------------

test("config: goal permission keys pinned to ask, user deny respected, /goal command registered without clobbering", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-cfg-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const cfg = { agent: {}, permission: { goal_write: "deny" } }
    await hooks.config(cfg)
    assert.equal(cfg.permission.plan_approve, "ask")
    assert.equal(cfg.permission.plan_close, "ask")
    assert.equal(cfg.permission.goal_write, "deny") // explicit deny kept
    assert.equal(cfg.permission.goal_complete, "ask")
    assert.equal(cfg.permission.goal_resume, "ask")
    assert.equal(cfg.permission.goal_discard, "ask")
    assert.ok(cfg.command.goal.template.includes("forge goal harness routing"))
    // No clobbering of a user command of the same name.
    const cfg2 = { agent: {}, command: { goal: { template: "mine" } } }
    await hooks.config(cfg2)
    assert.equal(cfg2.command.goal.template, "mine")
    // All eleven tools registered (5 plan + 6 goal).
    for (const t of ["plan_write", "plan_tick", "plan_approve", "plan_close", "plan_discard", "goal_write", "goal_check", "goal_complete", "goal_pause", "goal_resume", "goal_discard"]) {
      assert.ok(hooks.tool[t], `missing tool ${t}`)
    }
    // Disable knob removes everything.
    const cfg3 = { agent: { forge: { disable: true } } }
    await hooks.config(cfg3)
    assert.deepEqual(hooks.tool, {})
    // Restore the module-level knob for subsequent tests in this process.
    await hooks.config({ agent: {} })
    assert.ok(hooks.tool.goal_write)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// goal_write: arm / queue / single-live / draft refusal / revise
// ---------------------------------------------------------------------------

test("goal_write arm=true passes the arm gate and lands an active, owned goal", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-arm-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    let asked = 0
    const out = await hooks.tool.goal_write.execute({ ...goalArgs(), arm: true }, toolCtx(sid, wt, async (req) => {
      asked++
      assert.equal(req.permission, "goal_write")
      assert.ok(req.metadata.title.startsWith("Arm goal:"))
    }))
    assert.equal(asked, 1, "arm gate must fire exactly once")
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "active")
    assert.equal(doc.session, sid)
    assert.equal(doc.revision, 1)
    assert.match(out.output, /armed/)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_write arm=false queues without any dialog", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-queue-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    const out = await hooks.tool.goal_write.execute({ ...goalArgs(), arm: false }, toolCtx(sid, wt, denyAsk))
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "queued")
    assert.equal(doc.session, "")
    assert.match(out.output, /queued \(inert\)/)
    // Queued goals never continue on idle.
    const { prompts } = makeHarness({ worktree: wt })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 0)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_write refuses a second live goal for the SAME session with edit/queue/discard options", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-single-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await assert.rejects(
      hooks.tool.goal_write.execute({ ...goalArgs({ goal: "another" }), arm: true }, toolCtx(sid, wt)),
      /already has a goal|edit|queue|discard/i,
    )
    assert.equal(goalFiles(wt).length, 1)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_write arming is refused while the session plan is in draft (safety interop, not binding)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-draft-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    await hooks.tool.plan_write.execute(
      {
        goal: "draft something",
        context: "looked around",
        approach: "do it",
        tasks: ["step one"],
        risks: "none",
        acceptance: ["it works"],
      },
      toolCtx(sid, wt),
    )
    await assert.rejects(
      hooks.tool.goal_write.execute({ ...goalArgs(), arm: true }, toolCtx(sid, wt, allowAsk)),
      /plan in draft|write ban/i,
    )
    assert.equal(goalFiles(wt).length, 0, "no goal file may be created")
    // Queuing stays allowed during draft (inert goal, no loop).
    await hooks.tool.goal_write.execute({ ...goalArgs(), arm: false }, toolCtx(sid, wt))
    assert.equal(liveDoc(wt).doc.status, "queued")
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_write revise bumps the revision and keeps status/owner/budget", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-revise-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt, { maxTurns: 5 })
    const out = await hooks.tool.goal_write.execute(
      { ...goalArgs({ goal: "make the suite green and fast", criteria: ["npm test exits 0", "lint passes"] }), revise: true },
      toolCtx(sid, wt, denyAsk),
    )
    assert.match(out.title, /rev 2/)
    const { doc } = liveDoc(wt)
    assert.equal(doc.revision, 2)
    assert.equal(doc.status, "active")
    assert.equal(doc.session, sid)
    assert.equal(doc.maxTurns, 5)
    assert.equal(doc.criteria.length, 2)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_write revise carries the Check Log and Turn Ledger audit trail", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-revise-hist-"))
  try {
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    // Produce a Check Log (goal_check) and a Turn Ledger entry (one
    // continuation turn with activity), then revise the contract.
    await hooks.tool.goal_check.execute({}, toolCtx(sid, wt))
    const file = goalFiles(wt)[0]
    writeFileSync(join(wt, ".opencode", "goal", file.name), appendLedger(file.text, { turn: 1, revision: 1, at: "2026-09-25T10:00:00+08:00", activity: true, writes: 2, checks: 1 }, "2026-09-25T10:00:00+08:00"))
    await hooks.tool.goal_write.execute({ ...goalArgs({ goal: "make the suite greener" }), revise: true }, toolCtx(sid, wt, denyAsk))
    const after = goalFiles(wt)[0]
    const doc = parseGoal(after.text)
    assert.equal(doc.revision, 2, "revision bumped")
    assert.equal(doc.log.length, 2, "both rev1 Check Log lines survive the revision")
    assert.match(doc.log[0], /rev1 #1 OK .*`npm test`/)
    assert.equal(doc.ledger.length, 1, "the rev1 Turn Ledger entry survives the revision")
    assert.match(after.text, /- turn 1 rev1 .*activity=yes \(writes=2 checks=1\)/)
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_write revise keeps stop_reason of a paused goal", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-revise-pause-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await hooks.tool.goal_pause.execute({ blocker: "waiting on an external API key" }, toolCtx(sid, wt))
    assert.equal(liveDoc(wt).doc.status, "paused")
    await hooks.tool.goal_write.execute({ ...goalArgs({ goal: "make the suite green once unblocked" }), revise: true }, toolCtx(sid, wt, denyAsk))
    const { doc, name } = liveDoc(wt)
    assert.equal(doc.status, "paused", "status stays paused across the revision")
    assert.equal(doc.stopReason, "blocker", "stop_reason survives the revision")
    assert.match(readFileSync(join(wt, ".opencode", "goal", name), "utf8"), /^stop_reason: blocker$/m)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// goal_check / goal_complete
// ---------------------------------------------------------------------------

test("goal_check runs items on the host and appends a revision-stamped Check Log", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-check-"))
  try {
    writeFileSync(join(wt, "done.txt"), "done\n")
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    const out = await hooks.tool.goal_check.execute({}, toolCtx(sid, wt))
    assert.match(out.output, /2\/2|#1 \[PASS\]/)
    const text = goalFiles(wt)[0].text
    assert.match(text, /run=\S+ rev1 #1 OK .*`npm test`/)
    assert.match(text, /rev1 #2 OK .*`done.txt :: done`/)
    // Subset selection keeps original numbering.
    const out2 = await hooks.tool.goal_check.execute({ items: [2] }, toolCtx(sid, wt))
    assert.match(out2.output, /#2 \[PASS\]/)
    await assert.rejects(hooks.tool.goal_check.execute({ items: [9] }, toolCtx(sid, wt)), /None of the given item numbers/)
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_check requires a live goal", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-checknolive-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    await assert.rejects(hooks.tool.goal_check.execute({}, toolCtx(sid, wt)), /No live goal/)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_check real-runner smoke: echo pass, exit 1 fail, contains hit and miss", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-real-"))
  try {
    mkdirSync(join(wt, "sub"))
    writeFileSync(join(wt, "done.txt"), "all done\n")
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    await hooks.tool.goal_write.execute(
      {
        goal: "real runner smoke",
        criteria: ["echo works", "exit codes work", "file contract works"],
        checks: [
          { shell: "echo forge-goal-smoke" },
          { shell: "exit 1" },
          { containsFile: "done.txt", containsText: "all done" },
          { containsFile: "done.txt", containsText: "not there" },
          { containsFile: "../escape.txt", containsText: "x" },
        ],
        constraints: "sandbox only",
        arm: true,
      },
      toolCtx(sid, wt),
    )
    const out = await hooks.tool.goal_check.execute({}, toolCtx(sid, wt))
    assert.match(out.output, /#1 \[PASS\][\s\S]*forge-goal-smoke/)
    assert.match(out.output, /#2 \[FAIL\][\s\S]*exit=1/)
    assert.match(out.output, /#3 \[PASS\]/)
    assert.match(out.output, /#4 \[FAIL\][\s\S]*not found/)
    assert.match(out.output, /#5 \[FAIL\][\s\S]*escapes the workspace/)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_check real-runner smoke: shell timeout kills the command", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-timeout-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    await hooks.tool.goal_write.execute(
      {
        goal: "timeout smoke",
        criteria: ["command must time out"],
        checks: [{ shell: 'node -e "setTimeout(()=>{},8000)"', timeoutSec: 1 }],
        constraints: "sandbox only",
        arm: true,
      },
      toolCtx(sid, wt),
    )
    const started = Date.now()
    const out = await hooks.tool.goal_check.execute({}, toolCtx(sid, wt))
    assert.ok(Date.now() - started < 5000, "timeout must fire at ~1s")
    assert.match(out.output, /#1 \[FAIL\][\s\S]*timed out after 1s/)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_complete is fail-closed: failing check refuses without reaching the gate", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-fail-"))
  try {
    setShellRunnerForTests(fakeRunnerFail)
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    let gated = 0
    await assert.rejects(
      hooks.tool.goal_complete.execute(
        { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "x" }] },
        toolCtx(sid, wt, async () => {
          gated++
        }),
      ),
      /fail-closed|FAIL/,
    )
    assert.equal(gated, 0, "user gate must not be reached on failing checks")
    assert.equal(liveDoc(wt).doc.status, "active")
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_complete rejects incomplete or failing self-attestations", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-attest-"))
  try {
    writeFileSync(join(wt, "done.txt"), "done\n")
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await assert.rejects(
      hooks.tool.goal_complete.execute({ attestations: [] }, toolCtx(sid, wt)),
      /no self-attestation/,
    )
    await assert.rejects(
      hooks.tool.goal_complete.execute({ attestations: [{ criterion: "npm test exits 0", pass: false, evidence: "still red" }] }, toolCtx(sid, wt)),
      /unmet/,
    )
    assert.equal(liveDoc(wt).doc.status, "active")
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_complete: all checks re-run passing + full attestation + user allow -> completed", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-done-"))
  try {
    writeFileSync(join(wt, "done.txt"), "done\n")
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    const out = await hooks.tool.goal_complete.execute(
      { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "exit 0, 42 tests" }] },
      toolCtx(sid, wt),
    )
    assert.match(out.output, /completed/)
    const text = goalFiles(wt)[0].text
    assert.match(text, /^status: completed$/m)
    assert.match(text, /rev1 #1 OK/, "final gate re-run recorded")
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_complete requires an active (not paused) goal", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-completeactive-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await hooks.tool.goal_pause.execute({}, toolCtx(sid, wt))
    await assert.rejects(
      hooks.tool.goal_complete.execute({ attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "x" }] }, toolCtx(sid, wt)),
      /No active goal/,
    )
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// pause / resume / discard
// ---------------------------------------------------------------------------

test("goal_pause is ungated and records the stop reason taxonomy", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-pause-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    const out = await hooks.tool.goal_pause.execute({}, toolCtx(sid, wt, denyAsk))
    assert.match(out.output, /stop_reason: user/)
    await hooks.tool.goal_resume.execute({}, toolCtx(sid, wt))
    const out2 = await hooks.tool.goal_pause.execute({ blocker: "auth service is down" }, toolCtx(sid, wt, denyAsk))
    assert.match(out2.output, /stop_reason: blocker/)
    assert.match(goalFiles(wt)[0].text, /^stop_reason: blocker$/m)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_resume: deny keeps it paused; allow re-arms, rebinds owner, tops up budget with ceiling", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-resume-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt, { maxTurns: 10 })
    await hooks.tool.goal_pause.execute({}, toolCtx(sid, wt, denyAsk))
    await assert.rejects(hooks.tool.goal_resume.execute({}, toolCtx(sid, wt, denyAsk)), /denied by user/)
    assert.equal(liveDoc(wt).doc.status, "paused")
    const sid2 = nextSid()
    await hooks.tool.goal_resume.execute({ addTurns: 5 }, toolCtx(sid2, wt))
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "active")
    assert.equal(doc.session, sid2, "ownership rebinds to the resuming session")
    assert.equal(doc.maxTurns, 15)
    // Hard ceiling holds even with an absurd top-up.
    await hooks.tool.goal_pause.execute({}, toolCtx(sid2, wt, denyAsk))
    await hooks.tool.goal_resume.execute({ addTurns: 99999 }, toolCtx(sid2, wt))
    assert.equal(liveDoc(wt).doc.maxTurns, 200)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_resume promotes the oldest queued goal (/goal next path)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-next-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const s1 = nextSid()
    const s2 = nextSid()
    await hooks.tool.goal_write.execute({ ...goalArgs({ goal: "first queued" }), arm: false }, toolCtx(s1, wt))
    await sleep(5)
    await hooks.tool.goal_write.execute({ ...goalArgs({ goal: "second queued" }), arm: false }, toolCtx(s2, wt))
    const promoter = nextSid()
    await hooks.tool.goal_resume.execute({}, toolCtx(promoter, wt))
    const files = goalFiles(wt)
    const active = files.find((f) => parseGoal(f.text).status === "active")
    assert.ok(active, "one goal must be active")
    assert.match(active.name, /first-queued/, "the OLDEST queued goal is promoted")
    assert.equal(parseGoal(active.text).session, promoter)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("goal_discard: gated; abandoned file remains as history; engine forgets the session", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-discard-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await assert.rejects(hooks.tool.goal_discard.execute({ reason: "wrong objective" }, toolCtx(sid, wt, denyAsk)), /denied by user/)
    assert.equal(liveDoc(wt).doc.status, "active")
    const out = await hooks.tool.goal_discard.execute({ reason: "wrong objective" }, toolCtx(sid, wt))
    assert.match(out.output, /abandoned/)
    assert.match(goalFiles(wt)[0].text, /^status: abandoned$/m)
    // A fresh goal may now be created in the same session.
    await hooks.tool.goal_write.execute({ ...goalArgs({ goal: "fresh start" }), arm: false }, toolCtx(sid, wt))
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// continuation engine
// ---------------------------------------------------------------------------

test("idle continuation: armed goal continues the owner session with a compact brief; turns and ledger increment", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-cont-"))
  try {
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 1)
    const body = prompts[0]
    assert.equal(body.path.id, sid)
    const brief = body.body.parts[0].text
    assert.match(brief, /\[forge:goal-continue\]/)
    assert.match(brief, /make the suite green/)
    assert.match(brief, /shell `npm test`/)
    assert.match(brief, /0\/25 turns used/)
    assert.equal(body.body.agent, undefined, "no agent override: single-principle, no switching")
    assert.match(goalFiles(wt)[0].text, /^turns_used: 1$/m)
    // Second idle evaluates turn 1 (ledger entry, no activity) and continues.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 2)
    assert.match(goalFiles(wt)[0].text, /- turn 1 rev1 \S+ activity=no \(writes=0 checks=0\)/)
    assert.equal(liveDoc(wt).doc.turnsUsed, 2)
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("idle: non-owner session and unknown-session-without-directory never continue", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-owner-"))
  try {
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    const stranger = nextSid()
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: stranger } } })
    await sleep(60)
    assert.equal(prompts.length, 0, "non-owner must not continue")
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("idle: lazy seeding resolves an unknown session via client.session.get", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-lazy-"))
  try {
    const { serverPromise, prompts } = makeHarness({
      worktree: wt,
      getSession: async () => ({ directory: wt, worktree: wt }),
    })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    // New harness lost the in-memory map; simulate restart by using a fresh
    // unknown-but-real owner id: re-render the goal file's owner.
    const files = goalFiles(wt)
    const ghost = parseGoal(files[0].text).session
    // Drop the in-memory binding (new process semantics) by disposing.
    await hooks.dispose?.()
    const { serverPromise: sp2, prompts: prompts2 } = makeHarness({ worktree: wt, getSession: async () => ({ directory: wt }) })
    const hooks2 = await sp2
    await hooks2.event({ event: { type: "session.idle", properties: { sessionID: ghost } } })
    await sleep(60)
    assert.equal(prompts2.length, 1, "lazy-seeded continuation for the persisted owner")
    await hooks2.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("budget: turn exhaustion wraps up once and pauses with budget-turns", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-budget-"))
  try {
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt, { maxTurns: 1 })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 1, "the single budgeted continuation")
    assert.match(goalFiles(wt)[0].text, /^turns_used: 1$/m)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(80)
    assert.equal(prompts.length, 2, "exactly one wrap-up prompt")
    assert.match(prompts[1].body.parts[0].text, /\[forge:goal-wrapup\]/)
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "budget-turns")
    // No further continuation after the pause.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 2)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("no-progress: two activity-free continuation turns auto-pause; a write resets the streak", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-noprog-"))
  try {
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt, { maxTurns: 10 })
    // Turn 1: no activity.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 1)
    // Turn 2: a write happened -> streak resets.
    await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "c", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 2)
    assert.equal(liveDoc(wt).doc.status, "active")
    // Turns 3 and 4: no activity twice -> auto-pause with wrap-up.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(80)
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "no-progress")
    assert.ok(prompts.at(-1).body.parts[0].text.includes("[forge:goal-wrapup]"))
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("transport failures: three consecutive failed deliveries auto-pause with transport-failures", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-transport-"))
  try {
    let fails = 0
    const { serverPromise } = makeHarness({
      worktree: wt,
      prompt: async () => {
        fails++
        throw new Error("connection refused (test)")
      },
    })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt, { maxTurns: 10 })
    for (let i = 0; i < 3; i++) {
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
      await sleep(60)
    }
    assert.equal(fails, 3)
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "transport-failures")
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("draft-conflict: a draft plan appearing mid-goal pauses the loop instead of fighting the write ban", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-conflict-"))
  try {
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await hooks.tool.plan_write.execute(
      {
        goal: "mid-goal planning",
        context: "context",
        approach: "approach",
        tasks: ["one"],
        risks: "none",
        acceptance: ["ok"],
      },
      toolCtx(sid, wt),
    )
    // The write ban still denies writes (plan behavior byte-identical).
    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "write", sessionID: sid, callID: "c" }, { args: {} }),
      /\[forge\] A plan is in draft/,
    )
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(80)
    assert.equal(prompts.length, 0, "no continuation into a walled loop")
    const { doc } = liveDoc(wt)
    assert.equal(doc.status, "paused")
    assert.equal(doc.stopReason, "draft-conflict")
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// compaction + notices
// ---------------------------------------------------------------------------

test("compaction: brief rides along; synthetic auto-continue suppressed only for goal sessions", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-compaction-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    const compacting = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: sid }, compacting)
    assert.equal(compacting.context.length, 1)
    assert.match(compacting.context[0], /\[forge:goal-brief\]/)
    assert.match(compacting.context[0], /make the suite green/)
    const ac1 = { enabled: true }
    await hooks["experimental.compaction.autocontinue"]({ sessionID: sid }, ac1)
    assert.equal(ac1.enabled, false)
    const other = { enabled: true }
    await hooks["experimental.compaction.autocontinue"]({ sessionID: "ses_unknown" }, other)
    assert.equal(other.enabled, true, "non-goal sessions keep the host default")
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("system notice: goal and plan notices coexist; paused notice routes explicit continuation through goal_resume", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-notice-"))
  try {
    const { serverPromise } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = nextSid()
    // Arm the goal FIRST (arming after a draft exists is refused by design).
    await hooks.tool.goal_write.execute({ ...goalArgs({ goal: "notice goal" }), arm: true }, toolCtx(sid, wt))
    await hooks.tool.plan_write.execute(
      { goal: "a plan", context: "c", approach: "a", tasks: ["t"], risks: "r", acceptance: ["ok"] },
      toolCtx(sid, wt),
    )
    const out1 = { system: [] }
    await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: { providerID: "x", modelID: "y" } }, out1)
    const planNotice = out1.system.find((s) => s.includes("[forge:plan-notice]"))
    const goalNotice = out1.system.find((s) => s.includes("[forge:goal-notice]"))
    assert.ok(planNotice, "plan notice present")
    assert.ok(goalNotice, "goal notice present")
    assert.match(goalNotice, /status: active/)
    await hooks.tool.goal_pause.execute({}, toolCtx(sid, wt, denyAsk))
    const out3 = { system: [] }
    await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: { providerID: "x", modelID: "y" } }, out3)
    const pausedNotice = out3.system.find((s) => s.includes("[forge:goal-notice]"))
    assert.match(pausedNotice, /stopped: user/)
    assert.match(pausedNotice, /goal_resume/)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// decoupling boundary (grep-level regression)
// ---------------------------------------------------------------------------

test("decoupling: goal core modules import nothing from plan-file; gate tools read no plan state", async () => {
  const { readFile } = await import("node:fs/promises")
  const goalFileSrc = await readFile(new URL("../src/goal-file.ts", import.meta.url), "utf8")
  const runCheckSrc = await readFile(new URL("../src/run-check.ts", import.meta.url), "utf8")
  assert.ok(!/from\s+"\.\/plan-file/.test(goalFileSrc), "goal-file.ts must not import plan-file")
  assert.ok(!/from\s+"\.\/plan-file/.test(runCheckSrc), "run-check.ts must not import plan-file")
  const pluginSrc = await readFile(new URL("../plugin.ts", import.meta.url), "utf8")
  const seg = pluginSrc.slice(pluginSrc.indexOf("const goalCheckTool"), pluginSrc.indexOf("const goalPauseTool"))
  assert.ok(!seg.includes("resolveActivePlan") && !seg.includes("planPath"), "goal_check/goal_complete read no plan state")
})

// ---------------------------------------------------------------------------
// Review regression tests (post-0.2.0 findings)
// ---------------------------------------------------------------------------

test("promotion of an old queued goal re-arms the wall-clock budget (armed_at)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-promo-clock-"))
  try {
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    // Queue a goal whose created timestamp is long past its 5-minute window.
    const sidA = nextSid()
    await hooks.tool.goal_write.execute({ ...goalArgs({ maxMinutes: 5 }), arm: false }, toolCtx(sidA, wt))
    const file = goalFiles(wt)[0]
    const goalPath = join(wt, ".opencode", "goal", file.name)
    const old = new Date(Date.now() - 30 * 60_000).toISOString()
    writeFileSync(goalPath, readFileSync(goalPath, "utf8").replace(/^created:.*$/m, `created: ${old}`))
    // A second session promotes it through the resume gate and idles.
    const sidB = nextSid()
    await hooks.tool.goal_resume.execute({}, toolCtx(sidB, wt, allowAsk))
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sidB } } })
    await sleep(60)
    assert.equal(prompts.length, 1, "fresh armed_at must let the promoted goal continue instead of budget-pausing on stale created")
    assert.match(goalFiles(wt)[0].text, /^turns_used: 1$/m)
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})

test("disable knob: the continuation engine must not inject briefs", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-disable-idle-"))
  try {
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    await hooks.config({ agent: { forge: { disable: true } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 0, "a disabled plugin must not continue goals (the user cannot discard one either)")
    // Re-enable and confirm the loop runs again (the knob is live).
    await hooks.config({ agent: {} })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 1)
    await hooks.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("the completion turn gets its Turn Ledger line even after the goal is terminal", async () => {
  const wt = mkdtempSync(join(tmpdir(), "goal-gate-ledger-"))
  try {
    writeFileSync(join(wt, "done.txt"), "done\n")
    setShellRunnerForTests(fakeRunnerPass)
    const { serverPromise, prompts } = makeHarness({ worktree: wt })
    const hooks = await serverPromise
    const sid = await armGoal(hooks, wt)
    // Turn 1: the engine continues; the turn has goal_check activity.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.equal(prompts.length, 1)
    await hooks["tool.execute.after"]({ tool: "goal_check", sessionID: sid, callID: "c", args: {} }, { title: "", output: "", metadata: {} })
    // The model completes inside the continuation turn.
    await hooks.tool.goal_complete.execute(
      { attestations: [{ criterion: "npm test exits 0", pass: true, evidence: "exit=0 (fake runner)" }] },
      toolCtx(sid, wt, allowAsk),
    )
    assert.equal(liveDoc(wt).doc.status, "completed")
    // The next idle must still ledger turn 1 although the goal is terminal.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await sleep(60)
    assert.match(goalFiles(wt)[0].text, /- turn 1 rev1 \S+ activity=yes \(writes=0 checks=1\)/)
    assert.equal(prompts.length, 1, "no further continuation for a terminal goal")
    await hooks.dispose?.()
  } finally {
    setShellRunnerForTests(null)
    rmSync(wt, { recursive: true, force: true })
  }
})
