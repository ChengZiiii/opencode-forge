# forge-config-json-schema — design

## Survey anchors (HEAD baseline, 2026-11-21)

- Consumed top-level keys: `agents` (cascade loader + pool resolver),
  `pool` + `shared` (pool resolver only — the asymmetry is documented,
  not changed here).
- Entry fields: `prompt`, `model`+`thoughtLevel` (atomic pair), `shape`
  (`readonly`|`write`), `permission` overrides; deprecated `depths`.
- `$schema` tolerance: both parse paths consume only known keys; no
  unknown-key checking anywhere (git grep verified) — zero code needed.
- Publication red line: `scripts` may only be NAMED bundle/test/typecheck
  (six git-prepare trigger names + workspaces are the actual constraints);
  appending a schema copy step INSIDE `bundle` is compliant, `dist/` is
  already in the files whitelist, and `exports` is unrestricted.

## Decisions

- **D1 — hand-written schema, mirror-locked:** `schema/forge.schema.json`
  written by hand against the validator's actual surface (NOT generated —
  a generator over the imperative fail-soft TS would need a zod rewrite
  and create a second source of truth). A drift-mirror test asserts the
  schema's shape enum, id/pool patterns, and atomic-pair constraint
  against the code constants (`AgentShape`, regex constants, the pair
  rule) — schema drift from code fails CI.
- **D2 — publication channel:** `bun run bundle` appends
  `copyFileSync(schema/forge.schema.json, dist/forge.schema.json)`;
  `package.json` `exports` gains `"./schema.json": "./dist/forge.schema.json"`.
  README gains a `$schema` usage snippet. No new script names; `files`
  unchanged (dist already whitelisted).
- **D3 — `$schema` is a documented tolerance, not a feature:** the README
  snippet shows `"$/schema"`-style or node_modules-referencing `$schema`
  lines; the parser's existing unknown-key tolerance covers them. The
  `.json`-extension comment squiggle caveat is noted in the README snippet
  (editor-side, unrelated to us).
- **D4 — shape-invalid text fix:** `shape-invalid` finding now states the
  true default (write — `shape-default-open`), one line in
  `src/forge-config.ts`, covered by an assertion on the finding text.

## Non-goals

- `_migrations` and any startup rewriting of user files (read-only
  stance; fail-soft deprecation findings are the migration story).
- Parser/zod refactor; new config fields; validation behavior changes
  beyond the finding text.

## Test plan

- Drift-mirror test: schema enum/patterns vs code constants (fail on
  drift).
- shape-invalid finding text asserts the write default.
- `$schema` key in a fixture parses clean (tolerance stays).
- `bun run bundle` emits `dist/forge.schema.json`; `npm pack --dry-run`
  shows it in the tarball; full suite green (742+ baseline).
