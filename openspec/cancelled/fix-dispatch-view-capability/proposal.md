# Proposal: fix-dispatch-view-capability

## Why

On the real 2.3.2 host every pinned dispatch emitted a noisy disclosure and
an internal TypeError: the dispatch watch's progress view called
`client.session.messages(...)`, but on v2 hosts the injected client has no
such method — the v2 session domain exposes 18 methods (probe: hook, list,
create, get, remove, switchAgent, switchModel, prompt, generate, command,
compact, synthetic, interrupt, update, move, wait, context, instructions —
no messages) and the forge v2 adapter (`v2SessionClient`) wires only
prompt/get/create. Every poll tick threw `TypeError: client.session.messages
is not a function`, counted as "view unreadable", and completion detection
survived only because the stream-loss withholding guard (execution-signal
activity) plus the signal core did the real work. The user-visible symptom:
a per-hold `[forge:dispatch-progress] the dispatch view (status + messages)
is unreadable...` disclosure on every dispatch, plus
`(final message unavailable: session.messages threw ... is not a function)`
instead of the child's final text in wake scaffolding.

Ecosystem + upstream research (2026-11-22): server-side v2 plugins do NOT
get a messages reader from the plugin domain — upstream anomalyco/opencode
#59566 confirms the v2 HTTP API is the sanctioned surface
(`session.message.list`) and that running state folds from
`session.execution.*` events; event-driven competitors
(opencode-asynchronous-agent) never poll messages at all; TUI-side monitors
read the TUI's shared message store (a surface server plugins cannot see).
The host's own HTTP API is proven reachable from in-process code
(sandbox probes read child messages via `GET /api/session/{id}/message`
with Basic auth from `service.json` throughout the 2026-11-22 E2E legs).

## What Changes

- **ADDED**: the v2 session adapter gains a REAL `messages` reader backed by
  the host HTTP API: `GET {service.url}/api/session/{id}/message` with Basic
  auth, discovered lazily from `service.json` (the host's own discovery
  artifact), with the child directory captured at create time. This restores
  the final-message text in wakes, error classification from the last
  assistant message, and progress-message content on v2 — the same contract
  v1 clients already honor.
- **MODIFIED**: `Dispatch outcome honesty on result-stream loss` — a view
  leg that is absent by CAPABILITY (the client does not provide the method)
  is distinguished from a view leg that FAILED: absence does not count as
  view loss and does not trigger the unreadable-view disclosure; genuine
  transient failures keep the existing withholding/classification semantics
  byte-for-byte. All three existing scenarios carry.
- The `DispatchClient.messages` field becomes optional; the core skips the
  leg when the capability is absent instead of throwing.

## Impact

- Specs: `specs/forge-subagents/spec.md` (one MODIFIED requirement, all
  scenarios carried + three new).
- Code: `src/dispatch-async.ts` (optional capability + guards),
  `plugin.ts` (v2 adapter HTTP messages reader + service discovery).
- Release: patch 0.32.2 through the full ③ sandbox → ④ npm ladder.
- On the real host the unreadable-view disclosure and the
  `is not a function` TypeError disappear entirely; wake texts carry the
  child's actual final report text.
