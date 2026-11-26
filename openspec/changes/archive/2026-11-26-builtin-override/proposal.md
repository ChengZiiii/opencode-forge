# builtin-override

## Why

The host ships two built-in subagents — **General** and **Explore**
(verified live on 2.3.2 via `/api/agent`: both `mode: subagent`,
visible). With native-first-roster landed, forge.json is the
configuration layer over native agent files, and the host already
merges same-name definitions (project-wins-scalars, permissions
spliced). That opens a zero-seam way to make the built-ins
configurable: a GLOBAL forge.json with same-name entries compiles to
`general.md` / `explore.md` — the built-ins' exact ids, LOWERCASE
(probe 2026-11-21: the identity key is the agent id = filename stem,
case-sensitive; only the lowercase stem truly overrides) — in the
host's global agent dir, overriding
the built-ins machine-wide — pin a model, pin a depth word, reshape.
Not configured = official behavior (the Auto worker inherits the
primary model and its depth, which IS the built-in default).

Owner direction (2026-11-21); this converges forge with the ecosystem
pattern the 2026-09-28 dispatch-simplification research already
recorded (static bindings over the native channel), with the hardest
part — same-name override semantics — carried natively by the host.

## What Changes

- **ADDED — Trigger-driven scaffold with an explicit lever:** the
  global forge.json scaffold is drafted in-band by the forge agent on
  the user's explicit ask — the established unconfigured-crew gate
  pattern ("ask you to write the file — only on their explicit
  go-ahead") — and gains a direct lever: the `/forge init global`
  command (forge-commands change; owner direction 2026-11-21 — the
  gates stay the NET that catches un-init'd sessions, the commands are
  the explicit user controls). The plugin never writes it uninvited;
  the scaffold ships the override entries in comment form.
- **ADDED — Override templates COMMENTED OUT by default:** the
  scaffold ships General/Explore entries in comment form; uncomment +
  fill `model`/`thoughtLevel` to activate. Default-installed state is
  byte-equal to official built-in behavior — we never hard-copy vendor
  prompt text (it drifts every host version).
- **ADDED — Collision redline:** when sync would emit a same-name
  non-namespaced file (`general.md`, `explore.md` — lowercase stems
  only) and a hand-written
  file of that name already exists, sync REFUSES + discloses. The GC
  predicate for override files keys on the GENERATED marker
  (content-level), not the `forge-` prefix — override files
  intentionally carry no prefix. Emission is case-locked: a
  capitalized variant (`General.md`) does NOT override — it creates an
  ambiguous duplicate entry (probe-verified negative form) — so the
  compiler never emits one and the handbook warns hand-writers.
- **PROBE RESULT (2026-11-21, reports/probe-builtin-override.md) —
  POSITIVE with a hard constraint:** user same-name files DO shadow
  the built-ins — description/system/model fully replaced, permissions
  = builtin base ∪ appended, ≤2s hot-apply — but ONLY on the exact
  lowercase id stem (`general`/`explore`). Capitalized files coexist as
  ambiguous duplicates. Layer mechanics identical global vs project;
  dual-layer same-id: project wins (existing layering rule holds).
  Change lives; implementation pins lowercase emission.

## Capabilities

### Added Capabilities

- `forge-subagents`: one new requirement — built-in override via the
  global recipe (init scaffold, commented templates, collision
  redline, builtin-override precedence probe).

## Non-goals

- No changes to built-in behavior when unconfigured (default state =
  official, byte-equal).
- No primary-agent overrides (subagents only).
- No per-project built-in overrides (global recipe only; workspace
  recipes keep the `forge-` namespace).

## Authorization note

Owner proposed the direction (2026-11-21), corrected the init shape
(trigger-driven, like the unconfigured-crew gate), then confirmed the
final posture: net (gates) + levers (`/forge init global`, see
forge-commands). **Apply approved 2026-11-21** (probe POSITIVE).
Foundation: native-first-roster (0.30.0, released) — this change
targets 0.31.0.
