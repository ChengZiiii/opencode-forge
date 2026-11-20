# v2-single-agent-surface — design

## Host evidence (binary + live, 2.3.2, 2026-11-20)

- `/api/agent` records for `build`/`plan` carry `hidden: false` and
  `mode: "primary"` — `hidden` is a first-class, hot-reloadable field.
  Editing user config (`agent.build.hidden: true`) flipped the LIVE
  service's records without a restart (verified same minute).
- The config→agent merge (ConfigAgentPlugin, `id:"opencode.agent"`) is
  itself an `agent.transform` that writes, per config entry:
  `disabled → draft.remove(id)`; otherwise model/request/system/
  description/mode/**hidden**/color/steps/permissions. It also applies
  `default_agent` via `b.default(...)`.
- The agent draft editor exposes `list/get/update/remove/default` —
  plugins hold the same powers, including hiding natives and setting
  the default.
- v2 agent records have NO `tools` field; the native `explore` agent is
  defined as `permissions: deny * + allow shell/grep/glob/...` — v2
  per-agent tool visibility is permission-shaped.
- OMO's recipe (issue 3443, their source): `build: { mode:"subagent",
  hidden: true }` — hide + demote. Forge takes hide-only (no demote):
  forge has no use for dispatchable native primaries, and demoting
  changes `plan`'s identity for every existing reference.
- Error strings in the host binary: "Subagent … is hidden",
  "Creating session's agent not found: (default)" — hidden agents
  refuse task dispatch; REMOVAL (config `disabled: true`) risks
  breaking session creation that references the agent. Hide is the safe
  suppression; remove is rejected.

## Decision tree

- **D1 hide vs remove:** hide (`hidden: true`), records stay — existing
  build/plan sessions keep resolving; nothing else in the record is
  touched.
- **D2 mechanism:** v2 `v2Setup` agent transform:
  `draft.update("build"|"plan", rec => { rec.hidden = true })`, each in
  its own try/catch (per-record fail-soft), skipped when the record is
  absent or already hidden. Never writes `mode`, `system`, or anything
  else on native records.
- **D3 opt-out:** global forge.json `"hideNativeAgents": false` — the
  global layer is already loaded by `createPoolResolver` on v2, so the
  knob rides an existing, proven channel. `agent["forge"].disable`
  remains the whole-plugin off switch. If the plugin-before-config
  transform ordering holds (D5 probe), a user's explicit
  `agent.build.hidden: false` in opencode config ALSO wins (merge runs
  later); otherwise the forge.json knob is the only opt-out and the
  README says so.
- **D4 shell front door:** every forge-family record (primary + all
  materialized `forge-*`, any shape) pushes
  `{action:"shell", resource:"*", effect:"deny"}` into its permission
  payload at registration. GATING PROBE (task 1.1): if deny shapes the
  model-facing tool list (expected, per the explore-agent design), this
  is the front door and the belt stays as depth. If deny turns out to
  be execution-only on this host, the slice closes as a verified
  limitation: belt + system mandate remain the v2 posture and the drift
  is documented — global `tool.transform` removal is rejected because
  it would strip the shell from NON-forge agents, violating the
  non-forge isolation requirement.
- **D5 default subject:** `draft.default(FORGE_AGENT)` guarded by
  `typeof draft.default === "function"`, shipped ONLY if task 1.2
  confirms plugin transforms run BEFORE the config merge on 2.3.2 (so
  an explicit user `default_agent` overrides ours — the same
  merge-after-transform ordering already observed live in the
  vision-agent knob investigation). Otherwise: no code, README keeps
  the `default_agent` recipe (this host already has it in config).

## Non-goals

- No v1 changes: the v1 config hook already hides shell from the family
  and sets the default; v1 cannot touch native agents (config hook
  returns own entries only) — v1 users get the README config recipe.
- No demote of native primaries (OMO demotes because their agents
  dispatch to natives; forge never dispatches to build/plan).
- No touching of `general`/`explore`/`compaction`/`title`/`summary` —
  subagents and host internals stay visible/functional.
- No global tool removal/rename; the tool registry stays as-is.

## Test plan

- v2-setup wiring: hidden applied when the record exists; absent record
  → skip; already hidden → untouched; `hideNativeAgents:false` → skip;
  one record throwing never blocks the other; primary/workers records
  carry the shell deny; default setter called only under the confirmed
  guard.
- Existing suites stay green (no v1 path changes).
- Sandbox E2E on 2.3.2: picker shows forge only; fresh session defaults
  to forge; the forge session's model-facing tool list has no builtin
  shell; forge_shell still executes with the deny present; belt still
  refuses a forced shell call.
