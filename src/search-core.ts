// forge-search-tools (change forge-search-tools, design D1-D5): the PURE
// function core for `forge_grep` / `forge_glob`. No @opencode-ai imports, no
// spawn, no fs access at module scope — every environment touch (realpath
// resolution, existence checks, PATH) is an injectable seam. Wired in
// plugin.ts by a later task through src/proc.ts `shellSpawn` with shell:false.
//
// Decision map (design.md):
//   D1 argv builder — direct rg spawn, fixed argv, no shell string ever.
//   D2 JSON-stream post-pass dedupe keyed by resolved realpath (memoized).
//   D3 outside-worktree link targets followed + disclosed, never refused.
//   D4 rg resolution: config override → PATH → fail-soft error w/ remedies.
//   D5 output byte-compatible with the builtin grep/glob pair.

import { join as winJoin } from "node:path"
import { join as posixJoin } from "node:path/posix"
import { relative, isAbsolute } from "node:path"
import { existsSync as fsExistsSync } from "node:fs"

// ---------------------------------------------------------------------------
// D1 — argv builder
// ---------------------------------------------------------------------------

/** Exclusion glob applied unconditionally (spec: the `.git` tree is always
 * excluded — value is the literal `--glob=!` + "`**`" + `/.git/` + "`**`"). */
export const GIT_EXCLUSION_GLOB = "--glob=!**/.git/**"

export type SearchToolKind = "grep" | "glob"

export interface RgArgvParams {
  kind: SearchToolKind
  /** Search pattern (grep) or file pattern (glob) — final literal arg. */
  pattern: string
  /** Optional target path (file or directory) — final literal arg after the
   * pattern. When omitted rg receives no path arg (caller's cwd = worktree). */
  path?: string
  /** File filter glob (grep's `include`). Default: absent. */
  include?: string
  /** Follow symlinks/junctions during traversal. Default: true (D1). */
  follow?: boolean
  /** Search dot-directories. Default: true (D1). */
  hidden?: boolean
}

/**
 * Build the fixed ripgrep argv. Pure — the pattern/path land as single
 * literal arguments behind `--`, so shell metacharacters cannot alter
 * execution (readonly by construction, no shell exists).
 *
 * Shape: `--no-config --json [--hidden] [--follow] [git-exclusion] [--glob=<include>] -- <pattern> [<path>]`
 * Both variants (grep/glob) share the shape; `follow`/`hidden` default TRUE,
 * diverging from the builtin pair by design.
 */
export function buildRgArgv(params: RgArgvParams): string[] {
  const { kind, pattern, path, include } = params
  const follow = params.follow !== false
  const hidden = params.hidden !== false
  const argv: string[] = ["--no-config", "--json"]
  if (hidden) argv.push("--hidden")
  if (follow) argv.push("--follow")
  argv.push(GIT_EXCLUSION_GLOB)
  if (typeof include === "string" && include.length > 0) {
    argv.push(`--glob=${include}`)
  }
  argv.push("--")
  argv.push(pattern)
  if (typeof path === "string" && path.length > 0) argv.push(path)
  // `kind` currently does not fork the argv shape (D1 fixes ONE vector for
  // both tools); it is carried in the params so the wiring layer and tests
  // can assert the shared shape against both variants without a second builder.
  void kind
  return argv
}

// ---------------------------------------------------------------------------
// D1b — files-listing vector (glob kind parity fix)
// ---------------------------------------------------------------------------

export interface RgFilesArgvParams {
  /** File-pattern glob — rides `--glob=` verbatim. */
  pattern: string
  /** Optional target path — final literal arg. When omitted, rg walks the
   * caller's cwd (the session worktree). */
  path?: string
  /** Follow symlinks/junctions during traversal. Default: true (D1). */
  follow?: boolean
  /** List dot-directories' files. Default: true (D1). */
  hidden?: boolean
}

