import test from "node:test"
import assert from "node:assert/strict"

// search-js-fallback (design D2-D4): the bundled pure-JS engine core —
// glob dialect matrix, walk semantics (hidden/.git/follow/cycle guard),
// grep scan (include filter, line numbers, binary skip, size cap, compile
// failure), walk cap notice, pathSeparator output, file-root behavior.
// Fake in-memory fs seams in the project's fake-fs convention (explicit
// file/dir/link maps, async seam functions).

import {
  jsSearch,
  matchGlob,
  globToRegExp,
  MAX_WALK_ENTRIES,
  MAX_FILE_BYTES,
} from "../src/search-js.ts"

// ---------------------------------------------------------------------------
// Fake fs: explicit file/dir/link maps; every seam normalizes separators so
// both "/" and "\\" path styles hit the same tree (pathSeparator tests).

function makeFs() {
  const files = new Map() // path -> string | Buffer
  const dirs = new Set() // dir paths (canonical, forward-slash)
  const links = new Map() // linkPath -> targetPath
  const children = new Map() // dirPath -> Set<name>
  const realpathOverrides = new Map() // path -> canonical value

  const norm = (p) => p.replaceAll("\\", "/")
  const parentOf = (p) => {
    const i = p.lastIndexOf("/")
    return i === -1 ? "" : p.slice(0, i)
  }
  const register = (p) => {
    const parent = parentOf(p)
    if (parent === "") return
    if (!children.has(parent)) children.set(parent, new Set())
    children.get(parent).add(p.slice(parent.length + 1))
  }
  // Resolve through links at ANY path depth ("R/link/d.ts" → target/d.ts),
  // bounded hops — a canonical path with no link components anywhere.
  const resolve = (p) => {
    let cur = norm(p)
    let hops = 0
    while (hops++ < 10) {
      let next = null
      for (const [l, t] of links) {
        if (cur === l) {
          next = t
          break
        }
        if (cur.startsWith(l + "/")) {
          next = t + cur.slice(l.length)
          break
        }
      }
      if (next === null) return cur
      cur = norm(next)
    }
    return cur
  }

  return {
    files,
    addDir(p) {
      dirs.add(norm(p))
      register(norm(p))
    },
    addFile(p, content = "x") {
      files.set(norm(p), content)
      register(norm(p))
    },
    addLink(l, t) {
      links.set(norm(l), norm(t))
      register(norm(l))
    },
    setRealpath(p, v) {
      realpathOverrides.set(norm(p), v)
    },
    seams: {
      async readdir(dir) {
        // Like fs.readdir on a symlink-to-dir: the listing comes from the
        // resolved TARGET's children (records still carry the link path).
        const base = resolve(dir)
        const names = [...(children.get(base) ?? [])].sort()
        return names.map((name) => {
          const full = norm(dir) + "/" + name
          const isSymbolicLink = links.has(full)
          const target = resolve(full)
          return {
            name,
            isFile: files.has(target),
            isDirectory: dirs.has(target),
            isSymbolicLink,
          }
        })
      },
      async stat(p) {
        const t = resolve(p)
        if (files.has(t)) return { isFile: true, isDirectory: false }
        if (dirs.has(t)) return { isFile: false, isDirectory: true }
        throw new Error("ENOENT: " + p)
      },
      async readFilePrefix(p, maxBytes) {
        const t = resolve(p)
        if (!files.has(t)) throw new Error("ENOENT: " + p)
        const buf = Buffer.from(files.get(t))
        return buf.length > maxBytes ? buf.subarray(0, maxBytes + 1) : buf
      },
      realpath(p) {
        const hit = realpathOverrides.get(norm(p))
        if (hit !== undefined) return hit
        return resolve(p)
      },
    },
  }
}

