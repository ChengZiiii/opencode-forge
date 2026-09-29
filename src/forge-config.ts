// Dedicated forge.json configuration core (spec: forge-subagents — "Static
// agent definitions in a dedicated forge.json" + "Field-level fail-soft
// validation"; change simplify-dispatch-to-static-agents).
//
// The file is JSONC: line/block comments allowed, trailing commas tolerated.
// Everything here is data in, data out — the loader takes injected fs deps so
// tests drive the exact code the plugin runs.
//
// Validation is FIELD-LEVEL FAIL-SOFT (ZCode subagentMarkdown pattern): a
// semantically invalid agent entry is skipped with an error finding while its
// siblings still apply; a mistyped optional field is ignored with a finding
// (and counts as absent for the atomic model/thoughtLevel pair — so a mistyped
// member can invalidate its whole entry). Only a syntactically broken document
// disables the whole (empty) agent set. There is NO seed and NO fallback: an
// unconfigured host is inert and silent, and the plugin only ever READS the
// file — onboarding is human-facing documentation, never an AI invitation.

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs"

export type AgentShape = "readonly" | "write"

// Validated agent definition. `model` + `thoughtLevel` are an ATOMIC PAIR
// (change auto-worker-inheritance): both present = pinned worker (brain and
// depth bound at materialization); both absent = Auto worker (carries no
// model key — the host inherits the parent session's model at dispatch, no
// depth injected); exactly one present = invalid entry, skipped with an
// error finding. Everything else is optional and degrades field-by-field.
export type ForgeAgentDef = {
  model?: string
  thoughtLevel?: string
  prompt?: string
  shape?: AgentShape
  permission?: Record<string, string>
}

export type ForgeConfigFinding = {
  level: "error" | "warn"
  code: string
  message: string
}

// ---------------------------------------------------------------------------
// JSONC parsing (unchanged from the dispatch-suite era; battle-tested)
// ---------------------------------------------------------------------------

export type JsoncParseOk = { ok: true; config: unknown }
export type JsoncParseErr = { ok: false; error: { message: string; line?: number; column?: number } }

// Strip comments and trailing commas SPACE-PRESERVING: every replaced char
// becomes a space (newlines inside line comments are kept), so byte offsets
// in the sanitized text map 1:1 onto the original — error locations stay
// honest. A trailing comma is dropped by replacing it with a space, which
// leaves valid JSON behind ({"a":1 ,} -> {"a":1  }).
function sanitizeJsonc(text: string): string {
  const out: string[] = []
  let i = 0
  const n = text.length
  let pendingComma = false
  const flushComma = (nextChar: string) => {
    if (pendingComma) {
      // Drop the comma only when the next significant char closes the
      // container; otherwise it separates real elements and stays.
      if (nextChar !== "}" && nextChar !== "]") out.push(",")
      pendingComma = false
    }
  }
  while (i < n) {
    const c = text[i]
    const d = i + 1 < n ? text[i + 1] : ""
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") {
        out.push(" ")
        i++
      }
      continue
    }
    if (c === "/" && d === "*") {
      out.push(" ", " ")
      i += 2
      while (i < n && !(text[i] === "*" && i + 1 < n)) {
        out.push(text[i] === "\n" ? "\n" : " ")
        i++
      }
      if (i < n) {
        out.push(" ", " ")
        i += 2
      }
      continue
    }
    if (c === '"') {
      flushComma(c)
      out.push(c)
      i++
      // String state: escapes never terminate the string; comment markers
      // inside are ordinary data.
      while (i < n && text[i] !== '"') {
        out.push(text[i])
        if (text[i] === "\\") {
          i++
          if (i < n) out.push(text[i])
        }
        i++
      }
      if (i < n) {
        out.push('"')
        i++
      }
      continue
    }
    if (c === ",") {
      pendingComma = true
      out.push(" ")
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out.push(c)
      i++
      continue
    }
    flushComma(c)
    out.push(c)
    i++
  }
  // A pending comma at EOF is malformed anyway; leave it dropped.
  return out.join("")
}

function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

