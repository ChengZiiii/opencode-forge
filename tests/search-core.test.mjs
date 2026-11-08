import test from "node:test"
import assert from "node:assert/strict"

// Task group 1 — pure-core unit tests for forge-search-tools (src/search-core.ts).
// Covers: argv matrix (task 1.1), JSON-stream parser (1.2), follow-dedupe +
// outside disclosure (1.3), rg resolution (1.4), formatter parity + truncation (1.5).

import {
  buildRgArgv,
  buildRgFilesArgv,
  parseRgJsonStream,
  parseRgFilesList,
  MAX_STREAM_LINE_LENGTH,
  dedupeFollowMatches,
  createMemoizedResolver,
  isOutsideWorktree,
  resolveRgBinary,
  RG_MISSING_REMEDIES,
  formatSearchOutput,
  MAX_RESULTS,
} from "../src/search-core.ts"

// ---------------------------------------------------------------------------
// 1.1 — argv matrix
// ---------------------------------------------------------------------------

test("argv: defaults are on (follow+hidden TRUE, .git excluded, literal tail)", () => {
  const argv = buildRgArgv({ kind: "grep", pattern: "TODO", path: "src" })
  assert.deepEqual(argv, [
    "--no-config",
    "--json",
    "--hidden",
    "--follow",
    "--glob=!**/.git/**",
    "--",
    "TODO",
    "src",
  ])
})

test("argv: glob variant shares the same fixed shape", () => {
  const argv = buildRgArgv({ kind: "glob", pattern: "*.ts", path: "." })
  assert.deepEqual(argv, [
    "--no-config",
    "--json",
    "--hidden",
    "--follow",
    "--glob=!**/.git/**",
    "--",
    "*.ts",
    ".",
  ])
})

test("argv: follow:false / hidden:false opt-outs drop their flags", () => {
  const argv = buildRgArgv({ kind: "grep", pattern: "x", path: "src", follow: false, hidden: false })
  assert.deepEqual(argv, ["--no-config", "--json", "--glob=!**/.git/**", "--", "x", "src"])
})

test("argv: include present adds --glob=<include>; absent adds nothing", () => {
  const withInclude = buildRgArgv({ kind: "grep", pattern: "x", path: "src", include: "*.ts" })
  assert.ok(withInclude.includes("--glob=*.ts"))
  assert.ok(withInclude.includes("--glob=!**/.git/**")) // exclusion always present
  const without = buildRgArgv({ kind: "grep", pattern: "x", path: "src" })
  assert.equal(without.filter((a) => a.startsWith("--glob=")).length, 1)
})

test("argv: file path and directory path pass through verbatim as the final arg", () => {
  const fileArgv = buildRgArgv({ kind: "grep", pattern: "x", path: "notes/a > b|.txt" })
  assert.equal(fileArgv[fileArgv.length - 1], "notes/a > b|.txt") // metacharacters stay one literal arg
  assert.equal(fileArgv[fileArgv.length - 3], "--") // separator sits before the pattern
  assert.equal(fileArgv[fileArgv.length - 2], "x")
  const dirArgv = buildRgArgv({ kind: "grep", pattern: "x", path: "src/sub/" })
  assert.equal(dirArgv[dirArgv.length - 1], "src/sub/")
  // omitted path → pattern is the last arg (caller's cwd = worktree)
  const noPath = buildRgArgv({ kind: "grep", pattern: "x" })
  assert.equal(noPath[noPath.length - 1], "x")
})

// ---------------------------------------------------------------------------
// 1.1b — files-listing vector (glob parity fix: EMPTY files must list)
// ---------------------------------------------------------------------------

test("argv files-vector: defaults are on, pattern rides --glob, NO -- pattern section", () => {
  const argv = buildRgFilesArgv({ pattern: "*.ts", path: "src" })
  assert.deepEqual(argv, [
    "--no-config",
    "--files",
    "--hidden",
    "--follow",
    "--glob=*.ts",
    "--glob=!**/.git/**",
    "src",
  ])
  assert.ok(!argv.includes("--"), "no `--` separator: files mode takes no content pattern")
})

test("argv files-vector: follow:false / hidden:false opt-outs drop their flags; omitted path appends nothing", () => {
  assert.deepEqual(buildRgFilesArgv({ pattern: "*.md", follow: false, hidden: false }), [
    "--no-config",
    "--files",
    "--glob=*.md",
    "--glob=!**/.git/**",
  ])
})

