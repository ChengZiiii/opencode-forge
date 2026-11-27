import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — contract tests for the write-guard decision
// layer (design D2; landed src/host-guard.ts). Spec: active/samehost gates
// fail closed — every unknown refuses with a reason, never a guess.

import {
  forgeServerEnablement, writesPermitted, sameHostVerdict, connectedLoopbackOf,
  nonceToken, nonceSufficient, normalizeAgentRows, normalizeAgentRowsDetailed, observeRegistration,
} from "../src/host-guard.ts"

const ACTIVE_ROW = { id: "forge", features: { server: true, tui: true }, state: { status: "active" } }

// ---------------------------------------------------------------------------
// forgeServerEnablement / writesPermitted
// ---------------------------------------------------------------------------

test("enablement: active row with features.server=true permits writes", () => {
  const e = forgeServerEnablement([ACTIVE_ROW, { id: "other" }])
  assert.deepEqual(e, { state: "active-observed" })
  assert.equal(writesPermitted(e), true)
})

test("enablement: absent row refuses (fail closed)", () => {
  const e = forgeServerEnablement([{ id: "other" }])
  assert.equal(e.state, "absent")
  assert.equal(writesPermitted(e), false)
})

test("enablement: failed row refuses and carries the error", () => {
  const e = forgeServerEnablement([{ id: "forge", features: { server: true }, state: { status: "failed", error: "boom" } }])
  assert.equal(e.state, "failed")
  assert.equal(e.error, "boom")
  assert.equal(writesPermitted(e), false)
})

test("enablement: non-array observation is unverifiable, never a guess", () => {
  const e = forgeServerEnablement(null)
  assert.equal(e.state, "unverifiable")
  assert.match(e.reason, /expected an array/)
})

test("enablement: ambiguous duplicate rows refuse", () => {
  const e = forgeServerEnablement([ACTIVE_ROW, { ...ACTIVE_ROW }])
  assert.equal(e.state, "unverifiable")
  assert.match(e.reason, /2 registry rows/)
})

test("enablement: missing features.server or wrong status is unverifiable", () => {
  assert.equal(forgeServerEnablement([{ id: "forge", state: { status: "active" } }]).state, "unverifiable")
  assert.equal(forgeServerEnablement([{ id: "forge", features: { server: false }, state: { status: "active" } }]).state, "unverifiable")
  assert.equal(forgeServerEnablement([{ id: "forge", features: { server: true } }]).state, "unverifiable", "missing status cannot verify")
  assert.equal(writesPermitted({ state: "unverifiable", reason: "x" }), false)
})

test("enablement: server-disabled forge while TUI loaded refuses writes (disabled/unverifiable gate)", () => {
  // The only native off-switch is removal: an active row is required, and
  // anything else (absent/failed/unverifiable) blocks saves and syncs.
  for (const rows of [[], null, [{ id: "forge" }], [{ id: "forge", features: { server: true }, state: { status: "unknown" } }]]) {
    assert.equal(writesPermitted(forgeServerEnablement(rows)), false, JSON.stringify(rows))
  }
})

// ---------------------------------------------------------------------------
// sameHostVerdict (loopback + hostname + seam pid + process identity)
// ---------------------------------------------------------------------------

function seamOf({ supported = true, pid = 4242, name = "opencode.exe", identitySupported = true, identity } = {}) {
  return {
    listeningPidOf: () => ({ pid: supported ? pid : null, supported }),
    processIdentity: () => identity ?? { name: identitySupported ? name : null, supported: identitySupported },
  }
}
const HAPPY = {
  api: { pid: 4242, hostname: "box", urls: ["http://10.9.9.9:1"] },
  local: { hostname: "box" },
  connectedBaseUrl: "http://127.0.0.1:4096",
}

test("sameHost: all legs verified -> writable", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf() })
  assert.equal(v.writable, true)
  assert.ok(v.reasons.some((r) => /loopback/.test(r)))
  assert.ok(v.reasons.some((r) => /matches/.test(r)))
})