// Minimal structural scanner used ONLY to locate the first syntax violation
// (V8's JSON.parse message no longer carries a position). Runs over the
// sanitized text; loose about number minutiae — JSON.parse stays the actual
// parser, this just pinpoints where it choked.
function locateJsonError(text: string): { message: string; line: number; column: number } | null {
  const n = text.length
  let i = 0
  const stack: Array<"o" | "ov" | "a" | "av"> = []
  const ws = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++
  }
  const fail = (why: string) => {
    const { line, column } = lineColumnAt(text, Math.min(i, n))
    return { message: `${why} (line ${line}, column ${column})`, line, column }
  }
  const skipString = (): string | null => {
    if (text[i] !== '"') return null
    i++
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\") i++
      i++
    }
    if (i >= n) return "unterminated string"
    i++
    return null
  }
  let expectValue = true
  ws()
  if (i >= n) return { message: "empty document", line: 1, column: 1 }
  for (;;) {
    ws()
    if (i >= n) return stack.length === 0 ? null : fail("unexpected end of document")
    const top = stack[stack.length - 1]
    const c = text[i]
    if (expectValue) {
      if (c === "{") {
        stack.push("o")
        i++
        expectValue = false
        continue
      }
      if (c === "[") {
        stack.push("a")
        i++
        continue
      }
      if (c === "}") {
        return fail(`expected a value before '}'`)
      }
      if (c === "]") {
        if (top === "a" || top === "av") {
          stack.pop()
          expectValue = false
          if (stack.length === 0) {
            ws()
            return i >= n ? null : fail(`unexpected token '${text[i]}' after top-level value`)
          }
          i++
          continue
        }
        return fail(`unexpected ']'`)
      }
      if (c === '"') {
        const err = skipString()
        if (err) return fail(err)
        expectValue = false
        if (top === "o") stack[stack.length - 1] = "ov"
        if (top === "a") stack[stack.length - 1] = "av"
        continue
      }
      if (c === "-" || (c >= "0" && c <= "9") || c === "t" || c === "f" || c === "n") {
        while (i < n && !"{}[],:\" \t\n\r".includes(text[i])) i++
        expectValue = false
        if (top === "a") stack[stack.length - 1] = "av"
        continue
      }
      return fail(`unexpected token '${c}'`)
    }
    if (top === "o") {
      if (c === '"') {
        const err = skipString()
        if (err) return fail(err)
        ws()
        if (text[i] !== ":") return fail("expected ':' after object key")
        i++
        expectValue = true
        continue
      }
      return fail(`expected '"' or '}' in object, got '${c}'`)
    }
    if (top === "ov" || top === "av") {
      if (c === ",") {
        i++
        expectValue = true
        if (top === "ov") stack[stack.length - 1] = "o"
        else stack[stack.length - 1] = "a"
        continue
      }
      if ((top === "ov" && c === "}") || (top === "av" && c === "]")) {
        stack.pop()
        if (stack.length === 0) {
          i++
          ws()
          return i >= n ? null : fail(`unexpected token '${text[i]}' after top-level value`)
        }
        i++
        continue
      }
      return fail(`expected ',' or closing bracket, got '${c}'`)
    }
    if (c === "]") {
      stack.pop()
      if (stack.length === 0) {
        i++
        ws()
        return i >= n ? null : fail(`unexpected token '${text[i]}' after top-level value`)
      }
      i++
      continue
    }
    return fail(`unexpected token '${c}'`)
  }
}

export function parseForgeJsonc(text: string): JsoncParseOk | JsoncParseErr {
  const sanitized = sanitizeJsonc(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(sanitized)
  } catch {
    const located = locateJsonError(sanitized)
    return {
      ok: false,
      error: located ?? { message: "invalid JSON", line: 1, column: 1 },
    }
  }
  return { ok: true, config: parsed }
}

// ---------------------------------------------------------------------------
// Field-level fail-soft semantic validation (spec: forge-subagents —
// "Field-level fail-soft validation")
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-z0-9-]+$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

