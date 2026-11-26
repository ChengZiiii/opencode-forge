import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { CheckItem } from "./goal-file.ts"
import type { CheckOutcome } from "./run-check.ts"

// The archived v2 idle contract describes background entries as still running.
// Only the observed owning-session shell shape is recognized here; unknown
// entries are not evidence of waiting or settlement.
export function hasIdleBackgroundShell(raw: unknown, sessionID: string): boolean {
  const background = (raw as { background?: unknown } | null)?.background
  return Array.isArray(background) && background.some((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    return e.kind === "shell" && e.sessionID === sessionID &&
      typeof e.shellID === "string" && e.shellID.length > 0 && typeof e.command === "string"
  })
}

// Missing or malformed background data is not evidence that a previously
// observed shell has completed. Only a complete array can clear the wait.
export function idleBackgroundKnown(raw: unknown): boolean {
  const background = (raw as { background?: unknown } | null)?.background
  return Array.isArray(background) && background.every(entry => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    return e.kind === "shell" && typeof e.sessionID === "string" && typeof e.shellID === "string" && !!e.shellID && typeof e.command === "string"
  })
}

// Native completion receipts are correlated to the ordered parent transcript.
// Distinct accepted calls on the same child cannot share one notification.
export function settledGoalRounds(rounds: ReadonlyMap<string, string>, context: unknown): Set<string> {
  const object = (x: unknown): Record<string, unknown> => x && typeof x === "object" ? x as Record<string, unknown> : {}
  const messages = object(context).data ?? context
  const settled = new Set<string>()
  if (!Array.isArray(messages)) return settled
  const created = (m: unknown) => object(object(m).time).created
  if (!messages.every(m => typeof created(m) === "number")) return settled
  const current = new Map<string, string>()
  const ambiguous = new Set<string>(), seen = new Set<string>()
  for (const raw of [...messages].sort((a, b) => Number(created(a)) - Number(created(b)))) {
    const m = object(raw)
    if (m.type === "assistant" && Array.isArray(m.content)) for (const rawPart of m.content) {
      const p = object(rawPart), state = object(p.state), meta = object(state.metadata)
      const id = p.callID ?? p.id, child = meta.sessionID
      if (p.type !== "tool" || p.name !== "subagent" || state.status !== "completed" || typeof id !== "string" || typeof child !== "string") continue
      // Historical receipts also occupy the child until their own observed
      // completion. Ignoring them would let a delayed old result settle a new call.
      if (rounds.has(id) && rounds.get(id) !== child) { ambiguous.add(child); continue }
      const previous = current.get(child)
      if (previous && previous !== id && !settled.has(previous)) ambiguous.add(child)
      current.set(child, id)
    }
    if (m.type !== "synthetic" || typeof m.id !== "string" || seen.has(m.id)) continue
    seen.add(m.id)
    const meta = object(m.metadata), child = meta.childID
    if (meta.source !== "subagent" || typeof child !== "string" || ambiguous.has(child)) continue
    const id = current.get(child)
    if (!id || settled.has(id) || typeof m.text !== "string") continue
    const match = /^<background-result kind="subagent" sessionID="([^"]+)" state="(completed|error|cancelled)" description="[^"]*">[\s\S]*<\/background-result>$/.exec(m.text)
    if (match && match[1] === child && match[2] === meta.state) settled.add(id)
  }
  return settled
}

// In-memory observations only; execution counts and information gain are separate.
type CheckReceipt = { id: string; messageID: string; input: string; output: string }
export type GoalActivity = { writes: number; checks: number; dispatches?: number; uncertain?: boolean; other?: boolean; evidence?: string[]; seen?: Map<string, unknown>; scope?: string; goalChecks?: Array<{ output: string; evidence?: string }>; checkReceipts?: CheckReceipt[] }
type ActivityEvent = { messageID?: string; status?: unknown; codemode?: boolean }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function singleText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const part = record(content[0])
  return part?.type === "text" && typeof part.text === "string" ? part.text : undefined
}

