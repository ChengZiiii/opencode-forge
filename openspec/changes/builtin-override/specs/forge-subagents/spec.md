# builtin-override — forge-subagents delta

## ADDED Requirements

### Requirement: Built-in subagent override via the global recipe

Scaffold creation `SHALL` be trigger-driven and in-band: the global
forge.json `SHALL` be drafted by the forge agent only on the user's
explicit go-ahead — the same pattern as the unconfigured-crew
initialization gate — the plugin `SHALL NOT` write that file
uninvited, and no dedicated init command `SHALL` exist. The scaffold
`SHALL` carry General/Explore
override entries in comment form — uncommenting and filling an entry
is the user's act, and the default-installed state `SHALL` be
byte-equal to official built-in behavior (no vendor prompt text is
ever copied). When the global recipe contains an override entry, sync
`SHALL` emit it as a same-name, non-namespaced file
(`General.md` / `Explore.md`) in the host's global agent directory;
if a hand-written file of that name already exists, sync `SHALL`
refuse and disclose rather than overwrite. Garbage collection for
override files `SHALL` key on the in-content GENERATED marker rather
than the `forge-` prefix. Implementation `SHALL` be gated on a
sandbox probe confirming that a user same-name agent file actually
shadows the BUILT-IN agent on the target host; a negative probe
result `SHALL` kill the change in propose.

#### Scenario: The scaffold arrives only on ask, inert by default

- **WHEN** the user asks for global workers or a built-in override
  and no global forge.json exists
- **THEN** the forge agent drafts the scaffold in-band with
  General/Explore entries in comment form, the host's built-in
  behavior is unchanged until the user uncomments and fills an entry,
  and without an ask the plugin writes nothing

#### Scenario: An activated override pins the built-in machine-wide

- **WHEN** the global recipe's Explore entry is uncommented with a
  model and depth word and forge_sync runs
- **THEN** `Explore.md` lands in the host's global agent dir, the
  compiled identity shadows the built-in in every workspace, and a
  later sync garbage-collects it (marker-keyed) when the entry is
  re-commented or removed

#### Scenario: Hand-written same-name files are never clobbered

- **WHEN** sync would emit `General.md` and a hand-written file of
  that name exists in the host's global agent dir
- **THEN** sync refuses with a disclosure naming the collision, and
  the hand-written file is left byte-identical