export function validateAgentSet(raw: unknown): { agents: Record<string, ForgeAgentDef>; findings: ForgeConfigFinding[] } {
  const findings: ForgeConfigFinding[] = []
  const agents: Record<string, ForgeAgentDef> = {}
  if (raw === undefined) return { agents, findings }
  if (!isRecord(raw)) {
    findings.push({ level: "error", code: "agents-not-object", message: 'forge.json "agents" must be an object mapping agent ids to definitions — the agent set is empty' })
    return { agents, findings }
  }
  for (const [rawId, entry] of Object.entries(raw)) {
    let label = `agents.${rawId}`
    let id = rawId
    // Reserved-prefix self-heal (change align-forge-config-discovery): the
    // plugin materializes every id as `forge-<id>`, so a `forge-`-prefixed
    // id would double the prefix (`forge-coder` -> agent `forge-forge-coder`).
    // Strip the prefix (all repetitions) with a warn finding — the entry
    // works under its intended name without forcing a file edit.
    if (rawId.startsWith("forge-")) {
      id = rawId.replace(/^(forge-)+/, "")
      findings.push({ level: "warn", code: "agent-id-forge-prefix", message: `${label}: the forge- prefix is added automatically at materialization — stripped to "${id}"; rename the entry to silence this warning` })
    }
    if (!AGENT_ID_RE.test(id)) {
      findings.push({ level: "error", code: "agent-id-invalid", message: `${label}: agent id must match [a-z0-9-] — entry skipped` })
      continue
    }
    if (agents[id] !== undefined) {
      // Only reachable via normalization (duplicate literal keys collapse at
      // JSON.parse): the later entry loses, first-wins, honest error.
      findings.push({ level: "error", code: "agent-id-collision", message: `${label}: normalizes to "${id}" which is already defined — entry skipped (first definition wins)` })
      continue
    }
    if (!isRecord(entry)) {
      findings.push({ level: "error", code: "agent-not-object", message: `${label}: definition must be an object — entry skipped` })
      continue
    }
    if (entry.depths !== undefined) {
      findings.push({ level: "warn", code: "depths-deprecated", message: `${label}.depths is no longer used (static agents pin one thoughtLevel) — ignored; set "thoughtLevel" instead` })
    }
    // Normalize the atomic pair FIRST (design D3): a mistyped member counts
    // as absent; the pair check below then decides the entry's fate.
    let model: string | undefined
    if (entry.model !== undefined) {
      if (nonEmptyString(entry.model)) {
        model = entry.model.trim()
      } else {
        findings.push({ level: "warn", code: "model-invalid", message: `${label}.model must be a non-empty string — field ignored (counts as absent for the model/thoughtLevel pair)` })
      }
    }
    let thoughtLevel: string | undefined
    if (entry.thoughtLevel !== undefined) {
      if (nonEmptyString(entry.thoughtLevel)) {
        thoughtLevel = entry.thoughtLevel.trim()
      } else {
        findings.push({ level: "warn", code: "thoughtlevel-invalid", message: `${label}.thoughtLevel must be a non-empty string — field ignored (counts as absent for the model/thoughtLevel pair)` })
      }
    }
    // Atomic pair: both absent = Auto worker; both present = pinned; exactly
    // one (either direction) = half-configured, entry skipped.
    if ((model === undefined) !== (thoughtLevel === undefined)) {
      const presentHalf = model !== undefined ? "model" : "thoughtLevel"
      const missingHalf = model !== undefined ? "thoughtLevel" : "model"
      findings.push({ level: "error", code: "agent-half-configured", message: `${label}: model and thoughtLevel form an atomic pair — ${presentHalf} is set but ${missingHalf} is missing; set BOTH to pin the brain and depth, or NEITHER for an Auto worker — entry skipped, siblings still apply` })
      continue
    }
    const def: ForgeAgentDef = {}
    if (model !== undefined) {
      def.model = model
      def.thoughtLevel = thoughtLevel
    }
    if (entry.prompt !== undefined) {
      if (nonEmptyString(entry.prompt)) {
        def.prompt = entry.prompt
      } else {
        findings.push({ level: "warn", code: "prompt-invalid", message: `${label}.prompt must be a non-empty string — field ignored` })
      }
    }
    if (entry.shape !== undefined) {
      if (entry.shape === "readonly" || entry.shape === "write") {
        def.shape = entry.shape
      } else {
        findings.push({ level: "warn", code: "shape-invalid", message: `${label}.shape must be "readonly" or "write" — defaulting to readonly` })
      }
    }
    if (entry.permission !== undefined) {
      if (isRecord(entry.permission) && Object.values(entry.permission).every((v) => typeof v === "string")) {
        def.permission = entry.permission as Record<string, string>
      } else {
        findings.push({ level: "warn", code: "permission-invalid", message: `${label}.permission must map tool names to string values — field ignored` })
      }
    }
    agents[id] = def
  }
  return { agents, findings }
}

