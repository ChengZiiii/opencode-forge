// dispatch-v2-hostsignals task 1.1 probe plugin: create child sessions with
// `agent` / `model` keys on the v2 promise-layer session domain and read the
// records back. Runs as a COMMAND (invoked via HTTP) — doing session.create
// INSIDE setup deadlocks (setup runs during location activation; the create
// then requires the activating location — 2026-11-22 field reality, the
// no-lines/no-error hang in the first probe attempt). Logs everything to
// $HYPHEN_PROBE_LOG.
import { appendFileSync } from "node:fs"

const line = (obj) => {
  try {
    appendFileSync(process.env.HYPHEN_PROBE_LOG || "agent-binding-probe.log", JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
  } catch {}
}

export default {
  id: "agent-binding-probe",
  async setup(ctx) {
    line({ ev: "setup", hasCreate: typeof ctx?.session?.create === "function", hasGet: typeof ctx?.session?.get === "function" })
    if (typeof ctx?.command?.transform !== "function") return
    await ctx.command.transform(async (editor) => {
      editor?.add?.({
        name: "binding-probe",
        description: "probe: agent/model binding on session.create",
        execute: async () => {
          const readBack = async (id) => {
            try {
              return await ctx.session.get({ sessionID: id })
            } catch (e) {
              return { __err: String(e?.message ?? e).slice(0, 160) }
            }
          }
          // 1. bound create: agent + model
          try {
            const bound = await ctx.session.create({ title: "probe-bound", agent: "general", model: { providerID: "opencode", modelID: "probe-model", id: "opencode/probe-model" } })
            line({ ev: "create-bound-ok", record: bound })
            const rb = await readBack(bound?.id)
            line({ ev: "readback-bound", agent: rb?.agent, model: rb?.model, keys: rb ? Object.keys(rb) : null, err: rb?.__err })
          } catch (e) {
            line({ ev: "create-bound-err", name: e?.name, head: String(e?.message ?? e).slice(0, 220) })
          }
          // 2. unbound create (control)
          try {
            const plain = await ctx.session.create({ title: "probe-plain" })
            const rb = await readBack(plain?.id)
            line({ ev: "create-plain-ok", id: plain?.id, readbackAgent: rb?.agent, readbackModel: rb?.model })
          } catch (e) {
            line({ ev: "create-plain-err", name: e?.name, head: String(e?.message ?? e).slice(0, 220) })
          }
          // 3. bogus agent: does create refuse?
          try {
            const bogus = await ctx.session.create({ title: "probe-bogus", agent: "forge-nonexistent-xyz" })
            const rb = await readBack(bogus?.id)
            line({ ev: "create-bogus-ok", id: bogus?.id, readbackAgent: rb?.agent, note: "host ACCEPTED a bogus agent" })
          } catch (e) {
            line({ ev: "create-bogus-refused", name: e?.name, head: String(e?.message ?? e).slice(0, 220) })
          }
        },
      })
      line({ ev: "registered", name: "binding-probe" })
    })
  },
}
