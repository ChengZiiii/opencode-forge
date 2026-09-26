// Worker prompt discipline for dispatched child sessions (spec: dispatch —
// "Worker prompt discipline"). Every dispatched prompt is wrapped with the
// tier's discipline template, which mandates:
//
//   1. workspace-relative paths only (probe P3-d: a worker read "workspace
//      root" as the filesystem root and hung on an unanswerable permission
//      ask for an absolute path),
//   2. verbatim reporting of tool refusals instead of improvising workarounds,
//   3. conclusions with evidence references.
//
// The template differs by tier shape: readonly tiers are told to report, not
// to work around restrictions; write tiers get the execution variant.

export type PromptTemplateInput = {
  prompt: string
  tier: string
  shape: "readonly" | "write"
}

const COMMON_MANDATES = [
  "Mandates (non-negotiable):",
  "- Use workspace-relative paths ONLY. Never write to or read from absolute paths outside this workspace; the workspace root is where you were started, not the filesystem root.",
  "- If any tool call is refused or denied, report the refusal VERBATIM in your final answer and stop that line of work. Never improvise a workaround around a permission denial.",
  "- End with conclusions backed by evidence references (file:line, command output, or the exact file/content you produced).",
].join("\n")

const READONLY_DISCIPLINE = `You are a readonly ${"{tier}"} worker: you gather, read, run read-only checks, and REPORT. Your restrictions are the design, not obstacles — do not attempt to work around them; report what you found instead.`

const WRITE_DISCIPLINE = `You are a ${"{tier}"} worker executing one scoped task. Do exactly the task, nothing else: no refactoring beyond scope, no unrelated files, no starting side quests.`

export function composeWorkerPrompt(input: PromptTemplateInput): string {
  const discipline =
    input.shape === "readonly"
      ? READONLY_DISCIPLINE.replaceAll("{tier}", input.tier)
      : WRITE_DISCIPLINE.replaceAll("{tier}", input.tier)
  return [
    "[forge:dispatch] You were dispatched by the forge main agent as a scoped worker.",
    discipline,
    "",
    "Task:",
    input.prompt.trim(),
    "",
    COMMON_MANDATES,
    "",
    "Finish with a single concluding report (the main agent will read only this): what you did, what you found/produced, and the evidence.",
  ].join("\n")
}
