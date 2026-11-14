# Design: task-shadow

## Context

- Verified upstream: oh-my-openagent registers its SDK-based async
  dispatch engine under `tools.task = delegateTask`
  (`packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:148`),
  shadowing the native task tool; the TUI keys its native live-subagent
  panel on the tool NAME `task`. Their metadata contract (sessionId /
  taskId / agent / run_in_background / description) is published into the
  tool part (`task-metadata-contract.ts`).
- Our 0.22.0 engine (SDK parentID child sessions, sync poll / async
  wake, harvest, cap) is mechanically identical; the observed TUI gap is
  the name, not the mechanism.
- Host reality on a forge install: forge is the default agent, forge
  replaced plan/build, opencode v2 deprecates the multi-agent-config
  surface — the native task surface has effectively one real caller (the
  forge primary). Owning the name aligns the surface with reality.

## Goals / Non-Goals

- Goals: (1) `task` shadowed by the forge engine with full native
  parity for arbitrary targets; (2) native TUI live panel for forge
  dispatches (empirically verified in the TUI); (3) mode-keyed question
  policy (sync: native parity; async: question-deny); (4) sync abort
  parity; (5) forge_dispatch retired — single dispatch surface.
- Non-Goals: reimplementing OMO's category/skill-injection extras;
  supporting co-installation with OMO (both shadow `task` — README
  discloses); changing wake/cap/harvest semantics (they carry over).

## Decisions

1. **Shadow, not coexist** — the name IS the rendering key; a second
   name keeps the generic block forever. OMO proves shadowing is stable
   on this stack.
2. **Full-parity non-forge path** — same engine, pool gate skipped,
   question policy mode-keyed. Non-forge children are plain host
   sessions like native task produced; recursion policy is the target
   agent's own config business (native behavior preserved).
3. **Metadata mirrors native/OMO keys** (`agent`, `sessionId`, `taskId`,
   `run_in_background`, `description`, `prompt`) — the TUI renderer's
   exact read is undocumented; mirroring OMO's proven keys plus a live
   TUI acceptance check (the user watches the panel) covers both known
   and unknown keys.
4. **Sync abort parity** — the tool context abort signal triggers child
   abort (native task kills children on turn abort; async children
   intentionally survive — session-scoped, existing harvest semantics).
5. **forge_dispatch retired** — two dispatch surfaces would bifurcate
   model behavior; the async-dispatch spec requirements are superseded
   here (REMOVED + ADDED deltas on the same live requirements).

## Risks / Trade-offs

- **Host-wide takeover**: every agent that calls `task` now hits our
  implementation. Mitigation: full-parity non-forge path, parity tests,
  live verification; the practical caller set on a forge host is the
  forge primary (workers are banned, plan/build replaced).
- **Unknown TUI renderer keys**: mirroring OMO + empirical check; if the
  live panel still doesn't engage, the fallback disclosure is honest
  README documentation — but OMO's production behavior says it will.
- **Co-installation with OMO**: undefined behavior (registration order
  decides the shadow). README: choose one orchestration layer.

## Migration Plan

Registration rename + engine extension; gates stay keyed on `task` (the
execute-before belts already key on that name); forge_dispatch removal
removes its tests; README breaking-note. No config changes.

## Open Questions

- None blocking. TUI rendering keys verified empirically at acceptance
  (user watches the panel during live verification).
