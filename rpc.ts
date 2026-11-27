// Shared static RPC definition — forge TUI config commit protocol
// (change forge-tui-subagent-config, tasks 6.1/6.2/6.3/6.5, design D4/D8).
//
// The `./rpc` package export: ONE plain-JSON-Schema definition shared by the
// server plugin (ctx.rpc.register) and the TUI (ctx.client.rpc). Pure data —
// no node/@opencode imports — statically bundled by design (probe archive
// REPORT §9.8.3). Contract: editOpen/prepare are PURE READ against the
// edit-start snapshot handle (read exactly once at open, never replaced);
// prepare issues a bounded single-use token bound to target, scope+sessionID
// (null = home scope of the server-observed location, never a wildcard — the
// observed location is part of the binding), snapshot bytes+identity, patch
// + preview hash and the server epoch/generation; commit runs under the
// per-actual-target lock and re-verifies before the atomic publish (one
// write per token; a failed sync stays consumed). Receipts are same-epoch,
// in-memory; a missing receipt is UNKNOWN and bytes never adjudicate an old
// commit — clients re-prepare, never replay. These methods are NOT model
// tools and attest no human caller (D5); request shapes carry no paths and
// no raw write text. Probe anchors: nonce echo, unknown-method rejection,
// dispose → unavailable, HTTP `{input:{...}}` wrapping (SDK auto-wraps).

// ---------------------------------------------------------------------------
// Shared protocol types (single source for server wiring, TUI and tests)
// ---------------------------------------------------------------------------

export type Scope = "workspace" | "global"

// Mirrors ForgeConfigFinding (src/forge-config.ts) — JSON-safe.
export type Finding = { level: "warn" | "error"; code: string; message: string }

// Full stat identity of a recipe file. dev/ino are canonical decimal
// STRINGS: real inodes exceed the safe-integer range (Number() would round
// them and the wire validator would refuse the identity as non-integer),
// so the lossless string is the only honest wire shape.
export type FileIdentity = { mtimeMs: number; size: number; dev?: string; ino?: string }

// Editable worker fields (spec: exactly these five, plus the ID at creation); Auto/Pinned is an atomic pair.
export type EntryDraft = {
  mode: "auto" | "pinned"
  model?: string
  thoughtLevel?: string
  prompt?: string
  shape?: "readonly" | "write"
  permission?: Record<string, string>
}

// One draft op in a prepare batch — never a path, never raw file text
// (targets are server-resolved, content token-bound). renameTo presence
// refuses (ids immutable); pool is for workspace creation on an absent file.
export type Op = {
  opId: string
  action: "create" | "update" | "delete"
  kind: "worker" | "override"
  id: string
  draft?: EntryDraft
  renameTo?: string
  pool?: string
}

// --- echo: transport provability + epoch observation ---

export type EchoInput = { nonce: string }
export type EchoOutput = {
  nonce: string
  pluginID: string
  appVersion: string
  epoch: string
  generation: number
}

// --- editOpen: authoritative resolve + the edit-start snapshot handle ---
// Pure read; the file is read exactly once here and every later
// prepare/commit references the returned handle.

export type EditOpenInput = { scope: Scope; sessionID: string | null }

export type EditOpenOk = {
  ok: true
  snapshotId: string
  // Server-resolved exact owning recipe path (disclosed before confirmation).
  path: string
  // Server-issued target identity for the resolved binding (scope, path,
  // observed location, anchor) — disclosed in every preview and receipt and
  // bound into the token; the UI must show it before confirmation.
  targetIdentity: string
  scope: Scope
  sessionID: string | null
  // Server-observed location — part of the token/snapshot binding.
  observedLocation: string | null
  // Authoritative anchor/owner identity for disclosure.
  anchor: string | null
  epoch: string
  generation: number
  // Bounded handle lifetime (epoch ms, injected clock). Expired handles are
  // refused and require a fresh editOpen; no auto-renewal.
  expiresAt: number
  exists: boolean
  readable: boolean
  // Absent file: the server authoritatively resolved a workspace root /
  // global home where explicit creation may land (still requires prepare +
  // confirm + token).
  creatable: boolean
  identity: FileIdentity | null
  // Exact raw bytes (utf8) of the edit-start snapshot when readable.
  raw: string | null
  // Parsed document when the snapshot parses (unknown JSON value).
  document: unknown
  parseError: { message: string; line?: number; column?: number } | null
  findings: Finding[]
}

