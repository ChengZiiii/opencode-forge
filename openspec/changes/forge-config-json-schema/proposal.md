# forge-config-json-schema

## Why

OMO-derived config engineering survey (`reports/explore-config-schema-report.md`)
found forge.json with zero editor support and zero typo defense: a worker
entry missing `thoughtLevel` beside a pinned `model` (the atomic pair), or
`"read-only"` instead of `"readonly"`, lands on disk and only surfaces as
a runtime fail-soft finding after the fact. The survey also confirmed the
cheap wins: the `$schema` key is ALREADY silently tolerated by both parse
paths (unknown keys are simply not consumed — zero code needed), a
hand-written schema of 100-150 lines covers the full field surface
(top-level `agents`/`pool`/`shared`, five entry fields, two-value shape
enum, existing id/pool regexes, the atomic pair via `anyOf/not`), and a
red-line-compliant publication path exists (the `bundle` script may append
a copy step — the red line locks script NAMES, not script bodies).

The survey's honest negative: OMO's `_migrations` auto-rewrite machinery
is NOT adopted — its value premise is STARTUP REWRITING of the user's
config file, which collides head-on with forge's published promise
(README: the plugin never writes the user's forge.json; file edits are
the user's own). Fail-soft deprecation findings (the `depths` precedent)
already are our migration story.

A real bug rides along: the `shape-invalid` finding says "defaulting to
readonly" (`src/forge-config.ts` HEAD L381) while the actual downstream
default is WRITE (`def.shape ?? "write"`, `src/dispatch-tiers.ts` L106) —
a user fixing a typo'd shape is told the wrong direction. One line,
user-facing, this change fixes it.

## What Changes

- **ADDED — JSON Schema publication:** a hand-written
  `schema/forge.schema.json` describing the forge.json surface; the
  `bundle` script appends a copy into `dist/` (red-line compliant), and
  `package.json` gains `exports["./schema.json"]` pointing at the dist
  copy so `"$/schema"`-style editor hints can reference
  `node_modules/@sorenllm/opencode-forge/dist/forge.schema.json` — plus
  the README documents the `$schema` line users can paste into their
  forge.json (which the parser already tolerates today).
- **ADDED — drift-mirror test:** a test asserting the schema's enums and
  patterns against the code constants they mirror (`AgentShape`,
  `AGENT_ID_RE`/pool regex, the atomic-pair rule) so schema and validator
  cannot drift apart silently.
- **FIX — shape-invalid finding text:** corrected to state the true
  default (write), matching `shape-default-open`.

## Capabilities

### Added Capabilities

- `forge-subagents`: one new requirement — JSON Schema publication for
  forge.json (schema content, publication channel, `$schema` tolerance,
  drift-mirror guarantee).

## Non-goals

- No `_migrations`/auto-rewrite machinery (read-only stance, README L898).
- No zod/parser refactor — the imperative fail-soft validator stays the
  single source of truth; the schema is a publication OF it, mirror-locked
  by test.
- No new forge.json fields; no behavior change in parsing or validation
  beyond the finding-text fix.

## Authorization note

User directive 2026-11-21 (autonomous multi-round closure). Implementation
is sequenced behind the in-flight Block C worker (same file:
`src/forge-config.ts`).
