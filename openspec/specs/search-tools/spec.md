# search-tools Specification

## Purpose
A forge-family search surface (`forge_grep`/`forge_glob`) that sees through workspace symlinks/junctions and dot-directories where the builtin pair is blind, is readonly by construction (no shell, no classifier, no ask-gate), and is the preferred search path for every forge worker.

## Requirements

### Requirement: Parity search interface with follow and hidden defaults

The plugin SHALL register two forge-family tools, `forge_grep` (content search) and `forge_glob` (file-pattern search), mirroring the builtin pair's interface: `pattern` (required), `path` (optional — defaults to the session worktree; a file path targets that file), and `include` (forge_grep file filter). Output SHALL align with the builtin pair's format (`Found N matches` with `path: Line n: content` blocks; forge_glob a plain path list), truncated at 100 results with a truncation notice. The tools SHALL diverge from the builtin pair by default: `follow` SHALL default to true (search through symlinks/junctions during traversal) and `hidden` SHALL default to true (dot-directories in scope), both exposed as explicit boolean params for opt-out. `**/.git/**` SHALL always be excluded.

#### Scenario: Content search traverses a workspace junction

- **WHEN** the workspace contains a junction linking to a folder whose files match the pattern, and `forge_grep` runs with default params from the worktree
- **THEN** matches under the link path are found alongside matches under the real path (subject to the dedupe requirement)

#### Scenario: Dot-directories are visible to forge_glob

- **WHEN** the workspace contains files under a dot-directory (e.g. `.tmp/`) and `forge_glob` lists the matching extension with default params
- **THEN** the dot-directory's files appear in the result list

#### Scenario: Opt-out params restore builtin behavior

- **WHEN** `follow: false` (or `hidden: false`) is passed explicitly
- **THEN** the tool does not traverse links (does not list dot-directory content) for that call — matching the corresponding builtin tool's scope

#### Scenario: Output parity with truncation

- **WHEN** a search yields more than 100 results
- **THEN** the first 100 are returned in the builtin-aligned format with a truncation notice advising a narrower path or pattern

### Requirement: Follow dedupe and outside-target disclosure

With follow enabled, a file reachable through multiple paths (its real path plus one or more link paths) SHALL be reported once per search, keeping the lexicographically first path, and the result SHALL end with a `+N duplicate paths merged` summary line when any dedupe occurred. A link whose target lies OUTSIDE the workspace SHALL be followed, and the result SHALL disclose the resolved outside target it searched through.

#### Scenario: A file behind a junction reports once

- **WHEN** a match lives in a file reachable both as `real/hello.txt` and as `link/hello.txt` (junction `link` → `real`)
- **THEN** the match reports once with the lexicographically first path kept, and the output ends with the duplicate-paths-merged line

#### Scenario: An outside-workspace link is followed and disclosed

- **WHEN** a workspace link points to a directory outside the workspace and `forge_grep` searches the worktree with defaults
- **THEN** matches under that link are returned and the output names the resolved outside target the link points at

### Requirement: Readonly-safe construction and family availability

The search tools SHALL invoke the ripgrep binary directly with a fixed argument vector derived from typed parameters — no shell, no command-string parsing — so no user-supplied pattern or path can alter execution via shell metacharacters. The tools SHALL NOT be subject to the readonly exec seal (the seal governs the `forge_shell` channel only), SHALL NOT appear in the mutating-tool deny family (available to explicit-readonly workers), and SHALL carry no permission ask-gate. Both tools SHALL be available to the primary forge agent and to every `forge-*` worker regardless of shape, and SHALL be hidden from every non-forge agent per the tool-partition capability.

#### Scenario: A readonly worker searches without friction

- **WHEN** a session runs an explicit `shape: "readonly"` forge worker and the worker calls `forge_grep`
- **THEN** the call executes and returns results — no seal classification applies and no exec-seal finding is recorded

#### Scenario: Typed params never form a shell command

- **WHEN** a search pattern or path containing shell metacharacters (`>`, `|`, quotes) is submitted
- **THEN** the value is passed to ripgrep as a single argument verbatim — it can neither redirect output nor break out of the argument vector

### Requirement: ripgrep resolution is fail-soft

The tools SHALL resolve the ripgrep binary in order: an explicit config override (`search.rgPath`) when it exists on disk, then `rg` on PATH. When neither resolves, a call SHALL return a fail-soft error naming both remedies (install ripgrep, or fall back to the builtin grep/glob for that search) — no bundled binary ships, no other session behavior changes.

#### Scenario: The config override wins when set

- **WHEN** `search.rgPath` points at an existing ripgrep binary
- **THEN** the search tools use that binary for every call

#### Scenario: A missing ripgrep degrades to guidance, not breakage

- **WHEN** no override is configured and no `rg` resolves on PATH
- **THEN** the tool call returns the fail-soft error naming the two remedies, and no crash, hang, or partial output results

### Requirement: Worker search preference mandate

The materialized worker discipline SHALL carry a standing preference line: search operations go through `forge_grep`/`forge_glob` first; the builtin `grep`/`glob` tools are fallback only. The builtin search tools SHALL remain visible to forge-family sessions — the preference is a discipline, not a tool hiding. The pre-existing discipline mandates SHALL remain present (this requirement adds to the standing prompt, it does not replace it).

#### Scenario: The composed worker prompt carries the preference

- **WHEN** a materialized `forge-*` agent's composed prompt is inspected
- **THEN** it contains the search-preference line alongside the pre-existing workspace-relative-path and verbatim-refusal mandates

#### Scenario: The builtin pair stays visible as fallback

- **WHEN** a forge worker session assembles its toolset
- **THEN** the builtin `grep` and `glob` tools remain available alongside `forge_grep`/`forge_glob`