test("sameHost: missing api pid or hostname refuses", () => {
  assert.equal(sameHostVerdict({ ...HAPPY, api: { ...HAPPY.api, pid: null }, seam: seamOf() }).writable, false)
  assert.equal(sameHostVerdict({ ...HAPPY, api: { ...HAPPY.api, hostname: null }, seam: seamOf() }).writable, false)
})

test("sameHost: non-loopback connectedBaseUrl refuses", () => {
  const v = sameHostVerdict({ ...HAPPY, connectedBaseUrl: "http://10.0.0.5:4096", seam: seamOf() })
  assert.equal(v.writable, false)
  assert.match(v.reason, /loopback/)
})

test("sameHost: missing connectedBaseUrl refuses EVEN IF api.urls announces a loopback URL", () => {
  for (const cb of [undefined, null, ""]) {
    const v = sameHostVerdict({ ...HAPPY, api: { pid: 4242, hostname: "box", urls: ["http://127.0.0.1:4096"] }, connectedBaseUrl: cb, seam: seamOf() })
    assert.equal(v.writable, false, `connectedBaseUrl=${JSON.stringify(cb)} must refuse`)
    assert.match(v.reason, /connected base URL|connectedBaseUrl/)
  }
})

test("sameHost: hostname mismatch (remote attachment) refuses", () => {
  const v = sameHostVerdict({ ...HAPPY, local: { hostname: "other-box" }, seam: seamOf() })
  assert.equal(v.writable, false)
  assert.match(v.reason, /hostname mismatch/)
})

test("sameHost: unsupported platform seam fails closed", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ supported: false }) })
  assert.equal(v.writable, false)
  assert.match(v.reason, /fail closed/)
})

test("sameHost: no local listener on the port refuses (server not on this machine)", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: { listeningPidOf: () => ({ pid: null, supported: true }), processIdentity: () => ({ name: "x", supported: true }) } })
  assert.equal(v.writable, false)
  assert.match(v.reason, /no local listener/)
})

test("sameHost: listener pid != api pid refuses (ownership unproven)", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ pid: 999 }) })
  assert.equal(v.writable, false)
  assert.match(v.reason, /does not match the API pid/)
})

test("sameHost: unidentifiable or non-opencode process refuses", () => {
  assert.equal(sameHostVerdict({ ...HAPPY, seam: seamOf({ identitySupported: false }) }).writable, false)
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ name: "chrome.exe" }) })
  assert.equal(v.writable, false)
  assert.match(v.reason, /not the opencode server/)
})

test("sameHost: URL userinfo trick in connectedBaseUrl (127.0.0.1:1000@remote.example) is NOT loopback — refuses", () => {
  const v = sameHostVerdict({ ...HAPPY, connectedBaseUrl: "http://127.0.0.1:1000@remote.example/", seam: seamOf() })
  assert.equal(v.writable, false, "a userinfo-prefixed URL must not be treated as a loopback endpoint")
  assert.match(v.reason, /userinfo/)
})

test("connectedLoopbackOf: exact-literal loopback only — trailing dot, 0.0.0.0, 127.0.0.2, mapped IPv6 refuse", () => {
  for (const bad of ["http://localhost./4096", "http://0.0.0.0:4096", "http://127.0.0.2:4096", "http://[::ffff:127.0.0.1]:4096", "ftp://127.0.0.1", "127.0.0.1:4096", "not a url"]) {
    assert.equal(connectedLoopbackOf(bad).ok, false, `${bad} must not pass`)
  }
  const ok = connectedLoopbackOf("http://localhost:4096")
  assert.ok(ok.ok)
  assert.equal(ok.ok ? ok.endpoint.port : -1, 4096)
})

test("sameHost: an opencode CLIENT helper process cannot serve the API — refuses", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ name: "opencode-client-helper" }) })
  assert.equal(v.writable, false, "a client-side helper matching /opencode/ loosely must not count as the server")
})

test("sameHost: official `opencode(.exe) serve` passes on the executable leg", () => {
  assert.equal(sameHostVerdict({ ...HAPPY, seam: seamOf({ name: "C:\\tools\\opencode.exe serve" }) }).writable, true)
  assert.equal(
    sameHostVerdict({ ...HAPPY, seam: seamOf({ identity: { supported: true, executable: "C:\\tools\\opencode.exe", args: ["serve"] } }) }).writable,
    true,
  )
})