test("argv: a grep query with an empty pattern keeps the MATCH vector (never --files)", () => {
  const argv = buildRgArgv({ kind: "grep", pattern: "" })
  assert.ok(!argv.includes("--files"), "grep never switches to files mode")
  assert.deepEqual(argv.slice(-2), ["--", ""], "empty pattern still lands after the -- separator")
  assert.ok(argv.includes("--json"), "grep keeps --json")
})

test("files-list parser: plain rg --files output becomes path records, blank lines skipped", () => {
  const out = parseRgFilesList(["src/a.ts", "", "empty.ts", "src/b.md"].join("\r\n"))
  assert.deepEqual(
    out.map((r) => r.path),
    ["src/a.ts", "empty.ts", "src/b.md"],
  )
  for (const r of out) {
    assert.equal(r.line, 0)
    assert.equal(r.text, "")
  }
  assert.deepEqual(parseRgFilesList(""), [])
})

test("files-list parser → formatter: an EMPTY file appears in glob results (builtin parity regression)", () => {
  // rg --files lists empty.ts (zero lines → NO match events → invisible to
  // the old content vector). The files vector + plain parser restores it.
  const records = parseRgFilesList(["full.ts", "empty.ts"].join("\n"))
  const out = formatSearchOutput(records, { kind: "glob" })
  assert.equal(out, ["full.ts", "empty.ts"].join("\n"))
})

// ---------------------------------------------------------------------------
// 1.2 — rg --json stream parser
// ---------------------------------------------------------------------------

function matchLine(p, n, text) {
  return JSON.stringify({
    type: "match",
    data: { path: { text: p }, line_number: n, lines: { text }, offset: 0 },
  })
}

test("parser: happy path — match events become records", () => {
  const stream = [
    matchLine("a.ts", 3, "const x = 1\n"),
    matchLine("b.ts", 7, "hello"),
  ].join("\n")
  const out = parseRgJsonStream(stream)
  assert.equal(out.records.length, 2)
  assert.deepEqual(out.records[0], { path: "a.ts", line: 3, text: "const x = 1\n" })
  assert.equal(out.garbageLines, 0)
  assert.equal(out.oversizedLines, 0)
})

test("parser: interleaved begin/end/summary events are ignored", () => {
  const stream = [
    JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
    matchLine("a.ts", 1, "hit\n"),
    JSON.stringify({ type: "end", data: { path: { text: "a.ts" }, binary_offset: null, stats: {} } }),
    JSON.stringify({ type: "some_future_event", data: { whatever: true } }),
    JSON.stringify({ type: "summary", data: { stats: {} } }),
    matchLine("c.ts", 2, "hit2\n"),
  ].join("\n")
  const out = parseRgJsonStream(stream)
  assert.equal(out.records.length, 2)
  assert.deepEqual(out.records.map((r) => r.path), ["a.ts", "c.ts"])
})

test("parser: garbage lines tolerated and counted", () => {
  const stream = ["not json at all", matchLine("a.ts", 1, "x"), "{broken json", "", "null"].join("\n")
  const out = parseRgJsonStream(stream)
  assert.equal(out.records.length, 1)
  assert.equal(out.garbageLines, 2) // "not json" + "{broken"; "null" is valid JSON (unknown → ignored)
})

test("parser: oversized record line is skipped by the guard", () => {
  const huge = matchLine("big.ts", 1, "x".repeat(MAX_STREAM_LINE_LENGTH))
  const stream = [matchLine("a.ts", 1, "ok"), huge].join("\n")
  const out = parseRgJsonStream(stream)
  assert.equal(out.records.length, 1)
  assert.equal(out.oversizedLines, 1)
})

// ---------------------------------------------------------------------------
// 1.3 — follow-dedupe + outside-target disclosure
// ---------------------------------------------------------------------------

test("dedupe: real+link duplicate reports once, first path kept, footnote N", () => {
  // junction "link" → "real": same resolved target, link reported FIRST in
  // stream order; "link/..." is also the lexicographically first path — it
  // must win regardless of arrival order (spec scenario 1 keeps first path).
  const records = [
    { path: "real/hello.txt", line: 1, text: "hello\n" },
    { path: "link/hello.txt", line: 1, text: "hello\n" },
    { path: "solo.ts", line: 4, text: "other\n" },
  ]
  const res = dedupeFollowMatches(records, {
    worktreeRoot: "C:/ws",
    follow: true,
    resolvePath: (p) =>
      p.startsWith("link/") ? `C:/ws/real/${p.slice("link/".length)}` : `C:/ws/${p}`,
  })
  assert.equal(res.records.length, 2)
  assert.deepEqual(
    res.records.map((r) => r.path).sort(),
    ["link/hello.txt", "solo.ts"],
  )
  assert.equal(res.mergedDuplicates, 1)
})

