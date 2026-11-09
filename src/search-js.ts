// forge-search-tools (change search-js-fallback, design D2-D4): the bundled
// PURE-JS search engine core — the third link of the engine chain
// (search.rgPath → rg on PATH → HERE). No @opencode-ai imports, no fs access,
// no spawn — every environment touch (readdir / stat / readFilePrefix /
// realpath) is an injectable seam, same style as src/search-core.ts. Wired in
// plugin.ts by a later task; records feed the EXISTING dedupe/disclosure/
// formatter post-pass unchanged (same {path, line, text} shape).
//
// Decision map (design.md):
//   D2 walk — DFS, name-sorted (determinism), `.git` dirs always skipped,
//      dot-segments skipped unless `hidden`, symlinks/junctions descend only
//      when `follow` with a memoized realpath seen-set cycle guard (seeded
//      with the root's realpath), files matched/scanned THROUGH the link path.
//   D3 glob dialect subset — `*` (within segment), `**` (crosses), `?`,
//      `[class]` (+ `[!...]` negation), `{a,b}` alternation translated to a
//      JS RegExp over the walk-relative forward-slash path; exotic constructs
//      simply fail to match (no error, documented divergence from rg).
//   D4 bounded walk, disclosed — MAX_WALK_ENTRIES entries / MAX_FILE_BYTES
//      per file, surfaced as truncation-style notices when hit.

// ---------------------------------------------------------------------------
// D3 — glob dialect subset
// ---------------------------------------------------------------------------

/** Escape a literal char for RegExp assembly. */
function escapeReChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c
}

/**
 * Translate one glob pattern (or one `{a,b}` alternative, recursively) to a
 * RegExp source fragment (no anchors — the caller anchors).
 *
 * Dialect subset (D3): `*` → `[^/]*` (within segment); a `**` followed by a
 * separator → a group matching zero or more whole leading segments; bare
 * `**` → `.*`; `?` → `[^/]`; `[class]` with leading `!` negation → `^` (ranges
 * kept); `{a,b}` → `(?:a|b)` single-level alternation (alternatives
 * translated recursively).
 * Regex specials are escaped everywhere else. Unclosed `[` / `{` degrade to
 * literal characters — exotic constructs under-match, never throw.
 */
function translateGlob(pat: string): string {
  let out = ""
  let i = 0
  while (i < pat.length) {
    const c = pat[i]!
    if (c === "*") {
      while (pat[i] === "*") i++
      if (pat[i] === "/") {
        i++
        out += "(?:[^/]*/)*"
      } else {
        out += ".*"
      }
    } else if (c === "?") {
      i++
      out += "[^/]"
    } else if (c === "[") {
      let j = i + 1
      let negated = false
      if (pat[j] === "!" || pat[j] === "^") {
        negated = true
        j++
      }
      // Review B1 layer 1 — class-body hardening: find the closing `]` while
      // CONSUMING backslash escape pairs (`\]` and `\\` are escaped MEMBERS,
      // never the terminator); emit the body with `\` and `]` re-escaped for
      // the regex class so no unescaped `]` or trailing `\` can leak out.
      let close = -1
      for (let k = j; k < pat.length; ) {
        if (pat[k] === "\\") {
          k += 2 // escaped member — skip its char
          continue
        }
        if (pat[k] === "]") {
          close = k
          break
        }
        k++
      }
      if (close === -1 || close === j) {
        // Unclosed or empty class → literal `[` (exotic under-match).
        out += "\\["
        i++
        continue
      }
      let body = ""
      for (let m = j; m < close; m++) {
        const ch = pat[m]!
        if (ch === "\\") {
          m++
          const escaped = pat[m]
          if (escaped === undefined) break // trailing lone `\` — dropped
          body += escaped === "\\" || escaped === "]" ? "\\" + escaped : escaped
          continue
        }
        body += ch === "]" || ch === "\\" ? "\\" + ch : ch
      }
      if (body.length === 0) {
        // Body collapsed to nothing (e.g. `[\`) → literal `[` under-match.
        out += "\\["
        i++
        continue
      }
      out += "[" + (negated ? "^" : "") + body + "]"
      i = close + 1
    } else if (c === "{") {
      const close = pat.indexOf("}", i + 1)
      if (close === -1) {
        out += "\\{"
        i++
        continue
      }
      const alts = pat.slice(i + 1, close).split(",")
      out += "(?:" + alts.map((a) => translateGlob(a)).join("|") + ")"
      i = close + 1
    } else {
      out += escapeReChar(c)
      i++
    }
  }
  return out
}

