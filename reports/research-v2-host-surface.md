# Research: v2 host surface — hardening `fix-dispatch-dispose-kill`

Date: 2026-11-23 · Scope: READ-ONLY local SDK + live-host HTTP probe (GET only) + web.
Live host: opencode **2.3.2** (`service.json`: `"version":"2.3.2"`, `http://127.0.0.1:28894`, auth Basic `opencode:<password>`).
OMO / oh-my-opencode explicitly **excluded** per user instruction.

---

## 0. Executive summary — verdicts on the three planned fixes

| Planned fix | Verdict | One-line basis |
|---|---|---|
| (a) dispose must **not** kill dispatch rows | **STRONGLY SUPPORTED** | Official v2 docs limit cleanup to "resources the plugin owns"; upstream issues prove dispose fires at arbitrary times (hot reload, config reload, location teardown) and races in-flight turns; community plugins make dispatch state **survive** plugin reload in the same host process. |
| (b) wire a **real abort** on the v2 adapter | **SUPPORTED, with a correction** | On 2.3.2 the abort primitive is **`interrupt`**, not `abort`. The live host has **no `/abort` endpoint at all**; it exposes `POST /api/session/{sessionID}/interrupt`. `session.abort` exists only in SDK-gen types *newer* than this host and in a flat, non-`/api` client surface. Native v2 subagent code aborts via `sessions.interrupt(child)` + `jobs.cancel(child)`. HTTP fallback exists: `POST /api/session/{id}/interrupt` (and stronger: `DELETE /api/session/{id}` = `session.remove`, which "stops active execution and recursively deletes child sessions"). |
| (c) honest "aborted" wake wording | **SUPPORTED** | Host-native vocabulary exists and is observable: `Session.Message.Idle {outcome: "succeeded"\|"failed"\|"interrupted"}` rows and the `session.execution.interrupted` event with `reason: "user"\|"shutdown"\|"superseded"\|"inactivity"`. Native subagent tool says "Subagent **cancelled** (sessionID: …)". Our `normalizeV2MessageRow` currently **drops** `idle` rows (`type === "idle"` → `null`), so the honest outcome is invisible to our wake path today. |

Additional contradiction flags beyond (a)–(c) in §5, including a possibly **dead `task` deny seal** on v2 (v2 action name is `subagent`).

---

## 1. Local SDK surface

Packages in `opencode-forge/node_modules/@opencode-ai/`: **`plugin` 1.18.32** and **`sdk` 1.18.32** (both pinned; npm latest for `@opencode-ai/plugin` is 1.19.5). The v2-native plugin package `@opencode/plugin` (no `-ai`) is **not installed** — the v2 promise-layer ctx our plugin consumes is structurally typed in `plugin.ts`.

### 1.1 `@opencode-ai/plugin` 1.18.32 — `dist/index.d.ts` (322 lines, read in full)

**PluginInput** (index.d.ts:36–46) — the *v1-form* host input. Fields, verbatim:

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;  // from "@opencode-ai/sdk" (v1-gen root client)
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void; };
    serverUrl: URL;
    $: BunShell;
};
```

**There is no `session` and no `permission` on PluginInput.** No abort channel of any kind is handed to a v1-form plugin besides `client` (HTTP) and `$`.

**Hooks interface** (index.d.ts:173–322) — full inventory, with the lines that matter to this change:

- `dispose?: () => Promise<void>` — **line 174**. Confirms: dispose takes **zero arguments** (no sessionID, no location, no reason). Our incident mechanic matches exactly.
- `event?: (input: { event: Event }) => Promise<void>` — line 175.
- `config?` — 178; `tool?: {[key: string]: ToolDefinition}` — 179; `auth?` — 182; `provider?` — 183.
- `"chat.message"?` — 187; `"chat.params"?` — 203; `"chat.headers"?` — 216.
- `"permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>` — **225–227** (this is the *hook*, not a tool ctx API).
- `"command.execute.before"?` — 228; `"tool.execute.before"?: (input: {tool, sessionID, callID}, output: {args})` — **235–241**; `"shell.env"?` — 242; `"tool.execute.after"?` — 249.
- Experimental: `experimental.chat.messages.transform` 259, `…system.transform` 265, `…provider.small_model` 271, `experimental.session.compacting` 283, `experimental.compaction.autocontinue` 296, `experimental.text.complete` 306, `tool.definition` 316.

### 1.2 `@opencode-ai/plugin` — `dist/tool.d.ts` (ToolContext for v1-form tools)

