import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { authorizedSearch, parseGlobalExcludes } from '../src/search-authorized.ts'

const root = resolve('fixture-worktree'), external = resolve('fixture-external')
const invocation = { sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test' }
function fixture(mode = 'allow') {
  const events = [], approvals = new Set()
  const file = join(root, 'real', 'a.txt'), hidden = join(root, '.hidden', 'a.txt'), out = join(external, 'a.txt')
  const dirs = new Map([[root, ['.git', '.hidden', 'link', 'real', 'outside']], [join(root,'.git'), ['a.txt']], [join(root,'.hidden'), ['a.txt']], [join(root,'real'), ['a.txt']], [external, ['a.txt']]])
  const links = new Map([[join(root,'link'), join(root,'real')], [join(root,'outside'),external]])
  const files = new Map([[file,'é Ab.\nabc\n'],[hidden,'Ab.'],[out,'Ab. SECRET']])
  const ext = p => p === external || p.startsWith(external + (process.platform === 'win32' ? '\\' : '/'))
  const checkRead = p => { events.push(['read',p]); assert.ok(events.some(e => e[0] === 'assert' && ['glob','grep'].includes(e[1].action))); if (ext(p)) assert.ok(approvals.size, 'external read before approval') }
  const seams = {
    stat(p) { return {isDirectory:()=>dirs.has(p),isFile:()=>files.has(p),isSymbolicLink:()=>links.has(p)} },
    realpath(p) { return links.get(p) ?? p },
    list(p) { checkRead(p); return dirs.get(p) ?? [] },
    read(p) { checkRead(p); return Buffer.from(files.get(p) ?? '') },
    async assert(req) {
      events.push(['assert',req]); assert.deepEqual(req.source,{type:'tool',messageID:'msg_test',id:'call_test'})
      if(req.action === 'external_directory') {
        if(mode==='deny') throw Object.assign(new Error('denied'),{name:'ToolError'})
        if(mode==='unknown') throw new Error('unknown permission transport')
        approvals.add(req.resources[0])
      }
    },
  }
  return {seams,events}
}
for (const kind of ['grep','glob']) {
  test(`${kind} authorizes actual external target before reading and deduplicates internal aliases`, async()=>{
    const {seams,events}=fixture()
    const res=await authorizedSearch(kind,{pattern:kind==='glob'?'*.txt':'Ab.',literal:true},invocation,root,root,seams)
    assert.match(res.content,/duplicate paths merged/)
    assert.match(res.content,/outside-workspace target searched/)
    assert.equal(res.output.length,3)
    assert.equal(events[0][0],'assert')
    assert.equal(events[0][1].action,kind)
    const externalRequest=events.find(e=>e[0]==='assert'&&e[1].action==='external_directory')
    assert.ok(externalRequest[1].resources[0].endsWith('fixture-external/*'))
  })
  for(const mode of ['deny','unknown']) test(`${kind} ${mode} never reads external link target`, async()=>{
    const {seams,events}=fixture(mode)
    const run=authorizedSearch(kind,{pattern:kind==='glob'?'*.txt':'Ab.'},invocation,root,root,seams)
    if(mode==='deny') assert.match((await run).content,/skipped target:/)
    else await assert.rejects(run,/unknown/)
    assert.ok(!events.some(e=>e[0]==='read'&&e[1].startsWith(external)))
  })
}
test('grep literal, case, include, offset, Unicode byte submatches and limit',async()=>{
  const {seams}=fixture()
  const res=await authorizedSearch('grep',{pattern:'ab.',literal:true,caseSensitive:false,include:'real/*.txt',follow:false,limit:1},invocation,root,root,seams)
  assert.equal(res.output.length,1)
  assert.deepEqual(res.output[0].submatches,[{text:'Ab.', start:3,end:6}])
  assert.equal(res.output[0].offset,0)
  assert.equal(res.output[0].entry.path,join('real','a.txt'))
  assert.match(res.content,/Found 1 matches/)
  const regex=await authorizedSearch('grep',{pattern:'ab.',caseSensitive:false,include:'real/*.txt',follow:false,limit:1},invocation,root,root,seams)
  assert.equal(regex.metadata.truncated,true)
})
test('glob hidden and follow opt-outs keep original scope',async()=>{
  const {seams}=fixture()
  const res=await authorizedSearch('glob',{pattern:'*.txt',hidden:false,follow:false},invocation,root,root,seams)
  assert.deepEqual(res.output,[{path:join('real','a.txt'),type:'file'}])
})

test('explicit directory anchors both content and structured paths',async()=>{
  const {seams}=fixture()
  const res=await authorizedSearch('glob',{pattern:'*.txt',path:'real'},invocation,root,root,seams)
  assert.deepEqual(res.output,[{path:'a.txt',type:'file'}])
  assert.equal(res.content.split(String.fromCharCode(10))[0],'a.txt')
})
test('explicit external denial rejects before listing or reading',async()=>{
  const {seams,events}=fixture('deny')
  await assert.rejects(authorizedSearch('glob',{pattern:'*.txt',path:external},invocation,root,root,seams),/denied/)
  assert.ok(events.every(e=>e[0]!=='read'))
  assert.deepEqual(events.filter(e=>e[0]==='assert').map(e=>e[1].action),['external_directory'])
})

test('Unicode code point offsets and bounded long-line match collection', async()=>{
  const {seams}=fixture()
  seams.read=()=>Buffer.from('😀'+'x'.repeat(200000))
  const res=await authorizedSearch('grep',{pattern:'.',path:'real',limit:1},invocation,root,root,seams)
  assert.deepEqual(res.output[0].submatches[0],{text:'😀',start:0,end:4})
  assert.equal(res.output[0].submatches.length,100)
})

test('explicit limit 15000 retains all 12000 unique records', async()=>{
  const names = Array.from({length:12000}, (_, i) => `file-${String(i).padStart(5,'0')}.txt`)
  const files = new Set(names.map(name => join(root,name)))
  const seams = {
    stat(p) { return {isDirectory:()=>p===root,isFile:()=>files.has(p),isSymbolicLink:()=>false} },
    realpath(p) { return p },
    list(p) { assert.equal(p,root); return [...names] },
    read() { throw new Error('glob must not read file content') },
    async assert(req) { assert.equal(req.action,'glob') },
  }
  const res = await authorizedSearch('glob',{pattern:'*.txt',limit:15000},invocation,root,root,seams)
  assert.equal(res.output.length,12000)
  assert.equal(new Set(res.output.map(item=>item.path)).size,12000)
  assert.equal(res.metadata.count,12000)
  assert.equal(res.metadata.truncated,false)
  assert.deepEqual(res.output.map(item=>item.path),names)
})

test('internal aliases select lexicographically first complete path', async()=>{
  const dir = join(root,'a'), canonical = join(dir,'x'), alias = join(root,'a-link')
  const seams = {
    stat(p) { return {isDirectory:()=>p===root||p===dir,isFile:()=>p===canonical,isSymbolicLink:()=>p===alias} },
    realpath(p) { return p===alias ? canonical : p },
    list(p) { if(p===root) return ['a-link','a']; if(p===dir) return ['x']; throw new Error(`unexpected list ${p}`) },
    read(p) { assert.equal(p,canonical); return Buffer.from('match\n') },
    async assert(req) { assert.ok(['glob','grep'].includes(req.action)) },
  }
  for(const kind of ['glob','grep']) {
    const res = await authorizedSearch(kind,{pattern:kind==='glob'?'*':'match'},invocation,root,root,seams)
    assert.equal(res.output.length,1)
    assert.equal(kind==='glob'?res.output[0].path:res.output[0].entry.path,'a-link')
    assert.match(res.content,/duplicate paths merged/)
    assert.equal(res.metadata.truncated,false)
  }
})

test('grep excludes ignored files unless positive include selects them; glob positive pattern selects them',async()=>{
  const {seams}=fixture()
  const list=seams.list, read=seams.read, stat=seams.stat
  const ignore=join(root,'.ignore'), generated=join(root,'generated.txt')
  seams.list=p=>p===root?[...list(p),'.ignore','generated.txt']:list(p)
  seams.stat=p=>p===ignore||p===generated?{isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false}:stat(p)
  seams.read=p=>p===ignore?Buffer.from('generated.txt\n'):p===generated?Buffer.from('Ab.'):read(p)
  const grep=await authorizedSearch('grep',{pattern:'Ab.',follow:false},invocation,root,root,seams)
  assert.ok(!grep.output.some(m=>m.entry.path==='generated.txt'))
  const included=await authorizedSearch('grep',{pattern:'Ab.',include:'generated.txt'},invocation,root,root,seams)
  assert.equal(included.output[0].entry.path,'generated.txt')
  const glob=await authorizedSearch('glob',{pattern:'generated.txt'},invocation,root,root,seams)
  assert.equal(glob.output[0].path,'generated.txt')
})


test('truncated DFS still selects globally first alias, and large limits are accepted', async()=>{
  const dir=join(root,'a'), one=join(dir,'one'), two=join(dir,'two'), alias=join(root,'a-link')
  const seams={
    stat(p){return {isDirectory:()=>p===root||p===dir,isFile:()=>p===one||p===two,isSymbolicLink:()=>p===alias}},
    realpath(p){return p===alias?one:p},
    list(p){return p===root?['a','a-link']:['one','two']},
    read(){return Buffer.from('match')}, async assert(){}
  }
  for(const kind of ['glob','grep']) for(const limit of [1,100001]) {
    const res=await authorizedSearch(kind,{pattern:kind==='glob'?'*':'match',limit},invocation,root,root,seams)
    assert.equal(kind==='glob'?res.output[0].path:res.output[0].entry.path,'a-link')
    assert.equal(res.output.length,limit===1?1:2)
    assert.equal(res.metadata.truncated,limit===1)
    assert.match(res.content,/duplicate paths merged/)
  }
})
test('root anchored ignore excludes only root file',async()=>{
  const sub=join(root,'sub'), top=join(root,'top.txt'), child=join(sub,'top.txt'), ignore=join(root,'.ignore')
  const seams={stat(p){return {isDirectory:()=>p===root||p===sub,isFile:()=>[top,child,ignore].includes(p),isSymbolicLink:()=>false}},realpath:p=>p,list:p=>p===root?['.ignore','top.txt','sub']:['top.txt'],read:p=>Buffer.from(p===ignore?'/top.txt'+String.fromCharCode(10):'match'),async assert(){}}
  const res=await authorizedSearch('grep',{pattern:'match'},invocation,root,root,seams)
  assert.deepEqual(res.output.map(m=>m.entry.path),[join('sub','top.txt')])
  const explicit=await authorizedSearch('grep',{pattern:'match',path:'sub'},invocation,root,root,seams)
  assert.deepEqual(explicit.output.map(m=>m.entry.path),['top.txt'])
  seams.read=p=>Buffer.from(p===ignore?'sub/top.txt':'match')
  const inherited=await authorizedSearch('grep',{pattern:'match',path:'sub'},invocation,root,root,seams)
  assert.deepEqual(inherited.output,[])
})
test('invalid glob range is query error even with no files',async()=>{
  const {seams}=fixture(); seams.list=()=>[]
  for(const pattern of ['[z-a]','foo[','{foo,bar']) await assert.rejects(authorizedSearch('glob',{pattern},invocation,root,root,seams),/range|invalid glob/i)
})

test('grep row limit is independent of walk entry budget',async()=>{
  const {seams}=fixture(); seams.read=()=>Buffer.from(('x'+String.fromCharCode(10)).repeat(200001));
  const res=await authorizedSearch('grep',{pattern:'x',path:'real',limit:200001},invocation,root,root,seams)
  assert.equal(res.output.length,200001); assert.equal(res.metadata.truncated,false)
})

for (const mode of ['allow','deny','unknown','absent','configured','linked']) {
  test(`global ignore ${mode}: precise authorization before content and native delegation if unavailable`, async()=>{
    const home=resolve('fixture-home'), xdg=join(home,'.config'), config=join(home,'.gitconfig'), ignore=join(xdg,'git','ignore'), custom=join(external,'custom-ignore')
    const {seams,events}=fixture()
    const stat=seams.stat, realpath=seams.realpath, read=seams.read, ask=seams.assert
    const sources=new Map(mode==='absent'?[]:mode==='configured'?[[config,'config'],[custom,'a.txt']]:mode==='linked'?[[ignore,'link'],[custom,'a.txt']]:[[ignore,'a.txt']])
    const approved=new Set()
    seams.stat=p=>{
      if(sources.has(p)) return {isDirectory:()=>false,isFile:()=>p!==ignore||mode!=='linked',isSymbolicLink:()=>p===ignore&&mode==='linked'}
      if(p===config||p===ignore||p===join(xdg,'git','config')) throw Object.assign(new Error('missing'),{code:'ENOENT'})
      return stat(p)
    }
    seams.realpath=p=>mode==='linked'&&p===ignore?custom:realpath(p)
    seams.assert=async req=>{
      if(req.action==='external_directory'&&req.resources[0].includes('fixture-home')&&['deny','unknown'].includes(mode)) throw new Error(mode)
      await ask(req); for(const r of req.resources) approved.add(r)
    }
    seams.read=p=>{
      if(!sources.has(p)) return read(p)
      assert.ok(approved.has(join(p===custom?external:p===config?home:join(xdg,'git'),'*').replaceAll(String.fromCharCode(92),'/')))
      events.push(['global-read',p]); return Buffer.from(sources.get(p))
    }
    seams.globalIgnore={home,xdg,parseConfig:()=>custom}
    seams.delegateNative=async()=>({delegated:true})
    const result=await authorizedSearch('grep',{pattern:'Ab.',literal:true},invocation,root,root,seams)
    if(['deny','unknown'].includes(mode)) {assert.deepEqual(result,{delegated:true});assert.ok(!events.some(e=>e[0].endsWith('read')))}
    else if(mode==='absent') assert.match(result.content,/duplicate paths merged/)
    else {assert.equal(result.output.length,0);assert.ok(events.some(e=>e[0]==='global-read'));assert.doesNotMatch(result.content,/fixture-home/)}
  })
}

// The native host launches rg from the effective target directory, not the
// plugin process cwd or necessarily the host location directory.
for (const [label, location, path, cwd] of [
  ['location', join(root,'real'), undefined, join(root,'real')],
  ['explicit relative directory', root, 'real', join(root,'real')],
  ['explicit absolute directory', root, join(root,'real'), join(root,'real')],
  ['explicit file', root, join('real','a.txt'), join(root,'real')],
]) {
  test(`global ignore effective cwd: ${label}`, async()=>{
    const {seams,events}=fixture()
    const home=resolve('fixture-home'), config=join(home,'.gitconfig'), ignore=join(cwd,'exclude.rules')
    const stat=seams.stat, read=seams.read
    seams.globalIgnore={home,parseConfig:()=> 'exclude.rules'}
    seams.stat=p=> p===config||p===ignore ? {isDirectory:()=>false,isFile:()=>true,isSymbolicLink:()=>false} : stat(p)
    seams.read=p=>{
      if(p===config||p===ignore) {events.push(['global-read',p]);return Buffer.from(p===ignore?'/a.txt':'config')}
      return read(p)
    }
    const result=await authorizedSearch('grep',{pattern:'Ab.',literal:true,path},invocation,location,root,seams)
    assert.deepEqual(events.filter(e=>e[0]==='global-read').map(e=>e[1]),[config,ignore])
    assert.equal(result.output.length,label==='explicit file'?1:0)
  })
}

for (const nested of [false,true]) test(`global ignore requires Git ancestry (nested=${nested})`,async()=>{
  const {seams}=fixture()
  const home=resolve('fixture-home'), config=join(home,'.gitconfig'), ignore=join(home,'.config','git','ignore')
  const stat=seams.stat, list=seams.list, read=seams.read
  seams.globalIgnore={home}
  seams.stat=p=>{
    if(p===config||p===ignore||p===join(home,'.config','git','config')) {
      if(p!==ignore) throw Object.assign(new Error('missing'),{code:'ENOENT'})
      return {isDirectory:()=>false,isFile:()=>true,isSymbolicLink:()=>false}
    }
    if(p===join(root,'.git')) throw Object.assign(new Error('missing'),{code:'ENOENT'})
    return stat(p)
  }
  seams.list=p=>p===root?list(p).filter(n=>n!=='.git'):nested&&p===join(root,'real')?[...list(p),'.git']:list(p)
  seams.read=p=>p===ignore?Buffer.from('a.txt'):read(p)
  const result=await authorizedSearch('grep',{pattern:'Ab.',literal:true,follow:false},invocation,root,root,seams)
  assert.equal(result.output.length,nested?1:2)
})
test('global excludes parser delegates ambiguous quoted whitespace instead of applying Git INI semantics',async()=>{
  assert.equal(parseGlobalExcludes(Buffer.from('[other]'+String.fromCharCode(10)+' EXCLUDESFILE = "~/custom"')), '~/custom')
  assert.throws(()=>parseGlobalExcludes(Buffer.from('[core]'+String.fromCharCode(10)+' excludesFile = "~/my rules"')), /Ambiguous/)
  const {seams,events}=fixture()
  const home=resolve('fixture-home'), config=join(home,'.gitconfig'), stat=seams.stat, read=seams.read
  seams.globalIgnore={home}
  seams.stat=p=>p===config?{isDirectory:()=>false,isFile:()=>true,isSymbolicLink:()=>false}:stat(p)
  seams.read=p=>{
    if(p!==config) return read(p)
    assert.ok(events.some(e=>e[0]==='assert'&&e[1].action==='external_directory'))
    events.push(['config-read',p]); return Buffer.from('[core]'+String.fromCharCode(10)+' excludesFile = "~/my rules"')
  }
  seams.delegateNative=async()=>({delegated:true})
  assert.deepEqual(await authorizedSearch('grep',{pattern:'Ab.'},invocation,root,root,seams),{delegated:true})
  assert.equal(events.filter(e=>e[0]==='config-read').length,1)
  assert.ok(!events.some(e=>e[0]==='read'))
})

for (const value of ['ignore~backup', '~/ignore~backup', '~other/ignore']) test(`global excludes ambiguous tilde delegates before candidate access: ${value}`,async()=>{
  assert.throws(()=>parseGlobalExcludes(Buffer.from('excludesFile = '+value)),/tilde expansion/)
  const {seams,events}=fixture()
  const home=resolve('fixture-home'), config=join(home,'.gitconfig'), stat=seams.stat, read=seams.read
  const inspected=[]
  seams.globalIgnore={home}
  seams.stat=p=>{inspected.push(p);return p===config?{isDirectory:()=>false,isFile:()=>true,isSymbolicLink:()=>false}:stat(p)}
  seams.read=p=>{
    if(p!==config) return read(p)
    assert.ok(events.some(e=>e[0]==='assert'&&e[1].action==='external_directory'))
    return Buffer.from('excludesFile = '+value)
  }
  seams.delegateNative=async()=>({delegated:true})
  assert.deepEqual(await authorizedSearch('grep',{pattern:'Ab.'},invocation,root,root,seams),{delegated:true})
  assert.ok(!inspected.some(p=>p.includes('~')))
  assert.ok(!events.some(e=>e[0]==='read'))
})
