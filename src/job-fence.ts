// OS-level safety net for forge jobs on Windows (design D3): a Job Object
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE around every spawned job tree.
// Whoever holds the job-object handle owns the fence: the kernel kills
// every process in the job the moment the last handle closes — including
// the host's own hard-kill (taskkill /F), where no JS exit handler can run.
//
// Node exposes no job-object API and a standing FFI dependency was rejected
// (design D5), so the handle is held by ONE shared watcher subprocess
// (powershell -NoProfile) whose stdin is a pipe from this host process:
//   host dies (any way)  ->  stdin pipe breaks  ->  watcher exits
//   watcher exits        ->  job-object handle closes  ->  kernel kills the tree
// The watcher also survives watcher-crash safety: its death merely closes the
// handle early, which kills the fenced trees (fail-safe direction — never a
// leak).
//
// Race-free membership: assigning the shell-wrapper pid alone is NOT enough
// (live finding: the real command is a grandchild born before the watcher
// finishes its Add-Type compile, too late for job inheritance). The watcher
// therefore runs a periodic process-table sweep (CreateToolhelp32Snapshot)
// and assigns EVERY descendant of every tracked pid — bounded depth, so a
// recycled ancestor pid cannot sweep unrelated processes into the job.
// Pids still arrive as "<pid>\n" stdin lines; lines buffer in the pipe while
// the shim compiles (a hard host death inside that ~1s window is covered by
// the JS exit matrix for normal exits; the boundary is recorded in README).
// POSIX has no equivalent without PDEATHSIG's parent-thread pitfalls
// (rejected in design): process groups + the exit matrix carry the cleanup,
// and next-start registry scanning reports orphans.

import { spawn, type ChildProcess } from "node:child_process"
import type { SpawnFn } from "./proc.ts"

// KILL_ON_JOB_CLOSE; no BREAKAWAY_OK — Chromium-family processes that
// explicitly break away escape the fence (known boundary, README).
const FENCE_PS_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class ForgeJobFence {
  [StructLayout(LayoutKind.Sequential)]
  public struct BASIC_LIMITS {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct EXTENDED_LIMITS {
    public BASIC_LIMITS Basic;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PE32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, int cbInfo);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll")]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool Process32FirstW(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool Process32NextW(IntPtr h, ref PE32 e);

  const int EXTENDED_LIMITS_CLASS = 9;
  const uint KILL_ON_JOB_CLOSE = 0x2000;
  const uint PROCESS_ALL_ACCESS = 0x1FFFFF;
  const uint SNAP_PROCESS = 0x2;
  // Descendant walk bound: deep enough for wrapper -> command -> children,
  // shallow enough that a recycled ancestor pid cannot pull unrelated
  // processes into the kill-on-close job.
  const int MAX_DEPTH = 4;

  static IntPtr _job = IntPtr.Zero;
  static readonly HashSet<uint> _roots = new HashSet<uint>();
  static readonly HashSet<uint> _fenced = new HashSet<uint>();
  static readonly object _gate = new object();
  static Timer _sweep;

  static void Sweep(object state) {
    try {
      var parents = new Dictionary<uint, uint>();
      var h = CreateToolhelp32Snapshot(SNAP_PROCESS, 0);
      if (h != IntPtr.Zero && h != new IntPtr(-1)) {
        var e = new PE32();
        e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
        if (Process32FirstW(h, ref e)) {
          do { parents[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(h, ref e));
        }
        CloseHandle(h);
      }
      lock (_gate) {
        if (_job == IntPtr.Zero) return;
        foreach (var kv in parents) {
          if (_fenced.Contains(kv.Key)) continue;
          uint p = kv.Key;
          int depth = 0;
          bool tracked = false;
          while (p != 0 && depth <= MAX_DEPTH) {
            if (_roots.Contains(p)) { tracked = true; break; }
            uint up;
            if (parents.TryGetValue(p, out up)) { p = up; } else { p = 0; }
            depth++;
          }
          if (!tracked) continue;
          var ph = OpenProcess(PROCESS_ALL_ACCESS, false, (int)kv.Key);
          if (ph != IntPtr.Zero) {
            if (AssignProcessToJobObject(_job, ph)) _fenced.Add(kv.Key);
            CloseHandle(ph);
          }
        }
      }
    } catch { }
  }

  public static int Run() {
    _job = CreateJobObject(IntPtr.Zero, null);
    if (_job == IntPtr.Zero) return 2;
    var info = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMITS)));
    try {
      Marshal.WriteInt32(info, 16, (int)KILL_ON_JOB_CLOSE);  // Basic.LimitFlags offset
      if (!SetInformationJobObject(_job, EXTENDED_LIMITS_CLASS, info, Marshal.SizeOf(typeof(EXTENDED_LIMITS)))) return 3;
    } finally {
      Marshal.FreeHGlobal(info);
    }
    _sweep = new Timer(Sweep, null, 0, 400);
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      uint pid;
      var t = line.Trim();
      if (t.Length > 0 && uint.TryParse(t, out pid) && pid > 0) {
        lock (_gate) { _roots.Add(pid); }
        var ph = OpenProcess(PROCESS_ALL_ACCESS, false, (int)pid);
        if (ph != IntPtr.Zero) {
          if (AssignProcessToJobObject(_job, ph)) {
            lock (_gate) { _fenced.Add(pid); }
          }
          CloseHandle(ph);
        }
      }
    }
    return 0;  // stdin EOF: the host is gone -> exit -> handle closes -> kernel kills
  }
}
"@
[ForgeJobFence]::Run()
exit $LASTEXITCODE
`

export type JobFence = {
  /** Fence a freshly spawned job tree (writes the pid line to the watcher). */
  assign(pid: number): void
  /** End the watcher (stdin EOF). Only meaningful at host shutdown. */
  dispose(): void
  /** False when the watcher died or was never started — callers degrade silently. */
  readonly healthy: boolean
}

export type FenceOptions = {
  spawnFn?: SpawnFn
  platform?: string
  /** Degrade reporting (ledgered by the caller); never throws. */
  onDegrade?: (reason: string) => void
}

export function createJobFence(opts: FenceOptions = {}): JobFence | null {
  const platform = opts.platform ?? process.platform
  if (platform !== "win32") return null
  const spawnFn = opts.spawnFn ?? spawn
  let child: ChildProcess
  try {
    child = spawnFn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", FENCE_PS_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    })
  } catch (err) {
    opts.onDegrade?.(`job fence not started: spawn failed (${String(err).slice(0, 120)})`)
    return null
  }
  const stdin = child.stdin
  if (!stdin) {
    opts.onDegrade?.("job fence not started: watcher has no stdin")
    return null
  }
  let healthy = true
  child.on("exit", () => {
    healthy = false
  })
  child.on("error", () => {
    healthy = false
  })
  // Degrade is ledgered exactly once per fence lifetime — a dead watcher
  // fails every later assign, but the note must not spam.
  let reported = false
  const fail = (why: string) => {
    healthy = false
    if (reported) return
    reported = true
    opts.onDegrade?.(why)
  }
  return {
    assign(pid: number) {
      if (!healthy || !stdin.writable) {
        fail("job fence watcher gone; job relies on the JS exit matrix only")
        return
      }
      try {
        stdin.write(`${pid}\n`)
      } catch (err) {
        fail(`job fence write failed (${String(err).slice(0, 120)})`)
      }
    },
    dispose() {
      try {
        stdin.end()
      } catch {
        // Already gone — the fence has already closed (trees already killed).
      }
    },
    get healthy() {
      return healthy
    },
  }
}
