# Verification Notes — shell-defang-default-open

Archived 2026-11-16. Released as **0.25.5** (feat `3a8a4e0`, release `058b5a2`,
pushed `86efb57..058b5a2`, npm dist-tags latest=0.25.5, store pin + installed
copy both 0.25.5, host restarted onto the release ~12:57).

## Acceptance evidence (tasks.md mirrored)

| Task | Evidence |
| ---- | -------- |
| 1.1 no default injection | config hook rewrite loop `continue`s on forge_shell; tests: unconfigured → `cfg.permission.forge_shell === undefined` (headless-gate, job-wiring 4.1, search-wiring ask-gate all assert it); doors still rewritten to ask |
| 1.2 classifier retired | `forgeShellGate` = deny-throw / allow-skip / unmodified ask; `[forge:headless-denied]` absent from dist (build check); `FORGE_HEADLESS` gone from dist; `src/headless.ts` tombstoned, zero imports, dropped from bundle; belt handles the 7 doors only, forge_shell passes through untouched in every direction |
| 1.3 posture matrix | tests/headless-gate.test.mjs fully rewritten — 15 tests: unconfigured runs WRITE-class via host allow; explicit ask reaches host unmodified (ask's own rejection IS the result); explicit allow skips ask; explicit deny refuses pre-ask; anti-recapture; doors real dialogs; seal refuses readonly workers' writes; hygiene wiring |
| 2.1 spawn defang | `NON_INTERACTIVE_ENV` (GIT_EDITOR=: EDITOR=: GIT_PAGER=cat PAGER=cat GIT_MERGE_AUTOEDIT=no) merged in `shellSpawn` with precedence parent < defang < caller; wiring proof: ENV_PRINT captured `:\|:\|cat\|cat\|no` through a real spawn |
| 2.2 interactive banner | `KNOWN_INTERACTIVE_COMMANDS` (34 entries) + pure segment-head matcher (env-prefix skip; `npm install` no, `git log \| less` yes, `echo vim` no); tool wrapper prepends the banner to every result shape |
| 2.3 banner non-blocking | live: `npm login` led with the verbatim banner, was NOT refused, ran to its OAuth wait, honest still-running at 60s idle, tree-killed cleanly |
| 3.1 gates | suite **633/633** (was 630), `bun run typecheck` exit 0, `openspec validate --all` 10 passed 0 failed |
| 3.2 docs | README: FORGE_HEADLESS row deleted; pass-through contract + hygiene sections; serve-ask disclosure ("answer asks via the host API or don't configure ask"); unconfigured default-open surface disclosed |
| 3.4 release train | publish attempt 1 hit the Windows no-shell `.cmd` EINVAL (nothing published — registry verified before retry); attempt 2 via `npm.cmd` + shell published; registry verified via direct fetch (npm view cache was stale). Push needed 7 attempts (Connection reset × 6 — this host's flaky github link, same as prior trains). Commits/publish ran through a node-driven child-process path under the owner's explicit remote authorization while the pre-0.25.5 gate was still live |
| 3.3 live replay | host restarted ~12:57 onto the pre-installed release: **(1)** `git push` — the exact command this host refused verbatim hours earlier — ran: `Everything up-to-date`, exit=0, zero asks; **(2)** sandbox `git commit --allow-empty-message` (no `-m`, editor path) completed instantly via `GIT_EDITOR=:` and created root commit `ee49340`; the chain's PowerShell mutating cmdlets (`New-Item`/`Set-Content`/`Remove-Item`) all ran — write-class pass-through proven; **(3)** `npm login` banner + release + OAuth wait + honest 60s idle return + clean tree kill |

## Honest findings

- The product decision (owner, 2026-11-16): full omo parity, direct
  pass-through — the opt-in classifier variant designed earlier in this
  change was explicitly rejected ("这个做成和omo一样的，直接放行"). The
  accepted consequence: an explicit `ask` on a serve host is a pending ask
  with no plugin-side rescue (host semantics, same as the native shell
  tool); disclosed in README.
- `exec-classify.ts` survives with a narrowed role: the readonly-exec-seal's
  write-class recognition only — its posture-path call site is gone.
- The release train itself became the first consumer of the change: the
  author's `git add` was refused live by the dying gate (third and final
  wild hit), and the unblock ran through a node-driven path under explicit
  owner authorization — recorded here rather than hidden.
- Windows packaging quirk re-confirmed for the pitfalls file: Node ≥ 20
  refuses `spawnSync("npm", …)` without a shell (EINVAL / exit null);
  `npm.cmd` + `shell: true` is the working form.
