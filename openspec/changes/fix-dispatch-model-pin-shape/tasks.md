# Tasks: fix-dispatch-model-pin-shape

## 1. Fix

- [ ] 1.1 `src/dispatch-async.ts`: create-body model record `id` = bare
      `modelID` (drop the `providerID + "/" + modelID` join).
- [ ] 1.2 Grep for any other site composing a qualified key into a model
      record `id` (dispatch core, v2 adapter passthrough, context-hook
      rewrite) — fix or document each as already-bare.

## 2. Tests

- [ ] 2.1 `tests/dispatch-hostsignals.test.mjs`: update create-body
      assertions — model record `{providerID, modelID, id: <modelID>}` with
      `id` bare; add an explicit assertion that `id` NEVER contains `/`.
- [ ] 2.2 Add a regression test pairing both pin sources (rosterModelPin
      direct + adopted-row re-spawn path) to the same seam so the two legs
      cannot diverge again.
- [ ] 2.3 Context-hook shape guard: assert the runtime rewrite leaves
      `id`/`modelID` bare (already-correct behavior pinned).

## 3. Verify (③ GATE — sandbox, real seam)

- [ ] 3.1 `bun run typecheck` + full `node --test tests/*.test.mjs` green.
- [ ] 3.2 `bun run bundle`; sandbox serve (isolated OPENCODE_CONFIG_DIR +
      XDG) with the fixed dist; pinned-model dispatch through the real
      create seam; `GET /api/session/:id` asserts stored `model.id` is the
      bare model id; serve log shows a two-segment select key (no tripled
      key anywhere).
- [ ] 3.3 Re-run the shape probe matrix (A/B/C) unchanged — A must now be
      produced by the FIXED code path (the probe's A variant is the old
      shape; the fixed core must emit B).

## 4. Release (④ GATE — npm ladder, user-authorized)

- [ ] 4.1 Version 0.32.0 → 0.32.1 (`chore: release 0.32.1` commit).
- [ ] 4.2 `npm pack --dry-run` whitelist check → `npm pack` → publish from
      the tgz → poll `dist-tags` until `latest = 0.32.1`.
- [ ] 4.3 Quarantine the host cache copy of 0.32.0; config already points
      at the npm specifier (no config surgery needed).
- [ ] 4.4 User restarts; real pinned dispatch to a pool worker completes
      (drain passes; report arrives). shasum/dist-tags reported for 对账.
- [ ] 4.5 D6 note: opportunistic adoption-leg re-kill on the real host when
      the next orphan occurs (adoption shares the fixed seam; not
      separately billable).
