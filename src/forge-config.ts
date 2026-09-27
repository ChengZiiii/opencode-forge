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
// while the agent still materializes. Only a syntactically broken document
// disables the whole (empty) agent set. There is NO seed and NO fallback: an
// unconfigured host is inert and silent, and the plugin only ever READS the
// file — onboarding is human-facing documentation, never an AI invitation.

import { readFileSync, statSync } from "node:fs"

export type AgentShape = "readonly" | "write"

// Validated agent definition. `model` is REQUIRED (an entry without it is
// skipped with an error finding); everything else is optional and degrades
// field-by-field.
export type ForgeAgentDef = {
  model: string
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
  for (const [id, entry] of Object.entries(raw)) {
    const label = `agents.${id}`
    if (!AGENT_ID_RE.test(id)) {
      findings.push({ level: "error", code: "agent-id-invalid", message: `${label}: agent id must match [a-z0-9-] — entry skipped` })
      continue
    }
    if (!isRecord(entry)) {
      findings.push({ level: "error", code: "agent-not-object", message: `${label}: definition must be an object — entry skipped` })
      continue
    }
    if (!nonEmptyString(entry.model)) {
      findings.push({ level: "error", code: "agent-model-missing", message: `${label}.model: a non-empty "provider/model" string is required — entry skipped, siblings still apply` })
      continue
    }
    const def: ForgeAgentDef = { model: entry.model.trim() }
    if (entry.depths !== undefined) {
      findings.push({ level: "warn", code: "depths-deprecated", message: `${label}.depths is no longer used (static agents pin one thoughtLevel) — ignored; set "thoughtLevel" instead` })
    }
    if (entry.thoughtLevel !== undefined) {
      if (nonEmptyString(entry.thoughtLevel)) {
        def.thoughtLevel = entry.thoughtLevel.trim()
      } else {
        findings.push({ level: "warn", code: "thoughtlevel-invalid", message: `${label}.thoughtLevel must be a non-empty string — field ignored, the agent still materializes` })
      }
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
// Cascade loader (project > global; hot-apply mtime cache; NO seed)
// ---------------------------------------------------------------------------

export type ForgeConfigSource = "project" | "global" | "none"

export type LoadedForgeConfig = {
  agents: Record<string, ForgeAgentDef>
  source: ForgeConfigSource
  // null when no file backs the result (unconfigured or unreadable).
  path: string | null
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
  const paths = forgeConfigPaths({ projectDir: deps.projectDir, homeDir: deps.homeDir })

  // Hot-apply cache: stat before every load; only an mtime/size change
  // triggers a re-read. Cached per path, INCLUDING parse failures, so a
  // broken file does not re-parse on every lookup.
  const cache = new Map<string, { mtimeMs: number; size: number; result: LoadedForgeConfig }>()

  const readCandidate = (path: string, source: Exclude<ForgeConfigSource, "none">): LoadedForgeConfig | null => {
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
      // Broken document: the WHOLE set is empty with one error finding
      // carrying the parse location. There is no seed to fall back to.
      result = {
        agents: {},
        source,
        path,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${parsed.error.message}${parsed.error.line !== undefined ? ` (line ${parsed.error.line}, column ${parsed.error.column})` : ""} — the agent set is empty until the file parses`,
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
          findings: [{ level: "error", code: "config-not-object", message: `${path}: top level must be an object — the agent set is empty` }],
        }
      } else {
        const validated = validateAgentSet(top === undefined ? undefined : (top as Record<string, unknown>).agents)
        result = { agents: validated.agents, source, path, findings: validated.findings }
      }
    }
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, result })
    return result
  }

  return {
    load(): LoadedForgeConfig {
      const project = paths.project ? readCandidate(paths.project, "project") : null
      if (project) return project
      const global = paths.global ? readCandidate(paths.global, "global") : null
      if (global) return global
      // Unconfigured: inert and silent (spec — "the unconfigured state SHALL
      // be inert: no subagents registered, no errors raised, no AI-facing
      // configuration recipe emitted").
      return { agents: {}, source: "none", path: null, findings: [] }
    },
  }
}
