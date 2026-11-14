# search-tools Delta

## MODIFIED Requirements

### Requirement: Readonly-safe construction and family availability

The search tools SHALL execute through a fixed engine derived from typed parameters — the ripgrep binary invoked directly with a fixed argument vector when one resolves, otherwise the plugin's bundled pure-JS walk engine — and no shell or command-string parsing SHALL exist in either path, so no user-supplied pattern or path can alter execution via shell metacharacters. The tools SHALL NOT be subject to the readonly exec seal (the seal governs the `forge_shell` channel only), SHALL NOT appear in the mutating-tool deny family (available to explicit-readonly workers), and SHALL carry no permission ask-gate. Both tools SHALL be available to the primary forge agent and to every `forge-*` worker regardless of shape, and SHALL be hidden from every non-forge agent per the tool-partition capability.

#### Scenario: A readonly worker searches without friction

- **WHEN** a session runs an explicit `shape: "readonly"` forge worker and the worker calls `forge_grep`
- **THEN** the call executes and returns results — no seal classification applies and no exec-seal finding is recorded

#### Scenario: Typed params never form a shell command

- **WHEN** a search pattern or path containing shell metacharacters (`>`, `|`, quotes) is submitted
- **THEN** the value reaches the serving engine (ripgrep argument vector or the JS engine's typed matcher) verbatim as data — it can neither redirect output nor break out into execution

#### Scenario: The JS engine traverses a workspace junction

- **WHEN** no ripgrep resolves, the workspace contains a junction linking to a directory outside the workspace, and `forge_glob` lists a pattern matching files under that junction
- **THEN** the junction's files appear in the result list under the junction-relative path, the output discloses the resolved outside target, and the engine-disclosure footnote is present

## REMOVED Requirements

### Requirement: ripgrep resolution is fail-soft

The tools SHALL resolve the ripgrep binary in order: an explicit config override (`search.rgPath`) when it exists on disk, then `rg` on PATH. When neither resolves, a call SHALL return a fail-soft error naming both remedies (install ripgrep, or fall back to the builtin grep/glob for that search) — no bundled binary ships, no other session behavior changes.

**Reason for removal**: the fail-soft error makes the pair's availability depend on a machine-level ripgrep install, and the remedy text redirects callers to the builtin pair — which is structurally blind to junctions, the very blind spot this pair exists to fix (field-confirmed 2026-11-09: rg-less machine, junction target found only by hand-written recursive PowerShell). Superseded by the engine-chain requirement below.

## ADDED Requirements

### Requirement: Engine chain — ripgrep preferred, bundled JS engine fallback

The search tools SHALL resolve the serving engine in order: an explicit config override (`search.rgPath`) when it exists on disk, then `rg` on PATH, then the plugin's bundled pure-JS engine. A call SHALL NEVER fail or degrade to guidance because no ripgrep resolved: the JS engine serves it and the output SHALL end with an engine-disclosure footnote naming the faster engine's remedies (`install ripgrep` / `search.rgPath`). A configured override that fails to spawn SHALL fall through to the JS engine with the same footnote. No binary ships; no install step exists; no other session behavior changes.

#### Scenario: The config override wins when set

- **WHEN** `search.rgPath` points at an existing ripgrep binary
- **THEN** the search tools use that binary for every call and no engine footnote appears

#### Scenario: A missing ripgrep serves through the JS engine

- **WHEN** no override is configured and no `rg` resolves on PATH
- **THEN** the call returns live results from the bundled JS engine, the output ends with the engine-disclosure footnote, and no crash, hang, or partial output results

#### Scenario: A broken override falls through

- **WHEN** `search.rgPath` points at a path that exists but fails to spawn (or spawns and errors)
- **THEN** the call is served by the JS engine with the engine-disclosure footnote rather than failing

#### Scenario: JS-engine bounds are disclosed, not silent

- **WHEN** the JS engine's walk exceeds its entry cap or skips files over its per-file size cap
- **THEN** the output carries a truncation-style notice naming the cap hit, advising a narrower path or pattern