```ts
export type ToolContext = {
    sessionID: string; messageID: string; agent: string;
    directory: string; worktree: string;
    abort: AbortSignal;                                   // line 16 — per-call cancel signal
    metadata(input: {title?, metadata?}): void;           // 17–22
    ask(input: AskInput): Promise<void>;                   // 23 — returns void, NOT once/always/deny
};
type AskInput = { permission: string; patterns: string[]; always: string[]; metadata: {...} };  // 25–32
```

Notes: tool cancellation is an **AbortSignal** (not a callable); `ask` resolves `Promise<void>` (fire-and-admit), so a v1 tool cannot read the decision — another reason the ask channel is weak for gate semantics.

### 1.3 `@opencode-ai/sdk` 1.18.32 — three distinct session surfaces

**(i) v1-gen client** (`dist/gen/sdk.gen.d.ts`, class `Session`, lines 106–180+):
- `abort(options: Options<SessionAbortData>)` at **line 148–150**, doc comment "Abort a session".
- `SessionAbortData` (`dist/gen/types.gen.d.ts:2059–2067`): `url: "/session/{id}/abort"`, response `200: boolean` ("Aborted session", line 2080–2086).
- Also: list/create/status/delete/get/update/**children**/todo/init/fork/unshare/share/diff/summarize/messages/prompt/message (106–180).
- `Instance.dispose` → `url: "/instance/dispose"` (types.gen.d.ts:1751–1757) — *instance-level* dispose, "Dispose the current instance".

**(ii) v2-gen flat client** (`dist/v2/gen/sdk.gen.d.ts`, class `Session2` at line 952, reachable as `OpencodeClient.session`, line 2291–2292):
- `abort` at 1142–1146 → `url: "/session/{sessionID}/abort"` (v2 types.gen.d.ts:8506–8529). **No `/api` prefix** — this surface does not match the live 2.3.2 HTTP tree (see §2).
- `prompt` (1085–1103) accepts `parts?: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>` — including the **native subagent dispatch part** `SubtaskPartInput = {id?, type: "subtask", prompt, description, agent, model?{providerID, modelID}, command?}` (v2 types.gen.d.ts:2132–2143).

**(iii) v2-gen `/api` client** (`dist/v2/gen/sdk.gen.d.ts`, class `Session3` at line 1626, reachable as `OpencodeClient.v2.session`, lines 2205–2213) — **this one matches the live 2.3.2 host**:
- `interrupt` at **1741–1747**: doc "Interrupt session execution / **Interrupt active execution owned by this OpenCode process. Idle interruption is a no-op.**"; `V2SessionInterruptData` → `url: "/api/session/{sessionID}/interrupt"`, responses `204 void`, errors 400/401/404 (v2 types.gen.d.ts:10175–10204).
- `wait` at 1706–1712: "Wait for a session agent loop to become idle."
- Also: list/create/**active**/get/switchAgent/switchModel/prompt (durable admission, `delivery: "steer"|"queue"`, `resume?: boolean`, 1690–1696)/compact/context/**history**/**events** (per-session SSE, 1736–1739)/message/messages + sub-domains `revert`, `permission` (`Permission2`, 1550–1596: list/create/get/reply), `question` (`Question2`, 1597–1624: list/reply/reject).
- Global ask-channel classes: `Question` (833–863: list/reply/reject "across all sessions") and `Permission` (865–900: `list`, `reply({requestID, reply: "once"|"always"|"reject", message?})`, deprecated `respond`).

**Conclusion for fix (b):** the only SDK abort that matches host 2.3.2 is **`interrupt`** on the `/api`-prefixed v2 client surface (or plain HTTP). `session.abort` (both spellings) is a *different-generation* surface that the live host does not serve — calling it would 404 even if it were wired.

### 1.4 Our own wiring (grounding the incident)

