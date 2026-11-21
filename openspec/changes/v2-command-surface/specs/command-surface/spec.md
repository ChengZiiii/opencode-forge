# Purpose

The forge slash-command surface: deterministic dedicated levers for the roster
operations, and typed-argument delivery that works identically on v1 and v2
hosts.

## ADDED Requirements

### Requirement: Dedicated levers as zero-argument commands

The plugin `SHALL` register `forge-sync`, `forge-init`, and
`forge-init-global` as dedicated commands on both host generations, each with
its own template (the same route body `/forge` routes to) and its own
description. The commands `SHALL NOT` depend on typed arguments for routing.

#### Scenario: forge-sync routes on a v2 host

- **WHEN** the user invokes `/forge-sync` on a v2 host
- **THEN** the delivered prompt is the sync-lever template verbatim, with no
  argument text required and no routing ambiguity

#### Scenario: commands are listed for autocomplete

- **WHEN** the command list is queried (v1 config commands or v2
  `/api/command`)
- **THEN** `forge-sync`, `forge-init`, and `forge-init-global` appear with
  their own descriptions

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
