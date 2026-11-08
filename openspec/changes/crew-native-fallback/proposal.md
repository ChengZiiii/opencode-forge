# Proposal: crew-native-fallback

## Why

Crew wave discipline text tells the session to dispatch `forge-*` workers — but two real situations
leave a crew with no usable forge worker: (a) the session's pool has no worker fitting a subtask's job
(e.g. a verifier-shaped subtask in a pool that only defines coders), and (b) mid-crew pool degradation
(non-compliant `pool` field) where the compliance belt refuses every `forge-*` dispatch until the file is
repaired. Today the MECHANICS already permit native (non-forge) task dispatch from an armed crew — no
guard refuses it — but nothing TELLS the model that: the discipline text and the compliance refusal copy
both read as if forge-* were the only lane, so a crew stalls or the model silently improvises without
recording the fallback.

## What Changes

- The native task channel becomes a FIRST-CLASS crew fallback, in guidance and disclosure:
  - The compliance belt's mid-crew refusal copy gains the native exit: while the pool is being repaired,
    dispatch the affected subtask through the NATIVE task channel with the same relay contract — the
    compliance belt gates `forge-*` dispatch only.
  - The `crew_begin {execution:"waves"}` arming output and the wave discipline text carry the one-line
    fallback rule: when no forge worker fits a subtask (or forge-* dispatch is blocked by a degraded
    pool), dispatch the native `general` subagent with the relay contract (change/artifact path, scoped
    prompt, evidence demands) and RECORD the fallback.
- Fallback dispatches are recorded: the wave notes in the crew record name any native fallback subtasks,
  and the `crew_close` report's evidence statement for a fallback subtask SHALL say it ran native (the
  close gate's cross-check is unchanged — titles and verdicts still govern).
- NO guard semantics change: the pool gate, compliance gate, pending belt, and dispatch belts keep their
  exact refusal conditions. Native targets were never refused and still are not; `forge-*` targets keep
  every gate. This change is guidance + disclosure + record-keeping.

## Capabilities

**Modified Capabilities:**

- `crew-harness` — MODIFIED requirement "Crew-governed dispatch pool-compliance gate" (the refusal copy
  gains the native exit; one scenario's THEN extends) + ADDED requirement "Native fallback dispatch in
  crew waves" (5 scenarios).

## Impact

- `plugin.ts` — the compliance refusal string (mid-crew belt), the `crew_begin` waves-arming output text,
  and the wave-discipline lines gain the fallback wording; no guard logic changes.
- `src/crew-gate.ts` — untouched (the gate keeps checking titles/verdicts/evidence; fallback is named in
  the evidence text, not a new field).
- `tests/` — `forge-subagents-wiring` / `hierarchical-pools` compliance-copy assertions updated for the
  extended refusal text; new assertions for the arming-output fallback line; a crew-gate test that a
  report whose evidence says "ran native" still closes.
- `README.md` — crew section: the native fallback lane + recording duty.
- `dist/index.js` — rebuilt.