/**
 * Build the files-listing argv for the glob tool (`rg --files` semantics).
 * Pure; the pattern lands as a single literal `--glob=` value. Verified
 * against ripgrep 15.2.0 on win32: `--files` emits a PLAIN path list (one
 * per line) — `--json` is inert at best and an arg-order-dependent error at
 * worst (`rg --files --json` exits 2 "requires at least one pattern"), so
 * the vector carries NO `--json` and the wiring parses the plain list with
 * `parseRgFilesList`. Crucially, `--files` lists EMPTY files (zero lines →
 * no match events → invisible to the content vector), which is the builtin
 * glob parity this vector exists to restore.
 *
 * Shape: `--no-config --files [--hidden] [--follow] --glob=<pattern> ` + the
 * literal git-exclusion glob (`GIT_EXCLUSION_GLOB`) + ` [<path>]`
 */
export function buildRgFilesArgv(params: RgFilesArgvParams): string[] {
  const follow = params.follow !== false
  const hidden = params.hidden !== false
  const argv: string[] = ["--no-config", "--files"]
  if (hidden) argv.push("--hidden")
  if (follow) argv.push("--follow")
  argv.push(`--glob=${params.pattern}`)
  argv.push(GIT_EXCLUSION_GLOB)
  if (typeof params.path === "string" && params.path.length > 0) argv.push(params.path)
  return argv
}

/**
 * Parse the plain path list emitted by `rg --files` (stdout as a single
 * string, one path per line). Blank lines are skipped; every surviving line
 * IS a path (rg emits no headers/footers in this mode). Records carry
 * line 0 / empty text — the glob formatter reads only `path`.
 */
export function parseRgFilesList(stdout: string): RgMatchRecord[] {
  if (typeof stdout !== "string" || stdout.length === 0) return []
  return stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((p) => ({ path: p, line: 0, text: "" }))
}

// ---------------------------------------------------------------------------
// D2 — rg --json stream parser
// ---------------------------------------------------------------------------

/** Oversized-record guard: stream lines longer than this are skipped
 * (bounded memory; a pathological rg line cannot balloon the result). */
export const MAX_STREAM_LINE_LENGTH = 1_048_576 // 1 MiB

export interface RgMatchRecord {
  /** Path exactly as rg reported it. */
  path: string
  line: number
  text: string
}

export interface RgStreamParseResult {
  records: RgMatchRecord[]
  /** Non-JSON / unparsable lines dropped (tolerated, design risk table). */
  garbageLines: number
  /** Lines dropped by the oversized-record guard. */
  oversizedLines: number
}

/**
 * Parse an rg `--json` stream (stdout as a single string). Strict-but-
 * tolerant: only `type: "match"` events become records; unknown event types
 * (`begin`, `end`, `summary`, `context`, future additions) are ignored;
 * garbage lines are tolerated and counted; oversized lines are skipped.
 */
export function parseRgJsonStream(stdout: string): RgStreamParseResult {
  const out: RgStreamParseResult = { records: [], garbageLines: 0, oversizedLines: 0 }
  if (typeof stdout !== "string" || stdout.length === 0) return out
  const lines = stdout.split(/\r?\n/)
  for (const raw of lines) {
    if (raw.length === 0) continue
    if (raw.length > MAX_STREAM_LINE_LENGTH) {
      out.oversizedLines++
      continue
    }
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      out.garbageLines++
      continue
    }
    if (ev === null || typeof ev !== "object" || ev.type !== "match") continue
    const data = ev.data
    if (data === null || typeof data !== "object") continue
    const pathText = data?.path?.text
    const lineNumber = data?.line_number
    const lineText = data?.lines?.text
    if (typeof pathText !== "string" || typeof lineNumber !== "number" || typeof lineText !== "string") continue
    out.records.push({ path: pathText, line: lineNumber, text: lineText })
  }
  return out
}

// ---------------------------------------------------------------------------
// D2/D3 — follow-dedupe post-pass + outside-target disclosure
// ---------------------------------------------------------------------------

/** Injectable realpath seam: reported path → resolved real path. */
export type PathResolver = (p: string) => string

/** Memoize a resolver per call (D2: realpath resolved once per distinct
 * reported path). Pure wrapper — the underlying seam stays injectable. */
