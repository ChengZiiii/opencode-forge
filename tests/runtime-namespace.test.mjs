import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Direct-run parity: the suite preloads this (package.json "test"); importing
// it here keeps a bare `node --test tests/runtime-namespace.test.mjs` just as
// isolated.
import "./lib/test-runtime-namespace.mjs"

import { server, __runtimeNamespaceTestSurface } from "../plugin.ts"
import { jobsLogDir } from "../src/job-runner.ts"
import { modelsDevCacheDir } from "../src/models-dev.ts"
import { watchdogLogDir } from "../src/watchdog.ts"

// fix-test-runtime-namespace-isolation (design D3). The plugin's runtime
// artifacts (job logs + survivor registry + jobs ledger, the models-dev cache,
// the watchdog ledger, the session-anchor ledger) live under
// `<os-tmp>/opencode-forge/` — the directory the REAL host plugin uses while
// a test suite runs. `<os-tmp>` is swapped by FORGE_TEST_RUNTIME_DIR, resolved
// at use time; FORGE_TEST_FORGE_HOME stays the HOME alias it always was (it
// moves the session-anchor ledger, and nothing else — as before).

// No real fence watcher here: its stdin pipe holds the event loop open.
process.env.FORGE_TEST_NO_FENCE = "1"

const ns = __runtimeNamespaceTestSurface
const dirs = []
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// Set (undefined = remove) the two redirect variables for the duration of a
// synchronous body, then restore exactly what was there.
const withEnv = (vars, body) => {
  const prev = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return body()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
// Forward slashes, no trailing separator — the only normalization applied.
const slash = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "")

const homes = () => ({
  tmp: ns.tmp() ?? null,
  root: slash(ns.root()),
  jobs: slash(ns.jobLogDir()),
  jobLedger: slash(ns.jobLedgerPath()),
  models: slash(ns.modelsDevCacheDir()),
  watchdog: slash(ns.watchdogLogDir()),
  probe: slash(ns.probeTmp()),
  ledger: slash(ns.sessionAnchorLedgerPath()),
})

test("N1: `<os-tmp>` follows FORGE_TEST_RUNTIME_DIR at use time; FORGE_TEST_FORGE_HOME moves only the session-anchor ledger, as before", () => {
  const rt = mk("forge-ns-runtime-")
  const home = mk("forge-ns-home-")
  const tmp = slash(tmpdir())

  // (a) The redirect swaps the `<os-tmp>` level; the tree mirrors production
  //     (`<tmp>/opencode-forge/<artifact>`), only `<tmp>` moved.
  const a = withEnv({ FORGE_TEST_RUNTIME_DIR: rt, FORGE_TEST_FORGE_HOME: home }, homes)
  assert.deepEqual(a, {
    tmp: rt,
    root: `${slash(rt)}/opencode-forge`,
    jobs: `${slash(rt)}/opencode-forge/jobs`,
    jobLedger: `${slash(rt)}/opencode-forge/jobs/ledger.jsonl`,
    models: `${slash(rt)}/opencode-forge/models-dev`,
    watchdog: `${slash(rt)}/opencode-forge/watchdog`,
    probe: slash(rt),
    ledger: `${slash(home)}/opencode-forge/session-anchors.jsonl`,
  })

  // (b) The HOME alias ALONE moves only the ledger — the behavior every
  //     existing test file was written against, unchanged.
  const b = withEnv({ FORGE_TEST_RUNTIME_DIR: undefined, FORGE_TEST_FORGE_HOME: home }, homes)
  assert.equal(b.tmp, null)
  assert.equal(b.jobs, `${tmp}/opencode-forge/jobs`)
  assert.equal(b.models, `${tmp}/opencode-forge/models-dev`)
  assert.equal(b.watchdog, `${tmp}/opencode-forge/watchdog`)
  assert.equal(b.probe, tmp)
  assert.equal(b.ledger, `${slash(home)}/opencode-forge/session-anchors.jsonl`)

  // (c) The redirect alone carries the ledger along (HOME unset).
  const c = withEnv({ FORGE_TEST_RUNTIME_DIR: rt, FORGE_TEST_FORGE_HOME: undefined }, homes)
  assert.equal(c.ledger, `${slash(rt)}/opencode-forge/session-anchors.jsonl`)

  // (d) Production: neither variable → each src helper's own default,
  //     byte-identical.
  const d = withEnv({ FORGE_TEST_RUNTIME_DIR: undefined, FORGE_TEST_FORGE_HOME: undefined }, homes)
  assert.deepEqual(d, {
    tmp: null,
    root: `${tmp}/opencode-forge`,
    jobs: `${tmp}/opencode-forge/jobs`,
    jobLedger: `${tmp}/opencode-forge/jobs/ledger.jsonl`,
    models: `${tmp}/opencode-forge/models-dev`,
    watchdog: `${tmp}/opencode-forge/watchdog`,
    probe: tmp,
    ledger: `${tmp}/opencode-forge/session-anchors.jsonl`,
  })
  assert.equal(d.jobs, slash(jobsLogDir()), "identical to the src default the plugin used before")
  assert.equal(d.models, slash(modelsDevCacheDir()), "identical to the src default the plugin used before")
  assert.equal(d.watchdog, slash(watchdogLogDir()), "identical to the src default the plugin used before")

  // Four different answers from one process in a row = use-time resolution.
  // (A module-load constant would have answered the same thing every time.)
  assert.equal(ns.tmp(), process.env.FORGE_TEST_RUNTIME_DIR, "restored to what the suite preload set")
})

