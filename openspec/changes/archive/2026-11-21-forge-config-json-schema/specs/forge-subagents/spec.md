# forge-config-json-schema — forge-subagents delta

## ADDED Requirements

### Requirement: JSON Schema publication for forge.json

The plugin `SHALL` publish a hand-written JSON Schema
(`schema/forge.schema.json`, mirrored into `dist/forge.schema.json` by
the bundle step and exposed via the package `exports` map under
`./schema.json`) describing the forge.json surface: the consumed
top-level keys (`agents`, `pool`, `shared`), the per-agent entry fields
(`prompt`, the atomic `model`+`thoughtLevel` pair expressed so that
half-pairs fail validation, `shape` with exactly the values `readonly`
and `write`, `permission` overrides), the id and pool naming rules the
validator enforces, and the deprecated `depths` key. The schema `SHALL`
be mirror-locked to the code: a test `SHALL` assert the schema's enums
and patterns against the code constants they mirror (the shape union,
the id/pool regexes, the atomic-pair rule), failing when either side
drifts. The parser's existing unknown-key tolerance `SHALL` keep
accepting a user-pasted `$schema` key verbatim (documented in README
with the node_modules reference form and the `.json`-extension comment
caveat), and the `shape-invalid` finding `SHALL` state the true default
(`write`), matching the shape-default-open semantics.

#### Scenario: Editor completion and typo defense

- **WHEN** a user references the published schema from their forge.json
  (`$schema` pointing at the package's `./schema.json` export)
- **THEN** their editor offers completion over the documented surface and
  flags invalid entries — a `model` without `thoughtLevel`, or a
  misspelled `shape` — before the file ever reaches the plugin

#### Scenario: Schema and validator cannot drift silently

- **WHEN** the validator's shape union, id/pool patterns, or atomic-pair
  rule changes without the schema changing in step (or vice versa)
- **THEN** the drift-mirror test fails, naming the drifted pair

#### Scenario: $schema stays tolerated and the finding tells the truth

- **WHEN** a forge.json carries a `$schema` key, or an entry carries an
  invalid `shape` value
- **THEN** the `$schema` key parses clean (unknown-key tolerance), and
  the `shape-invalid` finding states that the entry defaults to WRITE
  (not readonly) while naming the accepted values
