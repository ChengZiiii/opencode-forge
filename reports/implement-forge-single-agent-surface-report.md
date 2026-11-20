# implement-forge-single-agent-surface — report

Status: **EDITS COMPLETE, VERIFICATION BLOCKED** — the mandated exec
surface (`forge_shell`) started returning a bare `Tool.Error` for every
invocation partway through this task (evidence below), so `bun run
typecheck`, `node --test`, `bun run bundle`, and the git commits could
NOT be executed. Nothing has been committed; the working tree carries
all edits below. Re-run the verification loop and commit per the plan in
"Commit plan" once the exec surface is back.

## Tool refusal (verbatim, per contract)

Every forge_shell call after the first two returns:

```
REFUSED: Error: Tool.Error
```

(bare, no message; reproduced 8×, including `echo` with default params
and `run_in_background: true`.) The very first call of the session also
surfaced the underlying cause:

```
spawn error: ENOENT: no such file or directory, uv_spawn
'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
```

i.e. the host-preferred shell binary is missing and the fallback is not
engaging — an infrastructure failure of the exec surface, not a
permission denial of the commands themselves. The builtin `shell` tool
is partition-refused for this agent family by design
("[forge:partition] Builtin shell refused ... Re-issue the command
through forge_shell.") and was NOT worked around, per the mandates.

Two forge_shell calls DID succeed early (git status/log: clean tree,
HEAD `55b6b13`), proving the setup, then the surface died.

## Changed files (working tree, uncommitted)

1. `plugin.ts`
   - `V2AgentDraft` type: added optional `default?(id: string): void`
     (D5 seam, ~L5635).
   - New v2-only primitives above `v2Setup` (~L6591ff):
     `V2_SHELL_DENY`, `v2WithShellDeny` (idempotent array append),
     `v2PermissionArray` (v1 permission record → v2
     `{action,resource,effect}` array + shell deny),
     `v2ReadHideNatives` (global forge.json layer, JSONC read-only,
     only explicit `false` disables, fail-soft default true).
   - v2Setup agent transform:
     - **D4 primary**: unconditional idempotent
       `agent.permissions = v2WithShellDeny(agent.permissions)` on the
       `forge` record (user-owned entries keep every other field —
       tools-merge parity).
     - **D1/D2 native suppression**: guarded hide-only
       `draft.update("build"|"plan", r => r.hidden = true)`; skip when
       record absent or already `hidden:true`; per-record try/catch
       with finding; gated by `v2ReadHideNatives(deps)`; never touches
       any other field; v1 path untouched.
     - **Field-name fix (D4)**: worker materialization now writes
       `agentDraft.permissions = v2PermissionArray(v1def.permission)`
       — the old `agentDraft.permission = v1def.permission` (singular
       record) was a wrong field name on the v2 domain (records carry a
       `permissions` ARRAY), so the readonly seal / task:deny / shell
       deny now actually reach the host.
     - **D5 default**: `try { if (typeof draft.default === "function")
       draft.default(FORGE_AGENT) } catch {}` at the end of the
       transform — standalone revert-ready slice per the dispatch.
   - Never denies action `"execute"`; no writes to user opencode config
     anywhere (D0); v1 `server()` path not modified.
2. `tests/v2-setup.test.mjs`
   - `makeCtx` now records `update`/`default` calls and supports
     `noDefault` / `throwDefault` shapes.
   - Subagent test updated to the `permissions` array reality (task:deny
     entry present, no singular `permission` key).
   - New tests (matrix, all under an isolated
     `FORGE_TEST_FORGE_HOME`): hides build/plan hide-only with
     general/explore untouched; absent records skipped/never created;
     already-hidden record left untouched; one record throwing doesn't
     block the sibling; `hideNativeAgents:false` global-layer opt-out;
     broken global layer keeps default-on; primary+worker (write AND
     readonly shape) records carry the shell deny and never an execute
     deny; readonly seal lands in the array; user-defined forge entry
     keeps fields but gains the deny; default called with "forge" under
     guard; missing default setter skipped; throwing default setter
     never escapes.
3. `README.md` — new "v2 single-agent surface" section (hide/default/
   shell-deny, zero-pollution statement, `hideNativeAgents` knob in the
   GLOBAL forge.json layer) + "v1-host config recipe"
   (`agent.build.hidden` / `agent.plan.hidden` / `default_agent`).
4. `openspec/changes/v2-single-agent-surface/tasks.md` — 2.1/2.2/2.4
   checked (2.2 notes the field-name fix); 2.3 annotated
   implemented-but-gated on probe 1.2 (revert-ready commit).

## tasks.md status

- 1.1 static leg: done previously; live leg + 1.2 + 1.3 probes: NOT RUN
  (exec surface down).
- 2.1 ✅ (code complete) · 2.2 ✅ (code complete, incl. permissions-array
  fix) · 2.3 code complete, checkbox intentionally left open pending
  probe 1.2 (D5 revert clause) · 2.4 ✅.
- 3.1 test matrix written ✅ (NOT yet executed) · 3.2 BLOCKED (no shell).
- 4.x BLOCKED (no shell; no bundle, no commits, no push).

## Test names added (tests/v2-setup.test.mjs)

- v2 setup: hides native build/plan primaries (hide-only, other fields
  and non-natives untouched)
- v2 setup: absent native records are skipped, never created
- v2 setup: an already-hidden native record is left untouched
- v2 setup: one native record throwing never blocks the other
  (per-record fail-soft)
- v2 setup: hideNativeAgents:false in the GLOBAL forge.json leaves
  natives untouched
- v2 setup: an unreadable global layer keeps the default (hide on)
- v2 setup: primary + worker records carry the shell-deny front door
  (never execute)
- v2 setup: a user-defined forge entry keeps its fields but gains the
  shell deny
- v2 setup: default setter called with forge under the typeof guard
- v2 setup: no default setter on the draft → silently skipped
- v2 setup: a throwing default setter never escapes
- (modified) v2 setup: registers forge subagents … — permissions-array
  assertions replace the singular `permission.task` one.

## Commit plan (NOT executed — exec surface down)

1. `plugin: v2 single-agent surface — native suppression, hideNativeAgents knob, shell-deny front door (permissions array fix)` — plugin.ts (everything except the D5 default block) + tasks.md.
2. `tests: v2-setup matrix — suppression, knob, shell deny, permissions array` — tests/v2-setup.test.mjs.
3. `plugin: v2 default subject to forge (D5, ordering-gated, revert-ready)` — the D5 block only.
4. `docs: README v2 single-agent surface + v1 config recipe` — README.md.
5. `chore: rebuild dist (v2-single-agent-surface)` — after `bun run bundle` (dist committed).

No `git push` (gate waves own the push).
