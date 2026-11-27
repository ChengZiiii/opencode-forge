## MODIFIED Requirements

### Requirement: Single forge command surface

The plugin `SHALL` register exactly one server forge command (`/forge`), routing on typed arguments: `sync`, `init`, `init global`, `stop` (session-scoped stop of the invoking session's native subagents — see 'Session-scoped stop for native subagents'), and a help fallback listing every route. The plugin `SHALL NOT` register any retired hyphenated server forge command (`forge-sync`, `forge-init`, `forge-init-global`, `forge-cancel`). User-owned entries carrying those names `SHALL` never be clobbered, rewritten, or deleted by the plugin (the create-only no-clobber contract is unchanged — the plugin merely stops creating its own).

The separate TUI-only `/forge-config` command and palette entry SHALL NOT be registered in the server command domain, SHALL NOT send a model prompt, and SHALL NOT clobber user-owned commands.

The `sync`, `init`, and `init global` routes SHALL enforce a forge-primary identity guard independent of tool visibility before any route work (see forge-subagents 'User-facing /forge command family'); `/forge stop` SHALL be exempt. Init SHALL refuse-and-review existing recipes and require explicit consent before a normal write. Unknown identity SHALL NOT start a guarded route.

#### Scenario: /forge sync routes on a v2 host

- **WHEN** the user invokes `/forge sync` on a v2 host
- **THEN** for a forge primary, the delivered prompt is the sync routing template with the typed argument composed per the argument-delivery contract

#### Scenario: /forge stop routes to the session-scoped stop lever

- **WHEN** the user invokes `/forge stop` in a session with native subagent children
- **THEN** the stop runs in the command's own execution and the delivered prompt carries its receipt (see 'Session-scoped stop for native subagents')

#### Scenario: No hyphenated forge commands in the command list

- **WHEN** the command list is queried (`/api/command`)
- **THEN** no `forge-sync`, `forge-init`, `forge-init-global`, or `forge-cancel` entry exists, and `/forge` appears with its route-describing help text

#### Scenario: User-owned entries with retired names survive untouched

- **WHEN** the user's own config carries a command named `forge-sync`
- **THEN** the plugin neither overwrites nor deletes it, and registers only `/forge` as its own server forge command
