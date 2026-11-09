import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRgBinary, RG_MISSING_REMEDIES } from "../src/search-core.ts"

// Task group 3 — behavior tests for forge_grep/forge_glob (change
// forge-search-tools tasks 3.1/3.2). Task 3.1 is a REAL-filesystem Windows
// junction E2E driven through the registered tool execute surface (the
// closest seam to a live host call this repo's wiring tests reach); it runs
// against the real rg binary when it resolves and SKIPS with an explicit
// reason otherwise (design risk table: never fake-green). Task 3.2 is the
// rg-missing fail-soft path on fake fs/PATH seams — no real fs dependency.

// Debounce must be tiny BEFORE plugin.ts is imported (module-level const).
process.env.FORGE_GOAL_DEBOUNCE_MS = "10"
process.env.FORGE_TEST_NO_FENCE = "1"
const { server } = await import("../plugin.ts")

// Host-lifetime simulation (same discipline as search-wiring/partition-wiring):
// reset the anchor set before each server() call so every test runs on a
// fresh host.
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

function ctxFor(wt, sessionID) {
  return { sessionID, worktree: wt, ask: async () => {}, metadata() {}, callID: "c", agent: "forge", messageID: "m" }
}

// ---------------------------------------------------------------------------
// Task 3.1 — Windows junction E2E (real fs, real rg when it resolves)
// ---------------------------------------------------------------------------

// Resolve rg ONCE with the real seams (real PATH, real existsSync). Every
// E2E test skips with this reason when the binary is unavailable.
const RG = resolveRgBinary()
const SKIP_REASON = `ripgrep not found on this host (${RG.ok ? "" : RG.error}) — real-rg junction E2E skipped`

/** Unique needles so tests cannot cross-contaminate via temp-dir siblings. */
const NEEDLE = "forge-junc-e2e-needle-7f3a"
const OUT_NEEDLE = "forge-outside-e2e-needle-b19c"

/** Fixture: worktree with real/ (hello.txt + sub/deep.txt), a dot-dir
 * .hidden/ with a matching file, and a junction link_junc → real/. All
 * paths are explicit absolute Windows paths (mkdtemp under the OS temp
 * dir); junction creation via symlinkSync(..., "junction") needs no admin. */
function makeJunctionFixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `forge-sbh-${tag}-`))
  const wt = join(root, "wt")
  mkdirSync(join(wt, "real", "sub"), { recursive: true })
  writeFileSync(join(wt, "real", "hello.txt"), `${NEEDLE} alpha\n`)
  writeFileSync(join(wt, "real", "sub", "deep.txt"), `${NEEDLE} beta\n`)
  mkdirSync(join(wt, ".hidden"), { recursive: true })
  writeFileSync(join(wt, ".hidden", "needle.txt"), `${NEEDLE} gamma\n`)
  symlinkSync(join(wt, "real"), join(wt, "link_junc"), "junction")
  return { root, wt }
}

