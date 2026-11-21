# native-first-roster — implementation report

- Date: 2026-11-21 · scope: tasks 1.1–5.1 (owner-approved apply, three resolutions)
- Repo: `opencode-forge/` (workspace root `C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev`)
- Verify: `bun run typecheck` exit 0 · `node --test tests/*.test.mjs` **812 pass / 0 fail** (788 baseline + 24 new) · `bun run bundle` exit 0 (dist rebuilt, committed)

## Files changed

| file | change |
| --- | --- |
| `src/roster-compile.ts` | **NEW** — compiler pure core (injectable fs, zero @opencode-ai): `NATIVE_TOOL_VOCAB` (single host-tool-vocabulary constant), `VARIANT_DEPTH_WORDS`, `compileRosterEntry` / `planRosterSync` (namespacing, `mode: subagent` always, `model: provider/model[#variant]`, probe-vocabulary tools face, mandate/shape/role/shared baked body, GENERATED header), `executeRosterSync` (atomic temp+rename with unlink-fallback, GC of marker-carrying orphans only), `staleCheckForPool` (mtime trigger + **content-based final verdict** — touch/checkout skew never dead-ends a sync round-trip) |
| `src/forge-config.ts` | `parseMaterializeKnob` / `parseSyncKnob` / `parseTopLevelKnobs` — fail-soft top-level knob parsing (bad value → warn finding + default) |
| `src/dispatch-tiers.ts` | export `MUTATING_TOOLS` (one constant now also feeds the native readonly face — zero drift) |
| `plugin.ts` | `forge_sync` tool (registered both generations via `forgeTools()`, diff disclosure created/updated/unchanged/GC'd, hot-apply note); crew_begin staleness precheck (native mode only, one-step in-band fix, same gate-language family as compliance); `nativeRosterSyncHint` appended to the task tool's not-materialized refusal; v2 default **native** (owner 2026-11-21 direct-cut; v1 server() path untouched → runtime-pinned); `materialize:"runtime"` escape hatch preserves the draft path; `sync:"auto"` per-pool session-start regeneration with console finding; `forge_sync` added to `FORGE_STATE_TOOLS` (coordinator-only, partition vocabulary 17→18) |
| `schema/forge.schema.json` + `dist/forge.schema.json` | `materialize` / `sync` properties (enums mirror the fail-soft validators) |
| `README.md` | handbook section: recipe field table, scout/coder/reviewer starter recipes, `mode: subagent` trap, vocabulary-drift note (`execute`/`subagent` current names), cross-machine lockfile story, upgrade recipe (remove → clear store → add → /forge sync) |
| `AGENTS.md` | architecture-table row for `src/roster-compile.ts` |
| `tests/*` | new suites (below) + runtime-pin (`materialize:"runtime"`) added to existing v2 draft-materialization fixtures that pin that path; tool-count/partition-count assertions updated for `forge_sync` |

## Tasks status

- [x] 1.1 compiler core · [x] 1.2 NATIVE_TOOL_VOCAB + drift mirror · [x] 2.1 forge_sync tool · [x] 2.2 staleness precheck + sync:auto · [x] 3.1 variant mapping (low/medium/high → `#variant`; none/minimal/xhigh/max keep the chat.params path — existing depth suite green) · [x] 3.2 knob matrix · [x] 4.1 README handbook · [x] 5.1 full design test plan. (5.2 sandbox E2E / 5.3 validate+publish remain, per task ledger.)

## Test names (new)

`tests/roster-compile.test.mjs` (15): vocab mirror locked to probe evidence · depth split low/medium/high · namespaced file per entry + mode stamp + GENERATED header · variant vs non-variant vs Auto model strings · tools face per shape in probe vocabulary · mandates+shape frame+role+shared baked · provenance (workspace + global fallback `forge-global-*` into the host global agent dir) · frontmatter emits ONLY probe-proven keys · execute create/unchanged · GC (orphans collected, hand-written files kept) · failed write leaves no half file (atomicity) · rename-refusal fallback lands new content · staleness fresh/stale/missing/empty · content-based verdict (mtime skew ≠ stale, real edit = stale) · agentDirFor mapping.

`tests/native-roster-wiring.test.mjs` (8): knob parsing fail-soft · v2 defaults native (no worker drafts, forge_sync registered) · runtime escape hatch materializes · gate round-trip (crew_begin refuses stale → forge_sync regenerates → retry registers PENDING) · recipe edit re-stales + touch does not · GC via the tool on recipe shrink · dispatch hint on unknown forge target (stale native roster) · sync:"auto" regenerates at session start while the default posture writes nothing uninvited.

`tests/forge-schema-mirror.test.mjs` (+1): materialize/sync enums mirror `parseTopLevelKnobs` both directions.

## v1 equivalence statement

The v1 `server()` path is byte-equal in behavior: it never sets `v2HostSeen`, so `nativeRosterActive()` is false on v1 → the crew staleness gate and dispatch hint are inert; the runtime materialization in the config hook is untouched; `forge_sync` is registered (per instruction, both paths) but never writes unless invoked. The pre-existing **788-test baseline passed unchanged** (the 19 initially-failing tests were all v2 fixtures pinning the now-escape-hatch draft path — resolved by explicitly pinning `materialize:"runtime"` in those fixtures, which is the documented knob matrix, not a behavior change). Non-variant depth words keep the chat.params injection — the full existing depth suite (dispatch-depth, forge-subagents-wiring) is green.

## Commits (not pushed, per contract)

- `6af6f63` docs: record owner resolutions in native-first-roster proposal/design (apply approved)
- `3941746` src: native roster compiler core + materialize/sync knobs (native-first-roster 1.1/1.2/3.1/3.2)
- `8f46daa` plugin: wire forge_sync tool, staleness gate + dispatch hint, v2 native default and sync:auto (native-first-roster 2.1/2.2)
- `ecd594f` tests: roster-compile + native-roster-wiring suites; pin runtime mode on existing v2 draft-materialization fixtures (native-first-roster 5.1)
- `ec0a2e0` docs: README native-roster handbook + AGENTS architecture row + task ledger (native-first-roster 4.1)
- `b945204` chore: rebuild dist (bundle, self-contained)

## Design deviations (disclosed)

1. **Staleness verdict is content-based when mtime says stale** (design D4 said mtime): pure mtime made a touched-but-identical recipe permanently refuse (sync reports "unchanged" and never refreshes mtimes → dead-end loop). mtime remains the cheap trigger; the final verdict compares compiled content. Locked by tests.
2. **crew_begin gate scoped to native mode only** (design also named a runtime-materialize precheck): in runtime mode no artifacts exist, so the check is vacuous there; the v1/runtime byte-equality contract drove the scoping.
