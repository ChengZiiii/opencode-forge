import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// forge-tui-subagent-config — REAL WIRE SCHEMA tests: every output the
// protocol actually emits (kernel handlers, and the frozen sync contract
// shapes whose handler lives server-side) must validate against the frozen
// JSON Schema definition (rpc.ts forgeConfigRpcDefinition).
//
// VALIDATOR NOTE (evidence, 2026-11-27): node_modules/json-schema@0.4.0 is
// draft-03-era and PROVABLY cannot evaluate this definition — it answers
// valid:true for const/enum/anyOf/additionalProperties violations
// (probe: validate({a:1,b:2},{anyOf:[{type:"object",properties:{a:{const:1}},required:["a"],additionalProperties:false}]})
// → valid:true). Its "passes" are vacuous. The definition uses exactly a
// draft-06 SUBSET (type / const / enum / required / properties / items /
// additionalProperties:false / anyOf), so this TEST-ONLY file carries a
// compact evaluator for that subset. It is not a production dependency and
// never substitutes handwritten shapes for actual handler output — it only
// adjudicates real instances against the frozen schema.
//
// Contract anchors (coordinator rulings 2026-11-27):
//   - sync prepare noop carries the FULL preview + findings, NEVER a bare
//     summary (ruling A).
//   - sync apply wire items stay STRUCTURED (created/updated {nativeId,
//     fileName}; unchanged string[]; errors/conflicts objects) — the server
//     converts the compiler's internal string arrays to these wire shapes
//     (ruling B-E: the shared types do NOT drift to raw strings).
//   - "directory-conflict" is a sync reject reason (ruling F, additive).
//   - preview carries required gc entries; a pure-delete sync is a real
//     planned change.
//   - additionalProperties stays FALSE everywhere — an extra field is a
//     refusal, never silently accepted.

import { forgeConfigRpcDefinition, CONFIG_RPC_DEFINITION_ID, CONFIG_RPC_METHODS } from "../rpc.ts"
import { createConfigRpcStore } from "../src/config-rpc-protocol.ts"

// Draft-06 subset evaluator — returns a list of error strings ([] = valid).
function wireValidate(instance, schema, at = "$") {
  const errs = []
  const typeOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v
  const typeOk = (v, t) => {
    const got = typeOf(v)
    const want = Array.isArray(t) ? t : [t]
    return want.some((x) => x === got || (x === "number" && got === "integer")) // draft-06: integer ⊂ number
  }
  if (schema.const !== undefined && JSON.stringify(instance) !== JSON.stringify(schema.const)) {
    errs.push(`${at}: const mismatch (expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)})`)
  }
  if (schema.enum !== undefined && !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(instance))) {
    errs.push(`${at}: enum miss (got ${JSON.stringify(instance)})`)
  }
  if (schema.type !== undefined && !typeOk(instance, schema.type)) {
    errs.push(`${at}: type ${JSON.stringify(schema.type)} required, got ${typeOf(instance)}`)
    return errs // structural checks below need the right shape
  }
  if (Array.isArray(instance) && schema.items !== undefined) {
    instance.forEach((item, i) => errs.push(...wireValidate(item, schema.items, `${at}[${i}]`)))
  }
  if (instance !== null && typeof instance === "object" && !Array.isArray(instance)) {
    for (const key of schema.required ?? []) {
      if (!(key in instance)) errs.push(`${at}: missing required "${key}"`)
    }
    for (const [key, value] of Object.entries(instance)) {
      const sub = schema.properties?.[key]
      if (sub === undefined) {
        if (schema.additionalProperties === false) errs.push(`${at}: additional property "${key}" refused (additionalProperties:false)`)
        continue
      }
      errs.push(...wireValidate(value, sub, `${at}.${key}`))
    }
  }
  if (schema.anyOf !== undefined) {
    const branchErrs = schema.anyOf.map((branch) => wireValidate(instance, branch, at))
    if (!branchErrs.some((e) => e.length === 0)) {
      errs.push(`${at}: no anyOf branch matched — ${branchErrs.map((e, i) => `branch${i}: ${e.slice(0, 3).join("; ")}`).join(" | ")}`)
    }
  }
  return errs
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// ---------------------------------------------------------------------------
// Kernel harness (real tempdir + fake clock/resolver) — REAL outputs only
// ---------------------------------------------------------------------------

