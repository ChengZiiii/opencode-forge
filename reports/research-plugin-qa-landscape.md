# Research: opencode v2 plugin QA landscape — how plugin authors ACTUALLY test

> Status: IN PROGRESS (incremental write; sections fill as evidence is verified)
> Working dir: opencode-forge. Date: 2026-11-23.
> Method notes: GitHub raw fetches flaky from this environment — evidence gathered via
> npm registry tarballs, GitHub REST API (pinned SHAs), jsdelivr, and rendered-page webfetch.
> Every claim tagged with source URL / file path. Unverified leads marked **[LEAD—UNVERIFIED]**.

## 0. Our gap-mapping baseline (mission input, for reference)

- ~910 unit/integration tests, node --test, stub clients; typecheck.
- Sandbox E2E: REAL opencode host (serve mode, fake USERPROFILE, plugin via config, dist via file:), driven over HTTP.
- Release-gated real-machine canaries.
- Five real misses:
  1. dispose-hook collateral kill across sessions (single-context sandbox never triggered).
  2. SDK-type vs live-host drift (SDK: session.abort; live 2.3.2: only interrupt).
  3. Host message-shape drift (bare rows vs info-wrapped); unit stubs encoded wrong shape.
  4. ask/permission channel untestable without a client in non-interactive modes.
  5. Plugin-dispatched vs host-native subagent channel semantic differences.

## Q1. Verified plugins' test architectures (mechanism-level)

### 1.1 @prevalentware/opencode-goal-plugin — `smoke:v2` against a real private v2 server

**Sources (all verified verbatim):**
- `scripts/smoke-v2-lifecycle.ts` (16,581 B, blob `28ad7cd7`, repo gitHead `5f206b2`) — fetched via GitHub blob API, full text read.
- `.github/workflows/ci.yml` (6,400 B, blob `74c09573`) — fetched via GitHub blob API, full text read.
- `package.json` scripts via `npm view` (npm registry metadata, 0.1.101).
- Tree map: https://api.github.com/repos/prevalentWare/opencode-goal-plugin/git/trees/5f206b2169751e0d50eaa92c54acc0755b6bffec?recursive=1

**Mechanism (smoke-v2-lifecycle.ts) — how the host is booted/pinned/isolated/driven:**

