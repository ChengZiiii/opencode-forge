# forge-tui-subagent-config Specification

## Purpose
Let humans configure Forge's native worker recipe inside OpenCode's TUI using the host's model catalog and explicit, scope-aware saves without a separate configuration system or model turn. Saves and synchronization are executed by the server plugin over the official Plugin RPC under a bounded prepare→confirm→commit protocol; the TUI drafts and confirms, it does not write files itself.

## Requirements

### Requirement: Native human configuration entry

The Forge package SHALL expose a V2 TUI entry with a searchable `Forge: Configure subagents` command-palette item and `/forge-config` shortcut from home and session views. Navigation SHALL use the host's theme and keyboard-compatible controls, remain operable on narrow terminals, and SHALL NOT change the active conversation's model or send a prompt. Opening, browsing, cancelling, and plugin lifecycle alone SHALL NOT write recipes or generated artifacts. Unavailable host capabilities SHALL be disclosed without breaking normal server plugin usage. User-owned commands SHALL NOT be overwritten. If the server Forge plugin is disabled, absent, its active state cannot be verified, or the RPC transport cannot be proven working against it, the TUI SHALL refuse recipe writes and sync, including retries (zero-write on unprovable server).

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
- **WHEN** the separate TUI module is loaded but the server plugin is disabled, absent, its active state cannot be verified, or the RPC transport to it cannot be proven (probe-proven echo/dispose behaviors fail)
- **THEN** no recipe save or sync is permitted — including retries — and the UI explains why

### Requirement: Scope-aware recipe browsing

The editor SHALL present the actual file, effective workspace roster, namespace and native worker IDs as resolved by the server plugin's existing exclusive-pool rules, not by a TUI-side reimplementation. It SHALL support browsing and searching both workspace and global recipes without merging them, default to the effective source, and distinguish inactive global fallback from active workspace workers. Session scope SHALL follow the server's authoritative session anchor resolution — including its live `session.moved` record — rather than a guessed process directory or a stale pre-move session row; home scope SHALL use a server-observed host workspace. If the server cannot confirm ownership for a target, the editor SHALL NOT offer writes for it. Creation of a missing workspace recipe SHALL be explicit, warn that it replaces global fallback, and require a valid declared pool name. Creation of a missing global recipe SHALL also be explicit with the global path and machine-wide scope shown; only the selected worker or override is activated, and unselected built-ins retain unchanged behavior. Existing ancestor-owned pools SHALL be edited at the owning file. Global override entries SHALL be separate from pool workers and limited to `general` and `explore`. The list view SHALL overlay every pending draft — create, update and delete alike — onto the base entries of the same scope: an entry with a pending update SHALL show the pending values with a pending marker, a pending delete SHALL show a removal marker, and the base file SHALL remain unchanged until an explicit confirmed save. The view SHALL NOT merge pending creates only: entries with pending updates or deletes SHALL NOT be rendered from stale base content without their pending state. Search SHALL run over the same merged view. Discarding a draft SHALL revert the view to the base entry and SHALL NOT pollute the edit-start snapshot used for conflict detection.

#### Scenario: Pending update overlays the listed entry
- **WHEN** an existing entry has a pending update draft while the list is rendered
- **THEN** the list shows the pending values over the base entry marked as pending, not the untouched base content

#### Scenario: Pending delete marks the entry
- **WHEN** an existing entry has a pending delete draft
- **THEN** the list still shows the entry with its pending-removal state while the base file stays unchanged until an explicit confirmed save

#### Scenario: Pinned to Auto pending conversion overlays the view
- **WHEN** a Pinned entry has a pending conversion to Auto while the list is rendered
- **THEN** the model and thought level disappear from the entry's pending presentation (both pin fields shown as removed) while nothing is written to disk until an explicit confirmed save

#### Scenario: Search covers the merged view
- **WHEN** the human searches while update or delete drafts are pending
- **THEN** results are computed over base entries plus all pending drafts in the same scope, so matching pending values are found and stale base content does not stand in for them

