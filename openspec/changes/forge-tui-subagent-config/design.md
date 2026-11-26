## Context

The archived `retire-plugin-runtime` change and Forge 0.35.0 are the code baseline. `src/forge-config.ts` has the exclusive `createPoolResolver`, shared upward discovery and fail-soft validators; the older `createForgeConfigLoader` still merges and is not the authoritative pool resolver. `src/roster-compile.ts` owns the native projection and no-clobber planning; `plugin.ts` wires `runRosterSync` and `forgeSyncTool`. The server package currently has only its root and schema exports.

OpenChamber's [Agents settings](https://github.com/openchamber/openchamber/tree/main/packages/ui/src/components/sections/agents) and [SettingsView](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/components/views/SettingsView.tsx) provide precedents for directory-scoped entity lists, catalog-driven model selection and save feedback. Forge adopts those interaction ideas, not its Web implementation, storage or autosave behavior. The [OpenCode V2 CLI plugin API](https://opencode.ai/docs/build/plugins/cli/) documents `context.keymap.layer`, native dialogs and custom UI. Installed CLI package metadata reports 2.4.2, but the workspace's older `@opencode-ai/plugin` types do not prove the documented `@opencode/plugin` TUI surface works on that version. No actual TUI load or target-model catalog call has yet been verified.

## Goals / Non-Goals

**Goals:** a human-only, host-native configuration entry sharing the existing recipe ownership, validation, compiler and host registration contract; deterministic tests plus real TUI proof.

**Non-Goals:** model-visible recipe editing APIs, a second registry/configuration file, a new dispatch engine, changes to harness behavior, arbitrary host config editing, remote writes without a proven ownership boundary, direct rename or new recipe fields.

## Decisions

### D1 — Native TUI entry, separate from server

Expose the existing `/forge` server family unchanged and register the `Forge: Configure subagents` palette entry and `/forge-config` only in the TUI. Prefer native searchable selections, dialogs, theme and keyboard behavior; use a compact list/detail presentation with vertical fallback. A separate `./tui` export in the same npm package is the intended packaging boundary, subject to actual host loading proof. Avoid a custom renderer or additional installation source. Probe the native TUI API and package resolution in an isolated host before choosing TS/TSX or SDK dependency versions. If native entry cannot load, do not break server setup or fake a server command as replacement.

### D2 — One recipe authority and host-bound target

Use `createPoolResolver`, `discoverProjectFileWith`, `forgeConfigPaths`, `parseForgeJsonc`, `validateAgentSet`, and `validateOverrideNode`; reuse session anchor resolution in `plugin.ts` or extract a shared pure interface, not a second precedence algorithm. The editor's target contains observed host identity, effective worktree, scope, exact owning recipe path and namespace. Global and workspace views remain separate; global overrides remain global. A missing project recipe may be created only at a verified workspace root, with a valid declared pool and explicit fallback warning. Never infer the anchor from TUI cwd. Missing global recipe creation similarly requires human confirmation of the exact global path and machine-wide scope; do not activate unselected overrides. Revalidate ownership and active server Forge state before commit or sync; disabled, absent or unverifiable server Forge prohibits writing and syncing; unsupported remote/unknown ownership disables writes. Prove host-to-TUI context and path ownership, including resumed/multiple workspaces, before enabling writes.

### D3 — Catalog and draft isolation

Use observed host provider/model availability and per-target model metadata; the documented current conversation `variant.list/set` is not evidence of arbitrary target variants and must not be used to change conversation selection. A narrow adapter normalizes observed catalog fields into searchable identities and level evidence. Missing metadata is unknown, not an empty authoritative list; use existing Forge depth semantics for explicit custom values. Auto/Pinned is a draft-level atomic pair, and changing model invalidates unsupported level selections until confirmed. Preserve raw unknown values in unchanged fields. Model/level and permission edits are checked by existing validators and materialization semantics. Do not introduce a registry or fallback list claiming availability. Test empty, delayed, disconnected and stale catalog states.

