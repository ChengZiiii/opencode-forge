import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// command-surface (change v2-command-surface tasks 5.1/5.2, renegotiated by
// command-surface-v2-cleanup D4) — the forge slash-command surface: the
// single-source lever bodies behind the /forge router (byte-identical
// extraction, now FOUR forms: sync / init / init global / stop), the RETIRED
// hyphenated family (absence pinned on BOTH host generations + no-clobber
// survival), the exact v2 registered set, typed-argument composition on the
// v2 execute path (upstream evaluateTemplate semantics), delivery passthrough,
// and DISCLOSED registration drift.

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
  v2Setup,
  FORGE_COMMAND_TEMPLATE,
  FORGE_HELP_ROUTE_LINE,
  STOP_LEVER_BODY,
  SYNC_LEVER_BODY,
  INIT_WORKSPACE_LEAD,
  INIT_FLOW_BODY,
  INIT_GLOBAL_BODY,
  INIT_GLOBAL_SCAFFOLD_NOTE,
  forgeFamilyGuard,
  composeCommandPrompt,
} from "../plugin.ts"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"

// ---------------------------------------------------------------------------
// Task 2.1 — single-source lever bodies, byte-identical routing template
// ---------------------------------------------------------------------------

test("routing template embeds the single-source lever bodies verbatim (extraction changed no bytes)", () => {
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- Argument "sync": ${SYNC_LEVER_BODY}`), "sync route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- Argument "init": ${INIT_WORKSPACE_LEAD} ${INIT_FLOW_BODY}`), "init route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- Argument "init global": ${INIT_GLOBAL_BODY} Scaffold shape:`), "init-global route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(forgeFamilyGuard("/forge")), "family guard verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(INIT_GLOBAL_SCAFFOLD_NOTE), "scaffold note verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(`- ${STOP_LEVER_BODY}`), "stop route line verbatim")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes(FORGE_HELP_ROUTE_LINE), "help line verbatim (four forms)")
  assert.ok(FORGE_COMMAND_TEMPLATE.includes("$ARGUMENTS"), "the router still routes on $ARGUMENTS")
})

test("retired hyphen family: all four names are absent from the v2 command domain", async (t) => {
  const RETIRED = ["forge-sync", "forge-init", "forge-init-global", "forge-cancel"]
  // v2: the command domain registers none of the retired names.
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2-"))] })
  for (const name of RETIRED) {
    assert.equal(state.commands.has(name), false, `v2: ${name} not registered`)
  }

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

test("v2 command domain registers exactly the forge surface: crew / forge / goal / plan (one /forge router, four argument forms)", async () => {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2b-"))] })
  assert.deepEqual([...state.commands.keys()].sort(), ["crew", "forge", "goal", "plan"])
  for (const name of ["plan", "goal", "crew", "forge"]) {
    const cmd = state.commands.get(name)
    assert.equal(typeof cmd.description, "string", `${name} carries a description`)
    assert.equal(typeof cmd.execute, "function", `${name} is EXECUTE-based (CommandDefinition.execute)`)
  }
  assert.match(state.commands.get("forge").description, /stop/, "the router description names the stop form")
})

test("v2 execute composes typed arguments: /forge sync delivers the routing template with the argument and the delivery hint", async () => {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2b-"))] })
  state.sessionRecords.set("ses_x", { agent: "forge" })
  await state.commands.get("forge").execute({ sessionID: "ses_x", prompt: { text: "sync" }, delivery: "steer" })
  const sent = state.prompts.at(-1)
  assert.ok(sent?.text?.startsWith('(forge roster levers. Argument: "sync")'), "the placeholder got the typed text")
  assert.ok(sent.text.includes(`- Argument "sync": ${SYNC_LEVER_BODY}`), "the sync route body rides verbatim")
  assert.equal(sent.sessionID, "ses_x")
  assert.equal(sent.delivery, "steer", "the delivery hint rides the send")
})

test("v2 execute: whitespace or missing typed text sends the /forge router template unchanged", async () => {
  const { ctx, state } = createV2MockContext()
  await v2Setup(ctx, { anchors: [mkdtempSync(join(tmpdir(), "forge-cmdsurf-v2c-"))] })
  state.sessionRecords.set("ses_y", { agent: "forge" })
  await state.commands.get("forge").execute({ sessionID: "ses_y", prompt: { text: "   \n\t" } })
  assert.equal(state.prompts.at(-1).text, FORGE_COMMAND_TEMPLATE.split("\n").filter(line => !line.startsWith("FAMILY GUARD")).join("\n"), "whitespace typed text leaves the template unchanged")
  state.sessionRecords.set("ses_w", { agent: "forge" })
  await state.commands.get("forge").execute({ sessionID: "ses_w" })
  assert.equal(state.prompts.at(-1).text, FORGE_COMMAND_TEMPLATE.split("\n").filter(line => !line.startsWith("FAMILY GUARD")).join("\n"), "missing prompt.text sends the template unchanged")
  assert.ok(!("delivery" in state.prompts.at(-1)), "no delivery key is fabricated when the invocation has none")
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