#### Scenario: Discard restores the base without snapshot pollution
- **WHEN** the human discards a pending draft
- **THEN** the view reverts to the base entry, the edit-start snapshot used for conflict detection stays as captured at editor open, and no bytes are written

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
- **WHEN** the server cannot authoritatively resolve a target's owning recipe or anchor
- **THEN** writes and syncs are unavailable for that target with an explanation; no path is guessed, and no connection-observed path is written as if it were a local file

### Requirement: Recipe field editing and host model choices

The UI SHALL support creating, editing and confirming removal of custom recipe workers and creating, editing or confirming removal of global built-in overrides. Existing worker IDs SHALL NOT be directly renamed. The editable worker fields SHALL be exactly `model`, `thoughtLevel`, `shape`, `prompt`, `permission`, plus the ID at creation. No new disable or runtime fields are introduced. Model selection SHALL use the host's available provider/model identities and target-model variant metadata, with searchable selection and visibly distinguished Auto/Pinned mode. Auto SHALL remove both model and thoughtLevel; Pinned SHALL require both, revalidating the level on model changes. Missing or unavailable catalog data, existing unavailable IDs and unknown levels SHALL be disclosed, never silently remapped. Custom levels may be explicitly entered under existing Forge depth semantics and labelled unverified if not supported by observed metadata. The entry page SHALL keep field controls with their current values visible on one page, with direct access to the corresponding field editors (such as the prompt or permission editors) without unrelated navigation. Within Pinned, changing the model SHALL NOT force an Auto/Pinned mode re-selection — the mode stays Pinned and only the level is revalidated — and the thought level SHALL be editable alone while the model identity is unchanged. An in-page Save & Sync SHALL save the current pending batch only, with the included entries explicitly disclosed before anything is written. The UI SHALL preserve shape default semantics, show explicit permission overrides, and never lift existing mandatory worker restrictions. Non-Forge host agents SHALL NOT be editable here.

#### Scenario: Model change keeps the pinned mode
- **WHEN** the human changes the model of a Pinned entry without touching the mode control
- **THEN** the draft stays Pinned, only the level is revalidated or replaced as required, and no Auto/Pinned re-selection step is forced

#### Scenario: Level edited alone
- **WHEN** the human edits only the thought level of a Pinned entry
- **THEN** the model identity is unchanged and the draft remains a valid pinned pair

#### Scenario: Flat edit page with batch disclosure on Save & Sync
- **WHEN** the human opens an entry for editing and then invokes Save & Sync from the edit page
- **THEN** field controls with current values are visible on one entry page with direct access to the corresponding editors and no unrelated navigation, and the confirmation enumerates exactly the entries included in the current pending batch before any write

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

All changes SHALL remain drafts until the human confirms Save & Sync with a target file and change summary. Leaving or switching a dirty draft SHALL require confirming discard or staying; no-op saves SHALL make no writes. The commit path SHALL apply targeted JSONC changes preserving unrelated bytes, comments, unknown fields, encoding and newline style, validate the changed entry against the live recipe contract, and retain unrelated invalid entries with disclosed findings. An unparseable or unreadable document or ambiguous edit target SHALL block writing rather than being replaced. The commit itself is server-mediated: the server SHALL recheck actual scope, file identity, active server Forge state and original content under its commit lock before atomic replacement, with failure leaving the previous file intact. Only a server-issued, preview-bound commit token authorizes a write; no model-accessible recipe-writer is introduced and the TUI never writes the target file directly. After a successful save the editor SHALL continue on a fresh editOpen against the current bytes (a new edit-start snapshot); if that refresh fails the UI SHALL report saved + refresh failed, SHALL keep the saved receipt accessible, and SHALL NOT replay the previous commit — recovery is a fresh prepare or an explicit reload. The search query and current selection SHALL be preserved across save and refresh within the same scope; switching scope SHALL clear the query and selection instead of carrying the previous scope's context into the new one. The UX revisions do not relax the two-step save and sync confirmations, the server-mediated commit protocol, or any security binding; autosave remains forbidden.

#### Scenario: Save continues on a fresh editor state
- **WHEN** a Save & Sync succeeds and the editor re-opens the target fresh
- **THEN** the user stays in the editor on a new edit-start snapshot of current bytes with the saved result disclosed, and no old commit is replayed

