# E2E probe evidence ！ task 1.1 (host tools-filter on plugin tools)

Setup: OPENCODE_CONFIG_DIR=<temp>/partition-probe/config, plugin file://<repo>, provider glm-coding-worker/glm-5.3-flash.

- Config agents: probeagent {tools:{forge_shell:false}}, probecontrol {}, explore {tools:{forge_shell:false}} (minimal entry on native agent).
- GET /agent: explore stays native=True, mode=subagent, native prompt intact (873 chars) ！ minimal entries MERGE by name, no native-definition loss. /agent exposes no tools field (filtering needs runtime evidence).
- Control (probecontrol, no hide): `opencode run --agent probecontrol "Call forge_shell ..."` -> toolcall attempted: `! permission requested: forge_shell (*); auto-rejecting` + `? forge_shell {"command":"echo probe-control"} failed` -> plugin tool present in toolset.
- Treatment (probeagent, forge_shell hidden): same prompt -> model replies exactly `NO_FORGE_SHELL` -> plugin tool absent from toolset.

VERDICT: the host applies agent `tools` filtering to plugin-registered tools. Load-bearing assumption holds; no fallback path needed.

# E2E evidence ！ sandbox runs (tasks 3.x/4.x/5.4), paseo host build 1.18.32

Isolation: fake USERPROFILE/HOME (no user config, no npm forge copy) + OPENCODE_CONFIG_DIR sandbox + plugin file://<repo> (fresh dist).

- Default subject (D13): bare `opencode run` header = `> forge` (default_agent pinned; was `> build` before the pin). Config dump: `default_agent: "forge"`, `cfg.agent.forge.tools = {shell:false, bash:false}`, keys = plan, build, general, explore, forge, forge-research.
- HOST DEVIATION found: this paseo build ignores `tools` maps on hook-INJECTED agent entries (file-configured entries are honored ！ verified both ways). Applied design R1 fallback: partition degrades to hard refusals here.
- Forge session (pure-injection form): builtin bash call -> `[forge:partition] Builtin shell refused: the forge family executes through forge_shell ...` (no process spawned); model re-issued via forge_shell -> toolcall attempted (run-mode ask gate auto-rejects; gate semantics intact).
- Build session: forge_shell call -> `[forge:partition] Tool refused: "forge_shell" belongs to the forge agent family and the current agent ("build") is outside it...`; system prompt check -> `PROMPT_FORGE:NO` (zero forge-authored text).
- forge.json fail-soft cross-check: a BOM-prefixed forge.json produced a located parse error and an empty agent set (no crash).

Unit: 246/246 (node --test tests/*.test.mjs), tsc clean, bundle 0.60 MB self-contained, npm pack --dry-run = 3 files per whitelist.