const serverInput = () => ({
  client: { session: {} },
  project: { id: "p" },
  directory: "/w",
  worktree: "/w",
  serverUrl: new URL("http://127.0.0.1:1"),
  $: () => {},
})
const ctxFor = (sessionID) => ({
  sessionID,
  worktree: mk("forge-ns-wt-"),
  ask: async () => ({ status: "allow" }),
  metadata: () => {},
})
// The finished form carries `jobId: j-…` on its own line; the still-running
// form says "The process is alive as job j-…". One id shape covers both.
const jobIdOf = (text) => {
  const id = /j-\d{8}-\d{6}-[0-9a-z]+/.exec(String(text))?.[0]
  assert.ok(id, `the result names the job id; got: ${String(text).slice(0, 160)}`)
  return id
}

// Run `body` with FORGE_TEST_RUNTIME_DIR = rt, restoring the variable after.
const withRuntimeDir = async (t, rt, body) => {
  const prev = process.env.FORGE_TEST_RUNTIME_DIR
  process.env.FORGE_TEST_RUNTIME_DIR = rt
  try {
    return await body()
  } finally {
    if (prev === undefined) delete process.env.FORGE_TEST_RUNTIME_DIR
    else process.env.FORGE_TEST_RUNTIME_DIR = prev
  }
}

test("N2: a real job spawned through server() writes ONLY inside the redirected namespace", async (t) => {
  const rt = mk("forge-ns-job-")
  await withRuntimeDir(t, rt, async () => {
    const h = await server(serverInput(), { jobs: { mode: "forge" } })
    t.after(() => h.dispose?.())
    const res = await h.tool.forge_shell.execute({ command: `node -e "console.log('ns-ok')"`, idle_ms: 8000, max_wait_ms: 20000 }, ctxFor("ses-ns"))
    const text = String(res.output)
    assert.match(text, /ns-ok/, "the job ran")
    const jobId = jobIdOf(text)

    const nsJobs = join(rt, "opencode-forge", "jobs")
    assert.deepEqual(
      readdirSync(nsJobs).filter((f) => f.startsWith(jobId)),
      [`${jobId}.log`],
      "the job's log is in the redirected namespace",
    )
    assert.ok(existsSync(join(nsJobs, "registry.json")), "the survivor registry lives there (never the host's)")

    // …and nothing of this job under the real directory the host plugin uses.
    const realJobs = jobsLogDir()
    assert.notEqual(slash(realJobs), slash(nsJobs))
    assert.equal(
      existsSync(realJobs) && readdirSync(realJobs).some((f) => f.startsWith(jobId)),
      false,
      "no trace of this job anywhere in the real jobs directory",
    )
  })
})

test("N3: a job still running at plugin dispose is killed AND ledgered inside the redirected namespace", async (t) => {
  const rt = mk("forge-ns-ledger-")
  await withRuntimeDir(t, rt, async () => {
    const ledgerPath = join(rt, "opencode-forge", "jobs", "ledger.jsonl")
    assert.equal(ns.jobLedgerPath(), ledgerPath, "the ledger sink resolves through the redirect")
    assert.equal(existsSync(ledgerPath), false, "nothing ledgered yet")

    const h = await server(serverInput(), { jobs: { mode: "forge" } })
    const res = await h.tool.forge_shell.execute({ command: `node -e "setTimeout(() => {}, 15000)"`, idle_ms: 1000, max_wait_ms: 6000 }, ctxFor("ses-ns3"))
    const jobId = jobIdOf(res.output)
    assert.equal(existsSync(ledgerPath), false, "a plain running job has not ledgered anything")

    await h.dispose()
    assert.equal(existsSync(ledgerPath), true, "the dispose kill ledgered into the redirected namespace")
    assert.match(readFileSync(ledgerPath, "utf8"), new RegExp(`"kind":"orphan-job","jobId":"${jobId}"`), "the entry is this job's")

    // …and the host's own ledger never heard of it.
    const realLedger = join(jobsLogDir(), "ledger.jsonl")
    if (existsSync(realLedger)) {
      assert.equal(readFileSync(realLedger, "utf8").includes(jobId), false, "nothing in the real jobs ledger")
    }
  })
})

const ROOT = fileURLToPath(new URL("..", import.meta.url))