const globRegexCache = new Map<string, RegExp>()

/**
 * Compile a glob pattern to a RegExp. Slash-bearing patterns anchor to the
 * FULL walk-relative path (`^…$`); no-slash patterns match the BASENAME of
 * any depth, gitignore-style (`(^|/)…$`).
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern)
  if (cached !== undefined) return cached
  const source = translateGlob(pattern)
  const anchored = pattern.includes("/")
  const prefix = anchored ? "^" : "(?:^|/)"
  // Review B1 layer 2 — compile guard: even a pathological translation must
  // under-match, never throw (design D2/D3) — fall back to a NEVER-matching
  // RegExp, the documented under-match posture.
  let re: RegExp
  try {
    re = new RegExp(prefix + source + "$")
  } catch {
    re = /$^/
  }
  globRegexCache.set(pattern, re)
  return re
}

/** Match a glob pattern against a walk-relative forward-slash path. */
export function matchGlob(pattern: string, relPathFwd: string): boolean {
  return globToRegExp(pattern).test(relPathFwd)
}

// ---------------------------------------------------------------------------
// D2/D4 — engine types, bounds, seams
// ---------------------------------------------------------------------------

/** Walk cap: entries visited before the walk aborts with a notice (D4). */
export const MAX_WALK_ENTRIES = 200_000

/** Per-file read cap for the grep kind (D4); over-cap files are skipped. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** Record collection cap — the walk aborts early (output truncation at 100
 * already bounds the displayed result; this bounds collection memory). */
const MAX_RECORDS = 10_000

/** Binary detection window: NUL within the first 8 KiB → skip silently
 * (rg parity). */
const BINARY_SNIFF_BYTES = 8 * 1024

