#!/usr/bin/env node
// reports/e2e/acceptance-gate.mjs — ONE fail-closed verdict for a release
// acceptance. It re-reads every sandbox E2E verdict file and the headed-TUI
// evidence, re-measures the repo live (typecheck, the full unit suite, the
// host version), and ties each piece of evidence to the build it ran on.
//
// What makes it fail-closed:
//   • a missing / unreadable / malformed verdict is a FAILURE, never a skip;
//   • every verdict must be NEWER than dist/index.js, and dist itself must
//     be newer than every source file (an E2E run on an older build proves
//     nothing about the release);
//   • each verdict must carry its own start time, and that time must be
//     later than the build (file mtimes alone can be preserved by a copy);
//   • typecheck, the unit suite and `opencode --version` are measured NOW;
//   • a leg the sandbox cannot reach is reported as BOOKED (the workspace
//     D6 rule) with its reason — it never counts as a pass, and the summary
//     shows it separately so nobody mistakes it for one;
//   • a product defect the release knowingly ships is reported KNOWN — never
//     a pass — and only when the release command NAMES it
//     (--accept-known <check>): unnamed, it is an ordinary FAIL. Every
//     release decides again, so a known defect cannot quietly accumulate.
//
// Usage (from anywhere; the script locates the repo from its own path):
//   node reports/e2e/acceptance-gate.mjs [--evidence <dir>] [--tui <file>]
//        [--c1 <file>] [--c5-standard <file>] [--c5-ceiling <file>] [--crew <file>]
//        [--host 2.4.0] [--min-tests 1001] [--ceiling-leg-ms 240000]
//        [--accept-known <check[,check]>]
//        [--out <file.json>] [--snapshot <dir>]
// Defaults: evidence = %LOCALAPPDATA%\Temp\opencode\view-e2e\logs (the
// sandbox scratch), out = reports/e2e/acceptance-gate-latest.json.
// Exit code 0 only when no check FAILED (booked legs and accepted known
// defects are listed in the header, not hidden).
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? resolve(args[i + 1]) : fallback
}
const SBX = join(process.env.LOCALAPPDATA ?? "", "Temp", "opencode", "view-e2e")
const EVIDENCE = argOf("--evidence", join(SBX, "logs"))
const TUI_FILE = argOf("--tui", join(EVIDENCE, "tui-gate.json"))
const C1_FILE = argOf("--c1", join(EVIDENCE, "dispose-e2e-K1-K2-D1-verdict.json"))
const C5_STANDARD_FILE = argOf("--c5-standard", join(EVIDENCE, "native-child-gate-e2e-final-standard-verdict.json"))
const C5_CEILING_FILE = argOf("--c5-ceiling", join(EVIDENCE, "native-child-gate-e2e-final-C-verdict.json"))
const CREW_FILE = argOf("--crew", join(EVIDENCE, "crew-full-e2e-verdict.json"))
// Known defects this release consciously ships, by driver check name. The
// driver must ALSO carry the check as a named known defect; both sides must
// agree before a failing check is reported KNOWN instead of FAIL.
const ACCEPTED_KNOWN = new Set(
  (args.includes("--accept-known") ? String(args[args.indexOf("--accept-known") + 1] ?? "") : "").split(",").map((s) => s.trim()).filter(Boolean),
)
const HOST_VERSION = args.includes("--host") ? String(args[args.indexOf("--host") + 1]) : "2.4.0"
const MIN_TESTS = Number(args.includes("--min-tests") ? args[args.indexOf("--min-tests") + 1] : "1001")
const CEILING_LEG_MS = Number(args.includes("--ceiling-leg-ms") ? args[args.indexOf("--ceiling-leg-ms") + 1] : "240000")
const OUT = argOf("--out", join(REPO, "reports", "e2e", "acceptance-gate-latest.json"))
const SNAPSHOT = argOf("--snapshot", "")
// Dry run: skip the three live measures. A skipped measure is a FAILURE
// (never a pass) — the flag exists to test this script while an E2E chain
// owns the machine, and can never produce a passing gate.
const NO_LIVE = args.includes("--no-live")
const notMeasured = { status: "FAIL", detail: "NOT MEASURED (--no-live dry run) — a gate without live measures cannot pass" }

