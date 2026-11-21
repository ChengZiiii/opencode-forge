# worker-shell-session-allow

## Why

0.30.0's native-first materialization exposed a host defect that kills
every native worker's `forge_shell`. Workers compiled to workspace-layer
`.opencode/agent/*.md` register only at the PROJECT location, while a
plugin tool's `ctx.permission.assert` evaluates at the PLUGIN HOST's
location (v2.3.2 `packages/core/src/permission.ts`: `configured()` runs
`agents.resolve(agentID ?? session.agent)` against the host-anchor
registry; a miss falls back to `missingAgentPermissions` — a literal
deny-all ruleset — which short-circuits BEFORE saved rules, the
`permission.evaluate` hook, and any ask). Net effect: the bare refusal
`Permission denied: forge_shell`, zero host-log trace, and no rule of
any kind consulted.

This is production-verified, not inferred: a 5-channel elimination
matrix (md `permissions` exact + allow-all, config v1 `permission` map,
config v2 `permissions` rule array — hot-load confirmed — and tools-face
explicit enable) ALL failed identically
(`reports/probe-native-worker-shell-denial.md` §6,
`reports/research-plugin-tool-permission.md` §1). Primary forge sessions
are immune because the plugin registers the `forge` agent
programmatically into the host-anchor registry. The asymmetry: Session
store is global-scope (resolvable anywhere), Agent registries are
per-location.

Consequences if unfixed: every write worker under native mode is
command-dead (this silenced our own plugindev write workers the hour
0.30.0 shipped), and the 0.31.0 dual-change E2E cannot run (its
verifiers are write workers). No upstream fix exists: v2.3.2 is the
latest release, dev's `permission.ts` is byte-identical in this
mechanism, and no matching issue has ever been filed (research §3).

## What Changes

- **Session-rule rescue (v2 only).** For forge-family sessions the
  plugin ensures a session-scoped allow rule
  `{action: "forge_shell", resource: "*", effect: "allow"}` through the
  documented `ctx.session.update` surface. Session rules merge AFTER
  agent rules and evaluation is last-match-wins (v2.3.2
  `permission.ts` `configured()` + `evaluate()` `findLast`), so this
  rule overrides the missing-agent deny-all. Injected in two places:
  on the forge PRIMARY session (children inherit session rules at
  creation — official semantics) and, as a belt, on the worker session
  itself at its first `forge_shell` call (covers sessions created
  before injection).
- **Explicit deny is sacred.** The forge_shell posture snapshot now
  reads BOTH config shapes: legacy v1 `permission.forge_shell` and the
  v2 `permissions` rule array. An explicit `deny` in either shape → no
  injection anywhere and the existing plugin-side refusal (belt
  extended to the v2 shape).
- **Belt-in-depth fallback.** If the host assert still rejects with the
  bare no-reason deny AND the resolved posture is not an explicit deny
  (i.e. the rejection can only be the cross-anchor fallback), the call
  proceeds with a bounded `[forge:session-rescue]` finding. This covers
  hosts where `session.update` is unavailable or the injection failed;
  it never fires past an explicit user deny.
- **v1 domain untouched.** v1 materializes drafts programmatically
  (resolvable at the host anchor) and has no session domain — immune by
  construction.
- **README:** native-mode rescue disclosure, the workers-shell deny
  recipe, and an explicit note that session rules are host state (no
  new plugin filesystem writes).

## Impact

- `specs/tool-partition/spec.md` — MODIFIED requirement "Exec posture
  pass-through on the exec surface": adds the cross-anchor rescue
  channel, its deny-gate, and its disclosure to the pass-through
  contract (full requirement restated with all scenarios).
- `plugin.ts` — posture snapshot dual-shape; session-permission
  injection helper (read-back-merge, idempotent, fail-soft); primary
  injection at the v2 session prompt hook; worker belt at the
  `forge_shell` handler; fallback belt on the assert path; disclosure
  lines.
- `README.md` — disclosure + recipe.
- `tests/worker-shell-session-allow.test.mjs` — new suite (posture
  dual-shape, injection matrix, fallback matrix, wiring).
