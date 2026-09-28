# dispatch Capability Delta

## REMOVED Requirements

### Requirement: Exact-match resolution with no clamping

**Reason**: Per-dispatch dynamic `(model, depth)` resolution is removed with the dispatch engine; models and depths are now pinned statically per agent definition (owner reversal of the 2026-09-27 adjudication, informed by omo/ZCode source research).
**Migration**: Pin `model` and an optional `thoughtLevel` in forge.json; per-call depth selection no longer exists. Superseded by the `forge-subagents` capability.

### Requirement: forge_dispatch tool contract

**Reason**: The HTTP child-session engine and its tool are removed; subagents are dispatched via the host's native task tool for TUI visibility.
**Migration**: Use the native `task` tool with `subagent_type: "forge-<id>"`. Superseded by `forge-subagents` — Native-task dispatch surface.

### Requirement: Reasoning-depth injection via chat params

**Reason**: The sessionID-keyed injection table was fed by the dispatch engine; injection now keys on the agent name with a statically pinned word.
**Migration**: Superseded by `forge-subagents` — Pinned thoughtLevel injection keyed by agent name (same family translation rules; untranslatable words degrade to findings instead of failing a dispatch).

### Requirement: Cost reporting with self-computed prices

**Reason**: Token/cost aggregation was a property of the engine's completion polling; with native task dispatch the plugin no longer observes subagent transcripts.
**Migration**: None — accepted loss; the host's own reporting applies.

### Requirement: Draft-plan interop and dispatch ledger

**Reason**: The dispatch tool and the ledger are both removed; plan-draft protection is inherited from the plan harness's existing spawn-class deny on the native task tool.
**Migration**: None — `task` is already denied during a draft. Superseded by `forge-subagents` — Native-task dispatch surface.

### Requirement: Worker prompt discipline

**Reason**: The wrapper was applied by the dispatch engine at spawn time; the discipline now lives inside the materialized agent prompt.
**Migration**: Superseded by `forge-subagents` — Materialization as native subagents with a pinned model (discipline embedded in the composed prompt).

### Requirement: Background dispatch mode

**Reason**: Background child sessions existed to feed wave orchestration and idle wake briefs; both are removed with the engine.
**Migration**: None — parallel work is expressed as parallel native task calls; there is no background handle.

### Requirement: Completion wake briefs

**Reason**: Depends on the removed background registry and idle re-prompt machinery.
**Migration**: None — native task calls return their results as tool results in the calling turn.

### Requirement: Background kill, run-mode disclosure and host-exit honesty

**Reason**: With no background dispatches there is nothing to kill, disclose, or mark lost-on-exit.
**Migration**: None.

### Requirement: Dedicated forge.json configuration file

**Reason**: The file contract survives but moves to the superseding capability with a changed schema (`thoughtLevel` replaces `depths`; the seed fallback level disappears).
**Migration**: Superseded by `forge-subagents` — Static agent definitions in a dedicated forge.json (two-level cascade: project over global, no seed level).

### Requirement: Seed placeholder onboarding

**Reason**: Placeholder pins and the AI-invited configuration recipe produced the exact failures the owner rejected (deterministic placeholder errors, session-AI-authored config files).
**Migration**: Superseded by `forge-subagents` — inert unconfigured state; onboarding is human-facing documentation.

### Requirement: Agent materialization as the permission vehicle

**Reason**: Materialization survives but its contract inverts: the pinned `model` is now written into the agent entry, and agents must be visible to the native task tool rather than spawned through the message body.
**Migration**: Superseded by `forge-subagents` — Materialization as native subagents with a pinned model.

### Requirement: forge_dispatch_config introspection

**Reason**: The introspection tool existed to round-trip configuration for the session AI to rewrite; the session AI is no longer a configuration actor.
**Migration**: None — configuration state is human-readable JSONC on disk; findings surface through plugin diagnostics.