export type EditOpenOutput =
  | EditOpenOk
  | { ok: false; reason: "scope-unresolved" | "unavailable" | "malformed-request"; message: string }

// --- prepare: canonical patch + single-use preview token (pure read) ---

export type PrepareInput = {
  snapshotId: string
  // Re-stated by the client and compared EXACTLY against the handle binding
  // (null against null). A mismatch refuses without a token.
  scope: Scope
  sessionID: string | null
  ops: Op[]
}

export type PreviewEntry = {
  opId: string
  id: string
  kind: "worker" | "override"
  action: "create" | "update" | "delete"
  // Per-entry plan kind. The FILE write kind is derived separately from the
  // edit-start snapshot (createFile) — a create-file batch stays create-file
  // regardless of the last entry's patch kind.
  entryKind: "create-file" | "patch" | "remove" | "no-op"
  summary: string[]
  findings: Finding[]
}

// A validator-rejected entry: never written, always listed (fail-soft).
export type PreviewRejected = {
  opId: string
  id: string
  reason: string
  message: string
  findings: Finding[]
}

export type Preview = {
  path: string
  // Server-issued target identity of the resolved binding (see EditOpenOk).
  targetIdentity: string
  scope: Scope
  sessionID: string | null
  // Exact snapshot bytes (null when the file will be created).
  oldText: string | null
  // The exact bytes a confirmed commit would publish.
  newText: string
  // sha256 hex of newText — the canonical content binding of the token.
  previewHash: string
  // Derived from the edit-start snapshot (exists=false), never from the last
  // entry's plan kind.
  createFile: boolean
  // Edit-start identity bound into the token (disclosure).
  identity: FileIdentity | null
  entries: PreviewEntry[]
  rejected: PreviewRejected[]
}

export type PrepareToken = {
  token: string
  // Bounded lifetime (epoch ms, injected clock). Expired tokens are refused
  // and require a fresh prepare; expiry is never auto-renewed.
  expiresAt: number
  epoch: string
  generation: number
}

export type PrepareOk =
  | { ok: true; outcome: "token"; token: PrepareToken; preview: Preview; findings: Finding[] }
  // Every entry resolved to no change: no token is issued and nothing can
  // write (cancel and no-op never write). Validator-rejected entries are
  // still disclosed here — a no-op never silently swallows them.
  | { ok: true; outcome: "no-op"; summary: string[]; rejected: PreviewRejected[]; findings: Finding[] }

export type PrepareRejectReason =
  | "snapshot-unknown"
  | "snapshot-expired"
  | "epoch-stale"
  | "scope-mismatch"
  | "scope-unresolved"
  // Current bytes/identity no longer match the edit-start handle: refuse and
  // reload — an external edit is never silently swallowed (and never a plan
  // input).
  | "conflict-reload"
  | "unreadable"
  | "unparseable"
  | "invalid-op"
  | "invalid-id"
  | "invalid-pool"
  | "invalid-scope"
  | "duplicate"
  | "not-found"
  | "ambiguous"
  // Every op in the batch was rejected: nothing to write, no token.
  | "no-valid-entries"
  | "malformed-request"
  | "unavailable"

export type PrepareOutput =
  | PrepareOk
  | { ok: false; reason: PrepareRejectReason; message: string; findings?: Finding[] }

// --- commit: confirmed single-use atomic publish ---
// The client MUST re-state the CURRENT scope/sessionID (the server cannot
// observe the TUI router's session→home migration); both are compared
// exactly against the token binding, then the server re-resolves the
// authoritative target under the commit lock. No client identity.

