import test from 'node:test'
import assert from 'node:assert/strict'
import { stopNative } from '../src/stop-native.ts'

const proof = id => ({ type: 'assistant', content: [{ type: 'tool', name: 'subagent', state: { status: 'completed', metadata: { sessionID: id, status: 'running' } } }] })
test('stop only confirmed native children and their own shells; revisit new children', async () => {
  let round = 0
  const calls = []
  const receipt = await stopNative('root', {
    children: async parent => parent === 'root' ? ['busy', 'idle', 'shell', 'unknown', ...(round ? ['new'] : [])].map(id => ({ id, parentID: parent, metadata: { sessionID: id } })) : [],
    context: async () => ({ data: ['busy', 'idle', 'shell', ...(round ? ['new'] : [])].map(proof) }),
    shells: async () => round ? [] : [{ id: 'owned', metadata: { sessionID: 'shell' } }, { id: 'other', metadata: { sessionID: 'unknown' } }],
    active: async () => ({ busy: { type: 'running' }, new: { type: 'running' } }),
    removeShell: async id => calls.push(['shell', id]),
    interrupt: async id => { calls.push(['interrupt', id]); return { interrupted: true } },
    wait: async () => { round++ },
  })
  assert.deepEqual(calls[0], ['shell', 'owned'])
  assert.ok(calls.some(c => c[1] === 'busy'))
  assert.ok(calls.some(c => c[1] === 'shell'))
  assert.ok(calls.some(c => c[1] === 'new'))
  assert.ok(!calls.some(c => ['other', 'unknown', 'idle'].includes(c[1])))
  assert.match(receipt, /unknown: scope not confirmed/)
  assert.match(receipt, /terminal outcome unconfirmed/)
})
test('shell enumeration fails; known descendants still attempted despite individual failure', async () => {
  const calls = []
  const receipt = await stopNative('root', {
    children: async parent => parent === 'root' ? [{ id: 'one', parentID: parent }, { id: 'two', parentID: parent }] : [],
    context: async () => [proof('one'), proof('two')],
    shells: async () => { throw Error('offline') },
    active: async () => { throw Error('offline') },
    removeShell: async () => assert.fail('no shell ownership'),
    interrupt: async id => { calls.push(id); if (id === 'one') throw Error('offline') },
    wait: async () => {},
  })
  assert.ok(calls.includes('two'))
  assert.match(receipt, /one: Interrupt request failed/)
  assert.match(receipt, /Shell enumeration unavailable; remaining count unknown/)
})

test('bounded context and interrupt calls do not strand sibling work; cursor discloses remainder', async () => {
  const pending = () => new Promise(() => {})
  const calls = []
  const receipt = await stopNative('root', {
    children: async parent => parent === 'root' ? { data: ['one', 'two'].map(id => ({ id, parentID: parent })), cursor: { next: 'more' } } : parent === 'one' ? [{ id: 'unproven', parentID: parent }] : [],
    context: async parent => parent === 'root' ? [proof('one'), proof('two')] : pending(),
    shells: async () => [],
    active: async () => ({ one: { type: 'running' }, two: { type: 'running' } }),
    removeShell: async () => assert.fail('no owned shells'),
    interrupt: async id => { calls.push(id); if (id === 'one') return pending(); return { interrupted: true } },
    wait: async () => {}, timeoutMs: 10, deadlineMs: 1000,
  })
  assert.ok(calls.includes('two'))
  assert.ok(!calls.includes('unproven'))
  assert.match(receipt, /remaining count unknown/)
  assert.match(receipt, /Dispatch evidence unavailable for one/)
  assert.match(receipt, /one: Interrupt request failed or timed out; outcome unknown/)
  assert.doesNotMatch(receipt, /No native children to stop/)
})

test('native short page carries an anchor, not proof of truncation; empty tail completes enumeration', async () => {
  const queries = [], calls = []
  let interrupted = false
  const receipt = await stopNative('root', {
    children: async (parent, cursor) => {
      queries.push([parent, cursor])
      return parent === 'root' && !cursor
        ? { data: [{ id: 'child', parentID: 'root' }], cursor: { previous: 'prev', next: 'anchor' } }
        : { data: [], cursor: { previous: null, next: null } }
    },
    context: async () => [proof('child')], shells: async () => [],
    active: async () => interrupted ? {} : { child: { type: 'running' } },
    removeShell: async () => assert.fail('no shell'),
    interrupt: async id => { calls.push(id); interrupted = true; return { interrupted: true } },
    wait: async () => {},
  })
  assert.deepEqual(calls, ['child'])
  assert.ok(queries.some(([parent, cursor]) => parent === 'root' && cursor === 'anchor'))
  assert.match(receipt, /Confirmed not running after interrupt request/)
  assert.doesNotMatch(receipt, /remaining count unknown/)
  assert.match(receipt, /Interrupting the parent does not guarantee children stop/)
})

test('later child pages are processed; failed tail retains proven children and discloses remainder', async () => {
  const calls = []
  const receipt = await stopNative('root', {
    children: async (parent, cursor) => {
      if (parent !== 'root') return []
      if (!cursor) return { data: [{ id: 'one', parentID: parent }], cursor: { next: 'page2' } }
      if (cursor === 'page2') return { data: [{ id: 'two', parentID: parent }], cursor: { next: 'tail' } }
      throw Error('offline')
    },
    context: async () => [proof('one'), proof('two')], shells: async () => [],
    active: async () => ({ one: {}, two: {} }), removeShell: async () => {},
    interrupt: async id => { calls.push(id); return { interrupted: true } }, wait: async () => {},
  })
  assert.ok(calls.includes('one') && calls.includes('two'))
  assert.match(receipt, /Child enumeration unavailable for root/)
  assert.match(receipt, /remaining count unknown/)
})

test('conflicting ancestry invalidates descendant and shell ownership', async () => {
  const calls = []
  const receipt = await stopNative('root', {
    children: async parent => parent === 'root' ? [{ id: 'b', parentID: 'root' }, { id: 'b', parentID: 'other' }] : parent === 'b' ? [{ id: 'g', parentID: 'b' }] : [],
    context: async parent => [proof(parent === 'root' ? 'b' : 'g')],
    shells: async () => [{id: 'sh', metadata: {sessionID: 'g'}}],
    active: async () => ({b: {}, g: {}}),
    removeShell: async id => calls.push(id), interrupt: async id => calls.push(id), wait: async () => {},
  })
  assert.deepEqual(calls, [])
  assert.match(receipt, /g: scope not confirmed/)
})

test('only a completed native start with running metadata qualifies; acknowledged shell request is not repeated', async () => {
  const calls = [], stale = proof('stale')
  stale.content[0].state.metadata.status = 'idle'
  const receipt = await stopNative('root', {
    children: async p => p === 'root' ? ['live', 'stale'].map(id => ({id, parentID: p})) : [],
    context: async () => [proof('live'), stale],
    shells: async () => [{id: 'sh', metadata: {sessionID: 'live'}}, {id: 'bad', metadata: {sessionID: 'stale'}}],
    active: async () => ({live: {}, stale: {}}),
    removeShell: async id => calls.push(['shell', id]), interrupt: async id => calls.push(['interrupt', id]), wait: async () => {},
  })
  assert.deepEqual(calls.filter(([op]) => op === 'shell'), [['shell', 'sh']])
  assert.ok(calls.every(([, id]) => id !== 'stale' && id !== 'bad'))
  assert.match(receipt, /stale: scope not confirmed/)
  assert.doesNotMatch(receipt, /Shell sh: confirmed no longer running/)
})