// ---------------------------------------------------------------- helpers
const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString())
const mtime = (file) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}
const sha256 = (file) => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}
const loadJson = (file) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) }
  }
}
const allTrue = (obj) => {
  const entries = Object.entries(obj ?? {})
  return entries.length > 0 && entries.every(([, v]) => v === true)
}
const falseKeys = (obj) => Object.entries(obj ?? {}).filter(([, v]) => v !== true).map(([k]) => k)
const clip = (s, n) => {
  const t = String(s ?? "")
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const startedOf = (j) => {
  for (const k of ["startedAt", "started", "checkedAt"]) {
    const ms = Date.parse(String(j?.[k] ?? ""))
    if (Number.isFinite(ms)) return { ms, key: k }
  }
  return { ms: NaN, key: null }
}
const walk = (dir, out = []) => {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else out.push(p)
    }
  } catch {}
  return out
}
const git = (...a) => {
  const r = spawnSync("git", a, { cwd: REPO, encoding: "utf8", windowsHide: true })
  return (r.stdout || "").trim()
}
// The sandbox host password must never ride along into a snapshot.
const sandboxSecret = () => {
  try {
    return String(JSON.parse(readFileSync(join(SBX, "xdg", "state", "opencode", "service.json"), "utf8")).password ?? "")
  } catch {
    return ""
  }
}

/** @type {Array<Record<string, any>>} */
const checks = []
const add = (c) => {
  checks.push(c)
  return c
}
const startedAtMs = Date.now()

// ------------------------------------------------- build / source freshness
const sourceFiles = [join(REPO, "plugin.ts"), join(REPO, "schema", "forge.schema.json"), ...walk(join(REPO, "src")).filter((f) => f.endsWith(".ts"))]
let newest = { file: null, ms: 0 }
for (const f of sourceFiles) {
  const ms = mtime(f)
  if (ms !== null && ms > newest.ms) newest = { file: relative(REPO, f).replaceAll("\\", "/"), ms }
}
const DIST = join(REPO, "dist", "index.js")
const distMs = mtime(DIST)
add({
  id: "build-fresh",
  title: "dist/index.js is newer than every source file",
  status: distMs !== null && distMs >= newest.ms ? "PASS" : "FAIL",
  detail: distMs === null ? "dist/index.js is missing" : `dist ${iso(distMs)} vs newest source ${newest.file} ${iso(newest.ms)}`,
  distMtime: iso(distMs),
  distSha256: sha256(DIST),
  newestSource: newest.file,
  newestSourceMtime: iso(newest.ms),
})

// ------------------------------------------------------------ E2E verdicts
const evidence = []
const readVerdict = (id, file) => {
  const m = mtime(file)
  const loaded = loadJson(file)
  const rec = { id, file, exists: existsSync(file), mtime: iso(m), sha256: existsSync(file) ? sha256(file) : null, readable: loaded.ok }
  if (!loaded.ok) {
    rec.error = loaded.error ?? "missing"
    add({ id: `evidence-fresh-${id}`, title: `${id}: verdict file present and readable`, status: "MISSING", detail: `${file}: ${rec.error}`, ...rec })
    evidence.push(rec)
    return null
  }
  const j = loaded.value
  const started = startedOf(j)
  rec.startedAt = iso(started.ms)
  rec.startedKey = started.key
  rec.hostPid = j.hostPid ?? null
  const fresh = m !== null && distMs !== null && m >= distMs && Number.isFinite(started.ms) && started.ms >= distMs
  add({
    id: `evidence-fresh-${id}`,
    title: `${id}: measured on THIS build (file and in-file start time both later than dist)`,
    status: fresh ? "PASS" : "FAIL",
    detail: fresh
      ? `file ${iso(m)} · ${started.key} ${iso(started.ms)} · dist ${iso(distMs)}`
      : `file ${iso(m)} · ${started.key ?? "no start time"} ${iso(started.ms)} · dist ${iso(distMs)} — stale or undated`,
    ...rec,
  })
  evidence.push(rec)
  return j
}
const simplePass = (j) => j?.verdict === true && j?.result?.pass === true && allTrue(j?.result?.checks) && !j?.inconclusive