export type CommitInput = {
  token: string
  // Must be EXACTLY true (handler-enforced) — explicit human confirmation.
  confirm: boolean
  scope: Scope
  sessionID: string | null
}

export type CommitEntryOutcome = {
  opId: string
  id: string
  kind: "worker" | "override"
  action: "create" | "update" | "delete"
  entryKind: "create-file" | "patch" | "remove" | "no-op"
  outcome: "written" | "no-op" | "rejected"
  reason?: string
  summary: string[]
  findings: Finding[]
}

export type CommitReceipt = {
  commitId: string
  // The spent token (echoed; also the receipt lookup key).
  token: string
  outcome:
    | "written"
    | "no-op"
    | "conflict"
    | "ownership-lost"
    | "write-failed"
    | "missing"
    | "unreadable"
    | "unparseable"
  message: string
  path: string
  // Server-issued target identity of the binding this receipt belongs to.
  targetIdentity: string
  scope: Scope
  sessionID: string | null
  // Post-publish stat identity (null unless outcome === "written").
  savedIdentity: FileIdentity | null
  // Real UTF-8 byte length of the published document (not UTF-16 chars).
  bytes: number
  entries: CommitEntryOutcome[]
  epoch: string
  generation: number
  // Epoch ms of the completed verdict (injected clock).
  at: number
  // Reserved slot for the server-side family-sync outcome (owned by the sync
  // handlers). A failed sync after a successful save does NOT change this
  // receipt's save verdict and does NOT revive the token.
  sync?: Record<string, unknown> | null
}

export type CommitRejectReason =
  | "token-unknown"
  | "token-expired"
  | "token-spent"
  | "epoch-stale"
  | "scope-mismatch"
  | "scope-unresolved"
  | "confirm-required"
  | "malformed-request"
  | "unavailable"

export type CommitOutput =
  | { ok: true; receipt: CommitReceipt }
  | { ok: false; reason: CommitRejectReason; message: string }

// --- receipt: same-epoch lookup by token (ambiguous-outcome resolution) ---
// found:false = UNKNOWN: bytes never adjudicate an old commit; re-prepare,
// never replay.

export type ReceiptInput = { token: string }
export type ReceiptOutput =
  | { found: true; receipt: CommitReceipt; epoch: string; generation: number }
  | { found: false; epoch: string; generation: number }

// --- sync: ONE method, explicit action (prepare/apply) ---

// One sync method with an explicit action (no invented syncPrepare method).
// prepare: confirm MUST be false, no token. apply: confirm MUST be exactly
// true and the prepared token is required. Unknown top-level fields are
// refused by the schema AND the sync handler.
export type SyncAction = "prepare" | "apply"

export type SyncInput = {
  scope: Scope
  sessionID: string | null
  confirm: boolean
  action: SyncAction
  // apply requires the prepared token; prepare must not carry one.
  token?: string
  // Optional apply-side correlation to the commit receipt.
  commitId?: string
}

export type SyncToken = { token: string; expiresAt: number; epoch: string; generation: number }

// Server-resolved family identity fixed before/after (coverage: "full" or
// the sync is refused — no coverage guessing, no new registry).
export type SyncFamily = { file: string; ns: string; materializedIds: string[] }

export type SyncFileOp = {
  nativeId: string
  fileName: string
  dest: string
  op: "create" | "update" | "unchanged"
}

// The exact garbage-collection candidates a sync would remove (marker-keyed,
// executor-identical eligibility) — part of the preview AND the token
// binding, so a pure-delete sync is a real planned change, never a noop.
export type SyncPreviewGc = { nativeId: string; dest: string }

export type SyncPreview = {
  path: string
  scope: Scope
  sessionID: string | null
  observedLocation: string | null
  anchor: string | null
  family: SyncFamily | null
  overridesIncluded: boolean
  files: SyncFileOp[]
  gc: SyncPreviewGc[]
  coverage: "full"
  summary: string[]
  findings: Finding[]
}

