// forge-dispatch-probe: load-bearing assumption probes (P1-P3) for the forge
// dispatch design. Logs everything to <tmp>/forge-dispatch-probe/logs/.
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const LOG_DIR = join(tmpdir(), "forge-dispatch-probe", "logs")
mkdirSync(LOG_DIR, { recursive: true })
const log = (file, obj) => {
  try {
    appendFileSync(join(LOG_DIR, file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
  } catch {}
}

export default {
  id: "forge-dispatch-probe",
  server(input) {
    log("plugin.log", {
      ev: "server-init",
      serverUrl: String(input.serverUrl ?? ""),
      hasClient: !!input.client,
      worktree: input.worktree,
    })
    return {
      config(cfg) {
        cfg.agent ??= {}
        if (!cfg.agent["probe-scout"]) {
          cfg.agent["probe-scout"] = {
            description: "Probe readonly scout agent (whitelist permission)",
            mode: "all",
            hidden: true,
            prompt:
              "You are a probe agent. Follow the user's instructions literally. When a tool call is refused, report the refusal text verbatim instead of improvising another way.",
            permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" },
          }
        }
        if (!cfg.agent["probe-builder"]) {
          cfg.agent["probe-builder"] = {
            description: "Probe builder agent (write/edit/bash allowed)",
            mode: "all",
            hidden: true,
            prompt:
              "You are a probe agent. Follow the user's instructions literally. When a tool call is refused, report the refusal text verbatim instead of improvising another way.",
            permission: { write: "allow", edit: "allow", bash: "allow", read: "allow", glob: "allow", grep: "allow", list: "allow" },
          }
        }
        if (!cfg.agent["probe-scout2"]) {
          cfg.agent["probe-scout2"] = {
            description: "Probe scout v2 (deny-list permission, omo style)",
            mode: "all",
            hidden: true,
            prompt:
              "You are a probe agent. Follow the user's instructions literally. When a tool call is refused, report the refusal text verbatim instead of improvising another way.",
            permission: { write: "deny", edit: "deny", bash: "deny", task: "deny", apply_patch: "deny" },
          }
        }
        if (!cfg.agent["probe-scout3"]) {
          cfg.agent["probe-scout3"] = {
            description: "Probe scout v3 (deny-list WITHOUT task deny)",
            mode: "all",
            hidden: true,
            prompt:
              "You are a probe agent. Follow the user's instructions literally. When a tool call is refused, report the refusal text verbatim instead of improvising another way.",
            permission: { write: "deny", edit: "deny", bash: "deny", apply_patch: "deny" },
          }
        }
        if (!cfg.agent["probe-scout4"]) {
          cfg.agent["probe-scout4"] = {
            description: "Probe scout v4 (tools boolean off, no permission key)",
            mode: "all",
            hidden: true,
            prompt:
              "You are a probe agent. Follow the user's instructions literally. When a tool you need is not available, say exactly: TOOL-UNAVAILABLE: <name> instead of improvising another way.",
            tools: { write: false, edit: false, bash: false, task: false },
          }
        }
        log("plugin.log", { ev: "config-hook", agents: Object.keys(cfg.agent ?? {}) })
      },
      async "chat.params"(input, output) {
        log("chat-params.log", {
          ev: "chat.params",
          sessionID: input.sessionID,
          agent: input.agent,
          model: `${input.model?.providerID ?? "?"}/${input.model?.modelID ?? "?"}`,
          optionKeys: Object.keys(output.options ?? {}),
        })
        try {
          output.options.__probeStamp = "chat-params-fired"
        } catch {}
      },
      tool: {
        probe_ping: {
          description:
            "Probe tool (no arguments). Returns a fixed string proving plugin tools execute in this session. Call it when asked to verify plugin tool execution.",
          args: {},
          execute: async (_args, ctx) => {
            log("tool-exec.log", { ev: "probe_ping", sessionID: ctx.sessionID, agent: ctx.agent, directory: ctx.directory })
            return { title: "probe_ping", output: `probe_ping OK session=${ctx.sessionID} agent=${ctx.agent}` }
          },
        },
      },
      async "tool.execute.before"(input) {
        log("tool-before.log", { ev: "before", tool: input.tool, sessionID: input.sessionID, callID: input.callID })
      },
      async "permission.ask"(input, output) {
        log("permission-ask.log", {
          ev: "permission.ask",
          sessionID: input?.sessionID,
          id: input?.id,
          type: input?.type,
          name: input?.name,
          status: output.status,
        })
      },
    }
  },
  setup() {
    log("plugin.log", { ev: "setup-init" })
  },
}
