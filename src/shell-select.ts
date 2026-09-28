// Host-aligned shell interpreter selection (spec: job-supervisor —
// "Host-aligned shell interpreter selection"). Mirrors the upstream chain
// (opencode packages/core/src/shell.ts, verified 2026-09-28): a
// host-configured shell wins when visible in the merged config; Windows
// prefers pwsh → powershell → git-bash → %COMSPEC% (cmd.exe as a
// machine-level capability fallback only); POSIX prefers the environment
// login shell, then bash, then /bin/sh. fish/nu are rejected like upstream.
// Pure logic with injectable probes, memoized per process. No
// @opencode-ai imports; nothing here knows about opencode.

import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export type ShellFamily = "ps" | "cmd" | "posix"

export type ResolvedShell = {
  /** Executable path or name to spawn directly. */
  bin: string
  family: ShellFamily
  /** Login-style invocation (POSIX bash/zsh) — argv gains -l. */
  login: boolean
}

export type ShellSelectDeps = {
  platform?: string
  env?: Record<string, string | undefined>
  which?: (bin: string) => string | undefined
  stat?: (file: string) => { isFile(): boolean } | undefined
}

// Host-configured shell, stashed by the plugin's config hook (fail-soft:
// absent/blank means "use the platform chain"). Resettable for tests.
let hostConfiguredShell: string | undefined
let memo: ResolvedShell | undefined

export function setHostShell(shell: string | undefined): void {
  hostConfiguredShell = shell && shell.trim() ? shell.trim() : undefined
  memo = undefined
}

// Upstream parity: these shells are deliberately rejected (META deny list).
const DENY = new Set(["fish", "nu"])

function shellName(bin: string): string {
  return basename(bin).replace(/\.exe$/i, "").toLowerCase()
}

function classify(bin: string): ResolvedShell {
  const name = shellName(bin)
  if (name === "pwsh" || name === "powershell") return { bin, family: "ps", login: false }
  if (name === "cmd") return { bin, family: "cmd", login: false }
  return { bin, family: "posix", login: name === "bash" || name === "zsh" }
}

function defaultWhich(platform: string, env: Record<string, string | undefined>): (bin: string) => string | undefined {
  return (bin) => {
    try {
      const r = spawnSync(platform === "win32" ? "where" : "which", [bin], {
        env: env as NodeJS.ProcessEnv,
        windowsHide: true,
        timeout: 5000,
      })
      if (r.status !== 0 || !r.stdout) return undefined
      const first = r.stdout.toString().split(/\r?\n/).find((l) => l.trim())
      return first?.trim() || undefined
    } catch {
      return undefined
    }
  }
}

function defaultStat(file: string): { isFile(): boolean } | undefined {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

// Git-bash discovery, host-style: the git binary's install root carries
// bin/bash.exe (…/Git/cmd/git.exe → …/Git/bin/bash.exe).
function gitBash(
  which: (bin: string) => string | undefined,
  stat: (file: string) => { isFile(): boolean } | undefined,
): string | undefined {
  const git = which("git")
  if (!git) return undefined
  const candidate = join(dirname(dirname(git)), "bin", "bash.exe")
  return stat(candidate)?.isFile() ? candidate : undefined
}

/**
 * Resolve the plugin's shell interpreter. Production call sites use
 * `resolveShell()` (memoized, real probes); tests pass explicit `deps` which
 * always recompute and never touch the memo.
 */
export function resolveShell(deps: ShellSelectDeps = {}): ResolvedShell {
  const hasDeps = Object.keys(deps).length > 0
  if (!hasDeps && memo) return memo

  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const which = deps.which ?? defaultWhich(platform, env)
  const stat = deps.stat ?? defaultStat

  const pick = (candidate: string | undefined): ResolvedShell | undefined => {
    if (!candidate) return undefined
    if (DENY.has(shellName(candidate))) return undefined
    const resolved = /^[a-z]:[\\/]/i.test(candidate) || candidate.includes("/") || candidate.includes("\\")
      ? stat(candidate)?.isFile()
        ? candidate
        : which(candidate)
      : which(candidate)
    return resolved ? classify(resolved) : undefined
  }

  let result: ResolvedShell | undefined = pick(hostConfiguredShell)

  if (!result && platform === "win32") {
    result =
      pick("pwsh") ??
      pick("powershell") ??
      pick(gitBash(which, stat)) ??
      pick(env.COMSPEC || "cmd.exe")
  }
  if (!result && platform !== "win32") {
    result = pick(env.SHELL) ?? pick("bash") ?? pick("/bin/sh")
  }
  if (!result) {
    // Absolute last resort (host parity: never fail execution solely because
    // the preferred interpreter was absent).
    result = platform === "win32" ? { bin: env.COMSPEC || "cmd.exe", family: "cmd", login: false } : { bin: "/bin/sh", family: "posix", login: false }
  }

  if (!hasDeps) memo = result
  return result
}

/** Test hygiene: drop the memoized resolution. */
export function resetShellMemo(): void {
  memo = undefined
}
