# Proposal: anchor-pool-preference

## Why

0.20.0 live incident (2026-11-08 evening): a resumed-after-restart session's dispatches to its OWN
workspace-pool workers were refused ("not dispatchable from this session … roster is the global
fallback"). Diagnosis: the authoritative-first anchor chain (`pool-gate-authoritative-anchor`) trusts
`client.session.get` unconditionally when it returns a non-rootish anchor — but for a session RESUMED
after a restart, the host record can carry the NEW launch directory (pool-less) instead of the
conversation's real workspace, while the plugin's in-memory map still holds the correct pooled worktree
(corroborated by live session activity — forge_shell cwd, tool contexts). The 0.18.0 incident fixed the
mirror (degraded map + good record); this is the unhandled direction: degraded record + good map.

## What Changes

- The anchor resolver (`resolveSessionAnchorForPools`, the ONE seam both the task pool gate and the crew
  compliance belt use) gains a conflict rule: when the authoritative anchor is valid but owns NO pool
  file, and the in-memory binding is a DIFFERENT non-degenerate worktree that DOES own a pool file, the
  POOLED binding wins for that resolution. One bounded disclosure per session records the substitution.
- Everything else keeps today's order: authoritative record pooled → it wins (the 0.18.0 semantics
  untouched); record unavailable/rootish → map decides; unknown-everything → fail-open with disclosure.
- No gate copy changes, no roster semantics changes, no disk state.

## Capabilities

**Modified Capabilities:**

- `forge-subagents` — MODIFIED requirement "Workspace pool ownership and global fallback": the anchor
  paragraph gains the pooled-preference conflict rule; one new scenario. All existing scenarios carried
  verbatim.

## Impact

- `plugin.ts` — `resolveSessionAnchorForPools` (~:2591) gains the conflict branch + a bounded
  anchor-preference disclosure note set; no other guard logic touched.
- `tests/hierarchical-pools.test.mjs` — new case (e) in the authoritative-anchor matrix: record pool-less
  (resume-rebind shape) + map pooled → own-pool ALLOWED (refused pre-fix), cross-pool still refused,
  disclosure fires exactly once; symmetric cases re-asserted (record pooled wins — existing case (a)).
- `README.md` — troubleshooting/anchor note updated.
- `dist/index.js` — rebuilt; released as 0.20.1 (patch).