/** Standard walk-semantics tree: visible + dot file/dir + .git + subdir. */
function walkTree() {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/a.ts", "x")
  fs.addFile("R/.hidden.ts", "x")
  fs.addDir("R/src")
  fs.addFile("R/src/b.ts", "x")
  fs.addFile("R/src/.c.ts", "x")
  fs.addDir("R/.git")
  fs.addFile("R/.git/x.ts", "x")
  fs.addDir("R/other")
  fs.addFile("R/other/d.ts", "x")
  return fs
}

const globParams = (over = {}) => ({
  kind: "glob",
  root: "R",
  pattern: "**/*.ts",
  follow: true,
  hidden: false,
  pathSeparator: "/",
  ...over,
})

// ---------------------------------------------------------------------------
// 1. Glob matcher unit cases (D3)
// ---------------------------------------------------------------------------

test("matchGlob: no-slash pattern matches the BASENAME at any depth", () => {
  assert.equal(matchGlob("*.ts", "a.ts"), true)
  assert.equal(matchGlob("*.ts", "src/x/a.ts"), true)
  assert.equal(matchGlob("*.ts", "a.js"), false)
  assert.equal(matchGlob("*.ts", "src"), false)
})

test("matchGlob: slash-bearing patterns anchor to the walk-relative path", () => {
  assert.equal(matchGlob("src/**", "src/a.ts"), true)
  assert.equal(matchGlob("src/**", "src/x/b.js"), true)
  assert.equal(matchGlob("src/**", "other/a.ts"), false)
  assert.equal(matchGlob("src/**", "asrc/a.ts"), false)
})

test("matchGlob: **/*.ts matches root-level files too (zero leading segments)", () => {
  assert.equal(matchGlob("**/*.ts", "a.ts"), true)
  assert.equal(matchGlob("**/*.ts", "x/a.ts"), true)
  assert.equal(matchGlob("**/*.ts", "x/y/a.ts"), true)
  assert.equal(matchGlob("**/*.ts", "x/a.js"), false)
})

test("matchGlob: a SINGLE star before a separator matches exactly one level (never inherits **/ semantics)", () => {
  // Live-caught regression (0.21.0/0.21.1): `*/tasks.md` matched two-level
  // paths because any star-run before `/` was translated as `**/`.
  assert.equal(matchGlob("*/tasks.md", "alpha/tasks.md"), true)
  assert.equal(matchGlob("*/tasks.md", "archive/old/tasks.md"), false, "two levels must NOT match")
  assert.equal(matchGlob("*/tasks.md", "tasks.md"), false, "zero levels must not match either")
  assert.equal(matchGlob("a/*/b.txt", "a/x/b.txt"), true)
  assert.equal(matchGlob("a/*/b.txt", "a/x/y/b.txt"), false)
})

test("matchGlob: a mid-segment single star never crosses separators (src/*.ts)", () => {
  assert.equal(matchGlob("src/*.ts", "src/a.ts"), true)
  assert.equal(matchGlob("src/*.ts", "src/x/a.ts"), false, "single star stays within the segment")
  assert.equal(matchGlob("src/*.ts", "src/a/b.ts"), false)
  assert.equal(matchGlob("*.ts", "x/a.ts"), true, "no-slash basename rule unchanged")
})

test("matchGlob: ? / [a-c] / [!a] / {a,b} dialect subset", () => {
  assert.equal(matchGlob("a?c", "abc"), true)
  assert.equal(matchGlob("a?c", "abbc"), false)
  assert.equal(matchGlob("a?c", "a/c"), false, "? never crosses a separator")
  assert.equal(matchGlob("[a-c]x", "bx"), true)
  assert.equal(matchGlob("[a-c]x", "dx"), false)
  assert.equal(matchGlob("[!a]x", "bx"), true)
  assert.equal(matchGlob("[!a]x", "ax"), false)
  assert.equal(matchGlob("{a,b}.txt", "a.txt"), true)
  assert.equal(matchGlob("{a,b}.txt", "b.txt"), true)
  assert.equal(matchGlob("{a,b}.txt", "c.txt"), false)
})