// ---------------------------------------------------------------------------
// opencode-aligned cascade loader (change align-forge-config-discovery):
// global base + NEAREST project override MERGED per agent id; the project
// layer is discovered by walking UP from the anchor directory to the
// filesystem root (first hit wins); hot-apply mtime cache; NO seed.
// opencode's own config language: "merged together, not replaced", project
// config found by "looking in the current directory, then traversing up".
// ---------------------------------------------------------------------------

export type ForgeConfigSource = "project" | "global" | "project+global" | "none"

export type LoadedForgeConfig = {
  agents: Record<string, ForgeAgentDef>
  source: ForgeConfigSource
  // null when no file backs the result (unconfigured or unreadable).
  path: string | null
  // The discovered project-layer file (nearest .opencode/forge.json on the
  // anchor's ancestor chain); null when no project layer exists.
  projectPath: string | null
  findings: ForgeConfigFinding[]
}

export function forgeConfigPaths(opts: { projectDir?: string; homeDir?: string }): { project: string; global: string } {
  const sep = opts.projectDir?.includes("\\") && !opts.projectDir?.includes("/") ? "\\" : "/"
  const project = opts.projectDir ? `${opts.projectDir}${sep}.opencode${sep}forge.json` : ""
  const global = opts.homeDir ? `${opts.homeDir}${sep}.config${sep}opencode${sep}forge.json` : ""
  return { project, global }
}

export type ForgeConfigLoaderDeps = {
  projectDir?: string
  homeDir?: string
  // Injectable for tests; null stat = file missing.
  stat?: (path: string) => { mtimeMs: number; size: number } | null
  readFile?: (path: string) => string
}

// Filesystem-root predicate for the upward walk: "/", "\", drive roots
// ("C:", "C:/", "C:\"), and the empty anchor terminate the chain.
function isFsRoot(p: string): boolean {
  return p === "" || p === "/" || p === "\\" || /^[A-Za-z]:[\\/]?$/.test(p)
}

// Strip the last path segment, preserving the caller's separator style.
// Returns null at a filesystem root or for a bare separator-less name.
function parentDirOf(p: string): string | null {
  let s = p
  while (s.endsWith("/") || s.endsWith("\\")) {
    if (isFsRoot(s)) return null
    s = s.slice(0, -1)
    if (isFsRoot(s)) return null
  }
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"))
  if (i < 0) return null
  const parent = s.slice(0, i + 1)
  return parent === "" ? null : parent
}

