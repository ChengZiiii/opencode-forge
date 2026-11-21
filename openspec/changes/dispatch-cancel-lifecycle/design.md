# Context

Children are independent host sessions; since 2.3.0 they always run in the
background and ESC only interrupts the parent turn (upstream #64073). forge
children are invisible to the host Job registry, so no host surface can cancel
them; forge's own registry kill fires only on owner-session deleted/dispose.
The abort engine already exists (`abortChild` in src/dispatch-async.ts) and
the `aborted` registry outcome already exists (owner-death path) — this change
is the user-facing wiring, not new kill machinery. See proposal.md — Why.

## Goals / Non-Goals

**Goals:**
- A discoverable, deterministic cancel lever in the hyphenated command family.
- Cancel that provably stops the child (idle/terminal assertion), not just a
  bookkeeping row.
- Interruption and orphan moments that disclose instead of surprising.

**Non-Goals:**
- Auto-kill on ESC (default is disclose-only; a configurable kill posture is
  deferred until the disclose behavior is proven).
- Cancelling host-native background tasks (out of forge's registry).
- Foreground dispatch restoration (upstream #64073 territory).

## Decisions

1. **Lever = dedicated `forge-cancel` command** (zero-arg lists; task id or
   `all` cancels) — joins the v2-command-surface hyphenated family; argument
   composition comes free from that change. Alternative rejected: a new tool
   — the 15-tool surface is a documented contract; a command adds zero tool
   count and rides the model layer naturally.
2. **Cancel = existing registry kill + `abortChild`** — the same engine the
   owner-death path uses; the only new code is the user-triggered entry and
   the idle assertion. The idle assertion (child reaches idle/terminal after
   abort) is what makes the promise real — tonight's lesson is that
   bookkeeping without a child-state check lies.
3. **Interrupt disclosure rides the durable `session.execution.interrupted`
   subscription from dispatch-v2-hostsignals** — no new subscription
   machinery; disclose-only keeps ESC semantics predictable (a policy knob
   may come later).
4. **Orphan detection reuses adoption's reconciliation** — the same pass that
   adopts persisted rows (dispatch-v2-hostsignals) notices streaming children
   without rows; C adds the disclosure contract.
5. **Gated-ask watchdog = a race inside the `gate()` choke point** — every
   door already awaits `gate(context.ask, …)`, so the watchdog is one timed
   race, not seven call-site edits. Timeout resolves as a DISCLOSED
   rejection thrown into the awaiting tool call (fail-closed: state
   unchanged, nothing auto-approved — the invariant survives verbatim); the
   disclosure names the known TUI wedge and the retry contract. Default
   300 s (`FORGE_GATE_ASK_WATCHDOG_MS`, 0 disables). Alternative rejected:
   host-side reply scraping — the plugin cannot see the client's dialog
   state, and the wedge proves the dialog can silently not exist.
6. **Lever = dedicated `forge-cancel` command** (see decision 1) shares the
   cancel engine with the watchdog's world: both are disclosure-first,
   fail-closed levers — cancel kills a child and says so; the watchdog
   refuses a gate and says so. Neither silently decides.

## Risks / Trade-offs

- [Abort engine cannot stop a child wedged in a host call] → the idle
  assertion times out and the disclosure states the child resisted
  cancellation, with the child session id for manual follow-up.
- [`all` cancels more than the user pictured] → the listing is always shown
  first in the disclosure; `all` requires it to have been surfaced this
  session.
- [Interrupt disclosure noise on frequent ESC] → one disclosure per interrupt
  edge, deduplicated per session.

## Migration Plan

None — additive lever; rollback is a revert.

## Open Questions

None.
