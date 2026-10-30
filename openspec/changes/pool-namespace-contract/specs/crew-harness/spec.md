# crew-harness Delta — pool-namespace-contract

## ADDED Requirements

### Requirement: Crew-governed dispatch pool-compliance gate

While a crew governs a session (PENDING or EXECUTING, including a goal-delegated born-armed crew), the plugin SHALL enforce file-level POOL COMPLIANCE on the session's configuration before any crew work dispatches: the session's workspace pool file SHALL declare a valid top-level `pool` namespace (a `[a-z0-9-]` string, 1–24 characters after trim). `crew_begin` SHALL run the compliance check as a registration pre-flight — a non-compliant pool file refuses the registration outright (no crew record is written, no PENDING crew exists) — and the tool-execute interception belt SHALL re-run the same check on every `task` dispatch from a crew-governed session targeting a `forge-*` worker, so a pool file degraded mid-crew blocks further crew dispatches until repaired. A compliance refusal SHALL name the session's pool file path, the violation (missing or invalid `pool` field), and the minimal compliant fix — add or repair the top-level `"pool": "<suggested>"` field (the suggestion being the family's currently derived namespace or a sanitized short form of it) — and SHALL state that the gate lifts hot-apply: the next resolve after the file is repaired admits registration/dispatch with no host restart. The check is FILE-LEVEL only: per-agent fail-soft findings (half-pinned entries, mistyped optional fields, broken individual entries) keep their existing skip-with-finding semantics and NEVER make the file non-compliant. Sessions whose roster comes from the global fallback layer (workspace without a pool file) are EXEMPT — the global family's namespace is fixed (`global`) and carries no rename risk. Belt composition: the compliance check runs in the same interception belt as, and AFTER, the session-domain pool gate — a cross-pool target is refused by the pool gate regardless of the session's own compliance state — and composes with the pending-crew execution-mode belt without replacing it. Unknown session anchors keep the existing fail-open posture (belt disclosure unchanged).

#### Scenario: Registration refuses a non-compliant pool file

- **WHEN** `crew_begin` is called in a session whose workspace pool forge.json defines agents but declares NO top-level `pool` field
- **THEN** the registration is refused outright — no crew record is written and no PENDING crew exists — and the refusal names the pool file path, the missing `pool` field, and the minimal fix (`"pool": "<suggested>"`), stating the gate lifts hot-apply once the file is repaired

#### Scenario: An invalid pool value is non-compliant too

- **WHEN** the session's workspace pool declares `"pool": "Aa Team!"` (charset mismatch) or `"pool": 7` (wrong type)
- **THEN** `crew_begin` refuses with the same fix copy as a missing field (the load-time warn finding and directory-name fallback still apply for materialization; crew dispatch waits for a valid declared value)

#### Scenario: A compliant registration proceeds

- **WHEN** the session's workspace pool declares a valid `pool` namespace (e.g. `"plugindev"`)
- **THEN** `crew_begin` registers the crew normally (record written, PENDING pause or born-armed execution per the execution-mode gate) — the compliance gate does not fire again for registration

#### Scenario: Mid-crew degradation blocks further crew dispatches

- **WHEN** a crew is EXECUTING and the workspace pool's `pool` field is removed (or invalidated) before a later wave's `task` dispatch to a `forge-*` worker
- **THEN** that dispatch is refused with the compliance fix copy; native (non-forge) task calls from the same session are unaffected; once the file is repaired, the next dispatch flows with no restart

#### Scenario: Global-fallback sessions are exempt

- **WHEN** a crew-governed session's workspace has no pool file and its roster comes from the global fallback layer
- **THEN** the compliance gate never fires — the global family's fixed `global` namespace carries no rename risk and needs no declared field

#### Scenario: Per-agent fail-soft findings do not block

- **WHEN** the session's workspace pool declares a valid `pool` but one agent entry is half-configured (`model` without `thoughtLevel`)
- **THEN** the file is compliant: `crew_begin` registers and crew dispatches flow — the bad entry keeps its existing skip-with-error-finding semantics and never blocks the crew

#### Scenario: The pool gate outranks the compliance belt

- **WHEN** a crew-governed session with a COMPLIANT pool dispatches a task targeting another workspace's `forge-<nsB>-coder`
- **THEN** the session-domain pool gate refuses it (not-dispatchable-from-this-session copy with exits) — the compliance belt never rewrites or masks a cross-pool refusal
