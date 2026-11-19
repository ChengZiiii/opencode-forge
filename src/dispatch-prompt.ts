// Standing worker-discipline prompt for materialized forge subagents (spec:
// forge-subagents — "Materialization as native subagents with a pinned
// model", discipline mandates inherited from the dispatch era). A subagent's
// system prompt is baked at materialization (there is no per-task wrapper —
// the task prompt arrives through the native task tool), so the three
// mandates ride INSIDE the agent prompt, always outermost relative to the
// role text:
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
  "- Run every shell command through the forge_shell tool (the builtin shell is not part of your toolset by design). Long-running or non-exiting commands: forge_shell with run_in_background, then collect results via forge_jobs poll before yielding.",
  "- Run every search through the forge_grep/forge_glob tools first — the builtin grep/glob tools are fallback only. forge_grep/forge_glob see through symlinks/junctions and dot-directories because follow and hidden are on by default.",
  "- If any tool call is refused or denied, report the refusal VERBATIM in your final answer and stop that line of work. Never improvise a workaround around a permission denial.",
  "- End with conclusions backed by evidence references (file:line, command output, or the exact file/content you produced).",
  "- Report-file delivery (reliability contract): when the dispatch prompt names a report path (convention: `reports/<task>-report.md`, workspace-relative), write your final report there in addition to replying on the result stream — the caller may need to recover your result from that file if the live result stream is lost. Readonly workers skip this: the reply is the report.",
].join("\n")

/** The standing report-file delivery line appended to dispatch prompts (idempotent — see withReportDelivery). */
export const REPORT_DELIVERY_LINE = (taskId: string): string =>
  `Report delivery contract (reliability): in addition to replying on the result stream, write your final report to \`reports/${taskId}-report.md\` (workspace-relative; create the directory if needed) — the caller may need to recover your result from that file if the live result stream is lost. If your toolset has no file write access, skip this: your reply is the report.`

/**
 * Append the standing report-file delivery contract to a dispatch prompt,
 * naming the concrete caller-provided report path. IDEMPOTENT by
 * construction: any previously appended contract line (from a journal round
 * trip or a re-wrap) is stripped first, so wrapping the same prompt twice
 * yields exactly one contract line with the CURRENT task id.
 */
export function withReportDelivery(promptText: string, taskId: string): string {
  const stripped = promptText.replace(/\n+Report delivery contract \(reliability\):[\s\S]*$/, "")
  return `${stripped}\n\n${REPORT_DELIVERY_LINE(taskId)}`
}

const READONLY_DISCIPLINE = (agent: string) =>
  `You are forge-${agent}, a readonly worker: you gather, read, run read-only checks, and REPORT. Your restrictions are the design, not obstacles — do not attempt to work around them; report what you found instead.`

const WRITE_DISCIPLINE = (agent: string) =>
  `You are forge-${agent}, a worker executing scoped tasks handed to you through the task tool. Do exactly the task, nothing else: no refactoring beyond scope, no unrelated files, no side quests.`

// Compose the standing system prompt for a materialized agent: discipline
// frame (shape-specific) + role text (explicit def.prompt overrides the
// built-in role default) + the three mandates (never replaceable).
export function materializeAgentPrompt(input: { agent: string; shape: "readonly" | "write"; role: string }): string {
  const frame = input.shape === "readonly" ? READONLY_DISCIPLINE(input.agent) : WRITE_DISCIPLINE(input.agent)
  return [frame, "", "Your role:", input.role.trim(), "", WORKER_MANDATES].join("\n")
}
