# spec.md delta — tool-partition

## ADDED Requirements

### Requirement: Headless ask liveness on the exec surface

The forge exec surface (`forge_shell`) resolves its permission posture
without a dialog when the host runs headless. Headless is a static host
property: serve mode auto-detected from the host process argv, overridable
with the `FORGE_HEADLESS` environment variable (`1` forces headless, `0`
forces interactive). The `opencode run` mode is NOT headless: its existing
ask auto-reject semantics are unchanged for the default posture, while
explicit user allow/deny (rule 1 below) applies identically in run mode.
The resolution
order SHALL be: (1) an explicit user-configured permission for the tool —
as captured by the plugin's config snapshot taken BEFORE posture rewriting
(the snapshot records the user's own value, never the plugin's injected
`ask`) — is honored verbatim in all modes (interactive, headless, and run
alike): `allow` skips the confirmation
ask and runs, `deny` refuses; this is the single documented respect in
which interactive behavior changes (today an explicit `allow` is overwritten
to `ask` before ever reaching the gate); (2) otherwise, in interactive (TUI)
mode, the existing two-piece ask dialog fires as before; (3) in headless
mode, a posture that would ask is resolved by the existing exec command
classifier (`src/exec-classify.ts`): a READ-class command proceeds, a
WRITE-class command is refused with an honest `[forge:headless-denied]`
error naming the command head, so the calling worker receives a real,
actionable answer instead of hanging forever on an unanswered dialog.
User-confirmation doors — `plan_approve`, `plan_close`, `goal_write (arm)`,
`goal_complete`, `goal_resume`, `goal_discard`, `crew_close` — exactly the
non-exec `gate()` permission keys — SHALL NEVER be auto-resolved
headlessly in any mode; they remain real dialogs. When both the
readonly-exec-seal and the headless classifier would refuse a call, the
seal finding SHALL land first (the stronger, shape-specific refusal).
Disclosure: in headless mode, commands the classifier reads as READ-class
but that write internally (scripts that mutate files, process spawning,
encoded payloads — the classifier's README-disclosed bypass surface) run
without confirmation; that bypass surface is the effective enforcement
boundary for write-shape workers in headless mode, is disclosed in the
README, and is accepted as part of this change.

#### Scenario: Read-class command proceeds headlessly

- **WHEN** the host runs headless and a forge-family worker calls `forge_shell` with a READ-class command while the posture would ask
- **THEN** the command runs and the worker receives its result — no dialog is awaited

#### Scenario: Write-class command refuses headlessly with an honest error

- **WHEN** the host runs headless and a worker calls `forge_shell` with a WRITE-class command while the posture would ask
- **THEN** the call fails immediately with a `[forge:headless-denied]` error naming the command, and the worker can adapt or report instead of hanging

#### Scenario: Explicit allow skips the ask; explicit deny refuses

- **WHEN** the user's config explicitly allows or denies `forge_shell` (captured by the pre-rewrite snapshot)
- **THEN** `allow` runs the command without the ask in headless and interactive modes alike, and `deny` refuses in both modes

#### Scenario: User-confirmation doors are never auto-resolved

- **WHEN** the host runs headless and a `plan_approve` / `plan_close` / `goal_write (arm)` / `goal_complete` / `goal_resume` / `goal_discard` / `crew_close` confirmation door fires
- **THEN** the ask remains a real pending dialog and is never resolved by the headless classifier

#### Scenario: Interactive default posture is unchanged

- **WHEN** the host runs with a TUI (not headless) and the user has NO explicit `allow`/`deny` for the tool
- **THEN** the two-piece ask dialog behaves exactly as before this requirement

#### Scenario: Unclassifiable commands flow headlessly (disclosed)

- **WHEN** the host runs headless and a write-shape worker calls a command the classifier reads as READ-class but that writes internally (a mutating script, process spawning, an encoded payload)
- **THEN** the command runs without confirmation — the classifier's README-disclosed bypass surface is the effective enforcement boundary, disclosed in the README and accepted with this change

#### Scenario: Run mode keeps its auto-reject posture

- **WHEN** the host runs in `opencode run` mode (not serve, not TUI) and a `forge_shell` call would ask, with no explicit user allow/deny for the tool
- **THEN** the existing auto-reject semantics apply unchanged for the default posture — run mode is not headless for the purposes of this requirement (explicit allow/deny is honored identically in run mode)

#### Scenario: Seal refusal lands before headless denial

- **WHEN** the host runs headless, the caller is an effective-readonly worker, and the command is WRITE-class
- **THEN** the readonly-exec-seal finding is the error surfaced (it lands before the `[forge:headless-denied]` classification would apply)