test("matchGlob: regex specials in patterns stay literal", () => {
  assert.equal(matchGlob("file(1).txt", "file(1).txt"), true)
  assert.equal(matchGlob("file(1).txt", "file1.txt"), false)
  assert.equal(matchGlob("a+b.txt", "a+b.txt"), true)
  assert.equal(matchGlob("a+b.txt", "aab.txt"), false)
})

test("matchGlob: exotic constructs under-match without throwing", () => {
  // rg-style possessive/unicode classes are not in the subset — they must
  // simply fail to match (documented divergence), never throw.
  assert.doesNotThrow(() => globToRegExp("*+"))
  assert.equal(matchGlob("*+", "ab"), false)
  assert.doesNotThrow(() => globToRegExp("\\p{L}"))
  assert.equal(matchGlob("\\p{L}", "a"), false)
})

// Review B1: escaped class members (`\]`, `\\`) must translate as LITERAL
// members — the old indexOf("]") slice emitted an unescaped `]` (or trailing
// `\`) into the regex class, and `new RegExp("[\\]]")` THROWS "Unterminated
// character class". Every matrix row is compiled AND matched inside a
// no-throw loop; escaped-member rows additionally assert real matching.
test("matchGlob: glob class escapes never throw (B1) — `\\]`/`\\\\` are literal members, trailing `\\` degrades", () => {
  const matrix = [
    "[\\]]", // escaped `]` member
    "[a\\]b]", // escaped `]` among other members
    "[\\\\]", // escaped backslash member
    "[\\", // trailing lone `\` — unterminated
    "x[\\]y].txt", // escaped member mid-pattern
    "[!\\]]", // negated class with escaped `]`
    "*+", // prior exotic rows stay in the no-throw loop
    "\\p{L}",
  ]
  for (const pat of matrix) {
    assert.doesNotThrow(() => globToRegExp(pat), `globToRegExp(${JSON.stringify(pat)}) must not throw`)
    assert.doesNotThrow(() => matchGlob(pat, "a]b"), `matchGlob(${JSON.stringify(pat)}, "a]b") must not throw`)
  }
  // `\]` is an escaped MEMBER: `*[\]].txt` matches a basename whose `]`
  // sits right before the extension; and mid-name via `*[\]]y.txt`.
  assert.equal(matchGlob("*[\\]].txt", "x].txt"), true)
  assert.equal(matchGlob("*[\\]]y.txt", "x]y.txt"), true)
  assert.equal(matchGlob("*[\\]].txt", "xy.txt"), false)
  assert.equal(matchGlob("[a\\]b]", "]"), true)
  assert.equal(matchGlob("[a\\]b]", "a"), true)
  assert.equal(matchGlob("[a\\]b]", "c"), false)
  // Trailing lone `\` degrades to literal `[` — deterministic under-match.
  assert.equal(matchGlob("[\\", "a"), false)
  assert.equal(matchGlob("[\\", "["), false)
})

// ---------------------------------------------------------------------------
// 2. Walk semantics (D2)
// ---------------------------------------------------------------------------

test("walk: hidden off skips dot-dirs AND dot-files; hidden on includes both", async () => {
  const fs = walkTree()
  const off = await jsSearch(globParams(), fs.seams)
  assert.deepEqual(
    off.records.map((r) => r.path),
    ["a.ts", "other/d.ts", "src/b.ts"],
  )
  const on = await jsSearch(globParams({ hidden: true }), fs.seams)
  assert.deepEqual(
    on.records.map((r) => r.path),
    [".hidden.ts", "a.ts", "other/d.ts", "src/.c.ts", "src/b.ts"],
  )
})

test("walk: .git is ALWAYS excluded, even with hidden on", async () => {
  const fs = walkTree()
  const res = await jsSearch(globParams({ hidden: true }), fs.seams)
  assert.equal(res.records.some((r) => r.path.includes(".git")), false)
})

