# command-surface Specification

## Purpose
The plugin's user-facing slash commands — the `/plan`, `/goal`, `/crew` and
`/forge` families — on both host generations: which commands exist, how a
typed argument reaches the command's handler on v2, and how a command the
host could not register is disclosed instead of silently missing.

## Requirements

### Requirement: Argument delivery on v2 commands

On v2 hosts the command `execute` `SHALL` read the invocation's typed
argument text (`prompt.text`) and compose the delivered prompt:
`$ARGUMENTS` in the template `SHALL` be replaced with the full typed text
using a function replacer so `$&`-style literals in the argument survive;
when the template contains no placeholder and the typed text is non-empty,
the text `SHALL` be appended after a blank line; when the typed text is
empty or whitespace, the template `SHALL` be delivered unchanged. The
invocation `delivery` hint `SHALL` be passed through to the prompt send.

#### Scenario: typed argument reaches the model

- **WHEN** the user invokes `/forge sync` on a v2 host
- **THEN** the delivered prompt contains the sync routing template with
  `$ARGUMENTS` replaced by `sync`

#### Scenario: argument appended when the template has no placeholder

- **WHEN** a command template contains no `$ARGUMENTS` and the user types
  trailing text
- **THEN** the delivered prompt is the template, a blank line, then the
  typed text

#### Scenario: empty argument leaves the template intact

- **WHEN** the user invokes a command with no trailing text
- **THEN** the delivered prompt is the template unchanged

### Requirement: Disclosed registration drift

WHEN command-domain registration throws on any host generation, the plugin
`SHALL` emit a console warning naming the drifted domain and the error head,
and `SHALL NOT` register a partial command set silently. The disclosure is
best-effort: it `SHALL NOT` throw into the host.

#### Scenario: drifted command domain is disclosed

- **WHEN** the host's command domain shape drifts and registration throws
- **THEN** a console warning names the command domain and the error head
- **AND** no partial command set is silently registered

### Requirement: Single forge command surface

The plugin `SHALL` register exactly one forge command (`/forge`) on both host generations, routing on typed arguments: `sync`, `init`, `init global`, `stop` (session-scoped dispatch stop), and a help fallback listing every route. The plugin `SHALL NOT` register any hyphenated forge command (`forge-sync`, `forge-init`, `forge-init-global`, `forge-cancel`) on either host generation. User-owned entries carrying those names `SHALL` never be clobbered, rewritten, or deleted by the plugin (the create-only no-clobber contract is unchanged — the plugin merely stops creating its own).

#### Scenario: /forge sync routes on a v2 host

- **WHEN** the user invokes `/forge sync` on a v2 host
- **THEN** the delivered prompt is the sync routing template with the typed argument composed per the argument-delivery contract

#### Scenario: /forge stop routes to the session-scoped stop lever

- **WHEN** the user invokes `/forge stop` in a session with in-flight dispatches
- **THEN** the delivered prompt directs the session-scoped stop (cancel the invoking session's in-flight dispatches only)

#### Scenario: No hyphenated forge commands in the command list

- **WHEN** the command list is queried (v1 config commands or v2 `/api/command`)
- **THEN** no `forge-sync`, `forge-init`, `forge-init-global`, or `forge-cancel` entry exists, and `/forge` appears with its route-describing help text

#### Scenario: User-owned entries with retired names survive untouched

- **WHEN** the user's own config carries a command named `forge-sync`
- **THEN** the plugin neither overwrites nor deletes it, and registers only `/forge` as its own
