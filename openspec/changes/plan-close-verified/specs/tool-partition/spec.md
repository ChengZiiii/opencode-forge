## MODIFIED Requirements

### Requirement: Exec posture pass-through on the exec surface

The forge exec surface (`forge_shell`) SHALL resolve its permission posture with NO plugin-injected default and NO plugin-side resolution: the plugin SHALL NOT rewrite the posture for unconfigured users (the host's own default flows — in practice `"*": allow` — so an unconfigured `forge_shell` executes in serve, TUI, and run modes alike, exactly like the native shell tool), and SHALL NOT classify commands to resolve any posture. Explicit user values (`allow` / `deny` / `ask`) SHALL flow to the host verbatim in every mode: an explicit `ask` behaves exactly like the native shell tool's ask in that mode (a real dialog in TUI, the host's ask auto-reject semantics in run mode, a pending ask on a serve host until answered via the host API — the host's business, disclosed, not the plugin's). User-confirmation doors — `plan_approve`, `goal_write (arm)`, `goal_complete`, `goal_resume`, `goal_discard`, `crew_close` — exactly the non-exec `gate()` permission keys — SHALL NEVER be auto-resolved in any mode; they remain real dialogs. (plan_close left the door set by plan-close-verified: its completion gate is plugin-verified, no longer an ask door.) The readonly-exec-seal SHALL remain the ONLY plugin-side exec refusal: explicit-readonly workers' write-class commands are refused by the seal before execution, posture-independently (a pure-function command classifier recognizes write-class commands for the seal; that classifier has no role on the posture path). Disclosure: with no explicit permission configured, ANY command the model issues through `forge_shell` runs without confirmation in every mode — this default-open posture is the documented, accepted product decision; the safety belt for readonly workers is the seal, which is posture-independent.

#### Scenario: Unconfigured posture runs everywhere (default-open)

- **WHEN** the user's config has NO explicit permission for `forge_shell` and a forge-family worker calls it with any command
- **THEN** the command executes in serve, TUI, and run modes alike — the plugin injects no ask, classifies nothing, and the host's default applies

#### Scenario: Explicit allow skips the ask; explicit deny refuses

- **WHEN** the user's config explicitly allows or denies `forge_shell`
- **THEN** `allow` runs the command without the ask in every mode, and `deny` refuses in every mode — both verbatim, with no plugin-side reinterpretation

#### Scenario: Explicit ask follows host semantics with no plugin resolution

- **WHEN** the user's config explicitly sets `forge_shell: "ask"` and a call arrives in TUI, run, or serve mode
- **THEN** the ask reaches the host unmodified — dialog in TUI, auto-reject semantics in run mode, pending ask in serve mode exactly like the native shell tool's ask there; the plugin never classifies the command and never emits `[forge:headless-denied]`

#### Scenario: No posture command classification anywhere

- **WHEN** any `forge_shell` call arrives under any posture in any host mode
- **THEN** the plugin performs no command classification on the posture path — the exec classifier exists solely inside the readonly-exec-seal for explicit-readonly workers

#### Scenario: User-confirmation doors are never auto-resolved

- **WHEN** a `plan_approve` / `goal_write (arm)` / `goal_complete` / `goal_resume` / `goal_discard` / `crew_close` confirmation door fires in any host mode
- **THEN** the ask remains a real pending dialog and is never resolved by any plugin-side mechanism

#### Scenario: Seal refuses readonly workers' writes as the sole plugin refusal

- **WHEN** an explicit-readonly forge worker calls `forge_shell` with a WRITE-class command, under any permission posture and any host mode
- **THEN** the readonly-exec-seal refuses the call before execution — the only plugin-side exec refusal, posture-independent
