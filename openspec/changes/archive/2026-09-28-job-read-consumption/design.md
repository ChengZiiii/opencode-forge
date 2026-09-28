# Design — job-read-consumption

## Context

The wake exists to tell the caller something it does not know. A poll that observes the terminal state has already told it — status, exit code, drained output. Delivering the wake afterwards is a duplicate the model can identify as noise (live evidence: the model judged it "没有新信息" and performed a manual clear whose only value was tidiness). This is the deferred twin of job-terminal-evidence's inline case, and OMO-slim's double-notify suppression ("a queued wake would double-notify") by another name.

## Decisions

- **D1 — Consumption is keyed on the terminal poll.** `poll()` is the only verb that reports state; it therefore owns consumption. `list` (a roster scan) and `log` (history paging that never asserts state) must not consume — otherwise a glance would silence a real notification.
- **D2 — First terminal poll consumes, unconditionally.** No toggles: once the exit status is in the caller's hands there is nothing left to announce. Covers both orders — poll-then-never-idle (wake dropped while queued) and wake-already-delivered-then-poll (entry self-clears; nothing to suppress).
- **D3 — Reuse the stale-id machinery.** `rememberConsumed` from job-terminal-evidence already gives "already consumed" answers for stale verbs; poll consumption plugs into it verbatim. The wiring needs zero changes.
- **D4 — Survivors follow the same rule.** An adopted survivor polled to terminal self-clears from the in-memory table; its persistent registry entry is already removed by the liveness watcher at terminal, and its notify is false. No special case.
- **D5 — E2E phase B rewritten, not deleted.** The canonical unread-notification scenario is "start background, never poll, idle → wake". Polled-to-terminal becomes a suppression assertion.
- **D6 — (discovered in E2E) completions arriving during idle need a push.** The old engine delivered wakes only on the idle TRANSITION edge; a completion landing after the turn ended had no future edge and sat queued until the window abandoned it to the ledger (live finding: E2E phase B2 "start background, don't poll" never woke). Fix: the manager fires `onWakeQueued` at queue time; the wiring keeps a believed-idle set (chat.message = busy, session.idle = idle; unknown = conservatively busy) and pushes immediately for idle-known sessions. Busy sessions keep the edge path — no mid-turn barging.

## Risks / Trade-offs

- [Model polls while running, expects a wake later, but a later poll consumed it] → the consuming poll itself returned the terminal state; the information arrived, just one turn earlier than the wake would have carried it.
- [Log-paging after consumption] → disk log path persists in earlier outputs; the stale-id error names the consumption.
- [Existing tests assert wake-after-poll] → updated; suppression cases added.

## Migration Plan

1. job-manager `poll()`: terminal observation → consume (delete + rememberConsumed).
2. Tests + README + description clause.
3. Regression, 0.9.0 pipeline, E2E rewrite for phase B.

## Open Questions

- None.
