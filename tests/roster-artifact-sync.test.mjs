import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createV2MockContext } from './lib/v2-mock-context.mjs'
import { createPoolResolver, forgeConfigPaths } from '../src/forge-config.ts'
import { agentDirFor, globalAgentDirFor, planRosterSync, planOverrideSync, GENERATED_MARKER } from '../src/roster-compile.ts'

const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
const recipe = (pool, prompt, auto) => ({ pool, ...(auto ? { sync: 'auto' } : {}), agents: { reader: { prompt } } })
const stamp = new Date('2026-01-01T00:00:00Z')

async function fixture(t, auto) {
  const root = mkdtempSync(join(tmpdir(), 'forge-artifact-sync-'))
  const home = join(root, 'home'), configDir = join(root, 'config')
  const workspace = join(root, 'workspace'), fallback = join(root, 'fallback'), bad = join(root, 'bad')
  for (const dir of [workspace, fallback, bad]) mkdirSync(dir)
  const globalFile = forgeConfigPaths({ homeDir: home }).global
  const workspaceFile = join(workspace, '.opencode', 'forge.json')
  const badFile = join(bad, '.opencode', 'forge.json')
  const globalRecipe = { ...recipe('global', 'Global fixture.', auto), override: { general: { prompt: 'General fixture.' }, explore: { prompt: 'Explore fixture.' } } }
  put(globalFile, JSON.stringify(globalRecipe)); put(workspaceFile, JSON.stringify(recipe('local', 'Workspace fixture.', auto))); put(badFile, '{broken')
  process.env.FORGE_TEST_FORGE_HOME = home
  process.env.OPENCODE_CONFIG_DIR = configDir
  process.env.FORGE_SERVICE_FILE = join(root, 'missing-service.json')
  process.env.FORGE_TEST_NO_DISPATCH_FETCH = '1'
  process.env.FORGE_TEST_NO_FENCE = '1'
  const previousCwd = process.cwd()
  process.chdir(fallback)
  t.after(() => process.chdir(previousCwd))
  const { v2Setup, v2WiringSeam } = await import('../plugin.ts')
  const anchors = [workspace, fallback, bad]
  const resolver = createPoolResolver({ homeDir: home })
  const resolution = resolver.resolve(anchors)
  const projections = planRosterSync(resolution, { globalPoolFile: globalFile, globalAgentDir: globalAgentDirFor({ homeDir: home, configDir }) }).flatMap(p => p.files.map(f => ({ path: join(p.dir, f.fileName), content: f.content, recipe: p.family.file })))
  assert.equal(projections.length, 2)
  assert.deepEqual(Object.keys(resolution.agents).sort(), ['global-reader', 'local-reader'])
  assert.deepEqual(resolution.families.find(f => f.ns === 'local').materializedIds, ['local-reader'])
  assert.deepEqual(resolution.families.find(f => f.ns === 'global').materializedIds, ['global-reader'])
  for (const p of projections) {
    put(p.path, p.content.replace(/(Global|Workspace) fixture\./, 'Old fixture.'))
    utimesSync(p.path, stamp, stamp); utimesSync(p.recipe, stamp, stamp)
  }
  const overrideDir = join(configDir, 'agent')
  const legacyGlobal = join(agentDirFor(globalFile), "forge-global-reader.md")
  const canonicalGlobal = projections.find(p => p.recipe === globalFile)
  assert.equal(canonicalGlobal.path, join(overrideDir, "forge-global-reader.md"))
  put(legacyGlobal, canonicalGlobal.content)
  const overridePlan = planOverrideSync(resolution.overrides, { dir: overrideDir, recipeFile: globalFile })
  const explore = join(overrideDir, 'explore.md'), general = join(overrideDir, 'general.md')
  const oldExplore = `${GENERATED_MARKER} old -->\nOld explore.`
  put(explore, oldExplore); utimesSync(explore, stamp, stamp)
  put(general, 'handwritten general\r\n')
  const unrelated = join(overrideDir, 'unrelated.md'); put(unrelated, GENERATED_MARKER)
  const cleanups = []
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup?.(); v2WiringSeam.resetHostAnchors(); rmSync(root, { recursive: true, force: true }) })
  async function boot(deps = {}) {
    v2WiringSeam.resetHostAnchors()
    const mock = createV2MockContext()
    cleanups.push(await v2Setup(mock.ctx, { anchors, homeDir: home, ...deps }))
    return mock.state
  }
  return { boot, home, root, resolver, projections, workspace, fallback, bad, badFile, workspaceFile, globalFile, globalRecipe, explore, general, unrelated, oldExplore, overridePlan, legacyGlobal, canonicalGlobal }
}