### D4 — User-confirmed, conflict-aware JSONC commit

Build a pure injectable core in `src/forge-config-edit.ts` for snapshot, edit plan, validation and commit result; UI adapters live in `src/tui/`. Keep raw bytes and parsed locations, target only selected keys and distinguish absent from unreadable. Choose a JSONC-aware edit implementation after checking comment/encoding preservation; never serialize the whole parsed object. Validate only changed entries and structural constraints so existing semantic findings do not erase siblings; refuse syntactically broken documents, duplicate/ambiguous edit locations and new ID normalization collisions. Existing ID is immutable in the form. Display exact file and diff before explicit Save & Sync, confirm discards/deletion, no-op is zero writes. Re-read original bytes, target file identity and pool ownership immediately before replacement; serialize cooperating saves, reject stale snapshots and unsafe file targets, use same-directory temporary file and atomic replace, clean up owned temporary files on failure. Do not claim immunity to arbitrary non-cooperating external races; test conflict detection and failure boundary and document filesystem limits. No model-callable recipe-write tool, lifecycle write, autosave or main config rewrite.

### D5 — Shared compiler and independent save/application receipt

Reuse `planRosterSync`, `executeRosterSync` and existing `runRosterSync` semantics via a narrow family-scoped adapter or extracted shared orchestration, not separate compilation logic. Probe the officially supported deterministic TUI-to-host synchronization path, including registration observation; if none exists, stop and seek a design revision rather than add an undocumented endpoint, request a model turn or declare an unobserved apply successful. The host-wide resolver remains necessary for collision/ownership adjudication, but the TUI operation writes/GCs only the selected family's generated projection (global includes global overrides). Preserve hand-written files and existing server sync/auto behavior. Confirm recipe persistence separately from compilation and observed host registration; on partial failure or unknown registration keep recipe and display retry against fresh content. If collision winners or another family projection would need reconciliation, report the conflict and application unconfirmed; do not write that other family, offer existing explicit host-wide sync recovery separately. No rollback of a saved recipe merely because host refresh is delayed; do not interrupt or restart running children. Preserve Auto dispatch inheritance, per-session depth freeze and existing fresh-per-request model pin (not a new full child snapshot). Test partial sync, no-clobber, collision changes and unrelated families.

### D6 — Acceptance requires actual host proof

Run local isolated probes before implementation; capture host and SDK version, package export load, menu entry, dialog/keyboard, target model metadata, worktree/source identity, same-host ownership, sync/refresh and no-model-turn proof. Distinguish documented API from observed behavior. If a required capability is absent, amend the OpenSpec with owner review before implementing a different user contract. Keep pure tests with injected files/host adapters and real TUI tests deterministic wherever possible. The two release gates remain applicable; no inferred pass. Historical unchecked migration tasks are a source of caution, not this change's proof.

## Risks / Trade-offs

- TUI SDK drift → bind only probe-proven public interfaces; separate entry so server remains loadable.
- Global fallback surprises and stale scope → explicit source, current effective scope, create warning, authoritative resolution and commit recheck.
- Concurrent editors or malformed JSONC → refuse stale or ambiguous writes, preserve unrelated bytes and show findings.
- Model metadata gaps → show unknown/unverified state rather than guessed variants; preserve existing custom values.
- Saved recipe but stale native registry → separate receipt and deterministic retry; keep existing dispatch staleness gate.
- Narrow terminal → native compact keyboard-driven list/detail layout; verify in real TUI.

## Migration Plan

No migration of existing recipes or generated data. Publish the same package with both entry points only after local gate passes and explicit release authorization. Verify the supported CLI-only entry enablement and official installation; never automatically edit the user's main config, and avoid duplicate source loads. Disabling/removing the TUI entry leaves recipe and existing server behavior intact; previous server-only builds can continue reading the unchanged recipe schema. Update the main forge-subagents descriptive Purpose to reflect the narrow human-save exception at the authorized archive step, not in advance of delta approval.
