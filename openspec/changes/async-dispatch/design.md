# Design: async-dispatch

## Context

- Verified upstream: oh-my-openagent (oh-my-opencode, `code-yeongyu`,
  dev branch) achieves native-visible async subagents ENTIRELY at plugin
  level: own `delegate-task` tool (`tool()` from `@opencode-ai/plugin`),
  child sessions via `client.session.create({ body: { parentID, title,
  permission }, query: { directory } })`
  (`packages/omo-opencode/src/tools/delegate-task/sync-session-creator.ts:19`),
  sync mode = in-tool session polling, async mode = task manager + result
  delivery by `<system-reminder>` injection (their agent prompts: "end
  your response - wait for the `<system-reminder>`"; "NEVER call
  background_output before receiving system-reminder — BLOCKING
  anti-pattern"). Their engineering weight sits in the parent-wake
  boundary (dedupe / window-requeue / user-message-race test matrix).
- Unattended-safety pattern (verified,
  `manager-session-permission.test.ts:129-140` + `buildSyncPromptTools`):
  child sessions are created with `permission: [{permission: "question",
  action: "deny", pattern: "*"}]` and the question tool hidden at prompt
  time — a child can never block on human input; write authority comes
  from the agent's permission config, and unattended permission asks
  degrade to poll timeout.
- Verified on OUR host (no fork needed, same mechanics): the live TUI
  host (`serve --port 58686`) session list shows every native task child
  as an ordinary record — `parentID` + `directory` + title
  `"desc (@agent subagent)"` — identical to what `client.session.create`
  produces (pinned SDK 1.18.33 `gen/types.gen.d.ts:469` carries
  `parentID` in the create payload). SDK children ARE native children to
  the session tree, event bus, abort API, and token accounting. The
  historical "read-only, unmonitored subagent" pain came from
  non-session execution (in-plugin/spawned agent loops outside the host
  session system); the `opencode run` subprocess fallback is rejected
  for exactly that reason.
- Our existing assets: an SDK client is already in hand (the pool gate's
  authoritative anchor fetch uses `client.session.get`), the job registry
  provides wake queue + session.deleted harvesting + diagnostics ledger,
  and the dispatch gates (pool / crew / readonly / primary-only) are
  shared predicates on the native-task path.
- User-finalized stance: sync-vs-async is the PRIMARY AGENT's dispatch-time
  decision (mode parameter + description steering, proven by our own
  forge_shell `run_in_background` usage all session long); user mid-flight
  conversion is cosmetic and out of scope; NO phase split — async opens
  to every materialized shape at once (OMO runs write agents in
  background in production); kilo-style fork-level affordances are
  explicitly not pursued.

## Goals / Non-Goals

- Goals: (1) forge_dispatch with wait/async on SDK child sessions,
  native TUI visibility; (2) async open to EVERY materialized shape from
  day one (no v1/v2 split); (3) gate parity with native task; (4)
  completion wake reusing the job-supervisor discipline with the child's
  final message inline; (5) per-session concurrency cap; (6) owner-death
  child abort.
- Non-Goals: replacing or gating off the native task path (coexist;
  retirement is a future change); user mid-flight conversion; deadline
  auto-convert of wait dispatches; a dedicated kill/output tool (child
  sessions are natively abortable in the TUI; the wake carries the full
  result); OMO-style category model-fallback chains, team mode, tmux
  surfaces.

## Decisions

1. **SDK child sessions over `opencode run` subprocess** — same server,
   `parentID` linking makes the child render exactly like a native task
   child (the historical reason we abandoned our own dispatch surface),
   no process-tree management. Fallback `opencode run` is NOT kept: two
   transports double the failure surface for zero added capability.
2. **One tool, two modes** — `mode: "wait" | "async"`; blocking parity
   (wait) and async live behind the same gates, one code path.
3. **Job-registry reuse for lifecycle only** — an async dispatch
   registers a registry entry (kind=dispatch) reusing wake queue,
   session-death harvesting, and ledger. It is NOT a job-runner child
   process; the poller is an in-plugin interval watching the child
   session status. forge_jobs list integration is a non-goal v1 (the
   handle + wake cover the model's needs; belt stays untouched).
4. **All-shapes async + question-deny (no phase split)** — OMO runs
   write agents in background in production; unattended safety comes
   from denying the question tool session-wide at child creation (the
   child proceeds and reports instead of blocking), NOT from shape
   gating. Write authority remains the materialized permission map
   (readonly shapes keep their full deny + exec-seal). A permission ask
   no one answers degrades to the honest poll timeout (child session id
   disclosed, natively abortable). Draft-plan interop unchanged:
   readonly shapes only, both modes.
5. **Primary-only** — workers calling forge_dispatch hit the same
   primary-only refusal as STATE tools; dispatch is a coordinator
   move.
6. **Wake carries the final message (bounded tail, 2500 chars)** — our
   dispatch mandates already force concise evidence+conclusion finals;
   the wake inlines the child's final message with a 2500-character tail
   bound (disclosed here and in README; the full transcript lives in the
   child session, natively inspectable). No separate output-fetch tool,
   no second round-trip, no pre-wake polling anti-pattern (OMO's lesson,
   adopted verbatim in the tool description).
7. **wait-mode poll timeout** — honest timeout finding naming the child
   session id; the child remains natively abortable. No auto-convert to
   async on timeout (user-finalized: the dependency structure did not
   change, converting is cosmetic).

## Risks / Trade-offs

- **SDK surface drift** (`session.create`/`prompt`/`abort` availability
  on our pinned @opencode-ai/plugin+sdk versions): spike task gates the
  build; the client object is version-negotiated by the host, and OMO
  runs the same calls in production.
- **Wake races** (parent busy at completion): inherited solution — the
  job-wake delivery window + ledger; OMO's race matrix validates the
  shape of the problem, our path is already tested for jobs.
- **Model confusion between native task and forge_dispatch**: both work
  for blocking dispatch; descriptions steer (forge_dispatch for
  forge-* targets, required for async). Acceptable nondeterminism in
  v1; retire-native-task remains a future decision point.
- **Cost runaway**: per-session cap 3 in-flight async; no global budget
  machinery added (non-goal).
- **Unattended write risk**: accepted deliberately (user-finalized
  no-split stance, OMO-proven); contained by the materialized permission
  map per agent, the question-deny seal, the concurrency cap, and
  owner-death harvest — belt coverage disclosed in README.

## Migration Plan

Additive: new tool + new requirements; no config format changes; the
REMOVED requirement's prohibition text is superseded by the new surface
requirement (native task semantics untouched).

## Open Questions

- None blocking. Spike output (exact SDK call shapes on our versions)
  is recorded here during implementation.

### Spike conclusions (2026-11-15, pinned @opencode-ai/sdk 1.18.33)

Authoritative surface: `dist/gen/types.gen.d.ts` in the workspace
`.opencode/node_modules/@opencode-ai/sdk`; cross-checked against OMO
`sync-session-creator.ts` / `sync-prompt-sender.ts` /
`sync-session-poller.ts` / `sync-result-fetcher.ts`.

1. **session.create** — `SessionCreateData` (L1811-1821): `POST /session`,
   `body?: { parentID?: string; title?: string }` +
   `query?: { directory?: string }`. The GENERATED body type carries only
   `parentID`/`title`; `permission` (and `model`) are server-accepted but
   untyped — OMO passes them via an `as Record<string, unknown>` cast
   (`sync-session-creator.ts:19-37`, `permission:
   QUESTION_DENIED_SESSION_PERMISSION`). Our core does the same with a
   duck-typed `body: Record<string, unknown>` seam — no SDK types imported,
   dist keeps bundling only `@opencode-ai/plugin`. `Session.parentID?`
   at L469; response is `{ data: Session }` with `Session.id`.
2. **Async prompt send** — `session.promptAsync` EXISTS on our pin:
   `SessionPromptAsyncData` (L2329-2354): `POST /session/{id}/prompt_async`,
   body `{ agent?, parts: TextPartInput[], tools?, system?, model? }` →
   **204 void** (`SessionPromptAsyncResponses` L2366-2371: fire-and-forget,
   exactly what async dispatch needs). `TextPartInput` (L1231-1234) =
   `{ type: "text", text: string, ... }`. Sync fallback
   `SessionPromptData` (L2244-2290): same body shape, returns
   `{ info: AssistantMessage, parts }` — the core prefers `promptAsync`
   and falls back to `prompt` when the client predates it.
3. **Status polling** — `SessionStatusData` (L1836-1859):
   `GET /session/status` → map `sessionID → SessionStatus`; the union
   (L396-405) is `"idle" | { type: "retry" } | { type: "busy" }` — there
   is NO "completed"/"error" enum. Terminal is inferred (OMO parity,
   `sync-session-poller.ts:12,259`): active = `busy`/`retry` (OMO also
   tolerates `running`); completion = session left active AND latest
   assistant message has `finish` set; error = latest assistant
   `info.error` (L106: `ProviderAuthError | ... | ApiError`) or
   `session.error` events (L518-524). Idle sessions are absent from the
   map — absence alone is not terminal.
4. **Final message** — `SessionMessagesData` (L2210-2243):
   `GET /session/{id}/message?limit=N` → `Array<{ info: Message, parts:
   Part[] }>`; pick latest `info.role === "assistant"` by
   `info.time.created`, join `parts` with `type === "text"` (`TextPart`
   L142-147). AssistantMessage carries `finish?` (L126) and `error?`
   (L106) — the two terminal markers polled above.
5. **session.abort** — `SessionAbortData` (L2059-2086):
   `POST /session/{id}/abort`, `path: { id }`, optional
   `query.directory`, body never → `200: boolean`. Matches OMO
   `abortSyncSession` (`sync-session-poller.ts:23-32`) verbatim.

Core delivered as `src/dispatch-async.ts` (structural client seam, no
@opencode-ai imports); tests `tests/dispatch-async.test.mjs`.