test("walk: follow off skips a symlink directory entirely; follow on descends it via the LINK-relative path", async () => {
  const fs = walkTree()
  fs.addLink("R/link", "R/other")
  const off = await jsSearch(globParams({ follow: false }), fs.seams)
  assert.equal(off.records.some((r) => r.path.startsWith("link/")), false)
  const on = await jsSearch(globParams({ follow: true }), fs.seams)
  assert.equal(on.records.some((r) => r.path === "link/d.ts"), true, "records under the LINK path")
})

test("walk: junction-shaped dirent (isSymbolicLink) descends when follow is on", async () => {
  // Junctions report as symlinks in Node on win32 — same dirent shape.
  const fs = walkTree()
  fs.addLink("R/junction", "R/src")
  const res = await jsSearch(globParams({ follow: true }), fs.seams)
  assert.equal(res.records.some((r) => r.path === "junction/b.ts"), true)
})

test("walk: cycle guard — a link to an ancestor dir does not loop", async () => {
  const fs = walkTree()
  fs.addLink("R/back", "R") // link → the root itself
  fs.addLink("R/src/up", "R/src") // link → a walked ancestor subdir
  const res = await jsSearch(globParams({ follow: true, hidden: false }), fs.seams)
  assert.equal(res.records.some((r) => r.path.startsWith("back/")), false)
  assert.equal(res.records.some((r) => r.path.startsWith("src/up/")), false)
  // The non-link tree still fully surfaced (no early death, no duplicates).
  assert.deepEqual(
    res.records.map((r) => r.path),
    ["a.ts", "other/d.ts", "src/b.ts"],
  )
})

// Review N5: two dirs mutually linked (dirA/linkB→dirB, dirB/linkA→dirA)
// walked under follow — the memoized-realpath seen-set must terminate the
// cycle: every file under both real dirs listed EXACTLY once, no hang.
test("walk: mutual-link cycle (dirA/linkB→dirB, dirB/linkA→dirA) terminates with each file exactly once", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addDir("R/dirA")
  fs.addDir("R/dirB")
  fs.addFile("R/dirA/a1.ts", "x")
  fs.addFile("R/dirB/b1.ts", "x")
  fs.addLink("R/dirA/linkB", "R/dirB")
  fs.addLink("R/dirB/linkA", "R/dirA")
  const res = await jsSearch(globParams({ pattern: "**/*.ts" }), fs.seams)
  const paths = res.records.map((r) => r.path)
  // Walk terminates and each real-dir file appears EXACTLY once (b1.ts via
  // the linkB path — the real dirB is then caught by the seen-set).
  assert.deepEqual(paths, ["dirA/a1.ts", "dirA/linkB/b1.ts"])
  assert.equal(paths.filter((p) => p === "dirA/a1.ts").length, 1)
  assert.equal(paths.filter((p) => p.endsWith("/b1.ts")).length, 1)
})

// ---------------------------------------------------------------------------
// 3. Grep scan (D2)
// ---------------------------------------------------------------------------

test("grep: include filter, 1-based line numbers, no records for non-matching lines", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/a.ts", "foo\nbar\nfoo baz")
  fs.addFile("R/b.js", "foo")
  fs.addFile("R/c.ts", "nothing here")
  const res = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "foo",
      include: "*.ts",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(res.records, [
    { path: "a.ts", line: 1, text: "foo" },
    { path: "a.ts", line: 3, text: "foo baz" },
  ])
})

test("grep vs glob: an EMPTY file yields no grep records but IS listed by glob kind", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/empty.ts", "")
  const grep = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "x",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(grep.records, [])
  const glob = await jsSearch(globParams({ root: "R", pattern: "*.ts" }), fs.seams)
  assert.deepEqual(glob.records, [{ path: "empty.ts", line: 0, text: "" }])
})

