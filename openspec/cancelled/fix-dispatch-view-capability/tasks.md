# Tasks: fix-dispatch-view-capability

## 1. Fix

- [x] 1.1 `src/dispatch-async.ts`: `DispatchClient.messages` optional;
      `pollChild` skips the messages leg when the method is absent (no
      messagesFailed); view-loss counting only on ACTIVELY failed legs;
      `fetchFinalMessage` returns the clean capability error on absence.
- [x] 1.2 `plugin.ts` `v2SessionClient`: HTTP-backed messages reader —
      lazy `service.json` discovery ({url, password}), Basic auth,
      `GET {url}/api/session/{id}/message`, `location[directory]` from a
      per-child map captured at create (fallback: first known directory);
      tolerant array/{data} parsing; failures return `{error}`.
- [x] 1.3 (0.32.3, real-host proven 2026-11-23) `plugin.ts`
      `normalizeV2MessageRow`: the 2.3.2 session-message HTTP surface ships
      BARE rows ({id, time:{created,…}, type:"assistant"|"user"|"idle",
      content: part[] | text: string, finish?, error?}) — translate into
      the v1-like {info:{role,finish,error,time},parts} envelope the core
      reads. Un-normalized, `latestAssistant()` filtered EVERY row out and
      every dispatch-complete wake read "no assistant response found" even
      though the child's final text was in the store (1.2's reader passed
      the rows through raw; the first E2E judged the wake channel by the
      parent's NATIVE task-result text and missed it — corrected here).

## 2. Tests

- [x] 2.1 Capability-absent client: poll ticks never reach stream-lost;
      fetchFinalMessage → clean capability error (no "is not a function").
- [x] 2.2 Regression: provided-but-failing messages + failing status still
      counts view loss exactly as before (existing semantics byte-for-byte).
- [x] 2.3 v2 adapter: stubbed service.json + stubbed fetch → messages call
      hits the right URL/auth and parses both array and {data} shapes;
      missing service.json → capabilityPending (absence, not throw).
- [x] 2.4 (1.3) BARE-row fixtures: idle markers drop; assistant content
      maps 1:1 to parts; user top-level text becomes a text part;
      numeric epoch time tolerated; enveloped rows pass through untouched;
      fetchFinalMessage reads the final text from bare rows end-to-end;
      textless assistant row → the honest "no assistant text output"
      error (distinct from not-found). 909/909.

## 3. Verify (③ GATE — sandbox, production-identical)

- [x] 3.1 typecheck + full suite green; bundle. (905/905 then 909/909)
- [x] 3.2 `serve --service` sandbox (isolated XDG so service.json is
      sandbox-local), boot-time plugin load via config `plugins`
      (npm-cache layout `@sorenllm/opencode-forge@latest/<ts>` with a
      file: dep on the repo), pinned dispatch: worker completed a full
      GLM round and wrote the marker file; zero `is not a function`,
      zero unreadable-view disclosures in the serve log.
      HONESTY CORRECTION (2026-11-23): the first run was ticked on a
      flawed judgment — the verbatim-text evidence came from the parent's
      NATIVE task-result channel and the driver's own `MARKER IN WAKE:
      false` was overlooked; the plugin wake channel was actually
      scaffolded by the 1.3 row-shape defect. RE-RUN with 0.32.3 code and
      the corrected judgment (scan the parent session for the
      `[forge:dispatch-complete]` message, bare user-row text field):
      `Final report:` carried the child's actual final text verbatim
      (`VIEW-E2E-OK … No tool refusals.`), zero scaffold strings.
      Sandbox layout notes that
      stand: the host chdirs to USERPROFILE and that directory becomes
      the anchor — fake home = the workspace itself; dir-scan lazy-loaded
      plugins register agents that the EXECUTION layer cannot resolve.

## 4. Release (④ GATE — npm ladder, user-authorized)

- [x] 4.1 Version 0.32.1 → 0.32.2 (`chore: release 0.32.2`, dist committed).
      SUPERSEDED same day: 0.32.2 is burned (1.3 row-shape defect shipped
      in it — wakes still scaffolded) → 0.32.3 carries 1.3; burned versions
      are never reused.
- [x] 4.2 0.32.2: `npm pack --dry-run` whitelist (4 files) → published from
      the tgz (shasum a1e21dee3acd3d4d2c594bbce30be178597cc8a1) →
      `dist-tags.latest = 0.32.2` confirmed; 0.32.1 cache copy renamed into
      `_quarantine`. 0.32.3 ladder re-runs this row.
- [x] 4.3 0.32.3: pack/publish/poll + shasum report (c560a83e0804b4640a7a
      012bdcb43d13e7051802, latest flipped); quarantine the 0.32.2
      cache copy (1795368019969 → _quarantine).
- [ ] 4.4 User restarts; the judgment channel is the PLUGIN wake — an
      `[forge:dispatch-complete]` block whose `Final report:` carries the
      child's final text verbatim (NOT the native task-result text), zero
      defect strings in the host log.
- [ ] 4.5 D6 note: none — the whole leg is sandbox-verifiable this time.
