import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import "./lib/test-runtime-namespace.mjs"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { v2Setup, v2WiringSeam } from "../plugin.ts"

const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data) }
const recipe = JSON.stringify({ pool: "fixture", sync: "auto", agents: { reader: { prompt: "fixture reader" } } })

test("ordinary setup ignores ancestor recipes outside fixture root and auto-syncs explicit fixture recipes", async t => {
  const outer = mkdtempSync(join(tmpdir(), "config-isolation-"))
  const root = join(outer, "fixtures")
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  const ancestor = join(outer, ".opencode", "forge.json")
  put(ancestor, recipe)
  const previous = process.env.FORGE_TEST_FIXTURE_ROOT
  const previousHome = process.env.FORGE_TEST_FORGE_HOME
  process.env.FORGE_TEST_FIXTURE_ROOT = root
  process.env.FORGE_TEST_FORGE_HOME = join(root, "home")
  t.after(() => {
    process.env.FORGE_TEST_FIXTURE_ROOT = previous
    process.env.FORGE_TEST_FORGE_HOME = previousHome
    v2WiringSeam.resetHostAnchors()
    rmSync(outer, { recursive: true, force: true })
  })
  const first = createV2MockContext()
  const cleanup = await v2Setup(first.ctx, { anchors: [workspace] })
  await cleanup?.()
  assert.equal(existsSync(join(outer, ".opencode", "agent")), false)
  assert.equal(readFileSync(ancestor, "utf8"), recipe)
  const own = join(workspace, ".opencode", "forge.json")
  put(own, recipe)
  const second = createV2MockContext()
  const dispose = await v2Setup(second.ctx, { anchors: [workspace] })
  await dispose?.()
  assert.equal(existsSync(join(workspace, ".opencode", "agent")), true)
  assert.equal(existsSync(join(outer, ".opencode", "agent")), false)
})
