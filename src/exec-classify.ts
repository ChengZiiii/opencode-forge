// readonly-exec-seal (spec: tool-partition — "Readonly workers execute on a
// sealed supervised-exec channel"): the WRITE-CLASS command classifier for
// the supervised exec channel (forge_shell). PURE function core — zero fs
// access, zero side effects, fully injectable (the optional workspaceRoot is
// a plain string), unit-tested in tests/exec-classify.test.mjs.
//
// Posture (design.md D1, adopted): classification is BEST-EFFORT
// belt-in-depth on top of the tool-face deny — NOT a sandbox. A command that
// fails to classify is READ-CLASS (fail-open on the channel, matching the
// refusal belts' fail-open posture); the covered indicator list and the
// known bypass surface (indirect writes, Start-Process writers, encoded
// payloads) are disclosed verbatim in the README.

// Classification vocabulary. The literal READ-CLASS / WRITE-CLASS terms are
// acceptance anchors (spec + README + tests all quote them).
export type ExecKlass = "READ" | "WRITE"
export const READ_CLASS: ExecKlass = "READ"
export const WRITE_CLASS: ExecKlass = "WRITE"

export interface ExecClassification {
  /** READ-CLASS flows; WRITE-CLASS is denied by the seal. */
  klass: ExecKlass
  /** WRITE-CLASS indicator id (present iff klass === WRITE). */
  indicator?: string
  /** The matched command fragment (what tripped the indicator). */
  detail?: string
}

// ---------------------------------------------------------------------------
// WRITE-CLASS indicator tables (exported for README cross-reference and
// test-matrix reuse — tests iterate these tables so the docs, the tables and
// the classifier can never drift apart).
// ---------------------------------------------------------------------------

/** id "redirect" — output redirection to files (`>`, `>>`, fd forms; the
 * PowerShell family uses the same operators; Out-File is a cmdlet below). */
export const REDIRECT_INDICATOR = "redirect"

/** id "mutating-cmdlet" — the known PowerShell mutating cmdlets (minimum
 * delta set; New-Item counts as mutating whenever it appears — it exists to
 * create things; Copy-Item counts — its destination is a write). */
export const MUTATING_CMDLETS = [
  "Set-Content",
  "Out-File",
  "New-Item",
  "Remove-Item",
  "Move-Item",
  "Copy-Item",
  "Add-Content",
  "Clear-Content",
] as const

/** id "git-mutation" — git subcommands that mutate the repo. */
export const GIT_MUTATING_SUBCOMMANDS = [
  "add",
  "commit",
  "push",
  "reset",
  "checkout",
  "rebase",
  "merge",
  "clean",
  "rm",
] as const

/** id "pkg-mutation" — package-manager commands that mutate the tree.
 * Display forms for the README table; the regexes below carry the aliases. */
export const PKG_MUTATING_COMMANDS = ["npm publish", "npm install", "bun add", "pip install"] as const
const PKG_MUTATING_PATTERNS: RegExp[] = [
  /\bnpm\s+(?:publish|install|i|ci|add)\b/i,
  /\bbun\s+(?:add|install)\b/i,
  /\bpip3?\s+install\b/i,
]

/** id "workspace-write" — explicit output-target flags whose parsed value
 * points at a path INSIDE the session workspace (parsed from the command
 * string only; no fs access at classify time). */
export const WRITE_TARGET_FLAGS = [
  "--out",
  "--output",
  "--out-file",
  "--outfile",
  "--outFile",
  "--dest",
  "--destination",
  "-o",
] as const

/** README cross-reference table (one row per covered WRITE-CLASS indicator). */
export const EXEC_SEAL_INDICATORS: ReadonlyArray<{ id: string; covers: string }> = [
  { id: REDIRECT_INDICATOR, covers: "`>` `>>` and fd forms (`2>` `*>`) — bash and the PowerShell family share the operators" },
  { id: "mutating-cmdlet", covers: MUTATING_CMDLETS.join(", ") },
  { id: "git-mutation", covers: `git ${GIT_MUTATING_SUBCOMMANDS.join("/")}` },
  { id: "pkg-mutation", covers: PKG_MUTATING_COMMANDS.join(", ") + " (with common aliases: npm i/ci/add, bun install, pip3 install)" },
  { id: "workspace-write", covers: `output-target flags ${WRITE_TARGET_FLAGS.join(" ")} whose parsed value is a workspace-relative path (or an absolute path under the provided workspaceRoot)` },
]

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Strip quoted spans ('...' / "...") so code literals like `node -e "x => y"`
// or strings mentioning cmdlet names cannot trip the redirect scan. A
// hand-rolled scanner (not regex-replace chains) so escapes inside quotes
// stay simple and predictable.
function stripQuoted(cmd: string): string {
  let out = ""
  let quote: '"' | "'" | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    out += ch
  }
  return out
}

