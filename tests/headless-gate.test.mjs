import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "../plugin.ts"
import { interactiveBanner, KNOWN_INTERACTIVE_COMMANDS, classifyExecCommand, WRITE_CLASS } from "../src/exec-classify.ts"
import { NON_INTERACTIVE_ENV } from "../src/proc.ts"

// Exec posture pass-through + non-interactive exec hygiene
// (shell-defang-default-open, spec tool-partition — "Exec posture
// pass-through on the exec surface" + "Non-interactive exec hygiene on the
// forge_shell surface"). Supersedes dispatch-resilience fold A's headless
// gate tests: the plugin classifies NOTHING on the posture path and injects
// NO default permission rule — explicit values reach the host verbatim, the
// unconfigured posture inherits the host default, and every spawn carries
// the defang env set.

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-posture-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"

const worktree = mkdtempSync(join(tmpdir(), "forge-posture-wiring-"))
process.on("exit", () => {
  for (const d of [worktree, process.env.FORGE_TEST_FORGE_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Unit: the known-interactive banner (informational — never a refuser)
// ---------------------------------------------------------------------------

test("banner unit: every table entry matches itself verbatim", () => {
  for (const entry of KNOWN_INTERACTIVE_COMMANDS) {
    const banner = interactiveBanner(entry)
    assert.ok(banner, `${entry} warns`)
    assert.match(banner, /^\[forge:interactive\]/, "the banner prefix")
    assert.match(banner, new RegExp(`"${entry}"`), "the banner names the matched entry")
  }
})

test("banner unit: benign commands never warn", () => {
  for (const cmd of [
    "",
    "node -e \"console.log('x')\"",
    "npm install left-pad",
    "npm run build",
    "git status",
    "vim.js --help",
    "echo vim",
    "nodevim",
  ]) {
    assert.equal(interactiveBanner(cmd), null, `${JSON.stringify(cmd)} is not known-interactive`)
  }
})

test("banner unit: consecutive-run matching with env prefixes and pipes", () => {
  assert.ok(interactiveBanner("FOO=1 npm login"), "env prefix skipped, entry still matches")
  assert.ok(interactiveBanner("sudo apt-get install -y ripgrep"), "sudo heads the segment")
  assert.ok(interactiveBanner("git log --graph | less"), "a piped primary pager heads its own segment")
  assert.ok(interactiveBanner("gh auth login"), "multi-word entry matches the head run")
  assert.ok(interactiveBanner("cd app && npm login"), "a follow-on command heads the next segment")
  assert.equal(interactiveBanner("npm logintool"), null, "exact-token equality — no substring trips")
  assert.equal(interactiveBanner("echo sudo vim"), null, "mid-segment single words never trip — head position only")
})

test("banner unit: the banner never refuses — it is informational text only", () => {
  // The banner is a string; classification is a separate concern (the seal
  // uses classifyExecCommand). A known-interactive command that is READ-class
  // stays READ-class for the seal.
  const banner = interactiveBanner("ssh")
  assert.ok(banner)
  assert.equal(classifyExecCommand("ssh").klass, "READ", "the banner is not a classification")
})

// ---------------------------------------------------------------------------
// Unit: the defang env set
// ---------------------------------------------------------------------------

test("defang set: the exact non-interactive environment", () => {
  assert.deepEqual(NON_INTERACTIVE_ENV, {
    GIT_EDITOR: ":",
    EDITOR: ":",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_MERGE_AUTOEDIT: "no",
  })
})

// ---------------------------------------------------------------------------
// Wiring: the posture pass-through matrix
// ---------------------------------------------------------------------------

const input = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: worktree,
  worktree,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

let lastHost = null
async function hooks() {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(input(), {})
  return lastHost
}

const toolCtx = (sessionID, askImpl) => ({
  sessionID,
  worktree: mkdtempSync(join(tmpdir(), `forge-posture-ctx-${sessionID}-`)),
  ask: askImpl,
  metadata: () => {},
  message: async () => {},
})

// A WRITE-class command (redirect) that is harmless to actually run — under
// pass-through the command class no longer decides anything on the posture
// path, so the test proves it by RUNNING it. The message rides stderr so it
// is captured (stdout goes to the redirect target).
const WRITEISH_CMD = `node -e "console.error('pass-through-ok')" > out.txt`

test("pass-through: unconfigured injects NOTHING — the host default applies to ANY command class", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cfg = { permission: {} }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, undefined, "no plugin-injected posture at all")
  assert.equal(cfg.permission.plan_approve, "ask", "doors are different: still rewritten to ask")
  // plan-close-verified D4: six doors — plan_close is plugin-verified now.
  assert.equal(cfg.permission.plan_close, undefined, "plan_close is no longer an injected door")
  // A WRITE-class command runs: the ask reaches the host (once), the host's
  // resolution (allow here) applies, no plugin-side denial exists.
  const asks = []
  const res = await h.tool.forge_shell.execute(
    { command: WRITEISH_CMD, idle_ms: 8000, max_wait_ms: 20000 },
    toolCtx("ses_pt_write", async (req) => {
      asks.push(req)
      return { status: "allow" }
    }),
  )
  assert.equal(asks.length, 1, "exactly one ask reaches the host — unmodified")
  assert.equal(asks[0].permission, "forge_shell")
  assert.match(res.output, /pass-through-ok/)
  assert.match(res.output, /exit=0/, "the WRITE-class command RAN under the host's allow")
  assert.ok(!res.output.includes("forge:headless-denied"), "no plugin-side denial exists anymore")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("pass-through: explicit ask reaches the host unmodified — the ask's own resolution IS the result", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cfg = { permission: { forge_shell: "ask" } }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "ask", "an explicit ask stands verbatim in the rule")
  // Run-mode shape: the host auto-rejects asks — the tool fails with the
  // ask's own error, the plugin added nothing on top.
  const asks = []
  await assert.rejects(
    () =>
      h.tool.forge_shell.execute(
        { command: "node -e \"console.log('nope')\"", idle_ms: 8000, max_wait_ms: 20000 },
        toolCtx("ses_ask_reject", async (req) => {
          asks.push(req)
          throw new Error("ask auto-rejected (run mode)")
        }),
      ),
    /ask auto-rejected/,
  )
  assert.equal(asks.length, 1, "the ask was created and left to the host")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("snapshot: explicit allow skips the ask — the user's own rule, every mode", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cfg = { permission: { forge_shell: "allow" } }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "allow", "the explicit allow keeps standing in the rule")
  assert.equal(h.__forgeSubagentsTest.gateSnapshot().forge_shell, "allow")
  const asks = []
  const res = await h.tool.forge_shell.execute(
    { command: WRITEISH_CMD, idle_ms: 8000, max_wait_ms: 20000 },
    toolCtx("ses_allow_pt", async (req) => {
      asks.push(req)
      return { status: "allow" }
    }),
  )
  assert.equal(asks.length, 0, "explicit allow skips the ask")
  assert.match(res.output, /exit=0/, "the WRITE-class command RAN under explicit allow")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("snapshot: explicit deny refuses everywhere, before any ask", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cfg = { permission: { forge_shell: "deny" } }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, "deny", "deny is never overridden")
  const asks = []
  await assert.rejects(
    () =>
      h.tool.forge_shell.execute(
        { command: "node -e \"console.log('x')\"" },
        toolCtx("ses_deny_pt", async (req) => {
          asks.push(req)
          return { status: "allow" }
        }),
      ),
    /explicitly denied by user configuration/,
  )
  assert.equal(asks.length, 0, "deny refuses without an ask")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("snapshot anti-recapture: a re-presented config is never captured; the belt is pure pass-through for forge_shell", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  // First pass: no explicit value — the hook rewrites the DOORS to ask but
  // leaves forge_shell untouched.
  const cfg = { permission: {} }
  await h.config(cfg)
  assert.equal(cfg.permission.forge_shell, undefined)
  // Re-present the SAME mutated merged object (the host re-present trap):
  // the doors' injected "ask" is never captured as explicit.
  await h.config(cfg)
  assert.equal(h.__forgeSubagentsTest.gateSnapshot().forge_shell, undefined, "nothing captured for forge_shell")
  // Belt: forge_shell passes through untouched in every direction.
  const out1 = { status: "allow" }
  await h["permission.ask"]({ id: "forge_shell" }, out1)
  assert.equal(out1.status, "allow", "belt does not touch forge_shell (pass-through)")
  const out2 = { status: "ask" }
  await h["permission.ask"]({ id: "forge_shell" }, out2)
  assert.equal(out2.status, "ask")
  const out3 = { status: "deny" }
  await h["permission.ask"]({ id: "forge_shell" }, out3)
  assert.equal(out3.status, "deny")
  // A later genuine user allow IS captured and re-presentation keeps it.
  const cfg2 = { permission: { forge_shell: "allow" } }
  await h.config(cfg2)
  await h.config(cfg2)
  assert.equal(h.__forgeSubagentsTest.gateSnapshot().forge_shell, "allow")
  // Doors are exempt from pass-through: an explicit allow on a door is still
  // rewritten to ask, and the belt keeps forcing doors to ask.
  const cfg3 = { permission: { plan_approve: "allow" } }
  await h.config(cfg3)
  assert.equal(cfg3.permission.plan_approve, "ask", "doors keep the full rewrite — they stay real dialogs")
  const out4 = { status: "allow" }
  await h["permission.ask"]({ id: "plan_approve" }, out4)
  assert.equal(out4.status, "ask")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("doors: plan_approve is never auto-resolved — the ask remains a real pending dialog", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const planCtx = toolCtx("ses_door", async () => ({ status: "allow" }))
  await h.tool.plan_write.execute(
    { goal: "g", context: "c", approach: "a", tasks: ["t1"], risks: "r", acceptance: ["a1"] },
    planCtx,
  )
  const asks = []
  const rejectCtx = toolCtx("ses_door", async (req) => {
    asks.push(req)
    throw new Error("user denied")
  })
  await assert.rejects(
    () => h.tool.plan_approve.execute({}, rejectCtx),
    /user denied/,
    "the gate still awaits a real ask — no plugin-side resolution touches doors",
  )
  assert.equal(asks.length, 1)
  assert.equal(asks[0].permission, "plan_approve")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("seal: a readonly worker's WRITE-class call still gets the seal finding (the sole plugin-side refusal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-posture-seal-"))
  try {
    mkdirSync(join(dir, ".opencode"), { recursive: true })
    writeFileSync(
      join(dir, ".opencode", "forge.json"),
      JSON.stringify({ pool: "ptseal", agents: { reviewer: { model: "zai/glm", thoughtLevel: "low", shape: "readonly" } } }),
    )
    const serverInput = { ...input(), directory: dir, worktree: dir }
    const h = await server(serverInput, {})
    try {
      await h.config({ agent: {}, command: {}, permission: {} })
      h.__forgeSubagentsTest.resetGateSnapshot()
      await h["chat.message"]({ sessionID: "ses_pt_seal", agent: "forge-ptseal-reviewer" })
      // The host order: tool.execute.before first — the seal throws and the
      // execute (whose gate would ask) is never reached.
      await assert.rejects(
        () =>
          h["tool.execute.before"](
            { tool: "forge_shell", sessionID: "ses_pt_seal", callID: "sh1" },
            { args: { command: "node build.js > out.txt" } },
          ),
        (err) => {
          const m = String(err)
          assert.match(m, /forge:seal/, "the seal finding is the surfaced error")
          assert.ok(!m.includes("forge:headless-denied"), "no headless denial exists anymore")
          return true
        },
      )
      // READ-class through the same seal: passes the before-hook; the gate
      // ask then reaches the host (pass-through) and resolves.
      await h["tool.execute.before"](
        { tool: "forge_shell", sessionID: "ses_pt_seal", callID: "sh2" },
        { args: { command: `node -e "console.log('seal-pt-ok')"` } },
      )
      const asks = []
      const res = await h.tool.forge_shell.execute(
        { command: `node -e "console.log('seal-pt-ok')"`, idle_ms: 8000, max_wait_ms: 20000 },
        toolCtx("ses_pt_seal", async (req) => {
          asks.push(req)
          return { status: "allow" }
        }),
      )
      assert.equal(asks.length, 1, "the ask reaches the host once (pass-through)")
      assert.match(res.output, /seal-pt-ok/)
    } finally {
      h.__forgeSubagentsTest.resetGateSnapshot()
      await h.dispose?.()
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// Wiring: the non-interactive exec hygiene
// ---------------------------------------------------------------------------

const ENV_PRINT = `node -e "console.log([process.env.GIT_EDITOR, process.env.EDITOR, process.env.GIT_PAGER, process.env.PAGER, process.env.GIT_MERGE_AUTOEDIT].join('|'))"`

test("hygiene wiring: every spawn carries the defang set (unconfigured posture)", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const res = await h.tool.forge_shell.execute(
    { command: ENV_PRINT, idle_ms: 8000, max_wait_ms: 20000 },
    toolCtx("ses_hygiene", async () => ({ status: "allow" })),
  )
  assert.match(res.output, /:\|:\|cat\|cat\|no/, "GIT_EDITOR=: EDITOR=: GIT_PAGER=cat PAGER=cat GIT_MERGE_AUTOEDIT=no")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("hygiene wiring: a known-interactive command warns WITHOUT blocking (banner prepended, command ran)", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  // `ssh` with no args prints usage and exits nonzero — it runs (no hang, no
  // refusal), and the banner names the match ahead of the result.
  const res = await h.tool.forge_shell.execute(
    { command: "ssh", idle_ms: 8000, max_wait_ms: 20000 },
    toolCtx("ses_banner", async () => ({ status: "allow" })),
  )
  assert.match(res.output, /^\[forge:interactive\] "ssh"/, "the banner leads the result")
  assert.match(res.output, /usage/, "the command's own output follows — the hygiene layer never refused")
  h.__forgeSubagentsTest.resetGateSnapshot()
})

test("hygiene wiring: the command string is byte-identical to what the model issued", async () => {
  const h = await hooks()
  h.__forgeSubagentsTest.resetGateSnapshot()
  const cmd = `node -e "console.log('byte-identical')"`
  const asks = []
  await h.tool.forge_shell.execute(
    { command: cmd, idle_ms: 8000, max_wait_ms: 20000 },
    toolCtx("ses_bytes", async (req) => {
      asks.push(req)
      return { status: "allow" }
    }),
  )
  assert.match(asks[0].metadata.title, /byte-identical/, "the issued string reached the gate unmodified")
  h.__forgeSubagentsTest.resetGateSnapshot()
})
