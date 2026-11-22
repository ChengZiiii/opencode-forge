# Proposal: fix-dispatch-model-pin-shape

## Why

Pinned-model child sessions die at host drain with a tripled model key.
Production evidence 2026-11-22: adopted wish j-20261120-051455-tt3x0o
(forge-plugindev-e2e-verifier, pin `glm-coding-worker/glm-5.3`) spawned and
its child session ended in `Model unavailable:
glm-coding-worker/glm-coding-worker/glm-5.3` (host log: `SessionRunnerModel.
select` → `ModelUnavailableError`), with a same-second unhandled
`SchemaError(Expected object)`.

Root cause pinned by a three-variant sandbox probe against 2.3.2 (2026-11-22,
`Temp/opencode/probe-model-shape.mjs`): the host's session model record keeps
`id` VERBATIM from the create body and composes the runner select key as
`providerID + "/" + id`. The dispatch core sends
`{providerID, modelID, id: "provider/model"}` (full key in `id`), so the
composed key is tripled. The bare-id and no-modelID variants compose the
clean `provider/model` key. The task-1.1/2.1 probes that "proved" the shape
only observed the record echoing the create body back — they never exercised
the runner select, which is why the defect shipped (D6 debt: the real-host
create-with-pin leg was recorded as unbilled in tasks.md 1.2/5.2 and came due
in production).

## What Changes

- **MODIFIED**: the create-time model record contract in `Agent-bound child
  creation with pre-spawn validation` — `id` SHALL be the bare model id
  (`modelID`), never the provider-qualified key; the host composes the
  qualified key itself. `src/dispatch-async.ts` is the single seam every
  `modelPin` consumer flows through.
- **MODIFIED** (same delta, documentation of an already-correct shape): the
  v2 runtime pin context-hook rewrite writes `id` = bare model id, which
  matches the host contract; it stays unchanged and is now covered by a test
  assertion so the two shapes cannot drift apart again.
- Tests: the dispatch-hostsignals create-body assertions are updated to pin
  the bare-id contract (the old assertions pinned the defective shape and
  passed — a self-confirming test is part of the root cause).

## Impact

- Specs: `specs/forge-subagents/spec.md` (one MODIFIED requirement, full
  scenario set carried).
- Code: `src/dispatch-async.ts` (one line: `id` value), tests
  (`tests/dispatch-hostsignals.test.mjs`).
- Release: patch 0.32.1 through the full ③ sandbox → ④ npm ladder.
- Every pinned-model dispatch leg benefits: direct task dispatch, queue
  re-spawn, and post-restart adoption (the leg that failed in production).
