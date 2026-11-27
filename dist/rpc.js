// rpc.ts
var CONFIG_RPC_DEFINITION_ID = "opencode-forge-config";
var CONFIG_RPC_METHODS = [
  "echo",
  "editOpen",
  "prepare",
  "commit",
  "receipt",
  "sync"
];
var scopeSchema = { type: "string", enum: ["workspace", "global"], description: "recipe scope" };
var sessionIDSchema = { type: ["string", "null"], description: "authoritative sessionID, or exactly null for the server-observed home scope" };
var fileIdentitySchema = {
  type: "object",
  properties: {
    mtimeMs: { type: "number" },
    size: { type: "integer" },
    dev: { type: "string" },
    ino: { type: "string" }
  },
  required: ["mtimeMs", "size"],
  additionalProperties: false
};
var nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
var findingSchema = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["warn", "error"] },
    code: { type: "string" },
    message: { type: "string" }
  },
  required: ["level", "code", "message"],
  additionalProperties: false
};
var findingsSchema = { type: "array", items: findingSchema };
var entryDraftSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["auto", "pinned"], description: "Auto/Pinned is an atomic pair: auto removes model+thoughtLevel, pinned requires both" },
    model: { type: "string" },
    thoughtLevel: { type: "string" },
    prompt: { type: "string" },
    shape: { type: "string", enum: ["readonly", "write"] },
    permission: { type: "object", additionalProperties: { type: "string" } }
  },
  required: ["mode"],
  additionalProperties: false
};
var opSchema = {
  type: "object",
  properties: {
    opId: { type: "string", description: "client correlation id, echoed per entry outcome" },
    action: { type: "string", enum: ["create", "update", "delete"] },
    kind: { type: "string", enum: ["worker", "override"] },
    id: { type: "string" },
    draft: entryDraftSchema,
    renameTo: { type: "string", description: "presence refuses the op — existing entry ids are immutable" },
    pool: { type: "string", description: "workspace worker creation on an absent file; one consistent pool per create-file batch" }
  },
  required: ["opId", "action", "kind", "id"],
  additionalProperties: false
};
var obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var parseErrorSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    line: { type: "integer" },
    column: { type: "integer" }
  },
  required: ["message"],
  additionalProperties: false
};
var editOpenOkSchema = {
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
    findings: findingsSchema
  },
  required: [
    "ok",
    "snapshotId",
    "path",
    "targetIdentity",
    "scope",
    "sessionID",
    "observedLocation",
    "anchor",
    "epoch",
    "generation",
    "expiresAt",
    "exists",
    "readable",
    "creatable",
    "identity",
    "raw",
    "document",
    "parseError",
    "findings"
  ],
  additionalProperties: false
};
var editOpenErrSchema = obj({
  ok: { const: false },
  reason: { type: "string", enum: ["scope-unresolved", "unavailable", "malformed-request"] },
  message: { type: "string" }
}, ["ok", "reason", "message"]);
var previewEntrySchema = obj({
  opId: { type: "string" },
  id: { type: "string" },
  kind: { type: "string", enum: ["worker", "override"] },
  action: { type: "string", enum: ["create", "update", "delete"] },
  entryKind: { type: "string", enum: ["create-file", "patch", "remove", "no-op"] },
  summary: { type: "array", items: { type: "string" } },
  findings: findingsSchema
}, ["opId", "id", "kind", "action", "entryKind", "summary", "findings"]);
var previewRejectedSchema = obj({
  opId: { type: "string" },
  id: { type: "string" },
  reason: { type: "string" },
  message: { type: "string" },
  findings: findingsSchema
}, ["opId", "id", "reason", "message", "findings"]);
var previewSchema = obj({
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
  rejected: { type: "array", items: previewRejectedSchema }
}, ["path", "targetIdentity", "scope", "sessionID", "oldText", "newText", "previewHash", "createFile", "identity", "entries", "rejected"]);
var prepareTokenSchema = obj({
  token: { type: "string" },
  expiresAt: { type: "number" },
  epoch: { type: "string" },
  generation: { type: "integer" }
}, ["token", "expiresAt", "epoch", "generation"]);
var prepareOkTokenSchema = obj({
  ok: { const: true },
  outcome: { const: "token" },
  token: prepareTokenSchema,
  preview: previewSchema,
  findings: findingsSchema
}, ["ok", "outcome", "token", "preview", "findings"]);
var prepareOkNoopSchema = obj({
  ok: { const: true },
  outcome: { const: "no-op" },
  summary: { type: "array", items: { type: "string" } },
  rejected: { type: "array", items: previewRejectedSchema },
  findings: findingsSchema
}, ["ok", "outcome", "summary", "rejected", "findings"]);
var prepareRejectReasons = [
  "snapshot-unknown",
  "snapshot-expired",
  "epoch-stale",
  "scope-mismatch",
  "scope-unresolved",
  "conflict-reload",
  "unreadable",
  "unparseable",
  "invalid-op",
  "invalid-id",
  "invalid-pool",
  "invalid-scope",
  "duplicate",
  "not-found",
  "ambiguous",
  "no-valid-entries",
  "malformed-request",
  "unavailable"
];
var commitEntryOutcomeSchema = obj({
  opId: { type: "string" },
  id: { type: "string" },
  kind: { type: "string", enum: ["worker", "override"] },
  action: { type: "string", enum: ["create", "update", "delete"] },
  entryKind: { type: "string", enum: ["create-file", "patch", "remove", "no-op"] },
  outcome: { type: "string", enum: ["written", "no-op", "rejected"] },
  reason: { type: "string" },
  summary: { type: "array", items: { type: "string" } },
  findings: findingsSchema
}, ["opId", "id", "kind", "action", "entryKind", "outcome", "summary", "findings"]);
var commitReceiptSchema = {
  type: "object",
  properties: {
    commitId: { type: "string" },
    token: { type: "string" },
    outcome: {
      type: "string",
      enum: ["written", "no-op", "conflict", "ownership-lost", "write-failed", "missing", "unreadable", "unparseable"]
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
    sync: { anyOf: [{ type: "object" }, { type: "null" }], description: "server-side family-sync outcome slot (owned by the sync handlers); null until attached" }
  },
  required: [
    "commitId",
    "token",
    "outcome",
    "message",
    "path",
    "targetIdentity",
    "scope",
    "sessionID",
    "savedIdentity",
    "bytes",
    "entries",
    "epoch",
    "generation",
    "at"
  ],
  additionalProperties: true
};
var commitRejectReasons = [
  "token-unknown",
  "token-expired",
  "token-spent",
  "epoch-stale",
  "scope-mismatch",
  "scope-unresolved",
  "confirm-required",
  "malformed-request",
  "unavailable"
];
var syncRosterRefSchema = obj({ nativeId: { type: "string" }, fileName: { type: "string" } }, ["nativeId", "fileName"]);
var syncErrorItemSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    nativeId: { type: "string" },
    fileName: { type: "string" }
  },
  required: ["message"],
  additionalProperties: false
};
var syncConflictItemSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    nativeId: { type: "string" },
    fileName: { type: "string" },
    winnerFile: { type: "string" }
  },
  required: ["message"],
  additionalProperties: false
};
var syncPreviewSchema = obj({
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
  findings: findingsSchema
}, ["path", "scope", "sessionID", "observedLocation", "anchor", "family", "overridesIncluded", "files", "gc", "coverage", "summary", "findings"]);
var syncRejectReasons = [
  "invalid-input",
  "scope-unresolved",
  "no-coverage",
  "recipe-unusable",
  "directory-conflict",
  "token-unknown",
  "token-expired",
  "token-spent",
  "epoch-stale",
  "scope-mismatch",
  "stale-preview",
  "unavailable"
];
var forgeConfigRpcDefinition = {
  id: CONFIG_RPC_DEFINITION_ID,
  methods: {
    echo: {
      input: obj({ nonce: { type: "string" } }, ["nonce"]),
      errors: {},
      output: obj({
        nonce: { type: "string" },
        pluginID: { type: "string" },
        appVersion: { type: "string" },
        epoch: { type: "string", description: "current server epoch — observable for reconnect/epoch-change detection" },
        generation: { type: "integer", description: "current RPC registration generation" }
      }, ["nonce", "pluginID", "appVersion", "epoch", "generation"])
    },
    editOpen: {
      input: obj({ scope: scopeSchema, sessionID: sessionIDSchema }, ["scope", "sessionID"]),
      errors: {},
      output: { anyOf: [editOpenOkSchema, editOpenErrSchema] }
    },
    prepare: {
      input: obj({
        snapshotId: { type: "string" },
        scope: scopeSchema,
        sessionID: sessionIDSchema,
        ops: { type: "array", items: opSchema, maxItems: 32, description: "bounded previews: at most 32 ops (default cap; handler enforces its configured limit) and 262144 UTF-8 bytes per serialized draft" }
      }, ["snapshotId", "scope", "sessionID", "ops"]),
      errors: {},
      output: {
        anyOf: [
          prepareOkTokenSchema,
          prepareOkNoopSchema,
          obj({ ok: { const: false }, reason: { type: "string", enum: [...prepareRejectReasons] }, message: { type: "string" }, findings: findingsSchema }, ["ok", "reason", "message"])
        ]
      }
    },
    commit: {
      input: obj({
        token: { type: "string" },
        confirm: { type: "boolean", description: "must be EXACTLY true — explicit human confirmation (handler-enforced)" },
        scope: scopeSchema,
        sessionID: sessionIDSchema
      }, ["token", "confirm", "scope", "sessionID"]),
      errors: {},
      output: {
        anyOf: [
          obj({ ok: { const: true }, receipt: commitReceiptSchema }, ["ok", "receipt"]),
          obj({ ok: { const: false }, reason: { type: "string", enum: [...commitRejectReasons] }, message: { type: "string" } }, ["ok", "reason", "message"])
        ]
      }
    },
    receipt: {
      input: obj({ token: { type: "string" } }, ["token"]),
      errors: {},
      output: {
        anyOf: [
          obj({ found: { const: true }, receipt: commitReceiptSchema, epoch: { type: "string" }, generation: { type: "integer" } }, ["found", "receipt", "epoch", "generation"]),
          obj({ found: { const: false }, epoch: { type: "string" }, generation: { type: "integer" } }, ["found", "epoch", "generation"])
        ]
      }
    },
    sync: {
      input: {
        type: "object",
        properties: {
          scope: scopeSchema,
          sessionID: sessionIDSchema,
          confirm: { type: "boolean" },
          action: { type: "string", enum: ["prepare", "apply"] },
          token: { type: "string", description: "required for apply (the prepared sync token); prepare must not carry one" },
          commitId: { type: "string", description: "optional apply-side correlation to the commit receipt" }
        },
        required: ["scope", "sessionID", "confirm", "action"],
        additionalProperties: false
      },
      errors: {},
      output: {
        anyOf: [
          obj({
            ok: { const: true },
            action: { const: "prepare" },
            outcome: { const: "token" },
            token: prepareTokenSchema,
            preview: syncPreviewSchema,
            findings: findingsSchema
          }, ["ok", "action", "outcome", "token", "preview", "findings"]),
          obj({
            ok: { const: true },
            action: { const: "prepare" },
            outcome: { const: "noop" },
            preview: syncPreviewSchema,
            findings: findingsSchema
          }, ["ok", "action", "outcome", "preview", "findings"]),
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
                  unconfirmedIds: { type: "array", items: { type: "string" } }
                },
                required: ["status", "observedBy", "confirmedIds", "removedConfirmedIds", "unconfirmedIds"],
                additionalProperties: false
              },
              conflicts: { type: "array", items: syncConflictItemSchema },
              summary: { type: "array", items: { type: "string" } },
              findings: findingsSchema,
              epoch: { type: "string" },
              generation: { type: "integer" },
              at: { type: "number" }
            },
            required: [
              "ok",
              "action",
              "outcome",
              "applied",
              "path",
              "scope",
              "sessionID",
              "created",
              "updated",
              "unchanged",
              "gced",
              "errors",
              "removedIds",
              "appliedStatus",
              "conflicts",
              "summary",
              "findings",
              "epoch",
              "generation",
              "at"
            ],
            additionalProperties: false
          },
          obj({
            ok: { const: false },
            action: { type: "string", enum: ["prepare", "apply", "unknown"] },
            reason: { type: "string", enum: [...syncRejectReasons] },
            message: { type: "string" }
          }, ["ok", "action", "reason", "message"])
        ]
      }
    }
  },
  events: {}
};
export {
  forgeConfigRpcDefinition,
  CONFIG_RPC_METHODS,
  CONFIG_RPC_DEFINITION_ID
};
