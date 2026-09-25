import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"

import { WATCHDOG_ENV_MARK, type LocatedProc } from "./watchdog.ts"

// ---------------------------------------------------------------------------
// Cross-platform process location for the hang-watchdog (D3).
//   POSIX   — exact match of the marker env in /proc/<pid>/environ.
//   Windows — foreign envs are unreadable; infer instead: descendants of the
//             host process created at or after the call's t0. The ancestor
//             constraint plus the time window keep the blast radius at "shell
//             descendants the host started during this call".
// Both paths are fully injectable (listPids/readEnv/execFn) for tests.
// ---------------------------------------------------------------------------

export type Locator = (callID: string, t0: number, cmdNeedle?: string, phase2?: boolean) => Promise<LocatedProc[]>

/**
 * Distinguishing token of a shell command for the Windows inference path.
 * Longest whitespace token wins (paths are single tokens and appear verbatim
 * in both the wrapper's and the child's command lines); degenerate commands
 * fall back to the whole trimmed string.
 */
export function commandNeedle(command: string): string {
  const trimmed = command.trim().replace(/^["']|["']$/g, "")
  if (trimmed.length === 0) return ""
  const tokens = trimmed.split(/\s+/)
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a), "")
  return longest.length >= 6 ? longest : trimmed
}

export type PosixDeps = {
  listPids?: () => number[]
  readEnv?: (pid: number) => Buffer | null
  readCmd?: (pid: number) => string
}

export type WinProc = { pid: number; ppid: number; cmd: string; createdMs: number }

export type WindowsDeps = {
  hostPid?: number
  execFn?: (cmd: string) => string
}

export function markerValue(callID: string): string {
  return `opencode-forge:${callID}`
}

