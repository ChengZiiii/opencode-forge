import test from "node:test"
import assert from "node:assert/strict"
import { createV2MockContext } from "./lib/v2-mock-context.mjs"
import { v2Setup } from "../plugin.ts"

// D9 fail-safe: a fake editor cannot prove host availability or external
// target authorization equivalence. Retain the original native definitions.
for (const names of [["grep", "glob"], ["glob"], []]) {
  test(`native search retained with registry containing ${names.join(",") || "neither tool"}`, async () => {
    const { ctx, state } = createV2MockContext()
    const definitions = new Map()
    for (const name of names) {
      const def = Object.freeze({
        id: name,
        name,
        namespace: "opencode",
        input: Object.freeze({ type: "object", properties: Object.freeze({ pattern: { type: "string" } }) }),
        output: Object.freeze({ type: "string" }),
        execute: () => { throw new Error("native search must not execute during setup") },
      })
      definitions.set(name, def)
      state.tools.set(name, def)
    }
    const original = ctx.tool.transform
    const updates = []
    ctx.tool.transform = (cb) => original((editor) => cb({ ...editor, update: (...args) => { updates.push(args); throw new Error("unexpected update") } }))
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => warnings.push(args.join(" "))
    let cleanup
    try {
      // Isolated fixture inputs: no host filesystem or model calls.
      cleanup = await v2Setup(ctx, { anchors: [], stat: () => null, readFile: () => "" })
      assert.deepEqual(updates, [], "unproven authority cannot install any override")
      assert.deepEqual(state.asserts, [], "setup makes no fabricated permission checks")
      assert.ok(warnings.some((line) => line.includes("[forge:search]") && line.includes("native tools retained")))
      for (const name of ["grep", "glob"]) assert.equal(state.tools.get(name), definitions.get(name))
      for (const name of ["forge_grep", "forge_glob"]) assert.equal(state.tools.has(name), false)
    } finally {
      cleanup?.()
      console.warn = warn
    }
    for (const name of ["grep", "glob"]) assert.equal(state.tools.get(name), definitions.get(name), "cleanup leaves builtin unchanged")
  })
}

for (const names of [["grep", "glob"], ["glob"], []]) {
  test(`local v2 registry overrides ${names.join(',') || 'neither'} in place`, async () => {
    const {ctx,state}=createV2MockContext()
    ctx.location={directory:process.cwd(),project:{directory:process.cwd()}}
    const outputs=new Map(names.map(name=>[name,{type:'array',items:{properties:Object.fromEntries((name==='grep'?['entry','line','offset','text','submatches']:['path','type']).map(k=>[k,{}]))}}]))
    for(const name of names) state.tools.set(name,{id:name,name,description:name,input:{type:'object',properties:{pattern:{type:'string'},literal:{type:'boolean',default:false},hidden:{type:'boolean',default:false}}},output:outputs.get(name),execute:async()=>{throw Error('native must not run during registration')}})
    const updates=[]
    const original=ctx.tool.transform
    ctx.tool.transform=cb=>original(editor=>cb({...editor,update:(name,fn)=>{updates.push(name);editor.update(name,fn)}}))
    const cleanup=await v2Setup(ctx,{anchors:[],stat:()=>null,readFile:()=>''})
    try {
      assert.deepEqual(updates,names)
      for(const name of names) {
        const tool=state.tools.get(name)
        assert.equal(tool.output,outputs.get(name))
        assert.equal(tool.input.properties.follow.default,true)
        if(name==='glob') assert.equal(tool.input.properties.hidden.default,true)
        else assert.equal(tool.input.properties.literal.default,false)
      }
      assert.deepEqual(state.asserts,[])
    } finally { await cleanup?.() }
  })
}
