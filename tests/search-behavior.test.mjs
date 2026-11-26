import test from "node:test"
import assert from "node:assert/strict"
import { resolveRgBinary, RG_MISSING_REMEDIES } from "../src/search-core.ts"

// Pure engine resolver regression retained while D9 keeps native search.
const EXPECTED_RG_MISSING_ERROR =
  "ripgrep (rg) not found — install ripgrep (or set search.rgPath in forge config to an existing rg binary), or fall back to the builtin grep/glob tools for this search"

test("3.2 resolver fail-soft (fake seams): no override + PATH miss → exact guidance error object, nothing throws", () => {
  assert.equal(RG_MISSING_REMEDIES, EXPECTED_RG_MISSING_ERROR.slice("ripgrep (rg) not found — ".length), "exported remedies constant matches the contract literal")
  // win32 seam: no rgPath override, fake existsSync always misses, PATH has
  // entries but none contains rg.
  const win = resolveRgBinary(undefined, {
    existsSync: () => false,
    pathEnv: "C:\\fake\\bin;C:\\other\\tools",
    pathSep: ";",
    platform: "win32",
  })
  assert.equal(win.ok, false, "not ok")
  assert.equal(win.error, EXPECTED_RG_MISSING_ERROR, "exact contract text (win32)")
  // posix seam parity: same guidance through the posix join/separator.
  const nix = resolveRgBinary(undefined, {
    existsSync: () => false,
    pathEnv: "/fake/bin:/other/tools",
    pathSep: ":",
    platform: "linux",
  })
  assert.equal(nix.ok, false, "not ok (posix)")
  assert.equal(nix.error, EXPECTED_RG_MISSING_ERROR, "exact contract text (posix)")
  // Both remedies named, verbatim, in the error body.
  assert.match(EXPECTED_RG_MISSING_ERROR, /install ripgrep/, "remedy 1: install ripgrep")
  assert.match(EXPECTED_RG_MISSING_ERROR, /fall back to the builtin grep\/glob tools for this search/, "remedy 2: builtin fallback")
  // Empty PATH env degrades to the same guidance (no dirs to scan).
  const empty = resolveRgBinary(undefined, { existsSync: () => false, pathEnv: "", pathSep: ";", platform: "win32" })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, EXPECTED_RG_MISSING_ERROR, "exact contract text (empty PATH)")
})
