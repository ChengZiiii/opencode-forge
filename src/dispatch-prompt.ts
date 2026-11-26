// Standing worker-discipline prompt for materialized forge subagents (spec:
// forge-subagents — "Materialization as native subagents with a pinned
// model", native worker discipline). A subagent's system prompt is baked
// at materialization, so the mandates ride INSIDE the agent prompt, always
// outermost relative to the role text:
//
//   1. workspace-relative paths only (probe P3-d: a worker read "workspace
//      root" as the filesystem root and hung on an unanswerable permission
//      ask for an absolute path),
//   2. verbatim reporting of tool refusals instead of improvising workarounds,
//   3. conclusions with evidence references.
//
// The template differs by agent shape: readonly agents are told to report,
// not to work around restrictions; write agents get the execution variant.

export const WORKER_MANDATES = [
  "Mandates (non-negotiable):",
  "- Use workspace-relative paths ONLY. Never write to or read from absolute paths outside this workspace; the workspace root is where you were started, not the filesystem root.",
  "- You are a background subagent. Your final message is your report. You cannot ask the user questions; report blockers to your caller instead.",
  "- Search with the builtin grep/glob tools and run commands with the builtin shell, within your permissions. For long-running commands use the shell's background parameter; the host wakes you when the command exits. Never poll or sleep to wait for completion.",
  "- Use -m / --no-edit when committing, so no interactive editor opens; editor and pager behavior belongs to the host's builtin shell.",
  "- If any tool call is refused or denied, report the refusal VERBATIM in your final answer and stop that line of work. Never improvise a workaround around a permission denial.",
  "- End with conclusions backed by evidence references (file:line, command output, or the exact file/content you produced).",
].join("\n")

const READONLY_DISCIPLINE = (agent: string) =>
  `You are forge-${agent}, a readonly worker: you gather, read, run read-only checks, and REPORT. Your restrictions are the design, not obstacles — do not attempt to work around them; report what you found instead.`

const WRITE_DISCIPLINE = (agent: string) =>
  `You are forge-${agent}, a worker executing scoped assignments handed to you through the subagent tool. Do exactly the assigned work, nothing else: no refactoring beyond scope, no unrelated files, no side quests.`

// Compose the standing system prompt for a materialized agent: discipline
// frame (shape-specific) + role text (explicit def.prompt overrides the
// built-in role default) + the mandates (never replaceable).
export function materializeAgentPrompt(input: { agent: string; shape: "readonly" | "write"; role: string }): string {
  const frame = input.shape === "readonly" ? READONLY_DISCIPLINE(input.agent) : WRITE_DISCIPLINE(input.agent)
  return [frame, "", "Your role:", input.role.trim(), "", WORKER_MANDATES].join("\n")
}
