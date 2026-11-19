## Context

forge already ships `{ id, server, setup }`; `setup` is a defensive
skeleton (agent + skill, simplified single-workspace pool resolution,
structural guards) written when V2 lacked the needed domains. The entire
`src/*` layer (pool resolver, crew gate, plan/goal file cores, run-check,
job manager/runner, watchdog, exec classify, models-dev slices,
dispatch tiers/prompts/depths) is host-agnostic and fs/spawn-injectable —
the V2 port is a wiring project over shared cores, not a rewrite. The V1
entry is NOT modified. Precedent: oh-my-openagent's maintainer-completed
port (issue #8485) — staged waves, a full API inventory first, every seam
runtime-verified on a real V2 host. Shared conventions:
`../opencode-v2-migration-conventions.md`.

## Goals / Non-Goals

**Goals:**
- Full V2 parity (agents, tools, permission belt, session seams,
  commands, continuation engines) in staged waves, each wave gated on the
  V1 suite staying green and the sandbox verifying that wave's seams.
- One code path per concern: V2 registrations call the same cores the V1
  hooks call.

**Non-Goals:**
- No V1 retirement; no behavior change on V1 hosts.
- No `@opencode/plugin` runtime dependency (structural typing stays).
- No V2 TUI plugin (forge has none).
- No new harness behavior — parity only.

## Decisions

1. **Staged waves with green gates (omo playbook).** Wave order: (W1)
   mock-context harness + agent materialization parity; (W2) tool
   surface; (W3) permission belt; (W4) session seams + commands; (W5)
   event-driven continuation engines; (W6) sandbox full-surface
   verification; (W7) manifest/docs/release. Each wave: unit tests first,
   V1 suite green before merge-in, sandbox seam check where applicable.
2. **Permission belt semantics on `evaluate`.** V1 `permission.ask`
   rewrites non-deny outcomes to ask (user dialog = gate) or denies
   outright (draft freeze, worker→STATE). V2's evaluate hook receives the
   request with the resolved rule; the belt applies the same decision
   table and produces ask/deny outcomes. The hard part is parity of
   precedence: the belt runs only when no explicit user rule decides
   first, exactly like V1's "except explicit deny" clause. Sandbox
   verifies the real event shape before W3 lands.
3. **Session-family mapping re-anchored on V2 seams.** The three-source
   capture (chat.message primary / chat.params secondary / tool context
   strongest) maps to prompt hook / context hook / tool execute.before.
   Injection ordering differs on V2 (prompt and context are separate
   events); the context hook performs family-dependent injections, so
   capture happens in prompt + execute.before and the context handler
   reads the map — same map, new event topology. Family-dependent
   behavior on a session whose family is still unknown keeps the
   fail-silent/fail-open posture per tool-partition.
4. **Continuation engines ride `ctx.event.subscribe()`.** The idle
   debounce → guard chain → brief → prompt pipeline moves from the V1
   event hook + `client.session.prompt*` to the V2 event subscription +
   session domain; the goal engine's session reads
   (`messages()`/`get()`) move to the V2 session read (the V1
   `messages()` maps to V2 `context()` per the omo evidence). Timers keep
   the existing debounce env knob; cleanup aborts the subscription.
5. **autocontinue suppression: re-evaluate, then decide.** V2 has no
   documented equivalent of `experimental.compaction.autocontinue`. The
   sandbox stage observes V2's actual compaction/continuation behavior on
   an active-goal session: if no synthetic auto-continue exists, the
   suppression is dropped and the finding is recorded here and in the
   README; if one exists, the compaction hook's event is inspected for a
   functional lever. Either way the goal-brief compaction reinjection
   (the compression-safety carrier) ports to
   `ctx.session.hook("compaction")`.
6. **Commands via the command domain.** `/plan` `/goal` `/crew` templates
   are static strings served from dist today; V2 registers them via
   `ctx.command.transform`. Host skill→command promotion is unaffected
   (forge ships no bundled skill).
7. **Structural typing + guarded readers (kept).** No `@opencode/plugin`
   import; every domain access `?.` + `typeof` guarded; a drifted domain
   disables exactly its own slice (new spec text pins this).

## Risks / Trade-offs

- [V2 permission evaluate precedence may differ from V1 ask-rewrite
  timing] → W3 lands only after the sandbox pins the real event flow; unit
  mocks mirror observed shapes; the belt's own decision table is pure and
  already unit-covered.
- [Session event topology change could miss family capture for some
  message kinds] → the strongest source (tool context) still anchors
  every guard; fail-open posture unchanged for unknown sessions.
- [Continuation engine regressions are silent (a goal loop that stops
  continuing)] → W6 sandbox runs a scripted idle-continuation scenario
  end-to-end; the existing goal-mode suite ports its scenarios to the V2
  harness.
- [Scale: ~20 tools × schema conversion] → mechanical, wave-gated, and
  covered by a shared schema-builder helper so the V1 `tool.schema.*`
  definitions translate in one place.

## Migration Plan

Waves W1–W5 as in Decision 1, each independently shippable in-repo but
released together at W7. Release: version bump, bundle, publish per the
release-train recipe (registry cache-buster verify, store flip), then the
V1-host install regression. Rollback: the V2 entry is additive; reverting
`setup` growth restores the skeleton; V1 hosts never load it.

## Open Questions

- Exact V2 shapes for the permission evaluate event, session context
  event (messages/parts), compaction event, and the session read
  contract — resolved empirically in the sandbox stages; specs pin
  behavior, not field names.
- Whether V2 exhibits a synthetic compaction auto-continue at all —
  resolved by the W6 observation (Decision 5).
- W3/W4 field-name assumptions recorded during implementation (all
  pinned to mock shapes; W6 verifies and adjusts mocks in the same
  change):
  - **permission evaluate event**: request fields assumed top-level
    (or nested under `request`); tool name resolved via the same
    `metadata.tool → permission → id → type` chain; outcome slot
    assumed writable under `status` (fallbacks `decision`/`outcome`
    read+written when present). Whether mutating that slot actually
    influences the host's resolution is a W6 observation.
  - **tool execute.before/after event**: assumed
    `{ tool, sessionID, args }` with `args` also accepted as
    `arguments`/`input`; refusal = THROWING inside the hook callback
    (v1 parity) — W6 must confirm a throw aborts the call on V2.
  - **session prompt/context/compaction events**: `agent` as string or
    `{ name }`; `context` mutates `event.options` (depth) and
    `event.system` (created when absent, injections); `compaction`
    appends to `event.context` (created when absent).
  - **session-domain record read**: `ctx.session.get({ path: { id } })`
    assumed as the `client.session.get` analog for the dispatch-belt
    anchor resolution; absent ⇒ the adapter passes null and the belts
    fall back to the in-memory map + fail-open (no degradation today).
  - **command def**: `{ name, template: string, description }` with a
    create-only guard via `editor.get(name)`.
  - **W5 event-domain shapes** (task 5.1; all pinned to mock shapes, W6
    verifies and adjusts in the same change):
    - **subscribe signature + handler shape**: assumed
      `ctx.event.subscribe(handlers)` where `handlers` is an
      event-type → async callback map (`"session.idle"`,
      `"session.deleted"`), returning an abort function (the setup
      cleanup calls it; a non-function return degrades to no cleanup).
      Whether the real API instead takes a single callback or an
      options object with `{ signal }` is a W6 observation.
    - **event envelope**: the v1 `{ type, properties: {...} }` envelope
      OR a flat payload — both accepted (first-level `properties`
      unwrap); `sessionID`/`sessionId` spellings for idle, `info.id`
      (or a flat `sessionID`) for deleted.
    - **session-domain sends/reads**: `ctx.session.prompt` /
      `promptAsync` / `status` / `get` assumed as the v1
      `client.session.*` analogs feeding the shared continuation
      engine (`promptAsync` falls back to `prompt` when absent); a
      missing method disables only its own slice (no goal continuation
      without `prompt`+`get`, no wakes without any send).

### W6a field realities (sandbox 2.3.2 + SDK 2.3.2 types)

The 2.3.2 sandbox E2E (live SSE capture + binary scan) plus the unpacked
`@opencode/plugin` / `@opencode/schema` 2.3.2 type files override every
W3/W4/W5 assumption above. Resolutions, each with its type evidence:

1. **EVENT DOMAIN** — `promise/event.d.ts`: `subscribe(options?)` returns
   an **AsyncIterable** of events (NO handlers-map, NO abort return
   value). `SubscribeOptions` carries `{ types?, signal? }`
   (`promise/adapter.js` `makeStreams`: abort via
   `options.signal.addEventListener("abort", ...)`, close via
   `iterator.return()`). Envelope is `{ id, created, type, data: {...} }`
   (@opencode/protocol `session-event.d.ts` — the payload lives under
   **`data`**, NOT `properties`). Emitted names on 2.3.2 include
   `session.execution.started|succeeded|failed|interrupted` (THE idle
   signal is **`session.execution.succeeded`**; `"session.idle"` exists
   in the schema but is NOT emitted — kept as a harmless alias),
   `session.deleted` (26x literals; `Deleted.data = { sessionID }`),
   `permission.asked`/`replied`, `session.created/updated`,
   `session.inbox.enqueued|delivered`.
   **FIX**: `v2SubscribeEvents` consumes the AsyncIterable in a detached
   for-await loop; payload under `.data` (`v2EventFields` reads `data`
   first, legacy `properties` as fallback); cleanup = AbortController +
   `iterator.return()`.
2. **IDLE MECHANISM CHOICE** — idle continuation (goal loop) and job-wake
   delivery ride the IN-PROCESS session hook
   `ctx.session.hook("experimental.idle", cb)`
   (`SessionHooks["experimental.idle"]: SessionIdle { sessionID,
   background: SessionIdleBackground[] }`, doc: "runs when a Session
   finishes model work and has no pending input, just before it goes
   idle"; hooks return `Registration { dispose }`). Rationale: in-process
   (no SSE race), richer `background` info (shell/subagent/codemode
   still running — a plugin waiting on that work can simply return), and
   the hook's own doc says input it admits runs in the same execution.
   The SSE `session.execution.succeeded` edge is kept ONLY as a fallback
   when the `experimental.idle` hook could not be registered (drifted
   session domain). `session.deleted` harvest stays on
   `event.subscribe` (AsyncIterable) — it is a lifecycle fact, not an
   idle edge. The idle work itself is detached (`void`) so the hook
   returns promptly.
3. **SESSION DOMAIN** — `promise/session.d.ts`: `SessionDomain =
   Pick<SessionApi, "list"|"create"|"get"|"remove"|"switchAgent"|
   "switchModel"|"prompt"|"generate"|"command"|"compact"|"synthetic"|
   "interrupt"|"update"|"move"|"context">` — there is **NO `promptAsync`**
   and **NO `status`**. `prompt` input is the flat **SessionPrompt**
   `{ sessionID, messageID, prompt: PromptInput.Prompt, metadata?,
   delivery: SessionInbox.Delivery }`; `PromptInput.Prompt`'s minimal
   valid shape is `{ text }` (@opencode/schema `prompt-input.d.ts`:
   `Prompt: Schema.Struct({ readonly text: Schema.String, ...
   optional files/agents/skills })`); `SessionInbox.Delivery` is
   `"steer" | "queue"` (`session-inbox.d.ts`). **FIX**:
   `v2SessionClient` translates the v1-shaped sends
   `{path:{id}, body:{parts:[{text}]}}` the shared cores emit into
   `{ sessionID, prompt: { text }, delivery: "steer" }` (an idle
   session's continuation/wake steers its next execution);
   `promptAsync` is approximated by the blocking `prompt` send (wakes
   target idle sessions, so the block is bounded by the send).
4. **PERMISSION DOMAIN** — `promise/permission.d.ts`: hook
   `("evaluate", cb)` where cb receives a MUTABLE
   **PermissionEvaluation** `{ sessionID, agent?, action, resources[],
   metadata?, source?, effect, message? }` and signals by MUTATING
   `input.effect` (may set `input.message`); returns void/Promise<void>.
   `Permission.Effect` is exactly `"allow" | "deny" | "ask"`
   (@opencode/schema `permission.d.ts`:
   `Schema.Literals<readonly ["allow", "deny", "ask"]>`). **FIX**: the
   belt mutates `effect` (doors allow→ask unless already deny; draft
   write-freeze → deny + message); name chain pruned to
   `metadata.tool → action` (the only fields the real type carries; the
   v1 `permission`/`id`/`type` chain and the status/decision/outcome
   slot guessing are gone).
   **GATE MAPPING** (every W3 gate):
   - Pure classification/refusal (doors forced to a REAL ask; draft
     write-freeze deny; forge_shell pass-through) — stays
     **evaluate-mutation** (the host resolves the ask prompt).
   - Decision-RETURNING gates — the v1 `context.ask` seam inside the
     tool cores (plan_approve / plan_close / goal_write(arm) /
     goal_complete / goal_resume / goal_discard / crew_close, plus
     forge_shell's posture ask) — map to
     **`ctx.permission.assert(input)`** ("evaluates rules and prompts
     the user, resolves when allowed, rejects with Tool.Error on deny";
     `AssertInput.Encoded = { sessionID, agent?, action, resources[],
     save?, metadata?, source? }`). `v2ToolContext` synthesizes the
     AskFn the shared cores expect (permission key → `action`, patterns
     → `resources`, metadata passthrough); assert rejection propagates
     as the gate refusal, resolution as allow.
5. **TOOL DOMAIN** — `promise/tool.d.ts`: `execute.before` payload is
   `{ tool, sessionID, agent, messageID, id: Tool.CallID, input }` — the
   V1 `callID` field is named **`id`** in V2 and the arguments live
   under **`input`**. `execute.after` exists with `status:
   "completed"|"error"` + `result`/`error`. The real ToolContext
   (`{sessionID, agent, messageID, signal, progress, ...}`) has NO
   `ask`, NO `worktree`, NO `metadata` — `v2ToolContext` synthesizes
   `ask` (via assert, see 4), falls `worktree` back to the session map
   then the host anchor, and defaults `metadata` to a no-op.
   `ToolEditor` entries are keyed by `id` (effective name).
6. **SESSION HOOKS** — names `"prompt" | "context" | "compaction"`
   CONFIRMED (`SessionHooks`), plus `"experimental.idle"` (see 2).
   Shapes: prompt = SessionPrompt (**no `agent` field** — family
   capture therefore rides the `context` hook's `SessionContext.agent`
   and `execute.before`'s `agent`; the prompt hook keeps only
   busy-marking); context = SessionContext with `system:
   Array<SystemPart>` + `tools` record + mutable `options`; compaction
   = SessionCompaction with optional `result` override (the goal-brief
   reinjection appends to `event.context` as before). Registrations
   return `Registration { dispose }` — collected for the setup cleanup.

Drift-matrix deltas from these resolutions: session-hooks registration
set is now `prompt/context/compaction/experimental.idle`; the event mock
is an AsyncIterable with an `emit(type, data)` helper; permission
assertions are recorded (`state.asserts`) with configurable
allow/deny; tool-editor entries carry `id`; tool-hook tests use
`{tool, sessionID, agent, messageID, id, input}` payloads.

### W6 live-verification supersessions (probe plugin + host E2E, 2.3.2)

The live sandbox runs (probe plugin shape matrix + driver E2E ×2, exit 0)
override two of the W6a type-derived shapes above and add new realities.
Each verified against the RUNNING host, not just types:

7. **PLUGIN EXPORT CONTRACT** — the host loader validates
   `mod.default` against `{id, effect: fn}` OR `{id, setup: fn}`
   (binary: `Ope=o({default:x([o({id,effect}),o({id,setup})])})`);
   `T?.plugin` named exports are read but a module with neither shape
   silently degrades to a NO-OP plugin (`T?.plugin ?? {id: dirName,
   effect: …}`) — bare named-`setup` exports are never called and there
   is NO load error. Forge's `export default {id, server, setup}` was
   already correct.
8. **PROMPT SEND SHAPE (supersedes W6a §3)** — the type-derived
   `{sessionID, prompt:{text}, delivery}` spelling is REJECTED by the
   running host (`SchemaError: Missing key at ["text"]`). Live shape
   matrix (probe plugin, six spellings): ONLY the flat root-level
   **`{sessionID, text}`** passes validation and starts a turn;
   `prompt:{text}` / `prompt:{parts}` / `{path:{id}, body:{text}}` /
   `{path:{id}, body:{parts}}` all throw. The call BLOCKS until the turn
   completes. **FIX**: `v2PromptInputOf` emits `{sessionID, text}`; the
   continuation pre-marks the turn before the await and ROLLS BACK on
   send failure (a failed send must not leave a phantom no-activity
   pending turn — the no-progress detector would outrun the transport
   counter; goal-mode test pins this).
9. **SESSION.GET SHAPE** — `ctx.session.get` validates a flat
   `{sessionID}` param (the v1 `{path:{id}}` throws the same
   SchemaError). The returned record carries the directory under
   **`location.directory`** (flat `directory`/`worktree` are absent).
   **FIX**: `v2SessionIdOf` translator in BOTH adapters
   (`v2SessionClient.get` + `v2AnchorClient`); both readers fall back to
   `location.directory`.
10. **COMMAND DOMAIN** — `promise/command.d.ts`: `CommandDefinition` is
    EXECUTE-based `{name, description?, execute({sessionID, prompt,
    delivery})}`; the editor exposes ONLY `add()` (no list/get/remove).
    The v1 template-command port is therefore: each command's execute
    sends the SAME constant template text into the invoking session via
    the flat prompt shape; `/crew` re-resolves its template lazily at
    invocation (pool mtime hot-apply reflected without restart; the
    description is frozen at registration). **Documented drift**: the
    v1 create-only rule is not implementable (no editor.get) — forge
    adds last; on 2.3.2 forge's `/goal` overwrites the host built-in.
11. **AGENT MODEL PINS** — writing a model on the v2 agent draft breaks
    the agent layer in BOTH spellings (v1 string `"provider/model"` AND
    parsed `{providerID, modelID}`): the /api/agent encoder later 500s
    ("Server failed to encode its response"). **Documented drift**: the
    pool model pin is V1-ONLY on this release; the v2 draft carries
    description/system/mode/permission only. The thoughtLevel pin is
    unaffected (runtime chat.params pool lookup by agent id). Verified
    by live bisect: minimal pool (no model) materializes and lists fine
    (`forge-live-research`, mode subagent).
12. **PERMISSION ASK WIRE** — the ask gate surfaces as SSE
    `permission.asked` `{data: {id, sessionID, action, resources[],
    metadata{title}}}`; the reply route is
    `POST /api/session/:sessionID/permission/:requestID/reply` with
    body `{decision: "once"}` (204) — binary-decoded route
    (`session.permission.reply`) + live 204 + observed
    `permission.replied` echo. The E2E driver uses this to pass the
    goal_complete gate.
13. **SESSION CREATE FOR FAMILY GATING** — the continuation family gate
    needs the session to run a forge-family agent: the driver (and any
    scripted probe) must create sessions with `{agent: "forge"}` on
    POST /api/session; a default-agent (build) session's idle is skipped
    (`skip: non-forge agent at schedule`) by design.
14. **AUTOCONTINUE (Decision 5 RESOLVED)** — binary scan of 2.3.2: the
    only synthetic auto-continues are opt-in TUI settings
    (`autoContinueAtUsageLimit`, question-dialog auto-answer — default
    "never", "auto-continue only runs when explicitly set"). NO default
    per-turn autocontinue exists on V2; nothing fights the goal loop.
    The compaction hook's goal-brief reinjection remains the loop's
    compaction-safety net. README v2 note: no autocontinue disable is
    needed on v2 hosts.
15. **EVIDENCE** — scripted idle-continuation E2E (driver
    `live-loop-e2e-v2.mjs`): forge-agent session → bootstrap idle →
    goal armed → idle #2 → `continued turn=1/3` → model creates
    done.txt + calls goal_complete → permission ask → reply "once" →
    host-side check rerun (check log OK entries) →
    `status=completed turns=1/3` — exit 0, reproduced twice across dist
    revisions. Draft write-freeze refusal observed live: after
    plan_write, a write attempt is refused with the verbatim
    `"[forge] A plan is in draft; write operations are denied (write)…"`
    and the file is NOT created.
