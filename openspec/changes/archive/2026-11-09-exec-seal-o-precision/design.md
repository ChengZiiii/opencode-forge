# Design — exec-seal-o-precision

## Context

`src/exec-classify.ts` classifies forge_shell commands for the readonly exec seal. Its
`workspace-write` indicator includes the bare short flag `-o` in `WRITE_TARGET_FLAGS`, so
ANY binary's `-o <path-like-token>` trips WRITE-CLASS. Two false-positive mechanisms,
reproduced live against the shipped classifier on 2026-11-08 (repro:
`classifyExecCommand` direct calls):

1. **Quote-strip rebinding.** `stripQuoted` removes quoted spans before tokenizing, so in
   `rg -o "v1\.2\.3" package.json` the pattern vanishes and `-o` rebinds onto the next
   bare token — `package.json`, the READ target. Result: WRITE-CLASS, detail
   `-o package.json`.
2. **Dotted-pattern pass-through.** In `rg -o needle.v2 src/` the unquoted pattern
   contains a dot, satisfies the `pathLike` guard, and is a relative "path" → WRITE-CLASS.

The only guarded shape today is a bare word with no `./\` (`rg -o TODO src/`). The victims
are readonly scouts (`shape: "readonly"`) — the exact workload the seal was built to
protect — who get a hard denial plus a wrong remedy pointer.

`-o` is ecologically overloaded: output FILE (gcc/clang/ld/rustc/go/curl/sort/psql/dotnet),
only-MATCHING (rg/grep), output FORMAT (kubectl/gh), OPTIONS (ssh). A single token shape
cannot disambiguate across binaries.

## Goals / Non-Goals

**Goals**

- Zero false positives on the two reproduced shapes (and their class), while keeping the
  unambiguous catches (`gcc -o out.exe`, `curl -o out.txt`, `go build -o bin/app`).
- Keep the seal's declared posture: pure string classifier, fail-open on ambiguity,
  README-disclosed bypass surface (the change trades undisclosed false positives for
  DISCLOSED false negatives — the honest direction for a belt, not a sandbox).
- Keep the no-drift invariant: tables exported, tests and README iterate them.

**Non-Goals**

- No new indicators, no broadening of other indicators; redirect/cmdlet/git/pkg scans and
  their stripping behavior are untouched.
- No per-binary semantic modeling beyond the writer set (no "known reader" denylist — see
  D3).
- No OS-level sealing (settled in readonly-exec-seal D3, not reopened).
- No change to seal wiring, finding bounds, or refusal text in `plugin.ts`.
- Publish/rollout orchestration stays outside this change (batch-level, user-instructed).

## Decisions

### D1 — Writer-binary allowlist gates the short `-o` (adopted)

`-o` counts as an output-target flag ONLY when the command's head binary resolves into
`O_FLAG_WRITER_BINARIES`. Head resolution rules (deterministic, string-only):

- Tokenize quote-aware (D2); take the first token; skip a leading `&` (PowerShell call
  operator). (`env VAR=...`-style prefixes are NOT skipped — an `env`-prefixed writer resolves head=`env`
  and flows READ; accepted at review as the same disclosed fail-open class as `cmd /c` wrappers, with this
  note as the record.)
- If the head token is quoted, use its content. Take the basename (split on `/` and `\`),
  lowercase, strip a trailing `.exe`.
- Membership is exact-match against the exported table.

Initial set: `gcc, g++, cc, c++, clang, clang++, ld, rustc, go, curl, sort, psql, dotnet`.
Rationale per member: compilers/linkers/rustc/ld emit binaries by `-o`; `curl -o` writes a
file; `sort -o` writes (bash-family semantics — under PowerShell `sort` aliases
Sort-Object which has no `-o` and would error anyway, so the over-catch is free);
`psql -o` sends output to a file; `go build/test -o` writes a binary; `dotnet build -o`
sets an output directory. Every other binary — known readers (`rg`, `grep`, `kubectl`,
`gh`, `ssh`) AND unknown binaries — flows READ on `-o`. That is fail-open, matches the
header posture of `exec-classify.ts`, and the README says so verbatim.

Table exported as `O_FLAG_WRITER_BINARIES` beside the other indicator tables; the test
matrix and README table iterate it (no-drift invariant extended).

### D2 — Quote-aware tokenizer for flag-value binding (adopted)

Add `tokenizeCommand(cmd): Array<{ text: string; quoted: boolean }>` (single scanner,
same quote rules as `stripQuoted`). Two tracks, explicitly separated:

- **Indicator scans** (redirect, cmdlets, git, pkg) keep running on `stripQuoted` output —
  unchanged behavior, no new false negatives there.
- **Flag-value binding** in `workspaceWriteMatch` runs on the quote-aware token list: the
  value candidate is the adjacent token INCLUDING quoted ones (`curl -o "out.txt"` binds
  `out.txt`; `rg -o "v1\.2\.3" package.json` binds the pattern — which then fails D1's
  writer gate anyway, belt over belt).

This closes the latent rebinding class for every flag in `WRITE_TARGET_FLAGS`, not just
`-o` (a quoted argument can no longer shift a flag onto a later token).

### D3 — Rejected alternatives

- **Drop `-o` from the flags entirely.** Simplest, but loses every `gcc -o`/`curl -o`/
  `go build -o` catch on the channel for zero additional precision over D1. Rejected.
- **Pattern heuristics on the value** (regex metachars ⇒ pattern, extension whitelist ⇒
  path, …). Whack-a-mole: `needle.v2` has no metachars; `data.json` is a legal pattern.
  Unbounded rule surface, brittle in both directions. Rejected.
- **Known-READER denylist** (`rg`/`grep`/`kubectl`/`ssh` exempt, everyone else caught).
  Fails CLOSED on every unknown binary — inverts the seal's declared fail-open posture and
  re-creates the false-conviction problem for any unlisted reader. Rejected on posture
  grounds, not just maintenance grounds.
- **Keep current behavior + document the FP.** The FP hits the readonly shape's core
  workload with a misleading remedy; documentation does not unblock the scout. Rejected.

### D4 — README disclosure duty (verbatim)

The `workspace-write` row's covers-text gains the writer-binary qualifier; the bypass
surface list gains "the short `-o` on a writer binary outside the known set flows".
Both derive from the exported tables (the row is generated from `WRITE_TARGET_FLAGS` +
`O_FLAG_WRITER_BINARIES` today's README renders by hand — the test suite cross-references
the exported tables so drift fails tests, same as the search-tools change's discipline).

### D5 — What deliberately does NOT move

- `pathLike` and `insideWorkspace` guards unchanged (still cheap string heuristics).
- Long-form flags stay binary-independent (D1 gates ONLY the short `-o`).
- Seal wiring, bounded findings, refusal text, draft-posture composition: untouched.
- `stripQuoted` semantics for other indicators: untouched (D2 adds a track; it does not
  modify the old one).

### D6 — Posture statement for the record

This change narrows coverage in one disclosed cell (`-o` × unknown-writer-binary) and
removes a false-conviction class that struck the readonly shape's primary workload. For a
belt-in-depth control whose documented bias is fail-open, trading an undisclosed false
positive for a disclosed false negative is the correct trade. No other indicator's
coverage changes.

## Risks / Mitigations

- **Writer-set maintenance** (new `-o`-writing tools appear): the set is one exported
  constant; the README table renders from it; adding a member is a one-line change with
  tests following automatically. Acceptable.
- **Head-resolution edge cases** (`&` operator, quoted exe paths, `cmd /c` wrappers):
  rules fixed in D1; tests cover `& "C:\path\gcc.exe" -o out.exe x` (catches) and a bare
  quoted-path head with `-o` on a non-writer (flows). `cmd /c gcc -o ...` hides the writer
  behind a wrapper — flows READ (fail-open, same class as Start-Process indirection,
  already disclosed).
- **Behavioral drift between docs/tests/code**: prevented by the table-iteration test
  invariant (D1/D4).
