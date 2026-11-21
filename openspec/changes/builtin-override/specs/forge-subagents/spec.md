# builtin-override — forge-subagents delta

## ADDED Requirements

### Requirement: Built-in subagent override via the global recipe

Scaffold creation `SHALL` be explicit-only: the global forge.json
`SHALL` be drafted in-band by the forge agent on the user's explicit
ask — directly, or via the `/forge init global` lever (forge-commands)
— and the plugin `SHALL NOT` write that file uninvited. The scaffold
`SHALL` carry General/Explore
override entries in comment form — uncommenting and filling an entry
is the user's act, and the default-installed state `SHALL` be
byte-equal to official built-in behavior (no vendor prompt text is
ever copied). When the global recipe contains an override entry, sync
`SHALL` emit it as a same-name, non-namespaced file in the host's
global agent directory, case-locked to the built-in's exact LOWERCASE
id stem (`general.md` / `explore.md` — the probe-established identity
key; a capitalized variant creates an ambiguous duplicate entry and
`SHALL` never be emitted); if a hand-written file of that name already
exists, sync `SHALL`
refuse and disclose rather than overwrite. Garbage collection for
override files `SHALL` key on the in-content GENERATED marker rather
than the `forge-` prefix. The gating probe ran 2026-11-21
(`reports/probe-builtin-override.md`): user same-name files DO shadow
the built-ins (description/system/model replaced, permissions
base-∪-appended, hot-apply) on the lowercase id only — POSITIVE.

#### Scenario: The scaffold arrives only on ask, inert by default

- **WHEN** the user asks for global workers or a built-in override
  (directly, or by running `/forge init global`) and no global
  forge.json exists
- **THEN** the forge agent drafts the scaffold in-band with
  General/Explore entries in comment form, the host's built-in
  behavior is unchanged until the user uncomments and fills an entry,
  and without an explicit ask or command the plugin writes nothing

#### Scenario: An activated override pins the built-in machine-wide

- **WHEN** the global recipe's Explore entry is uncommented with a
  model and depth word and forge_sync runs
- **THEN** `explore.md` (lowercase id stem) lands in the host's
  global agent dir, the
  compiled identity shadows the built-in in every workspace, and a
  later sync garbage-collects it (marker-keyed) when the entry is
  re-commented or removed

#### Scenario: Hand-written same-name files are never clobbered

- **WHEN** sync would emit `general.md` and a hand-written file of
  that name exists in the host's global agent dir
- **THEN** sync refuses with a disclosure naming the collision, and
  the hand-written file is left byte-identical
