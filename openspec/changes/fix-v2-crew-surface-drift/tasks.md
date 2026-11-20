# fix-v2-crew-surface-drift — tasks

## 1. Probe (2.3.2)

- [ ] 1.1 Locate where `v2RegisterToolHooks`'s anchorClient comes from
  and hoist that seam into shared module state the crew tool can consume
  (guards identical to the belt's).
- [ ] 1.2 Probe the 2.3.2 client surface for child-session creation
  (what the SDK/plugin context actually exposes where `client.session.create`
  used to live — renamed method, different receiver, or absent). Record
  observed shapes in design.md D2 and pick the adaptation branch.

## 2. Implement

- [ ] 2.1 Crew gate anchor unification: `crew_begin` roster resolution,
  session binding, and crew record path go through
  `resolveSessionAnchorForPools`; tool-context anchor only on the
  no-client path (behavior identical to today there).
- [ ] 2.2 Task tool client adaptation per 1.2, with the honest
  degradation error (contract string naming the native task tool) when
  no seam resolves.
- [ ] 2.3 Child creation's parent directory resolves from the
  authoritative anchor (re-anchored parents → correctly-anchored
  children).

## 3. Tests

- [ ] 3.1 Anchor matrix (crew gate): authoritative pool-owning record
  beats a stale pool-less tool context (today's live failure becomes the
  regression); no-client fallback keeps today's resolution; fresh
  install with only a workspace pool passes the gate.
- [ ] 3.2 Task client guard tests: moved-seam probe adapts; absent seam
  returns the exact degradation string (asserted as a contract).
- [ ] 3.3 `bun run typecheck` clean; `node --test tests/*.test.mjs` all
  green (v1 and v2 suites, zero regressions).

## 4. Verify + release

- [ ] 4.1 Sandbox E2E on 2.3.2, workspace-pool-only (NO global forge.json
  on the test machine): full crew loop — register → arm waves → dispatch
  (plugin task tool) → report → crew_close; plus the re-anchored-session
  scenario (create session in a pool-less dir, move it, crew works).
- [ ] 4.2 `bun run bundle`; official-install verify per AGENTS
  (git+file → github → npm pack tgz); version bump + `npm publish` only
  after user approval.