#### Scenario: Refresh failure after a successful save
- **WHEN** the post-save fresh editOpen fails
- **THEN** the UI reports saved + refresh failed, the receipt stays accessible, no commit is replayed, and recovery is re-prepare or explicit reload

#### Scenario: Query and selection preserved across save and refresh
- **WHEN** the editor returns to the list after a save or a post-save refresh within the same scope
- **THEN** the search query and current selection are preserved as they were before the save

#### Scenario: Scope switch clears query and selection
- **WHEN** the human switches between workspace and global scopes
- **THEN** the search query and current selection are cleared for the new scope and no previous-scope context is applied to it

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
- **WHEN** the file bytes, destination identity or owning pool differ from the edit-start snapshot at server commit time
- **THEN** the save is refused as a conflict and offers reload rather than overwriting the newer contents

#### Scenario: Commit failure
- **WHEN** the server-side atomic write fails
- **THEN** the prior file stays intact, the human sees the failure, and synchronization is not started

### Requirement: Server-mediated commit protocol

Recipe writes SHALL follow a server-side prepare→preview→explicit-confirm→commit protocol over the official Plugin RPC. The edit-start snapshot is defined as the original bytes and full file identity the server reads exactly once, when the editor opens the target — issued to the client as a snapshot handle; the save prepare SHALL compute its canonical patch and preview hash against that handle, and the server SHALL NOT take a fresh read at prepare or commit time and present it as the original: if the current bytes or identity no longer match the handle, the operation is refused and the client must reload, so an external edit between form open and Save is never silently swallowed. The prepare step SHALL be pure read: it resolves the authoritative target (scope, sessionID or null, owning file, anchor/owner) and returns the preview without writing. The server SHALL issue a bounded, short-lived, single-use token binding the exact recipe target, scope and sessionID — where a null sessionID SHALL mean exactly the home scope of the server-observed location at prepare time (that location's home on this server plus the server's own global home), never a wildcard, with the observed location itself part of the binding — plus the authoritative anchor/owner, the edit-start snapshot's original bytes and full file identity, the canonical patch and preview hash, and the server epoch/registration generation. The token lifetime SHALL be a bounded implementation parameter returned to the client as `expiresAt`; an expired token SHALL be refused and requires a fresh prepare — expiry is never auto-renewed. A token SHALL be valid only within its server epoch/registration generation and SHALL authorize at most one write; the server has no client identity, so no claim is made that it can refuse a token "presented from another connection" — the only server-provable refusal surfaces are the epoch/generation, the single-use state, and the target/scope/location bindings. On the same server, a token prepared with a null sessionID under location A SHALL be refused when the target now resolves under location B, even when the global target path is identical. No persistent token or receipt store is required: receipts are in-memory and same-epoch, a missing receipt means UNKNOWN, and current bytes SHALL NOT be used to adjudicate an ambiguous old commit — bytes only feed a new prepare or a sync of current state. The server SHALL refuse any request that names an arbitrary absolute path, carries arbitrary write text, or is not covered by a valid unspent token. The confirmed commit SHALL run under the server's commit lock — one lock per actual target, shared across locations for the same global target — and re-verify, from the edit-start snapshot: unchanged bytes and file identity, still-valid ownership and a second check of the confirmed scope; multi-entry first creation SHALL commit with the create kind, and entries a validator rejects SHALL NOT be written and SHALL be listed in the receipt. With two prepares over the same original bytes, once the first commit succeeds the second token SHALL be refused as stale; a sync step that fails after a successful commit SHALL still consume the token rather than revive it. Where the server's authoritative known-anchor set cannot fully adjudicate a target, the dependent sync or change SHALL be refused rather than answered from a newly invented registry — registration location and the authoritative anchor set are adjudicated separately. Cancellation and no-op SHALL never write.

#### Scenario: Prepare is pure read and issues a bounded preview token
- **WHEN** the TUI submits a draft edit plan referencing the snapshot handle from editor open and the server resolves a legitimate recipe target
- **THEN** nothing is written, the returned preview binds target/scope/edit-start bytes/identity/patch-hash/epoch in a single-use short-lived token with a returned `expiresAt`, and the TUI can display the exact file, scope and diff

