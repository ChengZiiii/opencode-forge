// Diagnostic probe plugin (CORRECT export shape: the host loads plugins via
// `export default { id, server }` — named `export async function server()` is
// silently ignored, which invalidated the first adaptive-key probe round).
//
// Logs every chat.params input (sessionID/agent/model + options before/after)
// to <tmp>/chatparams-probe.log AND injects the adaptive-key candidates with
// distinct marker words so the catch server can see which key the host
// transports: top-level effort="low", namespaced anthropic.output_config.effort
// ="medium". The forge plugin's own stamp (if any) appears as "xhigh".
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOG = join(tmpdir(), "chatparams-probe.log")
const line = (obj) => {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
  } catch {}
}

export default {
  id: "chatparams-probe",
  server() {
    line({ ev: "loaded" })
    return {
      "chat.params": async (input, output) => {
        const raw = input as unknown as Record<string, unknown>
        line({
          ev: "chat.params",
          sessionID: raw.sessionID,
          agent: raw.agent,
          model: raw.model,
          optionsBefore: JSON.parse(JSON.stringify(output?.options ?? {})),
        })
        if (!output.options) output.options = {}
        output.options.effort = "low"
        output.options.anthropic = {
          output_config: { effort: "medium" },
          thinking: { type: "adaptive" },
        }
        line({ ev: "chat.params.stamped", sessionID: raw.sessionID, optionsAfter: output.options })
      },
    }
  },
}