- `plugin.ts:8504–8512` — `type V2SessionClient` wires exactly `prompt | promptAsync | get | create | messages`. **No abort/interrupt.**
- `plugin.ts:8569–8671` — `v2SessionClient(ctx)` builds that adapter from `ctx.session` (flat `{sessionID, …}` params) + the HTTP-backed messages reader via `discoverServiceHttp()` (8525–8545, reads `service.json` — the same artifact our HTTP probe used).
- `plugin.ts:9245–9246` — `const v2Client = v2SessionClient(ctx); … jobClient = v2Client`, and `plugin.ts:9264/9275` cast it `as unknown as DispatchClient`.
- `src/dispatch-async.ts:127` — `DispatchClient.session.abort` is **required** (non-optional); header comment line 13 claims `session.abort POST /session/{id}/abort → boolean` — **stale against 2.3.2** (no such endpoint live; see §2).
- `src/dispatch-async.ts:936–943` — `abortChild` calls `client.session.abort({path:{id}})` in try/catch → on the v2 adapter this is `undefined is not a function`, swallowed into `{ok:false, error:"session.abort threw: …"}`. Matches the established "silent no-op".
- `plugin.ts:6481–6490` — the v1-form `dispose` hook: `engineForgetAll(); exitCleanup?.trigger("dispose"); jobManager.disposeAll(); watchdog.dispose(); sessions.clear()` — **process-wide, unscoped**. This is the kill-all mechanic.
- `plugin.ts:7503–7506` — v2 `ctx.permission.assert` is typed `assert?(input: unknown): Promise<void>` (usage contract documented in §3.1).
- `plugin.ts:8688–8709` — `normalizeV2MessageRow`: `if (!type || type === "idle") return null` (line 8693) — **idle rows (and their `outcome`) are discarded** today.
- `plugin.ts:9301–9306` — the *v2 setup* cleanup path already models the sanctioned pattern: it disposes only hook registrations + aborts the event loop (does **not** touch jobManager).

---

## 2. Live-host HTTP probe (READ-ONLY, GET only)

Auth: `Authorization: Basic base64("opencode:" + password)` from `C:/Users/Soren/.local/state/opencode/service.json`. All calls were GET; nothing mutated.

### 2.1 Endpoint-listing discovery (verbatim status codes)

```
/api/doc        -> 404 (0 bytes)
/doc            -> 200 (9156 bytes, HTML docs UI)
/openapi.json   -> 200 (458269 bytes, full OpenAPI 3.1.0 spec)   ← authoritative
/api/openapi.json -> 404
/swagger.json   -> 200 (9156 bytes, same HTML UI)
```

`GET /openapi.json` → `{"openapi":"3.1.0","info":{"title":"opencode HttpApi","version":"0.0.1"}}`, **142 paths**.

### 2.2 (a) Does an abort endpoint exist?

**NO.** Across all 142 paths, `abort` appears **nowhere** (searched `abort|interrupt|kill|stop|cancel`; only matches were `/api/session/{sessionID}/interrupt` and coincidental `skill` substrings). Verbatim spec of the real endpoint:

```
POST /api/session/{sessionID}/interrupt     operationId=session.interrupt
  summary: "Interrupt session execution"
  params: sessionID (path, required); resume (query, optional)
  responses:
    200 SessionInterruptResponse
    400 InvalidRequestErrorEncoded | 401 UnauthorizedErrorEncoded | 404 SessionNotFoundErrorEncoded

SessionInterruptResponse = { type: object, required: ["interrupted"], additionalProperties: false,
  properties: { interrupted: { type: boolean,
    description: "Whether an active execution owned by this OpenCode process was interrupted." } } }
```

Also present: **`DELETE /api/session/{sessionID}` = `session.remove`**, `PATCH` = `session.update`, `GET` = `session.get` (verbatim operationIds from the live spec). The v2 plugin docs (§3.1) state remove "stops active execution and recursively deletes child sessions" — a stronger, self-cleaning kill for child sessions.

Note (minor drift): SDK 1.18.32's `Session3.interrupt` declares `204 void` and no `resume` param; the live 2.3.2 spec says `200 {interrupted}` and has `resume` query. Treat the **live spec** as truth for this host.

### 2.3 (b) Session-related endpoints (verbatim paths from `/openapi.json`)

```
/api/session                                        (list)
/api/session/active
/api/session/{sessionID}                            GET session.get | DELETE session.remove | PATCH session.update
/api/session/{sessionID}/agent
/api/session/{sessionID}/background
/api/session/{sessionID}/command
/api/session/{sessionID}/compact
/api/session/{sessionID}/context
/api/session/{sessionID}/diff
/api/session/{sessionID}/environment
/api/session/{sessionID}/fork
/api/session/{sessionID}/form            + /{formID} + /{formID}/reply      ← v2 ask channel ("questions" became forms)
/api/session/{sessionID}/generate
/api/session/{sessionID}/inbox           + /{inboxID}
/api/session/{sessionID}/interrupt                    ← the abort primitive
/api/session/{sessionID}/message                      (GET; params limit, order, cursor, type)
/api/session/{sessionID}/message/{messageID}
/api/session/{sessionID}/model
/api/session/{sessionID}/move
/api/session/{sessionID}/permission       + /{requestID} + /{requestID}/reply
/api/session/{sessionID}/prompt                        (POST session.prompt — durable admission)
/api/session/{sessionID}/revert  /revert/commit /revert/stage
/api/session/{sessionID}/shell
/api/session/{sessionID}/synthetic
/api/session/{sessionID}/view
/api/experimental/session/{sessionID}/wait             (POST experimental.session.wait → 204; 404/503 errors)
/api/experimental/session/{sessionID}/log | /export | /skill | /terminal | /terminal/read
/api/experimental/session/import | /stats
/api/permission/request   /api/permission/saved(/{id})   ← global pending/saved permissions
```

