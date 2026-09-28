# Design: simplify-dispatch-to-static-agents

## Context

The dispatch suite shipped 2026-09-27 as a three-layer stack (roster → forge_dispatch HTTP engine → /crew discipline). Production use on the owner's real topology (single endpoint `glm-coding-worker`, single model family `glm-5.3-flash`, depth not injectable for that provider family) exposed four failures — see proposal.md Why. The surviving assets this design builds on: `forge-config.ts` (JSONC parsing + mtime-cached cascade loader), `dispatch-depth.ts` (family translation: verbatim-first / no interpolation / budget table / toggle), `dispatch-tiers.ts` (role prompts + permission shaping), `dispatch-prompt.ts` (worker discipline), and the config-hook materialization path in `plugin.ts`. Evidence base: probe P1 (chat.params fires for any session carrying an `agent` parameter — including task-spawned sessions), the omo/ZCode source research summarized in the conversation record, and the timeout-incident postmortem.

## Goals / Non-Goals

**Goals:**

- Subagents a fresh user can see, click, and monitor in the host TUI (native `task` tool channel).
- Zero configuration by the session AI; onboarding is human-only and inert until the human acts.
- A config surface small enough to hold in one glance: `{model, thoughtLevel?, prompt?, shape?, permission?}` per agent.
- Behavior preserved where it already worked: JSONC cascade + hot-apply, create-only materialization, shape-derived permission with the forced `task: deny`, family-true depth translation.

**Non-Goals:**

- Fixing endpoint-side empty responses on reduced toolsets (external cause; failures now surface as visible native task failures; `shape: "write"` remains the documented workaround).
- Fallback chains per agent (omo-style `(model, depth)` chain rotation) — deferred until a multi-model topology exists.
- Legacy reasoning-level rename table (ZCode `legacy-reasoning-level-renames.ts` pattern) — deferred; verbatim pass-through keeps working as today.
- Token/cost aggregation, background handles, wake briefs, kill, ledger — removed with the engine, not redesigned.
- Re-adding per-call depth when upstream `variant` ships in a release — tracked as a future change; the chat.params keying designed here (agent name) survives that migration.

## Decisions

### D1 — Static bundling, reversing the 2026-09-27 adjudication (owner decision)

Per-agent static `(model, thoughtLevel)` — recorded explicitly as a reversal of the earlier "持久化纪律、动态绑大脑" thesis. Alternatives rejected: keep dynamic and patch the four UX failures individually (the TUI invisibility of HTTP child sessions is structural, not patchable in a plugin; omo resolved the same ceiling by leaving the opencode plugin layer entirely); keep both paths (two doors was the original confusion — three doors is worse).

### D2 — Native `task` as the only dispatch channel; materialization writes `model`

Agents materialize via the existing config hook, now carrying `model` (reversal of "agents never set a model") and **not** `hidden` — hidden agents risk disappearing from the task tool's vocabulary, and discoverability through that tool is the entire point. `mode: subagent` keeps them out of the Tab cycle. Per-call depth is impossible on 1.18.32 (task tool has no depth argument; no `variant` field in the message body) — accepted as the price of the channel. Alternative rejected: keep the HTTP engine just for depth (that engine is the source of every observed failure class).

### D3 — chat.params keyed by agent name; untranslatable words degrade to findings

The old sessionID-keyed expectation table was fed by the engine at spawn time. The new key is the agent name carried in the hook input (stable across sessions and spawn paths; P1 evidence). Consequence: concurrency-safe with zero state. Semantic change taken deliberately: a `no-mapping` word (e.g. `medium` on a `low/high/max`-only native ladder) **injects nothing and records a finding** instead of erroring — there is no dispatch call left to fail, and the worker session must not be broken by a config word. This diverges from the old fail-closed dispatch semantics in exactly one place, and the divergence is disclosed as a finding naming both vocabularies.

### D4 — Field-level fail-soft parsing (ZCode `subagentMarkdown` pattern)

Semantic validation degrades at the smallest enclosing level: bad agent entry → skip that agent, siblings apply; bad optional field → ignore the field, agent applies; broken JSONC → empty set + error finding. The seed agents and the whole-file→seed fallback (old D9) are deleted — there is no seed to fall back to, and no placeholder pins to confuse anyone. Findings surface through plugin diagnostics (the existing validation-findings channel), never silently.

### D5 — No AI onboarding path

No seed, no recipe, no "writable back" introspection tool. Unconfigured = inert and silent: nothing registered, nothing fails, nothing teaches the model to touch config. The README (human-facing) carries the template and the two file paths. This removes the observed failure mode at its root (two AI-authored forge.json files, neither user-directed).

### D6 — /crew retained and reworked onto the declared plan + native task waves (owner decision at review, 2026-09-28)