#### Scenario: Expired tokens are refused until a fresh prepare
- **WHEN** a client presents a preview token after its returned `expiresAt` has passed
- **THEN** the server refuses the operation with no write, nothing auto-renews the token, and the client must run a new prepare (against current bytes) and re-confirm

#### Scenario: External edits between form open and Save are not swallowed
- **WHEN** the file bytes or identity change after the editor opened its target (snapshot handle issued) but before the human clicks Save, so the prepare or commit no longer matches the edit-start snapshot
- **THEN** the server refuses the save with no write and offers reload — no fresh read at save time is substituted for the edit-start snapshot

#### Scenario: Confirmed commit re-verifies and atomically publishes on the server
- **WHEN** the human explicitly confirms a previewed save and the server executes the commit under its lock
- **THEN** the server re-checks the edit-start snapshot, ownership and confirmed scope, writes atomically only the validated entries, and returns a receipt of saved bytes/identity and per-entry outcomes

#### Scenario: Server refuses arbitrary paths and write text
- **WHEN** a request names a path the server did not authoritatively resolve, or carries write content not bound by a valid unspent preview token
- **THEN** the server refuses the operation with no write

#### Scenario: Home scope binds the server-observed location, not a wildcard
- **WHEN** a token was prepared with a null sessionID while the server-observed location was A, and the target now resolves under location B on the same server — even with an identical global target path — or the server restarted or its registration generation changed
- **THEN** the old token is refused with no write; a null sessionID always meant exactly location A's home scope on that server, never any location

#### Scenario: Competing prepares serialize per actual target
- **WHEN** two clients prepare over the same original bytes and the first commit succeeds, or two commits race on the same global target reached from different locations
- **THEN** the second stale token is refused as a conflict and the commits serialize on one shared per-target lock; at most one write happens per token, and a failed sync after commit still leaves the token consumed

#### Scenario: Ambiguous commit outcome resolves by receipt, never replay
- **WHEN** a commit outcome is uncertain (lost response, crossed restart) — the same-epoch in-memory receipt, where it exists, can confirm the outcome; without it the state is UNKNOWN, and current bytes matching the patch do not prove whether this commit wrote or not
- **THEN** the client never blindly replays the commit; it resolves by the receipt where available, otherwise re-prepares against current content and re-confirms or syncs current state — without replaying the old commit; no cross-epoch exactly-once guarantee

### Requirement: Epoch invalidation and preview invalidation limits

Server-side token invalidation SHALL be claimed only where the server can prove it: after a server restart or a change of the RPC registration generation, every previously issued token SHALL be refused, and no persistent token/receipt store survives — a receipt missing after such an event leaves the outcome UNKNOWN (no cross-epoch exactly-once promise). The server SHALL NOT claim that a network disconnect alone voids in-memory tokens (it has no client identity and cannot detect arbitrary transport reconnects); the honest residual is stated: API clients holding a valid unspent token can commit within the same epoch. The TUI SHALL enforce the client-side editor-session discipline: on detecting a disconnect or an observable epoch/registration change, it SHALL drop all in-flight tokens and open a fresh editor session requiring a new prepare, a freshly displayed preview and explicit human confirmation again. Because default per-boot server authentication rotates and the old session cannot recover (probe-proven 401 retry storm with no reconnect event), the design SHALL NOT claim lossless reconnection; the UI SHALL disclose the broken connection and the re-confirmation requirement.

#### Scenario: Restarted or re-authenticated server rejects old previews
- **WHEN** the server restarted or its RPC registration generation changed and a client presents a preview token issued before that event
- **THEN** the commit is refused with no write and the refusal is disclosed

#### Scenario: Reconnected session re-reads and re-confirms
- **WHEN** a client reconnects after a disconnect, restart or auth loss and wants the same change
- **THEN** it re-reads the current recipe state, prepares a new snapshot and preview, and write happens only after the human confirms the fresh preview

### Requirement: RPC transport trust boundary