export function createMemoizedResolver(resolve: PathResolver): PathResolver {
  const cache = new Map<string, string>()
  return (p: string): string => {
    const hit = cache.get(p)
    if (hit !== undefined) return hit
    const v = resolve(p)
    cache.set(p, v)
    return v
  }
}

export interface DedupeResult {
  /** Surviving records, original order, each group represented by its
   * lexicographically first reported path. */
  records: RgMatchRecord[]
  /** How many duplicate records were merged away (footnote N). */
  mergedDuplicates: number
  /** Resolved real paths that escaped the worktree root (disclosure D3). */
  outsideTargets: string[]
}

/** True when `resolved` is not under `root` (plain-string comparison; both
 * are absolute host paths). Handles Windows separators and drive casing. */
export function isOutsideWorktree(resolved: string, root: string): boolean {
  const norm = (s: string): string => s.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  const r = norm(root)
  const v = norm(resolved)
  if (v === r) return false
  const rel = relative(r, v)
  return rel.startsWith("..") || isAbsolute(rel)
}

export interface DedupeOptions {
  /** Worktree root as a plain string (D3: disclosure comparison only). */
  worktreeRoot: string
  /** Injectable realpath resolver (wrap with createMemoizedResolver). */
  resolvePath: PathResolver
  /** Dedupe/disclosure only apply when follow is on (D2 risk note). */
  follow: boolean
}

/**
 * Follow-dedupe post-pass. Groups match records by resolved realpath, keeps
 * the lexicographically first reported path per group, counts merged
 * duplicates for the `+N duplicate paths merged` footnote, and collects
 * resolved targets that lie outside the worktree root for disclosure.
 */
export function dedupeFollowMatches(records: RgMatchRecord[], opts: DedupeOptions): DedupeResult {
  if (!opts.follow) return { records: [...records], mergedDuplicates: 0, outsideTargets: [] }
  const resolve = createMemoizedResolver(opts.resolvePath)
  const seen = new Map<string, RgMatchRecord[]>() // realpath → kept records (per line)
  const outside = new Set<string>()
  let merged = 0
  for (const rec of records) {
    const real = resolve(rec.path)
    if (isOutsideWorktree(real, opts.worktreeRoot)) outside.add(real)
    const bucket = seen.get(real)
    if (bucket === undefined) {
      seen.set(real, [rec])
      continue
    }
    // Same underlying file already reported at this line? A later arrival on
    // an equal line number is a link-path duplicate → merge. Different line
    // numbers in the same file are distinct matches → keep, but rewrite the
    // path to the group's lexicographically first reported path.
    const sameLine = bucket.find((k) => k.line === rec.line)
    if (sameLine !== undefined) {
      merged++
      if (rec.path < sameLine.path) sameLine.path = rec.path // keep first path
      continue
    }
    if (rec.path < bucket[0].path) bucket[0].path = rec.path // representative path
    bucket.push(rec)
  }
  const kept: RgMatchRecord[] = []
  for (const bucket of seen.values()) {
    // Normalize every kept record in a group onto the group's
    // lexicographically first reported path (the representative).
    const firstPath = bucket.reduce((m, r) => (r.path < m ? r.path : m), bucket[0].path)
    for (const r of bucket) kept.push({ ...r, path: firstPath })
  }
  // Stable overall order: sort kept records by (path, line).
  kept.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
  return { records: kept, mergedDuplicates: merged, outsideTargets: [...outside].sort() }
}

// ---------------------------------------------------------------------------
// D4 — rg binary resolution (fail-soft)
// ---------------------------------------------------------------------------

export interface RgResolveSeams {
  /** fs seam — defaults to node:fs existsSync (lazily, stays injectable). */
  existsSync?: (p: string) => boolean
  /** PATH variable — defaults to process.env.PATH. */
  pathEnv?: string
  /** Path list separator — defaults to the host platform's. */
  pathSep?: string
  /** Platform tag ("win32"/"posix") — defaults to process.platform. */
  platform?: string
}

