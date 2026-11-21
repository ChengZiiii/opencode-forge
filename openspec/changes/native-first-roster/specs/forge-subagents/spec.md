# native-first-roster — forge-subagents delta

## ADDED Requirements

### Requirement: Native roster compilation and sync

The plugin `SHALL` compile the forge.json recipe into namespaced native
agent files (`.opencode/agent/forge-<ns>-<id>.md`) through an explicit
sync operation, and `SHALL` keep the recipe as the sole semantic
authority: pools, session-domain dispatch gating, crew roster
disclosure, and compliance checks `SHALL` continue reading the recipe
through the existing pool resolver, with native files serving only as
the materialized projection. Each compiled file `SHALL` carry the
provenance-bearing description, an always-stamped `mode: subagent`
(without which the host silently falls back to a general dispatch), the
pinned model identity including its variant channel where the recipe's
depth word maps to one, the tools face in the host's current tool
vocabulary per the entry's shape, and the dispatch mandates baked into
the prompt body — all emitted under a GENERATED header that directs
edits to the recipe. The sync `SHALL` write atomically and `SHALL`
garbage-collect namespaced files whose entries left the recipe.
Compilation `SHALL` emit only probe-proven frontmatter keys (unknown
keys are dropped by the host once `permissions` is present). Before
crew registration on a native-mode host the plugin `SHALL` check
recipe-versus-artifact staleness — mtime-triggered with content
adjudication (a byte-identical touch is not staleness) — and refuse
with a one-step recovery instruction when stale; the sync
operation `SHALL` be agent-invocable so recovery happens in-band and
transcript-visible, and the host's hot-apply `SHALL` be relied on (no
restart demanded). A `sync: "auto"` opt-in `SHALL` regenerate on
detection with a disclosed finding; absent the opt-in the plugin
`SHALL NOT` write files uninvited. Depth words that map to variant
values `SHALL` compile into the model string; all other words `SHALL`
keep riding the per-spawn chat.params injection with its existing
disclosure. Generated artifacts `SHALL` be designed to travel with the
workspace (committed like a lockfile: a fresh machine pulling the
workspace needs no initialization), and the README handbook `SHALL`
document the recipe fields, starter recipes, the `mode: subagent`
trap, the current host tool vocabulary with its drift caveat, and the
cross-machine story.

#### Scenario: Recipe compiles to namespaced native agents

- **WHEN** a recipe with a pool and mixed-shape entries is synced
- **THEN** each entry exists as `.opencode/agent/forge-<ns>-<id>.md`
  with `mode: subagent` stamped, the pinned model (variant included
  where mapped), the shape's tools face in the current host vocabulary,
  mandates baked into the prompt body, and a GENERATED header — and
  removing the entry from the recipe garbage-collects its file on the
  next sync

#### Scenario: Stale artifacts refuse and recover in-band

- **WHEN** the recipe is newer than its compiled artifacts and a crew
  registration (or materialization precheck) runs
- **THEN** the operation is refused with a one-step recovery
  instruction; invoking the sync tool regenerates atomically, the host
  hot-applies the files, and the retry passes — all visible in the
  session transcript

#### Scenario: Depth rides variant where expressible, params elsewhere

- **WHEN** an entry's depth word maps to a variant value versus a word
  outside the variant set
- **THEN** the variant word compiles into the model string while the
  other keeps the per-spawn chat.params injection with its existing
  disclosure — the 7-word dictionary and translation matrix unchanged

#### Scenario: Recipe stays the authority; visibility follows the host

- **WHEN** dispatch gating, crew roster disclosure, or compliance
  checks run against a workspace whose agents are native-compiled
- **THEN** verdicts derive from the recipe exactly as today, while
  agent visibility follows the host's up-tree-merge scoping (nested
  directories see parent agents — a disclosed difference from
  nearest-exclusive pool scoping)

#### Scenario: Cross-machine is zero-initialization

- **WHEN** a workspace with committed recipe and committed generated
  artifacts is pulled onto a fresh machine
- **THEN** no initialization or migration step is required — the
  artifacts arrive with the recipe via the same pull, and staleness
  checks pass because both files travelled together

#### Scenario: Runtime materialization remains available as an escape hatch

- **WHEN** the materialize knob selects the runtime path (v1 hosts are
  pinned to it by generation; v2 hosts may opt in as the escape hatch)
- **THEN** behavior is byte-equal to today's draft-based
  materialization (the staleness gate is a native-mode facility)