test("sameHost: script wrapper passes ONLY with an explicit wrapper executable + the exact opencode entry in the args", () => {
  assert.equal(
    sameHostVerdict({ ...HAPPY, seam: seamOf({ identity: { supported: true, executable: "C:\\node\\node.exe", args: ["C:\\app\\opencode.mjs", "serve"] } }) }).writable,
    true,
    "node wrapper carrying opencode.mjs is commandline-verified",
  )
})

// P1 independent-review regressions (coder3300): spoofed wrappers and
// name/args mismatches must fail closed.
test("sameHost P1: node.exe running observer.js --watch opencode.js is NOT the server — refuses", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ identity: { supported: true, args: ["node.exe", "observer.js", "--watch", "opencode.js"] } }) })
  assert.equal(v.writable, false, "an unrelated node script whose args merely mention opencode.js must not pass")
})

test("sameHost P1: executable other.exe whose args list opencode.exe is NOT the server — refuses", () => {
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ identity: { supported: true, args: ["other.exe", "opencode.exe"] } }) })
  assert.equal(v.writable, false, "a non-opencode executable launching opencode as a CHILD-ARG pattern must not pass")
})

test("sameHost: the port checked is the CONNECTED base URL's port, never api.urls", () => {
  const seen = []
  const seam = {
    listeningPidOf: (port) => { seen.push(port); return { pid: 4242, supported: true } },
    processIdentity: () => ({ name: "opencode.exe", supported: true }),
  }
  sameHostVerdict({ ...HAPPY, api: { pid: 4242, hostname: "box", urls: ["http://10.9.9.9:7777", "http://localhost:9999"] }, connectedBaseUrl: "http://localhost:4096", seam })
  assert.deepEqual(seen, [4096], "the seam must probe the connected endpoint's port only")
})

// ---------------------------------------------------------------------------
// Registration observation — observable-field discipline
// ---------------------------------------------------------------------------

test("observeRegistration: Auto expectation (model null) against a row still carrying the old pin is unconfirmed", () => {
  const before = normalizeAgentRows([{ id: "forge-proj-w", description: "d", model: { providerID: "prov", modelID: "old" } }])
  const after = normalizeAgentRows([{ id: "forge-proj-w", description: "d", model: { providerID: "prov", modelID: "old" } }])
  const o = observeRegistration(before, after, { id: "forge-proj-w", expect: "present", model: null })
  assert.equal(o.kind, "unconfirmed", "Auto conversion removes the pin — a registry row still carrying the old model is NOT applied")
  assert.match(o.detail, /model/)
})

test("observeRegistration: a changed description alone confirms; unchanged observable fields on an update do not", () => {
  const before = normalizeAgentRows([{ id: "w", description: "old" }])
  const same = normalizeAgentRows([{ id: "w", description: "old" }])
  assert.equal(observeRegistration(before, same, { id: "w", expect: "present", description: "old" }).kind, "confirmed", "fields already current after a confirmed prior observation")
  // prompt/permission are NOT observable registry fields: an edit that only
  // changed them leaves every observable field identical, so application
  // must stay unconfirmed rather than silently 'confirmed'.
  const o = observeRegistration(before, same, { id: "w", expect: "present" })
  assert.equal(o.kind, "unconfirmed", "no observable field evidence — an update cannot be reported applied")
})

// ---------------------------------------------------------------------------
// Nonce proof
// ---------------------------------------------------------------------------

test("nonce: sufficient only when written, read back exactly, and cleaned", () => {
  const token = nonceToken(123)
  assert.match(token, /^forge-samehost-123-/)
  assert.equal(nonceSufficient({ token, written: true, readBack: token, cleaned: true }), true)
  assert.equal(nonceSufficient({ token, written: true, readBack: token, cleaned: false }), false)
  assert.equal(nonceSufficient({ token, written: true, readBack: "other", cleaned: true }), false)
  assert.equal(nonceSufficient({ token, written: false, readBack: token, cleaned: true }), false)
})

