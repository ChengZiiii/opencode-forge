// Write-guard decisions for the TUI editor (change forge-tui-subagent-config,
// design D2; probes REPORT §3 + probe5 same-host evidence, host 2.4.2).
//
// Pure decision layer: every capability arrives as OBSERVED data (plugin
// registry rows, /api/info, injected local-seam results) and every unknown
// fails closed. What this layer deliberately does NOT claim (owner
// correction 2026-11-27, help/schema probe): there is no known server-side
// disable flag for plugins — the only native off-switch is plugin removal —
// so the gate keys on the OBSERVED registry row (active / failed / absent)
// and never infers an "internally disabled" state behind an active row.
// npm-level disable matrices remain unproven and are claimed by nobody.
//
// P1 review hardening (2026-11-27): endpoint URLs are judged with `new URL`
// — a userinfo-prefixed URL (`http://127.0.0.1:1000@remote.example/`) is NOT
// a loopback endpoint, the loopback host must match exactly, and the port
// must be valid. The ONLY endpoint input is the ACTUALLY-CONNECTED base URL
// (`connectedBaseUrl`) — a missing one REFUSES, and the service-announced
// `urls` list is never consulted (a remote host can announce anything).
// Process identity is judged on the EXACT executable basename (`opencode` /
// `opencode.exe`), not a loose /opencode/ substring: client-side helpers and
// script wrappers need real commandline evidence or an explicit
// seam-verified flag. The exact-executable listener owner matching the API
// pid IS the accepted same-process proof.
//
// Second review round (2026-11-27): identity evidence sources are
// strict — the executable is ONLY `executable` or the command line's
// first token, never an argument that merely names opencode; wrapper
// acceptance requires a RECOGNIZED command layout (`<entry>` right after
// the wrapper, optionally `run <entry>`), unknown layouts refuse; a model
// field that is neither absent, a known object shape, nor a known
// `provider/model` string DEMOTES its row (unreliable) and any
// unrecognizable row makes "absent" unprovable; an expectation object
// that constrains nothing (e.g. model:{}) is no expectation at all.

// ---------------------------------------------------------------------------
// Server Forge enablement (from GET /api/plugin rows)
// ---------------------------------------------------------------------------

export type ForgePluginRow = {
  id?: string
  features?: { server?: boolean; tui?: boolean }
  state?: { status?: string; error?: string }
}

export type ForgeServerEnablement =
  | { state: "active-observed" }
  | { state: "absent" }
  | { state: "failed"; error?: string }
  | { state: "unverifiable"; reason: string }

// The enablement verdict for the Forge server plugin from the observed
// /api/plugin rows of the target location. ONLY a row with
// features.server === true AND state.status === "active" permits writes;
// a missing row (absent), a failed row, and any malformed/incomplete
// observation all refuse — with the reason, never a guess.
export function forgeServerEnablement(rows: unknown, forgeId = "forge"): ForgeServerEnablement {
  if (!Array.isArray(rows)) {
    return { state: "unverifiable", reason: `plugin registry observation failed: expected an array of rows, got ${rows === null ? "null" : typeof rows}` }
  }
  const mine = rows.filter((r): r is ForgePluginRow => r !== null && typeof r === "object" && (r as ForgePluginRow).id === forgeId)
  if (mine.length === 0) return { state: "absent" }
  if (mine.length > 1) return { state: "unverifiable", reason: `${mine.length} registry rows carry id "${forgeId}" — enablement is ambiguous` }
  const row = mine[0]
  if (row.features?.server !== true) {
    return { state: "unverifiable", reason: `registry row for "${forgeId}" does not report features.server=true — the server part is not observable` }
  }
  const status = row.state?.status
  if (status === "active") return { state: "active-observed" }
  if (status === "failed") return { state: "failed", error: typeof row.state?.error === "string" ? row.state.error : undefined }
  return { state: "unverifiable", reason: `registry row for "${forgeId}" reports status ${JSON.stringify(status ?? null)} — cannot verify an active server plugin` }
}

