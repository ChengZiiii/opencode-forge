# Tasks

## 1. Sandbox probe (gate)

- [x] 1.1 Probe: register a hyphenated command (`forge-sync`) on a 2.3.2 sandbox serve; assert it appears in `/api/command`. If rejected, STOP per design D3 fallback and record the finding here before proceeding with the rest. **GATE PASSED 2026-11-22** (`scripts/hyphen-command-probe.mjs`, exit 0). Field realities (2.3.2): ① hyphenated name accepted — `forge-sync` registered via `ctx.command.transform` editor.add and listed in `GET /api/command?location[directory]=<dir>`; ② `POST /api/session/:id/command {name, text, delivery}` → 204, and `execute` receives `{sessionID, prompt:{text}, delivery}` verbatim (typed args DO reach plugin commands; bug③ pipeline confirmed); ③ the promise-layer `ctx.session.prompt` ACCEPTS an extra `delivery` key (no SchemaError — passthrough is safe, the defensive schema-retry path stays as drift insurance); ④ `command.list` is LAZY-location-scoped: the first query right after activation returns `[]`, a subsequent query lists the registered command (probe: first ws query `[]`, post-activation query lists forge-sync); ⑤ standalone serve auth: `/api/info` bare → 401, `Basic opencode:<pw>` accepted — the random password prints to stdout (block-buffered when piped: unreliable) and persists to `<XDG_CONFIG_HOME>/opencode/service.json`; ⑥ config `plugin` file:// entries must point at a DIRECTORY package (single .mjs dropped with "configured plugin path must be a directory" — probe ships as probe-pkg/ per the npm-postpublish-e2e precedent); ⑦ reused sandbox ports carry TIME_WAIT heels after a kill (bind fails for minutes) — the probe derives a per-run port from the pid.

## 2. Shared route bodies

- [x] 2.1 Extract the sync / init / init-global route bodies from `FORGE_COMMAND_TEMPLATE` into per-lever template functions; `/forge`'s routing template consumes them (no behavior change for v1). Byte-identity pinned by `tests/command-surface.test.mjs` ("routing template embeds the single-source lever bodies verbatim") + all pre-existing template-content tests unchanged-green.

## 3. Dedicated commands (both entries)

- [x] 3.1 Register `forge-sync` / `forge-init` / `forge-init-global` in the v2 command domain with per-lever descriptions. (wiring: "v2 command domain registers the dedicated hyphenated family")
- [x] 3.2 Register the same three commands in the v1 config hook (plain templates, no `$ARGUMENTS`). (wiring: "v1 config hook registers the hyphenated family", no-clobber asserted)

## 4. Argument delivery on v2

- [x] 4.1 In the v2 `execute`, read `input.prompt.text`; implement composition: `$ARGUMENTS` function-replacement, append-after-blank-line fallback, empty ⇒ template unchanged; pass `delivery` through. (`composeCommandPrompt` exported; matrix tests for replace-all+$&-literal, append, empty/null/undefined; delivery passthrough asserted incl. no-key-fabrication; schema-retry disclosed degradation for drifted hosts.)
- [x] 4.2 Narrow the registration drift `catch` to emit a console warning naming the domain and error head. Also disclosed: the editor-without-add drift (was an early-return silent no-op — same incident class).

## 5. Tests

- [x] 5.1 Unit: composition matrix — replacement (incl. `$&` literal in args), append fallback, empty/whitespace arg, multiple `$ARGUMENTS` occurrences.
- [x] 5.2 Wiring: v2 `execute` receives `prompt.text` → delivered prompt contains the typed argument; dedicated commands present in the registration set with their own descriptions; drift catch emits the disclosure warning.
- [x] 5.3 All existing tests stay green (`node --test tests/*.test.mjs`). **872/872** (the one expectation update: `v2-session-commands` "commands register" now includes the hyphenated family).

## 6. Verification & ship

- [x] 6.1 `bun run typecheck` clean; `openspec validate --all` passes. (typecheck exit 0; validate: all 7 changes valid.)
- [x] 6.2 Sandbox E2E: session.command `forge` with text `sync` → delivered prompt contains `Argument: "sync"`; `forge-sync` invocation delivers the sync template verbatim. Evidence: probe run exit 0 — invoke 204 + `execute-input {sessionID, prompt:{text:"sync"}, delivery:"steer"}` + `prompt-ok withDelivery:true` on 2.3.2; composition correctness covered by the matrix tests (same function the registrar uses); the live-model transcript leg is covered by the existing goal-loop E2E pattern when a provider is attached.
- [x] 6.3 `bun run bundle` (self-contained dist — 880KB, exit 0), README command chapter added (hyphenated family primary, `/forge` fallback).
