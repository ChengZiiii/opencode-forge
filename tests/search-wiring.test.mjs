import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRgBinary } from "../src/search-core.ts"

// Task group 2 — wiring tests for forge_grep/forge_glob (change
// forge-search-tools tasks 2.1/2.2): registration (tool count 17),
// partition joins (FORGE_ALL_TOOLS, worker toolset), ask-gate absence, and
// readonly-shape permission neutrality. Behavior/E2E (junction, fail-soft
// runtime) is task group 3.

// Debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_NO_FENCE = "1"
const { server } = await import("../plugin.ts")

// Host-lifetime simulation (same discipline as partition-wiring): reset the
// anchor set before each server() call so every test runs on a fresh host.
let lastHost = null
async function startServer(inputArg, opts) {
  if (lastHost) lastHost.__forgeSubagentsTest.resetAnchors()
  lastHost = await server(inputArg, opts)
  return lastHost
}

function inputFor(wt) {
  return {
    client: { session: {} },
    project: { id: "p" },
    directory: wt,
    worktree: wt,
    serverUrl: new URL("http://127.0.0.1:1"),
    $: () => {},
    experimental_workspace: { register() {} },
  }
}

test("registration: both search tools are registered — plugin tool count is 17", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-reg-"))
  try {
    const h = await startServer(inputFor(wt), {})
    assert.equal(typeof h.tool.forge_grep.execute, "function", "forge_grep registered")
    assert.equal(typeof h.tool.forge_glob.execute, "function", "forge_glob registered")
    assert.equal(Object.keys(h.tool).length, 17, "15 prior tools + the search pair")
    // Descriptions carry the preference line (D7 — teaches the primary,
    // which has no materialized mandate).
    for (const name of ["forge_grep", "forge_glob"]) {
      assert.match(
        h.tool[name].description,
        /Prefer forge_grep\/forge_glob over the builtin grep\/glob — follow and hidden are on by default/,
        `${name} description carries the preference line`,
      )
    }
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition: a materialized forge-* worker's tools map includes both search tools (and the builtin pair stays visible)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-worker-"))
  try {
    mkdirSync(join(wt, ".opencode"), { recursive: true })
    writeFileSync(
      join(wt, ".opencode", "forge.json"),
      JSON.stringify({ pool: "sw", agents: { scout: { model: "x/y", thoughtLevel: "low", shape: "readonly" }, coder: { model: "x/y", thoughtLevel: "low", shape: "write" } } }),
    )
    const h = await startServer(inputFor(wt), {})
    const cfg = { agent: {} }
    await h.config(cfg)
    for (const id of ["forge-sw-scout", "forge-sw-coder"]) {
      const worker = cfg.agent[id]
      assert.ok(worker, `${id} materialized`)
      assert.notEqual(worker.tools.forge_grep, false, `${id} keeps forge_grep`)
      assert.notEqual(worker.tools.forge_glob, false, `${id} keeps forge_glob`)
      // The preference is a discipline, not a hiding: builtin grep/glob stay
      // visible as fallback (spec: worker search preference mandate).
      assert.notEqual(worker.tools.grep, false, `${id} keeps builtin grep visible`)
      assert.notEqual(worker.tools.glob, false, `${id} keeps builtin glob visible`)
    }
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("partition: non-forge fallback entries hide both search tools", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-nonforge-"))
  try {
    const h = await startServer(inputFor(wt), {})
    const cfg = { agent: { mine: {}, plain: { tools: { grep: true } } } }
    await h.config(cfg)
    for (const t of ["forge_grep", "forge_glob"]) {
      assert.equal(cfg.agent.plain.tools[t], false, `plain agent hides ${t}`)
      assert.equal(cfg.agent.mine.tools[t], false, `mine hides ${t} (no explicit opt-in)`)
      for (const native of ["build", "plan", "general", "explore"]) {
        assert.equal(cfg.agent[native].tools[t], false, `${native} fallback hides ${t}`)
      }
    }
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("ask-gate: the config hook's permission section gains no forge_grep/forge_glob keys", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-perm-"))
  try {
    const h = await startServer(inputFor(wt), {})
    const cfg = { agent: {} }
    await h.config(cfg)
    const gates = ["plan_approve", "plan_close", "goal_write", "goal_complete", "goal_resume", "goal_discard", "forge_shell", "crew_close"]
    for (const g of gates) assert.equal(cfg.permission[g], "ask", `gate key ${g} stands`)
    assert.equal(cfg.permission.forge_grep, undefined, "no ask-gate on forge_grep")
    assert.equal(cfg.permission.forge_glob, undefined, "no ask-gate on forge_glob")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test("readonly shape: a readonly worker's materialized permission carries no deny on either search tool", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-ro-"))
  try {
    mkdirSync(join(wt, ".opencode"), { recursive: true })
    writeFileSync(
      join(wt, ".opencode", "forge.json"),
      JSON.stringify({ pool: "sw", agents: { scout: { model: "x/y", thoughtLevel: "low", shape: "readonly" } } }),
    )
    const h = await startServer(inputFor(wt), {})
    const cfg = { agent: {} }
    await h.config(cfg)
    const scout = cfg.agent["forge-sw-scout"]
    assert.ok(scout, "readonly scout materialized")
    // The mutating family IS denied (shape seal) — the search pair is not in it.
    assert.equal(scout.permission.write, "deny")
    assert.equal(scout.permission.bash, "deny")
    assert.notEqual(scout.permission.forge_grep, "deny", "no deny on forge_grep")
    assert.notEqual(scout.permission.forge_glob, "deny", "no deny on forge_glob")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// Empty-file parity regression (follow-up fix to task 2.1 wiring): the glob
// vector is rg --files, which lists EMPTY files; the old content vector
// (empty pattern + --glob) could not — zero lines → no match events. Runs
// against the real rg when it resolves; skips with an explicit reason
// otherwise (same discipline as the task-3.1 junction E2E).
test("forge_glob regression: an EMPTY file appears in the results (rg --files semantics)", async (t) => {
  const rg = resolveRgBinary()
  if (!rg.ok) {
    t.skip(`ripgrep not found on this host (${rg.error}) — real-rg parity test skipped`)
    return
  }
  const wt = mkdtempSync(join(tmpdir(), "search-empty-"))
  try {
    writeFileSync(join(wt, "full.ts"), "export const x = 1\n")
    writeFileSync(join(wt, "empty.ts"), "") // zero bytes: invisible to content search
    const h = await startServer(inputFor(wt), {})
    const ctx = { sessionID: "ses_glob", worktree: wt, ask: async () => {}, metadata() {}, callID: "c", agent: "forge", messageID: "m" }
    const r = await h.tool.forge_glob.execute({ pattern: "*.ts" }, ctx)
    const lines = r.output.split("\n")
    assert.ok(lines.includes("empty.ts"), `empty.ts listed (output: ${r.output})`)
    assert.ok(lines.includes("full.ts"), `full.ts listed (output: ${r.output})`)
    // And a grep across the same tree: the empty file yields no match —
    // the vectors stay honest to their semantics.
    const g = await h.tool.forge_grep.execute({ pattern: "export" }, ctx)
    assert.match(g.output, /Found 1 matches/)
    assert.match(g.output, /full\.ts: Line 1:/)
    assert.ok(!g.output.includes("empty.ts"))
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})
