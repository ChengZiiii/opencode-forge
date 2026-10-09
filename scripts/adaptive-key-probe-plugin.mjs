// Micro probe plugin for the adaptive-key experiment: injects CANDIDATE
// option keys into every chat.params call so the catch server can observe
// which of them the host actually transports to the anthropic wire.
// Distinct marker words disambiguate the surviving key on inspection:
//   reasoningEffort = "xhigh"  (injected by the forge plugin itself)
//   effort          = "low"    (top-level candidate)
//   anthropic.output_config.effort = "medium" (provider-namespaced candidate)
export async function server() {
  return {
    "chat.params": async (_input, output) => {
      if (!output.options) output.options = {}
      output.options.effort = "low"
      output.options.anthropic = {
        output_config: { effort: "medium" },
        thinking: { type: "adaptive" },
      }
    },
  }
}