export interface JsDirent {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

/** Injectable fs seams — the whole engine is pure with respect to these. */
export interface JsSearchSeams {
  readdir(dir: string): Promise<JsDirent[]>
  /** Follows links (stat, not lstat). */
  stat(p: string): Promise<{ isFile: boolean; isDirectory: boolean }>
  /** Read up to maxBytes; returning MORE than maxBytes marks the file
   * oversized (the real seam reads maxBytes + 1 to make that detectable). */
  readFilePrefix(p: string, maxBytes: number): Promise<Buffer>
  /** Canonical path of the FINAL target (follows links) — cycle-guard seam. */
  realpath(p: string): string
}

export interface JsSearchParams {
  kind: "grep" | "glob"
  /** ABS file or dir — a file root scans/matches that single file only,
   * with the root string verbatim as the record path. */
  root: string
  pattern: string
  include?: string
  follow: boolean
  hidden: boolean
  /** Output path separator ("\\" on win32, "/" elsewhere). */
  pathSeparator: string
}

export interface JsSearchResult {
  records: { path: string; line: number; text: string }[]
  notices: string[]
  error?: string
}

// ---------------------------------------------------------------------------
// D2 — walk engine
// ---------------------------------------------------------------------------

interface WalkContext {
  params: JsSearchParams
  seams: JsSearchSeams
  records: { path: string; line: number; text: string }[]
  lineRe: RegExp | null // grep kind only (glob compiles globToRegExp instead)
  seen: Set<string> // memoized realpath values of walked directories
  realCache: Map<string, string>
  visited: number
  oversizedSkips: number
  aborted: boolean // record cap hit — stop walking (notice emitted, review N4)
  capped: boolean // walk entry cap hit — stop walking, notice emitted later
  maxWalkEntries: number
}

function realOf(ctx: WalkContext, p: string): string {
  const hit = ctx.realCache.get(p)
  if (hit !== undefined) return hit
  const v = ctx.seams.realpath(p)
  ctx.realCache.set(p, v)
  return v
}

function pushRecord(ctx: WalkContext, path: string, line: number, text: string): void {
  ctx.records.push({ path, line, text })
  if (ctx.records.length >= MAX_RECORDS) ctx.aborted = true
}

/** Grep-kind scan of one file (include filter, size cap, binary skip,
 * 1-based line regex test). Records carry the walk-relative output path. */
async function scanFile(
  ctx: WalkContext,
  full: string,
  relFwd: string,
  outPath: string,
): Promise<void> {
  const include = ctx.params.include
  if (typeof include === "string" && include.length > 0 && !matchGlob(include, relFwd)) return
  let buf: Buffer
  try {
    buf = await ctx.seams.readFilePrefix(full, MAX_FILE_BYTES)
  } catch {
    return // fail-soft: unreadable file skips silently
  }
  if (buf.length > MAX_FILE_BYTES) {
    ctx.oversizedSkips++
    return
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return // binary, silent (rg parity)
  const re = ctx.lineRe
  if (re === null) return
  const lines = buf.toString("utf8").split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (ctx.aborted) return
    if (re.test(lines[i]!)) pushRecord(ctx, outPath, i + 1, lines[i]!)
  }
}

/** Glob-kind listing of one file (EMPTY files included — rg `--files`
 * parity; no content read, no binary skip). */
function listFile(ctx: WalkContext, relFwd: string, outPath: string): void {
  if (matchGlob(ctx.params.pattern, relFwd)) pushRecord(ctx, outPath, 0, "")
}

async function handleFile(ctx: WalkContext, full: string, relFwd: string): Promise<void> {
  if (ctx.params.kind === "grep") {
    await scanFile(ctx, full, relFwd, relFwd.split("/").join(ctx.params.pathSeparator))
  } else {
    listFile(ctx, relFwd, relFwd.split("/").join(ctx.params.pathSeparator))
  }
}

async function walkDir(ctx: WalkContext, full: string, relFwd: string): Promise<void> {
  let entries: JsDirent[]
  try {
    entries = await ctx.seams.readdir(full)
  } catch {
    return // fail-soft: unreadable directory skips, siblings still apply
  }
  // Name-sorted for determinism (D2).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (ctx.aborted || ctx.capped) return
    ctx.visited++
    if (ctx.visited > ctx.maxWalkEntries) {
      ctx.capped = true
      return
    }
    if (e.isDirectory && e.name === ".git") continue // ALWAYS skipped (D2)
    if (!ctx.params.hidden && e.name.startsWith(".")) continue
    const childFull = full + ctx.params.pathSeparator + e.name
    const childRel = relFwd === "" ? e.name : relFwd + "/" + e.name
    if (e.isSymbolicLink) {
      if (!ctx.params.follow) continue
      let st: { isFile: boolean; isDirectory: boolean }
      try {
        st = await ctx.seams.stat(childFull)
      } catch {
        continue // broken link skips, siblings still apply
      }
      if (st.isDirectory) {
        const real = realOf(ctx, childFull)
        if (ctx.seen.has(real)) continue // cycle guard (D2)
        ctx.seen.add(real)
        await walkDir(ctx, childFull, childRel)
      } else if (st.isFile) {
        await handleFile(ctx, childFull, childRel) // through the LINK path
      }
    } else if (e.isDirectory) {
      // Realpath every walked directory (memoized — bounded by directory
      // count) so a later link → already-walked-ancestor is caught by the
      // same seen-set the symlink branch checks.
      const real = realOf(ctx, childFull)
      if (ctx.seen.has(real)) continue
      ctx.seen.add(real)
      await walkDir(ctx, childFull, childRel)
    } else if (e.isFile) {
      await handleFile(ctx, childFull, childRel)
    }
  }
}