export type SyncPrepareOk =
  | { ok: true; action: "prepare"; outcome: "token"; token: SyncToken; preview: SyncPreview; findings: Finding[] }
  // No change to project: no token is issued, nothing can write. The FULL
  // preview still rides the verdict — the UI shows the current projection
  // even when there is nothing to apply.
  | { ok: true; action: "prepare"; outcome: "noop"; preview: SyncPreview; findings: Finding[] }

export type SyncRosterRef = { nativeId: string; fileName: string }
export type SyncErrorItem = { message: string; nativeId?: string; fileName?: string }
export type SyncConflictItem = { message: string; nativeId?: string; fileName?: string; winnerFile?: string }

// Field-level application observation: applied ONLY for actually-changed
// registration fields or the exact removed ID — unchanged or unobserved is
// unconfirmed, never applied.
export type SyncAppliedStatus = {
  status: "applied" | "unconfirmed"
  observedBy: string | null
  confirmedIds: string[]
  removedConfirmedIds: string[]
  unconfirmedIds: string[]
}

export type SyncApplyOk = {
  ok: true
  action: "apply"
  outcome: "applied" | "unconfirmed" | "conflict" | "refused" | "noop"
  applied: boolean
  path: string
  scope: Scope
  sessionID: string | null
  created: SyncRosterRef[]
  updated: SyncRosterRef[]
  unchanged: string[]
  gced: string[]
  errors: SyncErrorItem[]
  removedIds: string[]
  appliedStatus: SyncAppliedStatus
  conflicts: SyncConflictItem[]
  summary: string[]
  findings: Finding[]
  epoch: string
  generation: number
  at: number
}

export type SyncRejectReason =
  | "invalid-input"
  | "scope-unresolved"
  | "no-coverage"
  | "recipe-unusable"
  | "directory-conflict"
  | "token-unknown"
  | "token-expired"
  | "token-spent"
  | "epoch-stale"
  | "scope-mismatch"
  | "stale-preview"
  | "unavailable"

export type SyncOutput =
  | SyncPrepareOk
  | SyncApplyOk
  | { ok: false; action: SyncAction | "unknown"; reason: SyncRejectReason; message: string }

// ---------------------------------------------------------------------------
// Definition constants
// ---------------------------------------------------------------------------

export const CONFIG_RPC_DEFINITION_ID = "opencode-forge-config"

export const CONFIG_RPC_METHODS = [
  "echo",
  "editOpen",
  "prepare",
  "commit",
  "receipt",
  "sync",
] as const

export type ConfigRpcMethod = (typeof CONFIG_RPC_METHODS)[number]

// ---------------------------------------------------------------------------
// JSON Schema fragments (plain JSON Schema values, no new dependency)
// ---------------------------------------------------------------------------

const scopeSchema = { type: "string", enum: ["workspace", "global"], description: "recipe scope" } as const

// JSON Schema type-array union: string or exact null (null sessionID = the
// home scope of the server-observed location at prepare, never a wildcard).
const sessionIDSchema = { type: ["string", "null"], description: "authoritative sessionID, or exactly null for the server-observed home scope" } as const

const fileIdentitySchema = {
  type: "object",
  properties: {
    mtimeMs: { type: "number" },
    size: { type: "integer" },
    // Canonical decimal strings — the canonical gate is src/file-identity.ts
    // normalizeFileIdentity server-side (unchanged). Plain type:string here:
    // Effect's wire schema validation runs with pattern matching disabled,
    // so a pattern on this field itself fails the response (invalid_output).
    // JSON-schema "integer" would run Number.isSafeInteger on the wire and
    // refuse every real-world inode above 2^53.
    dev: { type: "string" },
    ino: { type: "string" },
  },
  required: ["mtimeMs", "size"],
  additionalProperties: false,
} as const

const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] })

const findingSchema = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["warn", "error"] },
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["level", "code", "message"],
  additionalProperties: false,
} as const

const findingsSchema = { type: "array", items: findingSchema } as const

const entryDraftSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["auto", "pinned"], description: "Auto/Pinned is an atomic pair: auto removes model+thoughtLevel, pinned requires both" },
    model: { type: "string" },
    thoughtLevel: { type: "string" },
    prompt: { type: "string" },
    shape: { type: "string", enum: ["readonly", "write"] },
    permission: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["mode"],
  additionalProperties: false,
} as const

const opSchema = {
  type: "object",
  properties: {
    opId: { type: "string", description: "client correlation id, echoed per entry outcome" },
    action: { type: "string", enum: ["create", "update", "delete"] },
    kind: { type: "string", enum: ["worker", "override"] },
    id: { type: "string" },
    draft: entryDraftSchema,
    renameTo: { type: "string", description: "presence refuses the op — existing entry ids are immutable" },
    pool: { type: "string", description: "workspace worker creation on an absent file; one consistent pool per create-file batch" },
  },
  required: ["opId", "action", "kind", "id"],
  additionalProperties: false,
} as const

// Object schema helper: every request surface is additionalProperties:false
// (fail-closed — the protocol structurally refuses arbitrary fields).
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const parseErrorSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    line: { type: "integer" },
    column: { type: "integer" },
  },
  required: ["message"],
  additionalProperties: false,
} as const

const editOpenOkSchema = {
  type: "object",
  properties: {
    ok: { const: true },
    snapshotId: { type: "string" },
    path: { type: "string" },
    targetIdentity: { type: "string", description: "server-issued identity of the resolved binding — disclosed before confirmation and bound into the token" },
    scope: scopeSchema,
    sessionID: sessionIDSchema,
    observedLocation: nullable({ type: "string" }),
    anchor: nullable({ type: "string" }),
    epoch: { type: "string" },
    generation: { type: "integer" },
    expiresAt: { type: "number" },
    exists: { type: "boolean" },
    readable: { type: "boolean" },
    creatable: { type: "boolean" },
    identity: nullable(fileIdentitySchema),
    raw: nullable({ type: "string" }),
    document: { description: "parsed JSONC document (unknown JSON value), or null" },
    parseError: nullable(parseErrorSchema),
    findings: findingsSchema,
  },
  required: [
    "ok", "snapshotId", "path", "targetIdentity", "scope", "sessionID", "observedLocation", "anchor",
    "epoch", "generation", "expiresAt", "exists", "readable", "creatable",
    "identity", "raw", "document", "parseError", "findings",
  ],
  additionalProperties: false,
} as const

const editOpenErrSchema = obj(
  {
    ok: { const: false },
    reason: { type: "string", enum: ["scope-unresolved", "unavailable", "malformed-request"] },
    message: { type: "string" },
  },
  ["ok", "reason", "message"],
)

const previewEntrySchema = obj(
  {
    opId: { type: "string" },
    id: { type: "string" },
    kind: { type: "string", enum: ["worker", "override"] },
    action: { type: "string", enum: ["create", "update", "delete"] },
    entryKind: { type: "string", enum: ["create-file", "patch", "remove", "no-op"] },
    summary: { type: "array", items: { type: "string" } },
    findings: findingsSchema,
  },
  ["opId", "id", "kind", "action", "entryKind", "summary", "findings"],
)

const previewRejectedSchema = obj(
  {
    opId: { type: "string" },
    id: { type: "string" },
    reason: { type: "string" },
    message: { type: "string" },
    findings: findingsSchema,
  },
  ["opId", "id", "reason", "message", "findings"],
)

const previewSchema = obj(
  {
    path: { type: "string" },
    targetIdentity: { type: "string", description: "server-issued identity of the resolved binding (see editOpen)" },
    scope: scopeSchema,
    sessionID: sessionIDSchema,
    oldText: nullable({ type: "string" }),
    newText: { type: "string" },
    previewHash: { type: "string", description: "sha256 hex of newText — the canonical token content binding" },
    createFile: { type: "boolean", description: "derived from the edit-start snapshot (absent file), never from the last entry's plan kind" },
    identity: nullable(fileIdentitySchema),
    entries: { type: "array", items: previewEntrySchema },
    rejected: { type: "array", items: previewRejectedSchema },
  },
  ["path", "targetIdentity", "scope", "sessionID", "oldText", "newText", "previewHash", "createFile", "identity", "entries", "rejected"],
)

