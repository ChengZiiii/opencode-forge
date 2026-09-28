# Design — job-terminal-evidence

## Context

The completion wake exists for one situation: the caller walked away from a still-running job (idle/max-wait early return or background start) and needs to learn the outcome later. A foreground call resolved on the exit event is the opposite case — the caller is holding the complete output in the same tool result. Waking them anyway is a duplicate; leaving the consumed entry in the registry then extorts a manual `clear` turn. Both OMO implementations hit this exact pair and fixed it the same way.

## Prior art (OMO, verified 2026-09-28)

- **oh-my-opencode-slim** (`src/utils/background-job-terminal-gate.ts:183-187`): "A foreground run's synchronous native terminal return is itself terminal evidence — the host call bound to this exact run has already come back… **Background runs never qualify**." Plus double-notify suppression when the host already delivered the first completion (`src/index.ts:945-950`, "a queued wake would double-notify").
- **Upstream background_task manager**: sync-attached waiters suppress parent notification ("A sync waiter is still polling this session; its detach re-arms removal"); consumed tasks auto-remove after `TASK_CLEANUP_DELAY_MS = 10 min` into a capped archive (`MAX_COMPLETED_TASK_ARCHIVE_SIZE = 100`).
- Neither hides the consumed entry forever nor wakes synchronously-consumed callers. Our design follows the slim framing (the rule is about *how the caller last saw the job*), with upstream's cleanup intent made immediate (D2).

## Decisions

- **D1 — Terminal evidence is defined by the caller's last observation.** Exactly one return form qualifies: the foreground invocation resolved on the **exit event** (the complete output was delivered inline). Not success-pattern returns (process may still be alive — its eventual death is real news), not idle/max-wait returns, not background starts.
- **D2 — Immediate removal, not a TTL.** Upstream keeps consumed tasks 10 minutes for potential reuse, because their tasks wrap reusable child sessions. Our jobs have nothing to reuse: the output was delivered, the process is gone, the disk log persists under the existing rotation. Immediate removal deletes the two-turn tax (wake + manual clear) with no capability loss.
- **D3 — Stale-id verbs self-describe.** `poll`/`kill`/`clear` on a self-cleared id error with "already consumed (output delivered with the original return)" instead of a bare unknown-job error — the model can reconstruct state without re-running anything.
- **D4 — Suppression is per-job, decided at resolution time.** The runner stamps the return form on the job; the manager consults it when the completion settles. No global toggles: a `notify: false` opt-out already exists for the reverse need, and the fix must not be configurable away by default.
- **D5 — Wake text unchanged.** The delivered message still carries exit code + tail; no new ceremony.

## Risks / Trade-offs

- [Model expects to re-poll a quick job by id out of habit] → the stale-id error self-describes; the forge_shell return text states the output was delivered in full.
- [Suppression hides a failure for a job whose output was truncated inline] → the inline tail is the same bounded tail the wake would carry; nothing is lost, only not duplicated.
- [Existing tests assert a wake for every completion] → updated to the three qualifying return forms; suppression cases added.

## Migration Plan

1. job-runner: stamp terminal-evidence at resolution.
2. job-manager: skip wake + remove registry entry at completion for stamped jobs; stale-id verb errors.
3. Tests + README + validate.

## Open Questions

- None.
