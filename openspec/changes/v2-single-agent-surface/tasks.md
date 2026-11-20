# v2-single-agent-surface — tasks

## 1. Sandbox probes (gating — 2.3.2, OPENCODE_CONFIG_DIR isolated)

- [ ] 1.1 Deny-shapes-visibility probe: register a test agent with
  `{action:"shell", resource:"*", effect:"deny"}`; assert whether the
  model-facing tool list (prompt assembly) excludes the builtin shell
  while forge_shell still executes. Record the verdict in design.md D4 —
  if deny is execution-only, close the front-door slice as a documented
  limitation (belt stays) and update the delta before apply ends.
- [ ] 1.2 Ordering probe: plugin transform vs the config→agent merge
  (`id:"opencode.agent"`) — does an explicit user `agent.build.hidden:
  false` / `default_agent` survive the plugin's writes? Decides D3's
  override claim and D5's gate. Record observed order.
- [ ] 1.3 Action-name + blast-radius probe: confirm the deny action id
  for the builtin shell (`shell`; check whether a `bash` alias matters
  on 2.3.2) and that the deny on forge-family records leaves non-forge
  agents' shell untouched.

## 2. Implement

- [ ] 2.1 Native suppression in `v2Setup`'s agent transform:
  guarded `draft.update("build"|"plan", rec => rec.hidden = true)`,
  per-record try/catch, skip-if-absent/already-hidden, `hideNativeAgents`
  opt-out read from the global forge.json layer.
- [ ] 2.2 Shell-deny front door: push the deny permission onto the
  forge primary record and every materialized `forge-*` record in the
  v2 registration path (all shapes), belt untouched.
- [ ] 2.3 Default subject per D5 gate (only if 1.2 confirms):
  `draft.default(FORGE_AGENT)` guarded by `typeof draft.default`.
- [ ] 2.4 README: v2 knob docs + v1 config recipe
  (`agent.build.hidden` / `agent.plan.hidden` / `default_agent`).

## 3. Tests

- [ ] 3.1 v2-setup wiring: suppression matrix (record exists / absent /
  already hidden / knob off / one record throws), primary+worker
  records carry the shell deny, default setter called only under the
  confirmed guard.
- [ ] 3.2 `bun run typecheck` clean; `node --test tests/*.test.mjs` all
  green (v1 suites must not regress).

## 4. Verify + release

- [ ] 4.1 Sandbox E2E (`opencode serve` + live-loop): picker shows
  forge only; fresh session defaults to forge; forge session's tool
  surface has no builtin shell; forge_shell executes; belt still
  refuses a forced shell call.
- [ ] 4.2 `bun run bundle`; official-install verify per AGENTS
  (git+file → github → npm pack tgz); version bump + `npm publish`
  only after user approval.