// Detect `>` / `>>` outside quotes (fd-dup forms like `2>&1` excluded: a `>`
// immediately followed by `&` is a stream merge, not a file write).
function redirectMatch(cmd: string): { detail: string } | null {
  const bare = stripQuoted(cmd).replace(/\r?\n/g, " ")
  const m = /(?:^|[^>&])>{1,2}(?!&)[^\s;&|]*/.exec(bare)
  if (m) return { detail: m[0].trim() }
  return null
}

function wordMatch(cmd: string, needle: string): { detail: string } | null {
  const re = new RegExp(`(^|[\\s;&|(])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  const m = re.exec(cmd)
  if (m) return { detail: m[0].trim() }
  return null
}

function gitMutationMatch(cmd: string): { detail: string } | null {
  const bare = stripQuoted(cmd)
  for (const sub of GIT_MUTATING_SUBCOMMANDS) {
    const m = new RegExp(`(?:^|[\\s;&|(])git\\s+${sub}\\b`, "i").exec(bare)
    if (m) return { detail: m[0].trim() }
  }
  return null
}

function pkgMutationMatch(cmd: string): { detail: string } | null {
  const bare = stripQuoted(cmd)
  for (const re of PKG_MUTATING_PATTERNS) {
    const m = re.exec(bare)
    if (m) return { detail: m[0].trim() }
  }
  return null
}

function isDriveRelative(p: string): boolean {
  return /^[a-zA-Z]:/.test(p)
}

// True when the value looks like a file path (contains a separator or an
// extension dot) — guards `-o` shapes like `rg -o TODO` where the next token
// is a pattern, not a path.
function pathLike(p: string): boolean {
  return /^[^;&|<>]+$/.test(p) && /[./\\]/.test(p)
}

function insideWorkspace(value: string, workspaceRoot?: string): boolean {
  const norm = (s: string): string => s.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  if (!isDriveRelative(value) && !value.startsWith("/") && !value.startsWith("\\\\")) {
    // Relative path — the plugin's standing mandate is workspace-relative
    // paths and forge_shell's cwd IS the session worktree, so a relative
    // target writes inside the workspace.
    return true
  }
  if (workspaceRoot === undefined) return false // cannot resolve — READ (fail-open)
  return norm(value).startsWith(`${norm(workspaceRoot)}/`) || norm(value) === norm(workspaceRoot)
}

function workspaceWriteMatch(cmd: string, workspaceRoot?: string): { detail: string } | null {
  const tokens = stripQuoted(cmd).split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    let flag = ""
    let value: string | undefined
    const eq = tok.indexOf("=")
    if (eq > 0 && tok.startsWith("--")) {
      flag = tok.slice(0, eq)
      value = tok.slice(eq + 1)
    } else if ((WRITE_TARGET_FLAGS as readonly string[]).includes(tok)) {
      flag = tok
      value = tokens[i + 1]
    }
    if (!flag || value === undefined) continue
    if (value.startsWith("-")) continue // next flag, not a value
    if (pathLike(value) && insideWorkspace(value, workspaceRoot)) {
      return { detail: `${flag} ${value}` }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Classify a forge_shell command string as READ-CLASS or WRITE-CLASS.
 * Pure: no fs, no clock, no side effects. Anything that fails to classify is
 * READ-CLASS (fail-open on the channel — the seal is belt-in-depth, not a
 * sandbox). The optional workspaceRoot (absolute) lets absolute output
 * targets resolve against the session workspace; without it only relative
 * paths count as workspace writes.
 */
export function classifyExecCommand(cmd: string, opts?: { workspaceRoot?: string }): ExecClassification {
  if (typeof cmd !== "string" || cmd.length === 0) return { klass: READ_CLASS }
  const r = redirectMatch(cmd)
  if (r) return { klass: WRITE_CLASS, indicator: REDIRECT_INDICATOR, detail: r.detail }
  for (const cmdlet of MUTATING_CMDLETS) {
    const m = wordMatch(cmd, cmdlet)
    if (m) return { klass: WRITE_CLASS, indicator: "mutating-cmdlet", detail: m.detail }
  }
  const g = gitMutationMatch(cmd)
  if (g) return { klass: WRITE_CLASS, indicator: "git-mutation", detail: g.detail }
  const p = pkgMutationMatch(cmd)
  if (p) return { klass: WRITE_CLASS, indicator: "pkg-mutation", detail: p.detail }
  const w = workspaceWriteMatch(cmd, opts?.workspaceRoot)
  if (w) return { klass: WRITE_CLASS, indicator: "workspace-write", detail: w.detail }
  return { klass: READ_CLASS }
}
