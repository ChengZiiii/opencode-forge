# Proposal: simplify-dispatch-to-static-agents

## Why

The 2026-09-27 dispatch adjudication (per-dispatch dynamic `(model, depth)` binding through an HTTP child-session engine) is reversed by the owner after production use: child sessions are invisible in the TUI (probe P4 was never closed), restricted-toolset dispatches hit endpoint-side empty responses wrapped in a hardcoded attribution string, and the seed-placeholder onboarding path invites the session AI to author `forge.json` (observed: two config files written by the model, neither user-directed). Source research into two production systems — oh-my-openagent's opencode edition and zai-org/ZCode — shows both converge on **static per-agent `(model, depth)` binding dispatched through the host's native subagent channel**; neither does per-call depth selection, and omo ultimately left the opencode plugin layer entirely when it needed deeper control. The owner's real topology is a single endpoint with a single model family, where the dynamic engine delivers nothing actually consumed.

## What Changes

- **BREAKING** — remove the `forge_dispatch` tool family (`forge_dispatch`, `forge_dispatch_config`, `forge_dispatch_list`, `forge_dispatch_kill`) together with the HTTP child-session engine, its registry, background wake briefs, per-dispatch ledger, and cost aggregation. Subagents are dispatched via the host's **native `task` tool** (TUI-visible, expandable, monitorable).
- `/crew` is RETAINED as the third state-activation command (owner decision at review, 2026-09-28 — on par with `/plan` and `/goal`) and reworked onto the native channel: waves become batches of parallel `task` calls whose results return in-turn, and `crew_begin` now registers a declared subtask plan that the `crew_close` gate cross-checks the report against — replacing the removed dispatch-ledger match with plan-relative evidence. Unconfigured `/crew` is a hard initialization gate presenting configuration guidance (file paths, embedded template, self-configure or consented AI-assist, restart-vs-hot-apply timing); the configuration invitation exists nowhere else. **BREAKING** for gate semantics only: evidence references are declared-subtask titles, not dispatch ids, and there is no persistent crew summary.
- forge.json agent definitions become static bundles: each agent pins `model` (now materialized into the hidden `forge-<id>` subagent — reversing the "agents never carry a model" rule) plus an optional `thoughtLevel`; the `depths` array is deprecated with a warning finding and no longer influences behavior.
- Reasoning-depth injection moves from the per-dispatch sessionID expectation table to the `chat.params` hook **keyed by agent name**, translating the pinned `thoughtLevel` with the existing family rules (verbatim-first / no interpolation / disclosure as a finding); a no-mapping word injects nothing and emits a bounded finding instead of erroring a dispatch.
- Seed placeholder agents (`Local/GPT Luna`) and the AI-invited configuration recipe are removed: an absent `forge.json` registers nothing and fails nothing; onboarding becomes human-facing documentation only. The session AI is never the config author.
- forge.json parsing becomes **field-level fail-soft** (ZCode pattern): a semantically invalid field or agent entry degrades to a finding and is skipped while the rest of the file applies; only a syntactically broken file disables the (now empty) agent set. Replaces the whole-file→seed fallback (old D9).
- Worker discipline (workspace-relative paths only, verbatim refusal reporting, evidence-bearing conclusions) moves from the dispatch prompt wrapper into the materialized agent prompt.
- v2 `setup` registration now also creates the static subagents (create-only), narrowing the v1/v2 gap.

## Capabilities

### New Capabilities

- `forge-subagents`: static forge.json-defined subagents materialized as hidden native agents — pinned model, baked discipline prompt, shape-derived permission with `task` always denied, optional pinned `thoughtLevel` injected per agent name via chat.params, field-level fail-soft config parsing, hot-apply, and an inert unconfigured state.

### Modified Capabilities

- `dispatch`: all requirements removed — the HTTP dispatch engine, forge_dispatch tool contract, background mode, completion wake briefs, kill, dispatch ledger, self-computed cost reporting, seed-placeholder onboarding, and the introspection tool cease to exist. The surviving behaviors (forge.json file contract, agent materialization, depth translation) are superseded by `forge-subagents`.
- `crew-harness`: the `/crew` discipline re-anchors on parallel native-task waves and a declared subtask plan registered at `crew_begin {objective, subtasks}`; the `crew_close` gate cross-checks the report against the declared plan (title-matched, renegade subtasks refused) instead of the removed dispatch ledger. ADDED: an unconfigured initialization gate (hard refusal + guidance embedding the template, the consented AI-assist option, and restart/hot-apply timing — the only configuration invitation in the plugin).

## Impact

- **Code**: `plugin.ts` (drop the 4 dispatch tool registrations; config-hook materialization now writes `model`; chat.params re-keyed by agent name; engine/registry/wake wiring removed; `/crew` template and `crew_begin`/`crew_close` reworked to declared-plan semantics); `src/` deletions (`dispatch-engine.ts`, `dispatch-client.ts`, `dispatch-registry.ts`, `dispatch-resolver.ts`, `dispatch-roster.ts`, `dispatch-ledger.ts`); rewrites (`forge-config.ts`, `crew-gate.ts` → declared-plan cross-check, `dispatch-tiers.ts` → agent prompt source, `dispatch-prompt.ts`); `dispatch-depth.ts` retained for translation.
- **Tests**: dispatch-engine/client/resolver/roster suites removed; crew-gate suite reworked to declared-plan semantics; new static-agent suites (materialization, fail-soft, depth injection, no-clobber, v2 setup).
- **Docs**: README dispatch/crew sections, file-ledger table (dispatch ledger row), AGENTS.md architecture table.
- **User config**: existing `depths` fields keep the file loading but stop influencing behavior (deprecation finding); the plugin never writes or migrates the file.
- **Explicitly not solved**: endpoint-side empty responses on reduced toolsets (now surface as native task failures in the TUI, visible and attributable); per-call model/depth routing (feature removed by design); token/cost aggregation for subagent runs (removed with the engine — accepted loss).
