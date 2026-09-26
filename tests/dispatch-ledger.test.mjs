import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Spec: dispatch — dispatch ledger (bounded rotation, B30). Same bounded
// style as the watchdog/job ledgers: capped entries, capped bytes, and a
// failing sink must never break the caller.

import { createDispatchLedger, DISPATCH_LEDGER_MAX_ENTRIES } from "../src/dispatch-ledger.ts"

test("B30: ledger rotates at the entry cap, keeping the newest lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-dispatch-ledger-"))
  try {
    const path = join(dir, "ledger.jsonl")
    const ledger = createDispatchLedger(path, 5)
    for (let i = 1; i <= 8; i++) ledger.append({ ts: "t", event: "completed", note: `n${i}` })
    const raw = readFileSync(path, "utf8").trim().split("\n")
    assert.equal(raw.length, 5)
    const notes = raw.map((l) => JSON.parse(l).note)
    assert.deepEqual(notes, ["n4", "n5", "n6", "n7", "n8"]) // oldest dropped
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("B30: byte overflow keeps only the newest half of the budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-dispatch-ledger-"))
  try {
    const path = join(dir, "ledger.jsonl")
    const ledger = createDispatchLedger(path, 10, 600)
    for (let i = 1; i <= 10; i++) ledger.append({ ts: "t", event: "completed", note: "x".repeat(80) + `-${i}` })
    const raw = readFileSync(path, "utf8").trim().split("\n")
    assert.ok(raw.length <= 5, `byte cap keeps at most half the entries (got ${raw.length})`)
    assert.match(JSON.parse(raw[raw.length - 1]).note, /-10$/, "newest line survives")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("B30: default cap constant matches the watchdog ledger family style", () => {
  assert.equal(DISPATCH_LEDGER_MAX_ENTRIES, 200)
})
