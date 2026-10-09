# tool-partition Delta — allow-readonly-recon-during-plan-draft

## MODIFIED Requirements

### Requirement: Session-scoped safety interop for active drafts

While a session has an active plan draft, the draft-phase write ban SHALL remain session-scoped: write-class tool calls are denied for every agent in that session, including non-forge agents, because the draft protects shared session state. The task-dispatch shape exemption SHALL follow the same session scope and the plan harness's semantics: a task call whose target resolves to an effective-readonly forge subagent passes during draft regardless of the speaking agent, while every other target stays denied. Non-forge turns SHALL gain no new dispatch capability from the exemption: the family dispatch guard refuses a non-forge agent's forge-* targets before the draft gate is consulted, and native targets are never effective-readonly — so a non-forge agent's dispatch surface during a draft is byte-identical with and without this exemption. Denials SHALL name the way out (return to forge for plan_approve, or /plan discard). This remains the one deliberate forge constraint that reaches non-forge turns: passive protection of shared state — forge SHALL never actively drive a non-forge turn.

#### Scenario: A non-forge agent is write-blocked during an active draft

- **WHEN** the user switches a draft-bound session to the build agent and it attempts a write
- **THEN** the write is denied with guidance naming plan approval via forge or /plan discard, and the draft is untouched

#### Scenario: The shape exemption grants non-forge turns nothing

- **WHEN** a draft-bound session is driven by a non-forge agent that dispatches `task {subagent_type: "forge-research"}` (effective readonly) or `task {subagent_type: "general"}`
- **THEN** the forge-* target is refused by the family dispatch guard and the native target by the draft write ban — identical to the pre-exemption behavior