**Absent on 2.3.2** (present in v1-gen SDK): `/session/{id}/abort`, `/session/{id}/prompt_async`, `/session/status` (status map), `/session/{id}/children`, `/instance/dispose` (paths above are the complete set). This confirms three comments in our code: no HTTP promptAsync on v2 (blocking-send approximation is the only channel), no status map, no children query — and invalidates the `session.abort` line-13 comment.

### 2.4 (c) Message row shape (live sample, one small session)

`GET /api/session/ses_dfb7b4334ffeOzBQGXD61RRqg6/message?limit=4` → envelope `{data: [...], cursor: {previous, next}}`; rows are **bare** (no `{info, parts}` wrapper):

```json
{"data":[{"id":"msg_…","time":{"created":1795372299532,"firstToken":…,"streamed":…},
 "type":"assistant","agent":"general","model":{…},
 "content":[{"type":"reasoning","text":"…","native":{…},"time":{…}},
            {"type":"tool","id":"call_…","name":"shell","executed":false,
             "state":{"status":"running","input":{…}},"time":{…}}]},
 {"id":"msg_…","type":"assistant",…,"finish":"…"}]}
```

Session records (`GET /api/session`) carry `parentID`, `permissions: [{action, resource, effect}]` (v2 spelling, live-confirmed), and an `outcome` field on the record itself.

**Honest-outcome vocabulary (live schemas, verbatim):**
- `Session.Message.Idle` = `{id, time, type: "idle", outcome: "succeeded" | "failed" | "interrupted", error?}` — the host records interruption as a first-class message outcome.
- Event `session.execution.interrupted` → `data: {sessionID, reason: "user" | "shutdown" | "superseded" | "inactivity"}` — the host distinguishes *who/why* interrupted.
- `Session.Message.Assistant.finish` enum includes `"error"`; `Session.Message.Assistant` carries `error: Session.StructuredError`.

These give fix (c) host-native wording to mirror: `interrupted` (outcome) / `cancelled` (native tool wording, §3.3) rather than an invented "aborted".

---

## 3. Official repo & docs (web)

### 3.1 Repo home + v2 plugin docs

