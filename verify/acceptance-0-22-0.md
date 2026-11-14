# Acceptance — async-dispatch release 0.22.0 (live verification)

Date: 2026-11-14/15 (session) · HEAD at release: `76cf947` (chore: bump version to 0.22.0 and rebuild dist (async-dispatch))

## Release chain

| Step | Result | Evidence |
| ---- | ------ | -------- |
| typecheck | 0 errors | `bun run typecheck` clean |
| unit tests | 533 pass / 0 fail | `node --test tests/*.test.mjs` → `tests 533 / pass 533 / fail 0` |
| bundle | rebuilt self-contained | `Bundled 95 modules in 35ms → dist/index.js 0.72 MB` |
| npm pack --dry-run | exactly 3 files | `npm notice total files: 3` (README.md / dist / package.json), shasum `80576bbfcaee684c581080784e2c728992215f11` |
| publish | `+ @sorenllm/opencode-forge@0.22.0` | `npm publish --access public` (token read from npmtoken.txt into `$env:NPM_CONFIG_TOKEN`, env var removed immediately after; token never echoed or written) |
| registry flip | latest=0.22.0 after **156 s** (poll #16 of 10 s loop) | `https://registry.npmjs.org/-/package/@sorenllm%2Fopencode-forge/dist-tags` |
| store update | dual-layer 0.22.0 | `deps=0.22.0 inner=0.22.0` (npm_@sorenllm outer package.json dependency + inner node_modules/@sorenllm/opencode-forge/package.json); store dist contains `forge_dispatch`: True. Installed via original spec string `opencode plugin "npm:@sorenllm/opencode-forge"` after deleting `~/.cache/opencode/packages/npm_@sorenllm` |
| global config | UNCHANGED (hash compare vs pre-install backup) — install landed in workspace-local `.opencode/opencode.json` which already had the spec string | `global config UNCHANGED (no strip needed)` |
| commits | `d9a8853` docs: async-dispatch spec delta + openspec metadata · `76cf947` chore: bump version to 0.22.0 and rebuild dist (async-dispatch) | `git log --oneline` |
| push | `865e2d2..76cf947  main -> main` on attempt 1; post-fetch `## main...origin/main` (in sync) | git push output |

## Live host verification (real host, real model calls, smoke scale)

Host: `opencode serve --port 47613 --hostname 127.0.0.1` with `OPENCODE_CONFIG_DIR` = temp sandbox copy (real opencode.jsonc copied for provider auth; global config untouched), workdir = `opencode_plugin_dev` — so the workspace `.opencode/opencode.json` loads the plugin via `npm:@sorenllm/opencode-forge` → **store 0.22.0 dist**. `/agent` listing confirmed `forge` + `forge-plugindev-spec-reviewer` materialized from the plugindev workspace pool. Primary session agent = `forge`, model `glm-coding-worker/glm-5.3`. Driver: `C:\Users\Soren\AppData\Local\Temp\opencode\dispatch-live-e2e.mjs` (REST message send + SSE idle + message polling + SDK session list).

Parent session: `ses_e240bf803ffeY0hIQGIksexnPA`

### A. wait mode — PASS

Prompt: `forge_dispatch(subagent_type="forge-plugindev-spec-reviewer", mode="wait", prompt="Reply with exactly the literal string WAIT-OK and nothing else.")`

Tool result delivered inline in the wait turn (parent idle after ~17 s):

```
<OUT>
[forge:dispatch] forge-plugindev-spec-reviewer finished (child session ses_e240bdb80ffe52ZZLJb1e80gl3).
Final report:
WAIT-OK
</OUT>
```

WAIT-MODE-RESULT: PASS — tool result contains `WAIT-OK` and the child session id `ses_e240bdb80ffe52ZZLJb1e80gl3`.

### B. async mode — PASS

Prompt: `forge_dispatch(subagent_type="forge-plugindev-spec-reviewer", mode="async", prompt="Reply with exactly the literal string ASYNC-OK and nothing else.")`

Handle returned immediately (parent idle after ~9 s, before child completion). Completion wake then delivered into the parent session as its own message:

```
[forge:dispatch-complete] forge_dispatch to forge-plugindev-spec-reviewer finished (task j-20261114-212628-spbjmw, child session ses_e240b9db8ffeJEi7qi454Oo7Hv).
Final report:
ASYNC-OK
The dispatch is complete — read the report above; no polling, no re-dispatch needed.
```

ASYNC-WAKE-DELIVERED: PASS — immediate handle, then `[forge:dispatch-complete]` wake containing `ASYNC-OK` arrived without any polling from the parent.

### C. parentID link (SDK session tree) — PASS

`@opencode-ai/sdk` `client.session.list()` (file-url import from workspace `.opencode/node_modules`):

```
ses_e240b9db8ffeJEi7qi454Oo7Hv  parentID=ses_e240bf803ffeY0hIQGIksexnPA  title="Reply with exactly the literal string ASYNC-OK and nothing e (@forge-plugindev-spec-reviewer subagent)"
ses_e240bdb80ffe52ZZLJb1e80gl3  parentID=ses_e240bf803ffeY0hIQGIksexnPA  title="Reply with exactly the literal string WAIT-OK and nothing el (@forge-plugindev-spec-reviewer subagent)"
```

Both child sessions carry `parentID` = parent session `ses_e240bf803ffeY0hIQGIksexnPA`.

## Boundary compliance

- openspec change NOT archived (explicit user instruction pending).
- No implementation code touched during verification; no bug found.
- Global `~/.config/opencode/opencode.jsonc` untouched (hash-verified against pre-install backup).
