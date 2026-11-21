# Context

On v2 the command domain offers exactly one command type — `execute` — with
`CommandInvocation = { sessionID, prompt: { text, files?, agents?, skills? },
delivery: "steer" | "queue" }` (packages/plugin/src/promise/command.ts). The
host never substitutes `$ARGUMENTS` in plugin commands; substitution is the
registrar's job (config/.md commands get it from the built-in config-command
plugin's `evaluateTemplate`; built-in /init /review append it themselves).
Official docs pattern: compose `prompt.text` onto the template inside
`execute`. The current forge v2 wiring (plugin.ts `addTemplateCommand`) reads
only `input.sessionID` and sends `template()` verbatim. See proposal.md — Why.

## Goals / Non-Goals

**Goals:**
- Typed arguments reach the model on v2, with upstream `evaluateTemplate`
  semantics for the `$ARGUMENTS` / append / empty cases.
- Deterministic, argument-free levers (`forge-sync` family) as the primary
  surface on both host generations.
- Registration drift that a human can see.

**Non-Goals:**
- Full `evaluateTemplate` parity (positional `$1..$N`, `!`cmd`` shell
  interpolation) — only `$ARGUMENTS` + append, matching what forge templates
  actually use. Positionals can come later behind #63509.
- Changing `/plan` `/goal` `/crew` template bodies (only their delivery path).

## Decisions

1. **Function replacer, not string replacement** — `template.replace("$ARGUMENTS", () => args)`. A string replacement would expand `$&`-style sequences inside the typed argument (mission-control incident class; upstream core uses `replaceAll("$ARGUMENTS", () => value)` for the same reason).
2. **Dedicated commands share route bodies with `/forge`** — the sync / init / init-global bodies are extracted into per-lever template functions; `/forge`'s routing template and `forge-sync` etc. consume the same functions, so behavior cannot fork between the two surfaces.
3. **Hyphenated names verified before ship** — `forge-sync` registration is probed on a 2.3.2 sandbox (`/api/command` lists it) before the family ships. If a host rejects hyphens (not observed anywhere upstream), the dedicated family is dropped and the args fix alone ships — that fallback is a tasks.md gate, not a spec change.
4. **`delivery` passthrough** — the invocation hint rides the prompt send so queue/steer semantics stay host-owned.
5. **Drift catch narrows to disclosed degradation** — the try/catch stays (a drifted host must not crash the plugin) but emits `console.warn("forge: command domain registration drifted — <error head>")`. Rationale: silent no-op is the mem0 #7602 / host #49982 incident class.

## Risks / Trade-offs

- [Host drops `prompt.text` for empty invocations] → Mitigated by the empty/whitespace scenario: template unchanged, exactly today's behavior.
- [Slash-menu crowding from the hyphenated family] → Accepted: four entries (`forge`, `forge-sync`, `forge-init`, `forge-init-global`) with per-lever descriptions; menu-as-documentation beats a black-box router.
- [v1 config-command expansion differences] → v1 hosts already expand `$ARGUMENTS` in config commands (verified in production on v1); dedicated commands are plain templates there, so no dual behavior to maintain.

## Migration Plan

Ship behind the normal build; no state to migrate. Rollback = revert;
dedicated commands disappear, `/forge` keeps working as before on v1 and
(with the composition fix) on v2.

## Open Questions

None — the hyphen-name probe is a tasks.md gate with a defined fallback.
