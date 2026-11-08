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

import { readFileSync, statSync } from "node:fs"

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
        // catalog-driven-depth-shapes: the config boundary normalizes to
        // lowercase (the dictionary and the user's writing surface are
        // lowercase; the catalog vouches for native casing on the wire).
        const normalized = thoughtLevel.toLowerCase()
        if (normalized !== thoughtLevel) {
          findings.push({ level: "warn", code: "thoughtlevel-normalized", message: `${label}.thoughtLevel "${thoughtLevel}" normalized to "${normalized}" (config is lowercase; the catalog decides wire casing)` })
        }
        thoughtLevel = normalized
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
// Workspace pool ownership + global fallback (change sole-pool-ownership,
// spec: forge-subagents — "Workspace pool ownership and global fallback").
// A session's dispatchable pool set is exactly its WORKSPACE pool — the
// NEAREST `.opencode/forge.json` walking up from the workspace directory —
// with the global layer (`~/.config/opencode/forge.json`) as a FALLBACK
// ONLY: fallback, not merge — a workspace with a pool never sees the
// global layer's agents in its roster. `forge.json` files nested DEEPER in
// a workspace's subtree are ignored entirely (the same workspace-ownership
// strictness as the host's native MCP config; there is NO subtree scan).
//
// The HOST-WIDE materialization set is the union of the global layer and
// every workspace pool the host has seen (one pool per seen directory: its
// walk-up nearest file). Everything re-resolves per call through the mtime
// caches — there is NO append-only anchor set: a pool file deleted from
// disk disappears from materialization at the next resolve (deletion is
// real, no zombie pools). EVERY family materializes namespaced (change
// pool-namespace-contract, design D1/D2): no plain-id privilege exists, so
// a materialized id is identical on every host regardless of the order
// workspaces were initialized in (host-history independence). Resolution
// order is PURELY lexicographic by absolute pool-file path (codepoint
// compare, global fallback file included in the sort) — anchor arrival
// order influences neither ids nor collision winners. Each family's ns is
// its declared `pool` field (fail-soft validated) else the sanitized pool
// directory basename; the global fallback file's ns is the FIXED "global"
// (design D2 — one rule, zero exceptions): a declared `pool` field on the
// global file is IGNORED with a warn finding. Everything here is data in, data out (fs injectable), same
// discipline as the loader above.
// ---------------------------------------------------------------------------

export type PoolFamilyOrigin = {
  // Absolute forge.json path — the pool's identity.
  file: string
  // The family's namespace (declared `pool` field, else sanitized pool-dir
  // basename; the global fallback file carries the FIXED "global" — its
  // declared field, if any, is ignored) — disambiguated with
  // an incrementing suffix on collision). Every family carries one; there
  // is no plain-id family (change pool-namespace-contract D1/D2).
  ns: string
  // The file's declared `pool` field as written (null when absent).
  declaredPool: string | null
  // forge-prompt-shared D2: the file's validated top-level `shared` prompt
  // segment (trimmed; null when absent or invalid-and-ignored). Per-FILE
  // scope — every agent this file materializes inherits THIS value only.
  shared: string | null
  // Materialized ids (without the `forge-` prefix) this pool contributes
  // after cross-family collision resolution.
  materializedIds: string[]
}

export type MaterializedPoolAgent = {
  // Materialized id WITHOUT the `forge-` prefix (e.g. "aa-shader").
  materializedId: string
  def: ForgeAgentDef
  ns: string
  file: string
  // forge-prompt-shared D2: this agent's ORIGIN file's `shared` segment —
  // the materializer resolves it per file, never per session or per host.
  shared: string | null
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
}

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

