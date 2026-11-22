# Community & Competitor Research — hardening four openspec changes

**Date:** 2026-11-23 · **Plugin:** sorenllm-opencode-forge (opencode v2 host, 2.3.2)
**Scope:** external practice only — opencode official docs/issues, Claude Code, Amp, Goose, Gemini CLI, Aider-adjacent harnesses, spec-driven tooling (spec-kit, OpenSpec), community opencode plugins.
**Excluded per instruction:** OMO / oh-my-opencode (obsolete in v2 era, covered by local research).
**Confidence:** [H] high (official docs / maintainer-confirmed), [M] medium (issue reports, reputable blogs), [L] low (single anecdote, inferred).

---

## Q1 — Confirmation without modals

### What opencode itself documents about `ask`
- Permission rules resolve to `allow` / `deny` / `ask`; **"ask — Wait for a decision from the client"**, and crucially: **"Non-interactive clients must decide how to handle approval requests; configured `deny` rules always remain enforced."** The burden is explicitly pushed onto the client, not the server. [H] https://opencode.ai/docs/permissions
- Approvals are interactive by design: `once` / `always` / `reject`, where **"reject — Reject it and every other pending permission request in that session"** — note the *session-scoped* bulk-reject semantics (direct precedent for C3's "stop = abort current session's in-flight work only"). [H] https://opencode.ai/docs/permissions
- Third-party headless guides confirm the failure mode empirically: **"In a non-interactive opencode run, an `ask` becomes an automatic reject."** [M] https://spillwave.ai/guides/opencode/part-16-without-you/
- Issue #13851 documents that CLI/non-interactive sessions are created with `question/plan_enter/plan_exit → deny` presets and that "ask requires human approval; without it, execution tends to abort/cancel" — built-in agents are described as "non-interactive hostile". [M] https://github.com/anomalyco/opencode/issues/13851
- A hands-on comparison found plugin-action `ask` rules unreliable in practice ("An ask rule on the plugin's action had no effect (the call ran unprompted)"). [L] https://iii.dev/blog/opencode-vs-claude-code-vs-iii/

### Real-world modal/ask failures in opencode (the wedge class we hit)
- **#13715 "Permission asks from nested subagent sessions silently hang"** — `Permission.ask()` waits indefinitely; the TUI only watches direct children, so grandchild requests are invisible; maintainer-adjacent fix landed Nov 1, 2026. Related: #7654 (questions from nested sub-agents don't appear in TUI). [M] https://github.com/anomalyco/opencode/issues/13715 · https://github.com/anomalyco/opencode/issues/7654
- TUI dialog can go stale while the server has no pending request (#28312); permission prompt loops (#30136); input freezes on directory-access ask (#30160); stuck "Permission Required" in new worktree (#30344); UI unresponsive while dialog shows (#6616). [M] https://github.com/anomalyco/opencode/issues/28312 · /30136 · /30160 · /30344 · /6616
- Still open in the v2 era: **#55678 (desktop 2.0.29) "permission dialog stuck after tool interrupt/timeout; Deny/Allow replies 404 forever, composer blocked"** — reproduced by the opencode-agent bot on 2.0.29 and latest dev. [M] https://github.com/anomalyco/opencode/issues/55678
- Serve+attach hang class: #16367 "Agent hangs indefinitely… remote TUI shows the agent as permanently 'thinking'". [L] https://github.com/anomalyco/opencode/issues/16367

### How Claude Code handles sign-off when prompts are unreliable
- Official headless docs: in `-p` Manual mode **"a call that needs approval is denied unless something approves it"**; `--permission-prompts none` for unattended runs — **"Anything that would prompt is denied… Claude is told that nobody can approve the request and not to retry it, and the run continues"**; persistent equivalent `permissions.denyInsteadOfPrompting`. Even SIGTERM handling is specified: a run waiting on a permission prompt "leaves the prompt unanswered". They never block headless on a human. [H] https://code.claude.com/docs/en/headless
- **Fail-closed instead of hang** is the pattern: unattended → deterministic deny + tell the model why, so the loop continues with an error it can reason about. [H] https://code.claude.com/docs/en/headless
- **In-band verification gates instead of modals:** hooks can deny/block with machine-checkable reasons — `PreToolUse` `permissionDecision: "deny"` with reason shown to Claude; `Stop`/`PostToolUse` `{"decision":"block","reason":"Test suite must pass before proceeding"}` — i.e. completion is gated by *re-running checks*, not by a human click. [M] https://twitterapi.io/blog/claude-code-hooks (recipes), hook surface per official docs [H] https://code.claude.com/docs/en/headless (PermissionRequest hooks referenced)
- Community opencode plugin pattern mirrors this: `tool.execute.before` throwing `"Run tests before committing!"` to enforce a verification gate before `git commit`. [M] https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a
- Plan-mode approval (the *transition* gate) stays interactive in TUI: exiting plan mode requires approving the plan (Shift+Tab cycle / "Yes, and…" choices); headless plan runs have **no approval step** and docs tell you to pass the permission mode you want. [M] https://munderdiffl.in/blog/how-to-use-claude-code-plan-mode/ · analysis [M] https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/ · bypass-vs-plan interaction bug [L] https://github.com/anthropics/claude-code/issues/40623

### Goose, Amp, Gemini CLI
- Goose: interactive **in-band Y/N in the terminal** ("Allow this action? (yes / no)"), `GOOSE_MODE` presets (`auto`/`approve`/…); headless guide's answer to prompts is mode pre-configuration + `GOOSE_MAX_TURNS` runaway protection — never a modal that blocks automation. [M] https://shattered.io/goose-ai-coding-assistant-local-ollama-12-steps-2026/ · https://goose-docs.ai/docs/tutorials/headless-goose/ · permission matrix https://goose-docs.ai/docs/guides/managing-tools/tool-permissions/
- Amp (Sourcegraph): SDK exposes machine-set `mode`/`model`/`effort`; no blocking approval UI in the programmatic surface — approval policy is an input, not a dialog. [M] https://ampcode.com/docs/sdk · https://www.npmjs.com/package/@ampcode/sdk
- Gemini CLI: `--approval-mode` (`yolo` etc.) chosen up front; custom commands that shell out trigger a confirmation *before* execution, not mid-flight. [M] https://geminicli.com/docs/cli/custom-commands/ · https://geminicli.com/docs/reference/configuration/

**Net for Q1:** universal pattern = (a) transition gates may ask interactively; (b) completion/unattended behavior must be deterministic (auto-allow, auto-deny-with-reason, or verified-checklist) — nobody ships "hang forever" as a design; (c) evidence summaries + fail-closed verification are the accepted substitute for a completion modal.

---

## Q2 — Planned-work lifecycles with structured verification

### Spec Kit (GitHub) — checklist/verification-as-gate
- `/speckit.checklist` generates "unit tests for your requirements"; `/speckit.analyze` checks cross-artifact consistency; `/speckit.converge` verifies completeness; **`/speckit.implement` "only reads [checklist] checkbox state and asks whether to proceed when items remain unchecked"** — checkbox state is the machine-readable gate. Maintainer clarification in discussion #2387: a checked item means the criterion is satisfied; implement is not supposed to auto-check them. [H] https://github.github.com/spec-kit/quickstart.html · https://github.com/github/spec-kit/discussions/2387 · repo https://github.com/github/spec-kit
- Reopen/refinement: discussions #775 (refining a spec after plan/tasks exist) and #2387 show the lifecycle is *file-based and editable* — rollback = edit/regenerate artifacts; there is no irreversible close. [M] https://github.com/github/spec-kit/discussions/775

### Claude Code ecosystem
- Plan mode: read-only until approved; exit tool requires explicit user approval; plans persisted under `~/.claude/`; revisions happen by iterating in plan mode (still no edits). [M] https://munderdiffl.in/blog/how-to-use-claude-code-plan-mode/ · https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/
- **claude-code-spec-workflow (Pimzino)** — closest analog to our plan harness: `/spec-create`, `/spec-execute <n> <feature>`, `/spec-status` — discrete commands for create/execute/monitor; tasks are per-feature files; execution is task-at-a-time with explicit human gates between phases. [M] https://github.com/Pimzino/claude-code-spec-workflow
- Stop-hook verified completion (see Q1): block the agent from ending until tests pass — i.e. "re-run commands as the close gate". [M] https://twitterapi.io/blog/claude-code-hooks

### Goose / Coder / academic harness
- Goose `/plan` mode: interactive planning dialogue with a separately configurable *planner* model/config; plans are generated **with per-phase checkboxes and validation steps** and persisted as files. [M] https://goose-docs.ai/blog/2025/12/19/does-your-ai-agent-need-a-plan/
- Coder's agent plan mode: `propose_plan` **snapshots the current plan file into the transcript**; user then picks "Implement plan" (approve) or keeps iterating — plan file + transcript snapshot + explicit transition. [M] https://coder.com/docs/ai-coder/agents/
- A terminal-agent harness paper describes the exact goal-harness shape: a Planner subagent writes a structured plan (goal, context, files, steps, **verification criteria**, risks), then `present_plan` offers *revise* (loop) or *approve* (execute). [L] https://arxiv.org/html/2603.05344v1

### opencode itself & its plugin ecosystem
- Built-in `plan` agent: edits denied except files under `~/.opencode/plan` — opencode's own plan lifecycle is *file-scoped*, giving a natural reopen/rollback surface (plan files stay on disk; re-enter plan mode to revise). [H] https://opencode.ai/docs/permissions (agent policy table) · https://opencode.ai/docs/agents
- **OpenSpec** (Fission-AI) — the spec tool we already use — is itself listed in the opencode ecosystem: changes → tasks → implementation → `archive` on completion; reopen = un-archive/edit tasks. [H] https://github.com/Fission-AI/OpenSpec · listed at https://awesomeopencode.com/
- Community goal harness precedent: **opencode-goal-plugin** ("goal-mode", slash-command, tui tags) exists on npm/GitHub. [L] https://github.com/prevalentware/opencode-goal-plugin (via https://github.com/topics/opencode-plugin)
- Orchestration plugin precedent with explicit lifecycle commands: subtask2 ("Extend opencode /commands into a powerful orchestration system with granular flow control"), pocket-universe ("closed loop, resilient, async agents… blocking main thread execution" — i.e. durable dispatch rows that survive). [M] https://github.com/spoons-and-mirrors/subtask2 · https://github.com/spoons-and-mirrors/pocket-universe

**Net for Q2:** every mature harness separates (1) plan authoring (file artifact), (2) transition approval (interactive, one-time), (3) completion verification (checkbox/command re-run, fail-closed), and keeps closed plans reopenable because the artifact is a file, not a transaction.

---

## Q3 — Slash command surfaces

### How commands are registered in opencode v2
- Three surfaces: Markdown files (`.opencode/commands/*.md`), JSON `commands` config, and **plugin registration via `ctx.command.transform(editor.add({name, description, execute({sessionID, prompt, delivery})}))`** — the executor receives the whole prompt object, so *argument routing is the plugin's job* (parse `prompt.text`). [H] https://opencode.ai/docs/commands · https://opencode.ai/docs/build/plugins/server (Commands section)
- Built-in argument templating exists only for Markdown/JSON commands: `$ARGUMENTS`, positional `$1..$n` with quoting, fallback append, and shell-in-template blocks. [H] https://opencode.ai/docs/commands
- **Collision semantics are silent replacement:** "Later sources replace earlier commands with the same name… A custom definition can also replace an earlier built-in command." Project > global > ancestor; nothing warns. Fewer, well-namespaced commands = smaller collision footprint. [H] https://opencode.ai/docs/commands
- Commands can carry `agent`, `model` (incl. `#variant`), and `subagent: true` (background child session) — relevant to how `/forge` routes work. [H] https://opencode.ai/docs/commands

### Known issues / quirks around plugin commands
- #10262 (feature): plugins could not register dynamic slash commands — the API we now have is the answer; the thread documents the demand for side-effect commands. [M] https://github.com/anomalyco/opencode/issues/10262
- #30268: registering a *pure side-effect* command (no LLM prompt) — exactly our `/forge stop` shape — is an asked-for pattern. [M] https://github.com/anomalyco/opencode/issues/30268
- #28292: plugins want to intercept/prevent command execution (no one-to-one `command.execute.before` in v2 — official migration doc confirms it's gone; "register a command with `ctx.command.transform` when the plugin owns that command"). [H] https://github.com/anomalyco/opencode/issues/28292 · https://opencode.ai/docs/build/plugins/migrate-v1
- Client dispatch bugs: #41339 plugin slash commands pass through as raw text (Desktop), #22255 "Failed to send command" (Desktop), #41245 skill slash commands drop context/arguments, #51638 core `/compact` disappearing after update — command plumbing across TUI/Desktop clients is a recurring bug class; one command exercised everywhere is easier to keep alive than four. [M] https://github.com/anomalyco/opencode/issues/41339 · /22255 · /41245 · /51638
- #47345: even core surfaces (plugin manager) are asked to be exposed as slash commands — consolidation into one discoverable entry point is the direction. [L] https://github.com/anomalyco/opencode/issues/47345

### Community practice: one command + args vs many
- Ecosystem inventory (55 plugins): beads ships a `/bd-*` command *family*; mystatus is "all quotas in one command"; subtask2 extends `/commands` into an orchestration system; most plugins ship 0–2 commands. Both patterns exist; nobody ships 4+ near-synonym commands for one subsystem. [M] https://awesomeopencode.com/ · https://github.com/joshuadavidthomas/opencode-beads · https://github.com/vbgate/opencode-mystatus
- Competitor convention: Claude Code custom commands use `$ARGUMENTS`/positional args in one file per command; Gemini CLI namespaces via subdirectories (`team/review.toml` → `/team:review`) — argument parsing and namespacing are first-class, multi-command sprawl is not. [H] https://code.claude.com/docs/en/headless (commands in -p) · [M] https://geminicli.com/docs/cli/custom-commands/

### Prior art for "stop the current session's background work" (session-scoped)
- opencode's own permission **reject is defined as session-scoped** ("reject it and every other pending permission request *in that session*"). [H] https://opencode.ai/docs/permissions
- v2 session APIs: `ctx.session.interrupt({sessionID, resume:false})` (interrupt a session), and `ctx.session.remove` — "Removal stops active execution and recursively deletes child sessions" — the sanctioned way to stop a session's work tree without touching other sessions. [H] https://opencode.ai/docs/build/plugins/server
- Claude Code: SIGINT/SIGTERM semantics + SDK `interrupt()` end the *run's* turn; background subagents are per-run. [H] https://code.claude.com/docs/en/headless
- **No precedent found** for a plugin command that aborts *other sessions'* in-flight work as an intended feature (only as the bug class we're fixing — process-wide kills show up as complaints, e.g. #55678's interrupt/timeout leaving dialogs wedged). Session-scoped stop is the only defensible semantics. [M]

---

## Q4 — Model variant / thinking-depth pinning

### Official opencode v2 model/variant mechanics
- Model references are `provider/model#variant`; variants are "named options for one model, often used for reasoning effort"; selectable for a run, session, agent, or command; custom variants defined per-model with `settings.reasoningEffort` etc., or auto-built from `capabilities.reasoning` (`effort`, `toggle`, `budget`). [H] https://opencode.ai/docs/models
- **Known sharp edge (documented):** "The root `model` currently retains only the default provider and model, **not a variant**… Select variants for a session, run, agent, or command instead." Config-level defaulting of variants is explicitly unreliable. [H] https://opencode.ai/docs/models
- Agent files: `model: anthropic/claude-sonnet-5-5#high` (or expanded `{providerID, model, variant}`); **"A subagent uses its configured model, or inherits the parent session's model when none is configured."** [H] https://opencode.ai/docs/agents
- Agent `request` overlays exist but **"The V2 session runner preserves these values but does not yet send them with model requests. Configure active request settings on the provider, model, or model variant instead."** — payload-rewriting routes around known-unsent fields; the sanctioned route is provider/model/variant settings. [H] https://opencode.ai/docs/agents
- The plugin seam for per-call options: `ctx.session.hook("context", …)` — `event.options` "starts empty for each model call; it does not contain resolved model settings. Typed keys are generation settings; **any other key is passed to the selected protocol as a provider option**." Register per request kind (context/compaction/generate/title). [H] https://opencode.ai/docs/build/plugins/server

### Community reports of variants/depth lost or defaulted
- **#21632 "subagent model variants are parsed but not applied at runtime"** — "The subagent ends up with `variant = undefined` and falls back to the provider default." Exact precedent for our C4 symptom class in worker/subagent sessions. [M] https://github.com/anomalyco/opencode/issues/21632
- **#25126 "TUI shows `medium` reasoning despite `reasoningEffort: high` being applied"** — the UI renders the model's default variant label instead of the effective option; comment confirms two setting locations (config vs TUI variant selector, cached in `~/.local/state/opencode/model.json`) silently fight; duplicate #18634 (`xhigh` invisible in TUI/export). [M] https://github.com/anomalyco/opencode/issues/25126 · https://github.com/anomalyco/opencode/issues/18634
- #40182: `--variant` **silently ignored** when not in the model's reasoning options (fix PR: reject unknown variant instead of dropping). #42848: auto-assigned `medium` variant crashes models with empty variant lists. #61521: catalog exposes zero variants → thinking stuck at `max`. #50257: `capabilities.reasoning` never set → picker shows "No reasoning" while the model does reason. #58809: feature request to *display* effective model+effort for running subagents (admission that display of effective depth is unsolved). #7713: commands specifying model variant (now shipped). [M] https://github.com/anomalyco/opencode/issues/40182 · /42848 · /61521 · /50257 · /58809 · /7713
- Real-world pinning configs that work: role/preset assignments like `vvoc role set smart zai-coding-plan/glm-5.3#max` (osovv/vv-opencode), and per-agent `deepseek/deepseek-flash#high` routing — with the explicit note that built-in background helpers' variant tiers "only take effect in child sessions/one-shot calls; the main session does not follow them" (znlgis config) — i.e. depth propagates per-session, another reason to pin per worker. [M] https://github.com/osovv/vv-opencode · https://github.com/znlgis/my-opencode-deepseek-config

### `thoughtLevel` specifically
- `thoughtLevel` is a real runtime field in the opencode/zai stack: a z.ai feedback log shows session payload `"thoughtLevel":"max"` inside `session.model_selection` [L] https://github.com/zai-org/feedback/issues/1009 ; agent-settings tooling exposes `thoughtLevel` for opencode agents [L] https://athenode.com/docs/plugins/tool-settings ; an agent-frontmatter spec lists `thoughtLevel` among opencode agent fields [L] https://github.com/Gentleman-Programming/gentle-ai/issues/945 ; a community technical design doc notes **"AgentConfig… no thoughtLevel"** — i.e. it is not settable via agent config, only via request options [L] https://github.com/mrzturn/opencode-switchman (docs/2026-08-28 technical design).
- Upstream AI SDK (which opencode's `@opencode/ai` providers fork): current Anthropic provider documents `providerOptions.anthropic.effort` (`low|medium|high|xhigh|max`) and `thinking` types; effort-defaults per model and silent-downgrade rules (e.g. `xhigh`+disabled thinking lowered to `high` with warning). Earlier SDK generations named this control `thoughtLevel` — the option-name choice must match whatever opencode 2.3.2's provider fork actually reads (verify against the vendored package, not the public docs). [H] https://ai-sdk.dev/providers/ai-sdk-providers/anthropic

### Competitor exposure of thinking depth
- **Amp:** first-class `effort` option at SDK level (`'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`) alongside `model`/`mode` — depth is an execution parameter, not a model rename. [H] https://ampcode.com/docs/sdk · https://www.npmjs.com/package/@ampcode/sdk
- **Claude Code:** `/effort <value>` accepted as an argument (with `/model`, `/fast`) in headless runs; permission/effort modes are session-level configuration. [H] https://code.claude.com/docs/en/headless
- **Gemini CLI:** thinking/approval handled by modes (`--approval-mode plan|yolo`), no per-subagent depth surface found. [M] https://geminicli.com/docs/reference/configuration/

---

## Q5 — v2 migration war stories (opencode + other plugins)

### Official migration contract (what changed)
- V1 plugin implementations **do not run in V2**; entrypoint is `Plugin.define({id, setup(ctx)})`; key mapping: `dispose` → **cleanup function returned by `setup`**; `permission.ask` → `ctx.permission.hook("evaluate")`; `chat.params` → `ctx.session.hook("context")`; `chat.headers` → `session.hook("model.request"/"http.request")`; `event` → `ctx.event.subscribe()`; tool map → `ctx.tool.transform`; **`command.execute.before` has no global equivalent**; experimental compaction hooks re-homed. [H] https://opencode.ai/docs/build/plugins/migrate-v1
- Cleanup semantics, verbatim intent: **"Use the cleanup function for timers, subprocesses, sockets, and other resources the plugin owns. Hook and transform registrations are scoped to the plugin and are cleaned up automatically."** Cleanup = *plugin-owned resources*, not other sessions' work. [H] https://opencode.ai/docs/build/plugins/migrate-v1
- Registrations: `Registration.dispose()` is idempotent; "unloading the plugin also disposes its registrations"; disposing a transform removes *its* changes and rebuilds from the rest. Transforms must be "cheap and repeatable", replayed in order; a later valid registration overrides the same effective tool name. Event subscriptions must be aborted from cleanup. [H] https://opencode.ai/docs/build/plugins/server
- Plugin manager safety net: failed plugin updates keep the previous version running/installed. [H] https://opencode.ai/docs/plugins

### War stories from the field
- **Plugin fails to load at all:** "Plugin must export a default definition with an id and an effect or setup function" (`SchemaError: Missing key at ["default"]["effect"|"setup"]`) — the single most common v2 breakage; moving files/renaming config keys does nothing. [M] https://agenticcontrolplane.com/blog/opencode-plugin-must-export-default-definition · https://opencode.ai/docs/build/plugins/migrate-v1
- **Cleanup timing surprise:** kimaki's migration guide documents that the v2 cleanup function "runs on reload **and location shutdown**" — i.e. dispose fires in situations where the host keeps running and sessions keep living; plugins that tie work-kill to dispose will destroy live work on unrelated reloads. Also: v1 "abort + replay prompt" is replaced by the native inbox (`steer`/`queue`). [M] https://kimaki.dev/blog/opencode-v2-migration
- **Tool registration/shape churn:** v2 tools return structured content (`{content}`), use JSON Schema input, and a stale v1 CLI won't load v2 implementations (the v2 installer provides `opencode2`); watch startup errors and `opencode service restart` when watched plugins misbehave. [M] https://flaviocopes.com/opencode-plugin/
- **Permission defaults shifted:** `external_directory` is allowed by default in 2.x ("add the ask rule before the first real session, not after the first surprise"); read the startup log for ignored-field warnings; "renaming plugins instead of porting them" is called out as the top migration mistake. [M] https://shattered.io/opencode-2-upgrade-from-1x-12-steps-2026/ · defaults [H] https://opencode.ai/docs/permissions
- **Hook payload shapes changed** (single mutable event vs input/output pair), per-request-kind hooks must be registered separately, `shell.env` split into `shell.hook("create.before")` + command-prefixing in `tool.execute.before` for per-session env. [M] https://kimaki.dev/blog/opencode-v2-migration · [H] https://opencode.ai/docs/build/plugins/migrate-v1
- **Session/abort model changed:** v2 offers `session.interrupt`/`session.remove`/inbox delivery; child sessions outlive prompts (background subagents always run to idle). v1-style "abort + replay" assumptions break. [H] https://opencode.ai/docs/build/plugins/server · [M] https://kimaki.dev/blog/opencode-v2-migration
- Desktop-plugin authors report one build now working across TUI+desktop but only after full v2 porting ("I built plugins for OpenCode v2 once, now they work in the desktop app too"). [L] https://www.reddit.com/r/opencode/comments/1xhroez/
- **No precedent found** for a v2 plugin intentionally killing *all in-flight subagent dispatches process-wide* from its dispose hook — every authoritative source scopes cleanup to plugin-owned resources, and durable-work plugins (pocket-universe, navigator, background-agents) advertise *survival* and restart recovery as features, not dispose-coupled teardown. [M] https://opencode.ai/docs/build/plugins/migrate-v1 · https://github.com/spoons-and-mirrors/pocket-universe · https://libraries.io/npm/opencode-navigator ("In-flight work is not cancelled")

---

## Implications for our four changes

1. **C1 (dispose/kill decoupling) is aligned with the letter of the v2 contract** — cleanup is documented for "timers, subprocesses… the plugin owns"; nobody couples plugin unload to other sessions' in-flight work. (migrate-v1 doc)
2. **C1: cleanup fires on reload AND location shutdown while the host lives on** — dispose-time kill is not just wrong scope, it fires at routine moments; journal+restart recovery (pocket-universe/navigator-style durability) is the ecosystem-endorsed alternative. (kimaki, awesomeopencode)
3. **C1: replace the silent no-op child-session abort with v2-native APIs** — `ctx.session.interrupt({sessionID, resume:false})` for abort, `ctx.session.remove` only when we own and want to delete the child tree; v1 "abort+replay" assumptions are dead in v2. (server docs, kimaki)
4. **C2: completion-time modal ask is indefensible** — opencode's own issues show ask dialogs wedging in TUI/desktop (#13715, #28312, #55678) and non-interactive runs auto-rejecting `ask`; Claude Code's answer is deterministic deny-with-reason (`--permission-prompts none`) so the loop continues. Keep the ask at the *transition* gate only.
5. **C2: plugin-verified close has direct precedents** — spec-kit's implement reads checkbox state and refuses to proceed on unchecked items; Claude Code Stop-hooks block completion until commands pass; a community opencode pattern throws on `tool.execute.before` until tests ran. Re-run structured verification fail-closed = industry norm.
6. **C2: keep the plan→execution ask** — every harness (Claude Code plan mode, goose /plan, Coder propose_plan) keeps exactly one interactive approval at the plan→execute boundary; evidence summary at close mirrors spec-kit/analyze+converge artifacts.
7. **C2: plan_reopen is unremarkable and expected** — plans are files in all surveyed harnesses (spec-kit, opencode's own `~/.opencode/plan`, OpenSpec archive); a bounded reopen window matches OpenSpec's archive/un-archive and spec-kit's editable artifacts.
8. **C3: one `/forge` command with argument routing matches the platform** — plugin commands receive the raw prompt and must parse args themselves; `$ARGUMENTS`/positional conventions exist only for Markdown/JSON commands; consolidation also shrinks exposure to the Desktop dispatch bug class (#41339, #22255) and silent same-name replacement collisions (commands doc).
9. **C3: `forge stop` scoped to the invoking session mirrors opencode's own semantics** — permission reject is defined as "every pending request *in that session*"; interrupt/remove are session-scoped APIs; no precedent found for deliberately killing other sessions' work (only bug reports about it).
10. **C4: variant loss in subagents is a known, reported bug class** (#21632 variant parsed-but-dropped; #25126/#18634 UI showing default variant) — pin via the *variant* channel (agent/command `model` with `#variant`, per-model variant settings), never by rewriting `payload.model` or deleting fields; root-config variants are documented as not retained.
11. **C4: thoughtLevel must ride request options at the sanctioned seam** — `session.hook("context")` `event.options` passes unknown keys to the provider protocol; agent-config-level `thoughtLevel` does not exist (AgentConfig has no such field; agent `request` overlays are documented as *not sent* in v2). Verify the exact option key (`thoughtLevel` vs `effort`/`reasoningEffort`) against opencode 2.3.2's vendored provider package; the public AI SDK has moved to `effort`.
12. **C4: display caveat to document, not fix** — effective-effort display for subagents is unsolved upstream (#58809, #25126); our UI showing "default" while depth is injected via options is consistent with known host behavior; surface the effective depth in our own evidence/journal UI rather than fighting the host picker.
