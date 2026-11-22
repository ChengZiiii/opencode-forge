# Proposal: v2-command-surface

## Why

On v2 hosts (2.3.2) forge's slash commands deliver their templates byte-unchanged:
the v2 command domain passes typed arguments in `CommandInvocation.prompt.text`
and performs NO `$ARGUMENTS` substitution for plugin-registered commands, but
forge's `execute` reads only `sessionID` and drops `prompt.text`. Production
incident 2026-11-22 (SorenUnityLabs): `/forge sync` executed without the
argument — the agent received the literal placeholder and showed the routing
menu instead of syncing. Separately, the whole command-domain registration sits
inside a silent `catch {}` ("Drifted: silent no-op") — the ecosystem's
worst-incident class (mem0 #7602, host #49982): a drifted registration fails
invisibly.

## What Changes

- **ADDED**: three dedicated zero-argument commands `forge-sync`,
  `forge-init`, `forge-init-global` (hyphenated family), each with its own
  template and description, registered on BOTH host generations. Routing
  becomes host-deterministic — no argument pipeline, no model-layer dispatch.
- **MODIFIED**: v2 command `execute` now reads `input.prompt.text` and
  composes the delivered text: `$ARGUMENTS` replaced with the full typed text
  (function replacer, so `$&`-style literals survive); when the template has
  no placeholder and the typed text is non-empty, the text is appended after
  a blank line (upstream `evaluateTemplate` parity); empty/whitespace text
  sends the template unchanged. `delivery` is passed through.
- **MODIFIED**: command-domain registration drift is disclosed
  (console.warn naming the drifted domain) instead of silently registering
  nothing.
- `/forge` keeps its `$ARGUMENTS` routing template as the fallback entry;
  `/forge-sync` etc. are the documented primary surface.

## Capabilities

- **New Capabilities**: `command-surface` — the forge slash-command surface
  (dedicated levers + argument delivery + drift disclosure).
- **Modified Capabilities**: none (no existing requirement text covers
  commands; `/crew command discipline` in crew-harness is unaffected).

## Impact

- Code: `plugin.ts` (v2 command wiring + new v1 config-command registrations),
  shared template constants (route bodies extracted into per-lever template
  functions consumed by both `/forge` routing and the dedicated commands).
- Tests: new unit tests (argument composition) + wiring tests (dedicated
  commands registered and listed; `prompt.text` reaches the delivered prompt).
- Docs: README command chapter gains the hyphenated family; `/forge` stays as
  fallback.
- No breaking changes: v1 hosts already expand `$ARGUMENTS` in config
  commands; the dedicated commands are additive there too.
