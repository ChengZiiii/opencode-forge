# crew-harness Delta — crew-native-fallback

## MODIFIED Requirements

### Requirement: Crew-governed dispatch pool-compliance gate

While a crew governs a session (PENDING or EXECUTING, including a goal-delegated born-armed crew), the plugin SHALL enforce file-level POOL COMPLIANCE on the session's configuration before any crew work dispatches: the session's workspace pool file SHALL declare a valid top-level `pool` namespace (a `[a-z0-9-]` string, 1–24 characters after trim). `crew_begin` SHALL run the compliance check as a registration pre-flight — a non-compliant pool file refuses the registration outright (no crew record is written, no PENDING crew exists) — and the tool-execute interception belt SHALL re-run the same check on every `task` dispatch from a crew-governed session targeting a `forge-*` worker, so a pool file degraded mid-crew blocks further crew dispatches until repaired. A compliance refusal SHALL name the session's pool file path, the violation (missing or invalid `pool` field), and the minimal compliant fix — add or repair the top-level `"pool": "<suggested>"` field (the suggestion being the family's currently derived namespace or a sanitized short form of it) — and SHALL state that the gate lifts hot-apply: the next resolve after the file is repaired admits registration/dispatch with no host restart. The MID-CREW belt refusal copy SHALL additionally name the NATIVE EXIT: while the pool is being repaired, the affected subtask may dispatch through the NATIVE task channel with the same relay contract — the compliance belt gates `forge-*` dispatch only, never the crew's existence. The check is FILE-LEVEL only: per-agent fail-soft findings (half-pinned entries, mistyped optional fields, broken individual entries) keep their existing skip-with-finding semantics and NEVER make the file non-compliant. Sessions whose roster comes from the global fallback layer (workspace without a pool file) are EXEMPT — the global family's namespace is fixed (`global`) and carries no rename risk. Belt composition: the compliance check runs in the same interception belt as, and AFTER, the session-domain pool gate — a cross-pool target is refused by the pool gate regardless of the session's own compliance state — and composes with the pending-crew execution-mode belt without replacing it. Unknown session anchors keep the existing fail-open posture (belt disclosure unchanged).

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
- **THEN** that dispatch is refused with the compliance fix copy PLUS the native exit (the affected subtask may run through the native task channel with the relay contract while the pool is repaired — the belt gates `forge-*` dispatch only); native (non-forge) task calls from the same session are unaffected; once the file is repaired, the next dispatch flows with no restart

#### Scenario: Global-fallback sessions are exempt

- **WHEN** a crew-governed session's workspace has no pool file and its roster comes from the global fallback layer
- **THEN** the compliance gate never fires — the global family's fixed `global` namespace carries no rename risk and needs no declared field

#### Scenario: Per-agent fail-soft findings do not block

- **WHEN** the session's workspace pool declares a valid `pool` but one agent entry is half-configured (`model` without `thoughtLevel`)
- **THEN** the file is compliant: `crew_begin` registers and crew dispatches flow — the bad entry keeps its existing skip-with-error-finding semantics and never blocks the crew

#### Scenario: The pool gate outranks the compliance belt

- **WHEN** a crew-governed session with a COMPLIANT pool dispatches a task targeting another workspace's `forge-<nsB>-coder`
- **THEN** the session-domain pool gate refuses it (not-dispatchable-from-this-session copy with exits) — the compliance belt never rewrites or masks a cross-pool refusal

## ADDED Requirements

### Requirement: Native fallback dispatch in crew waves

An armed crew's wave discipline SHALL treat the NATIVE task channel as a first-class fallback lane: when the session's pool offers no forge worker fitting a subtask's job, or `forge-*` dispatch is blocked by a degraded pool file, the session MAY dispatch the subtask through the native task channel (e.g. the `general` subagent) carrying the SAME relay contract as a forge dispatch — the change/artifact path for authoritative guides, the scoped task prompt, and the evidence demands. The fallback SHALL be disclosed, not silent: the `crew_begin` waves-arming output and the wave-discipline text SHALL carry the one-line fallback rule, and any natively-dispatched subtask SHALL be recorded — the crew record's wave notes name it, and its `crew_close` evidence statement SHALL say it ran native. The close gate's cross-check is UNCHANGED: declared titles, verdicts, and evidence statements govern exactly as before (a fallback subtask needs no new field). No guard semantics change: native targets remain ungated for forge-family sessions as they are today, and every `forge-*` gate (pool, compliance, pending belt, family belt) keeps its exact refusal conditions — the fallback is guidance and disclosure, never a bypass.

#### Scenario: No fitting forge worker falls back natively and records it

- **WHEN** an armed crew's subtask needs a role the session's pool does not define (e.g. an e2e-verifier subtask in a pool of coders) and the session dispatches the native `general` subagent with the relay contract
- **THEN** the dispatch flows (no guard refuses a native target), the crew record's wave notes name the fallback, and the subtask's crew_close evidence says it ran native — the close gate accepts it like any other verdict

#### Scenario: Degraded-pool crew keeps moving via native dispatch

- **WHEN** a crew is EXECUTING and the workspace pool file is non-compliant, so `forge-*` dispatches are refused with the native exit in the copy
- **THEN** the session dispatches the affected subtasks natively with the relay contract while repairing the pool — the crew continues instead of stalling, and the fallback is recorded

#### Scenario: The arming output teaches the fallback lane

- **WHEN** `crew_begin {execution: "waves"}` arms a crew (standalone or born-armed under a goal)
- **THEN** the arming output carries the fallback rule: no fitting forge worker (or forge dispatch blocked) → dispatch the native subagent with the same relay contract and record the fallback in the wave notes and the close evidence

#### Scenario: Normal all-forge waves are unchanged

- **WHEN** the session's pool fits every subtask and is compliant
- **THEN** waves dispatch `forge-*` workers exactly as before — the fallback rule is present in the guidance but changes no behavior

#### Scenario: Fallback never weakens a forge gate

- **WHEN** any crew session attempts a `forge-*` dispatch that a belt would refuse (cross-pool target, non-compliant pool, pending crew)
- **THEN** the refusal fires exactly as before — the native fallback lane adds no exception to any `forge-*` gate
