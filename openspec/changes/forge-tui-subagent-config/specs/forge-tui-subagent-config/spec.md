## Purpose

Let humans configure Forge's native worker recipe inside OpenCode's TUI using the host's model catalog and explicit, scope-aware saves without a separate configuration system or model turn.

## ADDED Requirements

### Requirement: Native human configuration entry

The Forge package SHALL expose a V2 TUI entry with a searchable `Forge: Configure subagents` command-palette item and `/forge-config` shortcut from home and session views. Navigation SHALL use the host's theme and keyboard-compatible controls, remain operable on narrow terminals, and SHALL NOT change the active conversation's model or send a prompt. Opening, browsing, cancelling, and plugin lifecycle alone SHALL NOT write recipes or generated artifacts. Unavailable host capabilities SHALL be disclosed without breaking normal server plugin usage. User-owned commands SHALL NOT be overwritten. If the server Forge plugin is disabled, absent or its active state cannot be verified, the TUI SHALL refuse recipe writes and sync, including retries.

#### Scenario: Open from home and session
- **WHEN** a human selects the palette entry or invokes the TUI shortcut from either supported view
- **THEN** the configuration list opens without any model request or change to the conversation model

#### Scenario: Navigate a narrow terminal
- **WHEN** the terminal cannot fit all list columns
- **THEN** keyboard navigation and a compact list/detail presentation keep the fields and actions accessible

#### Scenario: TUI API unavailable
- **WHEN** the host cannot provide the supported TUI entry or a required capability
- **THEN** the unavailable feature is disclosed and server-side Forge remains independently usable

#### Scenario: Server plugin disabled or unverifiable
- **WHEN** the separate TUI module is loaded but the server plugin is disabled, absent or its active state cannot be verified
- **THEN** no recipe save or sync is permitted and the UI explains why

### Requirement: Scope-aware recipe browsing

The editor SHALL identify the actual file, effective workspace roster, namespace and native worker IDs according to the existing exclusive-pool rules. It SHALL support browsing and searching both workspace and global recipes without merging them, default to the effective source, and distinguish inactive global fallback from active workspace workers. Session scope SHALL follow the existing authoritative session anchor resolution rather than a guessed process directory; home scope SHALL use an observed host workspace. If ownership cannot be confirmed, the editor SHALL NOT write. Creation of a missing workspace recipe SHALL be explicit, warn that it replaces global fallback, and require a valid declared pool name. Creation of a missing global recipe SHALL also be explicit with the global path and machine-wide scope shown; only the selected worker or override is activated, and unselected built-ins retain unchanged behavior. Existing ancestor-owned pools SHALL be edited at the owning file. Global override entries SHALL be separate from pool workers and limited to `general` and `explore`.

#### Scenario: Workspace overrides the fallback
- **WHEN** a session has an ancestor-owned workspace pool and a global recipe
- **THEN** the workspace file is the effective source and the selectable global view is labelled non-effective for that session; no deeper recipe is created

#### Scenario: Create a previously absent workspace pool
- **WHEN** only the global pool exists and the human opts to create a workspace pool
- **THEN** the path, fallback consequence and valid pool name are presented before any write, and cancelling leaves the effective global roster intact

#### Scenario: Create a previously absent global recipe
- **WHEN** the human confirms the first global worker or override in the TUI while no global recipe exists
- **THEN** the global recipe is created only on explicit save, with only the selected entry active and other built-ins unchanged

#### Scenario: Global override view
- **WHEN** viewing global configuration
- **THEN** general and explore overrides are listed separately with their configured or unoverridden state, regardless of the current workspace pool

#### Scenario: Unknown or remote ownership
- **WHEN** the session anchor or same-host filesystem ownership cannot be established, including an unsupported remote attachment
- **THEN** writes are unavailable with an explanation; no guessed local path is modified

### Requirement: Recipe field editing and host model choices

The UI SHALL support creating, editing and confirming removal of custom recipe workers and creating, editing or confirming removal of global built-in overrides. Existing worker IDs SHALL NOT be directly renamed. The editable worker fields SHALL be exactly `model`, `thoughtLevel`, `shape`, `prompt`, `permission`, plus the ID at creation. No new disable or runtime fields are introduced. Model selection SHALL use the host's available provider/model identities and target-model variant metadata, with searchable selection and visibly distinguished Auto/Pinned mode. Auto SHALL remove both model and thoughtLevel; Pinned SHALL require both, revalidating the level on model changes. Missing or unavailable catalog data, existing unavailable IDs and unknown levels SHALL be disclosed, never silently remapped. Custom levels may be explicitly entered under existing Forge depth semantics and labelled unverified if not supported by observed metadata. The UI SHALL preserve shape default semantics, show explicit permission overrides, and never lift existing mandatory worker restrictions. Non-Forge host agents SHALL NOT be editable here.

#### Scenario: Pin a worker from the host catalog
- **WHEN** the human selects a provider, a model and a supported target-model level
- **THEN** the draft contains the exact provider/model identity and matching thoughtLevel; the conversation model is unchanged

#### Scenario: Convert a pinned worker to Auto
- **WHEN** the human chooses Auto and saves
- **THEN** both pin fields are removed and the new worker projection inherits its parent's model under the existing contract

