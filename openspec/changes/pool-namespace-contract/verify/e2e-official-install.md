# E2E verify note — official install (git+file) + pool-namespace behavior + README four-step uninstall

- Date: 2026-10-30 (local 15:47–16:05)
- Change: `pool-namespace-contract` (tasks.md item 5.2, repo AGENTS.md 终验纪律)
- Repo: `C:\Users\Soren\Desktop\AgentWorkCommon\opencode_plugin_dev\opencode-forge`, HEAD `9d7c7fe025f912e83779f9bdfdda442dd4d58147`, package version **0.18.0**
- Host/platform: Windows 10 (win32), PowerShell 5.1 host, node v24.14.0, opencode CLI **1.18.34**
- Discipline: deterministic only — zero model calls. Roster probes via the `opencode serve` HTTP API (`GET /config?directory=<ws>`); the crew compliance gate driven by executing the **installed dist's** `crew_begin` tool surface from a node driver (the serve HTTP surface has no tool-invocation route — `/doc` lists only `message`/`command`, which are model turns).

## Step 1 — Official install: PASS

Command:

```
opencode plugin "git+file:///C:/Users/Soren/Desktop/AgentWorkCommon/opencode_plugin_dev/opencode-forge" --global
```

Observed (exit code 0): `Plugin package ready` → `Plugin config updated` → `Added to C:\Users\Soren\.config\opencode\opencode.jsonc` → `Installed git+file:///...` → `Scope: global (C:\Users\Soren\.config\opencode)` → `Done`.

