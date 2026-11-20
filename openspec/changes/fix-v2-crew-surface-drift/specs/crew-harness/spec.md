# fix-v2-crew-surface-drift — crew-harness delta

## MODIFIED Requirements

### Requirement: Unconfigured crew initialization gate

When `/crew` is invoked and the session's dispatchable roster is empty (neither the session's workspace pool nor the global fallback materializes any agent), the command SHALL refuse entry into crew orchestration (hard gate) and SHALL present initialization guidance stating: the two configuration layers and their relationship (the global `~/.config/opencode/forge.json` and the workspace's own `.opencode/forge.json` — SOLE OWNERSHIP: the nearest `.opencode/forge.json` walking up from the session's worktree owns the session and IS the whole roster; the global layer serves only as the fallback when the workspace has none — a fallback, not a merge; `forge.json` files nested deeper in the workspace subtree are ignored, the same workspace-ownership strictness as the host's native MCP config), a copy-paste JSONC agent template embedded in the command's discipline text, and the choice between configuring it themselves or having the session AI do so — where AI-assisted configuration SHALL happen only after the user's explicit go-ahead in that conversation, through the normally-visible write path. The guidance — template example AND prose — SHALL disclose the optional per-agent `prompt` field: an explicit prompt fully overrides the built-in role, only the ids `research` and `review` carry built-ins, and any other id without a prompt gets a generic one-liner (it will not know its job). The guidance SHALL likewise disclose the `shape` field: an ABSENT shape defaults to WRITE (open permissions — the compatibility-preserving default for existing pools), and `shape: "readonly"` is the explicit seal on the mutating-tool family for read-only roles; the embedded template example SHALL show the shape field on every agent entry. The guidance SHALL also state the id naming rule: ids are plain role words WITHOUT the `forge-` prefix, which the plugin adds at materialization (a prefixed id is auto-stripped with a warning). When the session AI writes the configuration on the user's go-ahead, it SHALL name ids as plain role words, SHALL give every agent a SHORT prompt derived from the role the user asked for — one or two sentences the user can trim or extend — SHALL give every agent an explicit `shape` (`readonly` for read-only roles — reviewers, scouts, planners; `write` for implementers and build-driving verifiers), SHALL write a long prompt only when the user explicitly asks for that agent, and SHALL include a proposed short, stable `pool` namespace for the file (a `[a-z0-9-]` word of at most 24 characters, independent of the directory name) so the materialized agent ids survive directory renames. The guidance SHALL also state the application timing: file edits, creations, and deletions hot-apply through the next config hook — no host restart is required for pool changes, and a deleted pool file un-materializes its agents. The gate SHALL resolve the calling session's roster anchor through the SAME authoritative-first chain as the dispatch belts (the host session record via the anchor client — with its pooled-map preference and ledger-rebind semantics; the tool-context anchor is consulted only when no anchor client is available), and SHALL anchor its guidance on that resolved worktree where one is observable (walking up from it for the owning pool), falling back to the host launch directory; and when the session's worktree carries a `.opencode/forge.json` the host has not yet materialized (the residual mismatch case — e.g. the file was created after host start), the gate output SHALL say so explicitly — naming the discovered file and directing the user to a host re-initialization in that workspace or to moving the agents into the global layer — instead of claiming the feature is unconfigured. The same disclosure SHALL apply on a successful `crew_begin` whose session-anchored discovery found a forge.json the host did not materialize. The plugin itself SHALL never write or create the file. This invitation surface SHALL exist only inside the unconfigured `/crew` flow — no other plugin surface (tool description, agent prompt, error path) SHALL invite AI-authored configuration.

#### Scenario: Unconfigured /crew refuses with initialization guidance

- **WHEN** `/crew <objective>` is invoked and the session's dispatchable roster is empty (no workspace pool, no global fallback)
- **THEN** entry into orchestration is refused and the response names the two layers with the sole-ownership rule (the workspace pool IS the roster; global is fallback-only, never merged; nested forge.json files ignored), shows the embedded template — including the optional per-agent `prompt` field and the `shape` field with its absent-defaults-to-write rule — offers the self-configure or AI-assisted options with the consent rule, and states the hot-apply timing (file changes apply at the next config hook; a deleted pool file un-materializes)

#### Scenario: AI-assisted configuration writes short role prompts

- **WHEN** the user explicitly asks the session AI to configure forge.json in that conversation
- **THEN** every agent the AI writes carries a SHORT prompt derived from the role the user asked for (one or two sentences), unless the user explicitly asked for a longer prompt on that agent — ids are named as plain role words without the `forge-` prefix, every agent carries an explicit `shape` (`readonly` for read-only roles, `write` for implementers), the file includes a proposed short stable `pool` namespace, and the consent rule (never write forge.json without the explicit go-ahead) still governs the write itself

#### Scenario: A workspace file the host cannot see is disclosed, not masked

- **WHEN** the session's dispatchable roster is empty but the calling session's worktree carries a usable `.opencode/forge.json` the host has not materialized
- **THEN** the gate output names that file and states that this host has not materialized it — directing the user to a host re-initialization in that workspace or to add the agents to the global layer — rather than reporting the feature as unconfigured

#### Scenario: The configuration invitation lives only in the /crew gate

- **WHEN** any other plugin surface is inspected (tool descriptions, materialized agent prompts, error paths)
- **THEN** no surface invites the session AI to author forge.json — the everyday dispatch path stays configuration-silent

#### Scenario: A configured crew bypasses the gate

- **WHEN** `/crew <objective>` is invoked and the session's dispatchable roster materializes at least one agent
- **THEN** the gate does not fire and orchestration discipline proceeds normally; if the session's own discovery additionally found a forge.json the host did not materialize, the crew_begin output carries that disclosure alongside the registration summary

#### Scenario: A re-anchored session resolves its roster from the authoritative record

- **WHEN** the session was created in a pool-less directory, the host session record now carries a pool-owning directory (session moved / re-anchored), and the tool context still reports the original pool-less directory
- **THEN** the gate resolves the roster from the authoritative record's directory (the workspace pool IS the roster) and does NOT fire the unconfigured refusal — the same verdict the dispatch belts give for that session

#### Scenario: A fresh install with only a per-project pool enters crew

- **WHEN** a host has no global forge.json anywhere, the session's workspace carries a `.opencode/forge.json` with at least one agent, and `/crew` is invoked
- **THEN** the gate does not fire — the workspace pool alone is a complete roster and crew orchestration proceeds with zero global configuration