Originally proposed for removal; the owner kept `/crew` as the third state-activation command (`/plan` / `/goal` / `/crew`). Rework, zero engine dependencies: `crew_begin {objective, subtasks[{title, agent?}]}` registers the declared plan in memory; the discipline executes waves as batches of parallel native `task` calls (results return in-turn — no brief pacing needed); `crew_close` stays ask-pinned and cross-checks the report against the declared plan (every declared subtask verdicted; renegade undeclared subtasks refused; FAIL requires attempt + retry reports). Anti-fabrication shifts from machine-observed dispatches (ledger ids) to declared-plan title matching — a declared subtask can no more be silently dropped than before, while improvised mid-flight work is refused rather than auto-adopted (fold discoveries into existing verdict notes, or discard and re-crew — crews are cheap in-memory state). No persistent crew summary (the dispatch ledger is gone; the close output and session transcript are the record). Alternatives rejected: removal (owner veto); structural-only close without a registered plan (weaker anti-drop guarantee); a dedicated crew ledger file (deferred — resurrect persistence only if the owner asks).

### D7 — What is lost, on the record

Cost/token aggregation (engine-polled transcripts), background handles + idle wake briefs, kill, the dispatch ledger, per-call `(model, depth)`, and persistent crew summaries (previously appended to the dispatch ledger — the close output is now the record). All accepted by the owner in conversation. Plan-draft interop is inherited (the plan harness already denies `task` during drafts — one less plugin-side refusal to maintain).

### D8 — v2 setup registers the subagents

The v2 `setup` entry now creates the same `forge-<id>` agents (create-only, structured-type guards) — agent registration needs no v1-only domain, so the v1/v2 gap for this capability closes completely. Tool/permission domains remain v1-only as before.

### D9 — Routing as prompt-level discipline, not a mechanism

Everyday subagent routing (prefer a matching `forge-*` agent; on no match use the native channel and say so to the user) is implemented as a routing-hint line in the plugin-authored forge agent prompt plus agent descriptions in the config — the model judges the match; the plugin builds no matcher. Alternative rejected: a plugin-side role matcher (over-engineering; both omo and ZCode rely on model choice driven by descriptions). Consequence accepted: the "明文告知" is best-effort discipline, deterministic only insofar as prompt compliance goes.

### D10 — Crew initialization gate and the AI-assist consent boundary (owner decisions at review, 2026-09-28)

Unconfigured `/crew` is a HARD gate (owner choice over a soft warn-and-continue): empty agent set → refuse entry, present initialization guidance (paths + embedded JSONC template + timing: agent additions need a restart, `thoughtLevel` edits hot-apply). The configuration invitation exists ONLY inside this gate. AI-assisted configuration is offered as an option but SHALL wait for the user's explicit in-conversation go-ahead and write through the normal visible write path — the consent boundary that separates this from the 2026-09-27 recipe failure (uninvited, model-initiated, invisible). Every other surface stays configuration-silent (D5). Alternatives rejected: soft gate (deferred until the owner wants it); a dedicated init command (the /crew flow is the only consumer).

## Risks / Trade-offs

- [Hidden/task-vocabulary assumption wrong on some host version — agents materialize but the model can't discover them] → E2E asserts the task tool lists `forge-*` agents on the pinned host version; mitigation if it fails: document `@forge-<id>` invocation; the capability degrades to "still works, less discoverable".
- [chat.params may not fire for task-spawned sessions on future hosts] → P1 probe evidence says sessions with an `agent` parameter all trigger; verified again in E2E; failure mode is silent no-injection (fail-soft by design, matches D3).
- [Toolset reduction still triggers endpoint empty responses] → external; now visible as task failures in the TUI (attributable, monitorable) instead of wrapped engine errors; README keeps the `shape: "write"` workaround.
- [Users with existing `depths` arrays see behavior change] → deprecation finding names each affected agent at load; README migration note; plugin never edits the file.
- [Declared-plan rigidity frustrates mid-flight discovery] → discipline template mandates folding discoveries into existing subtask verdict notes or discarding + re-crewing; in-memory crews make restarts cheap.
- [AI oversteps the consent boundary and writes config uninvited] → the invitation exists only in the /crew gate text; every other surface stays configuration-silent (D5); the write itself goes through the host's visible write path and permission flow; discipline text mandates waiting for the user's go-ahead.

## Migration Plan

1. Ship order: implement → full test suite → `bun run bundle` → official-install E2E (per AGENTS.md 终验) asserting: no forge_dispatch tools, task tool lists forge agents, thoughtLevel injection reaches chat.params on a task-spawned session, fail-soft parsing findings.
2. User migration (optional): edit forge.json to replace `depths` with `thoughtLevel`; absent = no injection. No plugin-side migration.
3. Rollback: `git revert` + reinstall the previous dist; forge.json files are untouched by the plugin in both directions.
4. Debris: `<tmp>/opencode-forge/dispatch/` ledger files remain as inert runtime debris — README's file-ledger table drops the row; users may delete the directory freely.

## Open Questions

- Whether materialized agents should be excludable from `@` mention completion on hosts where subagent mode still surfaces them there (cosmetic; host-governed; safe to answer later).