export type RgResolution =
  | { ok: true; binary: string; source: "config" | "path" }
  | { ok: false; error: string }

/** Remedies named in every fail-soft error (spec requirement 4). */
export const RG_MISSING_REMEDIES =
  "install ripgrep (or set search.rgPath in forge config to an existing rg binary), or fall back to the builtin grep/glob tools for this search"

/**
 * Resolve the ripgrep binary: config override `search.rgPath` when it exists
 * on disk → `rg` found on PATH → fail-soft error naming both remedies.
 * Never throws; returns an error object the caller surfaces as tool output.
 */
export function resolveRgBinary(config?: { rgPath?: string }, seams?: RgResolveSeams): RgResolution {
  const platform = seams?.platform ?? process.platform
  const sep = seams?.pathSep ?? (platform === "win32" ? ";" : ":")
  const exists = seams?.existsSync ?? fsExistsSync
  const pathEnv = seams?.pathEnv ?? (process.env.PATH ?? "")

  if (typeof config?.rgPath === "string" && config.rgPath.length > 0 && exists(config.rgPath)) {
    return { ok: true, binary: config.rgPath, source: "config" }
  }
  const exe = platform === "win32" ? "rg.exe" : "rg"
  // Join with the SEAM platform's path semantics so a faked posix/PATH hit
  // resolves the same way it would on that platform (test seam parity).
  const join = platform === "win32" ? winJoin : posixJoin
  for (const dir of pathEnv.split(sep)) {
    if (dir.length === 0) continue
    const candidate = join(dir, exe)
    if (exists(candidate)) return { ok: true, binary: candidate, source: "path" }
  }
  return {
    ok: false,
    error: `ripgrep (rg) not found — ${RG_MISSING_REMEDIES}`,
  }
}

// ---------------------------------------------------------------------------
// D5 — output formatter (builtin parity)
// ---------------------------------------------------------------------------

/** Results cap with truncation notice (spec requirement 1). */
export const MAX_RESULTS = 100

export interface FormatOptions {
  kind: SearchToolKind
  /** Footnote N from the dedupe pass (line emitted only when N > 0). */
  mergedDuplicates?: number
  /** Outside-worktree resolved targets from the dedupe pass (D3 lines). */
  outsideTargets?: string[]
}

/**
 * Format results byte-compatible with the builtin pair:
 *  - grep: `Found N matches` header + `path: Line n: content` blocks
 *  - glob: plain path list (first-seen order, deduped)
 *  - empty: `No files found`
 *  - >100 results: first 100 + truncation notice advising narrower path/pattern
 * Footnotes (duplicate merge count, outside-target disclosures) append last.
 */
export function formatSearchOutput(records: RgMatchRecord[], opts: FormatOptions): string {
  const lines: string[] = []
  const total = records.length
  if (total === 0) {
    lines.push("No files found")
  } else if (opts.kind === "glob") {
    // Plain unique path list (first-seen order), truncated like grep mode.
    const unique: string[] = []
    const seen = new Set<string>()
    for (const r of records) {
      if (!seen.has(r.path)) {
        seen.add(r.path)
        unique.push(r.path)
      }
    }
    for (const p of unique.slice(0, MAX_RESULTS)) lines.push(p)
    if (unique.length > MAX_RESULTS) {
      lines.push(`(truncated at ${MAX_RESULTS} results — narrow the path or pattern)`)
    }
  } else {
    lines.push(`Found ${total} matches`)
    const shown = records.slice(0, MAX_RESULTS)
    for (const r of shown) lines.push(`${r.path}: Line ${r.line}: ${r.text.replace(/\r?\n$/, "")}`)
    if (total > MAX_RESULTS) {
      lines.push(`(truncated at ${MAX_RESULTS} results of ${total} — narrow the path or pattern)`)
    }
  }
  for (const t of opts.outsideTargets ?? []) {
    lines.push(`outside-workspace target searched via link: ${t}`)
  }
  const merged = opts.mergedDuplicates ?? 0
  if (merged > 0) lines.push(`+${merged} duplicate paths merged`)
  return lines.join("\n")
}