function makeEnv() {
  let idCounter = 0
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-wire-schema-"))
  const globalDir = path.join(root, "home", ".config", "opencode")
  fs.mkdirSync(globalDir, { recursive: true })
  const GLOBAL_FILE = path.join(globalDir, "forge.jsonc")
  fs.writeFileSync(GLOBAL_FILE, '{\n  "agents": {\n    "util": { "prompt": "old prompt" }\n  }\n}\n', "utf8")
  const epochState = { epoch: "ep-1", generation: 3 }
  const deps = {
    clock: () => 1000,
    randomId: () => `id-${++idCounter}`,
    hash: sha256,
    epoch: () => ({ ...epochState }),
    ttlMs: { snapshot: 600000, token: 60000, receipt: 60000 },
    resolver() {
      return { ok: true, target: { path: GLOBAL_FILE, observedLocation: GLOBAL_FILE, anchor: null, creatable: true } }
    },
  }
  const store = createConfigRpcStore(deps)
  return {
    root, GLOBAL_FILE,
    rpc: store.handlers({ pluginID: "forge", appVersion: "2.4.2" }),
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} },
  }
}

const wireErrors = (methodName, output) => wireValidate(output, forgeConfigRpcDefinition.methods[methodName].output)

const checkWire = (methodName, output) => {
  const errs = wireErrors(methodName, output)
  assert.deepEqual(errs, [], `${methodName} wire output must validate against the frozen schema — got:\n${errs.join("\n")}`)
}

// A real ok path through the whole commit protocol: echo → editOpen →
// prepare(token) → commit(written) → receipt(found), each output validated.
test("real kernel outputs validate against the frozen wire schemas (echo/editOpen/prepare/commit/receipt)", async () => {
  const env = makeEnv()
  try {
    checkWire("echo", await env.rpc.echo({ nonce: "n-1" }))
    const ed = await env.rpc.editOpen({ scope: "global", sessionID: null })
    checkWire("editOpen", ed)
    const p = await env.rpc.prepare({
      snapshotId: ed.snapshotId, scope: "global", sessionID: null,
      ops: [{ opId: "o1", action: "update", kind: "worker", id: "util", draft: { mode: "pinned", model: "prov/new", thoughtLevel: "high" } }],
    })
    checkWire("prepare", p)
    assert.equal(p.outcome, "token", "harness sanity: the real prepare issues a token")
    const c = await env.rpc.commit({ token: p.token.token, confirm: true, scope: "global", sessionID: null })
    checkWire("commit", c)
    assert.equal(c.receipt.outcome, "written", "harness sanity: the real commit writes")
    checkWire("receipt", await env.rpc.receipt({ token: p.token.token }))
  } finally {
    env.cleanup()
  }
})

// Real REFUSAL outputs validate too (the anyOf failure branches are part of
// the wire contract, not an afterthought).
test("real kernel refusal outputs validate (confirm-required, token-unknown, malformed-request)", async () => {
  const env = makeEnv()
  try {
    const refusedConfirm = await env.rpc.commit({ token: "whatever", confirm: false, scope: "global", sessionID: null })
    checkWire("commit", refusedConfirm)
    const refusedUnknown = await env.rpc.commit({ token: "whatever", confirm: true, scope: "global", sessionID: null })
    checkWire("commit", refusedUnknown)
    assert.equal(refusedUnknown.reason, "token-unknown")
    const malformed = await env.rpc.prepare({
      snapshotId: "x", scope: "global", sessionID: null,
      ops: [], smuggled: "field",
    })
    checkWire("prepare", malformed)
    assert.equal(malformed.reason, "malformed-request")
  } finally {
    env.cleanup()
  }
})

test("the definition itself stays closed: every method input is an additionalProperties:false object", () => {
  assert.equal(CONFIG_RPC_DEFINITION_ID, "opencode-forge-config")
  for (const name of CONFIG_RPC_METHODS) {
    const input = forgeConfigRpcDefinition.methods[name].input
    assert.equal(input.type, "object", `${name}.input`)
    assert.equal(input.additionalProperties, false, `${name}.input must refuse unknown fields`)
    assert.ok(Array.isArray(input.required) && input.required.length > 0, `${name}.input has required fields`)
  }
})

// ---------------------------------------------------------------------------
// Sync wire shapes (frozen contract; the handler is server-owned)
// ---------------------------------------------------------------------------

const previewRow = { nativeId: "forge-alpha", fileName: "forge-alpha.md", dest: "C:/w/agents/forge-alpha.md", op: "update" }
const gcRow = { nativeId: "forge-old", dest: "C:/w/agents/forge-old.md" }
const finding = { level: "warn", code: "c", message: "m" }
const syncPreview = {
  path: "C:/r/pool.md",
  scope: "global",
  sessionID: null,
  observedLocation: "C:/loc",
  anchor: null,
  family: { file: "C:/r/pool.md", ns: "alpha", materializedIds: ["alpha"] },
  overridesIncluded: true,
  files: [previewRow],
  gc: [gcRow],
  coverage: "full",
  summary: ["update: C:/w/agents/forge-alpha.md"],
  findings: [finding],
}

