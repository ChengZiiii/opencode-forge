// Host-owned cancellation, invoked only by the explicit stop command.
import { selectStopScope, type StopCandidate, type StopCommand, type StopEnumeration } from "./stop-scope.ts"

export type StopClient = {
  children(parent: string, cursor?: string): Promise<unknown>
  context(parent: string): Promise<unknown>
  shells(): Promise<unknown>
  active(): Promise<unknown>
  removeShell(id: string): Promise<unknown>
  interrupt(id: string): Promise<unknown>
  wait(): Promise<void>
  timeoutMs?: number
  deadlineMs?: number
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {}
const unwrap = (value: unknown): unknown => record(value).data ?? value
const rows = (value: unknown): unknown[] => {
  const data = unwrap(value)
  if (!Array.isArray(data)) throw new Error("invalid enumeration")
  return data
}
export const STOP_LIST_LIMIT = 500

export async function stopNative(root: string, client: StopClient): Promise<string> {
  const findings = new Set<string>()
  const deadline = Date.now() + (client.deadlineMs ?? 8000)
  const bounded = async <T>(call: () => Promise<T>): Promise<T> => {
    const remaining = Math.min(client.timeoutMs ?? 1500, deadline - Date.now())
    if (remaining <= 0) throw new Error("deadline")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([Promise.resolve().then(call), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), remaining) })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  const receipts = new Map<string, Set<string>>()
  const receipt = (id: string, text: string) => {
    if (!receipts.has(id)) receipts.set(id, new Set())
    receipts.get(id)!.add(text)
  }
  let empty = false
  const requestedShells = new Map<string, string>()
  const requestedInterrupts = new Set<string>()
  for (let round = 0; round < 3; round++) {
    const candidates: StopCandidate[] = []
    let enumeration: StopEnumeration = "complete"
    const queue = [root]
    const visited = new Set<string>(queue)
    const parents = new Map<string, string>()
    for (let index = 0; index < queue.length && index < STOP_LIST_LIMIT; index++) {
      const parent = queue[index]
      try {
        const children: unknown[] = []
        const cursors = new Set<string>()
        let cursor: string | undefined
        // v2 returns a next anchor even for a short final nonempty page.
        // Follow it to an empty tail, rather than treating its presence as truncation.
        for (;;) {
          try {
            const rawChildren = await bounded(() => client.children(parent, cursor))
            const page = rows(rawChildren)
            const next = record(record(rawChildren).cursor).next
            if (typeof next === "string" && cursors.has(next)) { enumeration = "truncated"; break }
            children.push(...page.slice(0, STOP_LIST_LIMIT - children.length))
            if (children.length >= STOP_LIST_LIMIT) { enumeration = "truncated"; break }
            if (next == null) break
            if (typeof next !== "string" || !next || !page.length) {
              enumeration = "truncated"; break
            }
            cursors.add(next)
            cursor = next
          } catch {
            enumeration = "partial"
            findings.add(`Child enumeration unavailable for ${parent}`)
            break
          }
        }
        if (!children.length) continue
        let proof = new Set<string>()
        try {
          for (const message of rows(await bounded(() => client.context(parent)))) {
            const m = record(message)
            if (m.type !== "assistant" && record(m.info).role !== "assistant" && m.role !== "assistant") continue
            const parts = m.parts ?? m.content
            for (const part of Array.isArray(parts) ? parts : []) {
              const p = record(part), state = record(p.state), metadata = record(state.metadata)
              if (p.type === "tool" && (p.name ?? p.tool) === "subagent" && state.status === "completed" && metadata.status === "running" && typeof metadata.sessionID === "string") proof.add(metadata.sessionID)
            }
          }
        } catch { enumeration = "partial"; findings.add(`Dispatch evidence unavailable for ${parent}`) }
        for (const raw of children) {
          const child = record(raw)
          if (typeof child.id !== "string" || child.parentID !== parent || visited.has(child.id)) {
            enumeration = "partial"
            if (typeof child.id === "string") candidates.push({ id: child.id, lineage: "unknown", dispatch: "unknown" })
            continue
          }
          const confirmed = proof.has(child.id)
          candidates.push({ id: child.id, lineage: "confirmed", dispatch: confirmed ? "confirmed" : "unknown" })
          if (confirmed) { visited.add(child.id); parents.set(child.id, parent); queue.push(child.id) }
        }
      } catch { enumeration = "partial"; findings.add(`Child enumeration unavailable for ${parent}`) }
    }
    // A conflicting ancestor invalidates the whole path, not merely that row.
    const disputed = new Set(candidates.filter(c => c.lineage !== "confirmed" || c.dispatch !== "confirmed").map(c => c.id))
    for (const candidate of candidates) {
      let ancestor = parents.get(candidate.id)
      while (ancestor && ancestor !== root) {
        if (disputed.has(ancestor)) { candidate.lineage = "unknown"; break }
        ancestor = parents.get(ancestor)
      }
    }
    if (queue.length > STOP_LIST_LIMIT) enumeration = "truncated"
    let commands: StopCommand[] = [], shellEnumeration: StopEnumeration = "complete"
    try {
      commands = rows(await bounded(() => client.shells())).map(raw => {
        const shell = record(raw), owner = record(shell.metadata).sessionID
        return { id: typeof shell.id === "string" ? shell.id : "", owner: typeof owner === "string" ? owner : "", ownership: typeof owner === "string" ? "confirmed" : "unknown", backgroundShell: "confirmed" }
      })
    } catch { shellEnumeration = "unavailable" }
    if (shellEnumeration === "complete" && commands.every(command => command.id)) {
      for (const [id, owner] of requestedShells) {
        if (!commands.some(command => command.id === id)) receipt(owner, `Shell ${id}: confirmed no longer running after termination request`)
      }
    }
    const scope = selectStopScope(root, candidates, enumeration, commands, shellEnumeration)
    for (const finding of scope.findings) findings.add(finding)
    empty = scope.nothingToStop
    const owners = new Set(scope.commands.map(c => c.owner))
    for (const command of scope.commands) {
      if (requestedShells.get(command.id) === command.owner) continue
      try {
        await bounded(() => client.removeShell(command.id))
        requestedShells.set(command.id, command.owner)
        receipt(command.owner, `Shell ${command.id}: termination requested (terminal outcome unconfirmed at request time)`)
      } catch { receipt(command.owner, `Shell ${command.id}: termination request failed or timed out; outcome unknown`) }
    }
    let active: Record<string, unknown> | undefined
    try {
      const value = unwrap(await bounded(() => client.active()))
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid active map")
      active = record(value)
    } catch { findings.add("Active session enumeration unavailable; terminal outcomes unknown") }
    for (const id of scope.children) {
      if (active && !(id in active) && !owners.has(id) && shellEnumeration === "complete" && commands.every(c => c.ownership === "confirmed")) {
        receipt(id, requestedInterrupts.has(id) ? "Confirmed not running after interrupt request (not proof of task success)" : "Observed idle (not proof of cancellation or terminal outcome)")
        continue
      }
      try {
        const result = record(unwrap(await bounded(() => client.interrupt(id))))
        requestedInterrupts.add(id)
        receipt(id, result.interrupted === false ? "Interrupt requested; host returned interrupted=false" : result.interrupted === true ? "Interrupt requested; host confirmed interrupt (not task success)" : "Interrupt requested; terminal outcome unconfirmed")
      } catch { receipt(id, "Interrupt request failed or timed out; outcome unknown") }
    }
    if (round < 2) try { await bounded(() => client.wait()) } catch { findings.add("Revisit deadline reached; remaining outcomes unknown"); break }
  }
  return ["[forge stop receipt] Relay these observations; do not start more work.",
    ...(empty && !receipts.size && !findings.size ? ["No native children to stop."] : []),
    ...[...receipts].map(([id, notes]) => `${id}: ${[...notes].join("; ")}`), ...findings,
    "Only explicit confirmations above establish observed stopped activity; task success is not established. The host may interrupt other activity as a collateral effect of a child interrupt; the scope above covers only explicit requests. In a sandbox observation, interrupting a child left its active parent running; this is not a general collateral-behavior guarantee. Interrupting the parent does not guarantee children stop; use /forge stop to request explicit child cancellation."].join("\n")
}
