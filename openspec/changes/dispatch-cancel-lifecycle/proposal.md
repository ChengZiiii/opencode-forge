# Proposal: dispatch-cancel-lifecycle

## Why

There is no user lever that terminates an in-flight async dispatch. Host
semantics since 2.3.0: ESC interrupts the parent session's current turn only;
background children are independent sessions and keep running (upstream
#64073, open). forge's children are created via `ctx.session.create`, so they
are invisible to the host's Job registry and to any host-side cancel surface;
the dispatch registry kills children only on owner-session deletion or
dispose. Production impact 2026-11-22: two concurrent workers ran the same
task with no way to stop either one; a runaway or misbehaving worker is
unkillable without process-level intervention. The user-facing severity was
flagged as critical.

## What Changes

- **ADDED**: a user-facing cancellation lever — the dedicated command
  `forge-cancel` (hyphenated family per v2-command-surface). Invoked without
  arguments it lists in-flight dispatches (task id, agent, child session,
  age). Invoked with a task id (or `all`) it cancels: the child session is
  aborted via the existing abort engine, the registry row settles as
  `aborted`, the ledger records the cancellation, and a wake discloses it.
  Cancelled dispatches are never retried.
- **ADDED**: parent-interrupt disclosure — when the parent session's turn is
  interrupted while dispatches are in flight, the plugin surfaces the
  in-flight list with cancel guidance. Default posture is disclose-only: ESC
  never silently kills workers.
- **ADDED**: orphan-child disclosure — when a streaming child with a dead or
  missing registry row is detected (e.g. after adoption gaps), it is surfaced
  with adopt/cancel guidance instead of running invisible.
- **ADDED**: gated-ask watchdog — the seven confirmation gates
  (plan_approve / plan_close / goal_write arm / goal_complete / goal_resume /
  goal_discard / crew_close) are time-boxed: when no client adjudication
  arrives within the window (the 2026-11-22 TUI wedge where the dialog never
  rendered and `goal_write` hung forever), the gate resolves as a DISCLOSED
  rejection — fail-closed, state unchanged, the tool call refused with an
  honest finding that names the wedge and the retry contract. The plugin
  NEVER auto-approves.

## Capabilities

- **New Capabilities**: `gate-asks` — the cross-harness confirmation-gate
  contract (the seven doors), including the new watchdog.
- **Modified Capabilities**: `forge-subagents` — requirements ADDED (user
  cancellation lever, parent-interrupt disclosure, orphan-child disclosure).
  The `aborted` registry outcome already exists (owner-death path); it gains
  a user-initiated trigger, no outcome-class change.

## Impact

- Code: dispatch registry (cancel verb), `src/dispatch-async.ts`
  (`abortChild` wiring to the user lever), command registration (depends on
  v2-command-surface for the hyphenated family and argument composition),
  interruption hook (depends on dispatch-v2-hostsignals' event
  subscription), the `gate()` choke point (watchdog race — the one function
  every door already awaits).
- Tests: cancel path unit/wiring tests; interrupted-parent disclosure test;
  watchdog tests (timeout → disclosed rejection; a decision beating the
  timer; disable knob); sandbox E2E: dispatch → cancel → child actually goes
  idle, ledger shows `aborted`, no retry fires.
- Docs: README dispatch chapter (cancel semantics + ESC posture); plan/goal
  chapters gain the watchdog wording (a gate can refuse on timeout —
  fail-closed, retryable).
- Change order dependency: lands after v2-command-surface and
  dispatch-v2-hostsignals.
