# worker-shell-session-allow — design

- Evidence base: `reports/probe-native-worker-shell-denial.md` (§1–§6,
  production geometry + 5-channel elimination matrix) and
  `reports/research-plugin-tool-permission.md` (§1 v2.3.2 source
  verbatim, §2 official docs, §3 upstream status, §5 fix menu). Every
  mechanism claim below is source- or production-anchored there.

## D1. Root cause (fixed, not guesswork)

`packages/core/src/permission.ts` @ v2.3.2:

```ts
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
// configured():
const agent = yield* agents.resolve(agentID ?? session.agent)
return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
```

- `Agent` registries are **location-scoped** (`agent.ts`:
  `makeLocationNode`); the Session store is **global-scoped**
  (`session/store.ts`: `makeGlobalNode`). A session is visible from any
  anchor; a workspace-layer md agent is not visible from the host
  anchor.
- The plugin tool's `ctx.permission.assert` closure captures the
  PLUGIN HOST location's Permission/Agent services (`plugin/host.ts`,
  `plugin.ts` `makeLocationNode`) — the calling session's location is
  irrelevant to where the assert evaluates.
- `denied(input, rules)` short-circuits before savedRules and before
  the `permission.evaluate` hook — hence zero diagnostics. The bare
  message `Permission denied: forge_shell` is `BlockedError.message`
  with no `reason`; a genuine unanswered ask would read differently
  ("…nobody is present to give it").
- `forge` (primary) is immune: the plugin registers it into the
  host-anchor registry. Draft-era workers were immune for the same
  reason (programmatic registration). Only NATIVE md workers cross
  anchors.

## D2. The rescue channel and why it is legitimate

`configured()` merges `merge(agentRules, session.permissions)` and
`evaluate()` picks `findLast` — session rules sit at the END of the
merged array and therefore WIN over the missing-agent deny-all.
Official plugin docs state this surface explicitly:
`ctx.session.update({sessionID, permissions})` — "They are evaluated
after the agent's rules, and the last matching rule wins. Child
sessions inherit the rules in effect when they are created."

This is not a bypass of the host permission system — it IS a
documented host permission surface, used to restore the documented
default posture ("every agent starts with an allow-all base policy")
for the one geometry where a host defect silently replaces it with
deny-all. A user's explicit deny remains fully effective (D3).

## D3. Posture gate — dual-shape, deny is sacred

- The posture snapshot reads BOTH user-config shapes:
  - v1 legacy: `permission.forge_shell` (`"allow"|"deny"|"ask"`);
  - v2: `permissions` rule array — `findLast` over rules whose action
    wildcard-matches `forge_shell` (action `forge_shell` or `*`) with
    resource `*` (we always assert `resources:["*"]`).
- Explicit `deny` (either shape) → NO injection on any session, and
  the existing plugin-side refusal fires before the assert (belt
  extended from v1-only to both shapes).
- Explicit `allow` or unconfigured → injection proceeds (for allow the
  host would allow anyway wherever the agent resolves; the session
  rule additionally covers the cross-anchor geometry).
- Explicit `ask` → primary sessions keep the real ask (agent resolves
  there, no injection needed — primary injection only fires when the
  session rules lack ours, and the ask path in a PRIMARY session is
  untouched because the assert evaluates agent rules first and the ask
  surfaces before our session rule changes the outcome — an ask rule
  is not a deny, and `ask` beats nothing here). For WORKER sessions an
  ask is unanswerable by construction (no client attachment): the
  rescue injects allow and the README discloses that workers are
  machine contexts — the supported way to silence worker shell is an
  explicit deny.

## D4. Injection mechanics

- Rule injected (verbatim): `{action: "forge_shell", resource: "*",
  effect: "allow"}` — scoped to our action name only; it cannot affect
  any builtin tool or other plugin.
- **Point 1 — primary (inheritance channel):** in the v2 session
  prompt hook, when the session's agent is the forge primary, ensure
  the rule is present. Workers created afterwards inherit session
  rules at creation (official semantics).
- **Point 2 — worker belt (coverage channel):** at `forge_shell`
  handler entry, when the session's agent family is a forge worker
  (existing sessionID→agent family map) and the session has not been
  marked injected, ensure the rule directly on THAT session. Covers
  workers created before the plugin loaded / before primary injection.
- Ensure = read-back-merge-write: `session.get(sessionID)` → existing
  `permissions ?? []` → append our rule unless an entry with our
  action+resource already exists → `session.update({sessionID,
  permissions})`. Never clobbers unknown existing rules; wholesale
  replacement semantics are respected by writing the merged array.
- Idempotence: in-memory `Set<sessionID>` of already-injected sessions
  + the read-back presence check (double belt; set is per-boot, safe
  across host restarts).
- Fail-soft: `session.get`/`session.update` are runtime-optional on
  our typed surface (host 2.3.2 delivers both — source-verified
  `host.ts`; typing stays defensive). Any absence/throw → skip that
  injection point, log nothing to the user, fall through to D5.
- The `agent` field keeps flowing into the assert input unchanged —
  attribution stays honest; the rescue works through session rules,
  not through hiding the agent.

## D5. Fallback belt — posture-driven, never past a deny

If the host assert still rejects AND the rejection is the bare
no-reason deny (`Permission denied: forge_shell`, no reason payload)
AND the resolved posture is NOT an explicit deny → the call proceeds
and a bounded one-line finding `[forge:session-rescue]` is attached to
the tool result (first occurrence per session; the finding names the
upstream root cause in one clause and the README pointer).

Rationale: with no explicit deny configured, a bare no-reason deny can
only be the cross-anchor fallback (D1) — saved-rule denies carry
rules, user-configured denies are caught by the posture gate first.
This belt makes worker shell function even on hosts lacking
`session.update`; it is belt-in-depth BEHIND D4, not a replacement.

Explicit `ask` nuance: an ask that times out/rejects unattended does
NOT carry the bare-deny signature (different message per source) — the
belt does not fire on it; the host's own unattended semantics stand.

## D6. v1 domain untouched

v1 materializes drafts programmatically → agents resolve at the host
anchor → no deny-all fallback. The v1 API has no session domain. No
v1 code path changes.

## D7. Disclosure

- README native-mode section: the rescue, its scope (forge_shell only,
  forge-family sessions only), the deny recipe (both config shapes),
  and the note that session rules are host state — the plugin's
  filesystem ledger gains NO new writes.
- The injected rule is disclosed in the sync/diag surface only if
  asked; it is not a roster artifact and never touches disk.