for (const auto of [false, true]) test(`setup artifact synchronization: ${auto ? 'auto opt-in' : 'explicit only'}`, async t => {
  const f = await fixture(t, auto)
  const warns = []
  const oldWarn = console.warn
  console.warn = (...args) => { warns.push(args.join(' ')); oldWarn(...args) }
  t.after(() => { console.warn = oldWarn })
  const state = await f.boot()
  assert.equal(f.resolver.workspacePoolOf(f.workspace), f.workspaceFile)
  assert.equal(f.resolver.workspacePoolOf(f.fallback), null)
  assert.equal(f.resolver.workspacePoolOf(f.bad), f.badFile)
  assert.equal(existsSync(join(f.bad, '.opencode', 'agent')), false)
  for (const p of f.projections) {
    if (auto) assert.equal(readFileSync(p.path, 'utf8'), p.content)
    else assert.match(readFileSync(p.path, 'utf8'), /Old fixture/)
  }
  const expectedExplore = f.overridePlan.files.find(p => p.fileName === 'explore.md').content
  if (auto) {
    assert.equal(readFileSync(f.explore, 'utf8'), expectedExplore)
    assert.match(warns.join('\n'), /hand-written/)
  } else {
    assert.equal(readFileSync(f.explore, 'utf8'), f.oldExplore)
    assert.match(warns.join('\n'), /stale.*override|override.*stale/i)
  }
  if (auto) {
    assert.equal(warns.filter(w => w.includes('stale roster regenerated')).length, 2)
  }
  const sync = () => state.tools.get('forge_sync').execute({}, { sessionID: 'ses_artifact_sync', agent: 'forge', worktree: f.workspace, directory: f.workspace, metadata() {} })
  const result = await sync()
  assert.match(result.output ?? result.content, /hand-written/)
  assert.match(result.output ?? result.content, auto ? /unchanged:/ : /updated:/)
  for (const p of f.projections) assert.equal(readFileSync(p.path, 'utf8'), p.content)
  assert.equal(readFileSync(f.explore, 'utf8'), expectedExplore)
  assert.equal(readFileSync(f.general, 'utf8'), 'handwritten general\r\n')
  assert.match(result.output ?? result.content, /former recipe-sibling path/)
  put(f.globalFile, JSON.stringify({ ...f.globalRecipe, agents: {}, override: {} }))
  if (auto) await f.boot()
  else await sync()
  assert.equal(existsSync(f.explore), false)
  assert.equal(existsSync(f.canonicalGlobal.path), false)
  assert.equal(readFileSync(f.legacyGlobal, "utf8"), f.canonicalGlobal.content)
  assert.equal(readFileSync(f.general, 'utf8'), 'handwritten general\r\n')
  assert.equal(readFileSync(f.unrelated, 'utf8'), GENERATED_MARKER)
})

test('a current legacy global file does not satisfy missing canonical freshness', async t => {
  const f = await fixture(t, true)
  rmSync(f.canonicalGlobal.path)
  await f.boot()
  assert.equal(readFileSync(f.canonicalGlobal.path, 'utf8'), f.canonicalGlobal.content)
  assert.equal(readFileSync(f.legacyGlobal, 'utf8'), f.canonicalGlobal.content)
})