const prepareTokenSchema = obj(
  {
    token: { type: "string" },
    expiresAt: { type: "number" },
    epoch: { type: "string" },
    generation: { type: "integer" },
  },
  ["token", "expiresAt", "epoch", "generation"],
)

const prepareOkTokenSchema = obj(
  {
    ok: { const: true },
    outcome: { const: "token" },
    token: prepareTokenSchema,
    preview: previewSchema,
    findings: findingsSchema,
  },
  ["ok", "outcome", "token", "preview", "findings"],
)

const prepareOkNoopSchema = obj(
  {
    ok: { const: true },
    outcome: { const: "no-op" },
    summary: { type: "array", items: { type: "string" } },
    rejected: { type: "array", items: previewRejectedSchema },
    findings: findingsSchema,
  },
  ["ok", "outcome", "summary", "rejected", "findings"],
)

const prepareRejectReasons = [
  "snapshot-unknown", "snapshot-expired", "epoch-stale", "scope-mismatch",
  "scope-unresolved", "conflict-reload", "unreadable", "unparseable",
  "invalid-op", "invalid-id", "invalid-pool", "invalid-scope", "duplicate",
  "not-found", "ambiguous", "no-valid-entries", "malformed-request", "unavailable",
] as const

const commitEntryOutcomeSchema = obj(
  {
    opId: { type: "string" },
    id: { type: "string" },
    kind: { type: "string", enum: ["worker", "override"] },
    action: { type: "string", enum: ["create", "update", "delete"] },
    entryKind: { type: "string", enum: ["create-file", "patch", "remove", "no-op"] },
    outcome: { type: "string", enum: ["written", "no-op", "rejected"] },
    reason: { type: "string" },
    summary: { type: "array", items: { type: "string" } },
    findings: findingsSchema,
  },
  ["opId", "id", "kind", "action", "entryKind", "outcome", "summary", "findings"],
)

const commitReceiptSchema = {
  type: "object",
  properties: {
    commitId: { type: "string" },
    token: { type: "string" },
    outcome: {
      type: "string",
      enum: ["written", "no-op", "conflict", "ownership-lost", "write-failed", "missing", "unreadable", "unparseable"],
    },
    message: { type: "string" },
    path: { type: "string" },
    targetIdentity: { type: "string", description: "server-issued identity of the binding this receipt belongs to" },
    scope: scopeSchema,
    sessionID: sessionIDSchema,
    savedIdentity: nullable(fileIdentitySchema),
    bytes: { type: "integer", description: "real UTF-8 byte length of the published document" },
    entries: { type: "array", items: commitEntryOutcomeSchema },
    epoch: { type: "string" },
    generation: { type: "integer" },
    at: { type: "number" },
    sync: { anyOf: [{ type: "object" }, { type: "null" }], description: "server-side family-sync outcome slot (owned by the sync handlers); null until attached" },
  },
  required: [
    "commitId", "token", "outcome", "message", "path", "targetIdentity", "scope", "sessionID",
    "savedIdentity", "bytes", "entries", "epoch", "generation", "at",
  ],
  additionalProperties: true,
} as const

const commitRejectReasons = [
  "token-unknown", "token-expired", "token-spent", "epoch-stale",
  "scope-mismatch", "scope-unresolved", "confirm-required", "malformed-request", "unavailable",
] as const

const syncRosterRefSchema = obj(
  { nativeId: { type: "string" }, fileName: { type: "string" } },
  ["nativeId", "fileName"],
)

const syncErrorItemSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    nativeId: { type: "string" },
    fileName: { type: "string" },
  },
  required: ["message"],
  additionalProperties: false,
} as const

const syncConflictItemSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    nativeId: { type: "string" },
    fileName: { type: "string" },
    winnerFile: { type: "string" },
  },
  required: ["message"],
  additionalProperties: false,
} as const

