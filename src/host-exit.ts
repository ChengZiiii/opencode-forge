// Host-exit cleanup matrix (design D2): the 0.3.0 bug was that job cleanup
// hung only on plugin `dispose` and `session.deleted` — neither fires on the
// `opencode run` one-shot exit path. This module wires EVERY exit the Node
// process can take:
//
//   SIGINT / SIGTERM            immediate force pass (a Windows SIGINT can
//                               kill the host mid-handler — no slow graceful
//                               sequence on the signal paths)
//   process 'exit'              force pass, ALWAYS at least once (independent
//                               of the signal latch — the universal belt for
//                               normal exit AND process.exit)
//   uncaughtException /         force pass (the host is on a dying
//   unhandledRejection          trajectory; a false alarm costs a kill of
//                               trees that were doomed anyway)
//   plugin dispose              the ONLY path with time for graceful-then-
//                               force (grace window, best UX)
//
// The Windows job-object fence (src/job-fence.ts) is the layer BELOW this:
// it covers hard-kills where no JS handler can run at all. Survive jobs are
// skipped everywhere (that is what they opted into).
//
// Idempotence is TWO latches, deliberately: `sequenced` collapses repeated
// dispose triggers, while `forceIssued` guarantees the 'exit' belt still
// fires its force pass even when a signal handler was killed halfway
// through (live finding: a Windows SIGINT terminates the host before a
// synchronous graceful sequence completes — the exit handler must not be
// swallowed by the earlier trigger).

import { terminateTreeSync, type SpawnSyncFn } from "./proc.ts"
import type { Job, JobManager } from "./job-manager.ts"

export type ExitCleanupOptions = {
  /** Grace window on the dispose path only (default 3000ms). */
  graceMs?: number
  spawnSyncFn?: SpawnSyncFn
  platform?: string
  /** Test seam: skip the real synchronous grace waits entirely. */
  noWait?: boolean
  /** Teardown after the DISPOSE path only (fence dispose, etc.). Exit/signal
   * paths must NOT run it: the fence watcher's stdin dying with the host is
   * the kernel-level backstop for exactly those paths — closing it early
   * (live finding: a taskkill aimed at a wrapper pid that already died with
   * the host misses the real process, and the fence was then gone too)
   * would orphan grandchildren. */
  after?: () => void
  /** fix-dispatch-dispose-kill D1: rows this predicate exempts are NEVER
   * killed, aborted, or marked killed by the exit matrix (dispose AND every
   * signal/exit path — the option rides construction so all triggers carry
   * it). Dispatch rows (job.dispatch != null) have no local pid; their
   * children are server-side sessions and their continuity is carried by
   * the dispatch journal + restart recovery, so an exit-time kill is pure
   * destruction (journal aborted → recovery skips a live child). Process
   * jobs (pid > 0) keep the current dispose contract. */
  skip?: (job: Job) => boolean
  /** Diagnostics ONLY: one line per trigger with what the matrix saw and
   * did, plus one per kill. A kill here writes no ledger line, which cost a
   * whole sandbox day of guessing whether a plugin dispose had run at all
   * (2026-11-23). Never throws into the cleanup path. */
  trace?: (line: string) => void
}

export type ExitCleanup = {
  /** Trigger by name ("SIGINT" | "SIGTERM" | "exit" | "uncaughtException" | "unhandledRejection" | "dispose"). */
  trigger(kind: string): void
  /** Remove every installed listener (tests). */
  uninstall(): void
}

export function createExitCleanup(manager: JobManager, opts: ExitCleanupOptions = {}): ExitCleanup {
  const graceMs = opts.graceMs ?? 3_000
  let sequenced = false
  let forceIssued = false
  let afterRan = false
  const installed: Array<[NodeJS.Signals | string, () => void]> = []

  const liveTargets = (): Job[] => {
    const targets: Job[] = []
    for (const job of manager.list()) {
      if (job.state === "running" && !job.survive && !opts.skip?.(job)) targets.push(job)
    }
    return targets
  }

  const exemptRows = (): number => manager.list().filter((job) => job.state === "running" && Boolean(opts.skip?.(job))).length
  const trace = (line: string): void => {
    try {
      opts.trace?.(line)
    } catch {
      // Diagnostics never break cleanup.
    }
  }

  const killOne = (job: Job, graceful: boolean) => {
    if (opts.skip?.(job)) return // D1: exempt rows are never killed/marked
    const pid = job.pid ?? 0
    trace(`kill job=${job.id} pid=${pid} owner=${job.ownerSession} graceful=${graceful ? "yes" : "no"}`)
    if (pid > 0) {
      terminateTreeSync(pid, {
        graceMs: graceful ? graceMs : 0,
        spawnSyncFn: opts.spawnSyncFn,
        platform: opts.platform,
        ...(opts.noWait ? { wait: false } : {}),
      })
    }
    try {
      job.killTree()
    } catch {
      // killTree degrades internally.
    }
    manager.markTerminal(job, "killed", null)
  }

  const forcePass = () => {
    if (forceIssued) return
    forceIssued = true
    for (const job of liveTargets()) killOne(job, false)
  }

  const trigger = (kind: string) => {
    if (kind === "dispose") {
      if (sequenced) {
        trace("dispose: ignored (sequenced latch already set)")
        return
      }
      sequenced = true
      const targets = liveTargets()
      trace(`dispose: live targets=${targets.length} exempt rows=${exemptRows()}`)
      for (const job of targets) killOne(job, true)
      forcePass()
      if (!afterRan) {
        afterRan = true
        opts.after?.()
      }
      return
    }
    // Every other exit kind goes straight to the force pass: fast enough to
    // complete before the OS terminates the host, and deduplicated with the
    // 'exit' belt via forceIssued. The fence is deliberately left running —
    // its stdin dying with the host is the kernel-level backstop here.
    if (!forceIssued) trace(`${kind}: live targets=${liveTargets().length} exempt rows=${exemptRows()}`)
    forcePass()
  }

  const onSignal = (kind: string) => () => trigger(kind)
  const wired: Array<[string, () => void]> = [
    ["SIGINT", onSignal("SIGINT")],
    ["SIGTERM", onSignal("SIGTERM")],
    ["exit", onSignal("exit")],
    ["uncaughtException", onSignal("uncaughtException")],
    ["unhandledRejection", onSignal("unhandledRejection")],
  ]
  for (const [ev, fn] of wired) {
    process.on(ev as NodeJS.Signals, fn)
    installed.push([ev as NodeJS.Signals, fn])
  }

  return {
    trigger,
    uninstall() {
      for (const [ev, fn] of installed) {
        try {
          process.removeListener(ev, fn)
        } catch {
          // Never installed / already removed.
        }
      }
    },
  }
}
