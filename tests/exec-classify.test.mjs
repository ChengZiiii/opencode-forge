import test from "node:test"
import assert from "node:assert/strict"

import {
  classifyExecCommand,
  EXEC_SEAL_INDICATORS,
  MUTATING_CMDLETS,
  GIT_MUTATING_SUBCOMMANDS,
  PKG_MUTATING_COMMANDS,
  WRITE_TARGET_FLAGS,
} from "../src/exec-classify.ts"

// readonly-exec-seal — the pure classifier matrix (spec: tool-partition —
// "Readonly workers execute on a sealed supervised-exec channel"). Every
// covered WRITE-CLASS indicator from the delta's minimum set is exercised,
// iterating the EXPORTED tables so the docs, the tables and the classifier
// cannot drift. Unclassifiable shapes are READ-CLASS (fail-open on the
// channel — the seal is belt-in-depth, not a sandbox).

const W = (cmd, opts) => classifyExecCommand(cmd, opts)

// ---------------------------------------------------------------------------
// Redirect indicator (bash + PowerShell family share the operators)

test("redirect: bash and PowerShell forms are WRITE-CLASS", () => {
  for (const cmd of [
    "node build.js > out.txt",
    "node build.js >> out.txt",
    "echo hi >notes.md",
    "node build.js > out.txt 2>&1",
    "node build.js 2> err.txt",
    "Get-ChildItem > listing.txt",
    "Get-ChildItem >> listing.txt",
    "Get-ChildItem *> all.txt",
    "cmd /c dir 1> log.txt",
  ]) {
    const v = W(cmd)
    assert.equal(v.klass, "WRITE", `${cmd} must be WRITE-CLASS`)
    assert.equal(v.indicator, "redirect", `${cmd} names the redirect indicator`)
    assert.ok(v.detail.includes(">"), `${cmd} carries the matched fragment`)
  }
})

test("redirect: fd-merges alone are NOT file writes — READ-CLASS", () => {
  assert.equal(W("node build.js 2>&1").klass, "READ")
})

test("redirect: arrows inside quoted code do not trip the scan", () => {
  assert.equal(W(`node -e "const f = (x) => x + 1; console.log(f(1))"`).klass, "READ")
  assert.equal(W("echo 'a -> b'").klass, "READ")
})

// ---------------------------------------------------------------------------
// Mutating cmdlets (table-driven: every exported cmdlet)

test("mutating-cmdlet: every table entry is WRITE-CLASS", () => {
  for (const cmdlet of MUTATING_CMDLETS) {
    for (const form of [cmdlet, cmdlet.toLowerCase()]) {
      const v = W(`${form} -Path notes.md -Value x`)
      assert.equal(v.klass, "WRITE", `${form} must be WRITE-CLASS`)
      assert.equal(v.indicator, "mutating-cmdlet")
      assert.ok(v.detail.toLowerCase().includes(form.toLowerCase()))
    }
  }
  // The spec's canonical shapes
  assert.equal(W("Set-Content -Path notes.md -Value x").indicator, "mutating-cmdlet")
  assert.equal(W("New-Item -Path src/gen -ItemType Directory").indicator, "mutating-cmdlet")
})

test("mutating-cmdlet: read-only cmdlet siblings are READ-CLASS", () => {
  for (const cmd of ["Get-Content notes.md", "Get-ChildItem src/", "Get-Item package.json", "Select-String -Pattern TODO src/"]) {
    assert.equal(W(cmd).klass, "READ", `${cmd} is read-only`)
  }
})

// ---------------------------------------------------------------------------
// Git mutating subcommands (table-driven: every exported subcommand)

test("git-mutation: every exported subcommand is WRITE-CLASS", () => {
  for (const sub of GIT_MUTATING_SUBCOMMANDS) {
    const v = W(`git ${sub} -A`)
    assert.equal(v.klass, "WRITE", `git ${sub} must be WRITE-CLASS`)
    assert.equal(v.indicator, "git-mutation")
    assert.ok(v.detail.toLowerCase().startsWith("git"))
  }
})

test("git-mutation: read-only git is READ-CLASS", () => {
  for (const cmd of ["git log --oneline -10", "git status", "git diff HEAD~1", "git show abc123", "git ls-files"]) {
    assert.equal(W(cmd).klass, "READ", `${cmd} is read-only`)
  }
})