The RPC methods used for this capability SHALL NOT be registered as model tools and SHALL NOT appear in any tool surface. The system SHALL state, in design, README and UI disclosure, that an RPC method registration is not proof of a human caller: any client holding the server's API authentication can invoke the methods directly — including preparing and committing without any human in the loop — and there is no caller-human attestation. The server-side guarantees are limited to writes bounded to server-resolved recipe targets, covered by server-issued prepared tokens (exact content bound by preview hash), single-use, valid only within the server epoch/registration generation, and receipted within that same epoch; displaying the preview and obtaining human confirmation is the TUI's responsibility, not a server-side guarantee. The capability SHALL NOT be claimed to prevent an authorized process from calling the API itself. The human TUI SHALL remain the normal, only surfaced save entry, with no AI-callable save tool exposed.

#### Scenario: RPC registration exposes no model tool
- **WHEN** the server registers the forge-config RPC definition
- **THEN** no tool is added to any model-facing tool surface, and the host plugin/tool inventories show no new tool from the registration

#### Scenario: Direct API callers are not proven human
- **WHEN** a process holding the server's API auth invokes the RPC methods directly, bypassing the TUI, it can prepare and commit without any human
- **THEN** its writes are still bounded to server-resolved targets and server-issued single-use epoch-bound tokens, commits are receipted within the same epoch, and no claim of human verification or caller blocking is made

#### Scenario: Unprovable RPC transport disables writes
- **WHEN** the RPC transport cannot be proven (echo/definition registration failures, version mismatch, unavailable methods)
- **THEN** the TUI performs zero writes and zero syncs and discloses the unprovable transport

### Requirement: Remote write scope disclosure (approval-pending change)

When the approved contract enables saves toward a connected server, an explicitly confirmed save SHALL write the connected server's filesystem — including a remote server the TUI is attached to — and SHALL NOT silently expand scope: the UI SHALL disclose before confirmation that the write goes to the connected server's filesystem, show the target scope, the exact server-side path, and the server-issued target identity. Acceptance of such connections SHALL rest on the server's authoritative ownership resolution and the preview binding of this capability, not on same-machine proof; a connection the server cannot authoritatively resolve stays read-only/unavailable. This requirement takes effect only upon explicit user approval of the revised proposal and is null and void before that approval. Approval record (2026-11-27): the user explicitly approved the revised proposal, including this remote-write scope behavior design, and issued the apply instruction ("continue") — this requirement is effective as of that approval. The requirement title above is retained verbatim for archive matching; the approval-pending state it names is resolved by this record.

#### Scenario: Remote-attached save writes the connected server filesystem
- **WHEN** a human confirms a save while the TUI is attached to a remote server whose Forge plugin authoritatively resolves the target
- **THEN** the write lands on the connected server's filesystem at the disclosed path, and the UI has shown that the target is the connected server, not a local file

#### Scenario: Server-issued target identity shown before confirmation
- **WHEN** a preview is displayed for a save toward the connected server
- **THEN** the preview names the scope, exact server-side path and server-issued target identity, and confirmation is impossible before that disclosure

### Requirement: Deterministic synchronization and application status

A successful changed-recipe Save & Sync SHALL invoke the existing native roster compilation semantics for the selected family — executed server-side through the RPC sync path — without a model turn, including its applicable global overrides, atomic generated writes, safe garbage collection and hand-written agent protection. It SHALL NOT rewrite unrelated families merely because they are known to the host. Recipe persistence and native projection/application outcomes SHALL be independently reported. Applied status SHALL require host confirmation of the actually changed observable registration fields (prompt, permission, variant where applicable) or of the exact removed ID — an unchanged existing ID or an unobserved change SHALL be reported as unconfirmed, never applied. Before syncing, the server SHALL fix the selected family identity with full before-and-after resolution; if coverage is unknown or the target's owning family moved, sync SHALL be refused rather than guessed. If sync or host confirmation fails, the editor SHALL retain the saved recipe, disclose the failure or unknown status and offer an explicit independent retry that re-reads the current recipe, re-resolves scope and re-prepares from current content; retry SHALL recheck server enablement and target ownership and SHALL NOT overwrite newer recipe changes and SHALL NOT replay a previously saved patch. Running children SHALL retain existing host and Forge semantics: Auto inheritance binds at dispatch, depth resolution freezes per session, and the existing request-time model pin hot-applies; the editor SHALL NOT interrupt or restart children. Existing server sync and opt-in auto sync remain available unchanged. If the edit changes cross-family collision winners or otherwise requires writing an unrelated family to reconcile the host registry, the editor SHALL disclose the conflict and SHALL NOT report applied; it SHALL offer the existing explicit host-wide sync recovery separately.