export function writesPermitted(enablement: ForgeServerEnablement): boolean {
  return enablement.state === "active-observed"
}

// ---------------------------------------------------------------------------
// Same-host ownership (loopback /api/info + injected local seam)
// ---------------------------------------------------------------------------

// Identity observation of one local pid (seam-injected; legacy `{name,
// supported}` shapes remain assignable — `name` carries a full command line
// when available, which is preferred over a bare image name).
export type LocalProcessIdentity = {
  supported: boolean
  // Exact executable path/name when observable (argv[0] / image name).
  executable?: string | null
  // POST-EXECUTABLE tokens when observable (`serve` / wrapper-entry
  // evidence). NEVER executable evidence by itself: with neither
  // `executable` nor `name`, the process is unknown and the verdict
  // refuses (unless verifiedService is asserted).
  args?: string[] | null
  // Legacy field: full command line (preferred) or bare image name.
  name?: string | null
  // True ONLY when the seam itself verified this pid is the opencode server
  // (platforms without commandline access). Never defaulted.
  verifiedService?: boolean
}

export type SameHostSeam = {
  // Identify the LOCAL process that owns the listening TCP socket on
  // `port`. supported=false means this platform/path cannot verify — the
  // verdict then fails closed (no writes). Injected so tests drive exact
  // behavior and no platform-specific command is hard-bound here.
  listeningPidOf(port: number): { pid: number | null; supported: boolean }
  // Best-effort identity of a local pid. supported=false also fails
  // closed: pid existence alone is not ownership.
  processIdentity(pid: number): LocalProcessIdentity
}

export type SameHostInput = {
  // Observed GET /api/info body (pid, hostname, urls verbatim). `urls` is
  // the SERVICE-ANNOUNCED list and is NEVER used by the verdict — it is
  // carried only as observability (a remote host can announce anything).
  api: { pid: number | null; hostname: string | null; urls?: string[] | null }
  // This side's observed hostname (os.hostname() of the TUI process).
  local: { hostname: string | null }
  seam: SameHostSeam
  // THE base URL this client actually talks to (live client surface /
  // service endpoint hint — the TUI gate's `baseUrl`). REQUIRED for the
  // TUI wiring: when it is missing or fails the strict validation below
  // the verdict REFUSES. There is deliberately NO fallback to the
  // service-announced `api.urls` (fake-announcement resistance).
  connectedBaseUrl?: string | null
}

export type SameHostVerdict =
  | { writable: true; reasons: string[] }
  | { writable: false; reason: string; reasons: string[] }

export type LoopbackEndpoint = { url: string; host: string; port: number }

// Exact loopback host literals only. Variants that URL-parsing would
// canonicalize to something else (trailing-dot `localhost.`, `0.0.0.0`,
// IPv4-mapped IPv6, `127.0.0.2`, …) fail closed here.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