- **Current home: `github.com/anomalyco/opencode`** (moved from `sst/opencode`; rename PR [#6687](https://github.com/anomalyco/opencode/pull/6687); also pinned by the installed host's own package metadata: `C:\Users\Soren\AppData\Roaming\npm\node_modules\@opencode\cli\package.json` → `"version": "2.3.2"`, `"repository": "git+https://github.com/anomalyco/opencode.git"`).
- **Server plugin doc (v2)**: <https://opencode.ai/v2/docs/build/plugins/server.md> (source: `services/site/src/docs/content/build/plugins/server.mdx` on `dev`). Key verbatim lines:
  - Lifecycle: **"`setup` runs when the plugin loads. It may return a cleanup function that runs when the plugin unloads."**
  - Location isolation: **"`ctx.location` describes the location where this plugin instance is loaded. … This is the plugin instance's location, not the location of every session it can access or event it receives."** (Plugin instances are per-location; state must be scoped accordingly.)
  - Sessions: **"Rename, interrupt, or wait for a session. `await ctx.session.interrupt({ sessionID, resume: false })`; `await ctx.session.wait({ sessionID })`"** and the reference `interrupt(input: SessionInterruptInput): Promise<{ interrupted: boolean }>`; **"Remove a temporary session with `remove`. Removal stops active execution and recursively deletes child sessions."**
  - `ctx.session` reference has **no** `messages` (use `context`) and **no** `fork`/`form` — matches our adapter reality.
  - **`ctx.permission.assert`** (exact documented signature in real use): `assert({sessionID, agent, source: {type: "tool", messageID, id}, action, resources, save, metadata?})` — *"`assert` evaluates the session's permission rules, including saved approvals, and prompts the user when a rule resolves to `ask`. **It resolves once the action is allowed.**"* / *"A deny rule or a rejection with feedback rejects with a `Tool.Error` that carries the reason… A plain rejection ends the current step. **Let these errors propagate rather than returning them as tool output.**"*
  - Tool cancellation: **"Promise tool executors receive `context.signal`. Pass it to cancellable work such as `fetch` so stopping the Session also stops the underlying operation."**
  - Events: `ctx.event.subscribe({types, signal})` async-iterable; **"Abort the stream during plugin cleanup."**
- **Migration doc**: <https://opencode.ai/v2/docs/build/plugins/migrate-v1.md> — hook table maps **"`dispose` → cleanup function returned by `setup`"**; and: **"Use the cleanup function for timers, subprocesses, sockets, and other resources the plugin owns. Hook and transform registrations are scoped to the plugin and are cleaned up automatically."** → *cleanup scope = resources the plugin owns*, not shared per-session registries. Also warns **"V1 plugin implementations do not run in V2"** (dual-export `{id, server, setup}` shape is the sanctioned bridge; V2 "reads the default export's `id` and `setup()` … ignoring `server()`").
- **Permissions doc**: <https://opencode.ai/v2/docs/permissions.md> — action table (verbatim): `read, edit, glob, grep, shell, subagent (resource: Target agent ID), skill, question (resource: *), webfetch, websearch, external_directory, <server>_<tool>, execute`. Callout: **"V1 uses different field and action names. In V2, use `permissions`, `shell`, and `subagent` instead of `permission`, `bash`, and `task`."** Rules: last match wins; **"Child sessions inherit the rules in effect when they are created"** (also in server doc); "If no rule matches, OpenCode uses `ask`."

### 3.2 Native subagent tool source (v2 branch) — abort + wording ground truth

`packages/core/src/tool/plugin/subagent.ts` @ [`anomalyco/opencode` branch `v2`](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/tool/plugin/subagent.ts) (`export const name = "subagent"`, id `opencode.tool.subagent`). Verbatim highlights:

- **The abort path** (foreground block): 
  ```ts
  const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
    Effect.onInterrupt(() =>
      Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], { discard: true }),
    ),
  )
  ```
  → native v2 kill = **`sessions.interrupt(child)` + `jobs.cancel(child)`**. No `abort` anywhere.
- **Honest failure/cancel wording**: `ToolFailure "Subagent failed (sessionID: ${child.id}): …"` / **`"Subagent cancelled (sessionID: ${child.id})"`**; success wraps as `<subagent sessionID="…" state="completed">…</subagent>`; background result says "The subagent is working in the background (sessionID: …). You will be notified automatically when it finishes."
- Dispatch mechanics mirror ours: parent-chain depth guard (`experimental.subagent_depth`, default 1), `permission.assert({action: "subagent", resources: [agent.id], save: [agent.id], …})`, `sessions.create({parentID, title: description, agent, model})`, prompt text prefixed `"You are a subagent spawned by another session."`, background = `resume: false` admission, and a **recovery record** `{kind: "subagent", parentSessionID, childSessionID, agent, description}` fed to a `SubagentJob` service (host-native restart-safe dispatch).

### 3.3 Upstream issues — dispose timing & ask-channel reliability

**Dispose / lifecycle timing (supports fix a):**
- [#42898 "plugins: hot reload makes the server unavailable"](https://github.com/anomalyco/opencode/issues/42898) — verbatim: **"The plugin subscribes to `ctx.event` in a background task. Its cleanup function aborts the subscription and waits for the task, as shown in the V2 plugin documentation. The cleanup might not finish during hot reload."** (Editing a plugin file is enough to trigger unload.) Closed not_planned.
- [#55272 "core: CPU-heavy plugin setup and full-scope teardown starve the shared event loop"](https://github.com/anomalyco/opencode/issues/55272) — full location disposal starves the whole shared server.
- [#54140 "Plugin instances accumulate across config reloads (no teardown)"](https://github.com/anomalyco/opencode/issues/54140) — dispose/teardown reliability across reloads is an active defect area.
- CHANGELOG (v2.3.0, [`dev/CHANGELOG.md`](https://github.com/anomalyco/opencode/blob/dev/CHANGELOG.md)): **"Promise plugin cleanup failures no longer prevent subsequent plugin replacements."**
- [#16626 "add session.stopping plugin hook"](https://github.com/anomalyco/opencode/issues/16626) — verbatim: **"In `opencode run` mode, process teardown races against the re-prompt (#15267). The continuation turn can arrive after disposal has begun."** → dispose-time logic racing live turns is a documented hazard.
- v1-on-v2 contract: [#53706](https://github.com/anomalyco/opencode/issues/53706) ("V1 plugins cannot be made to load on V2…"), [#48138](https://github.com/anomalyco/opencode/issues/48138), [#50140](https://github.com/anomalyco/opencode/issues/50140) (v1 file-plugin detect-mode loader in `packages/opencode/src/plugin/shared.ts`), [#59859](https://github.com/anomalyco/opencode/issues/59859) (dual v1/v2 export pattern in the wild). Our v1-form plugin running under 2.3.2 rides this thin compat path — treat its dispose timing as *undocumented*, another reason dispose must be conservative.

**Ask channel reliability (supports treating ask as best-effort):**
- [#36762 "Headless `opencode run`: any permission resolving to `ask` hangs forever, no timeout (three repro paths)"](https://github.com/anomalyco/opencode/issues/36762) — verbatim: **"In non-interactive `opencode run` (no TTY), any permission check that resolves to `ask` blocks forever: no prompt can render, there is no timeout, and the process looks busy while spending nothing. The only external signature is a `message=asking` log line."** Related: #14473 (server mode), #7876, #35073 (sync-subagent variant). Closed completed 2026-08-22 (fail-fast landed after 2.3.2's era — do not rely on it here).
- [#41730 "Auto-approve permissions (--auto) do not cascade down to subagents"](https://github.com/anomalyco/opencode/issues/41730) — subagent waits forever on permission the parent already auto-approved.
- [#54477](https://github.com/anomalyco/opencode/issues/54477) (GitHub Action hangs; handler replies to no permission event), [#20823](https://github.com/anomalyco/opencode/issues/20823), [#3503](https://github.com/anomalyco/opencode/issues/3503).
- [#55593 "core: permission `ask` silently auto-approved — no request created"](https://github.com/anomalyco/opencode/issues/55593) — the inverse failure: ask silently passes.
- [#47817](https://github.com/anomalyco/opencode/issues/47817) (auto-approve approves *other clients'* requests), [#51398](https://github.com/anomalyco/opencode/issues/51398) (auto-approve not sticky).
- Reload cancels pending asks (community-observed, Kimaki guide §packaging): "Any write in a watched plugin folder reloads every location, and a reload **cancels pending forms and permissions**."

---

## 4. Community plugins (patterns; OMO excluded)

### 4.1 Dispose-time cleanup without killing shared state — **precedent found**

- **`@prevalentware/opencode-goal-plugin`** ([GitHub](https://github.com/prevalentWare/opencode-goal-plugin), [README](https://raw.githubusercontent.com/prevalentWare/opencode-goal-plugin/main/README.md)) — the strongest precedent, and it is a *dispatch-like* workload (goals + Task-subagent deferral):
  - Reload survival: **"The deferral survives a plugin reload in the same host process"** and **"A later idle, unrelated prompt, or plugin reload cannot resume that goal"** — state is deliberately scoped to the **host process**, not the plugin instance; reload (dispose) is a non-event for user-visible state; only a host-process restart triggers rebuild.
  - Restart rebuild: **"After a plugin or server restart, V2 rebuilds Task-subagent deferral state by replaying each non-closed goal session's persisted transcript, because the V2 plugin context exposes no live child-session query; children that leave no finalized tool entry in the transcript are only observed through live events."** (Also independently confirms: no child-session query on the v2 ctx.)
  - State ownership is process-keyed with atomic writes + a coordination sqlite ("Ownership survives a paused process and is released automatically when that process exits") — not keyed to plugin lifetime.
- Official docs (§3.1) codify the same rule: cleanup = own timers/subprocesses/sockets; registrations auto-disposed.
- No counter-example found: **no community plugin was found that deliberately destroys shared per-session registries on dispose.** (Closest negative evidence is upstream bugs where dispose-time work *broke* the server — #42898, #55272.)

### 4.2 User confirmation when the ask channel is unreliable — **precedent found (avoid blocking)**

- **Goal plugin's `awaiting_user` pattern**: the agent never blocks on ask; it persists `status: "paused", reason: "awaiting_user", blocker: "…"` — **"This preserves the goal and stops automatic continuation. A later ordinary reply does not reactivate it by itself: the agent may resume … only when your reply clearly resolves the pending request."** Explicit resume (`/goal resume`) is required; unrelated messages leave it paused. I.e., *confirmation = durable paused state + explicit resume verb*, not an in-flight ask.
- Upstream evidence that blocking on ask is unsafe in headless/serve/auto modes: §3.3 issue cluster (#36762, #41730, #54477, #55593).
- In-band re-verification: the goal plugin also *refuses* weak in-band resumption ("A later ordinary reply does not reactivate it by itself") — the community pattern is **fail-closed pausing**, with the ask/permission surface used only opportunistically. Kimaki's port notes the same inside custom tools: "`ctx.permission.assert(input)` asks the user and waits. **Rethrow a plain rejection; it ends the current step.**" (i.e., let deny propagate; never swallow into output).
- No community precedent found for *trusting* an in-band text reply as a security confirmation; everything found leans on explicit user verbs (resume command / permission reply `once|always|reject`).

### 4.3 Dispatching subagents on v2 — native task tool vs SDK child sessions

- **Native tool is session-based, same as ours**: §3.2 source — the v2 `subagent` tool creates child *sessions* (`parentID`, agent, model) and blocks/waits via the host Job service; v1's `task` tool was renamed (`task` → `subagent`, `subagent_type` → `agent`, `task_id` → `sessionID`) — system-message quote in the [Kimaki v2 migration guide](https://kimaki.dev/blog/opencode-v2-migration): *"`bash` is now `shell`; `task` is now `subagent`."*
- **SDK-side subagent dispatch part**: `SubtaskPartInput {type:"subtask", prompt, description, agent, model?, command?}` (§1.3-ii) — a prompt-part spelling for the same mechanism.
- **Community dispatch plugins**:
  - [beremaran/opencode-agent-tree](https://github.com/beremaran/opencode-agent-tree) — enforces decomposition; "EVERY subtask with the `task` tool to a subagent. Never bundle… You only plan, write subtask briefs, dispatch." (v1-era `task` naming).
  - [opencode-task-model](https://npm.io/package/opencode-task-model) — subagent contract with `child session title` / self-contained `prompt` / `task_id` continuation (v1 shape).
  - [Sub-Agent Reporter](https://andrewraisbeck.com/blog/opencode-plugin/) — pipes subagent output/actions to stdout (observability, not dispatch).
  - Goal plugin **defers to the host's native Task children** (`defer_while_tasks_active`, `max_task_block_seconds` ceiling so "an unobservable child cannot stall a goal indefinitely") instead of reimplementing child lifecycle.
- Pattern verdict: on v2, community dispatch either (i) rides the **native `subagent` tool** (host owns block/wake/interrupt/recovery), or (ii) like us, creates child sessions via the SDK and then owns wake (per-session SSE `session.events`, `experimental wait`, `session.execution.succeeded`/`session.idle`) and kill (**`interrupt`**, or `remove` for recursive cleanup). Goal plugin wake channels verbatim: "Continuation is driven by V2 `session.execution.succeeded` events and legacy `session.idle` / `session.status` idle notifications"; "native `session.retry.scheduled` events cancel plugin recovery".

---

## 5. Contradiction flags vs the planned fix (explicit)

1. **(b) `session.abort` does not exist on host 2.3.2.** Live OpenAPI: no `/abort` path anywhere; the endpoint is `POST /api/session/{sessionID}/interrupt` (§2.2). SDK 1.18.32's `abort` types (`/session/{id}/abort` v1-gen; `/session/{sessionID}/abort` v2-flat) are a different surface/generation. → Wire `abortChild` on the v2 adapter as **`ctx.session.interrupt({sessionID})`** (promise layer; returns `{interrupted}` per docs) with an **HTTP fallback `POST {service.url}/api/session/{sid}/interrupt`** using the already-implemented `discoverServiceHttp()`. Consider a stronger mode: `DELETE /api/session/{sid}` (`session.remove` — stops execution + recursively deletes children). Also fix the stale header comment `dispatch-async.ts:13`.
2. **(a) No contradiction — but note the sanctioned v2-native cleanup already exists in our own setup path** (`plugin.ts:9301–9306`): the v1-form `dispose` (`plugin.ts:6481`) doing `jobManager.disposeAll()` is the outlier vs both our v2 cleanup and the documented contract ("resources the plugin owns"). Dispose also fires at unpredictable times (hot reload on any watched file write — #42898; teardown races — #16626), and a reload **cancels pending forms/permissions**, so dispose-time ask-adjacent work is doubly unreliable.
3. **(c) No contradiction — but the honest outcome is currently unreadable**: `normalizeV2MessageRow` drops `idle` rows (`plugin.ts:8693`), so `outcome: "interrupted"` never reaches the wake path. To word wakes honestly, surface `Session.Message.Idle.outcome` and/or subscribe to `session.execution.interrupted` (`reason: user|shutdown|superseded|inactivity`). Host-native wording to mirror: outcome `interrupted`; native tool message "Subagent **cancelled** (sessionID: …)". Note the goal plugin's split: reason `user` → terminal `cancelled` state; `shutdown`/`superseded` → only suppress local continuation, do **not** cancel persisted state — a directly reusable semantic for "dispose ≠ user abort".
4. **NEW RISK — `task` deny seal may be dead on v2.** `dispatch-async.ts:50–54` sends `TASK_DENY_PERMISSIONS_V2 = [{action: "task", resource: "*", effect: "deny"}]`. The v2 permission action for subagent dispatch is **`subagent`** (official action table §3.1; native tool asserts `action: "subagent"`). The probe that verified the *spelling* landed on the child record did not verify the *action name* matches what the native tool asserts. If 2.3.2 already uses `subagent`, our nested-dispatch guard is inert against the native tool (it would still block our own v1-named checks). Recommend adding `{action: "subagent", resource: "*", effect: "deny"}` alongside (fail-soft dual spelling, same pattern as the existing v1+v2 seal pair). By contrast, `action: "question"` **is** a valid v2 action (resource `*`) — that seal stands.
5. **`prompt_async` does not exist on 2.3.2** (no such path live; only `POST /api/session/{id}/prompt`). The v2 adapter's blocking-send approximation is the only channel; `dispatch-async.ts:9` comment is stale for this host. Durable admission with `resume: false` (native subagent background mode) is the host-blessed fire-and-forget shape if we ever get the promise-layer spelling.
6. **`external_directory` default flipped on v2** (allow-by-default; v1 asked) — relevant to any future sandbox-escape seals, per the permissions doc warning.
7. **Minor:** SDK 1.18.32 `Session3.interrupt` says `204 void`; live 2.3.2 returns `200 {interrupted}` and supports `?resume=`. Code against the live shape; parse the body defensively.

---

## Appendix — evidence index

- Local files: `node_modules/@opencode-ai/plugin/dist/index.d.ts` (Hooks 173–322; PluginInput 36–46); `…/plugin/dist/tool.d.ts` (ToolContext 2–32); `…/sdk/dist/gen/sdk.gen.d.ts` (Session 106–180; Instance.dispose 90–92); `…/sdk/dist/gen/types.gen.d.ts` (2059–2086 abort; 1751–1757 instance dispose); `…/sdk/dist/v2/gen/sdk.gen.d.ts` (Session2 952+, Session3 1626–1774, Question 833, Permission 865, V2 2205, OpencodeClient 2241); `…/sdk/dist/v2/gen/types.gen.d.ts` (8506–8530 abort; 10175–10204 interrupt; 2122–2143 subtask part); `plugin.ts` (6481, 7487–7559, 8504–8512, 8525–8545, 8569–8671, 8688–8709, 9245–9306); `src/dispatch-async.ts` (9–13, 50–54, 80–129, 936–943).
- Live probe artifacts: `/openapi.json` snapshot at `C:\Users\Soren\AppData\Local\Temp\opencode\openapi-232.json` (142 paths); creds `C:/Users/Soren/.local/state/opencode/service.json` (host 2.3.2, `http://127.0.0.1:28894`).
- Web: <https://opencode.ai/v2/docs/build/plugins/server.md>; <https://opencode.ai/v2/docs/build/plugins/migrate-v1.md>; <https://opencode.ai/v2/docs/permissions.md>; <https://github.com/anomalyco/opencode/blob/v2/packages/core/src/tool/plugin/subagent.ts>; issues #36762, #42898, #16626, #55272, #54140, #53706, #48138, #50140, #59859, #41730, #54477, #55593, #47817, #51398, #14473, #20823, #3503 (all under github.com/anomalyco/opencode); <https://github.com/prevalentWare/opencode-goal-plugin>; <https://github.com/beremaran/opencode-agent-tree>; <https://kimaki.dev/blog/opencode-v2-migration>; <https://github.com/awesome-opencode/awesome-opencode>; host package `@opencode/cli@2.3.2` (npm global, repository → anomalyco/opencode).
