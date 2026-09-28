# Design — auto-worker-inheritance

## Context

The dispatch roster's fatal flaw (0.4.0 postmortem) was zero-config model *selection* — picking a candidate from a catalog, where "configured ≠ usable". An Auto worker performs no selection: it inherits the parent session's model via the host's native spawn behavior, so the failure class cannot recur (the parent is running on the model by definition). The host already implements this inheritance for agent entries without a `model` field; the only blocker is our own validation.

## Decisions

- **D1 — Atomic pair, both directions (user ruling 2026-09-28).** `model` + `thoughtLevel` must be both-absent (Auto) or both-present (pinned). `thoughtLevel` without `model` is rejected symmetrically with model-without-thoughtLevel: a pinned depth on an inherited brain is a configuration the user did not think through, and ZCode's precedent (subagents declare model AND depth, or neither) is the contract we are matching.
- **D2 — Fail-soft at entry granularity (user ruling 2026-09-28).** A half-configured entry is skipped with an error finding naming the id and the missing half; siblings materialize untouched. Matches the existing fail-soft philosophy (smallest enclosing level, never a whole-file rejection).
- **D3 — Validation order: normalize, then pair-check.** Field-type validation runs first; a mistyped `model` or `thoughtLevel` (wrong type, or non-empty-string violation) is treated as absent for the atomic-pair check. Consequence: a pinned `model` with a typo'd `thoughtLevel` skips the whole entry (error finding) instead of materializing depthless — consistent with the strictness ruling; the old "mistyped optional costs only itself" scenario is deliberately retired.
- **D4 — Auto = omit the key, never a magic value.** No `"model": "auto"` string sentinel: omission is unambiguous, host-native, and keeps `model` a pure `provider/model` identity whenever present. Materialized entries for Auto workers carry no `model` key at all.
- **D5 — Snapshot semantics, documented not engineered.** Inheritance binds at dispatch time (the host snapshots the parent model into the child session); later primary model switches affect only future dispatches. This is host behavior — the plugin documents it and adds nothing.
- **D6 — Depth mirroring is out of scope.** An Auto worker runs at the provider's default depth. "Mirror the primary's current depth setting" would require parent-option snapshotting across sessions (chat.params on task-spawned children + parent linkage) — a separate change if real usage demands it. When the primary runs at provider default (the common case), Auto is already identical to ZCode's Auto.
- **D7 — Breaking change, declared.** Model-only entries that materialized under the old spec will now be skipped. README carries an upgrade note; the spec text itself states the rejection as intended behavior. No migration code (the plugin never writes user config — the user fixes the file; the error finding tells them exactly which half is missing).

## Risks / Trade-offs

- [Users with model-only entries lose those workers after upgrade] → error finding names the id + missing half; README upgrade note shows the one-line fix (add `thoughtLevel` or delete `model`).
- [Auto worker on a primary running an exotic model the task path handles poorly] → no new failure class: the parent is running that model successfully in the same session.
- [`agentDescriptionFor` wording drift between pinned/auto] → wiring test asserts both description shapes.

## Migration Plan

1. Validation + type change in forge-config.ts (normalize → pair-check).
2. Conditional materialization + description branch in dispatch-tiers.ts.
3. Wiring tests (v1 + v2), config tests, README, E2E.

## Open Questions

- None — both judgment calls were settled by the user before propose (D1, D2).
