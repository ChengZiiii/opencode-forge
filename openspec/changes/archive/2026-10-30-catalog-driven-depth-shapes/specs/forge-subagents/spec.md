# forge-subagents Delta — catalog-driven-depth-shapes

## MODIFIED Requirements

### Requirement: Pinned thoughtLevel injection keyed by agent name
For any session running a `forge-<id>` agent, the plugin SHALL translate that agent's pinned `thoughtLevel` to the provider's native parameter and stamp it onto the LLM request via the `chat.params` hook, keyed by the agent name (stable across sessions and spawn paths — no per-dispatch session table). The meta vocabulary SHALL be the seven-word dictionary `none / minimal / low / medium / high / xhigh / max` — a translation dictionary, never a whitelist. The pinned word SHALL be normalized at the configuration boundary (trimmed and lowercased — `High` and `XHigh` behave exactly as `high` and `xhigh`) with a warn finding recorded when normalization changed the value. Wire-shape resolution SHALL be data-driven in a fallback chain: when the models.dev catalog carries `reasoning_options` for the model, the shape (effort word list / toggle / token budget) SHALL come from that data for every provider family EXCEPT anthropic, with the ladder matched case-insensitively and the catalog's native casing emitted on the wire; for the anthropic family the shape SHALL instead be resolved from the empirically verified transport matrix — adaptive-era models receive the adaptive effort channel, legacy-era models receive the budget tier table — regardless of what the catalog carries, because the current host generation's anthropic transport silently drops the effort-word key a catalog effort shape would select. A model the catalog is silent on SHALL fall back to the provider-prefix family map; a provider absent from both SHALL be treated as an effort-word channel by default. A word that matches neither the dictionary nor the model's ladder SHALL pass through VERBATIM on word-shaped channels, disclosed as unverified — the provider is the final judge, and a provider-side rejection surfaces as the request's own error, never swallowed by the plugin. Legacy budget-only models and toggle-only endpoints — the shapes with no word channel — are the only no-counterpart cases: there the plugin SHALL inject nothing and record a bounded finding naming both vocabularies (the worker session itself must never be broken by the plugin). Budget-tier translation on legacy budget models SHALL use the documented tier table per meta word (`none` → thinking off; the table carries tiers for `minimal` and `xhigh`). Adaptive-era Anthropic models SHALL receive the effort word on the empirically verified adaptive effort key; the plugin does not own transport-layer capability probing, so the patched-host presumption (a host generation whose anthropic transport maps the adaptive key onto the wire) is a documented limitation in the README, not a runtime-detectable condition. The verbatim-first and no-interpolation rules SHALL govern every translation (a word passes as-is or is refused with a finding — it is never remapped to a different level). An agent without `thoughtLevel` SHALL inject nothing. The session's first depth resolution — including a no-mapping (dead-end) resolution — SHALL be frozen for the whole session: neither the injected value nor the absence of injection is rewritten mid-session, and configuration edits affect only sessions created afterwards.
#### Scenario: The pinned depth reaches the provider request
- **WHEN** a session runs `forge-research` pinned `thoughtLevel: "low"` on an effort-style family provider
- **THEN** that session's chat.params writes `options.reasoningEffort = "low"` and keeps it stable across turns
#### Scenario: Absent thoughtLevel injects nothing
- **WHEN** an agent defines no `thoughtLevel`
- **THEN** the provider's default applies and no reasoning option is injected
#### Scenario: An untranslatable word degrades to a finding, not a broken session
- **WHEN** a pinned word has no counterpart on a shape with no word channel — a legacy budget-only model offered a word outside the tier table, or a toggle-only endpoint offered `xhigh`
- **THEN** nothing is injected, the session runs at the provider default, and a bounded finding naming the shape's vocabulary and the meta dictionary is recorded once
#### Scenario: Case variants normalize at the boundary
- **WHEN** forge.json pins `thoughtLevel: "High"` (or `"XHigh"`) and the entry loads
- **THEN** the pinned word normalizes to `high` (or `xhigh`), injection behaves exactly as the lowercase word, and a warn finding records the normalization once
#### Scenario: An unknown word passes through on word channels
- **WHEN** an agent pins `thoughtLevel: "ultra"` on an effort-word channel and the model's ladder does not list it
- **THEN** the word is injected verbatim with an unverified disclosure, and any provider-side rejection surfaces as the request's own error — the plugin neither swallows it nor breaks the session itself
#### Scenario: The catalog decides the shape, with prefix fallback
- **WHEN** the models.dev catalog carries `reasoning_options` for the model (effort values / toggle / budget), is silent for another model on a known provider, and absent for a custom provider
- **THEN** the first model translates by its catalog shape (ladder matched case-insensitively, catalog casing emitted), the second falls back to the provider-prefix family, and the third defaults to effort-word pass-through
#### Scenario: Catalog effort metadata does not override the verified anthropic matrix
- **WHEN** the models.dev catalog carries `reasoning_options` of type effort for `anthropic/claude-opus-4-7` and `anthropic/claude-opus-4-6` (as the production catalog does) and agents pin `thoughtLevel: "xhigh"` on each
- **THEN** the adaptive-era model translates on the empirically verified adaptive effort key (never the effort-word key the current host generation's anthropic transport silently drops), and the legacy-era model translates on the budget tier table — the catalog's effort claim for the anthropic family is not consulted for shape selection
#### Scenario: Adaptive-era Anthropic models receive the effort word
- **WHEN** an adaptive-era Anthropic model is pinned `thoughtLevel: "xhigh"` on a host whose anthropic transport maps the adaptive effort key onto the wire
- **THEN** the effort word reaches the wire on that key as-is; the patched-host presumption is documented in the README (the plugin performs no transport-layer capability probing)
#### Scenario: Budget tiers cover the seven-word dictionary
- **WHEN** a legacy budget-tier model is pinned `minimal` or `xhigh`
- **THEN** the documented tier table resolves them (the published floors/caps, including the 1024 API-minimum tier for `minimal`) and the README table remains the verbatim source
#### Scenario: A dead-end resolution freezes like any other
- **WHEN** a session's first depth resolution is a dead end (no-counterpart shape) and the user then edits forge.json mid-session in a way that would make the pinned word translatable
- **THEN** nothing is injected for the remainder of that session and the bounded finding is not re-recorded; a session created after the edit resolves fresh and injects
