# fix-v2-crew-surface-drift — tasks

## 1. Probe (2.3.2)

- [x] 1.1 Locate where `v2RegisterToolHooks`'s anchorClient comes from
  and hoist that seam into shared module state the crew tool can consume
  (guards identical to the belt's).
- [x] 1.2 Probe the 2.3.2 client surface for child-session creation
  (what the SDK/plugin context actually exposes where `client.session.create`
  used to live — renamed method, different receiver, or absent). Record
  observed shapes in design.md D2 and pick the adaptation branch.

## 2. Implement

- [x] 2.1 Crew gate anchor unification: `crew_begin` roster resolution,
  session binding, and crew record path go through
  `resolveSessionAnchorForPools`; tool-context anchor only on the
  no-client path (behavior identical to today there).
- [x] 2.2 Task tool client adaptation per 1.2, with the honest
  degradation error (contract string naming the native task tool) when
  no seam resolves.
- [x] 2.3 Child creation's parent directory resolves from the
  authoritative anchor (re-anchored parents → correctly-anchored
  children).

## 3. Tests

- [x] 3.1 Anchor matrix (crew gate): authoritative pool-owning record
  beats a stale pool-less tool context (today's live failure becomes the
  regression); no-client fallback keeps today's resolution; fresh
  install with only a workspace pool passes the gate.
- [x] 3.2 Task client guard tests: moved-seam probe adapts; absent seam
  returns the exact degradation string (asserted as a contract).
- [x] 3.3 `bun run typecheck` clean; `node --test tests/*.test.mjs` all
  green (v1 and v2 suites, zero regressions).

## 4. Verify + release

- [ ] 4.1 Sandbox E2E on 2.3.2, workspace-pool-only (NO global forge.json
  on the test machine): full crew loop — register → arm waves → dispatch
  (plugin task tool) → report → crew_close; plus the re-anchored-session
  scenario (create session in a pool-less dir, move it, crew works).
  (E2E RUN 2026-11-21, reports/e2e-crew-surface-drift-report.md —
  **PARTIAL**: the decisive acceptance PASSED (crew registers in the
  fresh-install shape, no more "CREW IS NOT INITIALIZED"; the
  ctx.session.create dispatch seam works; the standing report contract
  closed the loop; crew_close reconciled) and the degraded re-anchor
  double-verdict holds — but TWO new implementation bugs surfaced and
  are queued as fixes: (1) arm-only `crew_begin {execution}` is refused
  by the tool schema — `subtasks` lacks `.optional()` in crewBeginTool,
  contradicting the tool's own description; (2) after a REAL
  `POST /api/session/:id/move` with `location.directory` verified
  changed, the crew gate still refuses naming the OLD directory — the
  authoritative anchor does not re-resolve after a move (the unit-mock
  passes but the live host disagrees; suspects: the
  effectiveWorktree-priority branch or a stale anchor-client read).
  Also recorded: host 500 `slice` bug on move with absolute
  forward-slash paths (reported upstream); sandbox isolation requires
  OPENCODE_TEST_HOME + OPENCODE_DB + serve CWD=workspace on 2.3.2,
  OPENCODE_CONFIG_DIR alone does NOT isolate the store.)
  (FIX RUN 2026-11-21, reports/fix-crew-e2e-bugs-report.md — both bugs fixed
  and live-retested: (1) `subtasks` is now `.optional()` in crewBeginTool's
  args (arm-only `{execution}` passes the host schema — live-armed in the
  retest); (2) post-move anchor re-resolution: the resolver prefers the
  host's `session.moved` event statement over the session.get record, which
  live-probing showed does not reflect moves; regression matrices (d)/(e)/(f)
  added, scenario B retest PASSED.)
- [ ] 4.2 `bun run bundle`; official-install verify per AGENTS
  (git+file → github → npm pack tgz); version bump + `npm publish` only
  after user approval.
