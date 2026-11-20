# forge-config-json-schema — tasks

## 1. Schema

- [ ] 1.1 Hand-write `schema/forge.schema.json` per design D1 (surface:
  `agents`/`pool`/`shared`; entry fields; shape enum; id/pool patterns;
  atomic pair via anyOf/not; deprecated `depths` noted).

## 2. Publication

- [ ] 2.1 `bundle` script appends the schema copy into `dist/`;
  `package.json` `exports` gains `"./schema.json": "./dist/forge.schema.json"`.
- [ ] 2.2 README: `$schema` usage snippet (node_modules reference form +
  `.json` comment caveat).

## 3. Fixes + tests

- [ ] 3.1 `shape-invalid` finding text states the write default (one
  line, `src/forge-config.ts`); finding-text assertion.
- [ ] 3.2 Drift-mirror test (schema enums/patterns vs code constants).
- [ ] 3.3 `$schema` fixture parses clean (tolerance regression).
- [ ] 3.4 `bun run typecheck`; `node --test tests/*.test.mjs` green
  (742+ baseline); `bun run bundle` emits the schema; `npm pack --dry-run`
  lists it.

## 4. Verify + release

- [ ] 4.1 `openspec validate --all`; git+file official-install verify per
  AGENTS (round-trip paired); version bump + npm publish ONLY after user
  approval.
