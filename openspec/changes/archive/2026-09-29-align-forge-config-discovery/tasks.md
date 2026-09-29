# Tasks — align-forge-config-discovery

## 1. Loader core (src/forge-config.ts)

- [x] 1.1 Add upward discovery: candidate chain from the anchor to the filesystem root (`dirname` terminates at `/` and drive roots); first existing `.opencode/forge.json` is the project layer; empty anchor skips the project layer
- [x] 1.2 Two-layer merge in `load()`: global base + project override per agent id (wholesale definitions, no field blending); `source` gains `project+global`; add `projectPath`; findings concatenate
- [x] 1.3 Per-layer fail-soft: a parse-broken document empties its own layer with its error finding while the other layer still applies; unconfigured state stays inert and silent
- [x] 1.4 Keep hot-apply: mtime/size cache per path; discovery re-runs per load so new/removed project files apply without restart

## 2. Wiring (plugin.ts)

- [x] 2.1 Unified `sessionAnchor(context)` chain (session worktree → session directory → host launch directory); rewire `worktreeFor` (plan_*/goal_* tools) onto it — degenerate-worktree sessions in other directories anchor correctly
- [x] 2.2 crew_begin: session-anchored discovery (bounded per-anchor loader cache, ≤8) for guidance paths + workspace-mismatch disclosure; gate refusal still keyed on the host-materialized set; empty-host + usable workspace file → mismatch-explaining refusal
- [x] 2.3 Update the unconfigured-refusal message and `CREW_INIT_TEMPLATE`: two layers, "merged — project overrides global per agent", walk-up wording; keep the consent rule and restart/hot-apply timing lines
- [x] 2.4 Config-hook loader creation and v2 setup unchanged in signature (walk-up + merge inherited); chat.params depth lookup stays host-anchored (depth must match the materialized model)
- [x] 2.5 Prompt disclosure in the configuration guidance (follow-up): CREW_INIT_TEMPLATE template example + prose and the crew_begin refusal disclose the optional per-agent `prompt`; AI-assisted configuration mandates a SHORT prompt per agent from the requested role (one or two sentences; long only on explicit request)
- [x] 2.6 Reserved-prefix self-heal (follow-up 2): the loader strips a `forge-` id prefix (all repetitions) with a warn finding; empty-after-strip is invalid; post-normalization collision skips the later entry with an error finding; the guidance states the plain-role-word naming rule in the template, the AI-assist mandate, and the refusal

## 3. Tests

- [x] 3.1 forge-config: merge (union + per-id override), walk-up (nearest wins, above-root stop), per-layer broken-doc fail-soft, `project+global` source, `projectPath`, inert unconfigured, hot-apply including file create/remove on the chain
- [x] 3.2 forge-subagents-wiring: /crew template + gate message wording (merged, two layers); crew_begin mismatch disclosure when the session anchor discovers a project layer the host did not materialize; empty-host + workspace-file refusal names the file and the relaunch guidance
- [x] 3.3 goal-mode / plan anchoring: a degenerate-worktree tool context with a distinct `directory` anchors plan/goal state under the session directory (not the launch dir)
- [x] 3.4 Prompt-disclosure assertions: the /crew init template and the crew_begin refusal both show the `prompt` field and the short-prompt mandate
- [x] 3.5 Reserved-prefix tests: normalization (single + repeated prefix, warn finding, materialized single-prefix agent name), collision after normalization (later entry skipped with an error), guidance naming-rule assertions in the init template and refusal
- [x] 3.6 Full suite green (`node --test tests/*.test.mjs`) + `bun run typecheck` clean

## 4. Docs & release

- [x] 4.1 README configuration section + AGENTS.md forge-config.ts row reflect merge + walk-up
- [ ] 4.2 `bun run bundle` (dist rebuilt, self-contained), version 0.11.0, `npm pack --dry-run` whitelist check, commit, npm publish, git push, switch the local global install to the fresh npm version and verify live
