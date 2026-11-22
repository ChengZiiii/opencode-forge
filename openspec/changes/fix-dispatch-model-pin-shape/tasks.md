# Tasks: fix-dispatch-model-pin-shape

## 1. Fix

- [x] 1.1 `src/dispatch-async.ts`: create-body model record `id` = bare
      `modelID` (drop the `providerID + "/" + modelID` join). Field reality:
      the host stores `id` verbatim (probe: variant A stored the full key
      and the runner composed the tripled key; B/C stored bare and composed
      clean) — commit 15e013d.
- [x] 1.2 Grep result: one composing site total (`src/dispatch-async.ts`).
      The other full-key joins are different surfaces — `modelDepthShape`
      (models.dev catalog lookup key, legitimately qualified), the depth
      trace log line, and the roster frontmatter `model:` string (host
      parses agent frontmatter itself). The v2 context-hook rewrite already
      wrote bare `id` (matches the host contract; now pinned by comment +
      shared parseIdentity contract).

## 2. Tests

- [x] 2.1 `tests/dispatch-hostsignals.test.mjs`: create-body assertion
      updated to `{providerID, modelID, id: <modelID>}` + explicit
      `id`-contains-no-`/` regression guard (the old assertion pinned the
      defective shape and passed — self-confirming, noted in proposal).
- [x] 2.2 Pairing test added: a provider-qualified pin parsed through
      `parseIdentity` (the shared contract of `rosterModelPin` and the
      adopted-row re-spawn) lands bare through the same
      `createChildSession` seam — the two legs cannot diverge.
- [x] 2.3 No v2 context-hook test harness exists; the hook already writes
      bare `id` (verified by read) and shares `parseIdentity` with the
      tested seam. Pinned by a contract comment at the rewrite site
      instead of a new harness (honest note, not silently skipped).

## 3. Verify (③ GATE — sandbox, real seam)

- [x] 3.1 typecheck EXIT=0; full suite 896/896 (was 895 +1 pairing test).
- [x] 3.2 Sandbox serve (isolated OPENCODE_CONFIG_DIR + XDG, git+file://
      entry — the file:// config entry is SILENTLY DROPPED by 2.3.2, second
      confirmation of the sandbox-verification lore): agent-bound parent
      (forge + glm-5.3-flash at create) dispatched a pinned pool worker;
      child session record `model.id` = `"glm-5.3-flash"` (bare); child
      completed a real turn (`pong`); serve log contains no tripled key.
      Driver: `Temp/opencode/e2e-pin-dispatch2.mjs` (run 2026-11-22).
- [x] 3.3 Shape probe matrix (A/B/C) run pre-fix: A (old shape) tripled,
      B/C clean — the fixed core now emits the B shape by construction and
      the 3.2 dispatch proves it through the real seam.

## 4. Release (④ GATE — npm ladder, user-authorized)

- [ ] 4.1 Version 0.32.0 → 0.32.1 (`chore: release 0.32.1` commit).
- [ ] 4.2 `npm pack --dry-run` whitelist check → `npm pack` → publish from
      the tgz → poll `dist-tags` until `latest = 0.32.1`.
- [x] 4.3 Quarantine the host cache copy of 0.32.0; config already points
      at the npm specifier (no config surgery needed).
- [ ] 4.4 User restarts; real pinned dispatch to a pool worker completes
      (drain passes; report arrives). shasum/dist-tags reported for 对账.
- [ ] 4.5 D6 note: opportunistic adoption-leg re-kill on the real host when
      the next orphan occurs (adoption shares the fixed seam; not
      separately billable).

## Archive order

This change MODIFIES a requirement introduced by `dispatch-v2-hostsignals`
(still unarchived): archive that one FIRST, then this one, or the archive
refusal fires (validate noted: "MODIFIED ... header not found" until the
source requirement reaches the live specs).

