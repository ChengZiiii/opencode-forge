# Design: crew-goal-conversion-relay

## Context

The crew→goal conversion mechanism (0.12.0) is intact but guidance-broken at three seams: the conversion output, the first post-arming turn, and the fold that dissolves subtask structure into criteria prose. The goal loop's Crew-layer directive exists only in idle continuation briefs with purely discretionary phrasing.

## Goals / Non-Goals

**Goals**
- The model's FIRST post-conversion turn knows the crew layer exists and how to re-arm it.
- The delegation structure (subtask titles + agent assignments) survives the fold into the goal contract.
- The continuation brief prefers orchestration when the contract is structured.

**Non-Goals**
- No new crew states, no new ask gates, no engine changes (the goal loop and crew engine are untouched).
- No schema change to `goal_write` (no subtasks field — the structure rides inside criteria/constraints text).
- No change to waves execution or close/abandon semantics.

## Decisions

### D1 — Relay lives in the conversion output text, not new state

The `crew_begin {execution: "goal"}` output gains three lines: (a) the goal loop may re-register the plan born-armed in ONE call, (b) preserve the subtask structure (titles + agents) inside the goal contract's criteria or constraints verbatim enough to survive, (c) a ready-to-adapt `crew_begin {objective, subtasks, execution: "waves"}` sketch naming the declared subtasks. Text-only — the conversion record file gains nothing (it already lists the subtasks verbatim).

*Alternative rejected*: teaching `goal_write` a `subtasks` field — a schema change in the goal contract parser/renderer for something the text can carry; rejected as scope creep for a guidance fix.

### D2 — Structure detection is deterministic and cheap

`goalBriefText` already holds `d.criteria` and `d.constraints`. Detection over their joined text: a `forge-<id>` mention (`/\bforge-[a-z0-9-]+\b/`) OR a numbered-list pattern (`/^\s*\d+[.).]/m`). When detected, the brief's crew-layer line is extended with a PREFER directive (re-register born-armed over self-executing the whole plan); when not, the existing discretionary line stands unchanged. No per-turn model judgment involved in the detection itself.

*Alternative rejected*: always-on strong directive — pushes orchestration onto goals that are genuinely single-threaded; the discretionary baseline stays for unstructured contracts.

### D3 — The prefer-directive keeps the loop's gates intact

The strengthened line reuses the existing one-call born-armed registration (`execution: "waves"` at registration — legal only under the governing goal) and the existing abandon-based re-shard path. No new vocabulary, so no new gate surface; the directive only biases WHICH path the model takes, not what is permitted.

## Risks / Trade-offs

- **Structure detection false positives** (a criterion that merely mentions a forge agent without needing delegation) → the prefer-directive says "prefer", the model can still self-execute with one line of reasoning; no gate forces either path.
- **Sketch staleness** (the output sketches `crew_begin` syntax that later drifts) → the sketch is composed from the same literal syntax the registration path validates; test asserts the sketch matches the current schema.
- **Conversion output length grows** → four additional lines on a decision that ends a workflow; acceptable.

## Migration

None — text-only; next host restart picks it up.