// C3 / C4 / C2 share one verdict shape (verdict + result.pass + result.checks).
for (const [id, name] of [
  ["c3-command-stop", "command-stop-e2e-verdict.json"],
  ["c4-pin-variant", "pin-variant-e2e-verdict.json"],
  ["c2-plan-close", "plan-close-headless-e2e-verdict.json"],
]) {
  const j = readVerdict(id, join(EVIDENCE, name))
  if (!j) continue
  const failed = falseKeys(j.result?.checks)
  const ok = simplePass(j)
  add({
    id: `e2e-${id}`,
    title: `${id}: every driver check passed on the live host`,
    status: ok ? "PASS" : "FAIL",
    detail: ok
      ? `${Object.keys(j.result.checks).length}/${Object.keys(j.result.checks).length} checks`
      : `failed checks: ${JSON.stringify(failed)}${j.inconclusive ? ` · inconclusive: ${clip(j.inconclusive, 200)}` : ""}${j.result?.error ? ` · error: ${clip(j.result.error, 200)}` : ""}`,
    checksTotal: Object.keys(j.result?.checks ?? {}).length,
    checksFailed: failed,
    retriedOnce: Boolean(j.first),
    inconclusive: j.inconclusive ?? null,
  })
}

// C1: K1 / K2 are gates; D1 may be BOOKED when the host offers no proven
// dispose trigger (its inconclusive text and the hook probe ride along).
{
  const j = readVerdict("c1-dispose", C1_FILE)
  if (j) {
    for (const leg of ["K1", "K2"]) {
      const r = j.results?.[leg] ?? {}
      add({
        id: `e2e-c1-${leg}`,
        title: `c1-dispose ${leg}: ${leg === "K1" ? "owner deleted mid-flight → aborted, keep-row, child gone" : "cancel lever → aborted wake carrying the journal reason"}`,
        status: r.pass === true ? "PASS" : "FAIL",
        detail: clip(JSON.stringify(r.pass === true ? { journalFinalOutcome: r.journalFinalOutcome, ledgerDisposeLines: r.ledgerDisposeLines } : { error: r.error, inconclusive: r.inconclusive, journalFinalOutcome: r.journalFinalOutcome, journalFinalReason: r.journalFinalReason }), 420),
        result: r,
      })
    }
    const d1 = j.results?.D1 ?? {}
    const booked = d1.pass !== true && typeof d1.inconclusive === "string" && d1.inconclusive.length > 0 && !d1.error && !d1.premiseFailed
    add({
      id: "e2e-c1-D1",
      title: "c1-dispose D1: a dispatch row survives a plugin dispose of the owner location",
      status: d1.pass === true ? "PASS" : booked ? "BOOKED" : "FAIL",
      booking: booked ? "D6 — the sandbox host (2.4.0) offers no action proven to run the plugin dispose hook while a dispatch is in flight" : null,
      detail: d1.pass === true ? "exemption observed live" : clip(`${d1.inconclusive ?? d1.error ?? "no result"} | dispose hook probe: ${JSON.stringify(d1.disposeHookProbe ?? null)}`, 700),
      result: d1,
    })
  }
}

// C5 phase 1 (production-default ceiling): A, B, B', D.
{
  const j = readVerdict("c5-standard", C5_STANDARD_FILE)
  if (j) {
    const legs = ["A", "B", "BI", "D"]
    const missing = legs.filter((l) => j.verdict?.[l] !== true)
    const hc = j.hostCeiling ?? {}
    const ceilingOk = hc.hostCeilingMs === hc.productionDefaultMs && hc.driverCeilingMs === hc.productionDefaultMs && Number.isFinite(hc.productionDefaultMs)
    const ok = j.verdictAll === true && missing.length === 0 && ceilingOk
    add({
      id: "e2e-c5-standard",
      title: "c5 standard phase: A/B/B'/D all pass under the production-default ceiling",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `legs ${legs.join(",")} · ceiling ${hc.hostCeilingMs}ms = production default`
        : `legs not passing: ${JSON.stringify(missing)} · verdictAll=${j.verdictAll} · ceiling host=${hc.hostCeilingMs} driver=${hc.driverCeilingMs} default=${hc.productionDefaultMs}`,
      legs: j.verdict ?? null,
      hostCeiling: hc,
    })
  }
}
// C5 phase 2: leg C under the raised ceiling (its own host phase).
{
  const j = readVerdict("c5-ceiling-C", C5_CEILING_FILE)
  if (j) {
    const hc = j.hostCeiling ?? {}
    const ceilingOk = hc.hostCeilingMs === CEILING_LEG_MS && hc.driverCeilingMs === CEILING_LEG_MS
    const ok = j.verdictAll === true && j.verdict?.C === true && ceilingOk
    add({
      id: "e2e-c5-ceiling-C",
      title: "c5 leg C: passes with host and driver both on the raised ceiling",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `leg C · ceiling ${hc.hostCeilingMs}ms`
        : `verdict.C=${j.verdict?.C} verdictAll=${j.verdictAll} · ceiling host=${hc.hostCeilingMs} driver=${hc.driverCeilingMs} (want ${CEILING_LEG_MS})`,
      hostCeiling: hc,
      result: j.results?.C ?? null,
    })
  }
}