// ---------------------------------------------------------------------------
// Registration observation (applied status needs CHANGED fields, not just an id)
// ---------------------------------------------------------------------------

test("agent rows: shape drift tolerated, id mandatory, model normalized", () => {
  const rows = normalizeAgentRows([
    { id: "forge-a-b", description: "d", model: { id: "claude-opus-4-6", providerID: "anthropic" } },
    { id: "forge-c-d" },
    { nope: 1 },
    null,
    "junk",
  ])
  assert.deepEqual(rows, [
    { id: "forge-a-b", description: "d", model: { providerID: "anthropic", modelID: "claude-opus-4-6" } },
    { id: "forge-c-d", description: null, model: null },
  ])
  assert.deepEqual(normalizeAgentRows(null), [])
})

test("observeRegistration: create confirmed when the row appears", () => {
  const before = []
  const after = normalizeAgentRows([{ id: "forge-proj-scout", description: "d" }])
  const o = observeRegistration(before, after, { id: "forge-proj-scout", expect: "present" })
  assert.equal(o.kind, "confirmed")
  assert.match(o.detail, /newly registered/)
})

test("observeRegistration: update with unchanged fields is NOT confirmed by id presence alone", () => {
  const before = normalizeAgentRows([{ id: "forge-proj-scout", description: "old", model: { providerID: "anthropic", modelID: "old-model" } }])
  const after = normalizeAgentRows([{ id: "forge-proj-scout", description: "old", model: { providerID: "anthropic", modelID: "old-model" } }])
  const o = observeRegistration(before, after, { id: "forge-proj-scout", expect: "present", model: { providerID: "anthropic", modelID: "new-model" } })
  assert.equal(o.kind, "unconfirmed")
  assert.match(o.detail, /do not yet match/)
})

test("observeRegistration: update confirmed when observable fields change", () => {
  const before = normalizeAgentRows([{ id: "forge-proj-scout", description: "old", model: { providerID: "anthropic", modelID: "old-model" } }])
  const after = normalizeAgentRows([{ id: "forge-proj-scout", description: "old", model: { providerID: "anthropic", modelID: "new-model" } }])
  const o = observeRegistration(before, after, { id: "forge-proj-scout", expect: "present", model: { providerID: "anthropic", modelID: "new-model" } })
  assert.equal(o.kind, "confirmed")
  assert.match(o.detail, /changed fields: model/)
})

test("observeRegistration: removal confirmed only when the row is gone", () => {
  const before = normalizeAgentRows([{ id: "forge-proj-scout", description: "d" }])
  assert.equal(observeRegistration(before, [], { id: "forge-proj-scout", expect: "absent" }).kind, "confirmed")
  const still = observeRegistration(before, before, { id: "forge-proj-scout", expect: "absent" })
  assert.equal(still.kind, "unconfirmed")
  assert.match(still.detail, /still registered/)
})

test("observeRegistration: unreadable registry is unconfirmed (unknown application status)", () => {
  const o = observeRegistration([], null, { id: "x", expect: "present" })
  assert.equal(o.kind, "unconfirmed")
  assert.match(o.detail, /unreadable/)
})

test("observeRegistration: expected row absent from after is unconfirmed", () => {
  const o = observeRegistration([], normalizeAgentRows([{ id: "other" }]), { id: "forge-proj-scout", expect: "present" })
  assert.equal(o.kind, "unconfirmed")
})

test("observeRegistration: description mismatch is unconfirmed", () => {
  const before = normalizeAgentRows([{ id: "w", description: "old" }])
  const after = normalizeAgentRows([{ id: "w", description: "old" }])
  const o = observeRegistration(before, after, { id: "w", expect: "present", description: "compiled output" })
  assert.equal(o.kind, "unconfirmed")
  assert.match(o.detail, /description/)
})

// ---------------------------------------------------------------------------
// normalizeAgentRowsDetailed (strict surface): structured failure vs row junk
// ---------------------------------------------------------------------------