function checkInput(value: unknown): string | undefined {
  const input = record(value)
  if (!input) return undefined
  if (!Object.keys(input).length) return "{}"
  if (Object.keys(input).length !== 1 || !Array.isArray(input.items) || !input.items.every(n => Number.isSafeInteger(n) && n > 0)) return undefined
  return JSON.stringify({ items: input.items })
}

function completeResult(result: Record<string, unknown> | undefined): boolean {
  const metadata = record(result?.metadata)
  return !!result && [result.truncated, metadata?.truncated, result.error, metadata?.error].every(t => t === undefined || t === false) && result.status !== "error" && metadata?.status !== "error"
}

function singleCompletedCheck(calls: unknown): string | undefined {
  if (!Array.isArray(calls) || calls.length !== 1) return undefined
  const call = record(calls[0])
  return call?.tool === "goal_check" && call.status === "completed" ? checkInput(call.input) : undefined
}

// The observed CodeMode wrapper repeats the inner result and tool-call summary.
// Consume exactly one same-message receipt, never infer a check from script text.
function consumeCheckWrapper(act: GoalActivity, id: string | undefined, result: unknown, event: ActivityEvent | undefined): boolean {
  const r = record(result), output = record(r?.output), metadata = record(r?.metadata)
  if (!id || !event?.messageID || event.status !== "completed" || event.codemode !== false || !completeResult(r) || !completeResult(output)) return false
  if (!Array.isArray(output?.files) || output.files.length !== 0 || typeof output.output !== "string" || singleText(r?.content) !== output.output) return false
  const input = singleCompletedCheck(metadata?.toolCalls)
  if (input === undefined || input !== singleCompletedCheck(output.toolCalls)) return false
  const matches = act.checkReceipts?.filter(p => p.id !== id && p.messageID === event.messageID && p.input === input && p.output === output.output)
  if (matches?.length !== 1) return false
  act.checkReceipts!.splice(act.checkReceipts!.indexOf(matches[0]), 1)
  return true
}

// A wrapper can also establish independent activity from its completed tool
// calls or produced files; an incomplete or conflicting summary cannot.
function wrapperOtherActivity(result: unknown, event: ActivityEvent | undefined): boolean {
  const r = record(result), output = record(r?.output), metadata = record(r?.metadata)
  if (event?.status !== "completed" || !completeResult(r) || !completeResult(output)) return false
  const calls = metadata?.toolCalls
  if (!Array.isArray(calls) || !isDeepStrictEqual(calls, output?.toolCalls)) return false
  return calls.some(raw => {
    const call = record(raw)
    return typeof call?.tool === "string" && call.tool !== "goal_check" && call.status === "completed"
  }) || (Array.isArray(output?.files) && output.files.length > 0)
}

export function rememberGoalCheck(act: GoalActivity, selected: { c: CheckItem; n: number }[], outcomes: CheckOutcome[], output: string): void {
  const complete = selected.length === outcomes.length && outcomes.every((o, i) => o.index === selected[i].n && o.comparable !== undefined)
  const evidence = complete ? createHash("sha256").update(JSON.stringify([act.scope, selected, outcomes.map((o) => o.comparable)])).digest("hex") : undefined
  ;(act.goalChecks ??= []).push({ output, evidence })
}

