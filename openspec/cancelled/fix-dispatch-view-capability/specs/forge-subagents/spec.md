## MODIFIED Requirements

### Requirement: Dispatch outcome honesty on result-stream loss

The dispatch layer `SHALL` classify every dispatch outcome as exactly one of
`completed`, `failed`, or `stream-lost/unknown`. A result stream that breaks
before a final report arrives `SHALL` classify as `stream-lost/unknown` and
`SHALL NOT` produce a terminal verdict: no exit-1 death certificate, no "no
reportable final message" obituary. The surfaced message `SHALL` state that
the result stream was lost and that the child state is unknown (possibly
still running). On hosts where host-signal completion detection is active,
the `stream-lost/unknown` verdict `SHALL` be declared only after the
reconcile pass also fails to observe the child: execution events that keep
flowing for an in-flight child `SHALL NOT` be overruled by an unread
synchronous view, and a child that host signals show to be alive `SHALL NOT`
be declared lost. A view leg that the client does not provide at all
(capability absence — e.g. a v2 session domain with no messages method)
`SHALL` be distinguished from a view leg that failed: capability absence
`SHALL NOT` count toward view loss, `SHALL NOT` produce the unreadable-view
disclosure, and `SHALL` degrade silently while host signals own completion.
On hosts where the adapter can provide a messages reader backed by the
host's own HTTP session-message API, the layer `SHALL` use it so wake texts
carry the child's actual final report text.

#### Scenario: Result stream breaks mid-dispatch

- WHEN the child session's result stream breaks (e.g. network
  `Connection reset`) before a final report arrives
- THEN the dispatch outcome is `stream-lost/unknown`
- AND the surfaced message states "result stream lost" and that the
  child state is UNKNOWN (possibly still running)
- AND no exit-1 / death / terminal obituary wording is produced

#### Scenario: healthy child is never declared lost

- WHEN the synchronous status/messages view is unreadable while the child's
  execution events continue to arrive
- THEN the dispatch stays in flight (no verdict is declared)
- AND the outcome settles from the host signals or the reconcile pass as
  usual

#### Scenario: verdict only after signals and reconcile both fail

- WHEN neither the host signals nor the reconcile pass can observe an
  in-flight child for the sustained streak
- THEN the outcome is `stream-lost/unknown` with the last-observed activity
  timestamp
- AND the report-file delivery contract remains the ground-truth recovery
  channel

#### Scenario: capability absence is not view loss

- WHEN the dispatch client provides neither a messages method nor a status
  method (a v2 host whose session domain exposes neither)
- THEN the watch does not count view-loss ticks, does not classify
  `stream-lost/unknown`, and does not emit the unreadable-view disclosure
- AND completion remains owned by the host-signal core and the reconcile
  pass exactly as before

#### Scenario: a failing messages reader on a provided capability still counts

- WHEN the client provides a messages method and it fails (throws or errors)
  while the status leg also fails for the sustained streak
- THEN the existing stream-loss withholding and classification semantics
  apply unchanged (capability presence behaves exactly like the pre-change
  contract)

#### Scenario: v2 wake carries the child's final report text

- WHEN a dispatch completes on a v2 host whose adapter provides the
  HTTP-backed messages reader (service discovery succeeded)
- THEN the wake text contains the child's actual final assistant text
- AND no `client.session.messages is not a function` error and no
  `(final message unavailable: ...)` scaffolding appears
