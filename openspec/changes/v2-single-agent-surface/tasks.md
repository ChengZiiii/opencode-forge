# v2-single-agent-surface — tasks

## 1. Sandbox probes (gating — 2.3.2, OPENCODE_CONFIG_DIR isolated)

- [x] 1.1 Deny-shapes-visibility probe — STATIC LEG DONE (binary,
  2026-11-20): `Tool.snapshot` skips blanket-denied tools from the
  model-facing inventory; `Tool.check` applies the same filter to the
  Code Mode catalog; hard rule recorded: never deny action `"execute"`
  (Code Mode kill switch). Live leg: end-to-end sandbox confirm that a
  deny-shell forge session offers no builtin shell while forge_shell
  executes.
- [x] 1.2 Ordering probe — CONFIRMED (sandbox P1, 2026-11-20,
  reports/probe-v2-surface-report.md): config-only agents are absent
  from the draft at plugin transform time; their config values appear
  only in the final records; a plugin `draft.default(...)` leaves zero
  observable trace and the user's `default_agent` survives. D3's
  override claim and D5's gate both hold.
- [ ] 1.3 Action-name + blast-radius probe (live leg): confirm the deny
  action id `shell` end-to-end (explore def + snapshot filter use the
  same namespace) and that the deny on forge-family records leaves
  non-forge agents' shell untouched. (Record-level leg confirmed by P3:
  the deny lands verbatim in the record's `permissions` array after the
  global allow, findLast makes it win. The tool-visibility leg is the
  4.1 E2E.)

## 2. Implement

- [x] 2.1 Native suppression in `v2Setup`'s agent transform:
  guarded `draft.update("build"|"plan", rec => rec.hidden = true)`,
  per-record try/catch, skip-if-absent/already-hidden, `hideNativeAgents`
  opt-out read from the global forge.json layer.
- [x] 2.2 Shell-deny front door: push the deny permission onto the
  forge primary record and every materialized `forge-*` record in the
  v2 registration path (all shapes), belt untouched. (Includes the
  field-name fix: v2 records carry `permissions` as an ARRAY of
  {action,resource,effect} entries — the old singular `permission`
  spelling never reached the host.)
- [x] 2.3 Default subject per D5 gate: probe 1.2 confirmed the
  ordering — `draft.default(FORGE_AGENT)` guarded by
  `typeof draft.default` ships (implemented as a standalone
  revert-ready block).
- [x] 2.4 README: v2 knob docs + v1 config recipe
  (`agent.build.hidden` / `agent.plan.hidden` / `default_agent`).

## 3. Tests

- [x] 3.1 v2-setup wiring: suppression matrix (record exists / absent /
  already hidden / knob off / one record throws), primary+worker
  records carry the shell deny, default setter called only under the
  confirmed guard. (Verified: 728/0 suite run, review report
  VERIFIED across the matrix.)
- [x] 3.2 `bun run typecheck` clean; `node --test tests/*.test.mjs` all
  green (v1 suites must not regress). (728 pass / 0 fail, exit 0 —
  gate run 2026-11-21.)

## 4. Verify + release

- [ ] 4.1 Sandbox E2E (`opencode serve` + live-loop): picker shows
  forge only; fresh session defaults to forge; forge session's tool
  surface has no builtin shell; forge_shell executes; belt still
  refuses a forced shell call.
- [ ] 4.2 `bun run bundle`; official-install verify per AGENTS
  (git+file → github → npm pack tgz); version bump + `npm publish`
  only after user approval.
