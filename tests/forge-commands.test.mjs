import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// forge-commands (tasks 1.1-1.4 + 2.1) — the /forge command family:
// registration in BOTH domains (v1 config hook + v2 command domain), the
// argument-routing template content (sync / init / init global / help),
// the family guard, the refuse-if-exists guard, the commented override
// scaffold, and the net-teaches-levers line in the unconfigured-crew
// refusal (gate semantics otherwise untouched).

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-cmds-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
process.on("exit", () => {
  try {
    rmSync(process.env.FORGE_TEST_FORGE_HOME, { recursive: true, force: true })
  } catch {}
})

import { server, v2Setup, FORGE_COMMAND_TEMPLATE, GLOBAL_RECIPE_SCAFFOLD_JSONC } from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

const input = (dir) => ({
  client: { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

const allowCtx = (sessionID) => ({
  sessionID,
  ask: async () => ({ status: "allow" }),
  metadata: () => {},
  message: async () => {},
})

let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts)
  return lastHost
}

// ---------------------------------------------------------------------------
// Template content (design D1/D2/D3)
// ---------------------------------------------------------------------------

test("/forge template: one command, $ARGUMENTS routing — all four forms plus the help fallback", () => {
  const t = FORGE_COMMAND_TEMPLATE
  assert.ok(t.includes('$ARGUMENTS'))
  assert.match(t, /Argument "sync"/)
  assert.match(t, /Argument "init global"/)
  assert.match(t, /Argument "init"/)
  assert.match(t, /Argument "stop"/, "the stop route rides the router (command-surface-v2-cleanup D1)")
  assert.match(t, /Argument empty or unknown/)
  // The help fallback lists all FOUR forms including /forge stop.
  assert.match(t, /\/forge sync \(force a roster sync NOW/)
  assert.match(t, /\/forge init \(draft this workspace's forge\.json/)
  assert.match(t, /\/forge init global \(draft the global forge\.json/)
  // fix-stop-cancels-queued-wishes (0.34.0): the help line names the queued
  // half too, and so does the stop route's own instruction.
  assert.match(t, /\/forge stop \(cancel THIS session's in-flight and queued async dispatches\)/)
  assert.match(t, /every QUEUED wish of this session \(removed from the queue before it can spawn/)
})

test("/forge template: FAMILY GUARD step-0 names the forge agent and the forge_sync tool", () => {
  const t = FORGE_COMMAND_TEMPLATE
  assert.match(t, /FAMILY GUARD \(step 0/)
  assert.match(t, /forge_sync tool in your available tools/)
  assert.match(t, /belongs to the forge agent/)
})

test("/forge sync: instructs an immediate forge_sync call with a verbatim diff report; automation posture unchanged (D5)", () => {
  const t = FORGE_COMMAND_TEMPLATE
  assert.match(t, /call the forge_sync tool NOW/)
  assert.match(t, /verbatim/)
  assert.match(t, /manual force lever/)
  assert.match(t, /sync:"auto" opt-in\) is unchanged/)
})

test("/forge init: names the workspace recipe, the interview/context drafting flow, and the refuse-if-exists guard", () => {
  const t = FORGE_COMMAND_TEMPLATE
  assert.match(t, /\.opencode\/forge\.json/)
  assert.match(t, /REFUSE to change it/)
  assert.match(t, /NEVER overwrite or rewrite/)
  assert.match(t, /ONLY on the user's explicit go-ahead/)
  assert.match(t, /hot-applies at the next config hook/)
})

test("/forge init global: same flow for the global recipe with the override entries COMMENTED (inert by default)", () => {
  const t = FORGE_COMMAND_TEMPLATE
  assert.match(t, /GLOBAL recipe \(~\/\.config\/opencode\/forge\.json\)/)
  assert.match(t, /refuse-and-review/)
  assert.match(t, /COMMENTED OUT/)
  // the scaffold itself ships inside the template, commented line by line
  assert.match(t, /^ {4}\/\/ "override": \{$/m, "the override node is in comment form")
  assert.match(t, /^ {4}\/\/   "general": \{ "model"/m)
  assert.match(t, /^ {4}\/\/   "explore": \{ "model"/m)
})

test("scaffold: inert by default — the override node and every entry are JSONC comments, no active override", () => {
  const s = GLOBAL_RECIPE_SCAFFOLD_JSONC
  assert.match(s, /^  "agents": \{$/m, "agents node is live (empty)")
  assert.match(s, /^  \/\/ "override": \{$/m, "override node is commented")
  assert.doesNotMatch(s, /^  "override"/m, "no active override node")
  for (const id of ["general", "explore"]) assert.doesNotMatch(s, new RegExp(`^ {4}"${id}":`, "m"), `${id} entry is comment-only`)
  assert.match(s, /Auto worker/, "Auto-worker semantics documented inline")
  assert.match(s, /REPLACES the built-in's prompt wholesale/, "the prompt-replacement disclosure is inline")
})

test("/forge template: the commands never write — every write rides a tool, transcript-visible", () => {
  const t = FORGE_COMMAND_TEMPLATE
  assert.match(t, /never writes anything by itself/)
  assert.match(t, /transcript-visible/)
})

// ---------------------------------------------------------------------------
// Registration — v1 config hook domain
// ---------------------------------------------------------------------------

test("v1 config hook registers command.forge (template constant, no-clobber on a user-defined entry)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cmds-v1-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = { agent: {}, command: {}, permission: {} }
  await h.config(cfg)
  const cmd = cfg.command["forge"]
  assert.ok(cmd, "command.forge registered")
  assert.equal(cmd.template, FORGE_COMMAND_TEMPLATE, "byte-identical template constant")
  assert.match(cmd.description, /roster levers/)
  assert.match(cmd.description, /init global/)

  // no-clobber: a user-defined /forge of their own is never overwritten
  const cfg2 = { agent: {}, command: { forge: { template: "MINE", description: "user owned" } }, permission: {} }
  await h.config(cfg2)
  assert.equal(cfg2.command.forge.template, "MINE")
})

// ---------------------------------------------------------------------------
// Registration — v2 command domain
// ---------------------------------------------------------------------------

test("v2 command domain registers the forge command (execute-type, sends the same template)", async () => {
  const { ctx, state } = createV2MockContext()
  const dir = mkdtempSync(join(tmpdir(), "forge-cmds-v2-"))
  await v2Setup(ctx, { anchors: [dir] })
  const cmd = state.commands.get("forge")
  assert.ok(cmd, "the v2 command editor carries 'forge'")
  assert.match(cmd.description, /roster levers/)
  assert.equal(typeof cmd.execute, "function")
  await cmd.execute({ sessionID: "ses_v2_forge" })
  const sent = state.prompts.find((p) => p?.text === FORGE_COMMAND_TEMPLATE)
  assert.ok(sent, "the executable sends the SAME constant template into the invoking session")
  assert.equal(sent.sessionID, "ses_v2_forge")
})

// ---------------------------------------------------------------------------
// D4 — the net teaches the levers (crew gate refusal names /forge init)
// ---------------------------------------------------------------------------

test("crew_begin unconfigured refusal names the /forge init levers alongside the in-band ask (gate semantics untouched)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cmds-gate-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  await h.config({ agent: {}, command: {}, permission: {} })
  await assert.rejects(
    () => h.tool.crew_begin.execute({ objective: "o", subtasks: [{ title: "x" }] }, allowCtx("ses_gate_levers")),
    (err) => {
      const m = String(err)
      assert.match(m, /CREW IS NOT INITIALIZED/)
      assert.match(m, /\/forge init\b/, "the refusal names /forge init")
      assert.match(m, /\/forge init global/, "the refusal names /forge init global")
      assert.match(m, /Levers:/)
      // the gate's own semantics are untouched — the original guidance body
      // still carries the sole-ownership + explicit-go-ahead teaching
      assert.match(m, /SOLE OWNERSHIP/)
      assert.match(m, /only on their explicit go-ahead/)
      return true
    },
  )
})