for (const auto of [false, true]) test(`fixture root refuses outside artifact destination: ${auto ? 'auto' : 'explicit'}`, async t => {
  const f = await fixture(t, auto)
  const outside = mkdtempSync(join(dirname(f.root), 'forge-artifact-outside-'))
  const priorRoot = process.env.FORGE_TEST_FIXTURE_ROOT
  process.env.FORGE_TEST_FIXTURE_ROOT = f.root
  t.after(() => {
    if (priorRoot === undefined) delete process.env.FORGE_TEST_FIXTURE_ROOT
    else process.env.FORGE_TEST_FIXTURE_ROOT = priorRoot
    rmSync(outside, { recursive: true, force: true })
  })
  const configDir = auto ? join(outside, 'missing', 'config') : outside
  process.env.OPENCODE_CONFIG_DIR = configDir
  const existing = join(configDir, 'agent', 'explore.md')
  if (!auto) put(existing, f.oldExplore)
  const warns = []
  const oldWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  t.after(() => { console.warn = oldWarn })
  const state = await f.boot()
  if (auto) assert.match(warns.join('\n'), /test fixture root refused roster path/)
  else {
    const result = await state.tools.get('forge_sync').execute({}, { sessionID: 'ses_artifact_sync', agent: 'forge', worktree: f.workspace, directory: f.workspace, metadata() {} })
    assert.match(result.output ?? result.content, /test fixture root refused roster path/)
  }
  // Valid sibling projections still land; the outside destination does not.
  for (const p of f.projections) {
    if (p.recipe === f.globalFile) assert.match(readFileSync(p.path, 'utf8'), /Old fixture/)
    else assert.equal(readFileSync(p.path, 'utf8'), p.content)
  }
  assert.equal(existsSync(join(configDir, "agent", "forge-global-reader.md")), false)
  if (auto) assert.equal(existsSync(join(outside, 'missing')), false)
  else {
    assert.equal(readFileSync(existing, 'utf8'), f.oldExplore)
    assert.equal(existsSync(join(configDir, 'agent', 'general.md')), false)
  }
})

// The resolver home is authoritative, not the ambient test-home alias.
test('auto sync does not borrow authorization from another home', async t => {
  const f = await fixture(t, false)
  const other = join(f.root, 'other-home')
  put(forgeConfigPaths({ homeDir: other }).global, JSON.stringify({ sync: 'auto' }))
  process.env.FORGE_TEST_FORGE_HOME = other
  await f.boot()
  assert.equal(readFileSync(f.explore, 'utf8'), f.oldExplore)
  for (const p of f.projections) assert.match(readFileSync(p.path, 'utf8'), /Old fixture/)
})

test('independent setups use host-union names without auto-writing earlier recipes', async t => {
  const f = await fixture(t, false)
  const a = f.workspace, b = join(f.root, 'zzz-second')
  mkdirSync(b)
  const bFile = join(b, '.opencode', 'forge.json')
  put(f.workspaceFile, JSON.stringify(recipe('shared', 'First fixture.', true)))
  put(bFile, JSON.stringify(recipe('shared', 'Second fixture.', true)))
  const { v2Setup } = await import('../plugin.ts')
  const first = await f.boot({ anchors: [a] })
  const full = planRosterSync(f.resolver.resolve([a, b, f.fallback]), { globalPoolFile: f.globalFile, globalAgentDir: dirname(f.canonicalGlobal.path) })
  const pa = full.find(p => p.family.file === f.workspaceFile)
  const pb = full.find(p => p.family.file === bFile)
  const aPath = join(pa.dir, pa.files[0].fileName), bPath = join(pb.dir, pb.files[0].fileName)
  assert.equal(pb.files[0].matId, 'shared-2-reader')
  assert.match(readFileSync(aPath, 'utf8'), /First fixture\./)
  // Earlier opt-in is not authorization to repair it during the second setup.
  const oldA = pa.files[0].content.replace('First fixture.', 'Old first fixture.')
  put(aPath, oldA)
  const second = createV2MockContext()
  second.ctx.location = { directory: b }
  process.chdir(a)
  const cleanup = await v2Setup(second.ctx, { homeDir: f.home })
  t.after(async () => cleanup?.())
  assert.equal(readFileSync(aPath, 'utf8'), oldA)
  assert.equal(readFileSync(bPath, 'utf8'), pb.files[0].content)
  assert.equal(readFileSync(f.explore, 'utf8'), f.oldExplore)
  assert.equal(readFileSync(f.general, 'utf8'), 'handwritten general\r\n')
  const globalProjection = f.projections.find(p => p.recipe === f.globalFile)
  assert.match(readFileSync(globalProjection.path, 'utf8'), /Old fixture/)
  const result = await first.tools.get('forge_sync').execute({}, { sessionID: 'ses_artifact_sync', agent: 'forge', worktree: a, directory: a, metadata() {} })
  assert.match(result.output ?? result.content, /unchanged:/)
  assert.equal(readFileSync(aPath, 'utf8'), pa.files[0].content)
  assert.equal(readFileSync(bPath, 'utf8'), pb.files[0].content)
})

