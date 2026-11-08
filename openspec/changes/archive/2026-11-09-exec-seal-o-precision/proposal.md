# Proposal: exec-seal-o-precision

## Why

The readonly exec seal's `workspace-write` indicator treats the bare short flag `-o` as an
output-target flag for EVERY binary. But `-o` is the most overloaded short flag in the tool
ecosystem: `rg`/`grep` use it for `--only-matching` (a pure-read switch), `kubectl`/`gh` for
output FORMAT, `ssh` for options. Verified live against the shipped classifier
(`classifyExecCommand`, repro 2026-11-08):

- `rg -o "v1\.2\.3" package.json` → **WRITE-CLASS** (the quoted pattern is stripped for
  indicator scanning, so `-o` rebinds onto the next bare token — the READ target itself)
- `rg -o needle.v2 src/` → **WRITE-CLASS** (the unquoted pattern contains a dot, passes the
  `pathLike` guard)

Both are 100% read-only searches. A readonly scout running them is denied AND mis-advised
("set `shape: \"write\"` if your job legitimately mutates") — a false conviction with a wrong
remedy, on exactly the reconnaissance workload the readonly shape exists for.

## What Changes

- The short `-o` flag counts as an output-target flag **only when the command's head binary
  is in a known writer-binary set** (`gcc`/`g++`/`cc`/`c++`/`clang`/`clang++`/`ld`/`rustc`/
  `go`/`curl`/`sort`/`psql`/`dotnet` — binaries whose `-o` denotes an output file). On every
  other binary (known readers like `rg`, and unknown binaries) `-o` flows READ-CLASS —
  fail-open, consistent with the seal's declared posture, and disclosed verbatim in the
  README bypass surface.
- Flag-value binding becomes **quote-aware**: a quoted token immediately following a flag
  binds as that flag's value (`curl -o "out.txt"` still caught; `rg -o "v1\.2"` stops
  rebinding onto a later path token). Quoted-span stripping for the OTHER indicator scans
  (redirect, cmdlet, git, pkg) is unchanged.
- Long-form output flags (`--out`, `--output`, `--out-file`/`--outfile`/`--outFile`,
  `--dest`, `--destination`) are unchanged and stay binary-independent — they are
  unambiguous.
- The writer-binary set is exported as a table (`O_FLAG_WRITER_BINARIES`) alongside the
  existing indicator tables, so the test matrix, the README table and the classifier cannot
  drift apart (the standing no-drift invariant).
- README: `workspace-write` table row updated; the bypass surface list gains "`-o` on
  binaries outside the writer set flows".

## Capabilities

**Modified Capabilities:**

- `tool-partition` — the requirement "Readonly workers execute on a sealed supervised-exec
  channel" gains the `-o` precision clause (writer-binary gate + quote-aware binding) and
  three new scenarios (non-writer `-o` flows; writer `-o` denied; quoted target binds
  correctly). No other requirement moves.

## Impact

- `src/exec-classify.ts` — `workspaceWriteMatch` gains the writer-head gate; a quote-aware
  tokenizer is added next to `stripQuoted`; new exported table. Purity and injectability
  unchanged (still zero fs access at classify time).
- `tests/exec-classify.test.mjs` — regression matrix: both live-reproduced false positives,
  writer catches (`gcc`/`curl`/`go`), quoted-target binding, `kubectl -o yaml`, call-operator
  / quoted-head edges. The suite iterates the exported tables, so coverage follows the
  tables automatically.
- `README.md` — indicator table row + bypass surface (verbatim disclosure duty).
- `plugin.ts` — untouched (the seal wiring, finding bounds and refusal text are unchanged).
- `dist/index.js` — rebuilt (standing red line: committed, self-contained).
- Posture impact, stated honestly: this REDUCES false positives at the cost of disclosed
  false negatives — an unknown writer binary's `-o` now flows READ. That is the seal's
  declared bias (fail-open, belt-in-depth, not a sandbox).
