// Dedicated forge.json configuration core (spec: dispatch — ADDED
// "Dedicated forge.json configuration file", design D1/D2/D5).
//
// The file is JSONC: line/block comments allowed, trailing commas tolerated.
// Everything here is data in, data out (same purity contract as
// dispatch-roster.ts) — the loader in this module takes injected fs deps, so
// tests drive the exact code the plugin runs.
//
// The plugin only ever READS forge.json. Onboarding happens through the error
// recipe (see forgeRecipe below), never by generating the file.

import { readFileSync, statSync } from "node:fs"

export type AgentShape = "readonly" | "write"

export type ForgeAgentDef = {
  model: string
  depths: string[]
  prompt?: string
  shape?: AgentShape
  permission?: Record<string, string>
}

export type ForgeConfig = {
  agents: Record<string, ForgeAgentDef>
}

// ---------------------------------------------------------------------------
// JSONC parsing (task 1.1)
// ---------------------------------------------------------------------------

export type JsoncParseOk = { ok: true; config: ForgeConfig }
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
      while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/")) {
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
  // Container stack: "o" object (expecting key or close), "ov" object after a
  // key-value pair (expecting comma or close), "a" array expecting value or
  // close, "av" array after a value.
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
        expectValue = false // next: key or close
        continue
      }
      if (c === "[") {
        stack.push("a")
        i++
        continue // arrays expect a value immediately (or close)
      }
      if (c === "}") {
        // An object never closes while a VALUE is expected ({"a": } is a
        // syntax error) — only arrays may close empty (handled below).
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
        if (top === "o") stack[stack.length - 1] = "ov" // a bare string is not a valid key start; JSON.parse will say so
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
    // Not expecting a value: object key, colon, comma, or close.
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { message: "forge.json top level must be an object", line: 1, column: 1 } }
  }
  const agents = (parsed as { agents?: unknown }).agents
  if (agents === undefined) return { ok: true, config: { agents: {} } }
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
    return { ok: false, error: { message: 'forge.json "agents" must be an object mapping agent ids to definitions', line: 1, column: 1 } }
  }
  return { ok: true, config: { agents: agents as Record<string, ForgeAgentDef> } }
}

// ---------------------------------------------------------------------------
// Onboarding recipe (task 2.2, spec — ADDED "Seed placeholder onboarding").
// Machine-actionable: the user's session AI can execute every step from this
// text alone. The identity list is injected (no discovery here — pure data),
// strings only, no ladders (the metalanguage makes ladder knowledge
// unnecessary).
// ---------------------------------------------------------------------------

export function forgeRecipe(input: { detectedIdentities: string[]; projectPath: string; globalPath: string }): string {
  const suggested = input.detectedIdentities[0] ?? "provider/model"
  const identityLines =
    input.detectedIdentities.length > 0
      ? input.detectedIdentities.map((id) => `   - ${id}`).join("\n")
      : "   (none detected — check the provider section of the host's opencode config)"
  const template = `{
  // forge dispatch agents — save the file; changes apply on the next dispatch, no restart
  "agents": {
    "research": {
      "model": "${suggested}", // exact "provider/model" string, pick from the detected list above
      "depths": ["low", "medium"], // first entry is the default; canonical words: none, low, medium, high, max — or the model's native level names, passed through verbatim
      // "prompt": "optional role prompt riding inside the discipline wrapper",
      // "shape": "write", // default readonly denies mutating tools; write agents need this
      // "permission": { "bash": "deny" } // optional override of the shape-derived permission
    }
  }
}`
  return [
    "[forge dispatch onboarding recipe]",
    'The dispatch agent you called is pinned to the placeholder model "Local/GPT Luna" — forge.json is not configured. Steps:',
    "",
    "1. Detected configured identities (use one as the exact model string):",
    identityLines,
    "",
    "2. Create ONE of these files (project-level wins; a single file fully applies — never merged):",
    `   - ${input.projectPath}  (project-level, versionable, team-shared)`,
    `   - ${input.globalPath}  (global)`,
    "",
    "3. Copy-paste template (JSONC — comments allowed) and edit model/depths:",
    "",
    template,
    "",
    '4. Verify: call the forge_dispatch tool again with agent "research" and a depth from its depths — the report shows the actual model and the depth translation.',
    "",
    '5. Extending: more agents are more entries under "agents"; agents that edit files need "shape": "write"; an explicit "permission" map overrides the shape-derived defaults — "task" is always denied, recursive dispatch stays impossible.',
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Cascade + seed (task 1.2)
// ---------------------------------------------------------------------------

// Placeholder identity for the seed: a fictional provider ("Local") that can
// never appear in a real host config, so any dispatch on the seed fails
// deterministically with the onboarding recipe (design D5).
export const PLACEHOLDER_IDENTITY = "Local/GPT Luna"

export const SEED_AGENTS: Record<string, ForgeAgentDef> = {
  research: { model: PLACEHOLDER_IDENTITY, depths: ["low", "medium"], shape: "readonly" },
  review: { model: PLACEHOLDER_IDENTITY, depths: ["medium", "high", "max"], shape: "readonly" },
}

export type ForgeConfigSource = "project" | "global" | "seed"

export type ForgeConfigFinding = {
  level: "error" | "warn" | "notice"
  code: string
  message: string
}

export type LoadedForgeConfig = {
  agents: Record<string, ForgeAgentDef>
  source: ForgeConfigSource
  // null for the seed (no file backs it).
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

  // Hot-apply cache (design D2): stat before every load; only an mtime/size
  // change triggers a re-read. Cached per path, INCLUDING parse failures, so
  // a broken file does not re-parse on every dispatch.
  const cache = new Map<string, { mtimeMs: number; size: number; result: LoadedForgeConfig }>()

  const readCandidate = (path: string, source: Exclude<ForgeConfigSource, "seed">): LoadedForgeConfig | null => {
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
      // Design D9: a broken winning file falls back to the SEED, never to the
      // next cascade level — no half-configured hybrid states.
      result = {
        agents: { ...SEED_AGENTS },
        source: "seed",
        path: null,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${parsed.error.message}${parsed.error.line !== undefined ? ` (line ${parsed.error.line}, column ${parsed.error.column})` : ""} — fell back to the built-in seed`,
          },
        ],
      }
    } else {
      result = { agents: parsed.config.agents, source, path, findings: [] }
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
      // Truly unconfigured (no file anywhere): one notice pointing at the
      // recipe. A broken file already reported its parse error above.
      return {
        agents: { ...SEED_AGENTS },
        source: "seed",
        path: null,
        findings: [
          {
            level: "notice",
            code: "dispatch-unconfigured",
            message: "forge dispatch is unconfigured (no forge.json found): every forge_dispatch call will fail with the configuration recipe. Create .opencode/forge.json (project) or ~/.config/opencode/forge.json (global), or ask your session AI to configure dispatch — the recipe in the dispatch error tells it exactly what to write.",
          },
        ],
      }
    },
  }
}
