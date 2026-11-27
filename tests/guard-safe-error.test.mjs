import test from "node:test"
import assert from "node:assert/strict"

// forge-tui-subagent-config — SAFE ERROR TEXT (disclosure) contract.
//
// The screenshot defect: a rejected non-Error (a plain SDK error object)
// was disclosed as "[object Object]" — unreadable and diagnostically
// useless. The shared safeErrorText (guard.ts, replacing the duplicated
// instanceof checks in tui.ts / flow.ts) must render every rejection
// readable while staying SAFE: bounded length, no secret dumping, no
// accessor traps, no cycle blowups.
//
// These tests pin only PROVEN behavior; nested SDK error shapes are NOT
// assumed (only the visible surfaces: _tag / code / message strings are
// asserted when present).

import { safeErrorText } from "../src/tui/guard.ts"

const OBJECT_OBJECT = "[object Object]"

test("a real Error renders its message verbatim (the existing contract, unchanged)", () => {
  assert.equal(safeErrorText(new Error("connection lost")), "connection lost")
})

test("a plain {code,message} rejection is readable — never '[object Object]'", () => {
  const out = safeErrorText({ code: "E_TIMEOUT", message: "upstream unavailable" })
  assert.notEqual(out, OBJECT_OBJECT)
  assert.ok(out.includes("E_TIMEOUT"), `the code is disclosed — ${out}`)
  assert.ok(out.includes("upstream unavailable"), `the message is disclosed — ${out}`)
})

test("a _tag SDK-shaped error surfaces its tag/message without assuming nested shapes", () => {
  const out = safeErrorText({ _tag: "HttpClientError", message: "request failed after 3 attempts" })
  assert.notEqual(out, OBJECT_OBJECT)
  assert.ok(
    out.includes("HttpClientError") || out.includes("request failed after 3 attempts"),
    `the visible surface is disclosed (tag or message) — ${out}`,
  )
})

test("an unknown object carrying a secret field never dumps the secret", () => {
  const SECRET = "sk-secret-abc123XYZQ"
  const out = safeErrorText({ errno: -111, secret: SECRET, detail: { token: SECRET } })
  assert.notEqual(out, OBJECT_OBJECT)
  assert.ok(!out.includes(SECRET), `the secret value is never dumped — ${out}`)
})

test("a Bearer/authorization fragment in the message is masked, not disclosed", () => {
  const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sc0ttT0k3n"
  const out = safeErrorText(new Error(`request failed: Bearer ${JWT} was rejected`))
  assert.ok(!out.includes(JWT), `the raw bearer token is masked — ${out}`)
  assert.ok(out.includes("request failed"), `the readable part survives — ${out}`)
  const TOKENY = "token=sup3rs3cret-value-42"
  const out2 = safeErrorText({ message: `auth failed (${TOKENY})` })
  assert.ok(!out2.includes("sup3rs3cret-value-42"), `a token= fragment is masked — ${out2}`)
})

// Credential-shape counterexamples (synthetic values only — never real
// credentials): every scheme spelling and length must be masked whole.
// A credential embedded in PROSE is not exempt: prose context never turns
// a credential into disclosable text.
test("every credential spelling is masked whole: lowercase Bearer, Authorization: Basic, SHORT credentials, uppercase BEARER — no length/scheme/case exemption", () => {
  const forms = [
    ["lowercase Bearer (12-char)", new Error(`rejected: Bearer abcdefghijkl`), "abcdefghijkl"],
    ["Authorization: Basic (12-char)", { message: `Authorization: Basic abcdefghijkl` }, "abcdefghijkl"],
    ["short Bearer credential", new Error(`upstream said: Bearer abc123`), "abc123"],
    ["short Basic credential", { message: `Authorization: Basic abc123` }, "abc123"],
    ["uppercase BEARER (12-char)", new Error(`upstream said: BEARER abcdefghijkl`), "abcdefghijkl"],
    ["uppercase BASIC", { message: `BASIC abcdefghijkl refused` }, "abcdefghijkl"],
    // NOTE: the authorized contract covers SCHEME-marked credentials
    // (Authorization/Bearer/Basic/token) with no prose exemption — the
    // scheme-embedded rows above prove prose is not exempt. A scheme-less
    // bare blob is deliberately NOT pinned: masking arbitrary high-entropy
    // strings without a scheme marker would destroy non-credential prose
    // ("NO word-shape guessing" is the landed, authorized design).
  ]
  for (const [label, err, secret] of forms) {
    const out = safeErrorText(err)
    assert.ok(!out.includes(secret), `${label}: the credential never leaks — ${out}`)
    assert.ok(!out.includes("[object Object]"), `${label}: readable — ${out}`)
  }
})

test("a field OUTSIDE the whitelist (name) is never disclosed, even on an otherwise-readable error", () => {
  const out = safeErrorText({ name: "InternalHandlerName42", code: "E_X", message: "" })
  assert.ok(!out.includes("InternalHandlerName42"), `a non-whitelisted field is never disclosed — ${out}`)
  assert.ok(out.includes("E_X"), `the whitelisted code still surfaces — ${out}`)
})

test("a very long message is bounded — never an unbounded dump", () => {
  const out = safeErrorText(new Error("x".repeat(100_000)))
  assert.ok(out.length > 0, "something readable survives")
  assert.ok(out.length <= 2_000, `the disclosure is bounded (got ${out.length} chars)`)
})

test("a throwing accessor never breaks rendering", () => {
  const hostile = {
    get boom() {
      throw new Error("accessor trap")
    },
    message: "still readable",
  }
  const out = safeErrorText(hostile)
  assert.notEqual(out, OBJECT_OBJECT)
  assert.ok(out.includes("still readable"), `the safe fields survive the hostile accessor — ${out}`)
  assert.ok(!out.includes("accessor trap"), "the accessor's own throw is not what gets rendered as the error")
})

test("an Error whose message GETTER throws renders safely (name fallback or masked sentence) — never a rethrow", () => {
  const hostile = new Error("placeholder")
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("getter trap")
    },
  })
  let out
  assert.doesNotThrow(() => {
    out = safeErrorText(hostile)
  }, "a throwing message getter must never escape safeErrorText")
  assert.ok(typeof out === "string" && out.length > 0, `a readable string survives — ${JSON.stringify(out)}`)
  assert.ok(!out.includes("getter trap"), "the getter's own throw is not what gets rendered — out: " + String(out))
})

test("a 'Basic <credentials>' authorization fragment is masked WHOLE — the scheme word alone must not survive while the credential leaks", () => {
  const CREDS = "dXNlcjpwYXNzd29yZA=="
  const out = safeErrorText(new Error(`auth rejected: Basic ${CREDS}`))
  assert.ok(!out.includes(CREDS), `the Basic credentials are masked whole — ${out}`)
  const out2 = safeErrorText({ message: `Authorization: Basic ${CREDS}` })
  assert.ok(!out2.includes(CREDS), `an Authorization: Basic header is masked whole — ${out2}`)
})

test("a self-referencing (cyclic) object renders without hanging or throwing", () => {
  // code-only: the {code,message} dual-field requirement is pinned by its
  // dedicated test above — this test targets cycle safety alone.
  const cyc = { code: "E_CYCLE" }
  cyc.self = cyc
  const out = safeErrorText(cyc)
  assert.notEqual(out, OBJECT_OBJECT)
  assert.ok(out.includes("E_CYCLE"), `the code survives the cycle — ${out}`)
})
