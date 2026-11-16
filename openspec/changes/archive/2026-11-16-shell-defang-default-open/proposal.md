# Proposal: shell-defang-default-open

## Why

The archived `dispatch-resilience` fold A made the plugin rewrite the
`forge_shell` posture to `ask` for unconfigured users and resolve that ask in
headless mode by classifying commands — READ-class runs, WRITE-class refuses.
On a real headless host (serve, no explicit permission config) this turned
every ordinary write-shaped command (`git push`, `npm publish`, `Out-File`)
into a hard refusal, breaking the development loop the plugin itself drives
(first observed live minutes after the user restarted onto 0.25.4: the plugin
refused its own author's `git push`). The user's product decision: adopt the
omo philosophy — **the default posture must not gate**; hang prevention
belongs in the executor (defang), not in refusals. omo implements this with a
non-interactive-env hook (git commands get `GIT_EDITOR=:`/`EDITOR=:` prepended;
known-interactive commands get a warning, nothing blocks) and no command
classification anywhere in its tree.

## What Changes

- **BREAKING (default posture inversion)**: the plugin no longer rewrites the
  `forge_shell` permission posture to `ask` for unconfigured users. With no
  explicit user permission, the host's own default flows (in practice `"*":
  allow`) — commands run in serve, TUI, and run modes alike, exactly like the
  native bash tool.
- **BREAKING (classifier retired, full omo parity)**: the headless posture
  resolution (READ-class proceeds / WRITE-class `[forge:headless-denied]`
  refuses) is REMOVED — not opt-in. The plugin performs no command
  classification on the posture path at all; explicit user values
  (`allow`/`deny`/`ask`) flow to the host verbatim in every mode, and an
  `ask` on a serve host behaves exactly like the native shell tool's ask
  there (pending until answered via the host API — the host's business, not
  the plugin's). The `FORGE_HEADLESS` exec knob and the plugin's headless
  detection on the posture path die with it. `src/exec-classify.ts` SURVIVES:
  the readonly-exec-seal still uses the same classifier to recognize
  write-class commands for readonly workers.
- **Kept by product decision**: the readonly-exec-seal (readonly workers'
  write-class refusal — now the ONLY plugin-side exec refusal, still
  posture-independent) and the seven user-confirmation doors (never
  auto-resolved in any mode).
- **Non-interactive exec hygiene (the omo port, forge-improved)**: forge owns
  the `forge_shell` executor, so the defang lands at SPAWN time, not as
  command-string mutation: every spawn merges `GIT_EDITOR=:`, `EDITOR=:`,
  `GIT_PAGER=cat`, `PAGER=cat`, `GIT_MERGE_AUTOEDIT=no` into the child env —
  no editor or pager can ever hang a command, git or not. Known-interactive
  commands (an enumerated banned list: logins, pagers-as-primary, manual-driven
  installers) attach a non-blocking warning line to the tool result instead of
  being refused.
- README: the FORGE_HEADLESS row is REMOVED (not rewritten); the "Headless
  ask liveness" section is replaced by the pass-through contract + hygiene;
  the unconfigured bypass surface is disclosed.

## Capabilities

- **New Capabilities**: none.
- **Modified Capabilities**:
  - `tool-partition` — the "Headless ask liveness on the exec surface"
    requirement is rewritten: the classifier is the resolution for an explicit
    user `ask` in headless mode, not for the plugin's injected default; a new
    requirement pins the spawn-time non-interactive hygiene (env defang +
    banned-list warning).
  - `job-supervisor` — the `forge_shell` posture requirement drops the
    "defaulting to `ask`" rewrite: the plugin injects no default; explicit
    user values are honored verbatim in all modes.

## Impact

- `plugin.ts`: config hook (drop the default `ask` rewrite; snapshot logic
  stays and now distinguishes explicit values from unconfigured), permission.ask
  belt (posture passes through verbatim — the headless classifier call site is
  REMOVED; the seal keeps its classifier usage), forge_shell executor (spawn
  env merge + banned warning).
- `src/exec-classify.ts`: kept (seal's write-class recognition); its posture
  call site in the belt is removed. `FORGE_HEADLESS` knob: removed (was
  fold-A's classifier forcing knob; nothing else reads it).
- Tests: posture matrix rewritten (unconfigured/explicit-allow/deny/ask ×
  serve/TUI/run — no plugin-side resolution anywhere, no
  `[forge:headless-denied]` assertions survive), hygiene assertions (env
  present on spawns, warning non-blocking), existing fold A tests updated or
  retired to the pass-through contract.
- Released as a minor after the suite gates; the flip + store train as
  usual.