export function observeGoalActivity(act: GoalActivity, tool: string, write: boolean, id: string | undefined, args: unknown, result: unknown, event?: ActivityEvent): void {
  // An unknown native dispatch result is not an acceptance and must not
  // consume the identity of a later positively accepted round.
  if (tool === "subagent") {
    const r = record(result), m = record(r?.metadata)
    if (!id || m?.status !== "running" || typeof m.sessionID !== "string" || !m.sessionID || r?.status === "error" || (event?.status !== undefined && event.status !== "completed")) {
      act.uncertain = true
      return
    }
  }
  if (id) {
    const key = JSON.stringify([event?.messageID, id, tool])
    const observation = [args, result, event, write]
    const seen = act.seen ??= new Map()
    if (seen.has(key)) {
      if (!isDeepStrictEqual(seen.get(key), observation)) act.uncertain = true
      return
    }
    for (const previous of seen.keys()) {
      const [messageID, callID, name] = JSON.parse(previous)
      if (messageID === (event?.messageID ?? null) && callID === id && name !== tool) act.uncertain = true
    }
    // Snapshot the event so a later contradictory update is not a replay.
    try { seen.set(key, structuredClone(observation)) } catch { act.uncertain = true }
  }
  if (tool === "subagent") {
    act.dispatches = (act.dispatches ?? 0) + 1
    if (write) act.writes++ // existing ledger format records accepted writes
    act.other = true
    return
  }
  const check = ["goal_check", "shell", "bash"].includes(tool)
  if (write || tool === "plan_tick") act.writes++
  if (check) act.checks++
  if (!check) {
    if (tool === "execute" && !write) {
      if (consumeCheckWrapper(act, id, result, event)) return
      if (wrapperOtherActivity(result, event)) act.other = true
      else act.uncertain = true
      return
    }
    act.other = true
    return
  }
  // Only compare explicitly complete results with a known exit status. A shell
  // invocation may mutate state (including git commit), so only recognizable
  // verification commands are candidates; everything else breaks repetition.
  const a = args as Record<string, unknown> | undefined
  const r = result as Record<string, unknown> | undefined
  const m = r?.metadata as Record<string, unknown> | undefined
  if (tool === "goal_check") {
    // Match only a result actually produced by this turn's host-run check.
    // The v2 host returns a text part; retain the legacy string adapter shape.
    const content = r?.output ?? r?.content
    const output = typeof content === "string" ? content : singleText(content)
    const matches = act.goalChecks?.filter((pending) => pending.output === output)
    const pending = matches?.length === 1 ? matches[0] : undefined
    const completed = event?.status === "completed" || (typeof content === "string" && event?.status === undefined)
    if (pending && typeof output === "string" && completeResult(r) && completed) {
      act.goalChecks!.splice(act.goalChecks!.indexOf(pending), 1)
      if (pending.evidence) {
        ;(act.evidence ??= []).push(pending.evidence)
        const input = checkInput(args)
        if (event?.codemode === true) {
          if (id && event.messageID && event.status === "completed" && r?.output === undefined && singleText(r?.content) === output && input !== undefined) {
            ;(act.checkReceipts ??= []).push({ id, messageID: event.messageID, input, output })
          } else act.uncertain = true
        } else if (event?.codemode !== false && typeof content !== "string") act.uncertain = true
      } else act.uncertain = true
    } else {
      act.uncertain = true
    }
    return
  }
  const command = a?.command ?? a?.cmd
  const verification = (typeof command === "string" && /^(?:npm test|npm run (?:test|typecheck)|npx tsc --noEmit|pytest)(?: -- [\w .-]+)?$/.test(command))
  if (!verification) {
    act.other = true
    return
  }
  if (!a || !Object.keys(a).length || !completeResult(r) || typeof r?.output !== "string" || m?.truncated !== false || !Number.isInteger(m.exitCode) || (event?.status !== undefined && event.status !== "completed")) {
    act.uncertain = true
    return
  }
  try {
    (act.evidence ??= []).push(JSON.stringify([act.scope, tool, a, m.exitCode, r.output]))
  } catch { act.uncertain = true }
}

export function classifyGoalActivity(act: GoalActivity | undefined, previous: string | undefined): { activity: boolean; repeated: boolean; evidence?: string; uncertain?: boolean } {
  if (!act) return { activity: false, repeated: false, uncertain: true } // missing observation is not empty
  if (act.other) return { activity: true, repeated: false }
  if (act.uncertain || act.goalChecks?.length || act.checkReceipts?.length) return { activity: false, repeated: false, uncertain: true }
  if (act.evidence?.length) {
    const evidence = JSON.stringify(act.evidence)
    return { activity: evidence !== previous, repeated: evidence === previous, evidence }
  }
  return { activity: act.writes > 0 || act.checks > 0, repeated: false }
}
