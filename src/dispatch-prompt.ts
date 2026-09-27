// Worker prompt discipline for dispatched child sessions (spec: dispatch —
// "Worker prompt discipline"). Every dispatched prompt is wrapped with the
// outer discipline template, which mandates:
//
//   1. workspace-relative paths only (probe P3-d: a worker read "workspace
//      root" as the filesystem root and hung on an unanswerable permission
//      ask for an absolute path),
//   2. verbatim reporting of tool refusals instead of improvising workarounds,
//   3. conclusions with evidence references.
//
// The role prompt (add-dispatch-onboarding) rides INSIDE the wrapper: it
// frames the worker (explicit def.prompt > built-in role default > generic)
// but can never replace the mandates — the wrapper is always outermost.
// The template differs by agent shape: readonly agents are told to report,
// not to work around restrictions; write agents get the execution variant.

export type PromptTemplateInput = {
  prompt: string
  agent: string
  shape: "readonly" | "write"
  // The agent definition's role prompt (see rolePromptFor). Optional for the
  // legacy tier path, which frames the role via the materialized tier agent.
  role?: string
}

const COMMON_MANDATES = [
  "Mandates (non-negotiable):",
  "- Use workspace-relative paths ONLY. Never write to or read from absolute paths outside this workspace; the workspace root is where you were started, not the filesystem root.",
  "- If any tool call is refused or denied, report the refusal VERBATIM in your final answer and stop that line of work. Never improvise a workaround around a permission denial.",
  "- End with conclusions backed by evidence references (file:line, command output, or the exact file/content you produced).",
].join("\n")

const READONLY_DISCIPLINE = `You are a readonly {agent} worker: you gather, read, run read-only checks, and REPORT. Your restrictions are the design, not obstacles — do not attempt to work around them; report what you found instead.`

const WRITE_DISCIPLINE = `You are an {agent} worker executing one scoped task. Do exactly the task, nothing else: no refactoring beyond scope, no unrelated files, no starting side quests.`

export function composeWorkerPrompt(input: PromptTemplateInput): string {
  const discipline =
    input.shape === "readonly"
      ? READONLY_DISCIPLINE.replaceAll("{agent}", input.agent)
      : WRITE_DISCIPLINE.replaceAll("{agent}", input.agent)
  return [
    "[forge:dispatch] You were dispatched by the forge main agent as a scoped worker.",
    discipline,
    ...(input.role ? ["", "Your role:", input.role.trim()] : []),
    "",
    "Task:",
    input.prompt.trim(),
    "",
    COMMON_MANDATES,
    "",
    "Finish with a single concluding report (the main agent will read only this): what you did, what you found/produced, and the evidence.",
  ].join("\n")
}
