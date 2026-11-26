# search-tools Specification

## Purpose
Same-name enhancements to builtin `grep` and `glob` for all agents under original parameter, output, environment and authorization contracts: default-follow traversal, default-hidden glob scope with opt-out, deduplication and authorized outside-target disclosure. Search uses ripgrep or bundled JS without a shell; unloading restores builtin definitions. No plugin search aliases are registered.

## Requirements

### Requirement: Follow dedupe and outside-target disclosure

With follow enabled, a file reachable through multiple paths (its real path plus one or more link paths) SHALL be reported once per search, keeping the lexicographically first path, and the result SHALL end with a `+N duplicate paths merged` summary line when any dedupe occurred. A link whose actual target lies OUTSIDE the workspace SHALL be followed only after equivalent host external-directory authorization for that target, before either engine reads its contents. Denied or unverifiable authorization means do not follow it; if equivalent checks cannot be enforced, retain the builtin unchanged. Disclose authorized outside targets searched and skipped unauthorized targets without reading their content.

#### Scenario: A file behind a junction reports once

- **WHEN** a match lives in a file reachable both as `real/hello.txt` and as `link/hello.txt` (junction `link` → `real`)
- **THEN** the match reports once with the lexicographically first path kept, and the output ends with the duplicate-paths-merged line

#### Scenario: An outside-workspace link is followed and disclosed

- **WHEN** a workspace link points to a directory outside the workspace and `grep` searches the worktree with defaults after host authorization of the actual outside target
- **THEN** matches under that link are returned and the output names the resolved outside target the link points at

#### Scenario: Outside link authorization precedes reads on both engines

- **WHEN** each engine encounters a workspace link resolving outside the workspace and the host allows, denies or cannot establish authorization on its actual target
- **THEN** allowed target results are returned only after authorization; denied or unverifiable targets are not read or traversed, and no unauthorized contents are returned; if equivalent checks cannot be enforced the builtin remains intact

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

### Requirement: Explicit path anchors pattern and output

When a call's `path` argument resolves to a DIRECTORY, the serving engine (whichever leg of the chain) SHALL match slash-bearing glob patterns and `include` filters against paths relative to that directory, and SHALL report result paths relative to that same directory — the two legs of the engine chain SHALL return identical path sets for identical explicit-path anchored queries. A `path` resolving to a FILE and the default (no-`path`) worktree root SHALL keep their existing shapes unchanged. The follow-dedupe pass's realpath resolution SHALL key to the call's effective root (the explicit directory when given, else the worktree); outside-workspace disclosure SHALL continue to compare resolved targets against the worktree.

#### Scenario: An anchored glob with an explicit directory path finds one-level files

- **WHEN** `glob` is called with pattern `*/tasks.md` and a `path` pointing at a directory containing `<change>/tasks.md` one level down
- **THEN** the change's `tasks.md` is listed as `<change>/tasks.md` (or with the platform separator) — relative to the given directory — on BOTH the ripgrep leg and the bundled JS engine leg

#### Scenario: Cross-engine agreement on the same explicit-path query

- **WHEN** the same anchored pattern and explicit directory path are served first by ripgrep (resolvable) and then by the bundled JS engine (ripgrep unresolvable)
- **THEN** the two results' path sets are identical, differing only by the engine-disclosure footnote

#### Scenario: The default root and file roots are unchanged

- **WHEN** no `path` is given, or `path` resolves to a single file
- **THEN** output pathing matches the pre-change behavior (worktree-relative for the default root; the given file root for a file)

### Requirement: Same-name search override with follow and hidden defaults

