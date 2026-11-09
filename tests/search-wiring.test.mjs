import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs"
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

// ---------------------------------------------------------------------------
// Engine-chain wiring (change search-js-fallback, tasks.md item 3): rg →
// bundled JS engine dispatch, spawn fall-through, engine footnote.
// ---------------------------------------------------------------------------

const ENGINE_FOOTNOTE_MISS =
  "(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)"

function ctxFor(wt, sessionID) {
  return { sessionID, worktree: wt, ask: async () => {}, metadata() {}, callID: "c", agent: "forge", messageID: "m" }
}

// 1. Scrubbed PATH (a temp dir with no rg): the JS engine serves BOTH tools
// with real results + the miss footnote pinned verbatim (spec delta scenario
// "A missing ripgrep serves through the JS engine").
test("engine chain: scrubbed PATH → builtin-js serves forge_grep AND forge_glob with the miss footnote", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-js-grep-"))
  const emptyBin = join(wt, "no-bin") // PATH target: exists, contains no rg
  try {
    mkdirSync(join(wt, "src"), { recursive: true })
    mkdirSync(emptyBin, { recursive: true })
    writeFileSync(join(wt, "src", "a.ts"), "forge-js-wire-needle alpha\n")
    writeFileSync(join(wt, "src", "empty.ts"), "") // zero bytes — glob must list it
    // Review N1 — JS-engine metachar leg: NEEDLE content carrying shell
    // metacharacters (`>`, `|`, quotes) must come back VERBATIM through the
    // JS engine when the pattern itself carries regex metachars.
    writeFileSync(join(wt, "src", "meta.txt"), 'echo "a|b" > out\nplain line\n')
    const h = await startServer(inputFor(wt), {})
    const savedPath = process.env.PATH
    process.env.PATH = emptyBin
    let g, b, m
    try {
      g = await h.tool.forge_grep.execute({ pattern: "forge-js-wire-needle" }, ctxFor(wt, "ses_js_grep"))
      b = await h.tool.forge_glob.execute({ pattern: "**/*.ts" }, ctxFor(wt, "ses_js_glob"))
      m = await h.tool.forge_grep.execute({ pattern: '"a\\|b"' }, ctxFor(wt, "ses_js_meta"))
    } finally {
      process.env.PATH = savedPath
    }
    // grep: first-line parity + real match + footnote pinned verbatim.
    assert.equal(g.output.split("\n")[0], "Found 1 matches", `grep header (output: ${g.output})`)
    assert.ok(g.output.includes(`${join("src", "a.ts")}: Line 1:`), `grep match present (output: ${g.output})`)
    assert.ok(g.output.endsWith(ENGINE_FOOTNOTE_MISS), `miss footnote verbatim, last line (output: ${g.output})`)
    // glob: fixture files listed INCLUDING the empty one + the same footnote.
    assert.ok(b.output.split("\n").includes(join("src", "a.ts")), `glob lists a.ts (output: ${b.output})`)
    assert.ok(b.output.split("\n").includes(join("src", "empty.ts")), `glob lists EMPTY file (output: ${b.output})`)
    assert.ok(b.output.endsWith(ENGINE_FOOTNOTE_MISS), `glob miss footnote verbatim, last line (output: ${b.output})`)
    // N1: the metachar-bearing line comes back VERBATIM through the JS
    // engine (pattern `"a\|b"` — regex-escaped `|` + literal quotes).
    assert.equal(m.output.split("\n")[0], "Found 1 matches", `metachar header (output: ${m.output})`)
    assert.ok(
      m.output.includes(`${join("src", "meta.txt")}: Line 1: echo "a|b" > out`),
      `metachar needle verbatim, | > quotes intact (output: ${m.output})`,
    )
    assert.ok(m.output.endsWith(ENGINE_FOOTNOTE_MISS), `metachar call served by builtin-js (output: ${m.output})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// 1b. Review N2 — readonly-worker direct execution: an EXPLICIT readonly
// pool worker agent id in the tool context, scrubbed PATH, must get REAL
// results through the JS engine AND collect ZERO exec-seal findings (the
// seal governs forge_shell only — search is readonly by construction).
test("engine chain: readonly pool worker executes forge_grep directly (scrubbed PATH) — real results, zero seal findings", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-js-ro-"))
  const emptyBin = join(wt, "no-bin") // PATH target: exists, contains no rg
  try {
    mkdirSync(join(wt, ".opencode"), { recursive: true })
    mkdirSync(join(wt, "src"), { recursive: true })
    mkdirSync(emptyBin, { recursive: true })
    writeFileSync(
      join(wt, ".opencode", "forge.json"),
      JSON.stringify({ pool: "sw", agents: { scout: { model: "x/y", thoughtLevel: "low", shape: "readonly" } } }),
    )
    writeFileSync(join(wt, "src", "a.ts"), "readonly-worker-needle alpha\n")
    const h = await startServer(inputFor(wt), {})
    const ctx = { sessionID: "ses_js_ro", worktree: wt, ask: async () => {}, metadata() {}, callID: "c", agent: "forge-sw-scout", messageID: "m" }
    const savedPath = process.env.PATH
    process.env.PATH = emptyBin
    let r
    try {
      r = await h.tool.forge_grep.execute({ pattern: "readonly-worker-needle" }, ctx)
    } finally {
      process.env.PATH = savedPath
    }
    assert.equal(r.output.split("\n")[0], "Found 1 matches", `header — JS engine served the readonly worker (output: ${r.output})`)
    assert.ok(r.output.includes(`${join("src", "a.ts")}: Line 1:`), `real match present (output: ${r.output})`)
    assert.ok(r.output.endsWith(ENGINE_FOOTNOTE_MISS), `engine footnote last (output: ${r.output})`)
    assert.deepEqual(h.__forgeSubagentsTest.sealFindings("ses_js_ro"), [], "search on the readonly worker collects no seal findings")
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// 2. Override wins (spec delta scenario "The config override wins when set"):
// searchRgPathOverride at a WORKING rg (the real binary when this host has
// one — the only honest working stand-in) → results served by rg, NO
// footnote. Skips with an explicit reason on rg-less hosts (never fake-green).
test("engine chain: searchRgPathOverride at a working rg → rg serves, no engine footnote", async (t) => {
  const rg = resolveRgBinary()
  if (!rg.ok) {
    t.skip(`ripgrep not found on this host (${rg.error}) — override-wins test skipped`)
    return
  }
  const wt = mkdtempSync(join(tmpdir(), "search-js-ovr-"))
  try {
    writeFileSync(join(wt, "a.ts"), "forge-ovr-needle alpha\n")
    const h = await startServer(inputFor(wt), { search: { rgPath: rg.binary } })
    const r = await h.tool.forge_grep.execute({ pattern: "forge-ovr-needle" }, ctxFor(wt, "ses_js_ovr"))
    assert.equal(r.output.split("\n")[0], "Found 1 matches", `header (output: ${r.output})`)
    assert.ok(r.output.includes("a.ts: Line 1:"), `rg-served match present (output: ${r.output})`)
    assert.ok(!r.output.includes("(engine:"), `no engine footnote on an rg-served call (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// 3. Broken override (spec delta scenario "A broken override falls through"):
// searchRgPathOverride at an EXISTING but broken stand-in — the host node
// binary, which spawns fine but exits >1 on rg's argv (bad option) — must
// fall through to the JS engine with the rg-failure footnote (reason
// substring flexible; the `(engine: builtin-js — rg failed` prefix pinned).
test("engine chain: broken override (exits >1) → JS engine serves with the rg-failure footnote", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-js-broken-"))
  try {
    writeFileSync(join(wt, "a.ts"), "forge-broken-ovr-needle alpha\n")
    // process.execPath exists on disk (resolution ok via config source) and
    // spawns, but node rejects rg's argv (`--no-config` etc.) → exit code 9.
    const h = await startServer(inputFor(wt), { search: { rgPath: process.execPath } })
    const r = await h.tool.forge_grep.execute({ pattern: "forge-broken-ovr-needle" }, ctxFor(wt, "ses_js_broken"))
    assert.equal(r.output.split("\n")[0], "Found 1 matches", `header — JS engine served (output: ${r.output})`)
    assert.ok(r.output.includes("a.ts: Line 1:"), `match present via builtin-js (output: ${r.output})`)
    const last = r.output.split("\n").at(-1)
    assert.ok(last.startsWith("(engine: builtin-js — rg failed to serve the call ("), `rg-failure footnote prefix (last line: ${last})`)
    assert.ok(/; install ripgrep or set search\.rgPath\)$/.test(last), `footnote closes with the remedy (last line: ${last})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// 4. Junction through the JS engine — the field-parity scenario from the
// spec delta ("The JS engine traverses a workspace junction"): a junction
// whose target dir lies OUTSIDE the worktree, scrubbed PATH, forge_glob must
// find the target files under the LINK-relative path AND disclose the outside
// target AND carry the engine footnote. Same junction-fixture convention as
// search-behavior.test.mjs (symlinkSync "junction" needs no admin on win32).
test("engine chain: junction to an outside target through builtin-js — link paths + outside disclosure + footnote", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-sjw-junc-"))
  const outside = mkdtempSync(join(tmpdir(), "forge-sjw-outside-"))
  const wt = join(root, "wt")
  try {
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, "local.txt"), "local\n")
    writeFileSync(join(outside, "external.txt"), "external\n")
    symlinkSync(outside, join(wt, "out_link"), "junction")
    const h = await startServer(inputFor(wt), {})
    const savedPath = process.env.PATH
    process.env.PATH = root // no rg anywhere in the scrubbed PATH
    let r
    try {
      r = await h.tool.forge_glob.execute({ pattern: "**/*.txt" }, ctxFor(wt, "ses_js_junc"))
    } finally {
      process.env.PATH = savedPath
    }
    const lines = r.output.split("\n")
    // (a) target files found under the LINK-relative path.
    assert.ok(lines.includes(join("out_link", "external.txt")), `link-relative path listed (output: ${r.output})`)
    assert.ok(lines.includes("local.txt"), `worktree file listed (output: ${r.output})`)
    // (b) the output discloses the resolved outside target.
    const resolved = realpathSync.native(join(outside, "external.txt")).toString()
    const disclosures = lines.filter((l) => l.startsWith("outside-workspace target searched via link: "))
    assert.equal(disclosures.length, 1, `exactly one disclosure line (output: ${r.output})`)
    assert.ok(disclosures[0].toLowerCase().endsWith(resolved.toLowerCase()), `disclosure names the resolved outside target ${resolved} (output: ${r.output})`)
    // (c) the engine footnote is present (last line).
    assert.ok(r.output.endsWith(ENGINE_FOOTNOTE_MISS), `engine footnote last (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// search-glob-anchor: explicit-directory path anchors pattern AND output on
// BOTH engine legs (rg 15.2.0 lifts glob anchoring to the whole path when
// --hidden/--follow meet an ABSOLUTE root — our defaults — so anchored
// patterns silently matched nothing on the rg leg pre-fix; bisect-verified
// 2026-11-09 live session).
// ---------------------------------------------------------------------------

// A. THE regression (fails on 0.21.0): anchored glob + explicit DIRECTORY
// path must find one-level files and report them TARGET-relative. rg leg
// (skip-guarded on rg-less hosts — never fake-green).
test("anchor: explicit directory path — anchored */tasks.md finds one-level files, target-relative (rg leg)", async (t) => {
  const rg = resolveRgBinary()
  if (!rg.ok) {
    t.skip(`ripgrep not found on this host (${rg.error}) — rg-leg anchor test skipped`)
    return
  }
  const wt = mkdtempSync(join(tmpdir(), "search-anchor-rg-"))
  try {
    mkdirSync(join(wt, "changes", "alpha"), { recursive: true })
    mkdirSync(join(wt, "changes", "beta"), { recursive: true })
    writeFileSync(join(wt, "changes", "alpha", "tasks.md"), "# alpha\n")
    writeFileSync(join(wt, "changes", "beta", "tasks.md"), "# beta\n")
    writeFileSync(join(wt, "changes", "README.md"), "# not a tasks file\n")
    const h = await startServer(inputFor(wt), {})
    // Relative path arg — exercises the join(worktree, path) + stat chain.
    const r = await h.tool.forge_glob.execute({ pattern: "*/tasks.md", path: "changes" }, ctxFor(wt, "ses_anchor_rg"))
    const lines = r.output.split("\n")
    assert.ok(lines.includes(join("alpha", "tasks.md")), `alpha listed TARGET-relative (output: ${r.output})`)
    assert.ok(lines.includes(join("beta", "tasks.md")), `beta listed TARGET-relative (output: ${r.output})`)
    assert.ok(!lines.some((l) => l.includes("README.md")), `non-matching file absent (output: ${r.output})`)
    assert.ok(!lines.some((l) => l.includes(wt)), `no absolute-prefix paths (output: ${r.output})`)
    assert.ok(!r.output.includes("(engine:"), `rg-served, no footnote (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// B. Cross-engine consistency (spec delta scenario "Cross-engine agreement"):
// the SAME anchored query served by rg (when present) and by builtin-js
// (scrubbed PATH) must yield IDENTICAL path sets — the JS copy additionally
// carries the engine footnote.
test("anchor: cross-engine agreement — identical path sets for the same explicit-path anchored query", async (t) => {
  const rg = resolveRgBinary()
  if (!rg.ok) {
    t.skip(`ripgrep not found on this host (${rg.error}) — cross-engine test needs both legs`)
    return
  }
  const wt = mkdtempSync(join(tmpdir(), "search-anchor-x-"))
  const emptyBin = join(wt, "no-bin")
  try {
    for (const d of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(wt, "changes", d), { recursive: true })
      writeFileSync(join(wt, "changes", d, "tasks.md"), "# x\n")
    }
    mkdirSync(emptyBin, { recursive: true })
    const h = await startServer(inputFor(wt), {})
    const viaRg = await h.tool.forge_glob.execute({ pattern: "*/tasks.md", path: "changes" }, ctxFor(wt, "ses_anchor_x_rg"))
    const savedPath = process.env.PATH
    process.env.PATH = emptyBin
    let viaJs
    try {
      viaJs = await h.tool.forge_glob.execute({ pattern: "*/tasks.md", path: "changes" }, ctxFor(wt, "ses_anchor_x_js"))
    } finally {
      process.env.PATH = savedPath
    }
    const stripFootnotes = (o) => o.split("\n").filter((l) => !l.startsWith("(engine:"))
    assert.deepEqual(stripFootnotes(viaJs.output), stripFootnotes(viaRg.output), `identical path sets across engines (rg: ${viaRg.output} / js: ${viaJs.output})`)
    assert.ok(viaJs.output.endsWith(ENGINE_FOOTNOTE_MISS), `JS copy footnoted (output: ${viaJs.output})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// C. grep-leg anchored `include` + explicit directory: only files one level
// under the target matching the anchored include are searched (the include
// rides the same --glob and inherited the defect pre-fix). JS leg (works on
// every host; the rg-leg shape is proven by A).
test("anchor: grep include anchored to the explicit directory — only matching level searched", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-anchor-inc-"))
  const emptyBin = join(wt, "no-bin")
  try {
    mkdirSync(join(wt, "sub", "one"), { recursive: true })
    mkdirSync(join(wt, "sub", "two"), { recursive: true })
    mkdirSync(emptyBin, { recursive: true })
    writeFileSync(join(wt, "sub", "one", "x.txt"), "anchor-include-needle\n")
    writeFileSync(join(wt, "sub", "two", "y.txt"), "anchor-include-needle\n")
    writeFileSync(join(wt, "sub", "top.txt"), "anchor-include-needle\n")
    const h = await startServer(inputFor(wt), {})
    const savedPath = process.env.PATH
    process.env.PATH = emptyBin
    let r
    try {
      r = await h.tool.forge_grep.execute({ pattern: "anchor-include-needle", include: "*/x.txt", path: "sub" }, ctxFor(wt, "ses_anchor_inc"))
    } finally {
      process.env.PATH = savedPath
    }
    assert.equal(r.output.split("\n")[0], "Found 1 matches", `only the anchored include's file matched (output: ${r.output})`)
    assert.ok(r.output.includes(`${join("one", "x.txt")}: Line 1:`), `match reported TARGET-relative (output: ${r.output})`)
    assert.ok(!r.output.includes("y.txt") && !r.output.includes("top.txt"), `non-include files untouched (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// D. Unchanged shapes (spec delta scenario "default root and file roots are
// unchanged"): default root stays worktree-relative; a FILE path root keeps
// its absolute-argument shape.
test("anchor: default root stays worktree-relative; file root keeps the absolute shape", async () => {
  const wt = mkdtempSync(join(tmpdir(), "search-anchor-def-"))
  try {
    writeFileSync(join(wt, "plain.ts"), "anchor-default-needle\n")
    const h = await startServer(inputFor(wt), {})
    const d = await h.tool.forge_grep.execute({ pattern: "anchor-default-needle" }, ctxFor(wt, "ses_anchor_def"))
    assert.ok(d.output.includes("plain.ts: Line 1:"), `default root worktree-relative (output: ${d.output})`)
    const absFile = join(wt, "plain.ts")
    const f = await h.tool.forge_grep.execute({ pattern: "anchor-default-needle", path: absFile }, ctxFor(wt, "ses_anchor_file"))
    assert.ok(f.output.includes("Line 1:"), `file root served (output: ${f.output})`)
    await h.dispose?.()
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})
