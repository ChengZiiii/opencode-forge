# E2E — forge-shell-mandate (0.8.0, npm mode, 2026-09-28)

Environment: real `opencode serve` (port 43122), workspace
`C:\Users\Soren\AppData\Local\Temp\opencode\shell-mandate-e2e\ws`, global
config npm plugin mode → cached `@sorenllm/opencode-forge@0.8.0`
(dist verified: the hard-refusal mandate string is present). Driver:
`scripts/shell-mandate-e2e.mjs` (SSE consumer: tool parts + text parts +
permission auto-approve). Model: `opencode/ling-3.0-flash-fin-free`.

## Task

Three trivial commands, one tool call each, report every output:

```
node -e "console.log(11*11)" | node -e "console.log('second-cmd')" | node -e "console.log('third-cmd')"
```

## Observed

- Tool sequence: `forge_shell` ×3 executions (9 SSE part events =
  pending/running/completed ×3) — the FIRST tool the model reached for was
  `forge_shell`, no builtin probe beforehand.
- Builtin `shell`/`bash` tool calls: **0**.
- `[forge:partition]` refusal lines in the transcript: **0**.
- All three outputs (`121`, `second-cmd`, `third-cmd`) reached the model
  and are quoted in its final report.

## Verdict

PASS — under the default partition the model routes every command straight
through `forge_shell`; the mandate removed the try-bash-first round-trip
that motivated the change. Note this session also exercises
job-terminal-evidence incidentally: three quick foreground commands, no
completion wakes, no registry litter.

## keepBuiltinShell leg — carried by unit coverage

The escape-hatch leg is pinned deterministically by
`tests/job-wiring.test.mjs` ("4.2 config: keepBuiltinShell … retains the
builtin shell" + "forge-shell-mandate: prompt and guidance compose per
config gate" asserting the preference wording and the absence of the
refusal claim). A behavioral model test would require the model to
deliberately choose the builtin tool — not deterministic enough to assert;
the config shape and the softened text are the testable substance.

## Ops note

Publish → tarball CDN lag ~4.5 min this round (install try 9 of a 30 s
retry loop). Double-publish guard (409 "Cannot publish over previously
staged version 0.8.0") again proved the earliest truth signal.
