// Async dispatch core: SDK child-session lifecycle for forge_dispatch.
//
// Pure logic, no @opencode-ai imports — the client is a structural
// (duck-typed) seam shaped after the pinned @opencode-ai/sdk 1.18.33
// surface (see openspec/changes/async-dispatch/design.md Open Questions
// for the exact verified call shapes):
//   session.create   POST /session                       body {parentID,title,permission,...} query {directory}
//   session.promptAsync POST /session/{id}/prompt_async  body {agent,parts:[{type:"text",text}]} → 204 void
//   session.status   GET  /session/status                → { [sessionID]: {type:"idle"|"busy"|"retry"} }
//   session.messages GET  /session/{id}/message          → [{info:{role,finish,error,time},parts:[{type,text}]}]
//   session.abort    POST /session/{id}/abort            → boolean
//
// The clock and sleeper are injectable so tests drive polls
// deterministically. Wiring (plugin.ts) owns gates, handles, wakes.

/** Session-wide question deny seal (OMO parity): a child can never block on human input. */
export const QUESTION_DENY_PERMISSION: ReadonlyArray<{
  permission: "question"
  action: "deny"
  pattern: "*"
}> = [{ permission: "question", action: "deny", pattern: "*" }]

/** Active (non-terminal) session status types — mirrors the SDK SessionStatus union. */
const ACTIVE_STATUS_TYPES = new Set(["busy", "retry", "running"])

export type SessionLike = { id?: string }

export type MessageInfoLike = {
  id?: string
  role?: string
  finish?: string
  error?: unknown
  time?: { created?: number; completed?: number }
}

export type PartLike = { type?: string; text?: string }

export type SessionMessageLike = { info?: MessageInfoLike; parts?: PartLike[] }

export type StatusMapLike = { [sessionID: string]: { type?: string } }

/**
 * Structural client seam — the host SDK client satisfies this without any
 * adapter. Responses are the SDK's {data?, error?} envelope; `error !==
 * undefined` is the failure branch (OMO convention).
 */
export type DispatchClient = {
  session: {
    create: (args: {
      body: Record<string, unknown>
      query?: { directory?: string }
    }) => Promise<{ data?: SessionLike; error?: unknown }>
    /** Fire-and-forget prompt (POST /session/{id}/prompt_async, 204 void). Preferred endpoint. */
    promptAsync?: (args: {
      path: { id: string }
      body: Record<string, unknown>
      query?: { directory?: string }
    }) => Promise<unknown>
    /** Synchronous fallback (POST /session/{id}/message) when promptAsync is absent. */
    prompt?: (args: {
      path: { id: string }
      body: Record<string, unknown>
      query?: { directory?: string }
    }) => Promise<unknown>
    status: (args?: Record<string, never>) => Promise<{ data?: StatusMapLike; error?: unknown }>
    messages: (args: {
      path: { id: string }
      query?: { limit?: number }
    }) => Promise<{ data?: SessionMessageLike[]; error?: unknown }>
    abort: (args: { path: { id: string }; query?: { directory?: string } }) => Promise<unknown>
  }
}

export type TimeSeams = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultNow = () => Date.now()
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Child session title in the host-native format (design D-spike: live TUI
 * children render as `"<desc> (@<agent> subagent)"` — we match verbatim).
 */
export function childSessionTitle(description: string, agentID: string): string {
  return `${description} (@${agentID} subagent)`
}

export type CreateChildInput = {
  parentSessionID: string
  /** Directory of the parent session (query.directory anchors the child to the same worktree). */
  parentDirectory: string
  agentID: string
  description: string
}

export type CreateChildResult =
  | { ok: true; sessionID: string }
  | { ok: false; error: string }

export async function createChildSession(
  client: DispatchClient,
  input: CreateChildInput,
): Promise<CreateChildResult> {
  let result: { data?: SessionLike; error?: unknown }
  try {
    result = await client.session.create({
      body: {
        parentID: input.parentSessionID,
        title: childSessionTitle(input.description, input.agentID),
        permission: QUESTION_DENY_PERMISSION,
      },
      query: { directory: input.parentDirectory },
    })
  } catch (e) {
    return { ok: false, error: `session.create threw: ${String(e)}` }
  }
  if (result.error !== undefined) {
    return { ok: false, error: `session.create failed: ${String(result.error)}` }
  }
  const id = result.data?.id
  if (typeof id !== "string" || id === "") {
    return { ok: false, error: "session.create returned no session id" }
  }
  return { ok: true, sessionID: id }
}

export type SendPromptInput = {
  sessionID: string
  agentID: string
  prompt: string
  directory?: string
}

export type SendPromptResult = { ok: true } | { ok: false; error: string }

export function buildPromptArgs(input: SendPromptInput): {
  path: { id: string }
  body: Record<string, unknown>
  query?: { directory?: string }
} {
  return {
    path: { id: input.sessionID },
    body: {
      agent: input.agentID,
      parts: [{ type: "text", text: input.prompt }],
    },
    ...(input.directory !== undefined ? { query: { directory: input.directory } } : {}),
  }
}