1. **Deterministic local fixture model, not a real provider**: `const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {...} })` — an OpenAI-compatible chat-completions endpoint (streaming SSE + non-streaming) that scripts a two-phase conversation (create_goal tool call → text milestones → update_goal complete on the 2nd continuation). Every model request is dumped to disk: `await writeFile(join(root, 'model-request-${modelCalls}.json'), ...)`.
2. **Host config via file**: writes `config/opencode/opencode.json` with `providers.fixture.settings.baseURL = http://127.0.0.1:<port>/v1`, `model: "fixture/fixture"`, `snapshots: false`; the plugin is loaded either as a local stub file (`export { default } from <file:...dist/server.js>`) or, in registry mode, installed via `opencode plugin add <pkg>` **through the CLI under test**.
3. **Env hygiene — the key isolation trick** (verbatim comment): *"Use a clean environment, not a spread of process.env (which may carry a live OPENCODE_DB, server connection settings, provider credentials, or config)."* — constructs env from scratch: `HOME/XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME` → temp root; `OPENCODE_DB` → temp sqlite; **`OPENCODE_PASSWORD: crypto.randomUUID()`** (server auth secret); `FIXTURE_API_KEY` random.
4. **Boot**: `const binary = process.env.OPENCODE_V2_BIN ?? "opencode2"`; version-probe first (`binary --version`), then `spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, detached: process.platform !== "win32" })` — **ephemeral port parsed from stdout** (`waitFor("server-ready", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))`).
5. **Process-tree cleanup is itself asserted**: POSIX — kill the whole detached process group (`process.kill(-pid, "SIGKILL")`) and poll until the group is gone (`"Server process group survived cleanup"`); Windows — `taskkill /PID <pid> /T /F` with bounded wait + explicit "Cannot verify Windows descendants after the server exited" guard.
6. **HTTP driving with auth**: every API call carries `authorization: Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` — the sanctioned programmatic auth for a throwaway host.
7. **Multi-location / multi-context assertions (directly relevant to our miss #1)**: creates a SECOND project dir on the SAME server and activates the plugin there too — verbatim comment: *"The user's shared server hosts many locations. Activating a second plugin instance must not duplicate continuation delivery for the first location."* It waits per-location for `/api/plugin?location[directory]=...` to show `state.status === "active"`.
8. **Lifecycle drive**: create session (`POST /api/session` with location+model+agent) → fire slash command via `POST /api/session/{id}/command` (with a **compat shim for host drift**: `const commandField = hostVersion.includes("0.0.0-beta-") ? "command" : "name"` — "Stable V2 reads `name`; 0.0.0 beta hosts still read `command`") → poll goal state file + `GET /api/session/{id}` (`.data.outcome`) + `GET /api/session/active` → on session failure pulls `GET /api/session/{id}/export` for diagnostics.
9. **Failure forensics**: per-stage `waitFor(stage, check, diagnose)` with last-observed values ("a bare timeout cannot say which final condition was stuck"); on failure writes `failure-summary.json` and copies the whole temp root to `OPENCODE_SMOKE_ARTIFACTS_DIR` for CI upload.

**CI host matrix (.github/workflows/ci.yml) — the version-pin answer (Q3):**

- `v2-smoke` job, `strategy.matrix.channel: [pinned, beta]`:
  - `pinned`: `version=$(node -p 'require("./package.json").devDependencies["@opencode/plugin"]'); npm install -g "@opencode/cli@$version"` — **the host binary version is pinned to the plugin's own SDK devDependency version** (SDK floor = host floor, one source of truth).
  - `beta`: `npm install -g @opencode/cli@beta` — **rolling canary against the host's current beta channel** (drift catcher).
  - `OPENCODE_SMOKE_TIMEOUT_MS: 120000`, artifacts uploaded `if: failure()`.
- `tui-compatibility` matrix `peer: [minimum, host]`: installs `@opentui/core|solid` at the declared minimum (0.5.8) vs the host theme's current version; `OPENCODE_TEST_HOST_THEME` flag switches fixtures — **peer-dependency floor testing, not just latest**.
- `node-runtime` matrix (22.13.0 / 24), dedicated **Windows runner job** (`blacksmith-2vcpu-windows-2025`) running `test/windows-rename.test.ts` + concurrency/lock tests with `OPENCODE_REQUIRE_WINDOWS_TEST: "1"` (platform-specific tests that no-op elsewhere).
- `test/setup.ts` (verbatim): every unit suite gets `mkdtempSync` state dir, sets `process.env.XDG_DATA_HOME` + `OPENCODE_GOAL_STATE_PATH`, removes on exit — suite-level state isolation.

**Unit-test corpus shape (tree):** `test/server.test.ts` (197 KB) + `test/server-v2.test.ts` (185 KB) — v1 and v2 host abstractions tested as **separate parallel files**, i.e. the plugin maintains a per-major-version server test suite; plus `test/harness.test.ts` (tests the test harness itself), `test/fixtures/host-theme.ts`, `test/fixtures/state-worker.ts` (out-of-process state worker fixture), `test/package.test.ts`, `test/dependencies.test.ts` (dep-graph/package sanity), `test/state-process.ts`, `test/state-read-gate.ts`.

**Engines pinning:** `"engines": { "opencode": ">=0.0.0-beta-0 <0.0.0 || >=1.17.1" }` (npm metadata) — deliberately odd `"<0.0.0"` term; devDeps pin `@opencode/client|plugin|schema|theme` at **2.3.0** while ALSO carrying `@opencode-ai/plugin ^1.17.1` — dual-SDK development.

### 1.2 opencode-navigator — host-version CI matrix (floor 2.2.6 / latest 2.3.2)

**Sources:**
- `npm view opencode-navigator --json` (1.1.0) — full scripts + devDependencies + engines (verbatim below).
- npm tarball downloaded + listed: https://registry.npmjs.org/opencode-navigator/-/opencode-navigator-1.1.0.tgz (57 files; includes `HOST_API.md`, `PROVIDERS.md`, `dist/runtime-dependencies.json`, `dist/runtime-requirements.json`, `scripts/snapshot-runtime.mjs`, `scripts/snapshot-verifier.mjs`, `scripts/update-local-snapshot.mjs`).

**Verified from npm metadata:**
- `engines: { "opencode": "^1.19.5 || ^2.2.6" }` — **dual host major support declared in engines**; devDeps carry BOTH SDK generations: `@opencode-ai/sdk ^1.19.5`, `@opencode-ai/plugin ^1.19.5` AND `@opencode/client ^2.2.6`, `@opencode/plugin ^2.2.6`.
- QA scripts (verbatim from npm metadata):
  - `"test:e2e": "bun run build && bash scripts/smoke-opencode.sh && bash scripts/smoke-opencode-v2.sh"` — split as `test:e2e:v1` / `test:e2e:v2` (**one smoke script per host major**).
  - `"check"` (runs on `prepublishOnly`) = test + test:gui + typecheck + lint + bundle:size + format:check — a full release gate.
  - `"test:gui": "bun test --conditions browser test/gui"` with `@playwright/test` devDep — GUI E2E.
  - `"bundle:size": "bun run scripts/check-bundle-size.ts"`; screenshots capture + `--verify` modes.
  - **`scripts/snapshot-runtime.mjs` / `snapshot-verifier.mjs` / `update-local-snapshot.mjs`** + `dist/runtime-dependencies.json` / `runtime-requirements.json` — a host-runtime snapshot/verify subsystem (details pending extraction below).

(pending: HOST_API.md QA sections, GitHub workflows, smoke-opencode-v2.sh body)

**Navigator GitHub CI (`.github/workflows/ci.yml`, blob `5eb9f102`, fetched verbatim) — dual-endpoint host matrix:**

- Job `opencode-smoke-v2` ("OpenCode 2.x (2.2.6)") installs `expect`, then runs the smoke TWICE when endpoints differ (verbatim, same pattern for the v1 job):
  ```yaml
  NAVIGATOR_HOST_ENDPOINT=minimum bash scripts/smoke-opencode-v2.sh
  if [[ "$(node scripts/host-versions.mjs v2 minimum)" != "$(node scripts/host-versions.mjs v2 latest)" ]]; then
    NAVIGATOR_HOST_ENDPOINT=latest bash scripts/smoke-opencode-v2.sh
  fi
  ```
  Comment: *"Stable ruleset context. This job now requires both host endpoints."* — **floor AND latest of every supported host line are both release-gating**.
- Job `headless-contracts`: `bun test test/headless-boundaries.test.ts test/host-port-contracts.test.ts test/lease-pool.test.ts test/monitoring-runtime.test.ts` — includes a dedicated **host-port contracts** unit suite (see below).
- Job `desktop-smoke` (matrix normal/quota, `ubuntu-24.04-arm`, 40min timeout): "Verify packed plugin in isolated Desktop" — runs the GUI smoke against the **packaged, checksum-verified Desktop app at both endpoints under Xvfb** (HOST_API.md line 61: "Verification uses an npm-style tarball in the official checksum-verified Linux ARM64 Desktop packages at both endpoints under Xvfb").

**`scripts/host-versions.mjs` (blob `13c31688`, fetched verbatim) — the pinning mechanism:**
```js
const sdk = { v1: '@opencode-ai/plugin', v2: '@opencode/plugin' }
// minimum = floor of the caret range in peerDependencies; latest = lockfile-resolved version
const range = metadata.peerDependencies[name]; const minimum = /^\^(\d+\.\d+\.\d+)$/u.exec(range)?.[1]
const { version: latest } = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`...)))
assert.equal(metadata.engines.opencode, [sdk.v1, sdk.v2].map((peer) => metadata.peerDependencies[peer]).join(' || '))
```
- **Matrix endpoints derive from the package manifest itself**: `minimum` = caret floor of the SDK peerDependency (2.2.6), `latest` = the lockfile-pinned SDK (2.3.2). A unit-test-grade assert keeps `engines.opencode` and the peer ranges consistent. HOST_API.md: *"The lockfile resolves 1.19.6 and 2.3.2 for reproducible checks. The required CI checks cover both endpoints in each line. Published SDK declarations and real-host checks define the boundary."*

**`scripts/smoke-opencode-v2.sh` (blob `29266e08`, 13 KB, fetched verbatim) — mechanism:**
1. **Host binary version gate**: desired version from `host-versions.mjs v2 ${NAVIGATOR_HOST_ENDPOINT:-latest}`; probes local `opencode2`/`opencode`/homebrew wrapper `--version`; on mismatch installs the EXACT host into the sandbox — `npm install --prefix "$temporary/opencode-v2" --no-package-lock --no-save "@opencode/cli@$host_version"` — and re-verifies the resolved `--version` equals the target, else exit 1. (Host and SDK share a version line: `@opencode/cli@X` ↔ `@opencode/plugin@X`.)
2. **Config env nuking** (beyond goal-plugin's clean-env): `unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_TUI_CONFIG OPENCODE_TUI_CONFIG_CONTENT OPENCODE_CLI_CONFIG` + `OPENCODE_DISABLE_PROJECT_CONFIG=true OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_LSP_DOWNLOAD=true OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_TERMINAL_TITLE=true` + all HOME/XDG_*/OPENCODE_CONFIG_DIR → temp dirs.
3. **Fixture model prevention by policy**: server `opencode.json` includes `"policies": [{ "action": "provider.use", "resource": "*", "effect": "deny" }]` — the host itself refuses all provider use; no fixture model server needed for TUI legs. `cli.json` sets `"session": { "permissions": "autoaccept", "sidebar": "auto" }` — **the sanctioned way to pre-answer the permission channel in tests** (our miss #4).
4. **Fake external-binary tripwires**: writes a synthetic `gh` on PATH that records invocation attempts into `$NAVIGATOR_SMOKE_GH_ATTEMPTS`; post-run assertion: "The smoke must not submit GitHub reports."
5. **TUI drive via `expect` (Tcl)**: spawns `opencode2 <workspace> --standalone --session <id> --print-logs --log-level error` in a 40x120 PTY; sends terminal capability escapes (OSC-10/11 colors, DA responses, kitty keyboard `CSI ?0u`, synchronized output); asserts rendered strings ("Navigator settings", "Add Quick Action", "Search Everything"...); sources per-feature `.tcl` probe scripts (`smoke-about.tcl`, `smoke-toolbar-content.tcl`, `smoke-native-todo.tcl`).
6. **State assertions on disk, not pixels**: plugin writes `preferences.json` marker — asserted via `bun --eval` JSON checks (`onboardingCompleted: true`, `user.toolbarPins` contains "Smoke label"); server-config JSONC edit asserted to PRESERVE a synthetic leading comment (`// Synthetic configuration comment preserved by native Todo setup`) — verifying the plugin's config edits don't clobber unknown content; transcript ANSI-stripped then grepped for `failed to load.*opencode-navigator`.
7. **Second-launch leg**: mutates `cli.json` (`start_in_chat: true`) via script, re-launches the TUI against the SAME session id, asserts `tabs.json` state shows the new chat — config-reload + persistence across host restarts.