/**
 * The bundled pure-JS search engine (design D2-D4). DFS walk from an
 * absolute file-or-dir root; records carry walk-relative paths joined with
 * `params.pathSeparator` (matching happens on the forward-slash form).
 *
 * `maxWalkEntries` is an OPTIONAL injected threshold defaulting to
 * MAX_WALK_ENTRIES (test seam for the walk-cap notice; the emitted notice
 * names the effective cap value).
 *
 * Grep pattern compile failure (plain RegExp, then "u"-flag fallback) returns
 * `{ error }` with NO records — the honest dialect-divergence line naming the
 * rg remedies. Never throws; per-entry failures skip fail-soft.
 */
export async function jsSearch(
  params: JsSearchParams,
  seams: JsSearchSeams,
  maxWalkEntries: number = MAX_WALK_ENTRIES,
): Promise<JsSearchResult> {
  // Compile the grep pattern up front — fail fast, no partial results.
  let lineRe: RegExp | null = null
  if (params.kind === "grep") {
    let firstError: unknown = null
    try {
      lineRe = new RegExp(params.pattern)
    } catch (err) {
      firstError = err
    }
    if (lineRe === null) {
      try {
        lineRe = new RegExp(params.pattern, "u")
      } catch (err2) {
        return {
          records: [],
          notices: [],
          error:
            "[forge:search] pattern is not a valid regular expression in the builtin-js engine (dialect difference) — install ripgrep or set search.rgPath for full rg-pattern support: " +
            String((err2 as Error)?.message ?? err2 ?? firstError),
        }
      }
    }
  }

  let rootSt: { isFile: boolean; isDirectory: boolean }
  try {
    rootSt = await seams.stat(params.root)
  } catch {
    return { records: [], notices: [], error: `[forge:search] root path is not accessible: ${params.root}` }
  }

  const ctx: WalkContext = {
    params,
    seams,
    records: [],
    lineRe,
    seen: new Set(),
    realCache: new Map(),
    visited: 0,
    oversizedSkips: 0,
    aborted: false,
    capped: false,
    maxWalkEntries,
  }

  // D4 notices — shared by the file-root and directory-root exits (review
  // N4: the record cap is no longer silent).
  const collectNotices = (): string[] => {
    const out: string[] = []
    if (ctx.capped) {
      out.push(`(js engine: walk capped at ${maxWalkEntries} entries — narrow the path)`)
    }
    if (ctx.aborted && ctx.records.length >= MAX_RECORDS) {
      out.push(`(js engine: capped at ${MAX_RECORDS} recorded matches — narrow the pattern)`)
    }
    if (ctx.oversizedSkips > 0) {
      out.push(`(js engine: skipped ${ctx.oversizedSkips} files over 8 MiB)`)
    }
    return out
  }

  if (rootSt.isFile) {
    // File root: single file only; record path is the root VERBATIM (not
    // dirname-relative). Matching uses the forward-slash form of the root.
    const relFwd = params.root.split(params.pathSeparator).join("/")
    if (params.kind === "glob") {
      if (matchGlob(params.pattern, relFwd)) pushRecord(ctx, params.root, 0, "")
    } else {
      await scanFile(ctx, params.root, relFwd, params.root)
    }
    return { records: ctx.records, notices: collectNotices() }
  }
  if (!rootSt.isDirectory) {
    return { records: [], notices: [] }
  }

  // Directory root: seed the cycle guard with the root's own realpath, then
  // walk (explicit root is walked regardless of dot-name — rg
  // explicit-target parity).
  ctx.seen.add(realOf(ctx, params.root))
  await walkDir(ctx, params.root, "")

  return { records: ctx.records, notices: collectNotices() }
}
