# Context

The v2 dispatch stack creates children via `ctx.session.create` (flat param
adapter) and prompts them through the session domain; the host's own subagent
tool passes `{ parentID, title, agent, model }` at create time. forge's
create body carries none of `agent`/`model`, and the v2 adapter's key
allowlist drops them even if present — production 2026-11-22 produced naked
default-agent children (agent `forge`, model `tidepool-alpha-free`) while the
read view independently went blind after a plugin hot-reload and declared
`stream-lost/unknown` at +30s against healthy, productive children. See
proposal.md — Why.

## Goals / Non-Goals

**Goals:**
- Binding integrity: the child the model talks to is the agent the roster
  defined — validated before spawn, asserted after create.
- Completion integrity: terminal verdicts come from host-owned signals with
  a reconcile backstop, never from a single fragile read view.
- Continuity integrity: in-flight dispatches survive plugin reload and host
  restart.

**Non-Goals:**
- Changing the outcome taxonomy, ledger shape, or report-file contract.
- Foreground dispatch semantics (upstream #64073 background model stays).
- v1 dispatch path changes (v1 keeps its proven client).

## Decisions

1. **`agent`/`model` ride the create call** — the adapter allowlist gains
   both keys and `createChildSession` passes them from the dispatch input
   (host subagent tool contract). Alternative rejected: binding via the
   prompt body — the v2 prompt adapter is flat `{sessionID, text}` and the
   host's own tool binds at create; two mechanisms for one job is drift
   surface.
2. **Refuse-not-degrade pre-spawn validation** — the roster resolver and the
   materialized native roster are checked before spawn (courier pattern);
   refusal disclosure names the agent + roster source + remedies, consistent
   with the existing session-scope pool gate wording.
3. **Read-back assertion is fail-loud** — after create, read the child and
   assert the bound agent; mismatch = `binding-lost` error class + journal
   entry, prompt never sent. Alternative rejected: warn-and-continue — that
   is precisely tonight's naked-worker failure mode.
4. **Completion = durable events + `ctx.session.wait`, reconcile at ≥10s**
   (mission-control hybrid; courier's resubscribe loop for stream loss).
   The REST view survives only as reconcile plumbing, never as sole terminal
   signal. The 30s blind-streak path remains only inside the last-resort
   stream-lost verdict, now requiring reconcile confirmation.
5. **Registry rows in `ctx.storage`** (plugin KV) keyed by task id; setup
   adopts running rows (dedupe against the active set); unreadable rows fall
   back to a `parentID` walk (kimaki pattern). Alternative rejected: JSON
   file state — `ctx.storage` is host-native and scoped per plugin.
6. **Hot-reload repro harness gates the work** — the sandbox reproduces
   reload-mid-dispatch (config touch triggers supervisor re-activation)
   before the fix lands, so the adoption leg has a failing-then-passing
   E2E. If the sandbox cannot reproduce the blind-poll geometry, the
   reproducible legs (binding, events, adoption) still gate, and the
   incident geometry is documented in the tasks.

## Risks / Trade-offs

- [Host silently drops unknown create keys on some host version] → the
  read-back assertion converts silent loss into a loud `binding-lost` class.
- [Event loss window between reload generations] → reconcile pass is the
  designed backstop; durable events replay from the bus log where available.
- [`ctx.storage` unavailable on older hosts] → fail-soft to in-memory +
  ledger, exactly today's behavior for v1.
- [Reconcile tick adds background reads] → cadence floor 10s; skipped when
  no rows are in flight.

## Migration Plan

No data migration. Reload adoption activates on first reload after install;
rollback is a plain revert (in-flight rows degrade to today's behavior).

## Open Questions

None blocking; the exact host key spelling (`agent` vs alias) is confirmed
by the sandbox probe in task 1 before implementation.
