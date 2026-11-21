import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// command-surface (change v2-command-surface, tasks 5.1/5.2) — the forge
// slash-command surface: the single-source lever bodies behind the /forge
// router (byte-identical extraction), the dedicated hyphenated family
// (forge-sync / forge-init / forge-init-global) on BOTH host generations,
// typed-argument composition on the v2 execute path (upstream evaluateTemplate
// semantics: $ARGUMENTS function-replacement / append-after-blank-line /
// empty⇒unchanged), delivery passthrough, and DISCLOSED registration drift.

process.env.FORGE_TEST_NO_FENCE = "1"
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-cmdsurf-home-"))
process.env.FORGE_TEST_NO_DISPATCH_FETCH = "1"
process.on("exit", () => {
  try {
    rmSync(process.env.FORGE_TEST_FORGE_HOME, { recursive: true, force: true })
  } catch {}
})

import {
  server,
  v2Setup,
  FORGE_COMMAND_TEMPLATE,
  FORGE_SYNC_LEVER_TEMPLATE,
  FORGE_INIT_LEVER_TEMPLATE,
  FORGE_INIT_GLOBAL_LEVER_TEMPLATE,
  SYNC_LEVER_BODY,
  INIT_WORKSPACE_LEAD,
  INIT_FLOW_BODY,
  INIT_GLOBAL_BODY,
  INIT_GLOBAL_SCAFFOLD_NOTE,
  forgeFamilyGuard,
  composeCommandPrompt,
} from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

const input = (dir) => ({
  client: { session: {} },
  project: { id: "p" },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})

let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest?.resetAnchors?.()
  lastHost = await server(inputArg, opts)
  return lastHost
}

// ---------------------------------------------------------------------------
// Task 2.1 — single-source lever bodies, byte-identical routing template
// ---------------------------------------------------------------------------

test("routing template embeds the single-source lever bodies verbatim (extraction changed no bytes)", () => {
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- Argument "sync": ${SYNC_LEVER_BODY}`), "sync route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- Argument "init": ${INIT_WORKSPACE_LEAD} ${INIT_FLOW_BODY}`), "init route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- Argument "init global": ${INIT_GLOBAL_BODY} Scaffold shape:`), "init-global route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(forgeFamilyGuard("/forge")), "family guard verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(INIT_GLOBAL_SCAFFOLD_NOTE), "scaffold note verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes("$ARGUMENTS"), "the router still routes on $ARGUMENTS")
})

