# forge-subagents Delta — shape-default-open

## MODIFIED Requirements

### Requirement: Materialization as native subagents with a pinned model

The config hook SHALL materialize each configured agent as a `mode: subagent` agent `forge-<id>` that is visible to the host's native `task` tool vocabulary (discoverable by the model, excluded from the Tab cycle by its subagent mode), a prompt composed of the worker discipline wrapped around the role prompt, and a deny-style permission: `shape: "readonly"` — which MUST be explicit — denies the full mutating-tool family — `write`, `edit`, `bash`, and the host's patch-family tools (`patch`, `applypatch`, `apply`, `multiedit`); `shape: "write"` allows them, and an ABSENT `shape` field SHALL default to `write` (open permissions — readonly is a restriction the pool author must ask for explicitly, never a surprise default); an explicit `permission` map overrides the shape-derived default — and every agent SHALL deny `task` regardless (recursive spawning stays physically impossible). A pinned entry's materialized agent SHALL carry the definition's pinned `model` (the brain is bound at materialization — there is no per-call model selection); an Auto entry's materialized agent SHALL carry no `model` key at all, deferring to the host's native spawn behavior — the parent session's current model binds at dispatch time (snapshot semantics: later primary model switches do not affect already-dispatched runs). The task-vocabulary description SHALL name the role and, for a pinned entry, the pinned brain; an Auto entry's description SHALL state that it inherits the parent session's model instead of claiming a pinned identity. The worker discipline embedded in the prompt SHALL mandate workspace-relative paths only (never absolute paths outside the workspace), verbatim reporting of tool refusals instead of improvising workarounds, and conclusions carrying evidence references; readonly agents are additionally told to report rather than work around restrictions. Materialization SHALL be create-only: a user-defined entry of the same id is never touched (identically under the v2 `setup` entry point, which registers the same agents on a create-only basis). When `agent["forge"].disable` is set no subagents SHALL be registered.

#### Scenario: Agent entries carry the pinned model

- **WHEN** the plugin loads with a forge.json defining `research: {model: "prov/x", thoughtLevel: "low"}` and the injected agent set is inspected
- **THEN** `forge-research` is a subagent-mode agent whose `model` is exactly `prov/x`, listed for the native task tool, with a deny-style permission including `task: deny`

#### Scenario: An Auto worker materializes without a model key

- **WHEN** the plugin loads with a forge.json defining `scout: {}` (no `model`, no `thoughtLevel`, no `shape`) and the injected agent set is inspected
- **THEN** `forge-scout` is a subagent-mode agent with no `model` field, listed for the native task tool, with the same deny-style permission including `task: deny`, a description that names inheritance rather than a pinned identity — and, defining no `shape`, OPEN write permissions (the absent-shape default)

#### Scenario: The materialized prompt embeds the discipline

- **WHEN** the composed prompt of a materialized agent is inspected
- **THEN** it contains the workspace-relative-path mandate and the verbatim-refusal-reporting mandate, wrapped around the agent's role prompt (explicit `prompt` overriding the built-in role default)

#### Scenario: The readonly deny face covers the patch family

- **WHEN** an agent with an EXPLICIT `shape: "readonly"` has its materialized permission enumerated
- **THEN** `patch`, `applypatch`, `apply`, and `multiedit` are denied alongside `write`, `edit`, and `bash`, and `task` stays denied for every shape; the same family governs the draft-phase shape gate's lifting test (a permission override that lifts any of them out of `deny` disqualifies the readonly exemption)

#### Scenario: An absent shape defaults to open permissions

- **WHEN** a pool defines `ta-tool: {model: "prov/x"}` with NO `shape` field and the materialized permission is inspected
- **THEN** the mutating-tool family is not denied (open write permissions), `task` stays denied — and the draft-phase recon exemption does NOT apply to this agent (the exemption keys on an explicitly readonly shape; a shape-less agent is not draft-exempt)

#### Scenario: A permission override keeps the recursion ban

- **WHEN** an agent sets `permission: {"bash": "deny"}` with `shape: "write"`
- **THEN** the materialized permission honors the override and still carries `task: deny`

#### Scenario: A user-defined agent entry is never clobbered

- **WHEN** the user has their own `agent["forge-research"]` configuration (v1 or v2 loader)
- **THEN** the plugin skips injection for that id and the user's entry stands

#### Scenario: The disable knob registers nothing

- **WHEN** `agent["forge"].disable: true` is set
- **THEN** no `forge-*` subagents are registered alongside the other plugin silences
