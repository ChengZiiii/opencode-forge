# Acceptance: 0.23.2 (sync-timeout-notify + terminal-inference soundness)

Date: 2026-11-15 (sandbox serve, file:// repo dist, official-config copy +
env knob)

## Live repro (the E plan) — sandbox serve :47622

Setup: `OPENCODE_CONFIG_DIR=<stn-config>` (real-config copy, plugin →
file:// repo dist), `FORGE_DISPATCH_POLL_TIMEOUT_MS=5000`, workdir =
plugindev workspace (pool gate passes for forge-plugindev-spec-reviewer).
Child workload: pure 1500-word essay generation ending with the token
`SLEEPER-DONE-0231` (no tools — bypasses the serve-mode permission-ask
hang discovered during setup, see below).

Markers (rescan of parent session ses_e2032dd2effe192McqvAtuxdJq,
child ses_e2032bafdffekrqfl5wqCMJ2yD):

- `timeoutFinding=true` — "Poll timeout after 5000ms" (env knob live)
- `armedDisclosure=true` — verbatim: "Completion tracking is ARMED —
  exactly one [forge:dispatch-complete] wake carrying the final report
  arrives when the child finishes; do not poll or re-dispatch in the
  meantime."
- `childSessionNamed=true`
- child completed: finish="stop", 13775 chars, SLEEPER-DONE-0231 present,
  REMOVED from the status map (the idle signal)
- **`wakeArrived=true`**
- **`wakeHasReport=true`** — the wake carries SLEEPER-DONE-0231

**Marker: STN-LIVE-0232 ALL-PASS.**

## Empirical corrections recorded during this change

1. **Status-map semantics (host 1.19.5, live-probed)**: `GET
   /session/status` returns ONLY currently-active sessions; a completed
   session is REMOVED. "Missing from a fetched map" is therefore the
   idle signal — NOT a hiccup. The contract's first guess ("missing =
   active") would have made completions undetectable; the live repro
   caught it before release and the contract was amended (proposal /
   design D5 / spec SHALL + scenarios).
2. **The armed poller's window is the 600s constant, never the sync
   knob** — a short-knob sync wait must not starve the tracker (found by
   the first repro round: the wake arrived carrying the poller's own
   5s timeout note instead of the report).
3. **Serve-mode permission-ask hang**: a forge-* readonly worker's
   forge_shell surfaces a permission ask (`action.action=ask` in the
   host log) that no one can answer in a headless serve — the tool hangs
   forever. The repro works around it via the sandbox permission block;
   the product gap (headless ask liveness for read-class worker
   commands) is flagged for a separate change.

## Pre-release chain

- Tests 556/556 (541 → 556: armed-wake chain, cap bypass, knob matrix,
  soundness matrix incl. the texture-forge flake shape), typecheck 0,
  `openspec validate sync-timeout-notify --strict` valid.
- package.json byte-repair (broken em-dash `E2 80 3F` → `E2 80 94`,
  Node 24 ERR_INVALID_PACKAGE_CONFIG) disclosed by the implementer,
  hash-verified.
- 0.23.1 was published mid-change with the wrong missing-semantics; it
  is superseded by 0.23.2 immediately (0.23.1's soundness rule would
  defer every completion detection to the 600s deadline).

## Environment notes for the record

- npmtoken.txt line 1 = the token; a Chinese annotation on line 2 broke
  whole-file reads (-Raw) once — extraction is line-1-only now.
- PS 5.1 Set-Content writes ANSI: the sandbox config copy was corrupted
  once by it ([System.IO.File]::WriteAllText UTF8 fixes it). Also: a
  serve caches the config read at startup — a config fixed on disk after
  a bad start needs a serve restart.
