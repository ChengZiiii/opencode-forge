# v2-plugin-api-port

## Why

OpenCode V2 is stable and community adoption is accelerating. It
intentionally does not run V1 plugin implementations, and forge's V2 entry
is still the defensive skeleton written when V2 had no tool, permission,
session, or command domains — on a V2 host, forge would load as a
bare agent registrar with no exec surface, no harness tools, no gates, no
goal engine: effectively absent. A quality precedent now exists: the
oh-my-openagent port (issue #8485, maintainer-completed 2026-10-18,
shipped as the 5.x line) demonstrates a runtime-verified staged migration
of a plugin two orders of magnitude larger, against exactly the API
surface forge needs. This change ports forge to full V2 parity following
that playbook, under the shared conventions in
`../opencode-v2-migration-conventions.md`.

## What Changes

- Upgrade the `setup` entry from the defensive skeleton (agent
  registration only, single-workspace pool resolution) to full V2 feature
  parity, keeping the V1 `server` entry untouched:
  - **Agent materialization**: the complete sole-pool-ownership resolver
    (workspace pool + global fallback, namespace materialization
    `forge-<ns>-<id>`, pinned models, provenance descriptions, shape
    permissions, create-only semantics) replaces the simplified
    single-workspace resolution.
  - **Tool surface**: all ~20 tools (`forge_shell`, `forge_jobs`,
    plan_\*, goal_\*, crew_\*, task, grep/glob) register via
    `ctx.tool.transform` with JSON Schema argument contracts.
  - **Permission gates**: the belt (draft write-freeze, plan/goal/crew
    double gates, crew pending + pool-compliance belts, worker→STATE
    primary-only refusals, status-file boundaries) moves to
    `ctx.permission.hook("evaluate")` — the ask-rewrites that make user
    dialogs the gates must produce ask outcomes on V2.
  - **Session seams**: `tool.execute.before` (activity marking, dispatch
    guards, readonly-exec seal) → `ctx.tool.hook("execute.before")`;
    `chat.message` + `chat.params` + system transform (family mapping
    three-source capture, thoughtLevel injection, forge system
    injections, channel mandate) → `ctx.session.hook("prompt")` /
    `ctx.session.hook("context")`; compaction goal-brief reinjection →
    `ctx.session.hook("compaction")`.
  - **Commands**: `/plan` `/goal` `/crew` register via the V2 command
    domain.
  - **Continuation engines**: goal idle continuation + job-wake delivery
    + `session.deleted` harvest move to `ctx.event.subscribe()` with
    cleanup; session reads (`client.session.*`) move to the V2 session
    domain.
  - **`experimental.compaction.autocontinue`**: no direct V2 equivalent —
    re-evaluated in the sandbox against V2's actual compaction/continuation
    behavior; if V2 has no synthetic auto-continue, the suppression is
    dropped with the finding documented (the goal-brief compaction
    reinjection remains the compression-safety carrier).
- Keep structural typing (no `@opencode/plugin` runtime import); guarded
  no-op degradation on shape drift, as today.
- Extend the manifest `engines.opencode` range to `^1.18.0 || ^2.0.0`.
- Verify in staged waves on a sandboxed real V2 host binary per the
  shared sandbox protocol; the V1 suite stays green at every wave gate.

## Capabilities

### New Capabilities

<!-- none: parity lands as a MODIFIED requirement in forge-agent -->

### Modified Capabilities

- `forge-agent`: the "v2 forward-compatible registration" requirement is
  rewritten — the V2 loader now carries the full feature surface through
  the V2 domains (the "v2 has no domain for them" prohibition is
  obsolete), keeping create-only agent semantics and silent
  shape-drift degradation.

## Impact

- `plugin.ts`: the `setup` entry grows substantially; shared internals
  (`src/*` — pool resolver, crew gate, goal/plan file cores, job runner,
  watchdog, exec classify) are host-agnostic, fs-injectable, and reused
  as-is.
- `package.json`: `engines.opencode` range (no new dependency).
- `README.md` / `AGENTS.md`: V2 install + dual-entry architecture notes.
- `tests/*.test.mjs`: a V2 mock-context harness (wired + drifted shapes
  per registration); the V1 suite (640 tests) must stay green at every
  stage.
- `dist/index.js`: rebuilt, still self-contained.
- No host-side breaking change: V1 hosts keep the exact current behavior;
  the plugin continues to support both loaders from one package.
