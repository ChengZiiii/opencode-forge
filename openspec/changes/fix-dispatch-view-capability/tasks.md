# Tasks: fix-dispatch-view-capability

## 1. Fix

- [ ] 1.1 `src/dispatch-async.ts`: `DispatchClient.messages` optional;
      `pollChild` skips the messages leg when the method is absent (no
      messagesFailed); view-loss counting only on ACTIVELY failed legs;
      `fetchFinalMessage` returns the clean capability error on absence.
- [ ] 1.2 `plugin.ts` `v2SessionClient`: HTTP-backed messages reader —
      lazy `service.json` discovery ({url, password}), Basic auth,
      `GET {url}/api/session/{id}/message`, `location[directory]` from a
      per-child map captured at create (fallback: first known directory);
      tolerant array/{data} parsing; failures return `{error}`.

## 2. Tests

- [ ] 2.1 Capability-absent client: poll ticks never reach stream-lost;
      fetchFinalMessage → clean capability error (no "is not a function").
- [ ] 2.2 Regression: provided-but-failing messages + failing status still
      counts view loss exactly as before (existing semantics byte-for-byte).
- [ ] 2.3 v2 adapter: stubbed service.json + stubbed fetch → messages call
      hits the right URL/auth and parses both array and {data} shapes;
      missing service.json → adapter omits messages (absence, not throw).

## 3. Verify (③ GATE — sandbox, production-identical)

- [ ] 3.1 typecheck + full suite green; bundle.
- [ ] 3.2 `serve --service` sandbox (isolated XDG so service.json is
      sandbox-local), git+file plugin, pinned dispatch: wake contains the
      child's final report text; serve log has zero `is not a function`,
      zero unreadable-view disclosures, zero `final message unavailable`.

## 4. Release (④ GATE — npm ladder, user-authorized)

- [ ] 4.1 Version 0.32.1 → 0.32.2 (`chore: release 0.32.2`, dist committed).
- [ ] 4.2 `npm pack --dry-run` whitelist check → publish from the tgz →
      poll `dist-tags` until `latest = 0.32.2`; report shasum.
- [ ] 4.3 Quarantine the 0.32.1 host cache copy (rename into
      `_quarantine`, never delete).
- [ ] 4.4 User restarts; a real pinned dispatch completes with the final
      report text in the wake and none of the three defect strings.
- [ ] 4.5 D6 note: none — the whole leg is sandbox-verifiable this time.
