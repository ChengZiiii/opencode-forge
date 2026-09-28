# Tasks — forge-shell-mandate

## 1. Prompt composition

- [ ] 1.1 `plugin.ts`: extract a `forgePrompt(opts)` composition — FORGE_PROMPT plus the exec-surface paragraph; hard wording ("every shell command — quick ones included — runs through forge_shell; the builtin shell/bash tools are refused here, do not try them first") when the partition holds (jobs.mode auto/forge, keepBuiltinShell unset); preference wording ("forge_shell first — it is the exec surface for every shell command") under `keepBuiltinShell: true`; no exec-surface paragraph under `jobs.mode: "native"`. Wire into the v1 agent def (line ~1782) and v2 `setup` (agent.system). Verify: forge-subagents-wiring prompt composition assertions.
- [ ] 1.2 `plugin.ts` system.transform: `[forge:job-guidance]` text per the same gate — absolute channel rule + keep the delegated-collection sentence when the hide holds; long-running framing retained under `keepBuiltinShell`; nothing under native/disabled (existing gates). Verify: job-wiring guidance assertions.
- [ ] 1.3 `plugin.ts` FORGE_SHELL_DESCRIPTION: final line becomes channel framing ("this tool is the exec surface for every shell command — quick ones included; long-running or non-exiting commands should use run_in_background"). Verify: read-through + existing description-dependent tests.

## 2. Docs

- [ ] 2.1 README: one sentence in the tool-partition section noting the forge family is prompted to route every command through forge_shell (belt as backstop). Verify: read-through.

## 3. Verification

- [ ] 3.1 Full regression: `bun run typecheck` + `node --test tests/*.test.mjs` green; `openspec validate --all` clean.
- [ ] 3.2 E2E (real environment, npm channel after release): a benign prompt in an `opencode run` runs its commands through forge_shell with no `[forge:partition]` refusal in the transcript; a `keepBuiltinShell` sandbox run still executes through the builtin shell when chosen. Evidence appended to verify/e2e.md.
