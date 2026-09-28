import test from "node:test"
import assert from "node:assert/strict"

import { killTree, shellSpawn, treeKillPlan } from "../src/proc.ts"
import { resolveShell, setHostShell } from "../src/shell-select.ts"

function fakeChild(pid = 4242) {
  const calls = []
  return {
    pid,
    kill(signal) {
      calls.push(signal ?? "SIGTERM")
    },
    killCalls: calls,
  }
}

test("treeKillPlan: windows escalates to taskkill /F /T against the tree", () => {
  assert.deepEqual(treeKillPlan("win32", 4242), { kind: "taskkill", args: ["/pid", "4242", "/F", "/T"] })
})

test("treeKillPlan: posix signals the detached process group", () => {
  assert.deepEqual(treeKillPlan("linux", 4242), { kind: "group", signal: "SIGKILL" })
  assert.deepEqual(treeKillPlan("darwin", 4242), { kind: "group", signal: "SIGKILL" })
})

test("killTree: windows path runs taskkill through the injected spawn", () => {
  const spawned = []
  const child = fakeChild(777)
  killTree(child, {
    platform: "win32",
    spawnFn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts })
      return fakeChild(9999)
    },
  })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].cmd, "taskkill")
  assert.deepEqual(spawned[0].args, ["/pid", "777", "/F", "/T"])
  assert.equal(child.killCalls.length, 0)
})

test("killTree: a missing pid degrades to a direct child kill", () => {
  const child = fakeChild(undefined)
  killTree(child, { platform: "win32", spawnFn: () => { throw new Error("must not spawn") } })
  assert.deepEqual(child.killCalls, ["SIGTERM"])
})

test("killTree: posix group kill failure falls back to a direct SIGKILL", () => {
  const child = fakeChild(1234)
  // No process group 1234 exists in the test process, so the group signal
  // throws and the fallback fires.
  killTree(child, { platform: "linux" })
  assert.deepEqual(child.killCalls, ["SIGKILL"])
})

test("shellSpawn: PowerShell family spawns the interpreter directly with the exit-code guard", () => {
  const captured = []
  const fakeSpawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild(1)
  }
  shellSpawn(fakeSpawn, "echo hi", {
    shell: { bin: "pwsh.exe", family: "ps", login: false },
    cwd: "/w",
    env: { FORGE_JOB_ID: "j-1", PATH: undefined },
    detached: true,
    windowsHide: true,
  })
  assert.equal(captured.length, 1)
  const { cmd, args, opts } = captured[0]
  assert.equal(cmd, "pwsh.exe")
  assert.deepEqual(args, ["-NoProfile", "-Command", "echo hi\nexit $LASTEXITCODE"])
  assert.equal("shell" in opts, false, "no Node shell option — explicit argv only")
  assert.equal(opts.cwd, "/w")
  assert.equal(opts.detached, true)
  assert.equal(opts.windowsHide, true)
  assert.equal(opts.env.FORGE_JOB_ID, "j-1")
  assert.equal("PATH" in opts.env, true, "parent env merged")
})

test("shellSpawn: cmd fallback and POSIX login/non-login argv forms", () => {
  const forms = [
    [{ bin: "cmd.exe", family: "cmd", login: false }, ["/c", "echo hi"]],
    [{ bin: "/bin/bash", family: "posix", login: true }, ["-l", "-c", "echo hi"]],
    [{ bin: "/bin/sh", family: "posix", login: false }, ["-c", "echo hi"]],
  ]
  for (const [shell, wantArgs] of forms) {
    const captured = []
    shellSpawn((cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      return fakeChild(1)
    }, "echo hi", { shell })
    assert.equal(captured[0].cmd, shell.bin)
    assert.deepEqual(captured[0].args, wantArgs)
    assert.equal("shell" in captured[0].opts, false)
  }
})

test("shellSpawn: detached defaults per platform and can be forced off", () => {
  const captured = []
  const fakeSpawn = (cmd, args, opts) => {
    captured.push(opts)
    return fakeChild(1)
  }
  const ps = { bin: "pwsh.exe", family: "ps", login: false }
  shellSpawn(fakeSpawn, "a", { shell: ps })
  assert.equal(captured[0].detached, process.platform !== "win32")
  shellSpawn(fakeSpawn, "b", { shell: ps, detached: false })
  assert.equal(captured[1].detached, false)
})

// ---------------------------------------------------------------------------
// Host-aligned interpreter selection (align-shell-interpreter)
// ---------------------------------------------------------------------------

const fakeStat = (files) => (file) => (files.has(file) ? { isFile: () => true } : undefined)

test("resolveShell: windows chain — pwsh first, then powershell, then git-bash, then COMSPEC", () => {
  const win = { platform: "win32", env: { COMSPEC: "C:\\Windows\\system32\\cmd.exe" } }
  const mk = (whichMap, files) => ({ ...win, which: (b) => whichMap[b], stat: fakeStat(new Set(files)) })

  let r = resolveShell(mk({ pwsh: "C:\\pwsh\\pwsh.exe", powershell: "C:\\ps\\powershell.exe" }, ["C:\\pwsh\\pwsh.exe"]))
  assert.deepEqual([r.bin, r.family], ["C:\\pwsh\\pwsh.exe", "ps"])

  r = resolveShell(mk({ powershell: "C:\\ps\\powershell.exe" }, ["C:\\ps\\powershell.exe"]))
  assert.deepEqual([r.bin, r.family], ["C:\\ps\\powershell.exe", "ps"])

  // git-bash discovered relative to the git binary's install root
  r = resolveShell(mk({ git: "C:\\Program Files\\Git\\cmd\\git.exe" }, ["C:\\Program Files\\Git\\bin\\bash.exe"]))
  assert.deepEqual([r.bin, r.family, r.login], ["C:\\Program Files\\Git\\bin\\bash.exe", "posix", true])

  // machine-level tail: bare COMSPEC
  r = resolveShell(mk({}, ["C:\\Windows\\system32\\cmd.exe"]))
  assert.deepEqual([r.bin, r.family], ["C:\\Windows\\system32\\cmd.exe", "cmd"])
})

test("resolveShell: host-configured shell wins; fish SHELL falls through to bash on POSIX", () => {
  setHostShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
  try {
    const r = resolveShell({
      platform: "win32",
      env: {},
      which: () => undefined,
      stat: fakeStat(new Set(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"])),
    })
    assert.deepEqual([r.family, r.login], ["ps", false])
  } finally {
    setHostShell(undefined)
  }

  let r = resolveShell({
    platform: "linux",
    env: { SHELL: "/usr/bin/fish" },
    which: (b) => (b === "bash" ? "/usr/bin/bash" : undefined),
    stat: fakeStat(new Set(["/usr/bin/fish", "/usr/bin/bash"])),
  })
  assert.deepEqual([r.bin, r.family, r.login], ["/usr/bin/bash", "posix", true], "denied SHELL falls to bash")

  r = resolveShell({ platform: "linux", env: {}, which: () => undefined, stat: fakeStat(new Set(["/bin/sh"])) })
  assert.deepEqual([r.bin, r.family, r.login], ["/bin/sh", "posix", false], "sh tail without login")
})