**`scripts/smoke-v2-session.mjs` (blob `6b60e948`, fetched verbatim) — headless serve bootstrap:**
- Boots `spawn(bin, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'])` — **`serve --stdio` emits one JSON line `{url}` on stdout** (ephemeral port without log-scraping!). Env: `OPENCODE_PASSWORD` + `OPENCODE_SERVER_PASSWORD` (both) = random base64url; Basic auth header on every call.
- **Plugin-activation probe** (verbatim comment): *"2.3 starts plugins asynchronously. Retrying an explicitly unavailable, read-only capability in the same server proves activation, not just boot."* — polls the plugin's OWN RPC endpoint `/api/rpc/opencode-navigator.quotas/capabilities`, accepting only `ok` or `{"type":"rpc.unavailable"}` until ready.
- **Dual-shape response tolerance** (our miss #3, verbatim): `const id = session.value.data?.id ?? session.value.id` — the same shipped smoke parses BOTH the info-wrapped and bare session shapes.

**`scripts/headless-boundaries.ts` (blob `52ab42e0`, fetched verbatim):** a compile-time architecture contract test using the TypeScript Compiler API — headless model files must not import `node:*|bun:*|electron|@opentui/|@opencode(-ai)?/` nor reference `Bun|process|fetch|window|document|localStorage...`, plus FSD layering rules. Runs as a normal `bun test` in the `headless-contracts` CI job.

**HOST_API.md (npm tarball, `package/HOST_API.md`, 218 lines, read in full) — verified claims:**
- Line 31–36: "Navigator supports stable OpenCode **1.x from 1.19.5** and **2.x from 2.2.6**. ... The lockfile resolves **1.19.6** and **2.3.2** for reproducible checks. The required CI checks cover both endpoints in each line. Published SDK declarations and real-host checks define the boundary; internal host components are not plugin APIs."
- Line 61–63: "Verification uses an npm-style tarball in the official checksum-verified Linux ARM64 Desktop packages at both endpoints under Xvfb. Native macOS/Windows and multiple live Desktop windows are not claimed as real-host coverage" — **explicit, honest coverage-claim boundaries**.
- Line 139–145: a minimal fixture reproducing a Desktop host defect "with Navigator disabled" to prove it is host-native, not plugin-caused; "Interaction smokes keep this native-only probe separate and exercise subsequent plugin commands through the public `commands.run` API."
- Line 147–150: Sources = official docs (opencode.ai/docs/build/plugins/{gui,cli,rpc}) + "the published `@opencode/plugin@2.2.6` declaration archive, audited on 2026-11-10" — they **audit the published SDK .d.ts archive** as the contract source.
- Line 226–233: "Both current hosts have isolated real-host checks. Historical installer fixtures exercise migration only; they do not extend the supported host matrix." + "The 1.x host ships older runtime modules; its actual smoke must pass rather than injecting the development modules into it" — the smoke runs against the host's OWN runtime modules, not dev-installed ones.
- Line 238: "CI and package verification use Node 26.12.1."

### 1.3 oh-my-opencode (code-yeongyu/oh-my-opencode, 71,067★) — documented test harness + QA skills + full-matrix CI

**Sources:** GitHub tree API on branch `dev` (pushed 2026-11-23); blobs fetched verbatim:
`.agents/skills/opencode-qa/references/testing-harness.md` (6,341 B, blob `fe948356`), `.omo/rules/test-discipline.md` (8,091 B, blob `9c1329cc`), `.agents/skills/opencode-qa/scripts/server-smoke.sh` (blob `30e873b7`), `.../tui-smoke.sh` (blob `1e00bdf7`).

This repo doubles as an opencode distribution and ships a **written QA architecture** (a skill teaching "how opencode QAs itself") plus 50+ CI workflows (`ci-full-matrix-label.yml`, `desktop-linux-qa.yml`, `desktop-windows-qa.yml`, `computer-live-windows-full.yml`, `windows-flake-soak.yml`, `.github/ci-test-timings.json`).

**testing-harness.md — the documented layers (verbatim structure):**
1. **Runner + root guard**: `bun test` only from a package dir (root `package.json` test script literally exits 1 — "do not run tests from root").
2. **In-memory bootstrap** (`test/preload.ts` via bunfig `preload`): XDG_* → temp dirs, `OPENCODE_DB=":memory:"`, **"Wipes all provider API keys from process.env"**, `OPENCODE_TEST_HOME`, `Log.init({print:false})`.
3. **Effect harness** (`test/lib/effect.ts`): `it.effect` (TestClock+TestConsole = deterministic time), `it.live`, `it.instance` (real scoped tmpdir + real Instance); `testEffect(layer)` binds a whole Effect layer.
4. **Instance fixtures** (`test/fixture/fixture.ts`): `tmpdirScoped({git,config,init})`, `provideInstance(directory)`, `withTmpdirInstance(...)` — real host instance per test with optional git init + config injection.
5. **CLI subprocess harness** (`test/lib/cli-process.ts`): `cliIt.live` spawns the real CLI with isolation env (`OPENCODE_TEST_HOME`, `OPENCODE_CONFIG_CONTENT` inline config, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, **`OPENCODE_PURE=1`**, `OPENCODE_DISABLE_{AUTOUPDATE,AUTOCOMPACT,MODELS_FETCH}=1`); helpers `opencode.run()/.serve()/.acp()`, `expectExit`, `parseJsonEvents`. Example cited: `cliIt.live("spawns serve and health responds", ...)` fetching `/global/health`.
6. **Fake LLM server** (`test/lib/llm-server.ts`): in-process OpenAI-compatible SSE — `llm.text("hello")`, `llm.tool("read", {...})`, `llm.pushMatch(matchFn, reply)`.
7. **Playwright e2e** for the app package (Vite webServer + backend at `localhost:4096`).
8. Style: **"Avoid mocks where possible. Test the real implementation. Do not duplicate logic into tests."**

**server-smoke.sh (verbatim checks):** isolated XDG sandbox + random password (`oqa_start_server`); then (1) `GET /global/health` → `healthy:true` + version; (2) **`GET /doc` → OpenAPI spec, asserts `.paths | length >= 100`** — the host publishes its live OpenAPI surface, making contract-snapshot diffs trivially scriptable; (3) unauthenticated `GET /session` → **HTTP 401 asserted (auth enforcement is itself tested)**.

**tui-smoke.sh (verbatim mechanism):** launches the TUI under **tmux** in the isolated sandbox; polls `capture-pane` for render markers (version string / "Ask anything" / ctrl+p); types a sentinel (`oqaXYZ`) and greps the pane to prove input reached the composer; kills the session and asserts `tmux has-session` false; **then opens the REAL user DB with sqlite3 and asserts the session count is unchanged ("real DB untouched")** — sandbox leakage is an explicit test assertion.

**test-discipline.md ("NON-NEGOTIABLE", fires on every test-file edit via globs):** the QA culture codified:
- *"Every test in this repo MUST pass `bun test` in one process, in one go — no isolation flags, no retries, no special ordering."*
- *"FLAKY = FAILING — A test that passes 9 of 10 times is failing 10% of the time."*
- **Subscribe-first, timeout-bound event testing**: "Register the listener BEFORE you trigger the action... Race against an explicit timeout. On timeout, fail with a useful message... The timeout is a circuit breaker, not a synchronization primitive."
- No sleeps in test bodies; no `.only`/reordering/isolation to mask leaks ("Cross-test contamination = state leak. Find the leak.").
- Authoring gate (4 questions incl. "What credible regression makes it fail?"), a junk-pattern blacklist (assertion-free probes, self-comparisons, export inventories, **"expected values produced by the code under test"**, "mocks that implement the asserted behavior"), and a prose-test ban: **"DO NOT write a test that asserts what the prose SAYS"** — test the machine-consumed value or write no test.

Also notable in tree: `kuitos/opencode-claude-memory` (84★) ships a **test/evals/** harness (`cases/sanitized-replay.json`, `judges.ts`, `task-eval.test.ts`) — recorded-session replay + LLM-judged evals as a community pattern; `joshuadavidthomas/opencode-agent-memory` (369★) ships plain vitest-style unit suites + `.github/workflows/test.yml` (no host E2E).

## Q2. Official testing surface (host repo + docs)

**Official docs (verified verbatim):**

- Plugin overview (https://opencode.ai/docs/build/plugins): *"Use versions compatible with the OpenCode release you target, and **test the installed package, not only a workspace-linked copy**. Publish a compatible plugin update when you adopt a newer API contract."*
- V1/V2 dual-support guidance (server docs page, migration section): *"The V1 object form is supported in OpenCode `1.18.29`. Older V1 releases may expect function exports instead; **test the installed package with the oldest V1 release you intend to support and with V2**."* — official docs explicitly mandate host-endpoint-matrix testing of the installed artifact.
- **No dedicated "testing plugins" doc page exists** — the docs tree (`/docs/build/plugins{,server,cli,gui,rpc,migrate-v1}`) has no testing/fixtures section; the sanctioned surfaces below are documented individually but never assembled into a testing recipe. (Checked via full read of the plugins + server pages; grep for "test|fixture|smoke" in the saved server page hits only the two lines above.)

**Sanctioned throwaway-host boot surface (verified from two independent plugin smoke implementations, not docs):**

- `opencode serve --hostname 127.0.0.1 --port 0` — ephemeral port; URL printed on stdout (goal-plugin parses the log line).
- **`opencode serve --stdio --hostname 127.0.0.1 --port 0`** — navigator's `smoke-v2-session.mjs`: first stdout line is JSON `{url}` (machine-readable, no log scraping). Env: `OPENCODE_PASSWORD` (+ `OPENCODE_SERVER_PASSWORD` set both in their harness) = Basic-auth password for `user opencode`.
- Per-test isolation env: `HOME`, `XDG_{CONFIG,DATA,STATE,CACHE}_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB` → temp; `OPENCODE_DISABLE_{PROJECT_CONFIG,AUTOUPDATE,LSP_DOWNLOAD,MODELS_FETCH,TERMINAL_TITLE}=true`; unset `OPENCODE_{CONFIG,CONFIG_CONTENT,TUI_CONFIG,TUI_CONFIG_CONTENT,CLI_CONFIG}` (all observed in navigator's smoke script; goal-plugin uses the clean-env-from-scratch variant with the explicit comment about not spreading process.env).
- **Programmatic permission/ask driving (official API, docs/server.md "Permissions")**: `ctx.permission.assert(...)` (prompts when a rule resolves to `ask`), plus **`ctx.permission.list({sessionID})` / `ctx.permission.get(...)` / `ctx.permission.reply({sessionID, requestID, decision: "once"})`** — a plugin-side scripted permission responder is a first-class API. Session-scoped rules can be pre-armed via `ctx.session.update({sessionID, permissions:[{action,resource,effect}]})`. Host-level test config: navigator's `cli.json` uses `"session": {"permissions": "autoaccept"}` and server `opencode.json` uses `"policies": [{"action":"provider.use","resource":"*","effect":"deny"}]` to make provider calls impossible.
- Plugin lifecycle contract (docs/server.md "Lifecycle"): *"`setup` runs when the plugin loads. It may return a cleanup function that runs when the plugin unloads."*

**How the host repo tests plugin lifecycle itself (anomalyco/opencode, default branch `dev`, head `b705c446` at 2026-11-23; 453 files under `packages/core/test/`):**

- **`packages/core/test/plugin/fixture.ts`** (blob `81063500`, fetched verbatim): exports `makePluginTestLayer()` / `PluginTestLayer` — assembles the ENTIRE real app (App, Bus, Session, Permission, Rpc, Plugin, PluginHooks, Tool, Mcp, Skill, Worktree... ~50 core service nodes) with only the boundaries replaced: `Location.node.replace(tempLocationLayer)`, stubbed `Npm.Service`, `Config.testLayer()`, `emptyMcpLayer`, stubbed `Generate.Service`, and a **stubbed `Permission.Service`** whose `ask` auto-succeeds (`ask: (input) => Effect.succeed({ id: ..., effect: "ask" })`, `reply: () => Effect.void`). Plugin lifecycle tests therefore run the REAL plugin supervisor against the REAL core services in-process — no host boot, no HTTP.
- **`packages/core/test/plugin-failure.test.ts`** (blob `a800b5d8`, fetched verbatim) — the host's OWN tests for exactly our miss-#1 defect class (plugin failure/cleanup collateral):
  - `"removes a failed plugin's hooks and RPC handlers without affecting healthy plugins"` — activates `broken` + `healthy`, forces `broken`'s transform to fail on reload, then asserts hooks/RPC/commands of `healthy` still work and `plugins.list()` shows `["failed","active"]`.
  - `"does not join queued failed-plugin cleanup during reload"` / `... during teardown"` — a failing plugin's finalizer that awaits `plugins.awaitActivation` must NOT deadlock the reload/teardown boundary (250ms timeout assertions).
  - `"preserves pending/reported failures when an earlier plugin changes"` — failure state survives other plugins' re-activation, reordering, and removal; failed plugin is not re-run until its own revision changes.
  - `"settles readiness before shutdown joins a disabled plugin's finalizers"`.
- Adjacent core suites: `packages/core/test/plugin/supervisor.test.ts` (19.8 KB), **`supervisor-reload.test.ts` (17.8 KB)**, `plugin.test.ts` (28.1 KB), `permission-assert.test.ts`, `promise-tool-cancel.test.ts` (tool `context.signal` cancellation), `session-remove.test.ts`; fixture plugins under `packages/core/test/plugin/fixtures/` (`greeting.ts`, `provider-factory.ts`). The v2 SDK package itself (`packages/plugin`) ships only 4 tests (`test/host.test.ts`, 3 gui tests) — the SDK's surface is tested mainly through core's suite.
- **`packages/http-recorder`** (README fetched verbatim) — an OFFICIAL, published cassette system: *"Record real Effect HTTP and WebSocket traffic once, then replay it from deterministic JSON cassettes... for provider integrations, retries, polling, multi-step flows, and any test where hand-written HTTP mocks hide too much of the real request shape."* Key semantics: first local run records (`test/fixtures/recordings/<name>.json`); **"When `CI=true`, missing cassettes fail instead of recording"**; no public overwrite mode ("Deletion makes the set of recordings being refreshed visible and reviewable"); redaction by default incl. credential scanning ("Unsafe cassettes fail without replacing an existing recording"); request matching with canonically-compared JSON, one-claim-per-interaction, unused-interaction failure on layer close; explicit limits (no streaming-timing/backpressure assertions). Companion `packages/simulation` provides a simulated OpenAI-compatible provider backend (`src/backend/simulated-provider.ts`, `openai.ts`) used for deterministic agent-loop tests.
- Recorded-fixture culture: `packages/ai/test/fixtures/recordings/**` (hundreds of provider-response JSON recordings, e.g. `alibaba-chat/qwen-3-8-max-*.json`), `packages/core/test/plugin/provider/claude-agent/fixtures/recordings/*.jsonl` — the host replays REAL provider transcripts (incl. `tools-abort.jsonl`, `tools-cancel.jsonl`, `text-resume.jsonl` — cancellation/resume flows tested from recordings).

## Q3. Version-matrix / drift defense (pinning, contract snapshots, "SDK type lied" precedents)
(pending)

## Q4. Coverage map: our five misses vs community/official patterns
(pending)

## Q5. Ranked recommendations (effort vs catch-value) + adoption sketch
(pending)

## Appendix: raw evidence dumps / fetch logs
(pending)
