# Design: close-state-tool-belt-gap

## Context

See proposal.md — Why. The mechanism ground truth (all E2E-verified facts, not assumptions):

- Plugin-registered tools bypass permission evaluation; the only real gates are `context.ask()` dialogs the tools themselves raise (pitfalls 4.5, goal-mode design).
- The owner's host build ignores hook-injected agent `tools` maps (partition change R1): config-injected entries (the plugin-materialized `forge-*` workers among them) expose every plugin tool; only the `tool.execute.before` fallback belts constrain what actually runs.
- The belt family today covers two quadrants: non-forge → any forge tool (refused), forge family → builtin shell/bash (refused). Workers → STATE tools: no belt — this is the hole a verifier walked through to `goal_complete`.
- `sessionAgents` (sessionID → agent name) is fed by three sources: `chat.message` (primary, per-turn), `chat.params` (belt; fires for task-spawned sessions too, and always fires before a session's first tool executes because the producing model request triggers it), and the plugin-tool context (strongest, but only for forge tools).

## Goals / Non-Goals

**Goals:**

- One belt closing the worker → STATE-tools quadrant, in the existing `tool.execute.before` fallback block, with wording that teaches the out (report back to the orchestrating session).
- Zero behavior change on hosts that honor injected tools maps (belt is dead code there).

**Non-Goals:**

- No change to gate tools' ask design, tool descriptions, or goal/plan/crew file semantics.
- No fail-closed posture for unknown sessions (uniform family stance stays).
- No per-user opt-out for workers (explicit `tools.<state-tool>: true` on a worker entry keeps visibility on honoring hosts — the ignore-host belt stays unconditional, mirroring the non-forge belt's existing asymmetry).

## Decisions

### D1 Belt lives in `tool.execute.before`, alongside the other fallback belts

Same hook as the draft write-ban, crew pending gate, and partition belts: it fires in TUI and `run` mode alike, aborts the call by throwing, and needs no config. Alternative — refusing inside each STATE tool's `execute` — rejected: scattered across 13 tools, no single place for the partition wording, and belt timing (before ANY execution) is the guarantee the spec states ("never reaches a user confirmation dialog").

### D2 "Primary" = agent name exactly `forge`; everything else in the family is a worker

`speaker.toLowerCase() === "forge"` passes; any `forge-*` name is refused (family rules follow the name, not the author — a user-defined `forge-foo` is a worker, same as the injection treats it). Alternative — resolving the agent entry's `mode` at belt time — rejected: the belt only has the session→name mapping, and name-keyed family semantics is the partition's established vocabulary.

### D3 Scope is the full STATE list (13 tools), not just `goal_*`

The partition invariant is "STATE tools are primary-only" as a block. Narrowing to the incident's tool would re-open the identical hole through `plan_close` / `crew_close` / `goal_discard` — each also mutates orchestration state out of the orchestrator's hands.

### D4 Message wording carries the protocol, not just the refusal

`[forge:partition] Tool refused: "<tool>" is a harness state tool reserved for the primary forge agent; "<speaker>" is a forge worker. Report your findings back to the orchestrating session — the primary agent calls <tool> at the gate.` The worker's correct move under the task-tool contract is to RETURN its result; the message says so instead of inviting a retry.

### D5 Unknown sessions stay fail-open

The incident path always carries a mapping (`chat.params` fires for task-spawned sessions before their first tool executes). Fail-closed would deviate from every other belt and risks false refusals on hosts with unusual event ordering. Honest residual: on a mapping-blind host the call falls through to the ask-gate — same posture as the rest of the belt family; the gate remains the last barrier there.

## Risks / Trade-offs

- [Explicit worker opt-in diverges across host kinds] → On honoring hosts `tools.goal_complete: true` on a worker entry keeps the tool visible; on ignore-hosts the belt refuses anyway. Pre-existing family behavior (the non-forge belt is unconditional in exactly the same way); documented in README rather than fixed here.
- [A task-spawned session running agent `forge` passes the belt] → Accepted: the belt keys on the agent persona, not session lineage; goal tools are workspace-visible by design and the ask-gate still applies. No known host shape dispatches the primary agent as a subagent.
- [`sessionAgents` eviction mid-session flips a live worker to unknown] → Fail-open, same residual as D5; eviction only happens on `session.deleted`.

## Migration Plan

Purely additive belt + tests + docs; no state, no config surface, no tool registration change. Rollback = revert the commit. Verification ladder: unit wiring tests → full `node --test tests/*.test.mjs` → `bun run typecheck` → `bun run bundle` → manual install per AGENTS.md terminal-validation rule (`git+file://` ring).