#### Scenario: Change a target model
- **WHEN** the selected target model changes and its previous level is not established as supported
- **THEN** the old choice requires explicit revalidation or replacement; the current conversation's variant list is not treated as the target's list

#### Scenario: Catalog unavailable or stale custom identity
- **WHEN** the catalog is not ready or an existing pinned identity or level is absent from it
- **THEN** availability is disclosed; the existing raw value is preserved unless explicitly edited, and an unverified level is not presented as host-confirmed

#### Scenario: Field and policy validation
- **WHEN** the human edits shape, prompt or permissions, or submits a duplicate or invalid ID or incomplete pin
- **THEN** the existing schema and policy rules apply; invalid changes are refused and namespaced worker restrictions remain enforced

#### Scenario: Delete or reset with confirmation
- **WHEN** a human requests deletion of a worker or removal of a built-in override
- **THEN** a confirmation names its identity and source file; cancelling makes no change, confirming removes only that recipe entry on explicit save

### Requirement: Explicit safe recipe saves

All changes SHALL remain drafts until the human confirms Save & Sync with a target file and change summary. Leaving or switching a dirty draft SHALL require confirming discard or staying; no-op saves SHALL make no writes. The editor SHALL apply targeted JSONC changes preserving unrelated bytes, comments, unknown fields, encoding and newline style, validate the changed entry against the live recipe contract, and retain unrelated invalid entries with disclosed findings. An unparseable or unreadable document or ambiguous edit target SHALL block writing rather than being replaced. Before committing, the editor SHALL recheck actual scope, file identity, active server Forge state and original content to detect external changes or competing saves, and SHALL use atomic replacement with failure leaving the previous file intact. Only the confirmed recipe may be written; no model-accessible recipe-writer is introduced.

#### Scenario: Cancel or unchanged draft
- **WHEN** a user backs out of a dirty edit, declines confirmation, or saves an unchanged draft
- **THEN** cancellation is respected and no recipe or generated file is written

#### Scenario: Preserve hand-edited JSONC
- **WHEN** an entry is changed in a recipe with comments, unknown keys, non-ASCII text and an unrelated invalid sibling
- **THEN** the changed fields are updated while unrelated content stays byte-identical and existing findings remain visible

#### Scenario: Broken or ambiguous recipe
- **WHEN** the original document cannot be parsed or read, or the edited key cannot be uniquely located
- **THEN** the editor discloses the problem with location when available and performs no write

#### Scenario: Another editor changes the file
- **WHEN** the file bytes, destination identity or owning pool differ from the snapshot at commit time
- **THEN** the save is refused as a conflict and offers reload rather than overwriting the newer contents

#### Scenario: Commit failure
- **WHEN** the atomic write fails
- **THEN** the prior file stays intact, the human sees the failure, and synchronization is not started

### Requirement: Deterministic synchronization and application status

A successful changed-recipe Save & Sync SHALL invoke the existing native roster compilation semantics for the selected family without a model turn, including its applicable global overrides, atomic generated writes, safe garbage collection and hand-written agent protection. It SHALL NOT rewrite unrelated families merely because they are known to the host. Recipe persistence and native projection/application outcomes SHALL be independently reported. Applied status SHALL require host confirmation of the relevant registration change (including changed observable fields or removal, not merely an existing ID), not just a successful disk write. If sync or host confirmation fails, the editor SHALL retain the saved recipe, disclose the failure or unknown status and offer explicit retry; retry SHALL recheck server enablement and target ownership and SHALL NOT overwrite newer recipe changes from a stale draft. Running children SHALL retain existing host and Forge semantics: Auto inheritance binds at dispatch, depth resolution freezes per session, and the existing request-time model pin hot-applies; the editor SHALL NOT interrupt or restart children. Existing server sync and opt-in auto sync remain available unchanged. If the edit changes cross-family collision winners or otherwise requires writing an unrelated family to reconcile the host registry, the editor SHALL disclose the conflict and SHALL NOT report applied; it SHALL offer the existing explicit host-wide sync recovery separately.

#### Scenario: Save then verify native registration
- **WHEN** a human confirms creation, modification or removal of a valid worker or override and native sync succeeds
- **THEN** the corresponding native projection is updated using the existing compiler, and the UI reports applied only after the relevant host registration is confirmed

#### Scenario: Sync failure after successful save
- **WHEN** the recipe persists but compilation, generated write or host confirmation fails
- **THEN** the UI distinguishes saved from sync failed or application unconfirmed and offers retry against current recipe content

#### Scenario: Preserve manual agents and other families
- **WHEN** an edited family has a conflicting hand-written agent or another known family has unrelated generated agents
- **THEN** existing no-clobber behavior is honored and unrelated families are not changed by the TUI sync

#### Scenario: Cross-family collision requires broader reconciliation
- **WHEN** an edit changes a collision winner and reconciling the native projection would require modifying another family
- **THEN** the TUI leaves the unrelated family untouched, reports application unconfirmed with the conflict and identifies the explicit host-wide sync recovery

#### Scenario: Existing child follows the current runtime contract
- **WHEN** a worker's configuration is saved while an already-dispatched child is running
- **THEN** the editor does not interrupt or restart it; Auto inheritance, frozen depth and request-time pinned model hot-apply remain governed by the existing runtime requirements