export function createPosixLocator(deps: PosixDeps = {}): Locator {
  const listPids = deps.listPids ?? (() => readdirSync("/proc").map(Number).filter((n) => Number.isInteger(n) && n > 0))
  const readEnv =
    deps.readEnv ??
    ((pid: number) => {
      try {
        return readFileSync(`/proc/${pid}/environ`)
      } catch {
        return null
      }
    })
  const readCmd =
    deps.readCmd ??
    ((pid: number) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`)
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .join(" ")
      } catch {
        return String(pid)
      }
    })
  return async (callID, _t0) => {
    const want = `${WATCHDOG_ENV_MARK}=${markerValue(callID)}`
    const hits: LocatedProc[] = []
    for (const pid of listPids()) {
      const env = readEnv(pid)
      if (!env) continue
      // Exact match inside the NUL-separated environ; never a substring test.
      if (env.toString("utf8").split("\0").includes(want)) hits.push({ pid, cmd: readCmd(pid) })
    }
    return hits
  }
}

// No -AsArray: that switch needs PowerShell 6.2+; stock Windows PowerShell
// 5.1 rejects it. parseWindowsProcs already tolerates the single-object shape.
const PS_LIST_PROCS =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate " +
  "| ConvertTo-Json -Compress"

export function parseWindowsProcs(raw: string): WinProc[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: WinProc[] = []
  for (const p of arr as Array<Record<string, unknown>>) {
    const pid = Number(p?.ProcessId ?? p?.pid)
    const ppid = Number(p?.ParentProcessId ?? p?.ppid)
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue
    const cmd = typeof p?.CommandLine === "string" ? p.CommandLine : ""
    // CIM dates arrive as "/Date(1790375411786)/" (ms) or ISO — accept both.
    let createdMs = Number.NaN
    const cd = p?.CreationDate ?? p?.createdMs
    if (typeof cd === "number") createdMs = cd
    else if (typeof cd === "string") {
      const slash = /\/Date\((\d+)\)\//.exec(cd)
      if (slash) createdMs = Number(slash[1])
      else {
        const t = Date.parse(cd)
        if (!Number.isNaN(t)) createdMs = t
      }
    }
    if (Number.isNaN(createdMs)) continue
    out.push({ pid, ppid, cmd, createdMs })
  }
  return out
}

// CIM CreationDates carry ~1s resolution (they round DOWN inside their
// second) and tool.execute.before fires up to ~1s before the child actually
// spawns — a hard `>= t0` would exclude the very processes created in the
// call's first second. Two seconds of window slack absorbs both, while the
// host-subtree constraint still bounds the blast radius.
const WINDOW_SLACK_MS = 2_000

export function createWindowsLocator(deps: WindowsDeps = {}): Locator {
  const hostPid = deps.hostPid ?? process.pid
  // Direct powershell.exe invocation — execSync's default shell is cmd.exe,
  // which would try to interpret the PowerShell pipeline itself.
  const execFn =
    deps.execFn ??
    ((cmd: string) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8", windowsHide: true, timeout: 15_000 }))
  return async (callID, t0, cmdNeedle, phase2 = false) => {
    let raw = "[]"
    try {
      raw = execFn(PS_LIST_PROCS)
    } catch {
      // PowerShell unavailable/failed: nothing we can safely claim — an
      // empty list turns this act into an honest unresolved report.
      return []
    }
    const procs = parseWindowsProcs(raw)
    // Descendant closure of the host process.
    const children = new Map<number, number[]>()
    for (const p of procs) {
      const list = children.get(p.ppid) ?? []
      list.push(p.pid)
      children.set(p.ppid, list)
    }
    const descendants = new Set<number>()
    const queue = [hostPid]
    while (queue.length > 0) {
      const cur = queue.pop() as number
      for (const child of children.get(cur) ?? []) {
        if (!descendants.has(child)) {
          descendants.add(child)
          queue.push(child)
        }
      }
    }
    // CIM's ParentProcessId is not dependable for host-spawned shells (the
    // same repro run reports the bash tool child under the host one time and
    // under a grandparent shell the next), so subtree membership alone
    // misses the very processes we need. A process is a candidate when it is
    // inside the time window AND (in the host subtree OR carrying the
    // stalled call's own command token). The command branch is at least as
    // precise as the tree branch: it is the literal command text of this
    // call, created during this call.
    const windowStart = t0 - WINDOW_SLACK_MS
    const norm = (s: string) => s.replace(/\\/g, "/")
    // Phase 2 (only reached when wave 1 provably failed to unblock): also
    // processes whose command lives in the stalled command's own directory —
    // that is where #47350-style detached pipe holders sit (their parent is
    // dead and their command differs from the stalled one). Separator-
    // normalized so Git-bash backslash paths match forward-slash needles.
    const slash = cmdNeedle !== undefined ? cmdNeedle.lastIndexOf("/") : -1
    const dirNeedle = phase2 && cmdNeedle !== undefined && slash > 0 ? norm(cmdNeedle.slice(0, slash)) : undefined
    return procs
      .filter(
        (p) =>
          p.createdMs >= windowStart &&
          p.pid !== hostPid &&
          // Self-exclusion: the locator's own powershell probe (and its
          // conhost) always satisfies subtree+window — never kill ourselves.
          // conhost.exe is never the hang culprit either, and killing one
          // would cripple every later probe on the same console.
          !/Win32_Process/.test(p.cmd) &&
          !/conhost\.exe/i.test(p.cmd) &&
          (descendants.has(p.pid) ||
            (cmdNeedle !== undefined && cmdNeedle.length >= 6 && p.cmd.includes(cmdNeedle)) ||
            (dirNeedle !== undefined && dirNeedle.length >= 6 && norm(p.cmd).includes(dirNeedle))),
      )
      .map((p) => ({ pid: p.pid, cmd: p.cmd, createdMs: p.createdMs }))
  }
}

export function createLocator(platform: string = process.platform, posix: PosixDeps = {}, win: WindowsDeps = {}): Locator {
  return platform === "win32" ? createWindowsLocator(win) : createPosixLocator(posix)
}
