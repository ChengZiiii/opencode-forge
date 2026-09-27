import test from "node:test"
import assert from "node:assert/strict"

// Spec: openspec/changes/add-dispatch-onboarding/specs/dispatch/spec.md
//   ADDED "Dedicated forge.json configuration file" — the file is JSONC
//   (comments allowed), parsed by a string-state-machine stripper so comment
//   markers inside string values never eat data.
//
// 1.1 parseForgeJsonc: comments / trailing commas / strings containing comment
// markers / escaped quotes / bad JSON with a located error.

import { parseForgeJsonc } from "../src/forge-config.ts"

test("1.1 line and block comments are stripped", () => {
  const r = parseForgeJsonc(`{
  // dispatch agents
  "agents": {
    /* research worker */ "research": { "model": "zai/glm-5.3", "depths": ["low"] }
  }
}`)
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.agents.research.model, "zai/glm-5.3")
})

test("1.1 strings containing comment markers survive verbatim", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "odd": { "model": "x/y", "depths": ["low"], "prompt": "see https://example.com // not a comment /* also not */" }
  }
}`)
  assert.equal(r.ok, true)
  assert.equal(r.config.agents.odd.prompt, "see https://example.com // not a comment /* also not */")
})

test("1.1 trailing commas are tolerated", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "research": { "model": "zai/glm-5.3", "depths": ["low", "medium",], },
  },
}`)
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.agents.research.depths, ["low", "medium"])
})

test("1.1 escaped quotes inside strings do not terminate the string state", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "q": { "model": "x/y", "depths": ["low"], "prompt": "say \\"hi\\" // keep" }
  }
}`)
  assert.equal(r.ok, true)
  assert.equal(r.config.agents.q.prompt, 'say "hi" // keep')
})

test("1.1 bad JSON errors with a located message", () => {
  const r = parseForgeJsonc(`{
  "agents": {
    "research": { "model": }
  }
}`)
  assert.equal(r.ok, false)
  assert.ok(r.error.message.length > 0, "error message is non-empty")
  // Position must be reported and must point into the ORIGINAL text (comments
  // are stripped space-preserving, so offsets align 1:1).
  assert.ok(typeof r.error.line === "number" && r.error.line >= 1, "error carries a 1-based line")
  assert.ok(typeof r.error.column === "number" && r.error.column >= 1, "error carries a 1-based column")
  assert.equal(r.error.line, 3)
})

test("1.1 non-object top level is a parse error", () => {
  const r = parseForgeJsonc(`[1, 2]`)
  assert.equal(r.ok, false)
})