// Strict single-URL verdict: absolute http(s) URL parsed with `new URL`
// (canonicalization defeats regex host-prefix tricks), NO userinfo
// (`http://user:pass@host/` is never loopback), EXACT loopback host, and a
// valid port (explicit, or the protocol default for empty).
export function connectedLoopbackOf(raw: unknown): { ok: true; endpoint: LoopbackEndpoint } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "no connected base URL observed" }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `${JSON.stringify(raw)} is not an absolute URL` }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${url.protocol} is not http(s)` }
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: `URL carries userinfo (user ${JSON.stringify(url.username)}) — a userinfo-prefixed URL is never a loopback endpoint` }
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: `host ${JSON.stringify(url.hostname)} is not exact loopback (127.0.0.1 / localhost / [::1])` }
  }
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `port ${JSON.stringify(url.port)} is not a valid TCP port` }
  }
  return { ok: true, endpoint: { url: raw, host: url.hostname, port } }
}

// Legacy urls-scan REMOVED deliberately (P1 review): there is no fallback
// from service-announced urls — only the actually-connected base URL can
// authorize the same-host verdict.

const OPENCODE_EXECUTABLES = new Set(["opencode", "opencode.exe"])
// Script-wrapper runs are only accepted with the exact opencode entry file
// visible in the commandline — never on a wrapper name match alone.
const OPENCODE_WRAPPER_ENTRIES = new Set(["opencode", "opencode.exe", "opencode.js", "opencode.mjs", "opencode.cjs"])
const WRAPPER_EXECUTABLES = new Set(["node", "deno", "bun", "bunx", "npx"])

function basenameOf(token: string): string {
  return token.replace(/^"(.*)"$/, "$1").split(/[\\/]/).pop() ?? token
}

function commandLineTokens(line: string): string[] {
  return line.replace(/"/g, " ").split(/\s+/).filter((t) => t !== "")
}

function isWrapperBasename(base: string): boolean {
  return WRAPPER_EXECUTABLES.has(base.replace(/\.(exe|cmd|bat)$/i, ""))
}

// Wrapper entry recognition — RECOGNIZED argument layouts only (unknown
// layout refuses, P1 review): `<entry> ...` (tokens AFTER the executable).
// The `run <entry>` form is a BUN-ism only: `node run opencode.js` executes
// a script literally named `run` and must refuse. A token anywhere deeper
// is never scanned: `node.exe observer.js --watch opencode.js` is an
// unrelated process that merely names opencode.
const RUN_SUBCOMMAND_WRAPPERS = new Set(["bun"])

function wrapperEntryTokenOf(wrapperBase: string, afterExecutableTokens: string[]): string | null {
  let rest = afterExecutableTokens
  if (rest[0] === "run" && RUN_SUBCOMMAND_WRAPPERS.has(wrapperBase)) rest = rest.slice(1)
  const entry = rest[0]
  if (entry === undefined || entry.startsWith("-")) return null
  return entry
}

function identityExecutableOf(identity: LocalProcessIdentity): { executable: string | null; afterExecutable: string[] } {
  // Executable evidence is ONLY the explicit `executable` or the command
  // line's FIRST token (the real argv[0] of a command line, or a bare
  // image name). `args` are POST-EXECUTABLE tokens by interface contract —
  // an argument is never the executable itself, and no argument deeper
  // than position 0 is ever scanned for a name (P1 review: with neither
  // executable- nor name-evidence the process is UNKNOWN → refuses, unless
  // the seam itself asserts verifiedService).
  if (typeof identity.executable === "string" && identity.executable.trim() !== "") {
    const after = Array.isArray(identity.args)
      ? identity.args.filter((t): t is string => typeof t === "string")
      : typeof identity.name === "string"
        ? commandLineTokens(identity.name).slice(1)
        : []
    return { executable: identity.executable.trim(), afterExecutable: after }
  }
  if (typeof identity.name === "string") {
    const tokens = commandLineTokens(identity.name)
    if (tokens.length > 0) return { executable: tokens[0], afterExecutable: tokens.slice(1) }
  }
  return { executable: null, afterExecutable: [] }
}

function identityTokensOf(identity: LocalProcessIdentity): string[] {
  if (Array.isArray(identity.args)) {
    return identity.args.filter((t): t is string => typeof t === "string")
  }
  return typeof identity.name === "string" ? commandLineTokens(identity.name) : []
}

function hasServeEvidence(identity: LocalProcessIdentity): boolean {
  return identityTokensOf(identity).some((t) => t.trim() === "serve")
}

// Exact-evidence identity verdict for the listener pid: the executable must
// be exactly `opencode`/`opencode.exe`, or a script wrapper carrying the
// exact opencode entry file in its commandline (commandline-verified, never
// name-only), or the seam must assert verifiedService===true. The official
// service binary (`opencode(.exe) serve`) passes on the executable leg; a
// `serve` token adds a reason but is not required.
function opencodeServerIdentityVerdict(pid: number, identity: LocalProcessIdentity): { ok: true; note: string; serve: boolean } | { ok: false; reason: string } {
  if (identity.supported !== true) {
    return { ok: false, reason: `process identity for pid ${pid} cannot be verified on this platform — writes refused (fail closed)` }
  }
  const serve = hasServeEvidence(identity)
  if (identity.verifiedService === true) {
    return { ok: true, note: "verifiedService asserted by the local seam", serve }
  }
  const evidence = identityExecutableOf(identity)
  const executable = evidence.executable
  if (executable === null) {
    return { ok: false, reason: `pid ${pid} is an unknown process — not the opencode server` }
  }
  const base = basenameOf(executable).toLowerCase()
  if (OPENCODE_EXECUTABLES.has(base)) {
    return { ok: true, note: `exact opencode executable ${JSON.stringify(executable)}`, serve }
  }
  if (isWrapperBasename(base)) {
    const entry = wrapperEntryTokenOf(base, evidence.afterExecutable)
    if (entry !== null && OPENCODE_WRAPPER_ENTRIES.has(basenameOf(entry).toLowerCase())) {
      return { ok: true, note: `${JSON.stringify(base)} wrapper executing the exact opencode entry ${JSON.stringify(basenameOf(entry))} (recognized command layout)`, serve }
    }
    return { ok: false, reason: `pid ${pid} runs ${JSON.stringify(executable)} (script wrapper) without a recognized opencode entry in its command layout — not provably the opencode server` }
  }
  return { ok: false, reason: `pid ${pid} is ${JSON.stringify(executable)} — not the opencode server` }
}

// Same-host ownership verdict. Requires ALL of:
//   1. /api/info reports pid + hostname,
//   2. the ACTUALLY-CONNECTED base URL (`connectedBaseUrl`) strictly
//      verified as loopback — `new URL` parse, http(s), no userinfo,
//      exact loopback host, valid port; its port is what the seam probes.
//      Missing or invalid REFUSES — there is no service-announced-urls
//      fallback (fake-announcement resistance),
//   3. hostname equality with the local machine,
//   4. the injected seam identifies the local LISTENING-socket owner pid,
//   5. that pid equals the API pid, and
//   6. exact-evidence process identity (see opencodeServerIdentityVerdict).
// Any unsupported/unknown leg refuses (fail closed) with the reason.
export function sameHostVerdict(input: SameHostInput): SameHostVerdict {
  const reasons: string[] = []
  if (typeof input.api.pid !== "number" || !Number.isFinite(input.api.pid)) {
    return { writable: false, reason: "server identity unavailable: /api/info reports no pid", reasons }
  }
  if (typeof input.api.hostname !== "string" || !input.api.hostname) {
    return { writable: false, reason: "server identity unavailable: /api/info reports no hostname", reasons }
  }
  const endpoint = connectedLoopbackOf(input.connectedBaseUrl)
  if (!endpoint.ok) {
    return {
      writable: false,
      reason: `the actually-connected base URL is missing or not a verified loopback endpoint (${endpoint.reason}) — writes refused (service-announced urls are never consulted; pass connectedBaseUrl)`,
      reasons,
    }
  }
  reasons.push(`verified loopback endpoint ${endpoint.endpoint.url} (host ${endpoint.endpoint.host}, port ${endpoint.endpoint.port})`)
  if (input.local.hostname === null || input.local.hostname !== input.api.hostname) {
    return { writable: false, reason: `hostname mismatch: API host ${JSON.stringify(input.api.hostname)} vs local ${JSON.stringify(input.local.hostname)}`, reasons }
  }
  reasons.push(`hostname ${input.api.hostname} matches`)
  const listener = input.seam.listeningPidOf(endpoint.endpoint.port)
  if (!listener.supported) {
    return { writable: false, reason: `local listening-socket ownership cannot be verified on this platform (port ${endpoint.endpoint.port}) — writes refused (fail closed)`, reasons }
  }
  if (listener.pid === null) {
    return { writable: false, reason: `no local listener found on port ${endpoint.endpoint.port} — the server is not on this machine`, reasons }
  }
  reasons.push(`local listener on port ${endpoint.endpoint.port} owned by pid ${listener.pid}`)
  if (listener.pid !== input.api.pid) {
    return { writable: false, reason: `listening pid ${listener.pid} does not match the API pid ${input.api.pid} — ownership unproven`, reasons }
  }
  reasons.push(`listener pid matches API pid ${input.api.pid}`)
  const identity = opencodeServerIdentityVerdict(listener.pid, input.seam.processIdentity(listener.pid))
  if (!identity.ok) {
    return { writable: false, reason: identity.reason, reasons }
  }
  reasons.push(`pid ${listener.pid} identified as the opencode server: ${identity.note}`)
  if (identity.serve) reasons.push(`serve subcommand observed for pid ${listener.pid}`)
  return { writable: true, reasons }
}

// ---------------------------------------------------------------------------
// Post-confirmation nonce proof (NEVER a browse-time write)
// ---------------------------------------------------------------------------

// Token minted after the human CONFIRMS a save; the wiring writes it into a
// temp file it owns, asks the server to read the same bytes back through
// /api/fs/read, then deletes the file. Browse/open flows never write it.
export function nonceToken(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `forge-samehost-${now}-${rand}`
}

export type NonceProof = {
  token: string
  written: boolean
  readBack: string | null
  cleaned: boolean
}

export function nonceSufficient(proof: NonceProof): boolean {
  return proof.written === true && proof.readBack === proof.token && proof.cleaned === true
}

// ---------------------------------------------------------------------------
// Native registration observation (GET /api/agent, probe REPORT §4)
// ---------------------------------------------------------------------------

export type NativeAgentRow = {
  id: string
  description?: string | null
  model?: { providerID?: string | null; modelID?: string | null } | null
  // Detailed normalization only (normalizeAgentRowsDetailed): every OTHER
  // observable field of the raw row (mode / prompt / permission / system /
  // …) preserved verbatim so field expectations can be verified. Legacy
  // rows omit it; a field absent here is NOT observable → any expectation
  // naming it stays unconfirmed (fail closed). Never edited by this layer.
  extras?: Record<string, unknown>
}

export type AgentRowsResult =
  | { ok: true; rows: NativeAgentRow[]; unreliable: number }
  | { ok: false; reason: string }

// Known string-model identity: `provider/model` (optionally `#variant`
// kept verbatim in modelID — a variant difference must not read as a
// match, fail closed).
const STRING_MODEL_RE = /^([^/\s#]+)\/(\S+)$/

// The unreliable-row count rides the returned rows array itself as a
// NON-ENUMERABLE own property (invisible to deepEqual/`.map`, preserved
// for observeRegistration) — so "absence is not provable" survives the
// plain `result.ok ? result.rows : null` UI mapping without extra wiring.
const UNRELIABLE_ROWS = "unreliableRows"

function annotateUnreliableRows(rows: NativeAgentRow[], count: number): NativeAgentRow[] {
  if (count > 0) {
    Object.defineProperty(rows, UNRELIABLE_ROWS, { value: count, enumerable: false, writable: false, configurable: false })
  }
  return rows
}

// Rows the detailed normalizer could not recognize, as carried by the
// rows array annotation (0 when the body was fully readable).
export function unreliableRowCount(rows: NativeAgentRow[] | null): number {
  if (!Array.isArray(rows)) return 0
  const v = (rows as { [UNRELIABLE_ROWS]?: unknown })[UNRELIABLE_ROWS]
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0
}

// Structured normalization (the fail-closed variant): a non-array body, or
// a body where NO row is parseable, is a STRUCTURED FAILURE — never an
// empty registry, because callers deactivate/GC on "absent" and a broken
// response must not read as "nothing registered" (that is how confirmed
// entries get deleted).
//
// Rows that CANNOT be recognized — no usable id, or a model field that is
// neither absent/null, a known object shape, nor a known `provider/model`
// string — are DEMOTED (not emitted) and COUNTED in `unreliable`: any
// unrecognizable row makes "absent" unprovable downstream (observeRegistration's
// afterUnreliableRows), because the demoted row may BE the agent whose
// removal would otherwise be wrongly confirmed (P1 review: a model shape
// drift must never read as a pin removal → Auto). Readable siblings keep
// confirming positively.
export function normalizeAgentRowsDetailed(raw: unknown): AgentRowsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `agent registry response is not an array (${raw === null ? "null" : typeof raw}) — unusable, never treat as an empty registry` }
  }
  const rows: NativeAgentRow[] = []
  let unreliable = 0
  for (const row of raw) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      unreliable++
      continue
    }
    const rec = row as Record<string, unknown>
    if (typeof rec.id !== "string" || rec.id.trim() === "") {
      unreliable++ // missing OR whitespace-only id = unrecognizable row
      continue
    }
    let model: NativeAgentRow["model"] = null
    if (rec.model !== null && rec.model !== undefined) {
      if (typeof rec.model === "object" && !Array.isArray(rec.model)) {
        const m = rec.model as Record<string, unknown>
        const providerID = typeof m.providerID === "string" ? m.providerID : null
        const modelID = typeof m.modelID === "string"
          ? m.modelID
          : typeof m.id === "string"
            ? m.id
            : typeof m.model === "string"
              ? m.model
              : null
        model = { providerID, modelID }
      } else if (typeof rec.model === "string") {
        const mMatch = STRING_MODEL_RE.exec(rec.model.trim())
        if (mMatch === null) {
          unreliable++ // unrecognized model shape — demote, never read as pin-less
          continue
        }
        model = { providerID: mMatch[1], modelID: mMatch[2] }
      } else {
        unreliable++ // unrecognized model shape — demote, never read as pin-less
        continue
      }
    }
    const extras: Record<string, unknown> = {}
    for (const key of Object.keys(rec)) {
      if (key === "id" || key === "description" || key === "model") continue
      extras[key] = rec[key]
    }
    rows.push({
      id: rec.id,
      description: typeof rec.description === "string" ? rec.description : null,
      model,
      extras,
    })
  }
  if (raw.length > 0 && rows.length === 0) {
    return { ok: false, reason: `${raw.length} registry rows carried no usable row (bad id or unrecognized model shape) — shape drift suspected; unusable, never treat as an empty registry` }
  }
  return { ok: true, rows: annotateUnreliableRows(rows, unreliable), unreliable }
}