// File-level pool compliance predicate (change pool-namespace-contract,
// design D4): a pool file is COMPLIANT iff its parsed top-level object
// declares a VALID `pool` field (the exact validatePoolField semantics:
// string, [a-z0-9-], 1–24 chars after trim). This is a FILE contract, not
// a per-agent one — agent-entry fail-soft findings never affect it (a
// pool with a valid `pool` but half-broken agents is still compliant; the
// per-agent findings ride their own channels). Pure data-in/data-out: the
// caller feeds the PARSED top level (undefined/non-object ⇒ missing).
export function poolFileCompliance(top: unknown): { compliant: boolean; violation: string } {
  const pool = isRecord(top) ? top.pool : undefined
  if (pool === undefined || pool === null) {
    return { compliant: false, violation: 'missing top-level pool field — declare "pool": "<namespace>" ([a-z0-9-], 1-24 chars) to make this file crew-compliant' }
  }
  if (!validatePoolField(pool).ok) {
    return { compliant: false, violation: `invalid top-level pool field ${JSON.stringify(String(pool))} — expected a string of [a-z0-9-], 1-24 chars after trim` }
  }
  return { compliant: true, violation: "" }
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

export function createPoolResolver(deps: PoolResolverDeps): {
  resolve(anchors: string[]): PoolResolution
  /** The workspace pool file owning an anchor (nearest forge.json walking
   *  up from it) — the session-scoping primitive; null when the workspace
   *  has no pool (the global fallback applies). */
  workspacePoolOf(anchor: string): string | null
} {
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

  // ---- mtime-cached parsed pool file (includes parse failures; the file
  // identity is the absolute path). `parsed: null` = no file at the path.
  type ParsedPool = { agents: Record<string, ForgeAgentDef>; declaredPool: unknown; shared: string | null; findings: ForgeConfigFinding[] }
  const fileCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedPool | null }>()
  const readPool = (path: string): ParsedPool | null => {
    const st = stat(path)
    if (st === null) {
      // Deletion hot-applies: the cached parse dies with the file.
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
        shared: null,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${doc.error.message}${doc.error.line !== undefined ? ` (line ${doc.error.line}, column ${doc.error.column})` : ""} — this pool contributes no agents until the file parses`,
          },
        ],
      }
    } else if (doc.config !== undefined && !isRecord(doc.config)) {
      parsed = { agents: {}, declaredPool: null, shared: null, findings: [{ level: "error", code: "config-not-object", message: `${path}: top level must be an object — this pool contributes no agents` }] }
    } else {
      const top = doc.config === undefined ? undefined : (doc.config as Record<string, unknown>)
      const validated = validateAgentSet(top === undefined ? undefined : top.agents)
      // forge-prompt-shared D2: per-file top-level `shared` — field-level
      // fail-soft exactly like `pool`. undefined/null → absent; a non-string
      // or trim-empty value records exactly ONE warn finding naming the file
      // and is ignored; a valid value is carried TRIMMED. The finding rides
      // parsed.findings, so it surfaces once per resolve through the same
      // channels as every other pool finding (global file included — its
      // findings were pre-collected at the top of resolve).
      const sharedRaw = top === undefined ? undefined : top.shared
      let shared: string | null = null
      if (sharedRaw !== undefined && sharedRaw !== null) {
        if (typeof sharedRaw === "string" && sharedRaw.trim().length > 0) {
          shared = sharedRaw.trim()
        } else {
          validated.findings.push({ level: "warn", code: "shared-invalid", message: `${path}: the top-level "shared" field must be a non-empty string — ignored` })
        }
      }
      parsed = { agents: validated.agents, declaredPool: top === undefined ? null : top.pool, shared, findings: validated.findings }
    }
    fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parsed })
    return parsed
  }

  const workspacePoolOf = (anchor: string): string | null => {
    const dir = (anchor ?? "").trim()
    if (!dir) return null
    return discoverProjectFileWith(stat, dir)
  }

  return {
    workspacePoolOf,

    resolve(anchorsInput: string[]): PoolResolution {
      // Dedup preserving order (the caller normalizes, this is belt-and-
      // braces). Order no longer matters for ids or collisions — family
      // order is purely lexicographic below (host-history independence).
      const anchors: string[] = []
      for (const a of anchorsInput) {
        const t = (a ?? "").trim()
        if (t && !anchors.includes(t)) anchors.push(t)
      }
      const findings: ForgeConfigFinding[] = []
      const globalParsed = globalPath ? readPool(globalPath) : null
      if (globalParsed) findings.push(...globalParsed.findings)

      // ---- one pool per seen workspace directory: its walk-up NEAREST
      // forge.json. Nested (deeper) forge.json files are invisible here —
      // nothing scans subtrees. Pool identity = absolute path, so the same
      // file reached through several anchors materializes exactly once.
      const uniqueFiles = new Set<string>()
      for (const anchor of anchors) {
        const f = workspacePoolOf(anchor)
        if (f) uniqueFiles.add(f)
      }
      if (globalPath && globalParsed) uniqueFiles.add(globalPath)

      // ---- resolution order is PURELY lexicographic by absolute pool-file
      // path (design D1): the global fallback file sorts alongside every
      // workspace pool, and anchor ARRIVAL order influences nothing — ids
      // and collision winners are identical on every host regardless of
      // the order workspaces were initialized in (host-history
      // independence). There is no primary/plain-id family anymore.
      const orderedFiles = [...uniqueFiles].sort(codepointCompare)

      // ---- parse every file once; validate its `pool` field fail-soft. The
      // global fallback file is the ONE exception-free case (design D2): its
      // ns is FIXED to "global", so a declared `pool` there is IGNORED with
      // a warn finding naming the file — never a rename, never an error.
      type Family = { file: string; parsed: ParsedPool | null; ns: string; declaredPool: string | null; shared: string | null }
      const families: Family[] = []
      for (const file of orderedFiles) {
        const parsed = readPool(file)
        // The global fallback family's findings were already collected once
        // at the top — never double-report them.
        if (parsed && file !== globalPath) findings.push(...parsed.findings)
        let declaredPool: string | null = null
        if (parsed) {
          if (file === globalPath) {
            if (parsed.declaredPool !== undefined && parsed.declaredPool !== null) {
              findings.push({ level: "warn", code: "pool-field-ignored-global", message: `${file}: the declared "pool" field ${JSON.stringify(String(parsed.declaredPool))} is ignored — the global fallback namespace is fixed to "global"` })
            }
          } else {
            const v = validatePoolField(parsed.declaredPool)
            if (parsed.declaredPool !== undefined && parsed.declaredPool !== null) {
              if (v.ok) {
                declaredPool = v.ns
              } else {
                findings.push({ level: "warn", code: "pool-field-invalid", message: `${file}: invalid "pool" field ${JSON.stringify(String(parsed.declaredPool))} (expected [a-z0-9-], 1-24 chars) — falling back to the directory-derived namespace` })
              }
            }
          }
        }
        // forge-prompt-shared D3: `shared` is CONTENT, not namespace — the
        // global fallback family INHERITS its file's shared segment even
        // though the declared `pool` field above is ignored there. One rule,
        // zero exceptions: whatever file an agent came from, that file's
        // valid `shared` rides beneath its chain.
        families.push({ file, parsed, ns: "", declaredPool, shared: parsed?.shared ?? null })
      }

      // ---- namespace assignment in resolution order: declared ?? sanitized
      // pool-dir basename — EXCEPT the global fallback file, whose ns is the
      // FIXED "global" no matter what it declares (design D2: one rule, zero
      // exceptions — the declared value is ignored upstream with a warn
      // finding). Collisions get an incrementing -2/-3/... suffix unique
      // across both derived and declared namespaces; error finding names
      // both files.
      const allDeclared = new Set<string>()
      for (const f of families) if (f.declaredPool) allDeclared.add(f.declaredPool)
      const usedNs = new Map<string, string>() // ns -> owning file
      for (const f of families) {
        const base =
          f.file === globalPath
            ? "global"
            : (f.declaredPool ??
              sanitizeNamespace(dirBasename(parentDirLabel(parentDirLabel(f.file)))))
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

      // ---- materialize: each family contributes ONLY its own file's agents
      // (sole ownership — the global layer is a fallback family, NEVER a
      // per-id merge base); EVERY family namespaces (no plain ids — D1/D2):
      // materialized id = <ns>-<id>. Cross-family materialized-id
      // collisions resolve in the (purely lexicographic) resolution order:
      // earlier file wins, later agent skipped + error finding naming both
      // files — deterministically on every host.
      const agents: Record<string, MaterializedPoolAgent> = {}
      const origins: PoolFamilyOrigin[] = []
      for (const f of families) {
        const own = f.parsed?.agents ?? {}
        const ids: string[] = []
        for (const rawId of Object.keys(own)) {
          const matId = `${f.ns}-${rawId}`
          const existing = agents[matId]
          if (existing !== undefined) {
            findings.push({ level: "error", code: "materialized-id-collision", message: `materialized agent forge-${matId} from ${f.file} collides with the one from ${existing.file} — the earlier pool in resolution order wins, this agent is skipped` })
            continue
          }
          // forge-prompt-shared D2: per-FILE scoping — the agent entry
          // carries ITS OWN file's shared, so two pools never bleed segments
          // into each other (sole-ownership mental model).
          agents[matId] = { materializedId: matId, def: own[rawId], ns: f.ns, file: f.file, shared: f.shared }
          ids.push(matId)
        }
        origins.push({ file: f.file, ns: f.ns, declaredPool: f.declaredPool, shared: f.shared, materializedIds: ids })
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