Resolved artifact: `~/.cache/opencode/packages/git+file_\C_\Users\Soren\Desktop\AgentWorkCommon\opencode_plugin_dev\opencode-forge/node_modules/@sorenllm/opencode-forge/package.json` → `name=@sorenllm/opencode-forge version=0.18.0`. Installed `dist/index.js` git-blob `aff03013e0ab0c707145805ead1241892e7dc4b5` — identical to `git rev-parse HEAD:dist/index.js` (byte-level SHA256 differs only via the installer's CRLF checkout; git-blob comparison proves content identity with commit `9d7c7fe`).

Installer-discipline strip (executed immediately after install): the installer rewrote the real config's `plugin` array from `"npm:@sorenllm/opencode-forge"` to two entries (npm + git+file). The git+file entry was surgically removed; the real `~/.config/opencode/opencode.jsonc` restored **byte-identical** — SHA256 before `5656FA484569AD202790084F13C9BF10F8EE91A763D839B819957A60A318842D`, SHA256 after strip identical, `fc /b`: `no differences encountered`.

## Step 2 — Sandbox host

Temp layout under `<workspace>/.tmp/poolns-e2e/`: `xdgconfig/opencode/opencode.json` (plugin array = the git+file entry, pattern per `scripts/sandbox-e2e-setup.mjs`), `forgehome/.config/opencode/forge.json` (global fallback layer; reached via `FORGE_TEST_FORGE_HOME`), workspaces `wsA` (forge.json `{"pool":"e2e","agents":{"scout":…}}`), `wsB` (forge.json agents-only, no `pool`), `wsC` (no forge.json). Host: `opencode serve --port 40520` as a background job.

**Honest deviation / environment finding**: with `OPENCODE_CONFIG_DIR` alone, opencode 1.18.34 **merges** the real user config into the sandbox (`/config` showed the real `skills` block and `vision-agent`, and the user's npm 0.17.0 plugin instance co-loaded, visible as 0.17.0-era plain-id materialization — e.g. plain `forge-scout` appeared when the host launched from wsA). Isolation was achieved by redirecting `XDG_CONFIG_HOME` (+ `OPENCODE_CONFIG_DIR`, `XDG_DATA_HOME`) to the sandbox; after that `/config` showed no real-config keys and every materialized id was 0.18.0-namespaced. The crew-compliance assertions below were driven against the installed 0.18.0 dist directly, unaffected by this host quirk.

## Step 3 — Behavior assertions

### (a) `pool: "e2e"` workspace pool materializes namespaced — PASS

`GET /config?directory=<wsA>` on the hermetic host returned agent keys `forge`, `forge-e2e-scout`, `forge-global-reviewer`; **plain `forge-scout` absent** (`PLAIN forge-scout present: False`). Description carries the 0.18.0 provenance contract:

> `forge subagent "e2e-scout" (readonly, pinned glm-coding-worker/glm-5.3) — dispatch via the task tool with subagent_type "forge-e2e-scout". Pool 'e2e' — origin c:\...\.tmp\poolns-e2e\wsa\.opencode\forge.json; dispatchable only from sessions whose workspace pool is this file.`

### (b) pool-less forge.json → directory-derived ns + crew_begin REFUSED — PASS (two parts)

Roster: `GET /config?directory=<wsB>` returned `forge-wsb-research` — the family materialized under the **directory-derived ns `wsb`** (no `pool` field), description `Pool 'wsb' — origin …wsb\.opencode\forge.json`.

crew_begin (node driver against the installed dist, context `worktree=wsB`, session `e2e_probe_b`): **refused**, verbatim:

> `[forge:crew] Pool compliance refused: this session's workspace pool file (C:/…/.tmp/poolns-e2e/wsB/.opencode/forge.json) is non-compliant — missing top-level pool field — declare "pool": "<namespace>" ([a-z0-9-], 1-24 chars) to make this file crew-compliant. Minimal fix: add or repair the top-level "pool": "wsb" field (a [a-z0-9-] string, 1-24 chars — REQUIRED for crew-governed dispatch). The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`

All four required elements present: names the file ✓, the missing-field violation ✓, the suggested ns (`"wsb"` — the currently derived namespace) ✓, the hot-apply lift ✓. **No crew record dir created**: `.opencode/crew` in wsB absent before AND after the refused call.

### (c) Hot-apply lift — PASS

Added `"pool": "e2e"` to wsB's forge.json; the next `crew_begin` (fresh session `e2e_probe_c`, no host restart) **REGISTERED**: output led with the record path line `Crew record (inspectable history; NOT a resume mechanism): .opencode/crew/2026-10-31-pool-namespace-e2e-probe.md`, then `[forge:crew] Crew registered PENDING for this session (execution has NOT started)` and the three-choice PENDING pause text. The record file exists on disk (header `- anchor: …wsB`, declared plan `1. probe subtask one`), and the registration roster shows the hot-applied rename: workspace pool now materializes **`forge-e2e-research`** under ns `e2e`.

### (d) Global fallback — PASS

`wsC` (no forge.json) with the global-layer forge.json in the temp config tree (`forgehome/.config/opencode/forge.json`, agent `reviewer`): the host materializes **`forge-global-reviewer`** — fixed `global` namespace — with description `Pool 'global' — origin: the global fallback layer.` The wsC `/crew` template's session-domain roster confirms ownership: the "this workspace pool" line is absent, the global fallback layer is the dispatchable roster, and every other host pool (`wsb`, `e2e`, `plugindev`) is listed as `NOT dispatchable from this session` with its origin path.

## Step 4 — README four-step uninstall (README.md lines 164–181, followed verbatim): PASS

1. **Remove the plugin entry from the `plugin` array** — real `~/.config/opencode/opencode.json`: the git+file entry was already surgically stripped right after install (installer-discipline); re-verified now: `git+file entry present: False`, `npm entry present: True` (the user's pre-existing npm entry untouched). The sandbox config's entry was removed for the gone-check below.
2. **Delete the package store dir** — deleted `~/.cache/opencode/packages/git+file_/…` (the store dir this git+file install actually created; `store after delete: False`). Honest note: the README names the npm scope-dir (`@sorenllm/opencode-forge`) and github layouts; the git+file layout is the `git+file_/…` path — the npm store dir was **deliberately NOT deleted** because it holds the user's live npm-channel 0.17.0 install (verified intact afterwards).
3. **Delete the `agent["forge"]` block if you added one** — none was added (`forge agent block: False` in the real config; the install never writes it).
4. **Done / gone-check** — restarted the sandbox serve with the plugin entry removed: `/config?directory=<wsA>` returns **0 `forge*` agents** and no `command.crew` / `command.plan` / `command.goal` — plugin fully gone from the sandbox.
5. (Optional debris) `<tmp>/opencode-forge/` was not written by this sandbox run (no jobs/watchdog fired); not deleted — it contains the verifying agent's own host-session job logs, out of scope.

Real-config cleanliness proof: final SHA256 `5656FA484569AD202790084F13C9BF10F8EE91A763D839B819957A60A318842D` == pre-install baseline; `fc /b`: `no differences encountered`. All five serve ports freed (tree-killed); temp `.tmp/poolns-e2e/` removed.

## Verdict table

| Step | Exit | Result | Evidence excerpt |
| --- | --- | --- | --- |
| 1 official install | 0 | PASS | `Installed git+file:///…`, store package.json `version=0.18.0`, dist git-blob == `HEAD:dist/index.js` |
| 2 sandbox host | 0 | PASS (after XDG isolation fix) | `opencode server listening`, hermetic `/config` (no real-config keys) |
| 3a namespaced pool | — | PASS | `forge-e2e-scout` present, plain `forge-scout` absent, `Pool 'e2e' — origin …` desc |
| 3b ns + compliance refusal | — | PASS | `forge-wsb-research` (dir-derived ns); `Pool compliance refused … missing top-level pool field … Minimal fix: "pool": "wsb" … lifts hot-apply`; no `.opencode/crew` created |
| 3c hot-apply lift | — | PASS | after adding `pool`: `Crew registered PENDING` + record path line; record file on disk |
| 3d global fallback | — | PASS | `forge-global-reviewer`, `Pool 'global' — origin: the global fallback layer.`, wsC roster = global only |
| 4 README four-step uninstall | 0 | PASS | entry removed / store deleted / no agent block / sandbox `/config` shows 0 forge agents + no crew command; real config byte-identical |

**Overall: PASS** — install, all four behavior assertions (a)–(d), and the four-step uninstall all verified deterministically against the official git+file install of 0.18.0 at commit `9d7c7fe`.