test("dedupe: a later lexicographically-smaller link path rewrites the kept path", () => {
  // "aaa/zz.txt" arrives AFTER "real/zz.txt" but is lexicographically first.
  const records = [
    { path: "real/zz.txt", line: 2, text: "q\n" },
    { path: "aaa/zz.txt", line: 2, text: "q\n" },
  ]
  const res = dedupeFollowMatches(records, {
    worktreeRoot: "C:/ws",
    follow: true,
    resolvePath: (p) => `C:/ws/real/${p.startsWith("aaa/") ? p.slice("aaa/".length) : p.slice("real/".length)}`,
  })
  assert.equal(res.records.length, 1)
  assert.equal(res.records[0].path, "aaa/zz.txt")
  assert.equal(res.mergedDuplicates, 1)
})

test("dedupe: distinct lines in the same underlying file are distinct matches", () => {
  const records = [
    { path: "link/a.txt", line: 1, text: "one\n" },
    { path: "link/a.txt", line: 5, text: "two\n" },
  ]
  const res = dedupeFollowMatches(records, {
    worktreeRoot: "C:/ws",
    follow: true,
    resolvePath: (p) => `C:/ws/real/${p.slice("link/".length)}`,
  })
  assert.equal(res.records.length, 2)
  assert.equal(res.mergedDuplicates, 0)
})

test("dedupe: outside-worktree resolved target is disclosed by name", () => {
  const records = [{ path: "ws/ext/data.txt", line: 2, text: "found\n" }]
  const res = dedupeFollowMatches(records, {
    worktreeRoot: "C:/ws",
    follow: true,
    resolvePath: () => "D:/outside/data/data.txt",
  })
  assert.deepEqual(res.outsideTargets, ["D:/outside/data/data.txt"])
})

test("dedupe: follow:false passes records through untouched", () => {
  const records = [
    { path: "link/hello.txt", line: 1, text: "hello\n" },
    { path: "real/hello.txt", line: 1, text: "hello\n" },
  ]
  const res = dedupeFollowMatches(records, {
    worktreeRoot: "C:/ws",
    follow: false,
    resolvePath: () => "C:/ws/real/hello.txt",
  })
  assert.equal(res.records.length, 2)
  assert.equal(res.mergedDuplicates, 0)
  assert.deepEqual(res.outsideTargets, [])
})

test("dedupe: resolver is memoized per distinct reported path", () => {
  let calls = 0
  const records = [
    { path: "real/a.txt", line: 1, text: "x" },
    { path: "real/a.txt", line: 2, text: "y" },
    { path: "real/b.txt", line: 1, text: "z" },
  ]
  dedupeFollowMatches(records, {
    worktreeRoot: "C:/ws",
    follow: true,
    resolvePath: (p) => {
      calls++
      return `C:/ws/${p}`
    },
  })
  assert.equal(calls, 2) // a.txt once (memoized across two records), b.txt once
})

test("memoized resolver: factory caches identical inputs", () => {
  let calls = 0
  const memo = createMemoizedResolver((p) => {
    calls++
    return p.toUpperCase()
  })
  assert.equal(memo("a"), "A")
  assert.equal(memo("a"), "A")
  assert.equal(memo("b"), "B")
  assert.equal(calls, 2)
})

test("isOutsideWorktree: inside / outside / windows separator forms", () => {
  assert.equal(isOutsideWorktree("C:/ws/src/a.ts", "C:/ws"), false)
  assert.equal(isOutsideWorktree("C:\\WS\\a.ts".replaceAll("\\", "/"), "C:/ws"), false)
  assert.equal(isOutsideWorktree("D:/outside/a.ts", "C:/ws"), true)
  assert.equal(isOutsideWorktree("C:/ws/../secret/a.ts", "C:/ws"), true)
  assert.equal(isOutsideWorktree("C:/ws", "C:/ws"), false) // the root itself
})

// ---------------------------------------------------------------------------
// 1.4 — rg binary resolution (fail-soft)
// ---------------------------------------------------------------------------

test("resolver: config override wins when it exists on disk", () => {
  const res = resolveRgBinary(
    { rgPath: "C:/tools/rg/rg.exe" },
    { platform: "win32", pathEnv: "C:/other", existsSync: (p) => p === "C:/tools/rg/rg.exe" },
  )
  assert.deepEqual(res, { ok: true, binary: "C:/tools/rg/rg.exe", source: "config" })
})