// Candidate forge.json path for a directory, preserving its separator style
// and never doubling a trailing separator (parent links keep theirs:
// "C:/work/repo/" → "C:/work/repo/.opencode/forge.json").
export function forgeCandidateAt(dir: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"
  const base = dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}${sep}`
  return `${base}.opencode${sep}forge.json`
}

// Upward discovery: the NEAREST .opencode/forge.json from the anchor to the
// filesystem root (first hit wins; nothing above it on the chain is
// consulted). Shared by the cascade loader and the pool resolver.
export function discoverProjectFileWith(
  stat: (path: string) => { mtimeMs: number; size: number } | null,
  anchor: string,
): string | null {
  let dir = (anchor ?? "").trim()
  if (!dir) return null
  for (;;) {
    const candidate = forgeCandidateAt(dir)
    if (stat(candidate) !== null) return candidate
    const parent = parentDirOf(dir)
    if (parent === null || parent === dir) return null
    dir = parent
  }
}

export function createForgeConfigLoader(deps: ForgeConfigLoaderDeps): { load(): LoadedForgeConfig } {
  const stat =
    deps.stat ??
    ((path: string) => {
      try {
        const s = statSync(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    })
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const globalPath = forgeConfigPaths({ homeDir: deps.homeDir }).global

  // Hot-apply cache: stat before every load; only an mtime/size change
  // triggers a re-read. Cached per path, INCLUDING parse failures, so a
  // broken file does not re-parse on every lookup. The upward DISCOVERY is
  // re-run on every load (stat-per-level, cheap) so a project file appearing
  // or disappearing anywhere on the anchor's chain applies without restart,
  // exactly like an edit does.
  const cache = new Map<string, { mtimeMs: number; size: number; result: LoadedForgeConfig }>()

  const readCandidate = (path: string, source: Exclude<ForgeConfigSource, "none" | "project+global">): LoadedForgeConfig | null => {
    const st = stat(path)
    if (st === null) {
      cache.delete(path)
      return null
    }
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result
    const text = readFile(path)
    const parsed = parseForgeJsonc(text)
    let result: LoadedForgeConfig
    if (!parsed.ok) {
      // Broken document: THIS layer's agent set is empty with one error
      // finding carrying the parse location (fail-soft per layer — the other
      // layer still applies). There is no seed to fall back to.
      result = {
        agents: {},
        source,
        path,
        projectPath: source === "project" ? path : null,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${parsed.error.message}${parsed.error.line !== undefined ? ` (line ${parsed.error.line}, column ${parsed.error.column})` : ""} — this layer contributes no agents until the file parses`,
          },
        ],
      }
    } else {
      const top = parsed.config
      if (top !== undefined && !isRecord(top)) {
        result = {
          agents: {},
          source,
          path,
          projectPath: source === "project" ? path : null,
          findings: [{ level: "error", code: "config-not-object", message: `${path}: top level must be an object — this layer contributes no agents` }],
        }
      } else {
        const validated = validateAgentSet(top === undefined ? undefined : (top as Record<string, unknown>).agents)
        result = { agents: validated.agents, source, path, projectPath: source === "project" ? path : null, findings: validated.findings }
      }
    }
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, result })
    return result
  }

  // Upward discovery + candidate naming now live at module scope
  // (discoverProjectFileWith / forgeCandidateAt) so the hierarchical pool
  // resolver (below) shares the exact same walk semantics.

  return {
    load(): LoadedForgeConfig {
      const projectPath = discoverProjectFileWith(stat, deps.projectDir ?? "")
      const project = projectPath ? readCandidate(projectPath, "project") : null
      const global = globalPath ? readCandidate(globalPath, "global") : null
      // Merge, never replace: global base, project definition wins per agent
      // id (wholesale — one definition per id, no cross-layer blending).
      if (project && global) {
        return {
          agents: { ...global.agents, ...project.agents },
          source: "project+global",
          path: project.path,
          projectPath: project.path,
          findings: [...global.findings, ...project.findings],
        }
      }
      if (project) return { agents: project.agents, source: "project", path: project.path, projectPath: project.path, findings: project.findings }
      if (global) return { agents: global.agents, source: "global", path: global.path, projectPath: null, findings: global.findings }
      // Unconfigured: inert and silent (spec — "the unconfigured state SHALL
      // be inert: no subagents registered, no errors raised, no AI-facing
      // configuration recipe emitted").
      return { agents: {}, source: "none", path: null, projectPath: null, findings: [] }
    },
  }
}

// ---------------------------------------------------------------------------
// Hierarchical pool materialization (change hierarchical-pool-materialization,
// spec: forge-subagents — "Hierarchical pool materialization on shared
// hosts"). An append-only anchor set resolves pool families: per anchor, the
// walk-up root pool PLUS every sub-pool forge.json in the anchor's subtree
// (bounded BFS, lexicographic sibling order, dependency skip-list, per-anchor
// scanned-directory budget, directory-mtime cache). Pool identity = absolute
// file path (dedup across anchors). The PRIMARY anchor's root pool keeps
// plain ids; every other family materializes as <ns>-<id> where ns is the
// file's `pool` field (fail-soft validated) else the sanitized directory
// basename. Resolution order is deterministic: primary root first, then
// lexicographic by file path — every collision rule keys off that order.
// Everything here is data in, data out (fs injectable), same discipline as
// the loader above.
// ---------------------------------------------------------------------------

export type PoolFamilyOrigin = {
  // Absolute forge.json path — the pool's identity.
  file: string
  // Null on the primary anchor's root pool (plain ids); the namespace of
  // every other family (declared `pool` field, else sanitized dir basename,
  // disambiguated with an incrementing suffix on collision).
  ns: string | null
  // The file's declared `pool` field as written (null when absent).
  declaredPool: string | null
  // True only for the primary anchor's root pool.
  primary: boolean
  // Materialized ids (without the `forge-` prefix) this pool contributes
  // after cross-family collision resolution.
  materializedIds: string[]
}

export type MaterializedPoolAgent = {
  // Materialized id WITHOUT the `forge-` prefix (e.g. "aa-shader").
  materializedId: string
  def: ForgeAgentDef
  ns: string | null
  file: string
}

