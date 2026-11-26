## 1. Probe the actual host before implementation

- [ ] 1.1 In the isolated sandbox, capture CLI/SDK versions and prove same-package TUI entry load, palette and slash registration, home/session dialog navigation, keyboard and narrow layout; record actual output, not document assumptions.
- [ ] 1.2 Probe supported provider/model availability and target-model variant metadata including unavailable states; verify configuration selection does not change the conversation model or send a model request.
- [ ] 1.3 Probe authoritative worktree and host identity for home, session, resumed and multiple workspace contexts; prove same-host filesystem ownership and refusal when unknown/remote; probe disabled, absent and unverifiable server Forge while TUI is loaded and confirm zero writes/sync.
- [ ] 1.4 Probe deterministic family-scoped sync invocation and native registration observation (create/update/remove/override), without model turns; capture public API evidence. If required capability is absent, stop for owner-reviewed contract revision before implementing alternatives.

## 2. Shared recipe editing core

- [ ] 2.1 Build injectable scope/target adapter reusing the exclusive pool resolver and authoritative anchors; test workspace/global/ancestor ownership, absent recipe, source namespace, no guessed path, resumed and multi-workspace cases.
- [ ] 2.2 Implement raw snapshot and targeted JSONC edit planning for worker and global override fields, creation/removal, Auto/Pinned and normalized ID collision checks; test preservation of comments, unknown keys, unrelated invalid entries, non-ASCII bytes and newline style, plus broken/ambiguous input refusal.
- [ ] 2.3 Implement owner-confirmed commit boundary, conflict/identity/ownership recheck, cooperating-save serialization and atomic write; test unchanged/cancelled writes, competing saves, changed target and write failure leaving prior bytes intact.
- [ ] 2.4 Implement host catalog adapter and draft model/level validation; test delayed/unavailable catalog, stale identity, model change, explicit unverified level and no active-model mutation.

## 3. Native TUI and synchronization

- [ ] 3.1 Register the probe-proven native menu and `/forge-config` TUI entry independently from server setup; test home/session, no prompt, no user command clobber, missing API disclosure, `/api/command` excluding plugin-owned forge-config, and lifecycle/non-confirmed zero writes.
- [ ] 3.2 Implement scope-aware searchable list and detail editor for new/existing workers and global overrides, exact file, effective roster, native identity and findings; test navigation and narrow terminal behavior.
- [ ] 3.3 Wire editing and explicit Save & Sync preview, deletion/reset confirmation, new pool fallback warning, missing global recipe confirmation and unsaved-change guard; test switching scope/selection, cancelling, no-op and invalid form behavior.
- [ ] 3.4 Extract/reuse family-scoped synchronization from existing roster compiler and connect it through the probe-proven deterministic host interface; verify current recipe content, manual files protected, collision adjudication, cross-family winner changes reported unconfirmed with separate host-wide recovery, and unrelated families untouched.
- [ ] 3.5 Expose separate saved/compiled/applied or failed/unconfirmed results and retry current content; test partial failures and verify no restart or interruption of already-dispatched children and preservation of Auto inheritance, frozen depth and fresh-per-request model pin.
- [ ] 3.6 Add same-package TUI export/build and document official enable/disable, scope, edit fields, save and retry behavior in README; verify both entry points in packed artifact without introducing a second installation source.

## 4. Local gate and evidence

- [ ] 4.1 Run `bun run typecheck`, `bun run test`, `bun run bundle`, `npm pack --dry-run`; record exact results and ensure the dist/README/package.json whitelist and independently loadable server/TUI output.
- [ ] 4.2 Run actual isolated TUI E2E: new workspace pool replacing global fallback, worker creation/pin/Auto/edit/delete, first global recipe creation, global override edit/reset, actual host registry changed-field/removal observations, no model turn and no unrelated changes; verify keyboard and narrow terminal, manual agents and failure/retry.
- [ ] 4.3 Verify regression of existing server commands and Plan/Crew/Goal/dispatch gates in the actual host per sandbox gate; document any unobservable legs with D6 reason and exact rerun method, not a substituted unit-test pass.

## 5. Official delivery and closure (owner gated)

- [ ] 5.1 After explicit release authorization, execute npm release and official package installation, record shasum/dist-tags, loaded server/TUI versions and deterministic smoke results according to workspace delivery gate; do not modify real main config without separate authorization.
- [ ] 5.2 Obtain user restart/real TUI acceptance at the delivered version; reconcile D6 obligations and record evidence, archive temporary probes/drivers per workspace rules.
- [ ] 5.3 Prepare final review and status/validation evidence for explicit archive authorization; at authorized archive reconcile main forge-subagents Purpose with the human-save exception and verify archived scenarios. Push only with separate explicit authorization.