#### Scenario: Save then verify native registration
- **WHEN** a human confirms creation, modification or removal of a valid worker or override and native sync succeeds
- **THEN** the corresponding native projection is updated using the existing compiler, and the UI reports applied only after the actually changed registration fields or exact removed ID are host-confirmed

#### Scenario: Sync failure after successful save
- **WHEN** the recipe persists but compilation, generated write or host confirmation fails
- **THEN** the UI distinguishes saved from sync failed or application unconfirmed and offers an independent retry that re-reads current recipe content and re-confirms scope instead of replaying the old patch

#### Scenario: Preserve manual agents and other families
- **WHEN** an edited family has a conflicting hand-written agent or another known family has unrelated generated agents
- **THEN** existing no-clobber behavior is honored and unrelated families are not changed by the TUI sync

#### Scenario: Cross-family collision requires broader reconciliation
- **WHEN** an edit changes a collision winner and reconciling the native projection would require modifying another family
- **THEN** the TUI leaves the unrelated family untouched, reports application unconfirmed with the conflict and identifies the explicit host-wide sync recovery

#### Scenario: Existing child follows the current runtime contract
- **WHEN** a worker's configuration is saved while an already-dispatched child is running
- **THEN** the editor does not interrupt or restart it; Auto inheritance, frozen depth and request-time pinned model hot-apply remain governed by the existing runtime requirements

### Requirement: Accessible layout and concise presentation

The editor SHALL present an accessible layout on both large and narrow terminals: every field and action SHALL be keyboard-reachable, narrow terminals SHALL get a compact arrangement, titles SHALL stay short, and fields SHALL be layered (identity and mode primary, secondary fields beneath). List rows SHALL NOT place long identities — such as the full model string — into the title line; long values belong in the description or detail position.

#### Scenario: Large-terminal layout
- **WHEN** the editor renders on a large terminal
- **THEN** fields are arranged in layers under short titles and remain fully keyboard-operable

#### Scenario: Narrow-terminal accessibility
- **WHEN** the terminal cannot fit the full layout
- **THEN** the compact arrangement keeps every field and action reachable without degrading titles into unusable forms

#### Scenario: Titles stay short
- **WHEN** an entry carries a long model identity or prompt
- **THEN** the title line stays short and the full value is available in the detail or description position

### Requirement: Compact feedback with on-demand detail

Toasts SHALL be short summaries (counts and risk flags), never full receipt listings, and SHALL NOT stack into long sequences. The full receipt — of any number of entries — SHALL be viewable on demand, paginated for large batches, with per-entry identity, action and outcome. Sync confirmation SHALL list the changed entries first together with an unchanged count. Failures, unconfirmed applications and conflicts SHALL appear in both the short form and the detail view — brevity SHALL NOT hide risk.

#### Scenario: Short toast, full detail on demand
- **WHEN** a save or sync completes with any number of entry outcomes
- **THEN** the toast stays short with counts plus risk flags and the complete per-entry receipt is viewable on demand

#### Scenario: Large receipt stays fully accessible
- **WHEN** a receipt contains more entries than fit one page
- **THEN** the detail view paginates through every entry without loss

#### Scenario: Sync confirmation leads with changes
- **WHEN** the human confirms a sync whose family also contains unchanged entries
- **THEN** the confirmation lists the changed entries first and shows the unchanged count, without hiding failures or unconfirmed items

#### Scenario: Risks stay visible
- **WHEN** a save or sync produces failures, unconfirmed applications or conflicts
- **THEN** the short toast carries the risk flags and the detail view names each affected entry
