// Import me FIRST (before plugin.ts) in any test file that needs the HOME
// alias (FORGE_TEST_FORGE_HOME — where `~/.config` forge config is looked
// up) in place BEFORE the plugin module is evaluated. ESM evaluates imports
// in order, so this module's side effect runs before the plugin module body.
//
// fix-session-anchor-ledger-use-time-path: the ledger path used to be
// resolved at plugin module load, from FORGE_TEST_FORGE_HOME. A test file
// that set the variable in its own body was always too late (imports are
// hoisted above every statement), so its binds went to the REAL
// `<os-tmp>/opencode-forge/` ledger. This module points the variable at a
// private temp directory before the plugin is evaluated — so that even a
// load-time resolution (the mutation check of that change re-introduces one
// on purpose) can never reach the real file.
//
// The `<os-tmp>` runtime-artifact namespace (job logs, caches, ledgers) is a
// different axis, redirected by the suite preload; importing it here keeps
// this module sufficient on its own.
import "./test-runtime-namespace.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (!process.env.FORGE_TEST_FORGE_HOME) {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-env-home-"))
  process.env.FORGE_TEST_FORGE_HOME = dir
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A handle that outlived the test keeps a file locked — leave it.
    }
  })
}