The plugin SHALL register no search tool under a name of its own (`forge_grep` and `forge_glob` SHALL NOT exist). Its search capability SHALL ride the host's builtin `grep` and `glob` tools under their own names: through the tool editor the plugin SHALL update each builtin definition — the builtin's definition is the base, its name and namespace are preserved — so that the one effective tool named `grep` (and `glob`) carries the capability for every agent. The update SHALL add a `follow` parameter to both tools (default `true`: search through symlinks and junctions during traversal; `false` restores the builtin's scope) and SHALL turn `glob`'s `hidden` default to `true` (dot-directories in scope; `grep` already searches them); every builtin parameter SHALL be kept with its actual semantics, including grep literal vs regex, caseSensitive, include, path and caller-provided limit (not a fixed 100 in place of the requested limit); glob path, hidden and limit likewise. The result the model reads SHALL keep the builtin's text format (`Found N matches` with `path: Line n: content` blocks, `No matches found`, the truncation notice; `glob` a plain path list or `No files found`), and `**/.git/**` SHALL stay excluded.

The override SHALL preserve the builtin access constraints and permission check semantics before it searches, including environment availability, external-directory authorization, and the original action/resource/context — the checks the builtin tools run, through the host's permission assert: the search action (`grep` / `glob`) with the pattern as its resource, and, for an explicit `path` or resolved link target outside the workspace, the external-directory authorization before any target content or directory is read. A user's permission rule on `grep` or `glob` SHALL therefore be decided by the host's permission evaluation on the same action and resource as against the builtin tools, and nothing SHALL be searched before that decision. The override SHALL keep the tool's declared result contract consistent: the builtin output schema SHALL remain compatible and satisfied. If equivalent availability or authorization cannot be established through the plugin interface, the override SHALL NOT install until the design is revised; likewise if a builtin tool is absent, or the host rejects the update as invalid, the builtin definition SHALL stand unchanged and the plugin SHALL disclose it; the plugin SHALL NOT register a search tool under another name as a fallback. When the plugin's registration is disposed, the builtin pair SHALL stand revealed exactly as it was.

#### Scenario: The builtin names carry the override

- **WHEN** the plugin loads on a host for which equivalent access constraints and result compatibility have been established and the host's tool registry is inspected
- **THEN** `grep` and `glob` are each registered once, carry `follow` (and `glob` a default-true `hidden`), and no `forge_grep` or `forge_glob` exists

#### Scenario: Equivalent host access constraints cannot be established

- **WHEN** the public plugin interface cannot establish equivalent environment availability, external-directory authorization or result compatibility
- **THEN** the plugin leaves both native tool definitions intact, discloses that the enhancements are not installed, and registers no alternate search names; enhancement-specific scenarios remain unverified

#### Scenario: Content search traverses a workspace junction

- **WHEN** the workspace contains a junction linking to a folder whose files match the pattern, and `grep` runs with default params from the worktree
- **THEN** matches under the link path are found alongside matches under the real path (subject to the dedupe requirement)

#### Scenario: Dot-directories are visible to glob

- **WHEN** the workspace contains files under a dot-directory (e.g. `.tmp/`) and `glob` lists the matching extension with default params
- **THEN** the dot-directory's files appear in the result list

#### Scenario: Opt-out params restore builtin behavior

- **WHEN** `follow: false` (or `hidden: false` on `glob`) is passed explicitly
- **THEN** the tool does not traverse links (does not list dot-directory content) for that call — matching the corresponding builtin tool's scope

#### Scenario: Output parity with truncation

- **WHEN** a search yields more than 100 results
- **THEN** with the builtin default limit, the first 100 are returned in the builtin's text format with a truncation notice advising a narrower path or pattern

#### Scenario: Both search engines preserve actual builtin argument semantics

- **WHEN** the same fixture is searched with literal and regex patterns, caseSensitive true and false, include/path filters, explicit limits below and above the default, and glob hidden selections, on each engine
- **THEN** both return the corresponding builtin match sets, counts and truncation semantics except the expressly changed follow and hidden defaults; permission decisions and environment availability remain equivalent to the builtin

#### Scenario: A user's grep permission rule still holds

- **WHEN** the user's config denies or asks for `grep` (or a pattern of it), and the overridden `grep` is called
- **THEN** the host's permission evaluation decides the call on the same action and resource as it would for the builtin tool, and the override searches nothing before that decision

#### Scenario: A path outside the workspace is authorized first

- **WHEN** the overridden `glob` is called with a `path` outside the workspace
- **THEN** the external-directory authorization runs before anything is read, and a declined authorization returns no results

#### Scenario: An invalid update leaves the builtin intact

- **WHEN** the host rejects the plugin's update of `grep` as invalid
- **THEN** the builtin `grep` definition stands unchanged, the plugin discloses that its search capability is not installed, and no tool under another name appears

#### Scenario: Unloading the plugin restores the builtin pair

- **WHEN** the plugin's registration is disposed
- **THEN** `grep` and `glob` behave exactly as the host's own tools — no `follow` parameter, `glob`'s `hidden` default back to false

### Requirement: Readonly-safe construction and host-wide availability

The overridden `grep` and `glob` SHALL execute through a fixed engine derived from typed parameters — the ripgrep binary invoked directly with a fixed argument vector when one resolves, otherwise the plugin's bundled pure-JS walk engine — and no shell or command-string parsing SHALL exist in either path, so no user-supplied pattern or path can alter execution via shell metacharacters. The override SHALL carry no permission ask-gate of its own beyond the host checks it runs (the readonly exec seal is retired with the exec surface it guarded). Both tools SHALL be available to every agent — the forge primary, every `forge-*` worker regardless of shape, and every non-forge agent — with no plugin-side hiding, because they are the host's own tools; an agent's own permission face decides whether it has them, as for any builtin tool.

#### Scenario: A readonly worker searches without friction

- **WHEN** a session runs an explicit `shape: "readonly"` `forge-*` worker and the worker calls `grep`
- **THEN** the call executes and returns results — no seal classification exists and no plugin refusal fires

#### Scenario: Typed params never form a shell command

- **WHEN** a search pattern or path containing shell metacharacters (`>`, `|`, quotes) is submitted
- **THEN** the value reaches the serving engine (ripgrep argument vector or the JS engine's typed matcher) verbatim as data — it can neither redirect output nor break out into execution

#### Scenario: The JS engine traverses a workspace junction

- **WHEN** no ripgrep resolves, the workspace contains a junction linking to a directory outside the workspace, and `glob` lists a pattern matching files under that junction with prior host authorization of its actual outside target
- **THEN** the junction's files appear in the result list under the junction-relative path, the output discloses the resolved outside target, and the engine-disclosure footnote is present

#### Scenario: A non-forge agent gets the same search tools

- **WHEN** the native build agent calls `grep` in a workspace with a junction
- **THEN** the call is served by the override with the same follow behavior, with no plugin-pushed deny and no partition refusal
