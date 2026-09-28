# Design — align-shell-interpreter

## Context

`src/proc.ts` `shellSpawn()` is the single spawn muscle shared by `job-runner.ts` (forge_shell jobs) and `run-check.ts` (goal verification). It currently passes `shell: true`, so Node picks `%COMSPEC%` (cmd.exe) on Windows and `/bin/sh` on POSIX. The host's native tool (`packages/opencode/src/tool/shell.ts` + `packages/core/src/shell.ts`, verified 2026-09-28) instead resolves a preferred shell and invokes PowerShell-family shells directly via an argument array. See proposal.md — Why, for the field evidence (exit-255 corpse) and the upstream architecture.

## Goals / Non-Goals

**Goals:**

- One interpreter-resolution function used by every plugin spawn site.
- Windows: PowerShell semantics by default (matching the host and the model's
  expectations); POSIX: bash-preferred login semantics.
- Exit codes and the four-condition completion race remain exactly as specified —
  only the process-tree root and its argv change.
- The model can read the interpreter flavor off the tool description.

**Non-Goals:**

- No tree-sitter parsing, no per-shell permission scanning (host's business).
- No new plugin option (`jobs.windowsShell` etc. rejected — see D3).
- No changes to fence/watchdog/kill mechanics beyond what the new tree root
  requires (none: both are pid-tree based and already handle PowerShell roots —
  the fence watcher itself is a `powershell -NoProfile -Command` process).
- No v2-entry-point changes (no tool domain there).

## Decisions

- **D1 — Replicate the host chain in plugin code, do not import host internals.**
  `@opencode-ai/core` is the host's internal package; depending on it would couple
  the plugin to unpublished layout. The chain is ~40 lines (which(), git-bash
  discovery via the git binary path, META-style family classification). A
  host-configured shell read from the merged config object (visible in the config
  hook) takes precedence when present; absence is fail-soft (fall through to the
  platform chain).
- **D2 — Argument forms mirror the host's `args()` table, simplified.**
  PowerShell family: `[shell, "-NoProfile", "-Command", command]` plus an
  `exit $LASTEXITCODE` tail guard so a native command's nonzero exit is not
  swallowed by a trailing PS statement (precedent: the fence watcher script).
  cmd.exe (capability fallback only): `[comspec, "/c", command]`. POSIX bash/zsh:
  `["-l", "-c", command]` — login mode without the host's rc-sourcing wrapper;
  the host's `eval`+`JSON.stringify` dance exists to pass cwd safely through a
  sourced rc, which we do not need because spawn's `cwd` option already places
  the job. Other POSIX shells: `["-c", command]`.
- **D3 — No cmd escape hatch.** The user explicitly rejected a fallback knob, and
  the host made the same call (cmd.exe exists only as COMSPEC last resort on
  machines with nothing else). A machine that truly has neither pwsh, powershell,
  nor git-bash still executes — via the chain's tail — but nothing invites
  pinning forge to cmd semantics.
- **D4 — `shellSpawn` keeps its injectable-spawn signature** so the existing
  FakeChild tests extend naturally: resolution is pure (platform + env + which
  injectable), the spawn call shape is asserted per family. Resolution results
  are memoized per process (like the host's `defaultAcceptable` cache).
- **D5 — Description disclosure is one sentence, platform-generic.** "Commands
  run under the host shell: PowerShell on Windows (the builtin shell's
  interpreter), the login shell (bash preferred) on POSIX." Naming the resolved
  binary per machine would leak host specifics into a static description; the
  family-level truth is what the model needs to pick syntax.
- **D6 — run-check inherits silently.** It already calls `shellSpawn`; no code
  change beyond what D1–D2 introduce. Goal-mode tests gain one assertion: a
  PowerShell-syntax check string executes through the injected fake and its exit
  code is honored.

## Risks / Trade-offs

- [PowerShell startup latency ~200–400 ms per foreground command] → accepted; a
  session's commands are seconds-count, the host pays the same cost, and idle
  early-return means long jobs are unaffected.
- [Existing cmd-syntax muscle memory (users or adapted models) breaks] → that is
  the point of alignment; `%VAR%` syntax was never a documented contract, and
  the description now states the flavor.
- [PS `-Command` exit-code quirks with multi-statement commands] → the
  `exit $LASTEXITCODE` guard covers the native-command case; PS-syntax errors
  still yield PowerShell's own nonzero exit, which is honest evidence.
- [Quoting] → the spawn argument array bypasses cmd's quoting layer entirely
  (improvement); PS parses the command string as a script, same as the host.
- [fence / taskkill / registry adoption see a PowerShell tree root] → all are
  pid-tree mechanisms today and already handle PowerShell roots (fence itself
  spawns one); `job-registry.ts` explicitly notes the wrapper-pid relocation
  case.

## Migration Plan

1. Implement resolution + spawn forms behind the existing `shellSpawn` signature;
   unit tests first (resolution chain per platform, argv per family, exit-code
   guard).
2. Wire description sentence + wiring tests; goal-mode assertion.
3. `bun run typecheck && node --test tests/*.test.mjs`; sandbox E2E
   (`OPENCODE_CONFIG_DIR` temp dir): `forge_shell` runs
   `echo $env:USERNAME` (PS syntax) successfully on Windows; POSIX CI-equivalent
   covered by injectable tests.
4. Rollback: revert the single commit; no persisted state references the
   interpreter.

## Open Questions

- None.