test("dedicated levers: own family guard naming the invoked command, shared body text, no argument dependency", () => {
  for (const [tpl, name, body] of [
    [FORGE_SYNC_LEVER_TEMPLATE, "/forge-sync", SYNC_LEVER_BODY],
    [FORGE_INIT_LEVER_TEMPLATE, "/forge-init", `${INIT_WORKSPACE_LEAD} ${INIT_FLOW_BODY}`],
  ]) {
    assert.ok(tpl.includes(forgeFamilyGuard(name)), `${name} carries its own family guard`)
    assert.ok(tpl.includes(body), `${name} embeds the shared route body`)
    assert.ok(tpl.includes("never writes anything by itself"), `${name} carries the boundaries`)
    assert.ok(!tpl.includes("$ARGUMENTS"), `${name} never depends on typed arguments for routing`)
  }
  // init global is self-contained: full flow + scaffold disclosure + scaffold
  assert.ok(FORGE_INIT_GLOBAL_LEVER_TEMPLATE.includes(forgeFamilyGuard("/forge-init-global")))
  assert.ok(FORGE_INIT_GLOBAL_LEVER_TEMPLATE.includes(INIT_FLOW_BODY), "the drafting flow body is shared verbatim")
  assert.ok(FORGE_INIT_GLOBAL_LEVER_TEMPLATE.includes(INIT_GLOBAL_SCAFFOLD_NOTE))
  assert.match(FORGE_INIT_GLOBAL_LEVER_TEMPLATE, /^ {4}\/\/ "override": \{$/m, "the commented scaffold ships inside")
  assert.ok(!FORGE_INIT_GLOBAL_LEVER_TEMPLATE.includes("$ARGUMENTS"))
})

// ---------------------------------------------------------------------------
// Task 4.1 — composeCommandPrompt (upstream evaluateTemplate semantics)
// ---------------------------------------------------------------------------

test("composeCommandPrompt: $ARGUMENTS replaced with the typed text (function replacer)", () => {
  assert.equal(composeCommandPrompt('(forge roster levers. Argument: "$ARGUMENTS")', "sync"), '(forge roster levers. Argument: "sync")')
})

test("composeCommandPrompt: every occurrence replaced and $&-style literals in the argument are NOT expanded", () => {
  assert.equal(composeCommandPrompt("$ARGUMENTS then $ARGUMENTS", "a $& b $' c"), "a $& b $' c then a $& b $' c")
})

test("composeCommandPrompt: no placeholder + non-empty text appends after a blank line", () => {
  assert.equal(composeCommandPrompt("TEMPLATE BODY", "extra instruction"), "TEMPLATE BODY\n\nextra instruction")
})

test("composeCommandPrompt: empty / whitespace / null / undefined typed text leaves the template unchanged", () => {
  assert.equal(composeCommandPrompt("TEMPLATE", ""), "TEMPLATE")
  assert.equal(composeCommandPrompt("TEMPLATE", "   \n\t"), "TEMPLATE")
  assert.equal(composeCommandPrompt("TEMPLATE", null), "TEMPLATE")
  assert.equal(composeCommandPrompt("TEMPLATE", undefined), "TEMPLATE")
})

// ---------------------------------------------------------------------------
// Task 3.1 + 5.2 — v2 wiring: dedicated family, composition, delivery
// ---------------------------------------------------------------------------

test("v2 command domain registers the dedicated hyphenated family with per-lever descriptions", async () => {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2-"))] })
  for (const name of ["forge-sync", "forge-init", "forge-init-global"]) {
    const cmd = state.commands.get(name)
    assert.ok(cmd, `${name} registered on the v2 command domain`)
    assert.match(cmd.description, /forge roster lever:/, `${name} carries its own description`)
    assert.equal(typeof cmd.execute, "function")
  }
  assert.ok(state.commands.get("forge"), "the /forge router stays registered")
})

test("v2 execute composes typed arguments: /forge sync delivers the routing template with the argument and the delivery hint", async () => {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2b-"))] })
  await state.commands.get("forge").execute({ sessionID: "ses_x", prompt: { text: "sync" }, delivery: "steer" })
  const sent = state.prompts.at(-1)
  assert.ok(sent?.text?.startsWith('(forge roster levers. Argument: "sync")'), "the placeholder got the typed text")
  assert.ok(sent.text.includes(`- Argument "sync": ${SYNC_LEVER_BODY}`), "the sync route body rides verbatim")
  assert.equal(sent.sessionID, "ses_x")
  assert.equal(sent.delivery, "steer", "the delivery hint rides the send")
})

test("v2 execute: no placeholder + typed text appends; empty or missing prompt.text sends the template unchanged", async () => {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2c-"))] })
  await state.commands.get("forge-sync").execute({ sessionID: "ses_y", prompt: { text: "and also prune" } })
  assert.equal(state.prompts.at(-1).text, `${FORGE_SYNC_LEVER_TEMPLATE}\n\nand also prune`)
  await state.commands.get("forge-init").execute({ sessionID: "ses_z", prompt: { text: "   " } })
  assert.equal(state.prompts.at(-1).text, FORGE_INIT_LEVER_TEMPLATE)
  await state.commands.get("forge-init-global").execute({ sessionID: "ses_w" })
  assert.equal(state.prompts.at(-1).text, FORGE_INIT_GLOBAL_LEVER_TEMPLATE)
  assert.ok(!("delivery" in state.prompts.at(-1)), "no delivery key is fabricated when the invocation has none")
})

// ---------------------------------------------------------------------------
// Task 3.2 + 5.2 — v1 wiring: the hyphenated family in the config hook
// ---------------------------------------------------------------------------

test("v1 config hook registers the hyphenated family (byte-identical templates, no-clobber)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cmdsurf-v1-"))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  const h = await startServer(input(dir), {})
  t.after(() => h.dispose?.())
  const cfg = { agent: {}, command: {}, permission: {} }
  await h.config(cfg)
  for (const [name, tpl] of [
    ["forge-sync", FORGE_SYNC_LEVER_TEMPLATE],
    ["forge-init", FORGE_INIT_LEVER_TEMPLATE],
    ["forge-init-global", FORGE_INIT_GLOBAL_LEVER_TEMPLATE],
  ]) {
    assert.equal(cfg.command[name]?.template, tpl, `${name} template byte-identical`)
    assert.match(cfg.command[name].description, /forge roster lever:/)
  }
  // no-clobber: a user-defined entry of their own is never overwritten
  const cfg2 = { agent: {}, command: { "forge-sync": { template: "MINE", description: "user owned" } }, permission: {} }
  await h.config(cfg2)
  assert.equal(cfg2.command["forge-sync"].template, "MINE")
})

// ---------------------------------------------------------------------------
// Task 4.2 — drift is DISCLOSED, never silent
// ---------------------------------------------------------------------------

test("v2 command domain drift discloses: a throwing transform warns naming the domain and the error head", async () => {
  const { ctx } = createV2MockContext()
  ctx.command = {
    transform: async () => {
      throw new Error("drifted shape: editor rejected")
    },
  }
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => warnings.push(a.map(String).join(" "))
  try {
    await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-drift-"))] })
  } finally {
    console.warn = origWarn
  }
  assert.ok(
    warnings.some((w) => w.includes("command domain registration drifted") && w.includes("drifted shape")),
    "the disclosure names the command domain and the error head",
  )
})

test("v2 command editor drift discloses: an editor without add() warns instead of registering nothing silently", async () => {
  const { ctx } = createV2MockContext({ drift: { command: "bad-shape" } })
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => warnings.push(a.map(String).join(" "))
  try {
    await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-drift2-"))] })
  } finally {
    console.warn = origWarn
  }
  assert.ok(
    warnings.some((w) => w.includes("command domain editor drifted") && w.includes("add() missing")),
    "the missing-add editor is disclosed, not a silent no-op",
  )
})
