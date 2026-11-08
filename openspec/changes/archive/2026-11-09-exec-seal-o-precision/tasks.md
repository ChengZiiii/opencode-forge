# Tasks — exec-seal-o-precision

- [x] 1. Classifier precision core (`src/exec-classify.ts`)
  - [x] 1.1 Add the exported writer-binary table `O_FLAG_WRITER_BINARIES` (gcc, g++, cc, c++, clang, clang++, ld, rustc, go, curl, sort, psql, dotnet) beside the other indicator tables
  - [x] 1.2 Add the quote-aware tokenizer `tokenizeCommand` (same quote rules as `stripQuoted`; emits `{text, quoted}` tokens); `stripQuoted` and the four indicator scans keep their current behavior untouched
  - [x] 1.3 Gate the short `-o` in `workspaceWriteMatch` on the resolved head binary (skip a leading `&`; quoted head uses its content; basename → lowercase → strip trailing `.exe`) being in the writer set; long-form flags stay binary-independent; flag-value binding switches to the quote-aware token list (adjacent token, quoted ones eligible)
  - [x] 1.4 Unit matrix in `tests/exec-classify.test.mjs`: both reproduced false positives (`rg -o "v1\.2\.3" package.json`, `rg -o needle.v2 src/`) → READ; `rg -o TODO src/` stays READ; `gcc -o out.exe main.c` / `curl -o out.txt <url>` / `go build -o bin/app ./cmd` → WRITE with the bound target in detail; `curl -o "out.txt" <url>` (quoted) → WRITE; `kubectl get pods -o yaml` → READ; `& "C:\path\gcc.exe" -o out.exe x` → WRITE; a quoted non-writer head with `-o` → READ; the suite iterates the exported tables (no-drift invariant extended to the new table)

- [x] 2. README verbatim disclosure
  - [x] 2.1 `workspace-write` row: covers-text gains the writer-binary qualifier for the short `-o` (rendered from the exported tables)
  - [x] 2.2 Bypass surface list gains: the short `-o` on a writer binary outside the known set flows (fail-open, disclosed)

- [x] 3. Verification gates (all four, in order)
  - [x] 3.1 `bun run typecheck` — clean
  - [x] 3.2 `node --test tests/*.test.mjs` — full suite green (442 baseline + new cases)
  - [x] 3.3 `bun run bundle` — dist rebuilt, self-contained, committed
  - [x] 3.4 `npm pack --dry-run` — whitelist still exactly dist + README.md + package.json