test("normalizeDetailed: non-array body is a STRUCTURED failure, never an empty registry", () => {
  for (const bad of [null, undefined, {}, "rows", 42]) {
    const r = normalizeAgentRowsDetailed(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    if (!r.ok) assert.match(r.reason, /not an array/)
  }
  assert.deepEqual(normalizeAgentRows(null), [], "legacy lenient surface stays [] (compat only)")
})

test("normalizeDetailed: junk-ONLY body is a structured failure; usable siblings survive", () => {
  const allJunk = normalizeAgentRowsDetailed([null, "junk", { name: "no id" }, 7])
  assert.equal(allJunk.ok, false, "zero usable ids among non-empty rows = shape drift, not an empty registry")
  const mixed = normalizeAgentRowsDetailed([{ nope: 1 }, { id: "w", description: "d" }])
  assert.ok(mixed.ok, "row-level junk is skipped when usable siblings exist")
  if (mixed.ok) assert.deepEqual(mixed.rows.map((r) => r.id), ["w"])
})

test("normalizeDetailed P1: a plain-string model value must NOT read as an absent pin (false Auto confirm)", () => {
  const r = normalizeAgentRowsDetailed([{ id: "w", model: "p/m" }])
  assert.ok(r.ok)
  const before = r.ok ? r.rows : null
  const after = r.ok ? r.rows : null
  const o = observeRegistration(before, after, { id: "w", expect: "present", model: null })
  assert.equal(o.kind, "unconfirmed", "an unparseable non-null model is NOT evidence the pin is gone")
})

test("normalizeDetailed P1: rows dropped for bad ids must not let observe prove an absence", () => {
  const before = normalizeAgentRowsDetailed([{ id: "w", description: "d" }])
  const rawAfter = [{ id: "other" }, { name: "w" }]
  const result = normalizeAgentRowsDetailed(rawAfter)
  const after = result.ok ? result.rows : null
  const o = observeRegistration(before.ok ? before.rows : null, after, { id: "w", expect: "absent" })
  assert.equal(o.kind, "unconfirmed", "a response that carried unparseable rows cannot prove w was removed")
})

test("normalizeDetailed: extras preserve every other observable field verbatim", () => {
  const r = normalizeAgentRowsDetailed([{ id: "w", description: "d", mode: "subagent", prompt: "hi", permission: { edit: "allow" } }])
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.rows[0].extras, { mode: "subagent", prompt: "hi", permission: { edit: "allow" } })
})

// ---------------------------------------------------------------------------
// RegistrationExpectation.fields (extras canonical JSON) + zero-constraint
// ---------------------------------------------------------------------------

test("fields: canonical JSON equality — object key order must never decide confirmation", () => {
  const before = normalizeAgentRows([{ id: "w" }]).map((r) => ({ ...r, extras: { permission: { edit: "deny", read: "allow" } } }))
  const afterRows = normalizeAgentRowsDetailed([{ id: "w", permission: { read: "allow", edit: "deny" } }])
  const after = afterRows.ok ? afterRows.rows : null
  const o = observeRegistration(before, after, { id: "w", expect: "present", fields: { permission: { edit: "deny", read: "allow" } } })
  assert.equal(o.kind, "confirmed", "same permission content, different key order — canonical JSON matches")
  const mismatch = observeRegistration(before, after, { id: "w", expect: "present", fields: { permission: { edit: "allow" } } })
  assert.equal(mismatch.kind, "unconfirmed")
})

test("fields: a field the row does not expose is NOT observable — unconfirmed (fail closed)", () => {
  const before = normalizeAgentRows([{ id: "w", description: "d" }])
  const after = normalizeAgentRows([{ id: "w", description: "d" }]) // legacy rows carry NO extras
  const o = observeRegistration(before, after, { id: "w", expect: "present", fields: { permission: { edit: "allow" } } })
  assert.equal(o.kind, "unconfirmed", "extras-less rows cannot confirm a fields expectation")
  assert.match(o.detail, /permission|field/)
})

