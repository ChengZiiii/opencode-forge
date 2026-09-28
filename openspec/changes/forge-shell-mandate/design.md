# Design — forge-shell-mandate

## Context

The belt refusal is correct but expensive: one wasted round-trip per violation, and each refusal turn teaches the model after the fact what the prompt could have taught up front. The failure mode is textual, not structural — the model cannot know the visible bash tool is a ghost unless the prompt says so. (On hosts that honor tools maps the tool is genuinely absent and the mandate is harmless redundancy.)

## Prior art (OMO, verified 2026-09-28)

- **oh-my-opencode-slim** `src/agents/permissions.ts:13-16`: restricted agents get `'*': 'deny', bash: 'deny'` — permission boundary, not tool hiding; the comment argues wildcard-deny so newly-added tools cannot leak through.
- **ACP wrapper agents** (slim `src/agents/councillor.ts`, upstream acp agents): bash denied + a dedicated wrapper tool allowed + the prompt hard-mandates "Always call acp_run" — prompt + boundary as one pattern, exactly the shape we already have (belt + forge_shell) and are strengthening.
- **Upstream** `src/shared/permission-compat.ts` migrates legacy `tools: {}` maps into permission maps — evidence that tools-map-based hiding is considered unreliable in the wild (hosts ignore it), matching our paseo finding.
- Neither OMO variant hides the builtin shell from the model's view at the plugin level. Nobody has a silver bullet; the mandate is the available lever.

## Decisions

- **D1 — Mandate lives in FORGE_PROMPT, composed per config.** The prompt is registered inside the config hook where `jobsMode`/`keepBuiltinShell` are known, so the refusal clause is included only when it is true. Static-but-wrong text is how the current "long-running" qualifier rotted.
- **D2 — The injection absolutizes under the same gate.** `[forge:job-guidance]` keeps its delegated-collection sentence (tests pin it) but loses the long-running qualifier when the hide holds; under `keepBuiltinShell` it keeps the accurate long-running framing.
- **D3 — The tool description states the channel, not the threat.** "forge_shell is the exec surface for every shell command — quick ones included" reads true under both gates; the refusal claim stays in prompt/injection text where it can be conditioned.
- **D4 — Worker mandates stay as-is.** `dispatch-prompt.ts` already mandates every command through forge_shell unconditionally (workers have no builtin shell at all); no change.
- **D5 — Honest limit recorded in the proposal.** Frequency reduction, not elimination; the belt stays.

## Risks / Trade-offs

- [Prompt grows by one paragraph] → four sentences; the forge prompt is otherwise tiny.
- [Mandate text could contradict keepBuiltinShell users] → composed per config (D1); the preference wording is additive, not contradictory.
- [Model still tries bash sometimes] → accepted; belt refusal names forge_shell and costs one turn.

## Migration Plan

1. plugin.ts: extract `forgePrompt()` composition + guidance text constant per gate; wire into v1 agent def, v2 setup, system.transform, tool description.
2. Tests: wiring wording assertions per config; then README + validate.

## Open Questions

- None.
