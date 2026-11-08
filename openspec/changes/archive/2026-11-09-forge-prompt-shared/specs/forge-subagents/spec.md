# forge-subagents Delta — forge-prompt-shared

## ADDED Requirements

### Requirement: Pool-level shared prompt segment

A pool's forge.json MAY declare an optional top-level `shared` field — a string prompt segment inherited by EVERY agent that file materializes. The materialized role prompt SHALL compose as: `shared` (when present and valid) joined by a blank line BENEATH the existing role chain, which is unchanged — an explicit per-agent `prompt` wins over the built-in `research`/`review` defaults, any other id without a prompt gets the generic one-liner, and `shared` never suppresses and never overrides anything (it is the pool's common base, not a replacement for any layer). Validation SHALL be field-level fail-soft: a `shared` that is not a non-empty string after trim records exactly ONE warn finding naming the file (`shared-invalid`) and is ignored — every agent of the pool still materializes with the unshared chain. The GLOBAL fallback file MAY declare `shared` and its family inherits it (the rule that ignores the global file's `pool` namespace field does NOT extend to `shared` — content is not namespace). Changes to `shared` SHALL hot-apply through the existing mtime cache at the next config resolve, exactly like any pool edit. With no `shared` declared anywhere, materialized prompts SHALL be byte-identical to the pre-change build.

#### Scenario: Shared rides beneath an explicit prompt

- **WHEN** a pool declares `"shared": "Project X conventions: …"` and an agent declares its own `prompt`
- **THEN** the materialized role prompt is the shared segment, a blank line, then the agent's explicit prompt — the explicit prompt's priority over role defaults is unchanged

#### Scenario: Shared rides beneath a built-in role default

- **WHEN** a pool declares `shared` and defines `research` WITHOUT a prompt
- **THEN** the materialized prompt is shared + blank line + the built-in research default — the built-in chain is intact beneath the shared base

#### Scenario: Shared rides beneath the generic one-liner

- **WHEN** a pool declares `shared` and defines a prompt-less agent whose id is neither research nor review
- **THEN** the materialized prompt is shared + blank line + the generic one-liner for that id

#### Scenario: Invalid shared warns once and is ignored

- **WHEN** a pool's top-level `shared` is a number, an array, or a whitespace-only string
- **THEN** exactly one warn finding (`shared-invalid`) names the file, the field is ignored, and every agent of the pool materializes with the unshared chain — the pool stays otherwise fully usable

#### Scenario: The global fallback file's shared inherits

- **WHEN** the global `~/.config/opencode/forge.json` declares a valid `shared`
- **THEN** every agent of the global fallback family inherits it — the `pool`-namespace-ignored rule for the global file does not extend to `shared`

#### Scenario: No shared anywhere is byte-identical

- **WHEN** no pool file (workspace or global) declares `shared`
- **THEN** every materialized prompt is byte-identical to the pre-change build, and no finding is recorded