export async function sendPrompt(
  client: DispatchClient,
  input: SendPromptInput,
): Promise<SendPromptResult> {
  const args = buildPromptArgs(input)
  try {
    if (typeof client.session.promptAsync === "function") {
      await client.session.promptAsync(args)
    } else if (typeof client.session.prompt === "function") {
      await client.session.prompt(args)
    } else {
      return { ok: false, error: "client has no session.promptAsync or session.prompt endpoint" }
    }
  } catch (e) {
    return { ok: false, error: `prompt send threw: ${String(e)}` }
  }
  return { ok: true }
}

export type PollInput = {
  sessionID: string
  /** Poll interval in ms (default 1000). */
  intervalMs?: number
  /** Wait-mode timeout in ms — the honest ceiling before giving up (default 600000). */
  timeoutMs?: number
}

export type PollResult =
  | { status: "completed"; polls: number }
  | { status: "error"; error: string; polls: number }
  | { status: "timeout"; sessionID: string; timeoutMs: number; polls: number }

export const DEFAULT_POLL_INTERVAL_MS = 1000
export const DEFAULT_POLL_TIMEOUT_MS = 600000

function isActiveStatus(status: { type?: string } | undefined): boolean {
  return status !== undefined && status.type !== undefined && ACTIVE_STATUS_TYPES.has(status.type)
}

function latestAssistant(messages: SessionMessageLike[]): SessionMessageLike | undefined {
  let best: SessionMessageLike | undefined
  let bestCreated = -Infinity
  for (const m of messages) {
    if (m.info?.role !== "assistant") continue
    const created = m.info.time?.created ?? 0
    if (created >= bestCreated) {
      best = m
      bestCreated = created
    }
  }
  return best
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const named = error as { name?: string; data?: { message?: unknown } }
    const detail = named.data?.message ?? ""
    return `${String(named.name)}${detail ? `: ${String(detail)}` : ""}`
  }
  return String(error)
}

/**
 * Poll the child session to a terminal state. Terminal semantics (spike,
 * OMO parity): the latest assistant message carrying an `error` object is a
 * terminal error; a session that has LEFT the active statuses (busy/retry)
 * with a finished latest assistant message is completed. Reaching the
 * timeout returns an honest timeout naming the child session id (the child
 * stays alive and natively abortable — we never kill on timeout here).
 */
export async function pollChild(
  client: DispatchClient,
  input: PollInput,
  seams: TimeSeams = {},
): Promise<PollResult> {
  const now = seams.now ?? defaultNow
  const sleep = seams.sleep ?? defaultSleep
  const intervalMs = input.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = input.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const deadline = now() + timeoutMs
  let polls = 0

  for (;;) {
    await sleep(intervalMs)
    polls++

    // Status fetch failure is transient (server hiccup) — keep polling
    // until the deadline; only timeout is terminal here.
    let statusMap: StatusMapLike | undefined
    try {
      const statusResult = await client.session.status()
      if (statusResult.error === undefined && statusResult.data && typeof statusResult.data === "object") {
        statusMap = statusResult.data
      }
    } catch {
      statusMap = undefined
    }
    const active = statusMap !== undefined && isActiveStatus(statusMap[input.sessionID])

    let messages: SessionMessageLike[] = []
    try {
      const msgResult = await client.session.messages({
        path: { id: input.sessionID },
        query: { limit: 100 },
      })
      if (msgResult.error === undefined && Array.isArray(msgResult.data)) {
        messages = msgResult.data
      }
    } catch {
      messages = []
    }

    const last = latestAssistant(messages)
    if (last?.info?.error != null) {
      return { status: "error", error: describeError(last.info.error), polls }
    }
    if (!active && last?.info?.finish !== undefined) {
      return { status: "completed", polls }
    }

    if (now() >= deadline) {
      return { status: "timeout", sessionID: input.sessionID, timeoutMs, polls }
    }
  }
}

export type FinalMessageResult = { ok: true; text: string } | { ok: false; error: string }

/** Newest-first assistant text: text parts of the latest assistant message, joined. */
export async function fetchFinalMessage(
  client: DispatchClient,
  sessionID: string,
): Promise<FinalMessageResult> {
  let messages: SessionMessageLike[]
  try {
    const result = await client.session.messages({ path: { id: sessionID } })
    if (result.error !== undefined) {
      return { ok: false, error: `session.messages failed: ${String(result.error)}` }
    }
    messages = Array.isArray(result.data) ? result.data : []
  } catch (e) {
    return { ok: false, error: `session.messages threw: ${String(e)}` }
  }
  const last = latestAssistant(messages)
  if (last === undefined) {
    return { ok: false, error: `no assistant response found in child session ${sessionID}` }
  }
  const text = (last.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n")
  if (text === "") {
    return { ok: false, error: `no assistant text output found in child session ${sessionID}` }
  }
  return { ok: true, text }
}

export type AbortResult = { ok: true } | { ok: false; error: string }

export async function abortChild(client: DispatchClient, sessionID: string): Promise<AbortResult> {
  try {
    await client.session.abort({ path: { id: sessionID } })
  } catch (e) {
    return { ok: false, error: `session.abort threw: ${String(e)}` }
  }
  return { ok: true }
}