// a) Spec scenario "Content search traverses a workspace junction" +
//    "A file behind a junction reports once": pre-dedupe the needle matches
//    under BOTH real\ and link_junc\ (2 files × 2 paths = 4 records) plus the
//    dot-dir hit (5 raw); the +2 footnote proves the link/real duplication
//    existed pre-dedupe, and each unique file reports ONCE post-dedupe under
//    the lexicographically first path (link_junc\... < real\...).
test("3.1a grep defaults: junction content found, deduped to one report per file with the +N footnote", async (t) => {
  if (!RG.ok) return t.skip(SKIP_REASON)
  const { root, wt } = makeJunctionFixture("grep")
  try {
    const h = await startServer(inputFor(wt), {})
    const r = await h.tool.forge_grep.execute({ pattern: NEEDLE }, ctxFor(wt, "ses_e2e_grep"))
    const lines = r.output.split("\n")
    assert.equal(lines[0], "Found 3 matches", `header (output: ${r.output})`)
    // Dot-dir hit visible by default (hidden defaults TRUE).
    assert.ok(r.output.includes(`${join(".hidden", "needle.txt")}: Line 1:`), `dot-dir match present (output: ${r.output})`)
    // Each junction pair reports ONCE, under the lexicographically first
    // path (link_junc\... < real\... — byte comparison, same as the core).
    for (const pair of [
      [join("real", "hello.txt"), join("link_junc", "hello.txt")],
      [join("real", "sub", "deep.txt"), join("link_junc", "sub", "deep.txt")],
    ]) {
      const kept = pair.slice().sort()[0]
      assert.ok(r.output.includes(`${kept}: Line 1:`), `kept representative ${kept} present (output: ${r.output})`)
      assert.ok(!r.output.includes(`${pair[0]}:`) || pair[0] === kept, `merged duplicate ${pair[0]} absent (output: ${r.output})`)
    }
    // The footnote is the dedupe evidence: 2 link-path duplicates merged.
    assert.ok(lines.includes("+2 duplicate paths merged"), `footnote line verbatim (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// b) Spec scenario "Dot-directories are visible to forge_glob" + junction
//    paths listed (follow defaults TRUE).
test("3.1b glob defaults: dot-directory files listed AND junction path listed", async (t) => {
  if (!RG.ok) return t.skip(SKIP_REASON)
  const { root, wt } = makeJunctionFixture("glob")
  try {
    const h = await startServer(inputFor(wt), {})
    const r = await h.tool.forge_glob.execute({ pattern: "**/*.txt" }, ctxFor(wt, "ses_e2e_glob"))
    const lines = r.output.split("\n")
    assert.ok(lines.includes(join(".hidden", "needle.txt")), `dot-dir file listed (output: ${r.output})`)
    assert.ok(lines.includes(join("link_junc", "hello.txt")), `junction path listed (output: ${r.output})`)
    assert.ok(lines.includes(join("link_junc", "sub", "deep.txt")), `junction deep path listed (output: ${r.output})`)
    assert.ok(!lines.includes(join("real", "hello.txt")), `real-path duplicate merged away (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// c) Opt-out parity: follow:false restores the builtin scope — no traversal
//    through the junction (spec scenario "Opt-out params restore builtin
//    behavior").
test("3.1c grep follow:false — junction content absent from results", async (t) => {
  if (!RG.ok) return t.skip(SKIP_REASON)
  const { root, wt } = makeJunctionFixture("nofollow")
  try {
    const h = await startServer(inputFor(wt), {})
    const r = await h.tool.forge_grep.execute({ pattern: NEEDLE, follow: false }, ctxFor(wt, "ses_e2e_nofollow"))
    assert.ok(!r.output.includes("link_junc"), `no junction path (output: ${r.output})`)
    assert.equal(r.output.split("\n")[0], "Found 3 matches", `real+hidden only (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// d) Opt-out parity: hidden:false drops the dot-directory content.
test("3.1d grep hidden:false — dot-directory content absent from results", async (t) => {
  if (!RG.ok) return t.skip(SKIP_REASON)
  const { root, wt } = makeJunctionFixture("nohidden")
  try {
    const h = await startServer(inputFor(wt), {})
    const r = await h.tool.forge_grep.execute({ pattern: NEEDLE, hidden: false }, ctxFor(wt, "ses_e2e_nohidden"))
    assert.ok(!r.output.includes(".hidden"), `no dot-dir content (output: ${r.output})`)
    assert.equal(r.output.split("\n")[0], "Found 2 matches", `2 unique files via real+junction, deduped (output: ${r.output})`)
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// e) Spec scenario "An outside-workspace link is followed and disclosed":
// a second temp dir OUTSIDE the worktree root, linked in via junction; grep
// worktree defaults return the match AND the disclosure naming the resolved
// outside target (followed, never refused — design D3).
test("3.1e grep defaults: outside-workspace link followed and resolved target disclosed", async (t) => {
  if (!RG.ok) return t.skip(SKIP_REASON)
  const { root, wt } = makeJunctionFixture("outside")
  const outside = mkdtempSync(join(tmpdir(), "forge-sbh-outside-"))
  try {
    writeFileSync(join(outside, "external.txt"), `${OUT_NEEDLE} delta\n`)
    symlinkSync(outside, join(wt, "outside_link"), "junction")
    const h = await startServer(inputFor(wt), {})
    const r = await h.tool.forge_grep.execute({ pattern: OUT_NEEDLE }, ctxFor(wt, "ses_e2e_outside"))
    // Match returned THROUGH the link (followed, not refused).
    assert.equal(r.output.split("\n")[0], "Found 1 matches", `one match via the link (output: ${r.output})`)
    assert.ok(r.output.includes(`${join("outside_link", "external.txt")}: Line 1:`), `link-path match present (output: ${r.output})`)
    // Disclosure names the RESOLVED outside target — the realpath of the
    // reported match path (the plugin's dedupe seam resolves each reported
    // path; the resolved file path escapes the worktree → disclosure).
    const resolved = realpathSync.native(join(outside, "external.txt")).toString()
    const disclosureLines = r.output.split("\n").filter((l) => l.startsWith("outside-workspace target searched via link: "))
    assert.equal(disclosureLines.length, 1, `exactly one disclosure line (output: ${r.output})`)
    assert.ok(
      disclosureLines[0].toLowerCase().endsWith(resolved.toLowerCase()),
      `disclosure names the resolved target ${resolved} (output: ${r.output})`,
    )
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Task 3.2 — rg-missing fail-soft (fake seams, no real fs dependency)
// ---------------------------------------------------------------------------

// The fail-soft error text is a CONTRACT (spec: names both remedies). The
// literal is hardcoded here AND cross-checked against the exported constant.
const EXPECTED_RG_MISSING_ERROR =
  "ripgrep (rg) not found — install ripgrep (or set search.rgPath in forge config to an existing rg binary), or fall back to the builtin grep/glob tools for this search"

test("3.2 resolver fail-soft (fake seams): no override + PATH miss → exact guidance error object, nothing throws", () => {
  assert.equal(RG_MISSING_REMEDIES, EXPECTED_RG_MISSING_ERROR.slice("ripgrep (rg) not found — ".length), "exported remedies constant matches the contract literal")
  // win32 seam: no rgPath override, fake existsSync always misses, PATH has
  // entries but none contains rg.
  const win = resolveRgBinary(undefined, {
    existsSync: () => false,
    pathEnv: "C:\\fake\\bin;C:\\other\\tools",
    pathSep: ";",
    platform: "win32",
  })
  assert.equal(win.ok, false, "not ok")
  assert.equal(win.error, EXPECTED_RG_MISSING_ERROR, "exact contract text (win32)")
  // posix seam parity: same guidance through the posix join/separator.
  const nix = resolveRgBinary(undefined, {
    existsSync: () => false,
    pathEnv: "/fake/bin:/other/tools",
    pathSep: ":",
    platform: "linux",
  })
  assert.equal(nix.ok, false, "not ok (posix)")
  assert.equal(nix.error, EXPECTED_RG_MISSING_ERROR, "exact contract text (posix)")
  // Both remedies named, verbatim, in the error body.
  assert.match(EXPECTED_RG_MISSING_ERROR, /install ripgrep/, "remedy 1: install ripgrep")
  assert.match(EXPECTED_RG_MISSING_ERROR, /fall back to the builtin grep\/glob tools for this search/, "remedy 2: builtin fallback")
  // Empty PATH env degrades to the same guidance (no dirs to scan).
  const empty = resolveRgBinary(undefined, { existsSync: () => false, pathEnv: "", pathSep: ";", platform: "win32" })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, EXPECTED_RG_MISSING_ERROR, "exact contract text (empty PATH)")
})

// Wiring-level engine chain (change search-js-fallback): the tool surface
// itself now SERVES the call through the bundled JS engine — real results +
// the miss footnote, no throw, no crash — when the PATH scan misses at call
// time (resolution runs per call; no spawn happens on a miss). The old
// fail-soft guidance output is dead contract, superseded by the spec delta's
// "A missing ripgrep serves through the JS engine" scenario.
test("3.2 wiring engine chain: forge_grep execute serves real results + miss footnote when rg does not resolve", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-sbh-miss-"))
  const wt = join(root, "wt")
  try {
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, "served.ts"), "forge-miss-served-needle alpha\n")
    const h = await startServer(inputFor(wt), {})
    const savedPath = process.env.PATH
    process.env.PATH = "" // PATH scan finds nothing; no rgPath override is configured
    let r
    try {
      r = await h.tool.forge_grep.execute({ pattern: "forge-miss-served-needle" }, ctxFor(wt, "ses_e2e_miss"))
    } finally {
      process.env.PATH = savedPath
    }
    assert.equal(r.output.split("\n")[0], "Found 1 matches", `first-line parity — the JS engine served (output: ${r.output})`)
    assert.ok(r.output.includes("served.ts: Line 1:"), `real match present (output: ${r.output})`)
    assert.ok(
      r.output.endsWith("(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)"),
      `miss footnote verbatim, last line (output: ${r.output})`,
    )
    await h.dispose?.()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