test('explicit sync discloses a deleted workspace recipe and preserves its artifacts; empty recipe permits marker GC', async t => {
  const f = await fixture(t, false)
  const subdir = join(f.workspace, 'nested', 'child')
  mkdirSync(subdir, { recursive: true })
  const state = await f.boot({ anchors: [subdir] })
  const local = f.projections.find(p => p.recipe === f.workspaceFile)
  const sync = () => state.tools.get('forge_sync').execute({}, { sessionID: 'ses_artifact_sync', agent: 'forge', worktree: subdir, directory: subdir, metadata() {} })
  const handwritten = join(dirname(local.path), 'forge-local-handwritten.md')
  put(handwritten, 'handwritten')
  rmSync(f.workspaceFile)
  const before = readFileSync(local.path, 'utf8')
  const missing = await sync()
  assert.match(missing.output ?? missing.content, /recipe missing/)
  assert.equal(readFileSync(local.path, 'utf8'), before)
  // Restoring a formerly observed recipe does not itself grant write
  // authority when a nearer recipe now owns the registered anchor.
  const nestedFile = join(subdir, '.opencode', 'forge.json')
  put(nestedFile, JSON.stringify({ pool: 'nested', agents: {} }))
  put(f.workspaceFile, JSON.stringify({ pool: 'local', agents: {} }))
  await sync()
  assert.equal(readFileSync(local.path, 'utf8'), before)
  rmSync(nestedFile)
  const empty = await sync()
  assert.match(empty.output ?? empty.content, /gc'd/)
  assert.equal(existsSync(local.path), false)
  assert.equal(readFileSync(handwritten, 'utf8'), 'handwritten')
})

test('auto sync refuses changed or vanished recipe before writing or GC', async t => {
  const f = await fixture(t, true)
  // An empty override would authorize GC if the old snapshot were trusted.
  put(f.globalFile, JSON.stringify({ ...f.globalRecipe, override: {} }))
  let globalReads = 0
  await f.boot({ readFile: path => {
    if (path.toLowerCase() === f.globalFile.toLowerCase() && ++globalReads === 2) {
      rmSync(f.globalFile)
      throw new Error('recipe disappeared')
    }
    if (path.toLowerCase() === f.workspaceFile.toLowerCase()) {
      const text = readFileSync(path, 'utf8')
      put(path, JSON.stringify(recipe('local', 'Changed fixture.', false)))
      return text
    }
    return readFileSync(path, 'utf8')
  } })
  assert.equal(existsSync(f.globalFile), false)
  assert.equal(readFileSync(f.explore, 'utf8'), f.oldExplore)
  for (const p of f.projections) assert.match(readFileSync(p.path, 'utf8'), /Old fixture/)
})
