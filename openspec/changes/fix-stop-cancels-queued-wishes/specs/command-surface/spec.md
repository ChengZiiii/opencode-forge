## MODIFIED Requirements

### Requirement: Single forge command surface

The plugin `SHALL` register exactly one forge command (`/forge`) on both host generations, routing on typed arguments: `sync`, `init`, `init global`, `stop` (session-scoped dispatch stop), and a help fallback listing every route. The plugin `SHALL NOT` register any hyphenated forge command (`forge-sync`, `forge-init`, `forge-init-global`, `forge-cancel`) on either host generation. User-owned entries carrying those names `SHALL` never be clobbered, rewritten, or deleted by the plugin (the create-only no-clobber contract is unchanged — the plugin merely stops creating its own).

#### Scenario: /forge sync routes on a v2 host

- **WHEN** the user invokes `/forge sync` on a v2 host
- **THEN** the delivered prompt is the sync routing template with the typed argument composed per the argument-delivery contract

#### Scenario: /forge stop routes to the session-scoped stop lever

- **WHEN** the user invokes `/forge stop` in a session with in-flight or queued dispatches
- **THEN** the delivered prompt directs the session-scoped stop (cancel the invoking session's in-flight and queued dispatches only)

#### Scenario: No hyphenated forge commands in the command list

- **WHEN** the command list is queried (v1 config commands or v2 `/api/command`)
- **THEN** no `forge-sync`, `forge-init`, `forge-init-global`, or `forge-cancel` entry exists, and `/forge` appears with its route-describing help text

#### Scenario: User-owned entries with retired names survive untouched

- **WHEN** the user's own config carries a command named `forge-sync`
- **THEN** the plugin neither overwrites nor deletes it, and registers only `/forge` as its own