export type PoolResolution = {
  families: PoolFamilyOrigin[]
  // Key: materialized id without the `forge-` prefix.
  agents: Record<string, MaterializedPoolAgent>
  findings: ForgeConfigFinding[]
}

export type PoolResolverDeps = {
  homeDir?: string
  // Injectable for tests; null stat = file missing.
  stat?: (path: string) => { mtimeMs: number; size: number } | null
  readFile?: (path: string) => string
  // Directory listing with dir-ness per entry; null/throw = unreadable.
  // Default: readdirSync(dir, { withFileTypes: true }).
  readdir?: (dir: string) => Array<{ name: string; dir: boolean }> | null
  // Per-anchor scanned-directory budget (default 2,000).
  scanBudget?: number
}

// Dependency dirs never descended into (exhaustive by design — the spec list
// is the normative set). `.opencode` is added at scan time: its forge.json is
// checked per-parent as a pool candidate, but the directory itself is never
// descended into.
const POOL_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".cache", "venv", ".venv", "__pycache__", "coverage"])
const POOL_SCAN_BUDGET = 2000

// Namespace sanitization (spec-exact): lowercase; each run of characters
// outside [a-z0-9-] collapsed to a single "-"; leading/trailing "-" trimmed;
// empty result falls back to the literal "pool".
export function sanitizeNamespace(name: string): string {
  const collapsed = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return collapsed || "pool"
}

// The optional top-level `pool` field: string, [a-z0-9-], 1..24 chars after
// trim. Anything else is invalid → warn finding + directory-name fallback.
export function validatePoolField(v: unknown): { ok: true; ns: string } | { ok: false } {
  if (typeof v !== "string") return { ok: false }
  const trimmed = v.trim()
  if (trimmed.length < 1 || trimmed.length > 24 || !/^[a-z0-9-]+$/.test(trimmed)) return { ok: false }
  return { ok: true, ns: trimmed }
}

// Basename of a directory path, separator-style agnostic.
function dirBasename(dir: string): string {
  let s = dir
  while (s.length > 1 && (s.endsWith("/") || s.endsWith("\\"))) s = s.slice(0, -1)
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"))
  return i < 0 ? s : s.slice(i + 1)
}