// The complete crew (goal criterion 3, second half): ONE crew on the live
// host, begin → engine briefs → waves → verdicts → crew_close. A check the
// driver carries as a NAMED known defect is KNOWN only when this release
// names it too; it is never a pass.
{
  const j = readVerdict("crew-full", CREW_FILE)
  if (j) {
    const all = j.result?.checks ?? {}
    // the crew driver records each check as { pass, detail }; accept a bare boolean too
    const isPass = (v) => (v !== null && typeof v === "object" ? v.pass === true : v === true)
    const failed = Object.keys(all).filter((k) => !isPass(all[k]))
    const knownDefects = Array.isArray(j.result?.knownDefects) ? j.result.knownDefects.filter((x) => x && typeof x.check === "string") : []
    const driverKnown = knownDefects.map((x) => x.check)
    const unexpected = failed.filter((k) => !driverKnown.includes(k))
    const known = failed.filter((k) => driverKnown.includes(k))
    const unnamed = known.filter((k) => !ACCEPTED_KNOWN.has(k))
    const ok = j.verdict === true && j.result?.pass === true && failed.length === 0
    const knownOnly =
      !ok && j.verdictExcludingKnown === true && j.result?.passExcludingKnown === true && unexpected.length === 0 && known.length > 0 && unnamed.length === 0
    const total = Object.keys(all).length
    add({
      id: "e2e-crew-full",
      title: "complete crew: begin → waves → verdicts → crew_close on the live host",
      status: ok ? "PASS" : knownOnly ? "KNOWN" : "FAIL",
      detail: ok
        ? `${total}/${total} checks · closed after ${Math.round((j.result?.msToClose ?? 0) / 1000)}s · sections ${JSON.stringify((j.result?.recordSections ?? []).map((s) => s.title))}`
        : knownOnly
          ? `${total - failed.length}/${total} checks; KNOWN DEFECT ${known.join(", ")}: ${knownDefects.map((x) => clip(String(x.note ?? ""), 150)).join(" | ")}`
          : `failed checks: ${JSON.stringify(unexpected)}${unnamed.length ? ` · known to the driver but NOT accepted by this release: ${JSON.stringify(unnamed)}` : ""}${j.result?.error ? ` · error: ${clip(j.result.error, 200)}` : ""}`,
      checksTotal: total,
      checksFailed: failed,
      knownDefects,
      acceptedKnown: [...ACCEPTED_KNOWN],
      sections: j.result?.recordSections ?? [],
      msToClose: j.result?.msToClose ?? null,
    })
  }
}

// Headed TUI evidence: reports/e2e/README.md documents the shape.
{
  const m = mtime(TUI_FILE)
  const loaded = loadJson(TUI_FILE)
  const rec = { id: "tui-headed", file: TUI_FILE, exists: existsSync(TUI_FILE), mtime: iso(m), sha256: existsSync(TUI_FILE) ? sha256(TUI_FILE) : null }
  if (!loaded.ok) {
    add({ id: "evidence-fresh-tui-headed", title: "tui-headed: evidence file present and readable", status: "MISSING", detail: `${TUI_FILE}: ${loaded.error ?? "missing"}`, ...rec })
  } else {
    const j = loaded.value
    const at = Date.parse(String(j.checkedAt ?? ""))
    const items = Array.isArray(j.items) ? j.items : []
    const failed = items.filter((x) => x?.pass !== true).map((x) => x?.id ?? "?")
    const fresh = m !== null && distMs !== null && m >= distMs && Number.isFinite(at) && at >= distMs
    const ok = j.pass === true && items.length > 0 && failed.length === 0 && j.hostVersion === HOST_VERSION && fresh
    add({
      id: "e2e-tui-headed",
      title: "headed TUI gate: every item observed in a real terminal on THIS build",
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `${items.length} items · checked ${j.checkedAt} · host ${j.hostVersion}`
        : `pass=${j.pass} · items ${items.length} · failed ${JSON.stringify(failed)} · host ${j.hostVersion} (want ${HOST_VERSION}) · checked ${iso(at)} vs dist ${iso(distMs)}`,
      items,
      checkedAt: j.checkedAt ?? null,
      hostVersion: j.hostVersion ?? null,
      ...rec,
    })
    evidence.push(rec)
  }
}

