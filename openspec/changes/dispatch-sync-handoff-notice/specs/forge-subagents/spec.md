# dispatch-sync-handoff-notice — Specs

## ADDED Requirements

### Requirement: Sync wait-budget expiry presented as a notice

The sync dispatch layer `SHALL` present a wait-budget expiry handoff as
a normal notification — informational styling with wording naming the
outcome ("sync wait budget ended — the dispatch continues in the
background; collect with `forge_jobs`") — and `SHALL NOT` render it
through the error channel.

#### Scenario: Wait budget expires while child is healthy

- WHEN a synchronous dispatch's wait budget expires while the child
  session is still running
- THEN the handoff surfaces as an informational notice naming the
  outcome and the collection path (`forge_jobs`)
- AND no error-channel rendering / alarm styling is used

### Requirement: Genuine dispatch failures keep error presentation

Genuine sync dispatch failures `SHALL` keep error-class presentation:
dispatch refusal (gates, pool caps) and evidence-backed worker errors
render through the error channel as before.

#### Scenario: Refusal and evidence-backed failure stay errors

- WHEN a dispatch is refused by a gate/pool cap, or the worker fails
  with recorded evidence
- THEN the message renders through the error channel unchanged

### Requirement: Budget-expiry notice carries retrieval pointers

The budget-expiry notice `SHALL` carry the retrieval pointers previously
carried by the error message — job id, task handle, and report path
when present — so the caller can collect the result without
re-dispatching.

#### Scenario: Notice is actionable

- WHEN the budget-expiry notice surfaces
- THEN it includes the job id (and task handle / report path when
  present)
