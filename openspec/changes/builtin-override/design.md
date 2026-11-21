# builtin-override — design

## Probe anchors

- `reports/probe-builtin-override.md` (2026-11-21): the identity key
  is the agent **id** (= filename stem, case-sensitive). LOWERCASE
  `general.md` / `explore.md` truly override the built-ins
  (description/system/model replaced, permissions = builtin base ∪
  appended, ≤2s hot-apply). Capitalized variants create ambiguous
  duplicate entries — the negative form, never emitted. Global and
  project layers behave identically; dual-layer same-id: project wins
  (existing layering rule holds under builtin collision).
- `reports/probe-native-agent-surface.md` (2026-11-21): frontmatter
  vocabulary, `mode: subagent` trap, variant channel.

## Decisions

- **D1 — Recipe key: a top-level `override` node, GLOBAL layer only.**
  `"override": { "general": {...}, "explore": {...} }` in the global
  forge.json. Workspace-pool `agents` ALWAYS compile namespaced
  (`forge-<ns>-<id>`) — per-project built-in overrides are a non-goal.
  Fail-soft: unknown override ids warn + skip; the handbook documents
  the two built-in subagent ids (`general`, `explore`).
- **D2 — Emission: case-locked lowercase stems, no prefix.**
  `<globalAgentDir>/<id>.md` with the exact builtin id; GENERATED
  marker; `mode: subagent`; model+variant per the same rules as
  workers; tools face per shape; GC keys on the marker (not the
  prefix). Capitalized stems are NEVER emitted.
- **D3 — Prompt reality, disclosed:** an activated override replaces
  the built-in's prompt wholesale (probe: system fully replaced; we
  never copy vendor text). Handbook states this plainly — activating
  an override is writing your own general/explore, not just pinning a
  model; the commented template suggests a minimal prompt.
- **D4 — Collision redline, case-exact:** if a hand-written
  `<globalAgentDir>/general.md` (exact id) exists, sync refuses +
  discloses, never overwrites.
- **D5 — Global agent dir mirrors the host's resolution** (probe
  correction): `OPENCODE_CONFIG_DIR` set → `$CONFIG_DIR/agent`;
  unset → `<home>/.config/opencode/agent`. `agentDirFor` implements
  exactly this; unit tests lock both branches. (Sandbox corollary:
  with CONFIG_DIR set, the fake-home `.config` path is NOT read.)
- **D6 — Scaffold:** `/forge init global` (forge-commands) ships the
  `override` node fully commented; in-band asks draft the same shape.

## Test plan

Compiler matrix: override node → lowercase emission (case-lock),
namespaced pools untouched by override semantics, collision refusal,
marker-keyed GC (comment-out → file GC'd; hand-written never touched),
CONFIG_DIR mirror both branches, scaffold inert-by-default, no
override node → zero emission. Suite baseline 812 stays green;
typecheck; bundle.