// ------------------------------------------------------- live repo measures
add(
  NO_LIVE
    ? { id: "live-typecheck", title: "tsc --noEmit (measured now)", ...notMeasured }
    : (() => {
        const r = spawnSync(process.execPath, [join(REPO, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 10 * 60 * 1000 })
        return {
          id: "live-typecheck",
          title: "tsc --noEmit (measured now)",
          status: r.status === 0 ? "PASS" : "FAIL",
          detail: r.status === 0 ? "no errors" : clip(`${(r.stdout || "").concat(r.stderr || "").replace(/^>.*$/gm, "")}`, 900),
          exitCode: r.status,
        }
      })(),
)
add(
  NO_LIVE
    ? { id: "live-unit-suite", title: `full unit suite (measured now; floor ${MIN_TESTS} tests)`, ...notMeasured }
    : (() => {
        const env = { ...process.env }
        delete env.FORGE_GOAL_PROBE
        // The reporter is PINNED: Node 24's default is `spec` (`ℹ tests 8`), and
        // the first live run of this gate (2026-11-23 19:59Z) parsed no counts
        // at all out of it. The parser accepts both shapes anyway so a reporter
        // change can never turn the counts into a silent null again; an
        // unparseable summary is a FAIL that says so.
        const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "tests/*.test.mjs"], { cwd: REPO, env, encoding: "utf8", windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 })
        const tap = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
        const num = (k) => {
          const m = [...tap.matchAll(new RegExp(`^\\s*(?:#\\s+|ℹ\\s+)?${k}\\s+(\\d+)\\s*$`, "gm"))]
          return m.length ? Number(m[m.length - 1][1]) : NaN
        }
        const counts = { tests: num("tests"), pass: num("pass"), fail: num("fail"), cancelled: num("cancelled"), skipped: num("skipped"), todo: num("todo") }
        const ok = r.status === 0 && counts.fail === 0 && counts.cancelled === 0 && counts.pass === counts.tests && counts.tests >= MIN_TESTS
        const notOk = tap.split("\n").filter((l) => /^\s*not ok\b/.test(l)).slice(0, 12)
        const unparsed = Number.isNaN(counts.tests)
        return {
          id: "live-unit-suite",
          title: `full unit suite (measured now; floor ${MIN_TESTS} tests)`,
          status: ok ? "PASS" : "FAIL",
          detail: ok
            ? `${counts.pass}/${counts.tests} pass`
            : unparsed
              ? `exit ${r.status} · the runner's summary lines were not found in its output (counts ${JSON.stringify(counts)}) · tail: ${clip(tap.trim().split(/\r?\n/).slice(-6).join(" | "), 600)}`
              : `exit ${r.status} · ${JSON.stringify(counts)} · ${JSON.stringify(notOk)}`,
          counts,
          exitCode: r.status,
          notOk,
        }
      })(),
)
add(
  NO_LIVE
    ? { id: "live-host-version", title: `opencode --version is ${HOST_VERSION} (measured now)`, ...notMeasured }
    : (() => {
        const r = spawnSync("opencode", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 60000, shell: true })
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
        const ok = text.split(/\r?\n/).some((l) => l.trim() === HOST_VERSION || l.trim().endsWith(HOST_VERSION))
        return {
          id: "live-host-version",
          title: `opencode --version is ${HOST_VERSION} (measured now)`,
          status: ok ? "PASS" : "FAIL",
          detail: clip(text, 160),
        }
      })(),
)

// ------------------------------------------------------------- git + secret
const dirty = git("status", "--porcelain").split("\n").filter(Boolean)
const secret = sandboxSecret()
const leaks = evidence.filter((e) => e.file && existsSync(e.file) && secret && readFileSync(e.file, "utf8").includes(secret)).map((e) => e.id)
add({
  id: "no-secret-in-evidence",
  title: "no evidence file carries the sandbox host password",
  status: leaks.length === 0 ? "PASS" : "FAIL",
  detail: leaks.length === 0 ? `checked ${evidence.length} files` : `found in: ${leaks.join(", ")}`,
})