// The sync projection preview — shared by the prepare token AND noop
// verdicts (a noop still discloses the full current projection; gc entries
// make a pure-delete sync a real planned change).
const syncPreviewSchema = obj(
  {
    path: { type: "string" },
    scope: scopeSchema,
    sessionID: sessionIDSchema,
    observedLocation: nullable({ type: "string" }),
    anchor: nullable({ type: "string" }),
    family: nullable(obj({ file: { type: "string" }, ns: { type: "string" }, materializedIds: { type: "array", items: { type: "string" } } }, ["file", "ns", "materializedIds"])),
    overridesIncluded: { type: "boolean" },
    files: { type: "array", items: obj({ nativeId: { type: "string" }, fileName: { type: "string" }, dest: { type: "string" }, op: { type: "string", enum: ["create", "update", "unchanged"] } }, ["nativeId", "fileName", "dest", "op"]) },
    gc: { type: "array", items: obj({ nativeId: { type: "string" }, dest: { type: "string" } }, ["nativeId", "dest"]) },
    coverage: { const: "full" },
    summary: { type: "array", items: { type: "string" } },
    findings: findingsSchema,
  },
  ["path", "scope", "sessionID", "observedLocation", "anchor", "family", "overridesIncluded", "files", "gc", "coverage", "summary", "findings"],
)

const syncRejectReasons = [
  "invalid-input", "scope-unresolved", "no-coverage", "recipe-unusable",
  "directory-conflict",
  "token-unknown", "token-expired", "token-spent", "epoch-stale",
  "scope-mismatch", "stale-preview", "unavailable",
] as const

// ---------------------------------------------------------------------------
// The static definition object (plain JSON Schema; statically bundled)
// ---------------------------------------------------------------------------

