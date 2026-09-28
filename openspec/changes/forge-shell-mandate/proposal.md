# forge-shell-mandate

## Why

On hosts that ignore injected tools maps (paseo), the builtin `shell`/`bash` tools stay visible to the forge family even though the partition hides them in the config — so the model sees bash, tries it first, eats the `[forge:partition] Builtin shell refused` belt rejection, and only then falls back to `forge_shell`. Every such attempt is one wasted round-trip. The prompt side makes it worse: every forge-authored shell instruction is qualified with "long-running or possibly non-exiting commands", which the model reads as "quick commands may use the builtin shell" — exactly the wrong lesson. OMO archaeology (2026-09-28, `alvinunreal/oh-my-opencode-slim` + upstream `code-yeongyu/oh-my-openagent`) confirms there is no plugin-level hiding on such hosts: the industry pattern is a permission-deny boundary plus an explicit channel mandate in the prompt (their ACP wrappers pair `bash: deny` with "Always call acp_run"). The belt is the boundary; this change hardens the mandate so the boundary is rarely tested.

## What Changes

- **forge-agent (ADDED)**: a channel-mandate requirement — the forge agent's system prompt and the `[forge:job-guidance]` injection state unconditionally that every shell command (quick ones included) runs through `forge_shell`, because the builtin shell tools are refused on the forge family while the exec partition holds. When `jobs.keepBuiltinShell` restores the builtin tool, the mandate softens to a preference (never a false refusal claim); under `jobs.mode: "native"` no mandate exists (no forge_shell at all).
- **plugin.ts**: FORGE_PROMPT gains an exec-surface paragraph, composed per config (hard refusal wording when the hide holds, preference wording under `keepBuiltinShell`); the `[forge:job-guidance]` injection absolutizes under the same gate; the `forge_shell` tool description states it is the exec surface for every command.
- **README**: the tool-partition section notes the mandate (one sentence).

## Impact

- Specs: forge-agent (1 ADDED)
- Code: plugin.ts (FORGE_PROMPT composition + guidance text + tool description)
- Tests: job-wiring (guidance wording per config), forge-subagents-wiring (prompt composition)
- Docs: README.md
- Honest limit: violation frequency drops; zero is not promised — the belt remains the enforcement and its rejection message already names the right tool.
