# fix-v2-anchor-field-reality — tasks

> Retrospective record: the field-reality patch shipped as 0.27.1 before
> this change directory existed (deferral approved by the user). Tasks
> below are marked done with their real-world evidence.

## 1. Diagnosis

- [x] 1.1 Confirm duplicate plugin-ID failure mode and collapse the four
  config forge references into one pinned npm source
  (`npm:@sorenllm/opencode-forge@0.27.1`)
- [x] 1.2 Probe the live 2.3.2 host with a temporary probe plugin:
  `ctx.location.directory` is a string property; `worktree` is absent
  (evidence in design.md)
- [x] 1.3 Identify the failure path: `v2AnchorCandidates` drops
  non-callable anchor fields → zero candidates → pool materialization
  skipped silently → `/api/agent` 500 + missing tool belt

## 2. Fix

- [x] 2.1 `v2AnchorCandidates` accepts property-shaped anchors (string
  value used directly) alongside zero-arg functions
- [x] 2.2 Absent fields keep falling through to remaining candidates
  (skip-silently semantics unchanged)
- [x] 2.3 Type-check + full suite (717 tests) green

## 3. Release

- [x] 3.1 Version bump → commit `a72c86e` → npm publish → registry
  tarball verified (HTTP 200)
- [x] 3.2 Config pinned to `npm:@sorenllm/opencode-forge@0.27.1`; no
  duplicate source entries
- [x] 3.3 Commit pushed to `ChengZiiii/opencode-forge` main

## 4. Live verification

- [x] 4.1 `/api/plugin`: forge 0.27.1 active, no Duplicate-ID failure
- [x] 4.2 `/api/agent?location[directory]=<workspace>`: all five
  `forge-plugindev-*` workers listed
- [x] 4.3 Forge tool belt (15 tools + task) present in a live session