export const forgeConfigRpcDefinition = {
  id: CONFIG_RPC_DEFINITION_ID,
  methods: {
    echo: {
      input: obj({ nonce: { type: "string" } }, ["nonce"]),
      errors: {},
      output: obj(
        {
          nonce: { type: "string" },
          pluginID: { type: "string" },
          appVersion: { type: "string" },
          epoch: { type: "string", description: "current server epoch — observable for reconnect/epoch-change detection" },
          generation: { type: "integer", description: "current RPC registration generation" },
        },
        ["nonce", "pluginID", "appVersion", "epoch", "generation"],
      ),
    },
    editOpen: {
      input: obj({ scope: scopeSchema, sessionID: sessionIDSchema }, ["scope", "sessionID"]),
      errors: {},
      output: { anyOf: [editOpenOkSchema, editOpenErrSchema] },
    },
    prepare: {
      input: obj(
        {
          snapshotId: { type: "string" },
          scope: scopeSchema,
          sessionID: sessionIDSchema,
          ops: { type: "array", items: opSchema, maxItems: 32, description: "bounded previews: at most 32 ops (default cap; handler enforces its configured limit) and 262144 UTF-8 bytes per serialized draft" },
        },
        ["snapshotId", "scope", "sessionID", "ops"],
      ),
      errors: {},
      output: {
        anyOf: [
          prepareOkTokenSchema,
          prepareOkNoopSchema,
          obj({ ok: { const: false }, reason: { type: "string", enum: [...prepareRejectReasons] }, message: { type: "string" }, findings: findingsSchema }, ["ok", "reason", "message"]),
        ],
      },
    },
    commit: {
      input: obj(
        {
          token: { type: "string" },
          confirm: { type: "boolean", description: "must be EXACTLY true — explicit human confirmation (handler-enforced)" },
          scope: scopeSchema,
          sessionID: sessionIDSchema,
        },
        ["token", "confirm", "scope", "sessionID"],
      ),
      errors: {},
      output: {
        anyOf: [
          obj({ ok: { const: true }, receipt: commitReceiptSchema }, ["ok", "receipt"]),
          obj({ ok: { const: false }, reason: { type: "string", enum: [...commitRejectReasons] }, message: { type: "string" } }, ["ok", "reason", "message"]),
        ],
      },
    },
    receipt: {
      input: obj({ token: { type: "string" } }, ["token"]),
      errors: {},
      output: {
        anyOf: [
          obj({ found: { const: true }, receipt: commitReceiptSchema, epoch: { type: "string" }, generation: { type: "integer" } }, ["found", "receipt", "epoch", "generation"]),
          obj({ found: { const: false }, epoch: { type: "string" }, generation: { type: "integer" } }, ["found", "epoch", "generation"]),
        ],
      },
    },
    sync: {
      // ONE sync method, explicit action (no invented syncPrepare method).
      // prepare: confirm false + no token; apply: confirm true + token.
      // Unknown top-level fields are refused (additionalProperties: false).
      input: {
        type: "object",
        properties: {
          scope: scopeSchema,
          sessionID: sessionIDSchema,
          confirm: { type: "boolean" },
          action: { type: "string", enum: ["prepare", "apply"] },
          token: { type: "string", description: "required for apply (the prepared sync token); prepare must not carry one" },
          commitId: { type: "string", description: "optional apply-side correlation to the commit receipt" },
        },
        required: ["scope", "sessionID", "confirm", "action"],
        additionalProperties: false,
      },
      errors: {},
      output: {
        anyOf: [
          obj(
            {
              ok: { const: true },
              action: { const: "prepare" },
              outcome: { const: "token" },
              token: prepareTokenSchema,
              preview: syncPreviewSchema,
              findings: findingsSchema,
            },
            ["ok", "action", "outcome", "token", "preview", "findings"],
          ),
          obj(
            {
              ok: { const: true },
              action: { const: "prepare" },
              outcome: { const: "noop" },
              // A noop still carries the FULL preview (projection + gc) — the
              // UI shows current state even when nothing is to apply.
              preview: syncPreviewSchema,
              findings: findingsSchema,
            },
            ["ok", "action", "outcome", "preview", "findings"],
          ),
          {
            type: "object",
            properties: {
              ok: { const: true },
              action: { const: "apply" },
              outcome: { type: "string", enum: ["applied", "unconfirmed", "conflict", "refused", "noop"] },
              applied: { type: "boolean" },
              path: { type: "string" },
              scope: scopeSchema,
              sessionID: sessionIDSchema,
              created: { type: "array", items: syncRosterRefSchema },
              updated: { type: "array", items: syncRosterRefSchema },
              unchanged: { type: "array", items: { type: "string" } },
              gced: { type: "array", items: { type: "string" } },
              errors: { type: "array", items: syncErrorItemSchema },
              removedIds: { type: "array", items: { type: "string" } },
              appliedStatus: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["applied", "unconfirmed"] },
                  observedBy: nullable({ type: "string" }),
                  confirmedIds: { type: "array", items: { type: "string" } },
                  removedConfirmedIds: { type: "array", items: { type: "string" } },
                  unconfirmedIds: { type: "array", items: { type: "string" } },
                },
                required: ["status", "observedBy", "confirmedIds", "removedConfirmedIds", "unconfirmedIds"],
                additionalProperties: false,
              },
              conflicts: { type: "array", items: syncConflictItemSchema },
              summary: { type: "array", items: { type: "string" } },
              findings: findingsSchema,
              epoch: { type: "string" },
              generation: { type: "integer" },
              at: { type: "number" },
            },
            required: [
              "ok", "action", "outcome", "applied", "path", "scope", "sessionID",
              "created", "updated", "unchanged", "gced", "errors", "removedIds",
              "appliedStatus", "conflicts", "summary", "findings", "epoch", "generation", "at",
            ],
            additionalProperties: false,
          },
          obj(
            {
              ok: { const: false },
              action: { type: "string", enum: ["prepare", "apply", "unknown"] },
              reason: { type: "string", enum: [...syncRejectReasons] },
              message: { type: "string" },
            },
            ["ok", "action", "reason", "message"],
          ),
        ],
      },
    },
  },
  events: {},
} as const

export type ForgeConfigRpcDefinition = typeof forgeConfigRpcDefinition
