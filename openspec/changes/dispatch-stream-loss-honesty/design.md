# dispatch-stream-loss-honesty — Design

## Context

The dispatch poller consumes the child session's result stream to produce
the dispatch outcome. Two live failure modes were observed on 2026-11-19
(four children affected, twice replicated):

1. The SSE/result stream breaks mid-flight (network `Connection reset`).
2. The poller exits the consume loop, reports the child as exited-1 with
   "no reportable final message", and writes NO ledger entry.
3. The child in fact keeps running and completes its work (verified by
   task ticks, git commits, and on-disk reports hours later).

The layer's epistemic error: it treats "MY view of the result stream
broke" as "the child died". These are different facts.

## Goals / Non-Goals

- Goal: the layer's claims must match its actual epistemic state — a
  broken view yields an unknown outcome, never a terminal verdict.
- Goal: every dispatch leaves a ledger trace of its outcome class.
- Goal: a delivery channel that survives view loss (files on disk).
- Non-Goal: changing watchdog kill semantics (stall thresholds stay).
- Non-Goal: reconnecting/retrying the result stream automatically
  (re-observation is the primary's choice; the layer stays honest about
  not knowing).

## Decisions

- **D1 — outcome classes.** Dispatch results gain a classification:
  `completed` (final report received), `failed` (child definitively
  failed with evidence), and NEW `stream-lost/unknown` (view broke
  before a final report; child state unknown). Only `completed`/`failed`
  may use terminal wording. `stream-lost/unknown` MUST include the
  phrase "result stream lost" and MUST NOT claim exit/death.
- **D2 — ledger completeness.** Every dispatch write path ends in a
  ledger entry. Stream loss writes `stream-lost/unknown` with the last
  observed activity timestamp. No dispatch outcome class may skip the
  ledger.
- **D3 — report-file contract.** The dispatch prompt template gains a
  standing line: the worker writes its final report to a
  caller-provided path under the workspace (`reports/<task>-report.md`)
  before ending. The poller/primary treat that file as the
  completion ground truth after a stream loss. This is already proven
  in the field (the w6a report file resolved a false obituary).
- **D4 — no auto-retry.** The layer does not silently re-dispatch on
  stream loss. The honest unknown is surfaced; re-observation or
  re-dispatch is the primary's explicit call.

## Risks / Trade-offs

- "Unknown" outcomes are less satisfying than verdicts — mitigated by
  the report-file contract giving the primary a cheap re-observation
  path.
- Template growth (one standing line) — negligible.

## Migration Plan

Single release; no state migration. The ledger gains one new outcome
class (append-only JSONL — consumers tolerant of new classes by
contract).

## Open Questions

- None.