function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function createPoolResolver(deps: PoolResolverDeps): { resolve(anchors: string[]): PoolResolution } {
  const stat =
    deps.stat ??
    ((path: string) => {
      try {
        const s = statSync(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    })
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const readdir =
    deps.readdir ??
    ((dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((d: Dirent) => ({ name: d.name, dir: d.isDirectory() }))
      } catch {
        return null
      }
    })
  const budget = typeof deps.scanBudget === "number" && deps.scanBudget > 0 ? deps.scanBudget : POOL_SCAN_BUDGET
  const globalPath = forgeConfigPaths({ homeDir: deps.homeDir }).global

  // ---- mtime-cached parsed pool file (includes parse failures; the file
  // identity is the absolute path). `parsed: null` = no file at the path.
  type ParsedPool = { agents: Record<string, ForgeAgentDef>; declaredPool: unknown; findings: ForgeConfigFinding[] }
  const fileCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedPool | null }>()
  const readPool = (path: string): ParsedPool | null => {
    const st = stat(path)
    if (st === null) {
      fileCache.delete(path)
      return null
    }
    const hit = fileCache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed
    let parsed: ParsedPool | null = null
    const text = readFile(path)
    const doc = parseForgeJsonc(text)
    if (!doc.ok) {
      parsed = {
        agents: {},
        declaredPool: null,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${doc.error.message}${doc.error.line !== undefined ? ` (line ${doc.error.line}, column ${doc.error.column})` : ""} — this pool contributes no agents until the file parses`,
          },
        ],
      }
    } else if (doc.config !== undefined && !isRecord(doc.config)) {
      parsed = { agents: {}, declaredPool: null, findings: [{ level: "error", code: "config-not-object", message: `${path}: top level must be an object — this pool contributes no agents` }] }
    } else {
      const top = doc.config === undefined ? undefined : (doc.config as Record<string, unknown>)
      const validated = validateAgentSet(top === undefined ? undefined : top.agents)
      parsed = { agents: validated.agents, declaredPool: top === undefined ? null : top.pool, findings: validated.findings }
    }
    fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parsed })
    return parsed
  }

  // ---- mtime-cached directory listing. The pool-file existence check for a
  // directory lives INSIDE its own cached entry (creating .opencode/forge.json
  // inside a directory changes THAT directory's mtime), so subtree scans stay
  // honest without re-statting every candidate on every resolve.
  type DirEntry = { mtimeMs: number; children: Array<{ name: string; dir: boolean }> | null; poolFile: string | null }
  const dirCache = new Map<string, DirEntry>()
  const listDir = (dir: string): DirEntry | null => {
    const st = stat(dir)
    if (st === null) {
      dirCache.delete(dir)
      return null
    }
    const hit = dirCache.get(dir)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit
    const listing = readdir(dir)
    const children = listing === null ? null : [...listing].sort((a, b) => codepointCompare(a.name, b.name))
    // The directory's OWN forge.json candidate (its root-pool file when the
    // directory is itself a pool). Checked once per mtime change.
    let poolFile: string | null = null
    const candidate = forgeCandidateAt(dir)
    if (stat(candidate) !== null) poolFile = candidate
    const entry: DirEntry = { mtimeMs: st.mtimeMs, children, poolFile }
    dirCache.set(dir, entry)
    return entry
  }

  // ---- bounded BFS subtree scan (spec-exact): breadth-first, lexicographic
  // sibling order, dependency skip-list, per-anchor scanned-directory budget.
  // A sub-pool file is `<subdirectory>/.opencode/forge.json` STRICTLY below
  // the anchor (the anchor's own file belongs to the walk-up root pool).
  // Returns pool files in deterministic discovery order.
  const scanSubtree = (anchor: string): string[] => {
    const files: string[] = []
    const seen = new Set<string>()
    let opened = 0
    const sep = anchor.includes("\\") && !anchor.includes("/") ? "\\" : "/"
    const joinDir = (parent: string, name: string) => (parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${name}` : `${parent}${sep}${name}`)
    const queue: string[] = [anchor]
    while (queue.length > 0 && opened < budget) {
      const dir = queue.shift()!
      if (seen.has(dir)) continue
      seen.add(dir)
      const entry = listDir(dir)
      opened++
      if (entry === null || entry.children === null) continue
      // The anchor's own pool file is the root pool, not a sub-pool.
      const isAnchor = dir === anchor
      if (!isAnchor && entry.poolFile !== null) files.push(entry.poolFile)
      for (const child of entry.children) {
        if (!child.dir) continue
        if (POOL_SKIP_DIRS.has(child.name) || child.name === ".opencode") continue
        queue.push(joinDir(dir, child.name))
      }
    }
    return files
  }

  return {
    resolve(anchorsInput: string[]): PoolResolution {
      // Dedup preserving order (the caller normalizes, this is belt-and-
      // braces); [0] is the primary anchor.
      const anchors: string[] = []
      for (const a of anchorsInput) {
        const t = (a ?? "").trim()
        if (t && !anchors.includes(t)) anchors.push(t)
      }
      const findings: ForgeConfigFinding[] = []
      // Global layer: the base of EVERY family (per-id wholesale override by
      // the family file). Its findings flow once per resolve.
      const globalParsed = globalPath ? readPool(globalPath) : null
      if (globalParsed) findings.push(...globalParsed.findings)

      // ---- collect unique pool files across all anchors' chains + subtrees.
      const primaryRootFile = anchors.length > 0 ? discoverProjectFileWith(stat, anchors[0]) : null
      const uniqueFiles = new Set<string>()
      if (primaryRootFile) uniqueFiles.add(primaryRootFile)
      for (const anchor of anchors) {
        for (const f of scanSubtree(anchor)) uniqueFiles.add(f)
        // Non-primary anchors' walk-up roots are families too (namespaced).
        if (anchor !== anchors[0]) {
          const rootFile = discoverProjectFileWith(stat, anchor)
          if (rootFile) uniqueFiles.add(rootFile)
        }
      }
      // ---- deterministic resolution order: primary root pool first, then
      // lexicographic by absolute file path. When NO project pool exists
      // anywhere, the global layer materializes as the plain-id family (the
      // legacy global-only host keeps its roster); otherwise it merges as
      // the base of every family.
      const plainPoolFile = primaryRootFile ?? (globalParsed !== null && globalPath ? globalPath : null)
      const orderedFiles = [plainPoolFile, ...[...uniqueFiles].filter((f) => f !== plainPoolFile).sort(codepointCompare)].filter((f): f is string => f !== null)

      // ---- parse every file once; validate its `pool` field fail-soft.
      type Family = { file: string; parsed: ParsedPool | null; ns: string | null; declaredPool: string | null; primary: boolean }
      const families: Family[] = []
      for (const file of orderedFiles) {
        const parsed = readPool(file)
        // The global fallback family's findings were already collected once
        // at the top — never double-report them.
        if (parsed && file !== globalPath) findings.push(...parsed.findings)
        const isPrimary = plainPoolFile !== null && file === plainPoolFile
        let declaredPool: string | null = null
        if (!isPrimary && parsed) {
          const v = validatePoolField(parsed.declaredPool)
          if (parsed.declaredPool !== undefined && parsed.declaredPool !== null) {
            if (v.ok) {
              declaredPool = v.ns
            } else {
              findings.push({ level: "warn", code: "pool-field-invalid", message: `${file}: invalid "pool" field ${JSON.stringify(String(parsed.declaredPool))} (expected [a-z0-9-], 1-24 chars) — falling back to the directory-derived namespace` })
            }
          }
        }
        families.push({ file, parsed, ns: null, declaredPool, primary: isPrimary })
      }

      // ---- namespace assignment in resolution order: declared ?? sanitized
      // basename; collisions get an incrementing -2/-3/... suffix unique
      // across both derived and declared namespaces; error finding names both
      // files.
      const allDeclared = new Set<string>()
      for (const f of families) if (f.declaredPool) allDeclared.add(f.declaredPool)
      const usedNs = new Map<string, string>() // ns -> owning file
      for (const f of families) {
        if (f.primary) continue
        const base = f.declaredPool ?? sanitizeNamespace(dirBasename(parentDirLabel(parentDirLabel(f.file))))
        let ns = base
        let suffix = 2
        while ((usedNs.has(ns) || (ns !== base && allDeclared.has(ns))) && suffix < 100) {
          ns = `${base}-${suffix++}`
        }
        const owner = usedNs.get(base)
        if (owner !== undefined && owner !== f.file) {
          findings.push({ level: "error", code: "pool-namespace-collision", message: `namespace "${base}" is already used by ${owner} — ${f.file} materializes under "${ns}" instead` })
        }
        f.ns = ns
        usedNs.set(ns, f.file)
      }

      // ---- materialize: global base under each family (per-id wholesale
      // override); namespaced ids <ns>-<id>; cross-family materialized-id
      // collisions resolve in resolution order (earlier family wins, later
      // agent skipped + error finding naming both files).
      const agents: Record<string, MaterializedPoolAgent> = {}
      const origins: PoolFamilyOrigin[] = []
      for (const f of families) {
        const merged: Record<string, ForgeAgentDef> = { ...(globalParsed?.agents ?? {}), ...(f.parsed?.agents ?? {}) }
        const ids: string[] = []
        for (const rawId of Object.keys(merged)) {
          const matId = f.ns === null ? rawId : `${f.ns}-${rawId}`
          const existing = agents[matId]
          if (existing !== undefined) {
            findings.push({ level: "error", code: "materialized-id-collision", message: `materialized agent forge-${matId} from ${f.file} collides with the one from ${existing.file} — the earlier pool in resolution order wins, this agent is skipped` })
            continue
          }
          agents[matId] = { materializedId: matId, def: merged[rawId], ns: f.ns, file: f.file }
          ids.push(matId)
        }
        origins.push({ file: f.file, ns: f.ns, declaredPool: f.declaredPool, primary: f.primary, materializedIds: ids })
      }
      return { families: origins, agents, findings }
    },
  }
}

// Parent-directory label of a path (all separators trimmed). Applied twice
// to a forge.json path it yields the POOL directory (…/<pool>/.opencode/
// forge.json → …/<pool>), the basis for directory-derived namespaces.
function parentDirLabel(filePath: string): string {
  let s = filePath
  while (s.length > 1 && (s.endsWith("/") || s.endsWith("\\"))) s = s.slice(0, -1)
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"))
  return i < 0 ? s : s.slice(0, i)
}