test("git-mutation: subcommand names must not match substrings of flags/files", () => {
  assert.equal(W("git log --grep=added").klass, "READ", "--grep=added is not `git add`")
})

// ---------------------------------------------------------------------------
// Package-manager writes (table + aliases)

test("pkg-mutation: published/installing forms are WRITE-CLASS", () => {
  for (const cmd of [...PKG_MUTATING_COMMANDS, "npm i", "npm ci", "npm add left-pad", "bun install", "pip3 install requests"]) {
    const v = W(cmd)
    assert.equal(v.klass, "WRITE", `${cmd} must be WRITE-CLASS`)
    assert.equal(v.indicator, "pkg-mutation")
  }
})

test("pkg-mutation: read-only package queries are READ-CLASS", () => {
  for (const cmd of ["npm ls", "npm run build", "npm view left-pad", "pip list", "pip show requests"]) {
    assert.equal(W(cmd).klass, "READ", `${cmd} is read-only`)
  }
})

// ---------------------------------------------------------------------------
// Workspace-path write targets (explicit output flags; command-string parse
// only, zero fs)

test("workspace-write: output flags with workspace-relative targets are WRITE-CLASS", () => {
  for (const flag of WRITE_TARGET_FLAGS) {
    const v = W(`node tools/gen.mjs ${flag} src/generated.ts`)
    assert.equal(v.klass, "WRITE", `${flag} with a relative target must be WRITE-CLASS`)
    assert.equal(v.indicator, "workspace-write")
  }
  // attached --flag=value form
  const v = W("node tools/gen.mjs --out=src/generated.ts")
  assert.equal(v.klass, "WRITE")
  assert.equal(v.indicator, "workspace-write")
})

test("workspace-write: absolute targets resolve against the injected workspaceRoot", () => {
  const root = "C:/Users/soren/work/repo"
  assert.equal(W(`tsc --outFile C:/Users/soren/work/repo/src/x.ts`, { workspaceRoot: root }).indicator, "workspace-write")
  // flag list covers -o / --output forms too
  assert.equal(W(`gcc -o C:/Users/soren/work/repo/app.exe main.c`, { workspaceRoot: root }).indicator, "workspace-write")
  assert.equal(W(`node gen.mjs --output C:/Users/soren/work/OTHER/x.ts`, { workspaceRoot: root }).klass, "READ", "outside the workspace is not sealed (channel posture: workspace writes only)")
  assert.equal(W("node gen.mjs --output C:/elsewhere/x.ts").klass, "READ", "no workspaceRoot injected — unresolvable absolute target fails open")
})

test("workspace-write: -o followed by a non-path pattern stays READ-CLASS", () => {
  assert.equal(W("rg -o TODO src/").klass, "READ", "rg's -o takes no output path")
  assert.equal(W("node gen.mjs --out --verbose").klass, "READ", "a following flag is not a value")
})

// ---------------------------------------------------------------------------
// Read-class samples from the spec (inspection, search, read-only evals)

test("READ-CLASS: spec samples flow", () => {
  for (const cmd of [
    "rg TODO src/",
    "grep -rn TODO src/",
    "git log --oneline -10",
    "git status",
    "git diff",
    "node --version",
    "node -e \"console.log(process.version)\"",
    "python -c \"print(1+1)\"",
    "ls -la",
    "Get-Content README.md",
    "bun run typecheck",
    "node --test tests/exec-classify.test.mjs",
  ]) {
    assert.equal(W(cmd).klass, "READ", `${cmd} is READ-CLASS`)
  }
})

test("READ-CLASS: unclassifiable / exotic shapes fail open to READ-CLASS", () => {
  for (const cmd of ["", "   ", "some-script-that-writes-internally.mjs", "powershell -EncodedPayload ZgBvAG8=", "Start-Process notepad.exe"]) {
    assert.equal(W(cmd).klass, "READ", `${JSON.stringify(cmd)} fails open`)
  }
})

test("indicator tables: the README cross-reference covers exactly the five delta indicators", () => {
  assert.deepEqual(
    EXEC_SEAL_INDICATORS.map((i) => i.id),
    ["redirect", "mutating-cmdlet", "git-mutation", "pkg-mutation", "workspace-write"],
  )
  for (const row of EXEC_SEAL_INDICATORS) assert.ok(row.covers.length > 0, `${row.id} carries its coverage text`)
})
