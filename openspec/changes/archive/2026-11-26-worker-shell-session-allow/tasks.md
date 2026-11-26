# worker-shell-session-allow — tasks

## 1. Implementation

- [x] 1.1 Posture snapshot dual-shape: read legacy v1 `permission.forge_shell`
  AND the v2 `permissions` rule array (findLast over action-wildcard match on
  `forge_shell` with resource `*`); explicit deny in either shape resolves to
  `deny`; extend the existing plugin-side refusal to fire on the v2 shape too.
  (Pure core `resolveForgeShellPosture` + `hostConfigDocumentsFor` — v2 hosts
  read the host config documents from disk, fail-soft; v1 hosts keep the
  snapshot truth byte-equal.)
- [x] 1.2 Session-rule injection helper (pure-ish core, injectable
  session-api shim): rule `{action:"forge_shell", resource:"*", effect:"allow"}`;
  read-back-merge via `session.get` → append unless an identical entry exists →
  `session.update`; never clobbers; in-memory idempotence set; explicit-deny
  gate returns "rescue disabled"; fail-soft when get/update are absent or
  throw (returns "unavailable", never surfaces to the user).
- [x] 1.3 Wire primary injection at the v2 session context hook (agent = forge
  primary — SessionPrompt carries no agent field): fire-and-forget seeding so
  worker children created later inherit session rules at creation.
- [x] 1.4 Wire worker belt at the `forge_shell` handler entry: family map says
  the session's agent is a forge worker (`forge-*`, primary `forge` excluded)
  → belt-inject before the posture gate (deny-gate inside the helper
  short-circuits); also wins the first-turn race against 1.3.
- [x] 1.5 Fallback belt on the assert path: rejection message exactly
  `Permission denied: forge_shell` (bare, no reason) AND posture ≠ explicit
  deny AND the session is a forge WORKER session (primary bare denies are
  real denies and propagate) → proceed; bounded `[forge:session-rescue]`
  disclosure once per session (diagnostics line + the tool call's metadata
  title). Harvested on session.deleted alongside the other session maps.
- [x] 1.6 README: "Worker shell rescue (v2 hosts)" disclosure — scope
  (forge-family sessions, forge_shell action only), session-rules-are-host-
  state note (File ledger unchanged), and the deny recipe for both config
  shapes.

## 2. Tests (`tests/worker-shell-session-allow.test.mjs` — 19 tests, green)

- [x] 2.1 Posture dual-shape matrix: v1 map three values (+bogus → unset);
  v2 array exact/wildcard/`?` action, resource gating (non-`*` never
  matches), foreign action, last-match-wins both orders, array-wins-over-map
  within a document, array-without-match falls through to the map, workspace
  overrides global both orders; empty/broken documents fail-soft.
- [x] 2.2 Injection helper matrix: appends into empty (exact rule shape);
  unknown existing rules survive byte-for-byte; identical-rule-present → no
  write; explicit deny → disabled (no write); api absent / get throws /
  update throws → unavailable (no throw).
- [x] 2.3 Fallback belt matrix: bare-deny + worker + unconfigured → proceeds
  + disclosure attaches exactly once; explicit deny refuses BEFORE the ask
  (verbatim refusal); explicit allow skips the ask; bare deny on primary
  `forge` / unknown sessions propagates; other messages (unanswered-ask
  wording, reasoned deny) propagate verbatim; v1 regression guard — host not
  v2 → belt inert even for worker sessions.
- [x] 2.4 Wiring: v2Setup captures a fake session domain's get/update and
  the registered context hook seeds the forge PRIMARY exactly once with the
  exact rule; a non-forge agent never seeds. (Worker-belt glue in the
  forge_shell execute is covered by the isWorker+ensure unit composition and
  the production-geometry verification in 3.2 — the E2E-only geometry.)

## 3. Verification

- [x] 3.1 `bun run typecheck`, full `node --test` suite green, `bun run
  bundle`, dist committed. (859/859 — 840 baseline + 19 new; HEAD 188ecca.)
- [x] 3.2 Production-geometry verification (2026-11-21, server PID 43308,
  fresh plugin load run=0793a9cf @ 21:48 — AFTER the patched dist deploy at
  21:37):
  - PASS leg: plugindev worker `forge_shell echo RESCUE-VERIFIED-OK` →
    exit=0, output verbatim; second call (`git log --oneline -1`) →
    `188ecca chore: dist rebuild (worker-shell-session-allow)` exit=0.
    Zero `[forge:session-rescue]` lines in the host log → the session-rule
    injection channel worked silently (primary seeding / worker belt);
    the fallback belt never fired — the designed clean path.
  - DENY leg: v2-array `permissions: [{action:"forge_shell",effect:"deny"}]`
    in opencode.jsonc → worker receives the plugin's EXPLICIT refusal
    verbatim (`[forge] forge_shell is explicitly denied by user
    configuration…`) — not the host's bare deny — proving the dual-shape
    posture resolver reads real disk and the deny gate short-circuits
    before any injection. Config restored byte-identical afterwards
    (SHA256 prefix 979DA33455822E1E = baseline).
- [x] 3.3 Fold into the 0.31.0 release train: unblocks the dual-change sandbox
  E2E (write workers regain command execution); E2E scenario list gains the
  worker-shell PASS leg. (2026-11-21: dual-change E2E relaunched the same
  evening — 9/9 sandbox scenarios PASS at final tally @92fc059; the
  production-geometry rescue leg is scenario 10 in
  reports/e2e-0310-dual-change-report.md. Ships in 0.31.0 — publish pending
  owner approval.)
