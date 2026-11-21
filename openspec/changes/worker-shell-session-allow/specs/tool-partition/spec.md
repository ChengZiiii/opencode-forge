# worker-shell-session-allow — delta

## MODIFIED Requirements

### Requirement: Exec posture pass-through on the exec surface

The forge exec surface (`forge_shell`) SHALL resolve its permission posture
with NO plugin-injected default and NO plugin-side resolution: the plugin
SHALL NOT rewrite the posture for unconfigured users (the host's own default
flows — in practice `"*": allow` — so an unconfigured `forge_shell` executes
in serve, TUI, and run modes alike, exactly like the native shell tool), and
SHALL NOT classify commands to resolve any posture. Explicit user values
(`allow` / `deny` / `ask`) SHALL flow to the host verbatim in every mode: an
explicit `ask` behaves exactly like the native shell tool's ask in that mode
(a real dialog in TUI, the host's ask auto-reject semantics in run mode, a
pending ask on a serve host until answered via the host API — the host's
business, disclosed, not the plugin's). User-confirmation doors —
`plan_approve`, `plan_close`, `goal_write (arm)`, `goal_complete`,
`goal_resume`, `goal_discard`, `crew_close` — exactly the non-exec `gate()`
permission keys — SHALL NEVER be auto-resolved in any mode; they remain real
dialogs. The readonly-exec-seal SHALL remain the ONLY plugin-side exec
refusal (below: the cross-anchor rescue and its deny-gate excepted — the
rescue restores the documented default, it does not refuse) :
explicit-readonly workers' write-class commands are refused by the seal
before execution, posture-independently (a pure-function command classifier
recognizes write-class commands for the seal; that classifier has no role on
the posture path). Disclosure: with no explicit permission configured, ANY
command the model issues through `forge_shell` runs without confirmation in
every mode — this default-open posture is the documented, accepted product
decision; the safety belt for readonly workers is the seal, which is
posture-independent.

On hosts whose permission assert evaluates at the plugin host's location
(v2 geometry; every 2.x host observed), an agent that registers only at the
project location (native-first workers) cannot resolve at the assert anchor
and the host falls back to a literal deny-all BEFORE any rule, saved
approval, hook, or ask is consulted. The plugin SHALL therefore maintain a
cross-anchor rescue for forge-family sessions, EXACTLY bounded: it SHALL
ensure, through the host's documented session-rule surface, that the
session's permission rules end with
`{action: "forge_shell", resource: "*", effect: "allow"}` — session rules
evaluate after agent rules with last-match-wins, so the rule restores the
documented default-open posture in exactly the geometry where the host
defect would silently replace it with deny-all. The rescue SHALL inject on
the forge primary session (child sessions inherit session rules at creation)
and, as a belt, on a worker session at its first `forge_shell` call. The
injection SHALL be read-back-merge (never clobber existing session rules),
idempotent, and scoped to the `forge_shell` action alone. An explicit user
`deny` — in EITHER supported config shape (legacy `permission.forge_shell`
or the v2 `permissions` rule array) — SHALL disable the rescue entirely (no
injection on any session) and SHALL refuse the call plugin-side before the
assert, verbatim as today. As belt-in-depth, when the host assert rejects
with the bare no-reason deny signature AND the resolved posture is not an
explicit deny (the rejection can only be the cross-anchor fallback), the
call SHALL proceed with a bounded `[forge:session-rescue]` finding naming
the rescue; the belt SHALL never fire past an explicit deny. v1 hosts are
untouched (draft materialization resolves at the host anchor; the v1 domain
has no session-rule surface and no defect).

#### Scenario: Unconfigured posture runs everywhere (default-open)

- **WHEN** the user's config has NO explicit permission for `forge_shell` and a forge-family worker calls it with any command
- **THEN** the command executes in serve, TUI, and run modes alike — the plugin injects no ask, classifies nothing, and the host's default applies; in a worker session under the cross-anchor geometry this default is delivered by the session-rule rescue below, not left to the broken fallback

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

- **WHEN** a `plan_approve` / `plan_close` / `goal_write (arm)` / `goal_complete` / `goal_resume` / `goal_discard` / `crew_close` confirmation door fires in any host mode
- **THEN** the ask remains a real pending dialog and is never resolved by any plugin-side mechanism

#### Scenario: Seal refuses readonly workers' writes as the sole plugin refusal

- **WHEN** an explicit-readonly forge worker calls `forge_shell` with a WRITE-class command, under any permission posture and any host mode
- **THEN** the readonly-exec-seal refuses the call before execution — the only plugin-side exec refusal, posture-independent

#### Scenario: Session-rule rescue unblocks native workers

- **WHEN** a native (md-materialized) forge worker session calls `forge_shell` with no explicit deny configured, on a host whose assert evaluates cross-anchor
- **THEN** the session's permission rules end with the `forge_shell` allow rule (injected read-back-merge, idempotent, scoped to that action) and the command executes exactly as the documented default-open posture prescribes

#### Scenario: Explicit deny disables the rescue everywhere

- **WHEN** the user's config carries an explicit `forge_shell` deny in EITHER shape (legacy `permission.forge_shell` map or v2 `permissions` rule array)
- **THEN** no session ever receives the injected rule, and the call is refused plugin-side before the assert with the existing verbatim deny refusal

#### Scenario: Primary injection lets children inherit

- **WHEN** a forge primary session prompts (v2 session hook) with no explicit deny configured
- **THEN** the plugin ensures the allow rule on that session so worker child sessions created afterwards inherit session rules carrying it at creation

#### Scenario: Rescue never clobbers session rules

- **WHEN** a target session already carries session-scoped permission rules (any origin)
- **THEN** the injection appends (or skips when our exact rule is already present) and writes back the merged array — existing rules survive byte-for-byte

#### Scenario: Fallback belt behind the injection

- **WHEN** the host assert rejects a `forge_shell` call with the bare no-reason deny signature, the resolved posture is not an explicit deny, and the session-rule surface is unavailable or the injection failed
- **THEN** the call proceeds and a bounded `[forge:session-rescue]` finding is attached naming the rescue — the belt never fires when the posture is an explicit deny
