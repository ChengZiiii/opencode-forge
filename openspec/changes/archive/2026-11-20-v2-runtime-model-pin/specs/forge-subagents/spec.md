# v2-runtime-model-pin — Specs

## ADDED Requirements

### Requirement: Runtime model pin on v2 hosts

On a v2 host, a forge-family agent whose pool def pins `model`
(`"provider/model"`) `SHALL` serve every request on the pinned model:
the context-injection path `SHALL` rewrite the payload's `model`
(providerID + id/modelID spellings, variant dropped) to the pinned
identity, resolved fresh per request (hot-apply contract). The agent
draft `SHALL` still omit `model` (the host encoder rejects it).

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

### Requirement: Sandbox full-chain proof

The change `SHALL` be verified on the live 2.3.2 sandbox: a pool agent
with a model pin, dispatched as a subagent, completes a turn served by
the pinned model (asserted on the served message record).

#### Scenario: Dispatched pinned subagent serves on the pin

- WHEN a primary dispatches a task to a pinned pool agent on the sandbox
- THEN the subagent's assistant record names the pinned model
