# builtin-override

## Why

The host ships two built-in subagents — **General** and **Explore**
(verified live on 2.3.2 via `/api/agent`: both `mode: subagent`,
visible). With native-first-roster landed, forge.json is the
configuration layer over native agent files, and the host already
merges same-name definitions (project-wins-scalars, permissions
spliced). That opens a zero-seam way to make the built-ins
configurable: a GLOBAL forge.json with same-name entries compiles to
`General.md` / `Explore.md` in the host's global agent dir, overriding
the built-ins machine-wide — pin a model, pin a depth word, reshape.
Not configured = official behavior (the Auto worker inherits the
primary model and its depth, which IS the built-in default).

Owner direction (2026-11-21); this converges forge with the ecosystem
pattern the 2026-09-28 dispatch-simplification research already
recorded (static bindings over the native channel), with the hardest
part — same-name override semantics — carried natively by the host.

## What Changes

- **ADDED — Trigger-driven scaffold, no new command:** the global
  forge.json scaffold is drafted in-band by the forge agent ONLY on
  the user's explicit ask — exactly the established
  unconfigured-crew gate pattern ("ask you to write the file — only
  on their explicit go-ahead"); the plugin never writes it uninvited
  and no `/forge init` command exists (owner correction 2026-11-21:
  project-level init was always trigger-driven — crew fires, finds no
  recipe, refuses with the template and the drafting affordance; the
  global layer follows the same shape). The unconfigured-crew refusal
  text is EXTENDED to name the global layer's override affordance, so
  the trigger point teaches both layers.
- **ADDED — Override templates COMMENTED OUT by default:** the
  scaffold ships General/Explore entries in comment form; uncomment +
  fill `model`/`thoughtLevel` to activate. Default-installed state is
  byte-equal to official built-in behavior — we never hard-copy vendor
  prompt text (it drifts every host version).
- **ADDED — Collision redline:** when sync would emit a same-name
  non-namespaced file (`General.md`, `Explore.md`) and a hand-written
  file of that name already exists, sync REFUSES + discloses. The GC
  predicate for override files keys on the GENERATED marker
  (content-level), not the `forge-` prefix — override files
  intentionally carry no prefix.
- **PROBE FIRST — verify, don't assume:** user same-name file vs
  BUILT-IN agent precedence is unprobed (probe 2026-11-21 covered
  project-vs-global layers, not built-ins). A short sandbox probe
  gates implementation; if the host does NOT let files shadow
  built-ins, this change dies in propose.

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

Owner proposed the direction (2026-11-21); this proposal adds three
patches: trigger-driven scaffolding (no dedicated command — owner
correction: init follows the unconfigured-crew gate pattern),
commented defaults, collision redline. Implementation starts only on explicit approval. Foundation:
native-first-roster (0.30.0) lands first — this change targets
0.31.0.
