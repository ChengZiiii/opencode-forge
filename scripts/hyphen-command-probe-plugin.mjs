// Historical (2026-11-26, retire-plugin-runtime): companion to historical command probe; not current command acceptance.
// v2-command-surface task 1.1 probe plugin: registers a hyphenated command
// ("forge-sync") on the v2 command domain and logs (a) the invocation input
// shape the host actually delivers, (b) whether the promise-layer prompt
// accepts a `delivery` key, to <tmp>/opencode/hyphen-probe/probe.log.
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOG = process.env.HYPHEN_PROBE_LOG || join(tmpdir(), "opencode", "hyphen-probe", "probe.log")
const line = (obj) => {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
  } catch {}
}

export default {
  id: "hyphen-command-probe",
  async setup(ctx) {
    line({
      ev: "setup",
      hasCommandTransform: typeof ctx?.command?.transform === "function",
      hasPrompt: typeof ctx?.session?.prompt === "function",
    })
    if (typeof ctx?.command?.transform !== "function") return
    try {
      await ctx.command.transform(async (editor) => {
        line({ ev: "editor", keys: Object.keys(editor ?? {}) })
        editor?.add?.({
          name: "forge-sync",
          description: "probe: hyphenated command name registration",
          execute: async (input) => {
            let inputClone
            try {
              inputClone = JSON.parse(JSON.stringify(input ?? {}))
            } catch {
              inputClone = String(input)
            }
            line({ ev: "execute-input", input: inputClone })
            const sid = typeof input?.sessionID === "string" ? input.sessionID : undefined
            if (!sid || typeof ctx.session?.prompt !== "function") {
              line({ ev: "skip", why: "no sessionID or prompt" })
              return
            }
            const delivery = input?.delivery
            try {
              await ctx.session.prompt({
                sessionID: sid,
                text: "PROBE turn (ignore)",
                ...(typeof delivery === "string" && delivery ? { delivery } : {}),
              })
              line({ ev: "prompt-ok", withDelivery: typeof delivery === "string" && Boolean(delivery) })
            } catch (e) {
              const msg = String(e?.message ?? e)
              line({ ev: "prompt-err", name: e?.name, head: msg.slice(0, 220) })
              if (typeof delivery === "string" && delivery) {
                try {
                  await ctx.session.prompt({ sessionID: sid, text: "PROBE turn (ignore)" })
                  line({ ev: "prompt-retry-ok", note: "delivery key dropped" })
                } catch (e2) {
                  line({ ev: "prompt-retry-err", name: e2?.name, head: String(e2?.message ?? e2).slice(0, 220) })
                }
              }
            }
          },
        })
        line({ ev: "added", name: "forge-sync" })
      })
      line({ ev: "transform-done" })
    } catch (e) {
      line({ ev: "transform-err", head: String(e?.message ?? e).slice(0, 300) })
    }
  },
}
