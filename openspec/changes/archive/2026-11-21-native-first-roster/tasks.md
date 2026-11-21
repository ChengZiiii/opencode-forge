# native-first-roster — tasks

> Status: COMPLETE (owner approved apply 2026-11-21; released as
> 0.30.0 the same day; archived on owner instruction).

## 1. Compiler core

- [x] 1.1 `src/roster-compile.ts` pure module (injectable fs, no
  @opencode-ai imports): recipe → file set per design D2 (namespacing,
  mode stamping, variant mapping, probe-vocabulary tools face, mandate
  baking, GENERATED header, orphan GC).
- [x] 1.2 `NATIVE_TOOL_VOCAB` single constant + drift-mirror test
  locked to probe evidence (`reports/probe-native-agent-surface.md`).

## 2. Sync tool + staleness gate

- [x] 2.1 `forge_sync` registered tool: compile + atomic write +
  disclosure of the diff (created/updated/GC'd files).
- [x] 2.2 Staleness precheck in crew_begin (and runtime-materialize
  precheck while that mode exists): refuse-with-guidance when recipe is
  newer; `sync:"auto"` opt-in path with finding disclosure.

## 3. Depth + migration

- [x] 3.1 Variant mapping (low/medium/high → `#variant` in model
  string); non-variant words keep chat.params path (existing depth
  suite stays green).
- [x] 3.2 `materialize: "native" | "runtime"` knob; runtime mode
  byte-equal regression (788 baseline is the net).

## 4. Handbook

- [x] 4.1 README cookbook: recipe fields, scout/coder/reviewer starter
  recipes, `mode: subagent` trap, tool-vocabulary drift note,
  cross-machine (lockfile) story.

## 5. Tests + verify + release

- [x] 5.1 Full design test plan (compiler matrix, staleness round-trip,
  atomicity, depth split, knob matrix).
- [x] 5.2 Sandbox E2E on 2.3.2: sync → native dispatch → hot-apply →
  cross-machine shape (second directory pull simulation).
  **7/7 PASS** (`reports/e2e-native-first-roster-report.md` — pinned
  model live with variant, readonly seal, GC redline incl. hand-written
  survivor, ws2 zero-init pull simulation); real-machine round-trip
  confirmed at release (`reports/release-0300-verify-report.md`).
- [x] 5.3 `openspec validate --all`; typecheck; bundle; git+file
  official-install round-trip paired; version bump + npm publish ONLY
  after owner approval. **Released 0.30.0 (2026-11-21, owner
  approved): npm publish → CDN → real-machine remove/store-clear/add →
  payload 4/4 hash-equal → native default verified live (drafts off,
  22→9) → forge_sync round-trip (9→14 natives, hot-apply) → config
  zero-drift** (`reports/release-0300-verify-report.md`).
