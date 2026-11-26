import assert from 'node:assert/strict'
import test from 'node:test'
import { agentDirFor, compileResolvedRosterEntry, compileRosterEntry, executeRosterSync, GENERATED_MARKER, planOverrideSync, planRosterSync, staleCheckForPool } from '../src/roster-compile.ts'

function fixture(file, ns) {
  const matId = `${ns}-reader`
  const agent = { materializedId: matId, ns, file, def: { shape: 'readonly', prompt: 'Read fixture.' }, shared: null }
  const family = { file, ns, declaredPool: null, shared: null, materializedIds: [matId] }
  return { families: [family], agents: { [matId]: agent }, findings: [], overrides: {} }
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const mutations = []
  return { files, mutations, deps: {
    stat: p => files.has(p) ? { mtimeMs: 100, size: files.get(p).length } : null,
    readFile: p => { if (!files.has(p)) throw new Error('missing'); return files.get(p) },
    writeFile: (p, content) => { mutations.push(p); files.set(p, content) },
    rename: (from, to) => { mutations.push(to); files.set(to, files.get(from)); files.delete(from) },
    unlink: p => { mutations.push(p); files.delete(p) },
    readdir: dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
  } }
}

test('global provenance uses Windows path identity, without folding POSIX paths', () => {
  const resolution = fixture('C:/Fake/.config/opencode/forge.json', 'global')
  const globalPoolFile = 'c:\\fake\\.config\\opencode\\forge.json'
  const expected = compileRosterEntry({ matId: 'global-reader', def: resolution.agents['global-reader'].def, provenance: { global: true } }).content
  const plans = planRosterSync(resolution, { globalPoolFile, platform: 'win32' })
  assert.equal(plans[0].files[0].content, expected)
  assert.notEqual(planRosterSync(resolution, { globalPoolFile, platform: 'linux' })[0].files[0].content, expected)
})

for (const [ns, file] of [['workspace', '/fake/work/.opencode/forge.json'], ['global', '/fake/home/.config/opencode/forge.json']]) {
  test(`${ns}: equal-mtime bad projection is detected without writes; explicit sync clears verdict`, () => {
    const resolution = fixture(file, ns)
    const plan = planRosterSync(resolution, { globalPoolFile: '/fake/home/.config/opencode/forge.json' })[0]
    const entry = plan.files[0]
    const dest = `${agentDirFor(file)}/${entry.fileName}`
    const fs = memoryFs({ [file]: '{}', [dest]: entry.content.replace('Read fixture.', 'Old fixture.') })
    const check = () => staleCheckForPool(file, resolution.families[0].materializedIds, fs.deps, matId => compileResolvedRosterEntry(resolution, matId, { globalPoolFile: '/fake/home/.config/opencode/forge.json' }).content)
    assert.match(check().reason, /differs/)
    assert.equal(check().stale, true)
    assert.deepEqual(fs.mutations, [])
    assert.deepEqual(executeRosterSync([plan], fs.deps).updated, [dest])
    assert.equal(check().stale, false)
    assert.equal(fs.files.get(dest), entry.content)
    assert.deepEqual(executeRosterSync([plan], fs.deps).unchanged, [dest])
    const unreadable = staleCheckForPool(file, [entry.matId], { ...fs.deps, readFile: () => { throw new Error('unreadable') } }, () => entry.content)
    assert.equal(unreadable.stale, true)
  })
}

test('ordinary checkout CRLF passes without rewriting, but moved provenance needs explicit sync', () => {
  const file = '/new/work/.opencode/forge.json'
  const plan = planRosterSync(fixture(file, 'local'), { globalPoolFile: '/global/forge.json' })[0]
  const entry = plan.files[0], dest = `${plan.dir}/${entry.fileName}`
  const crlf = entry.content.replace(/\n/g, '\r\n')
  const fs = memoryFs({ [file]: '{}', [dest]: crlf })
  const check = () => staleCheckForPool(file, [entry.matId], fs.deps, () => entry.content)
  assert.equal(check().stale, false)
  assert.deepEqual(executeRosterSync([plan], fs.deps).unchanged, [dest])
  assert.deepEqual(fs.mutations, [])
  fs.files.set(dest, crlf.replaceAll('/new/work/', '/old/work/'))
  assert.match(check().reason, /differs/)
  assert.deepEqual(fs.mutations, [])
  assert.deepEqual(executeRosterSync([plan], fs.deps).updated, [dest])
  assert.equal(check().stale, false)
})

test('ordinary sync protects handwritten collisions and discloses deleted entries and recipes', () => {
  const file = '/fake/work/.opencode/forge.json'
  const plan = planRosterSync(fixture(file, 'local'), { globalPoolFile: '/global/forge.json' })[0]
  const entry = plan.files[0], dest = `${plan.dir}/${entry.fileName}`, orphan = `${plan.dir}/forge-local-gone.md`
  const fs = memoryFs({ [file]: '{}', [dest]: 'handwritten', [orphan]: entry.content })
  const check = () => staleCheckForPool(file, [entry.matId], fs.deps, () => entry.content)
  assert.match(check().reason, /entry removed/)
  assert.deepEqual(fs.mutations, [])
  const outcome = executeRosterSync([plan], fs.deps)
  assert.match(outcome.errors[0], /hand-written/)
  assert.deepEqual(outcome.gced, [orphan])
  assert.equal(fs.files.get(dest), 'handwritten')
  assert.match(check().reason, /hand-written collision/)
  fs.files.set(orphan, entry.content)
  fs.files.delete(file)
  assert.match(staleCheckForPool(file, [], fs.deps, () => entry.content).reason, /recipe missing/)
  assert.equal(fs.files.get(orphan), entry.content)
})

test('override sync discloses handwritten collision, updates stale generated sibling and marker-GCs only owned builtins', () => {
  const dir = '/fake/global/agent'
  const fs = memoryFs({ [`${dir}/general.md`]: 'handwritten', [`${dir}/explore.md`]: `${GENERATED_MARKER} old -->`, [`${dir}/forge-global-reader.md`]: GENERATED_MARKER, [`${dir}/unrelated.md`]: GENERATED_MARKER })
  const plan = planOverrideSync({ general: { prompt: 'General fixture' }, explore: { prompt: 'Explore fixture' } }, { dir, recipeFile: '/fake/global/forge.json' })
  const result = executeRosterSync([plan], fs.deps)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /hand-written/)
  assert.deepEqual(result.updated, [`${dir}/explore.md`])
  assert.equal(fs.files.get(`${dir}/general.md`), 'handwritten')
  assert.equal(fs.files.get(`${dir}/explore.md`), plan.files.find(f => f.fileName === 'explore.md').content)
  const gc = executeRosterSync([{ kind: 'override', dir, files: [] }], fs.deps)
  assert.deepEqual(gc.gced, [`${dir}/explore.md`])
  assert.equal(fs.files.get(`${dir}/general.md`), 'handwritten')
  assert.equal(fs.files.get(`${dir}/forge-global-reader.md`), GENERATED_MARKER)
  assert.equal(fs.files.get(`${dir}/unrelated.md`), GENERATED_MARKER)
})