test("N4: the preload itself redirects any process that loads it, honors an inherited redirect, and cleans up on exit", () => {
  const preload = pathToFileURL(join(ROOT, "tests", "lib", "test-runtime-namespace.mjs")).href
  const run = (extraEnv, code) => {
    const env = { ...process.env, ...extraEnv }
    if (env.FORGE_TEST_RUNTIME_DIR === undefined) delete env.FORGE_TEST_RUNTIME_DIR
    return spawnSync(process.execPath, ["--import", preload, "-e", code], { env, encoding: "utf8", windowsHide: true, timeout: 30_000 })
  }

  // No inherited redirect: the preload creates a private directory before any
  // user code runs…
  const fresh = run({ FORGE_TEST_RUNTIME_DIR: undefined }, "const d = process.env.FORGE_TEST_RUNTIME_DIR; process.stdout.write(JSON.stringify({ d, exists: d ? require('node:fs').existsSync(d) : false }))")
  assert.equal(fresh.status, 0, fresh.stderr)
  const out = JSON.parse(fresh.stdout)
  assert.equal(typeof out.d, "string")
  assert.ok(out.d, "the variable is set before any user code runs")
  assert.equal(out.exists, true, "the directory exists by then")
  // …as a direct child of <os-tmp> (never inside a repo or a config home)…
  assert.equal(dirname(resolve(out.d)), resolve(tmpdir()), "a direct child of <os-tmp>")
  // …and removes it when the process exits.
  assert.equal(existsSync(out.d), false, "removed on exit")

  // An inherited redirect is honored as-is and never removed by the preload.
  const rt = mk("forge-ns-inherited-")
  const inherited = run({ FORGE_TEST_RUNTIME_DIR: rt }, "process.stdout.write(process.env.FORGE_TEST_RUNTIME_DIR)")
  assert.equal(inherited.status, 0, inherited.stderr)
  assert.equal(inherited.stdout, rt)
  assert.equal(existsSync(rt), true, "the caller's directory survives")
})

test("N5: every canonical suite entry point goes through the preload", () => {
  const entry = "--import ./tests/lib/test-runtime-namespace.mjs --test tests/*.test.mjs"
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert.ok(pkg.scripts.test.endsWith(entry), `package.json "test" is the isolated entry; got: ${pkg.scripts.test}`)

  // The acceptance gate measures the live unit suite itself — same preload,
  // or the gate's own run would write into the host's directories.
  const gate = readFileSync(join(ROOT, "reports", "e2e", "acceptance-gate.mjs"), "utf8")
  assert.ok(gate.includes('"--import", "./tests/lib/test-runtime-namespace.mjs"'), "the acceptance gate runs the live unit suite through the preload")

  for (const doc of ["README.md", "docs/dev-loop.md"]) {
    assert.ok(readFileSync(join(ROOT, doc), "utf8").includes(entry), `${doc} documents the isolated entry`)
  }
})

test("N6: the config hook writes the models-dev snapshot inside the redirected namespace — exactly one `models-dev` level deep", async (t) => {
  const rt = mk("forge-ns-models-")
  const realSnapshot = join(modelsDevCacheDir(), "snapshot.json")
  const realBefore = existsSync(realSnapshot) ? statSync(realSnapshot).mtimeMs : null

  // No network: the hook's catalog fetch is answered here, with a catalog
  // only this test could have served.
  const realFetch = globalThis.fetch
  const noFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH
  delete process.env.FORGE_TEST_NO_DISPATCH_FETCH
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, text: async () => JSON.stringify({ "probe-ns": { models: { m1: {} } } }) }
  }
  t.after(() => {
    globalThis.fetch = realFetch
    if (noFetch === undefined) delete process.env.FORGE_TEST_NO_DISPATCH_FETCH
    else process.env.FORGE_TEST_NO_DISPATCH_FETCH = noFetch
  })

  // Everything that resolves a path is read INSIDE the redirect.
  let resolved = null
  await withRuntimeDir(t, rt, async () => {
    const h = await server(serverInput(), {})
    t.after(() => h.dispose?.())
    resolved = ns.modelsDevCacheDir()
    await h.config({})
  })

  assert.ok(calls >= 1, "the hook fetched the catalog")
  const cacheDir = join(rt, "opencode-forge", "models-dev")
  assert.equal(resolved, cacheDir, "the resolved cache dir is the redirected one")
  const file = join(cacheDir, "snapshot.json")
  assert.equal(existsSync(file), true, "the snapshot landed in the redirected namespace")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).providers["probe-ns"].models.m1, {}, "and it is the catalog this test served")
  assert.equal(existsSync(join(cacheDir, "models-dev")), false, "exactly one models-dev level (no nesting)")
  const realAfter = existsSync(realSnapshot) ? statSync(realSnapshot).mtimeMs : null
  assert.equal(realAfter, realBefore, "the host's own snapshot was not rewritten")
})