const checkSyncWire = (output) => {
  const errs = wireErrors("sync", output)
  assert.deepEqual(errs, [], `sync wire output must validate against the frozen schema — got:\n${errs.join("\n")}`)
}
const expectSyncRefused = (output, why) => {
  const errs = wireErrors("sync", output)
  assert.ok(errs.length > 0, `the schema must refuse this drift: ${why}`)
}

test("sync prepare/token with the full preview incl. gc validates (gc is required additive)", () => {
  checkSyncWire({
    ok: true, action: "prepare", outcome: "token",
    token: { token: "synctok-1", expiresAt: 2000, epoch: "ep-1", generation: 3 },
    preview: syncPreview,
    findings: [finding],
  })
  expectSyncRefused(
    { ok: true, action: "prepare", outcome: "token", token: { token: "t", expiresAt: 1, epoch: "e", generation: 1 }, preview: { ...syncPreview, gc: undefined }, findings: [] },
    "a preview without gc is not the frozen shape (pure-delete syncs are real planned changes)",
  )
})

test("sync prepare/noop carries preview + findings and NEVER a bare summary (ruling A)", () => {
  checkSyncWire({ ok: true, action: "prepare", outcome: "noop", preview: syncPreview, findings: [finding] })
  expectSyncRefused(
    { ok: true, action: "prepare", outcome: "noop", summary: ["nothing to do"], findings: [finding] },
    "noop with a bare summary (old draft shape) — the frozen noop carries the full preview",
  )
  expectSyncRefused(
    { ok: true, action: "prepare", outcome: "noop", preview: syncPreview, summary: ["x"], findings: [] },
    "noop smuggling an extra summary field — additionalProperties stays closed",
  )
})

test("sync apply keeps STRUCTURED wire items (ruling B-E: server converts compiler strings)", () => {
  checkSyncWire({
    ok: true, action: "apply", outcome: "applied", applied: true,
    path: "C:/r/pool.md", scope: "global", sessionID: null,
    created: [{ nativeId: "forge-beta", fileName: "forge-beta.md" }],
    updated: [{ nativeId: "forge-alpha", fileName: "forge-alpha.md" }],
    unchanged: ["C:/w/agents/forge-keep.md"],
    gced: ["C:/w/agents/forge-old.md"],
    errors: [{ message: "C:/w/agents/forge-x.md: boom", nativeId: "forge-x", fileName: "forge-x.md" }],
    removedIds: ["forge-old"],
    appliedStatus: { status: "applied", observedBy: "host-agent-list", confirmedIds: ["forge-alpha", "forge-beta"], removedConfirmedIds: ["forge-old"], unconfirmedIds: [] },
    conflicts: [{ message: "winner flip", nativeId: "forge-y", winnerFile: "C:/r/other.md" }],
    summary: ["created: C:/w/agents/forge-beta.md"],
    findings: [finding],
    epoch: "ep-1", generation: 3, at: 2000,
  })
  // The compiler's INTERNAL string arrays are refused on the wire — the
  // server must convert, the shared types never drift to raw strings.
  expectSyncRefused(
    { ...structuredApplyBase(), created: ["C:/w/agents/forge-beta.md"], updated: ["C:/w/agents/forge-alpha.md"] },
    "created/updated as raw dest strings",
  )
  expectSyncRefused({ ...structuredApplyBase(), unchanged: 2 }, "unchanged as a count number")
  expectSyncRefused({ ...structuredApplyBase(), errors: ["C:/w/x.md: boom"] }, "errors as raw strings")
  expectSyncRefused({ ...structuredApplyBase(), conflicts: ["winner flip"] }, "conflicts as raw strings")
  expectSyncRefused({ ...structuredApplyBase(), smuggled: true }, "apply with an extra top-level field")
})

function structuredApplyBase() {
  return {
    ok: true, action: "apply", outcome: "unconfirmed", applied: false,
    path: "C:/r/pool.md", scope: "global", sessionID: null,
    created: [], updated: [], unchanged: [], gced: [], errors: [],
    removedIds: [],
    appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [] },
    conflicts: [], summary: [], findings: [],
    epoch: "ep-1", generation: 3, at: 2000,
  }
}

test("sync refusal shapes: directory-conflict is a valid reason; unknown reasons are refused (ruling F)", () => {
  checkSyncWire({ ok: false, action: "prepare", reason: "directory-conflict", message: "unselected family shares the artifact directory" })
  checkSyncWire({ ok: false, action: "unknown", reason: "invalid-input", message: "bad" })
  expectSyncRefused({ ok: false, action: "prepare", reason: "made-up-reason", message: "x" }, "reason outside the frozen enum")
})