// ----------------------------------------------------------------- verdict
const failed = checks.filter((c) => c.status === "FAIL" || c.status === "MISSING")
const booked = checks.filter((c) => c.status === "BOOKED")
const known = checks.filter((c) => c.status === "KNOWN")
const passed = checks.filter((c) => c.status === "PASS")
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`
const extras = [...(booked.length ? [plural(booked.length, "booked leg")] : []), ...(known.length ? [plural(known.length, "known defect")] : [])]
const suffix = extras.length ? ` (${extras.join(" · ")})` : ""
const report = {
  gate: "acceptance-gate",
  generatedAt: iso(Date.now()),
  elapsedMs: Date.now() - startedAtMs,
  packageVersion: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version,
  git: { head: git("rev-parse", "HEAD"), short: git("rev-parse", "--short", "HEAD"), dirtyFiles: dirty.length, dirty: dirty.slice(0, 60) },
  hostVersionWanted: HOST_VERSION,
  build: { distMtime: iso(distMs), distSha256: sha256(DIST), newestSource: newest.file, newestSourceMtime: iso(newest.ms) },
  pass: failed.length === 0,
  hardPass: failed.length === 0 && booked.length === 0 && known.length === 0,
  counts: { pass: passed.length, fail: failed.length, booked: booked.length, known: known.length, total: checks.length },
  booked: booked.map((c) => ({ id: c.id, booking: c.booking, detail: c.detail })),
  knownDefects: known.map((c) => ({ id: c.id, failedChecks: c.checksFailed ?? [], defects: c.knownDefects ?? [] })),
  failed: failed.map((c) => ({ id: c.id, title: c.title, detail: c.detail })),
  checks,
  evidence,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
const md = join(dirname(OUT), "acceptance-gate-latest.md")
const row = (c) => `| ${c.id} | ${c.status} | ${clip(String(c.detail).replaceAll("|", "\\|"), 260)} |`
writeFileSync(
  md,
  [
    `# Acceptance gate — ${report.packageVersion} — ${report.pass ? "PASS" : "FAIL"}${suffix}`,
    "",
    `- generated: ${report.generatedAt} · git ${report.git.short} (${report.git.dirtyFiles} uncommitted paths) · host wanted: ${HOST_VERSION}`,
    `- build: dist ${report.build.distMtime} (newest source ${report.build.newestSource} ${report.build.newestSourceMtime}) · sha256 ${report.build.distSha256}`,
    `- counts: ${passed.length} pass · ${failed.length} fail · ${booked.length} booked · ${known.length} known`,
    "",
    "| check | status | detail |",
    "| --- | --- | --- |",
    ...checks.map(row),
    "",
    ...(booked.length ? ["## Booked legs (D6 — not a pass)", "", ...booked.map((c) => `- **${c.id}** — ${c.booking}. ${c.detail}`), ""] : []),
    ...(known.length
      ? [
          "## Known defects this release ships (accepted by name — NOT a pass)",
          "",
          ...known.flatMap((c) => (c.knownDefects ?? []).map((d) => `- **${c.id}** · check \`${d.check}\` — ${d.note}`)),
          "",
        ]
      : []),
    "",
  ].join("\n"),
)

// Evidence snapshot (opt-in): the verdict files + this report, hashed.
if (SNAPSHOT) {
  mkdirSync(SNAPSHOT, { recursive: true })
  const manifest = []
  for (const e of evidence) {
    if (!e.file || !existsSync(e.file)) continue
    if (secret && readFileSync(e.file, "utf8").includes(secret)) {
      manifest.push({ source: e.file, copied: false, reason: "carries the sandbox password" })
      continue
    }
    const dest = join(SNAPSHOT, relative(EVIDENCE, e.file).replaceAll("\\", "__").replaceAll("/", "__"))
    copyFileSync(e.file, dest)
    manifest.push({ source: relative(EVIDENCE, e.file), copied: true, file: relative(REPO, dest).replaceAll("\\", "/"), sha256: sha256(dest) })
  }
  copyFileSync(OUT, join(SNAPSHOT, "acceptance-gate.json"))
  copyFileSync(md, join(SNAPSHOT, "acceptance-gate.md"))
  writeFileSync(join(SNAPSHOT, "manifest.json"), `${JSON.stringify({ snapshotAt: iso(Date.now()), git: report.git.short, build: report.build, files: manifest }, null, 2)}\n`)
}

for (const c of checks) console.log(`${c.status.padEnd(7)} ${c.id.padEnd(26)} ${clip(String(c.detail), 150)}`)
console.log(`\nGATE ${report.pass ? "PASS" : "FAIL"}${suffix} — ${passed.length} pass · ${failed.length} fail · ${booked.length} booked · ${known.length} known${booked.length ? ` (${booked.map((c) => c.id).join(", ")})` : ""}${known.length ? ` [${known.flatMap((c) => (c.knownDefects ?? []).map((d) => d.check)).join(", ")}]` : ""}`)
console.log(`report: ${OUT}`)
process.exit(report.pass ? 0 : 1)
