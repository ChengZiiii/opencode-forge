# Design: fix-dispatch-view-capability

## Decision

Two coordinated pieces:

1. **v2 adapter gains a real messages reader** (`v2SessionClient` in
   plugin.ts): a lazily-discovered HTTP reader against the host's own
   session-message API. Discovery reads `service.json` (`$XDG_STATE_HOME`/
   `~/.local/state` + `/opencode/service.json` — the host's own discovery
   artifact, {url, password}); the request is
   `GET {url}/api/session/{id}/message` with `Authorization: Basic
   opencode:<password>` and `location[directory]` from a per-child map
   captured at create time (the adapter's create already receives
   `query.directory`). Tolerant response parsing: bare array or {data}
   envelope. Any failure returns `{error}` (a TRANSIENT failure of a
   PROVIDED capability — the existing honest view-loss semantics apply,
   which is correct).
2. **Capability-aware core** (dispatch-async.ts): `DispatchClient.messages`
   becomes optional. `pollChild` skips the messages leg when the method is
   absent (no `messagesFailed`); view-loss counting requires ACTIVELY
   failed legs — absence never counts, so a capability-less client can
   never reach `stream-lost` from absence alone and the wiring's
   unreadable-view disclosure cannot fire. `fetchFinalMessage` returns a
   clean `{ok:false, error:"no messages capability ..."}` instead of a
   TypeError string. Status stays non-optional-shaped but equally guarded:
   absence yields `statusMap === undefined` which today means
   `active = true` (the soundness posture) — unchanged.

## Field realities (probes + research, 2026-11-22)

- v2 session domain methods (shape probe on 2.3.2): hook, list, create,
  get, remove, switchAgent, switchModel, prompt, generate, command,
  compact, synthetic, interrupt, update, move, wait, context, instructions.
  **No messages. No status.** The v1 SDK client shape (`input.client`,
  with `session.messages` → GET /session/{id}/message) is never injected
  on `plugins`-config hosts — forge's v2 path runs exclusively there.
- Production symptom chain (user-visible disclosure 2026-11-22): every
  poll tick threw `TypeError: client.session.messages is not a function`;
  status was equally absent → view-loss streak → `stream-lost` verdict →
  withheld by the execution-activity guard (the
  dispatch-stream-loss-honesty machinery) → one per-hold
  `[forge:dispatch-progress] the dispatch view (status + messages) is
  unreadable...` disclosure; the terminal fetch produced
  `(final message unavailable: session.messages threw ...)`. The child's
  actual report arrived anyway via the durable terminal event payload —
  the signal core owned everything.
- HTTP surface: `GET /api/session/{id}/message?location[directory]=<ws>`
  with Basic auth works on 2.3.2 (used by every 2026-11-22 sandbox E2E
  driver to read child messages). `service.json` is the host's own
  discovery file (present on real hosts running `serve --service`;
  absent in plain-serve sandboxes unless `--service` is used).
- Upstream anomalyco/opencode#59566 confirms the v2 HTTP API provides
  `session.message.list/get` and that the plugin session domain resolves
  child sessions with no ownership check — a server-side plugin reading
  its own children over HTTP is sanctioned usage.
- Ecosystem: event-driven competitors (opencode-asynchronous-agent) never
  poll messages; TUI monitors (agents-monitor, agent-pulse) read the
  TUI's shared message store, a surface server plugins do not have;
  native-task wrappers (background-subagent, task-model) delegate tracking
  to the host. Forge keeps its own children (pinned models, pools,
  adoption), so an HTTP-backed reader is the v2-correct equivalent of the
  v1 client method.

## What this deliberately does NOT change

- Completion semantics on v2: `status` remains unavailable, so the
  `unreadable status = active` soundness posture keeps poll-completion
  from firing on v2 — completion stays owned by the signal core and the
  reconcile pass (the working production path). The messages leg powers
  error classification, the wake's final text, and progress content — not
  the completion verdict.
- The stream-loss machinery: a PROVIDED-but-failing messages reader counts
  exactly as before (withholding guard, reconcile confirmation, honest
  classification). Only capability ABSENCE changes behavior.
- v1 hosts: `input.client.session.messages` exists there; the guards are
  no-ops.

## Verification shape (③)

1. Unit: capability-absent client → poll never reaches stream-lost and
   fetchFinalMessage returns the clean capability error; provided-but-
   failing client → existing view-loss behavior unchanged (regression);
   v2 adapter messages reader → stubbed service.json + fetch → correct
   URL/auth/parse; service.json missing → adapter omits messages.
2. Sandbox (production-identical): `serve --service` with isolated XDG
   (so service.json lands inside the sandbox), git+file plugin, pinned
   dispatch → wake contains the child's final report text; zero
   `is not a function`; zero unreadable-view disclosures; zero
   `final message unavailable`.