test("model: {} (zero constraint) on an EXISTING id is not a change — unconfirmed", () => {
  const rows = normalizeAgentRows([{ id: "w", model: { providerID: "p", modelID: "m" } }])
  const o = observeRegistration(rows, rows, { id: "w", expect: "present", model: {} })
  assert.equal(o.kind, "unconfirmed", "an unconstrained model expectation cannot confirm an update of a pre-existing row")
})

test("model: {} (zero constraint) confirms only a TRUE addition (readable before missing the id)", () => {
  const after = normalizeAgentRows([{ id: "w", model: { providerID: "p", modelID: "m" } }])
  assert.equal(observeRegistration([], after, { id: "w", expect: "present", model: {} }).kind, "confirmed")
  assert.equal(observeRegistration(null, after, { id: "w", expect: "present", model: {} }).kind, "unconfirmed", "unknown prior state is never a proven addition")
})

test("model: exact 'provider/model' string expectation matches fieldwise identity", () => {
  const after = normalizeAgentRows([{ id: "w", model: { providerID: "p", modelID: "m" } }])
  assert.equal(observeRegistration([], after, { id: "w", expect: "present", model: "p/m" }).kind, "confirmed")
  assert.equal(observeRegistration([], after, { id: "w", expect: "present", model: "p/other" }).kind, "unconfirmed")
})

test("normalizeDetailed: model pin normalizes from probe {id} AND host {providerID, modelID} shapes", () => {
  const r = normalizeAgentRowsDetailed([
    { id: "a", model: { providerID: "p1", id: "m1" } },
    { id: "b", model: { providerID: "p2", modelID: "m2" } },
  ])
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.rows[0].model, { providerID: "p1", modelID: "m1" }, "probe shape {providerID, id}")
  assert.deepEqual(r.rows[1].model, { providerID: "p2", modelID: "m2" })
})

test("legacy normalizeAgentRows must never be the deletion-proof channel (deprecated trap)", () => {
  // A broken body reads as [] here by design — the test pins the trap:
  // callers MUST route confirmations through normalizeAgentRowsDetailed.
  assert.deepEqual(normalizeAgentRows("garbage"), [])
})

// ---------------------------------------------------------------------------
// Final narrow review (coder3300): wrapper-entry directness + bad-row
// inference holes
// ---------------------------------------------------------------------------

test("sameHost narrow: node.exe args [run, opencode.js] is NOT commandline evidence — the entry is not the wrapper's direct argument", () => {
  // `node run opencode.js` runs an UNKNOWN script "run" — "opencode.js" is
  // merely its argument, not the node entry. (Only a direct wrapper
  // invocation like `bun run`-style argv[1] entries carry identity.)
  const v = sameHostVerdict({ ...HAPPY, seam: seamOf({ identity: { supported: true, args: ["node.exe", "run", "opencode.js"] } }) })
  assert.equal(v.writable, false, "an indirect run script must not inherit opencode identity from its argument list")
})

test("observe narrow: a BEFORE body that carried bad rows cannot prove 'newly registered' on a zero-constraint present", () => {
  const beforeResult = normalizeAgentRowsDetailed([{ id: "other" }, { name: "w" }]) // {name:w} dropped → prior state unreliable
  const before = beforeResult.ok ? beforeResult.rows : null
  const afterRows = normalizeAgentRowsDetailed([{ id: "w" }])
  const after = afterRows.ok ? afterRows.rows : null
  const o = observeRegistration(before, after, { id: "w", expect: "present" })
  assert.equal(o.kind, "unconfirmed", "an unreliable BEFORE cannot prove w is NEW — id presence alone stays unconfirmed")
})

test("observe narrow: blank-ID junk rows in AFTER cannot prove w's absence", () => {
  const before = normalizeAgentRowsDetailed([{ id: "w", description: "d" }])
  const rawAfter = [{ id: "other" }, { id: "   " }]
  const result = normalizeAgentRowsDetailed(rawAfter)
  const after = result.ok ? result.rows : null
  const o = observeRegistration(before.ok ? before.rows : null, after, { id: "w", expect: "absent" })
  assert.equal(o.kind, "unconfirmed", "a response carrying unparseable rows cannot prove w was removed")
})
