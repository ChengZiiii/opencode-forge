# worker-shell-session-allow — tasks

## 1. Implementation

- [ ] 1.1 Posture snapshot dual-shape: read legacy v1 `permission.forge_shell`
  AND the v2 `permissions` rule array (findLast over action-wildcard match on
  `forge_shell` with resource `*`); explicit deny in either shape resolves to
  `deny`; extend the existing plugin-side refusal to fire on the v2 shape too.
- [ ] 1.2 Session-rule injection helper (pure-ish core, injectable
  session-api shim): rule `{action:"forge_shell", resource:"*", effect:"allow"}`;
  read-back-merge via `session.get` → append unless an identical entry exists →
  `session.update`; never clobbers; in-memory idempotence set; explicit-deny
  gate returns "rescue disabled"; fail-soft when get/update are absent or
  throw (returns "unavailable", never surfaces to the user).
- [ ] 1.3 Wire primary injection at the v2 session prompt hook (agent = forge
  primary): call the helper, swallow failures silently.
- [ ] 1.4 Wire worker belt at the `forge_shell` handler entry: family map says
  the session's agent is a forge worker → call the helper before the posture
  gate (deny-gate inside the helper short-circuits).
- [ ] 1.5 Fallback belt on the assert path: rejection carries the bare
  no-reason deny signature (message exactly `Permission denied: forge_shell`)
  AND posture ≠ explicit deny → proceed; attach bounded `[forge:session-rescue]`
  finding once per session.
- [ ] 1.6 README: native-mode rescue disclosure (scope: forge-family sessions,
  forge_shell action only), the deny recipe for both config shapes, note that
  session rules are host state (no new plugin filesystem writes — File ledger
  unchanged).

## 2. Tests (`tests/worker-shell-session-allow.test.mjs` + adjacent suites)

- [ ] 2.1 Posture dual-shape matrix: v1 map three values; v2 array
  exact/wildcard/deny/allow/ask precedence (findLast); mixed shapes; unset.
- [ ] 2.2 Injection helper matrix: appends into empty rules; appends keeping
  unknown existing rules (no clobber); skips when identical rule present;
  explicit-deny → disabled; get/update absent → unavailable; update throws →
  unavailable (no throw); idempotence set short-circuits second call.
- [ ] 2.3 Fallback belt matrix: bare-deny + unconfigured → proceed + finding;
  bare-deny + explicit deny → refusal (belt silent); rejection with any other
  message → surfaces verbatim (belt silent); finding emitted once per session.
- [ ] 2.4 Wiring: prompt-hook path calls the helper for the forge primary
  agent; worker belt path calls it for family-mapped worker sessions; v1 code
  path byte-untouched (regression guard on the v1 gate).

## 3. Verification

- [ ] 3.1 `bun run typecheck`, full `node --test` suite green, `bun run
  bundle`, dist committed.
- [ ] 3.2 Production-geometry verification (the only geometry that exhibits
  the defect — sandbox serves cannot reproduce it, probe §0): deploy the
  patched dist, `opencode service restart`, dispatch a plugindev worker with
  `forge_shell echo` → PASS verbatim; explicit-deny config → verbatim refusal;
  `[forge:session-rescue]`/injection disclosure present in the right places;
  revert any test config afterwards (byte-identical restore, hash-verified).
- [ ] 3.3 Fold into the 0.31.0 release train: unblocks the dual-change sandbox
  E2E (write workers regain command execution); E2E scenario list gains the
  worker-shell PASS leg.
