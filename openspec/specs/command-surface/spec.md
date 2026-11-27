# command-surface Specification

## Purpose
The v2 `/plan`, `/goal`, `/crew` and single `/forge` command families: argument delivery, invocation-identity guards, disclosed registration drift and session-scoped native stop. Stop acts inside command execution, reports verified scope and outcomes honestly, and accepts non-forge callers.

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

WHEN command-domain registration throws, the plugin
`SHALL` emit a console warning naming the drifted domain and the error head,
and `SHALL NOT` register a partial command set silently. The disclosure is
best-effort: it `SHALL NOT` throw into the host.

#### Scenario: drifted command domain is disclosed

- **WHEN** the host's command domain shape drifts and registration throws
- **THEN** a console warning names the command domain and the error head
- **AND** no partial command set is silently registered

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

### Requirement: Session-scoped stop for native subagents

`/forge stop` SHALL request stop only for native subagent descendants whose ownership is confirmed by the host — and SHALL run in the command's own execution, so the stop never depends on the session's model choosing to call a tool. The target SHALL satisfy BOTH confirmed descendant relationship to the invoking session and host evidence of native subagent dispatch for that work. Parent links identify candidates, not native dispatch provenance; unknown provenance or ownership SHALL be skipped and disclosed. The stop route SHALL NOT sit behind the forge family guard: a session driven by any agent may stop its own children — dispatch is not partitioned (forge-subagents 'Dispatch gates enforced on the native subagent tool'), so a non-forge session that dispatched workers can stop them the same way.

The stop SHALL proceed in this order:

1. terminate the background commands those sessions left in the host — the commands the host lists for the session's directory whose starting session satisfies both scope conditions, each terminated through the host's shell endpoints;
2. request interrupt only for descendants meeting both conditions;
3. revisit, for a bounded few rounds within seconds — interrupting again any child the host woke in the meantime and including newly observed children only when both their ownership and native dispatch provenance are independently confirmed.

The receipt SHALL say, per child, what happened: which stops were requested versus confirmed terminal, which were already idle (not necessarily terminal), how many commands were confirmed terminated, and which step, if any, could not be carried out.

A failure SHALL narrow the stop, never widen or hide it: when the host's shell endpoints cannot be reached, `/forge stop` SHALL still request interrupt for descendants individually confirmed on both conditions and the receipt SHALL disclose shell enumeration unavailable and command count unknown; when a step throws, the remaining confirmed native subagent descendants SHALL still be attempted and the receipt SHALL name the failure. The plugin SHALL NOT delete a child session as part of a stop — the child's record is the audit trail of what it did — SHALL NOT touch a command or a session outside the family, and SHALL NOT clear messages the user queued for the invoking session. Only a complete successful enumeration proving no native children permits a nothing-to-stop receipt. Unavailable, incomplete, truncated or timed-out enumeration SHALL disclose the observed scope and unknown remainder; requests and confirmed terminal outcomes SHALL be separate, with no guessed counts or success. The stop SHALL NOT reach for other host job kinds (code-mode scripts, image and video jobs): it covers the invoking session's native subagent children and the background commands they left, nothing more. The plugin SHALL NOT actively cancel other job types or broaden requests on failure; host interrupt collateral behavior is unverified and SHALL be probed and disclosed, not assumed absent.

#### Scenario: Busy children are stopped with their background commands

- **WHEN** the user invokes `/forge stop` while two native children of the session are working and one of them has left a background command in the host
- **THEN** the stop attempts are made for both confirmed children and the confirmed-owned command; where host evidence confirms all outcomes the receipt names two interrupted children and one terminated command, otherwise it distinguishes the unconfirmed requests

#### Scenario: A finished child keeps its record

- **WHEN** the user invokes `/forge stop` and a native child of the session has already finished its turn and left no command behind
- **THEN** that child is left as it is (interrupting an idle session changes nothing), its record stays in the host's session tree, and the receipt counts it as already idle

#### Scenario: Another session's work is never touched

- **WHEN** a background command is running in the same directory but was started by a session outside the invoking session's family
- **THEN** `/forge stop` leaves it running, and leaves every session outside the family untouched

#### Scenario: A related session without native dispatch evidence is not a stop target

- **WHEN** the same parent has a verified native subagent child and another related session not dispatched natively or of unknown provenance
- **THEN** only the verified native child and its confirmed-owned background commands are targeted, the other session is untouched and unknown scope disclosed

#### Scenario: The shell endpoints are unreachable

- **WHEN** `/forge stop` cannot reach the host's shell endpoints
- **THEN** it attempts interrupt only for confirmed descendants, the receipt explicitly says shell enumeration and remaining count are unknown, and no step is reported as done that was not

#### Scenario: Partial enumeration or timeout never becomes a confirmed stop

- **WHEN** enumeration is truncated, unavailable or times out, or a cancellation request returns without terminal proof
- **THEN** only descendants meeting both conditions and their confirmed-owned commands are targeted, the receipt distinguishes requested and confirmed outcomes, and unidentified scope or counts remain unknown; other host jobs are not actively cancelled

#### Scenario: Nothing to stop

- **WHEN** the user invokes `/forge stop` in a session with completely verified absence of eligible native children
- **THEN** the receipt says so plainly and nothing is interrupted or terminated

#### Scenario: The stop does not wait for the model

- **WHEN** the user invokes `/forge stop`
- **THEN** the bounded stop attempts precede the session's next turn; the delivered prompt carries the receipt for the session AI to relay, and no tool call is needed to complete the stop

#### Scenario: A non-forge session stops its own children

- **WHEN** the user invokes `/forge stop` in a session driven by a non-forge agent that has native children
- **THEN** the stop runs the same way with no family-guard redirect, and the receipt reports those children