test("grep: binary file (NUL in first 8 KiB) skipped silently", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/bin.dat", "abc\u0000def foo")
  const res = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "foo",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(res.records, [])
  assert.deepEqual(res.notices, [], "binary skip is silent (rg parity)")
})

test("grep: oversized file skipped with the pinned notice", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/big.ts", "x".repeat(MAX_FILE_BYTES + 5))
  const res = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "x",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(res.records, [])
  assert.deepEqual(res.notices, ["(js engine: skipped 1 files over 8 MiB)"])
})

test("grep: compile failure returns the pinned error template and NO records", async () => {
  const fs = walkTree()
  const res = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "([", // invalid in BOTH plain and "u" RegExp dialects
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(res.records, [])
  assert.deepEqual(res.notices, [])
  const prefix =
    "[forge:search] pattern is not a valid regular expression in the builtin-js engine (dialect difference) — install ripgrep or set search.rgPath for full rg-pattern support: "
  assert.ok(res.error.startsWith(prefix), `error carries the pinned template: ${res.error}`)
  assert.ok(res.error.length > prefix.length, "compile error detail appended")
})

// ---------------------------------------------------------------------------
// 4. Walk cap (D4) — injected threshold seam
// ---------------------------------------------------------------------------

test("walk cap: exceeded entries abort the walk with the cap notice", async () => {
  const fs = makeFs()
  fs.addDir("R")
  for (let i = 1; i <= 5; i++) fs.addFile(`R/f${i}.ts`, "x")
  const res = await jsSearch(globParams({ pattern: "*.ts" }), fs.seams, 3)
  assert.deepEqual(res.notices, ["(js engine: walk capped at 3 entries — narrow the path)"])
  assert.equal(res.records.length, 3, "walk aborted after the cap — not all 5 entries")
  assert.deepEqual(
    res.records.map((r) => r.path),
    ["f1.ts", "f2.ts", "f3.ts"],
  )
})

test("bounds: exported cap constants match the design values", () => {
  assert.equal(MAX_WALK_ENTRIES, 200_000)
  assert.equal(MAX_FILE_BYTES, 8 * 1024 * 1024)
})

// Review N4: the record-collection cap is no longer silent — the walk aborts
// at 10000 recorded matches WITH the pinned notice (default text reads
// exactly `10000`).
test("record cap: collection aborts at 10000 recorded matches with the pinned notice (N4)", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/big.ts", Array.from({ length: 10_010 }, () => "needle").join("\n"))
  const res = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "needle",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.equal(res.records.length, 10_000, "collection stops at the cap")
  assert.deepEqual(res.notices, [
    "(js engine: capped at 10000 recorded matches — narrow the pattern)",
  ])
})

// ---------------------------------------------------------------------------
// 5. pathSeparator + file-root behavior
// ---------------------------------------------------------------------------

test("pathSeparator: win32-style separator yields backslash output paths", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addDir("R/src")
  fs.addFile("R/src/a.ts", "foo")
  const res = await jsSearch(
    {
      kind: "grep",
      root: "R",
      pattern: "foo",
      follow: true,
      hidden: false,
      pathSeparator: "\\",
    },
    fs.seams,
  )
  assert.deepEqual(res.records, [{ path: "src\\a.ts", line: 1, text: "foo" }])
})

test("file root: single file scanned with the root string VERBATIM as record path", async () => {
  const fs = makeFs()
  fs.addDir("R")
  fs.addFile("R/a.ts", "foo\nbar")
  const grep = await jsSearch(
    {
      kind: "grep",
      root: "R/a.ts",
      pattern: "bar",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(grep.records, [{ path: "R/a.ts", line: 2, text: "bar" }])
  const glob = await jsSearch(
    {
      kind: "glob",
      root: "R/a.ts",
      pattern: "*.ts",
      follow: true,
      hidden: false,
      pathSeparator: "/",
    },
    fs.seams,
  )
  assert.deepEqual(glob.records, [{ path: "R/a.ts", line: 0, text: "" }])
})