// Registry rows tolerate shape drift: id is the only mandatory field.
/**
 * @deprecated LEGACY lenient surface — a BROKEN response reads as `[]`,
 * indistinguishable from a genuinely empty registry. NEVER feed
 * confirmation, GC or deactivation decisions from it (that is exactly how
 * confirmed entries get deleted on a bad response). Verification flows and
 * the TUI MUST use {@link normalizeAgentRowsDetailed}, whose ok:false
 * result maps to `after = null` → observeRegistration reports unconfirmed.
 * Kept only for old callers and shape tests.
 */
export function normalizeAgentRows(raw: unknown): NativeAgentRow[] {
  const result = normalizeAgentRowsDetailed(raw)
  return result.ok
    ? result.rows.map((r) => ({ id: r.id, description: r.description ?? null, model: r.model ?? null }))
    : []
}

// Deterministic deep-value serialization for observable-field comparison
// (object key order must never decide a confirmation).
function canonicalJson(v: unknown): string {
  if (v === undefined) return "null"
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  const rec = v as Record<string, unknown>
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`
}

export type RegistrationExpectation = {
  // The NATIVE id (forge-<ns>-<id> for workers, general/explore for
  // overrides).
  id: string
  expect: "present" | "absent"
  // Observable-field confirmation (probe: description + model:{id,providerID}
  // are observable within ~0.4s of the file write). Shapes:
  //   null                — the model pin / description MUST be gone (a
  //                         pinned→Auto conversion is only confirmed when
  //                         the pin truly disappears);
  //   "provider/model"    — exact identity string match;
  //   {providerID?, modelID?} — fieldwise match (undefined fields
  //                         unconstrained; a bare {} constrains nothing).
  // Presence of the id alone is NEVER a changed-fields confirmation for
  // an update.
  model?: string | { providerID?: string | null; modelID?: string | null } | null
  description?: string | null
  // Additional observable-field expectations matched against the row's
  // normalized extras by the row's own field names (e.g. permission /
  // prompt / mode), canonical-JSON equality. A field the row does not
  // expose is not observable here → unconfirmed (fail closed), never
  // confirmed-by-default.
  fields?: Record<string, unknown>
}

export type RegistrationObservation =
  | { kind: "confirmed"; detail: string }
  | { kind: "unconfirmed"; detail: string }

export type RegistrationObservationInput = {
  // Count of raw rows the detailed normalizer could NOT recognize (junk
  // elements, rows without a usable id, unrecognized model shapes —
  // normalizeAgentRowsDetailed's `unreliable`). While > 0, "absent" is
  // NOT provable: any unrecognizable row may be the agent whose removal
  // would otherwise be wrongly confirmed (P1 review). Readable siblings
  // keep confirming positively.
  afterUnreliableRows?: number
}

// Applied status requires the host registry to OBSERVE the change (changed
// observable fields or removal — not merely an existing id). Duplicate rows
// for the same id are ambiguous and refuse. `before` may be null (unknown
// prior state); `after` null means the registry is unreadable.
export function observeRegistration(
  before: NativeAgentRow[] | null,
  after: NativeAgentRow[] | null,
  expected: RegistrationExpectation,
  observation?: RegistrationObservationInput,
): RegistrationObservation {
  if (after === null) return { kind: "unconfirmed", detail: "the native agent registry is unreadable — application status unknown" }
  const matches = after.filter((r) => r.id === expected.id)
  if (matches.length > 1) {
    return { kind: "unconfirmed", detail: `${expected.id} appears ${matches.length} times in the native registry — ambiguous, refusing to confirm` }
  }
  const row = matches[0]
  if (expected.expect === "absent") {
    if (row === undefined) {
      // Explicit input wins; otherwise the rows-array annotation from
      // normalizeAgentRowsDetailed carries the count (P1 review: any
      // unrecognizable row may BE the agent — absence is not provable).
      const unreliable = observation?.afterUnreliableRows ?? unreliableRowCount(after)
      if (unreliable > 0) {
        return { kind: "unconfirmed", detail: `${expected.id} is no longer listed, but ${unreliable} registry row(s) were unrecognizable — removal is not provable from a partly unreadable registry` }
      }
      return { kind: "confirmed", detail: `${expected.id} removed from the native registry` }
    }
    return { kind: "unconfirmed", detail: `${expected.id} is still registered — removal not yet observed` }
  }
  if (row === undefined) return { kind: "unconfirmed", detail: `${expected.id} not yet present in the native registry` }
  const fieldKeys = expected.fields === undefined || expected.fields === null ? [] : Object.keys(expected.fields)
  // A model object that constrains NOTHING (both fields undefined, e.g.
  // {}) is no expectation at all — it must not count as a checkable leg
  // (P2 review).
  const modelConstrains = expected.model !== undefined && !(
    expected.model !== null && typeof expected.model === "object" &&
    (expected.model as { providerID?: unknown }).providerID === undefined &&
    (expected.model as { modelID?: unknown }).modelID === undefined
  )
  if (!modelConstrains && expected.description === undefined && fieldKeys.length === 0) {
    // Presence alone proves presence — never a change. Only a FULLY
    // READABLE prior registry missing the id (a genuinely new
    // registration) confirms on presence (P2 review: a partly unreadable
    // prior may have contained the id). An unknown prior, a prior that
    // already had the id, or an unreadable prior stays unconfirmed.
    const prior = before === null ? null : before.find((r) => r.id === expected.id) ?? null
    if (before !== null && prior === null) {
      const beforeUnreliable = unreliableRowCount(before)
      if (beforeUnreliable === 0) {
        return { kind: "confirmed", detail: `${expected.id} confirmed in the native registry (newly registered)` }
      }
      return { kind: "unconfirmed", detail: `${expected.id} is not listed in the prior registry, but ${beforeUnreliable} prior row(s) were unrecognizable — a genuinely new registration is not provable` }
    }
    return { kind: "unconfirmed", detail: `${expected.id} is present but no checkable observable field was expected (model/description/fields) — id presence alone confirms nothing about an update` }
  }
  if (modelConstrains) {
    const m = row.model ?? null
    if (expected.model === null) {
      if (m !== null) {
        return { kind: "unconfirmed", detail: `${expected.id} is registered but its model pin ${JSON.stringify(m)} is still present — the Auto conversion is not yet observed` }
      }
    } else if (typeof expected.model === "string") {
      const identity = `${m?.providerID ?? ""}/${m?.modelID ?? ""}`
      if (identity !== expected.model) {
        return { kind: "unconfirmed", detail: `${expected.id} is registered but its model fields ${JSON.stringify(m)} do not yet match the expected ${JSON.stringify(expected.model)}` }
      }
    } else if (expected.model !== null && typeof expected.model === "object") {
      const want = expected.model
      const providerMismatch = want.providerID !== undefined && (m?.providerID ?? null) !== (want.providerID ?? null)
      const modelMismatch = want.modelID !== undefined && (m?.modelID ?? null) !== (want.modelID ?? null)
      if (providerMismatch || modelMismatch) {
        return { kind: "unconfirmed", detail: `${expected.id} is registered but its model fields ${JSON.stringify(m)} do not yet match the expected ${JSON.stringify(want)}` }
      }
    }
  }
  if (expected.description !== undefined && row.description !== expected.description) {
    return { kind: "unconfirmed", detail: `${expected.id} is registered but its description does not yet match the compiled output` }
  }
  for (const key of fieldKeys) {
    const observed = row.extras === undefined ? undefined : row.extras[key]
    const wanted = (expected.fields as Record<string, unknown>)[key]
    if (observed === undefined || canonicalJson(observed) !== canonicalJson(wanted)) {
      return { kind: "unconfirmed", detail: `${expected.id} is registered but its observable field ${JSON.stringify(key)} is missing or does not yet match the expected value` }
    }
  }
  const prior = before === null ? null : before.find((r) => r.id === expected.id) ?? null
  const changed = prior === null ? "newly registered" : describeFieldChanges(prior, row)
  return { kind: "confirmed", detail: `${expected.id} confirmed in the native registry (${changed})` }
}

function describeFieldChanges(prior: NativeAgentRow, row: NativeAgentRow): string {
  const changes: string[] = []
  if (prior.description !== row.description) changes.push("description")
  const pm = `${prior.model?.providerID ?? ""}/${prior.model?.modelID ?? ""}`
  const cm = `${row.model?.providerID ?? ""}/${row.model?.modelID ?? ""}`
  if (pm !== cm) changes.push("model")
  if (prior.extras !== undefined && row.extras !== undefined) {
    const keys = new Set([...Object.keys(prior.extras), ...Object.keys(row.extras)])
    for (const key of keys) {
      if (canonicalJson(prior.extras[key]) !== canonicalJson(row.extras[key])) changes.push(key)
    }
  }
  return changes.length > 0 ? `changed fields: ${changes.join(", ")}` : "fields already current"
}
