// Normalized evidence, not a host response schema. The caller must independently
// verify both the lineage to the invoking session and native dispatch provenance.
export type StopProof = "confirmed" | "excluded" | "unknown"
export type StopEnumeration = "complete" | "partial" | "unavailable" | "truncated" | "timeout"
export type StopCandidate = { id: string; lineage: StopProof; dispatch: StopProof }
export type StopCommand = { id: string; owner: string; ownership: StopProof; backgroundShell: StopProof }

// This is a scope preview only; it makes no requests and claims no outcomes.
export function selectStopScope(
  invokingSession: string,
  children: readonly StopCandidate[],
  childEnumeration: StopEnumeration,
  commands: readonly StopCommand[],
  commandEnumeration: StopEnumeration,
) {
  const findings: string[] = []
  const eligible = new Set<string>()
  let unknownChildren = !invokingSession || childEnumeration !== "complete"
  let unknownCommands = commandEnumeration !== "complete"
  if (!invokingSession) findings.push("Invoking session unknown")
  if (childEnumeration !== "complete") findings.push(`Child enumeration ${childEnumeration}; remaining count unknown`)
  if (unknownCommands) findings.push(`Shell enumeration ${commandEnumeration}; remaining count unknown`)
  for (const child of children) {
    if (child.id === invokingSession || child.lineage === "excluded" || child.dispatch === "excluded") continue
    if (invokingSession && child.id && child.lineage === "confirmed" && child.dispatch === "confirmed" &&
        children.every(other => other.id !== child.id || (other.lineage === "confirmed" && other.dispatch === "confirmed"))) {
      eligible.add(child.id)
    } else {
      unknownChildren = true
      findings.push(`Child ${child.id || "(unknown ID)"}: scope not confirmed`)
    }
  }
  const selected = new Map<string, string>()
  for (const command of commands) {
    if (command.backgroundShell === "excluded" || command.ownership === "excluded") continue
    if (command.ownership === "confirmed" && command.owner && !eligible.has(command.owner)) continue
    if (command.id && eligible.has(command.owner) && command.ownership === "confirmed" && command.backgroundShell === "confirmed" &&
        commands.every(other => other.id !== command.id || (other.owner === command.owner && other.ownership === "confirmed" && other.backgroundShell === "confirmed"))) {
      selected.set(command.id, command.owner)
    } else {
      unknownCommands = true
      findings.push(`Command ${command.id || "(unknown ID)"}: scope not confirmed`)
    }
  }
  return {
    children: [...eligible],
    commands: [...selected].map(([id, owner]) => ({ id, owner })),
    unknownChildren,
    unknownCommands: unknownCommands || unknownChildren,
    nothingToStop: !unknownChildren && eligible.size === 0,
    findings,
  }
}
