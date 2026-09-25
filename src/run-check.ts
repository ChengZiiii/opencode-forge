// Verification executors for the forge goal harness.
//
// Two kinds of checks, both executed BY THE PLUGIN on the host (never by the
// model's own bash): shell commands (spawned with the worktree as cwd and a
// per-command timeout) and file contracts (re-read from disk inside the
// project boundary, literal substring assertion). No @opencode-ai imports;
// the shell runner is injectable so tests drive fake outcomes determinately.

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { killTree } from "./proc.ts"
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  type CheckItem,
} from "./goal-file.ts"

export type CheckOutcome = {
  index: number
  kind: "shell" | "contains"
  label: string
  ok: boolean
  detail: string
  durationMs: number
}

export type ShellRunner = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; output: string; timedOut: boolean; spawnError?: string }>

export const OUTPUT_LIMIT = 2048

// Real shell execution: shell:true (cmd.exe on Windows, sh elsewhere),
// stdout+stderr merged and truncated, hard kill on timeout. On Windows the
// kill escalates to `taskkill /F /T` (the direct child is cmd.exe; the
// command runs as a grand-child); on POSIX the child is spawned detached so
// the whole process group can be signalled.
export const defaultShellRunner: ShellRunner = (cmd, opts) =>
  new Promise((resolveRun) => {
    let child
    try {
      child = spawn(cmd, {
        shell: true,
        cwd: opts.cwd,
        windowsHide: true,
        ...(process.platform !== "win32" ? { detached: true } : {}),
      })
    } catch (err) {
      resolveRun({ code: null, output: "", timedOut: false, spawnError: String(err) })
      return
    }
    let output = ""
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, opts.timeoutMs)
    // Safety net: never hold the gate longer than timeout + 30s even if the
    // tree kill raced (orphaned grand-child still streaming). Unref'd and
    // cleared on settle so a completed check leaves no timer delaying
    // process exit.
    const failsafe = setTimeout(
      () => settle({ code: null, output, timedOut: true, spawnError: "timeout settle fallback" }),
      opts.timeoutMs + 30_000,
    )
    failsafe.unref?.()
    const settle = (r: { code: number | null; output: string; timedOut: boolean; spawnError?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(failsafe)
      resolveRun(r)
    }
    child.stdout?.on("data", (d: Buffer) => {
      if (output.length < OUTPUT_LIMIT * 2) output += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      if (output.length < OUTPUT_LIMIT * 2) output += d.toString()
    })
    child.on("error", (err) => settle({ code: null, output, timedOut, spawnError: err.message }))
    child.on("close", (code) => settle({ code, output, timedOut }))
  })

// Test seam: swap the shell runner (goal-mode tests inject fakes).
let shellRunner: ShellRunner = defaultShellRunner
export function setShellRunnerForTests(runner: ShellRunner | null): void {
  shellRunner = runner ?? defaultShellRunner
}

function truncateOutput(output: string): string {
  const flat = output.replace(/\r?\n/g, " ⏎ ").trim()
  return flat.length > OUTPUT_LIMIT ? `${flat.slice(0, OUTPUT_LIMIT)}…` : flat
}

// Path boundary: the resolved target must be the worktree itself or live
// under it — `..` escapes and absolute-path tricks are rejected.
function insideWorktree(worktree: string, file: string): boolean {
  const root = resolve(worktree)
  const abs = resolve(root, file)
  return abs === root || abs.startsWith(root + sep)
}

async function runShellItem(item: Extract<CheckItem, { kind: "shell" }>, index: number, worktree: string): Promise<CheckOutcome> {
  const timeoutSec = Math.min(item.timeoutSec ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC)
  const started = Date.now()
  const r = await shellRunner(item.cmd, { cwd: worktree, timeoutMs: timeoutSec * 1000 })
  const durationMs = Date.now() - started
  if (r.spawnError) {
    return { index, kind: "shell", label: item.cmd, ok: false, detail: `spawn failed: ${r.spawnError}`, durationMs }
  }
  if (r.timedOut) {
    return { index, kind: "shell", label: item.cmd, ok: false, detail: `timed out after ${timeoutSec}s (partial output: ${truncateOutput(r.output) || "none"})`, durationMs }
  }
  return {
    index,
    kind: "shell",
    label: item.cmd,
    ok: r.code === 0,
    detail: `exit=${r.code} ${truncateOutput(r.output)}`.trim(),
    durationMs,
  }
}

function runContainsItem(item: Extract<CheckItem, { kind: "contains" }>, index: number, worktree: string): CheckOutcome {
  const started = Date.now()
  const label = `${item.file} :: ${item.text}`
  if (!insideWorktree(worktree, item.file)) {
    return { index, kind: "contains", label, ok: false, detail: "path escapes the workspace boundary", durationMs: Date.now() - started }
  }
  const abs = join(worktree, item.file)
  let content: string
  try {
    content = readFileSync(abs, "utf8")
  } catch (err) {
    return { index, kind: "contains", label, ok: false, detail: `cannot read file: ${(err as Error).message}`, durationMs: Date.now() - started }
  }
  const ok = content.includes(item.text)
  return {
    index,
    kind: "contains",
    label,
    ok,
    detail: ok ? `found in ${item.file} (${content.length} chars)` : `required text not found in ${item.file} (${content.length} chars)`,
    durationMs: Date.now() - started,
  }
}

export async function runChecks(checks: CheckItem[], worktree: string): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (let i = 0; i < checks.length; i++) {
    const item = checks[i]
    outcomes.push(item.kind === "shell" ? await runShellItem(item, i + 1, worktree) : runContainsItem(item, i + 1, worktree))
  }
  return outcomes
}

export function outcomesAllOk(outcomes: CheckOutcome[]): boolean {
  return outcomes.every((o) => o.ok)
}

export function formatOutcomes(outcomes: CheckOutcome[]): string {
  return outcomes.map((o) => `#${o.index} [${o.ok ? "PASS" : "FAIL"}] (${o.kind}) ${o.label}\n    ${o.detail}`).join("\n")
}
