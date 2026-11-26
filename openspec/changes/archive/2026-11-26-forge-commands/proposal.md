# forge-commands

## Why

Owner direction (2026-11-21): the roster's user controls should be
REAL slash commands, with the existing trigger-driven gates remaining
as the net. The two-layer posture:

- **NET (existing, unchanged):** the unconfigured-crew refusal catches
  a session with no recipe and teaches the scaffold in-band; the
  staleness gate catches drift and teaches `forge_sync`. Nobody is
  ever stranded for not knowing a command — the owner's own framing:
  "crew 在无子代理的情况下，其实就是未 init 时的兜底".
- **LEVERS (new):** `/forge init`, `/forge init global`, `/forge sync`
  — the user's direct, explicit controls. `/forge sync` is a
  force/debug/fallback lever on top of unchanged automation (the
  staleness gate + in-band sync default, the `sync:"auto"` opt-in).

Today's slash surface is exactly `/plan` `/goal` `/crew`; this adds a
`/forge` family of three execute-type commands — templates that
instruct the forge agent, so every effect still lands in the
transcript (same visibility discipline as the tools; the commands
themselves never write files).

## What Changes

- **ADDED — `/forge sync`:** execute-type command → the forge agent
  invokes the `forge_sync` tool NOW and reports the diff
  (created/updated/GC'd). Debug + fallback posture: default sync
  behavior is unchanged — the command is the explicit override, not a
  new automation.
- **ADDED — `/forge init`:** project scaffold lever. Drafts the
  workspace forge.json in-band WITH the user (interview or from
  project context — pool namespace, roles, shapes), refuse-if-exists
  (offer review, never overwrite). The explicit form of what the crew
  gate has always taught ("ask you to write the file — only on their
  explicit go-ahead").
- **ADDED — `/forge init global`:** global scaffold lever — same
  drafting flow for `~/.config/opencode/forge.json`; the scaffold
  ships the General/Explore override entries in comment form
  (builtin-override's inert-by-default scaffold).
- **UPDATED — unconfigured-crew refusal text:** names the `/forge
  init` levers alongside the in-band ask (the net teaches the levers).
- **FAMILY GUARD:** all three are forge-session commands (same guard
  as `/plan` `/goal` `/crew`).

## Capabilities

### Added Capabilities

- `forge-subagents`: one new requirement — user-facing `/forge`
  command family (sync force lever, project/global init levers,
  net-teaches-levers).

## Non-goals

- No new automation (default posture and `sync:"auto"` semantics
  unchanged — the command is the manual lever).
- No silent or direct writes (commands are templates; every write goes
  through in-band tools, transcript-visible).
- No gate semantics changes (the net stays the net).

## Authorization note

Owner direction (2026-11-21, "确实可以要"): explicit init levers
(project + global) and a user-forced sync, with auto-sync behavior
kept. Targets 0.31.0 alongside builtin-override (the global scaffold's
commented override templates are gated by that change's probe).
