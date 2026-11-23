# crew-continue-native-child-gate — implementation report (tasks 2.1-2.6)

Worker: forge-plugindev-coder · Date: 2026-11-23 · Repo: opencode-forge

## Per-task evidence

| Task | What | Evidence |
| --- | --- | --- |
| 2.1 | `nativeChildrenInFlight` pure core, injectable `NativeChildClient` seam; list envelope tolerance (array \| `{sessions}` \| `{data}`), `parentID === sessionID` filter, `session.status()` cross-read (unwrap `.data`, keys = busy ids), terminal = absent-or-idle, **fail-OPEN** on any throw/unreadable shape (incl. absent `session.list`/`session.status`) | `src/native-child-gate.ts:31-73` |
| 2.2 | `NativeChildTracker` pure core: mark / terminalize-with-outcome / drop / forgetParent / runningChildren; sticky terminal verdicts; `lastChildTerminal` computed on each terminalize; `nativeChildDigestLine` (D7: interrupted ⇒ named DEAD). Wiring: `crewNoteNativeChildTerminal` records the digest for a recently-suppressed parent and re-arms `scheduleIdleContinuation(client, parentID, CREW_CHILD_RESUME_DEBOUNCE_MS=500)` on last-child-terminal; `noteCrewNativeChildEvent` classifies created / deleted / the three execution-terminal edges / `session.status` idle / `session.idle` tolerated alias | `src/native-child-gate.ts:76-152`; `plugin.ts:6148-6159`, `plugin.ts:6170-6209` |
| 2.3 | Feed wired into the EXISTING `v2SubscribeEvents` loop — one call after `v2EventFields(ev)`, before the existing if-chain; no new subscription/stream | `plugin.ts:9123-9126` |
| 2.4 | Ceiling: `CREW_NATIVE_CHILD_CEILING_MS` (env `FORGE_CREW_NATIVE_CHILD_CEILING_MS`, default 900_000), `crewNativeCeiling` map `{firstSuppressedAt, disclosed}`; expiry ⇒ send once + ONE bounded `console.warn` + stop suppressing for the registration (`disclosed: true` short-circuit); fresh `crew_begin` clears via `crewEngineForgetSession` (called at plugin.ts:5817); gate-open pass ends the episode (marker deleted) | `plugin.ts:6120`, `plugin.ts:6127`, `plugin.ts:6263-6287` |
| 2.5 | Gate hook in `continueCrewIfEligible` after `crewStalled` + family re-check, BEFORE `crewPendingTurn` accounting; the suppressed `return` precedes streak / transport-failure / ledger effects. Ceiling-expiry fall-through sends (a real turn) and only then accounts | `plugin.ts:6255-6287` (hook), suppressed return `plugin.ts:6283`, `crewPendingTurn` block after at `plugin.ts:6288+` |
| 2.6 | Eviction: `crewEngineForgetSession` clears tracker rows (`forgetParent`), ceiling marker, pending digest; `harvestSessionEnd` calls it (plugin.ts:6665); child `session.deleted` drops its own row via the feed; zero disk state (all maps in-memory); goal branch untouched (only `continueCrewIfEligible`, `crewContinueBrief` digest param, `scheduleIdleContinuation` optional debounce param — the last two keep their default behavior byte-identical for every existing caller) | `plugin.ts:6093-6105`, `plugin.ts:6179-6183`, `plugin.ts:6665` |

## How the digest rides the brief (D7 defect-B)

1. A suppressed nudge writes `firstSuppressedAt` into `crewNativeCeiling` —
   the suppression episode is now "recent".
2. Every terminal edge of a tracked child while the episode is live pushes
   `nativeChildDigestLine(childID, outcome)` into `crewChildDigest[parentID]`
   (`plugin.ts:6148-6159`). An `interrupted` child gets the explicit DEAD
   wording (abort disclosure) at the moment the plugin sees the event.
3. Last-child-terminal re-arms the engine with the short debounce (500ms,
   env `FORGE_CREW_CHILD_RESUME_DEBOUNCE_MS`) — a deferral never depends on
   a further idle event.
4. `crewContinueBrief(crew, childDigest)` appends a "Native child outcomes
   since the last brief" block, one line per child
   (`plugin.ts:6216-6228`); the digest is cleared ONLY on successful
   delivery (`plugin.ts:6329-6334`). The re-armed pass re-runs the full
   guard chain — the walk confirms the children are gone (terminal =
   absent/idle in the status map), so the gate opens and the brief carries
   the digest.

## Gates — BLOCKED (tool failure, reported verbatim)

Every shell attempt through the mandated `forge_shell` tool failed with:

```
spawn error: ENOENT: no such file or directory 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
```

(reproduced 5×, incl. `echo ok`, `cmd /d /c ...`, background mode — the
tool's fixed powershell spawn target does not exist on this host; no other
shell is in this worker's toolset by design, and no workaround was
improvised.) Consequently NOT run: `npm run typecheck`, `npm run bundle`
(dist NOT rebuilt), `npm test` (expected-failure enumeration for the test
wave — the new scenarios 3.1-3.7 do not exist yet in tests/, the parallel
worker owns tests/), and the `plugin:` COMMIT. The dispatch prompt's COMMIT
instruction is therefore NOT satisfied — verbatim failure above.

Mitigation performed instead: full static re-read of every edited region
(`src/native-child-gate.ts` whole; `plugin.ts` 6092-6334, 6665, 9123-9126,
9247) — no type/syntax anomalies; new code adds no `@opencode-ai` imports;
existing callers keep byte-identical defaults (`crewContinueBrief` optional
param, `scheduleIdleContinuation` optional debounce). Existing
`tests/crew-continue.test.mjs` stub clients have no `session.list`, and the
walk fails OPEN on a missing list — the existing scenarios should be
unaffected (unverified: no test run).

## Not satisfied / open

- `npm run typecheck` / `npm run bundle` / `npm test` / git commit — blocked
  by the forge_shell spawn failure above; must be run by the owner or a
  shell-capable worker before the ③ gate.
- Task 4.1/4.2 (verification, sandbox E2E) — out of this worker's scope.
- Tests 3.1-3.7 — parallel worker (tests/ untouched by this worker).
- Test seams provided for the wave: `setCrewNativeChildClockForTests`
  (plugin.ts:6137), exported `noteCrewNativeChildEvent` (plugin.ts:6170),
  `v2WiringSeam.crewNativeChildren/.crewNativeCeiling/.crewChildDigest`
  (plugin.ts:9247), and pure cores importable from `src/native-child-gate.ts`.
