# Tasks — pool-namespace-contract

## 1. Resolver core (pure functions, src/forge-config.ts)

- [x] 1.1 Delete the primary/plain-id special case in `createPoolResolver.resolve` (`plainPoolFile`), make family order purely lexicographic by absolute pool-file path (global layer included in the sort), and namespace the global fallback family with the fixed ns `global` — verify with new resolver-level tests in `tests/hierarchical-pools.test.mjs`: no plain ids anywhere, `forge-global-<id>` for the fallback, and identical materialized ids across two resolvers fed the same anchors in OPPOSITE orders (host-history independence)
- [x] 1.2 Update resolver-level collision tests: cross-family materialized-id collision now resolves in lexicographic path order (earlier file wins, later agent skipped + error finding naming both files), deterministically across anchor orders
- [x] 1.3 Add `poolFileCompliance` (file-level predicate: compliant iff the parsed top level declares a valid `pool` — same `[a-z0-9-]` 1–24 rule as `validatePoolField`) with unit tests: missing field, invalid charset, wrong type, over-length, valid value; the predicate ignores per-agent entries entirely

## 2. Description provenance (src/dispatch-tiers.ts)

- [x] 2.1 Extend the materialized-agent description builder with the provenance line (family namespace + origin forge.json path + "dispatchable only from sessions whose workspace pool is this file"; global family: origin is the global fallback layer) — verify via `tests/dispatch-prompt.test.mjs` assertions that the provenance sentence is present for a workspace family and names the file, and the global variant names the global layer

## 3. Wiring (plugin.ts)

- [x] 3.1 Config-hook materialization passes family origin through to the description builder; drop the `f.primary ? "primary pool (plain forge-<id> ids)"` label branches in the roster/crew surfaces — every family renders `pool <ns> (forge-<ns>-*)`; verify via `tests/forge-subagents-wiring.test.mjs`: materialized ids are namespaced, descriptions carry provenance, create-only semantics intact
- [x] 3.2 `crew_begin` compliance pre-flight: refuse registration (no crew record, no PENDING crew) when the session's workspace pool file is non-compliant; refusal names the file, the violation, the minimal fix (`"pool": "<suggested>"` — the currently derived namespace), and the hot-apply lift; verify via wiring tests covering missing field and invalid value, plus a compliant-registration control
- [x] 3.3 Belt compliance check in `tool.execute.before` for crew-governed sessions (PENDING or EXECUTING incl. born-armed) dispatching `forge-*` targets, running AFTER the session-domain pool gate (cross-pool refusals keep their copy); native task targets unaffected; verify via wiring tests: mid-crew degradation refusal, hot-apply lift after repair, global-fallback exemption, per-agent fail-soft non-blocking, pool-gate precedence
- [x] 3.4 Update `/crew` + unconfigured-gate template strings: `non-primary pools materialize as forge-<ns>-<id>` → `every pool materializes as forge-<ns>-<id>; the global fallback materializes as forge-global-<id>`; the embedded JSONC template's `pool` hint states the crew compliance requirement — verify via template snapshot assertions in `tests/forge-subagents-wiring.test.mjs`
- [x] 3.5 v2 `setup` parity: single-anchor resolve now namespaces (no plain ids), descriptions carry provenance — verify via `tests/v2-setup.test.mjs` updated id/description assertions with create-only parity intact

## 4. Documentation

- [x] 4.1 README: rewrite the id-shape documentation (every pool `forge-<ns>-<id>`, global `forge-global-<id>`, determinism guarantee, provenance line) and add the BREAKING migration note (declare `pool`; old plain ids are gone; crew gate requires the field) — verify by reading the README section against the new spec wording
- [x] 4.2 AGENTS.md: update the `plugin.ts` / `src/forge-config.ts` / tests rows (primary 纯 id → 全命名空间化、全局 forge-global-*、crew 合规闸) to match the shipped behavior — verify by grep: no stale `primary` / 纯 id pool wording remains in the architecture table
- [x] 4.3 Bump version to 0.18.0 (BREAKING minor; repo baseline is 0.17.0) in package.json — verify `npm pack --dry-run` reports the new version

## 5. Gate

- [x] 5.1 Full gate green: `bun run typecheck`, `node --test tests/*.test.mjs` (all suites), `bun run bundle` (self-contained dist), `npm pack --dry-run` (files whitelist = dist + README.md + package.json)
- [ ] 5.2 Official-install E2E per AGENTS.md: `opencode plugin "git+file:///<repo abs path>" --global`, then in an isolated workspace verify a namespaced roster + crew compliance refusal on a `pool`-less forge.json, then the README four-step uninstall; record results in the change's verify notes
