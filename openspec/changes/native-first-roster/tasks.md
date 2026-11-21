# native-first-roster — tasks

> Status: PROPOSED — awaiting owner review (proposal Authorization
> note). Do not check off until apply is approved.

## 1. Compiler core

- [ ] 1.1 `src/roster-compile.ts` pure module (injectable fs, no
  @opencode-ai imports): recipe → file set per design D2 (namespacing,
  mode stamping, variant mapping, probe-vocabulary tools face, mandate
  baking, GENERATED header, orphan GC).
- [ ] 1.2 `NATIVE_TOOL_VOCAB` single constant + drift-mirror test
  locked to probe evidence (`reports/probe-native-agent-surface.md`).

## 2. Sync tool + staleness gate

- [ ] 2.1 `/forge sync` registered tool: compile + atomic write +
  disclosure of the diff (created/updated/GC'd files).
- [ ] 2.2 Staleness precheck in crew_begin (and runtime-materialize
  precheck while that mode exists): refuse-with-guidance when recipe is
  newer; `sync:"auto"` opt-in path with finding disclosure.

## 3. Depth + migration

- [ ] 3.1 Variant mapping (low/medium/high → `#variant` in model
  string); non-variant words keep chat.params path (existing depth
  suite stays green).
- [ ] 3.2 `materialize: "native" | "runtime"` knob; runtime mode
  byte-equal regression (788 baseline is the net).

## 4. Handbook

- [ ] 4.1 README cookbook: recipe fields, scout/coder/reviewer starter
  recipes, `mode: subagent` trap, tool-vocabulary drift note,
  cross-machine (lockfile) story.

## 5. Tests + verify + release

- [ ] 5.1 Full design test plan (compiler matrix, staleness round-trip,
  atomicity, depth split, knob matrix).
- [ ] 5.2 Sandbox E2E on 2.3.2: sync → native dispatch → hot-apply →
  cross-machine shape (second directory pull simulation).
- [ ] 5.3 `openspec validate --all`; typecheck; bundle; git+file
  official-install round-trip paired; version bump + npm publish ONLY
  after owner approval.
