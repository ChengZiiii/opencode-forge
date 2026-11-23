## MODIFIED Requirements

### Requirement: Runtime model pin on v2 hosts

On a v2 host, a forge-family agent whose pool def pins `model`
(`"provider/model"`) `SHALL` serve every request on the pinned model:
the context-injection path `SHALL` rewrite the payload's `model`
(providerID + id/modelID spellings) to the pinned identity, resolved fresh
per request (hot-apply contract). The variant field `SHALL` survive the
rewrite honestly: when the pinned identity equals the resolved model the
existing `variant` `SHALL` be preserved (the compiled roster's variant
channel — e.g. `#low` — reaches the host UI intact); when the pin switches
to a different model, the variant `SHALL` be derived from the recipe's
pinned depth when that depth is a variant word (`low`/`medium`/`high`),
and only otherwise `SHALL` be dropped (a stale variant of a different model
is meaningless). The agent draft `SHALL` still omit `model` (the host
encoder rejects it).

#### Scenario: Pinned pool agent serves on the pinned model

- GIVEN a pool def pinning `model: "glm-coding-worker/glm-5.3"` on a v2
  host whose default model differs
- WHEN the pinned agent's session builds a request
- THEN the served request uses the pinned model
- AND the assistant message record names the pinned model

#### Scenario: Unpinned agents keep the resolved model

- WHEN a forge-family agent's def has no `model` pin
- THEN the context path leaves the payload model untouched

#### Scenario: Malformed pin skips silently

- WHEN a def's `model` does not parse as `"provider/model"`
- THEN no rewrite happens and no error surfaces

#### Scenario: Same-identity pin preserves the variant channel

- GIVEN a compiled worker whose `.md` model string carries a variant
  (e.g. `glm-coding-worker/glm-5.3-flash#low`) and whose recipe pins the
  same model
- WHEN the pinned agent's session builds a request
- THEN the payload model keeps `variant: "low"` — the host UI shows the
  real depth instead of default

#### Scenario: Model switch derives the variant from the pinned depth

- GIVEN a recipe pinning a different model with
  `thoughtLevel: "high"`
- WHEN the context path rewrites the payload model to the pinned identity
- THEN the variant is set to `"high"`; with no depth word pinned, the
  stale variant is dropped instead
