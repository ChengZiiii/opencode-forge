# Design — crew-native-fallback

## Context

Crew dispatch guards (plugin.ts ~2750-2830): family belt (non-forge → no forge-* targets), session-domain
pool gate (cross-pool → refuse with three exits), pending belt (unarmed crew → refuse everything),
compliance belt (crew-governed + forge-* target + non-compliant pool → refuse with fix copy). NATIVE
targets have never been refused for a forge-family session. The wave-discipline text (crew_begin arming
output, /crew template, goal-delegated brief) says "waves of parallel native task calls" but every
roster/discipline line steers to forge-* workers; the compliance refusal copy implies the only remedy is
repairing the pool. Result: in the two no-forge-worker situations the model either stalls or improvises
unrecorded.

This change was APPROVED in the five-change batch discussion as: 无可用 forge 池工人时 crew 派发回退原生
task 通道（回退披露，不硬拒）— disclosure over hard refusal.

## Goals / Non-Goals

**Goals**: make the native lane a taught, recorded crew fallback; keep every existing gate bit-identical;
keep the close gate unchanged (titles/verdicts/evidence govern).

**Non-Goals**: no guard relaxation (registration pre-flight still refuses non-compliant pools — the
pool-contract stance from pool-namespace-contract stands); no new crew record fields; no automatic
fallback selection logic (the dispatching model decides; the guidance teaches); no changes to the task
tool itself.

## Decisions

### D1 — Guidance + disclosure only; zero guard-diff (adopted)

Three text touchpoints gain the fallback rule (exact wording pinned in the delta): (1) the mid-crew
compliance refusal copy gains the native exit sentence; (2) the `crew_begin {execution:"waves"}` arming
output (standalone + born-armed + goal-delegated variants) carries the one-line rule; (3) the /crew
template's wave-discipline line. Guards: NO diff. This is the entire mechanism — the native lane already
exists mechanically; teaching it is the fix.

### D2 — Recording: wave notes + evidence wording, no schema change (adopted)

The crew record is a Markdown file written at registration; wave notes are the session's own narration
discipline (the wave text already asks for evidence verdicts). The fallback recording duty rides the
existing surfaces: the arming/wave text says "record the fallback in your wave notes; the subtask's close
evidence must say it ran native". `crew_close` accepts it because evidence is free text checked for
presence, not content. No `native: true` field — a schema change would ripple the gate, the record format
and every test for zero enforcement gain (the duty is honesty, not gating).

### D3 — Registration pre-flight stays a hard refusal (adopted, explicitly)

Relaxing `crew_begin`'s non-compliant-pool refusal was considered and REJECTED: the registration refusal
guards the pool CONTRACT (namespace integrity) before a crew exists, the mid-crew belt already provides
the native lane for an executing crew, and softening registration would let crews form around pools their
own author never made crew-legal. The approved fallback is about DISPATCH, not registration.

### D4 — Copy discipline (adopted)

The compliance refusal keeps its full fix copy and gains exactly one sentence naming the native exit;
the cross-pool refusal copy is NOT touched (its three exits are pool-configuration remedies — adding a
native lane there would blur "wrong pool" with "no worker"; a cross-pool target is a configuration error,
not a coverage gap). Tests assert the extended compliance copy verbatim-prefix so future wording drift
fails loudly.

### D5 — Rejected alternatives

- **Auto-fallback (engine rewrites the dispatch target).** Silent substitution is the opposite of
  disclosure; the dispatching model owns target choice. Rejected.
- **A `nativeSubtasks` allowlist per crew.** Pre-declaring which subtasks may run native adds a
  registration field and a new gate for no enforcement value. Rejected.
- **Leaving it to README only.** The refusing moment is where the model needs the exit — copy at the
  refusal point beats documentation. Rejected (README still documents, as support).

## Risks / Mitigations

- **Model over-uses native lane (ignores forge workers)**: the guidance frames native as the FALLBACK
  ("when no forge worker fits or forge dispatch is blocked"); the roster disclosure in every crew surface
  keeps forge workers first-class; the close evidence's "ran native" makes over-use visible at review.
- **Wording drift breaking spec-copy assertions**: tests pin the copy prefix verbatim (D4).
- **Interaction with crew-autonomous-waves (same batch)**: both touch crew_begin arming text — sequencing
  is sequential per change; the second change rebases on the first's text. Batch order in this repo:
  crew-autonomous-waves lands first; this change's wording applies on top.