test("resolver: config override that does NOT exist falls through to PATH", () => {
  const res = resolveRgBinary(
    { rgPath: "C:/missing/rg.exe" },
    {
      platform: "win32",
      pathEnv: "C:/bin;C:/other",
      existsSync: (p) => p === "C:\\bin\\rg.exe",
    },
  )
  assert.deepEqual(res, { ok: true, binary: "C:\\bin\\rg.exe", source: "path" })
})

test("resolver: PATH hit joins the directory with the platform exe name", () => {
  const res = resolveRgBinary(undefined, {
    platform: "posix",
    pathEnv: "/usr/bin:/usr/local/bin",
    existsSync: (p) => p === "/usr/local/bin/rg",
  })
  assert.deepEqual(res, { ok: true, binary: "/usr/local/bin/rg", source: "path" })
})

test("resolver: no override + no PATH hit → fail-soft error naming both remedies", () => {
  const res = resolveRgBinary(undefined, {
    platform: "win32",
    pathEnv: "C:/empty;C:/also-empty",
    existsSync: () => false,
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /ripgrep .* not found/)
  assert.ok(res.error.includes(RG_MISSING_REMEDIES))
  assert.match(res.error, /install ripgrep/)
  assert.match(res.error, /builtin grep\/glob/)
})

// ---------------------------------------------------------------------------
// 1.5 — output formatter (builtin parity) + truncation
// ---------------------------------------------------------------------------

test("formatter: grep parity — Found N matches + path: Line n: blocks", () => {
  const out = formatSearchOutput(
    [
      { path: "src/a.ts", line: 3, text: "const x = 1\n" },
      { path: "src/b.ts", line: 7, text: "hello" },
    ],
    { kind: "grep" },
  )
  assert.equal(
    out,
    ["Found 2 matches", "src/a.ts: Line 3: const x = 1", "src/b.ts: Line 7: hello"].join("\n"),
  )
})

test("formatter: empty case is No files found", () => {
  assert.equal(formatSearchOutput([], { kind: "grep" }), "No files found")
  assert.equal(formatSearchOutput([], { kind: "glob" }), "No files found")
})

test("formatter: glob is a plain unique path list", () => {
  const out = formatSearchOutput(
    [
      { path: "a.ts", line: 1, text: "m" },
      { path: "b.md", line: 2, text: "m" },
      { path: "a.ts", line: 9, text: "m" },
    ],
    { kind: "glob" },
  )
  assert.equal(out, ["a.ts", "b.md"].join("\n"))
})

test("formatter: truncation at 100 results with narrower-path/pattern notice", () => {
  const records = Array.from({ length: 150 }, (_, i) => ({
    path: `f${i}.ts`,
    line: i + 1,
    text: "hit",
  }))
  const out = formatSearchOutput(records, { kind: "grep" })
  const lines = out.split("\n")
  assert.equal(lines[0], "Found 150 matches")
  assert.equal(lines[1], "f0.ts: Line 1: hit")
  assert.equal(lines.filter((l) => l.includes(": Line ")).length, MAX_RESULTS)
  assert.equal(lines[lines.length - 1], "(truncated at 100 results of 150 — narrow the path or pattern)")
})

test("formatter: glob truncation at 100 unique paths", () => {
  const records = Array.from({ length: 120 }, (_, i) => ({
    path: `f${i}.ts`,
    line: 1,
    text: "m",
  }))
  const out = formatSearchOutput(records, { kind: "glob" })
  const lines = out.split("\n")
  assert.equal(lines.length, MAX_RESULTS + 1)
  assert.match(lines[lines.length - 1], /truncated at 100 results/)
})

test("formatter: duplicate footnote + outside-target disclosure append last", () => {
  const out = formatSearchOutput(
    [{ path: "real/a.txt", line: 1, text: "x" }],
    { kind: "grep", mergedDuplicates: 2, outsideTargets: ["D:/outside/data"] },
  )
  const lines = out.split("\n")
  assert.equal(lines[0], "Found 1 matches")
  assert.equal(lines[1], "real/a.txt: Line 1: x")
  assert.equal(lines[2], "outside-workspace target searched via link: D:/outside/data")
  assert.equal(lines[3], "+2 duplicate paths merged")
})

test("formatter: no footnote when nothing merged", () => {
  const out = formatSearchOutput([{ path: "a.ts", line: 1, text: "x" }], { kind: "grep", mergedDuplicates: 0 })
  assert.ok(!out.includes("duplicate paths merged"))
})
