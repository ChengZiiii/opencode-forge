# fix-v2-anchor-field-reality — design

## Field reality (probe evidence, opencode 2.3.2)

Recorded from a temporary probe plugin executed on the live 2.3.2 host
(service pid context, 2026-11-20):

- `ctx.location.directory` → **string property** (e.g.
  `"C:\Users\Soren\Desktop\AgentWorkCommon\opencode_plugin_dev"`), NOT a
  zero-arg function.
- `ctx.location.worktree` → **absent** (undefined; no such field on the
  2.3.2 location domain).

The prior guard treated "not callable" as "not a usable anchor" and
dropped the field entirely. With the only usable candidate being a
string property, anchor resolution had zero candidates and skipped
pool materialization silently — the guarded degradation path made the
plugin look healthy (setup resolved, no throw) while its entire worker
pool was missing.

## Shape contract

`v2AnchorCandidates` reads a field as usable when it is either:

- a zero-arg function (invoked for the value — unchanged prior behavior),
- or a non-callable value used directly as the anchor string.

Absent (`undefined`) fields are not candidates; resolution falls through
to the next candidate and, when all are absent, skips that anchor group
without throwing (existing skip-silently semantics, unchanged).

## Verification trail

- `tsc` type-check + full test suite (717 tests) green.
- Packaged and released as `@sorenllm/opencode-forge@0.27.1`; registry
  tarball verified.
- Live: `opencode service restart` on the affected host →
  `/api/plugin` shows forge 0.27.1 active with no duplicate-ID failure;
  `/api/agent?location[directory]=<workspace>` lists all five
  `forge-plugindev-{spec-reviewer,coder,test-coder,gate-verifier,e2e-verifier}`
  workers; the forge tool belt (15 tools + task) present in-session.
