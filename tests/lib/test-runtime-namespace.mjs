// Suite preload — the ONE place the test runtime namespace is redirected.
//
// Canonical entry (package.json "test"):
//   node --import ./tests/lib/test-runtime-namespace.mjs --test tests/*.test.mjs
//
// fix-test-runtime-namespace-isolation: the plugin keeps its per-host runtime
// artifacts (job logs, the survivor registry, the jobs ledger, the models-dev
// cache, the watchdog ledger, the session-anchor ledger) under
// `<os-tmp>/opencode-forge/` — the directory the REAL host plugin is using
// right now. Until 2026-11-24 a unit test that spawned a real job wrote into
// that directory: it overwrote the host's `registry.json` and its
// `ensureJobLifecycle` adopted the host's live survivors into the test
// process; every `config` hook rewrote the host's models-dev snapshot; one
// test deleted the host's whole watchdog directory.
//
// Setting FORGE_TEST_RUNTIME_DIR here (before any test module is evaluated,
// in every test-file process the runner spawns) swaps the `<os-tmp>` level of
// that namespace for a private temp directory per process, removed on exit.
// It is a preload rather than a per-file import so that isolation holds by
// construction for every test file — including ones nobody remembers to
// touch. A test file that imports this module explicitly (so that a direct
// `node --test tests/<file>` run is isolated too) gets the same thing; the
// guard makes the double import a no-op.
//
// The suite also owns a fixture root. Ordinary real-disk recipe discovery
// may only see files below this root; injected filesystem fixtures are
// unaffected. Redirect OS temp so existing mkdtemp-based fixtures stay valid.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (process.env.FORGE_TEST_FIXTURE_OWNER !== String(process.pid)) {
  const root = mkdtempSync(join(tmpdir(), "forge-test-fixtures-"))
  process.env.FORGE_TEST_FIXTURE_ROOT = root
  process.env.FORGE_TEST_FIXTURE_OWNER = String(process.pid)
  // An inherited host config override is not a test fixture. Tests that need
  // one set it explicitly in their body, after the preload.
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.FORGE_TEST_FORGE_HOME
  process.on("exit", () => {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
}
const root = process.env.FORGE_TEST_FIXTURE_ROOT
for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = root
if (!process.env.FORGE_TEST_FORGE_HOME) {
  const home = mkdtempSync(join(root, "home-"))
  process.env.FORGE_TEST_FORGE_HOME = home
  process.on("exit", () => {
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  })
}

if (!process.env.FORGE_TEST_RUNTIME_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-ns-"))
  process.env.FORGE_TEST_RUNTIME_DIR = dir
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A handle that outlived the test keeps a file locked — leave it.
    }
  })
}
