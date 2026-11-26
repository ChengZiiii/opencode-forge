## Why

Forge 0.35.0 now dispatches native OpenCode V2 workers, but configuring them still requires hand-editing JSONC, finding model identities and reasoning levels, and synchronizing the native projection. Bring the configuration experience into the host TUI, borrowing OpenChamber's entity editor and catalog-driven selection without creating a second configuration system.

## What Changes

- Add a native TUI command-palette entry and `/forge-config` UI-only shortcut, usable from home and session views without sending a model prompt.
- Browse, search, create, edit and confirm deletion of workspace/global workers; edit or remove global `general`/`explore` overrides independently. Show the effective pool, source file and native identity.
- Edit existing recipe fields with host-driven model and reasoning choices, explicit Auto/Pinned mode, role prompt, shape and permission. Preserve unknown existing values and unrelated JSONC content.
- Add explicit Save & Sync with change preview, conflict detection, atomic recipe writes, existing native roster compilation and separately verified application status. No lifecycle or model-triggered recipe writes, autosave, independent registry or direct editing of generated agent files.
- Keep existing server commands, dispatch gates and Plan/Crew/Goal unchanged; no new recipe fields, direct rename or general OpenCode config editor.

## Capabilities

### New Capabilities

- `forge-tui-subagent-config`: native TUI navigation, scope-aware forms, host model choices, explicit safe recipe changes and deterministic synchronization.

### Modified Capabilities

- `forge-subagents`: narrow exception to read-only recipe ownership for explicit human TUI saves; explicit TUI synchronization alongside existing in-band sync and auto opt-in.
- `command-surface`: distinguish the existing single server `/forge` family from the new UI-only `/forge-config` entry without restoring retired server commands.

## Impact

- New TUI entry/module and pure recipe editing core, existing `src/forge-config.ts` pool resolver/validation and `src/roster-compile.ts`/`plugin.ts` synchronization chain; package exports, bundle, tests and README.
- **Depends on:** archived `retire-plugin-runtime` (Forge 0.35.0 / OpenCode V2). Historical incomplete probe tasks are not presumed verified; this change requires fresh applicable host evidence.
- Native V2 TUI API, model catalog and same-host filesystem/sync boundaries must be probed on the actual CLI before coding. Remote or uncertain ownership is read-only/unavailable in this release.
- Same Forge package, separate host server and TUI entry points. No real main-config change, publication or archive authorization follows merely from proposal approval.
