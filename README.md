# opencode-forge

Single general-purpose **forge** agent + two orthogonal harnesses for
[opencode](https://opencode.ai) ≥ 1.18: a **plan harness** (decide first,
execute later) and a **goal harness** (arm an objective, let the loop drive
itself to a host-verified finish). They share nothing but a safety interop;
OpenSpec spec workflows remain a third, separate lane.

```
/plan fix login timeout   → read-only recon → plan_write (draft, writes denied)
                           → present, end turn → USER REVIEW (revise / discard / go-ahead)
                           → plan_approve (user dialog = final gate) on explicit go-ahead
                           → execute task by task, plan_tick on each (timestamped audit)
                           → all ticked → per-criterion self-check → plan_close
                             (user dialog = completion gate) → done
/plan                     → list in-progress plans with progress
/plan resume              → continue the most recent unfinished plan
/plan discard             → abandon the current plan (abandoned, writes restored)
```

```
/goal make the suite green --check "npm test" --contains "src/a.ts::export const A"
                          → goal_write (arm=true; the user dialog IS the arm action)
                          → loop: work → goal_check (advisory) → idle → continuation brief
                          → goal_complete re-runs EVERY check itself on the host
                            (fail-closed) + per-criterion attestations → user dialog
                            = completion gate → completed
/goal add ...             → queue an inert goal (no dialog, no loop)
/goal                     → live goal + queue overview
/goal pause | resume | discard/stop/cancel
```

- Plan files: `.opencode/plan/<date>-<slug>.md` in your project, frontmatter
  state machine `draft → approved → done` (exit: `abandoned`).
- While a plan is in draft, `write` / `edit` / `bash` / `task` are **denied
  at the permission layer** — including your own `allow` config. The only
  exits are approval and discard. This is deliberate; see Design stance.
- `plan_approve` / `plan_close` are pinned to a confirmation dialog: the
  model can never flip the state itself.
- Goal files: `.opencode/goal/<date>-<slug>.md`, state machine
  `queued → active ⇄ paused → completed / abandoned`, one live goal per
  session plus a workspace queue. Completion is **verified by the plugin**,
  not attested by the model: `goal_complete` re-executes every check itself
  and refuses (fail-closed) on any failure.
- The native `build` / `plan` agents are hidden while the plugin is loaded
  (runtime injection, nothing written to your config). Uninstall restores
  them automatically; plan and goal files are never deleted.

## Install

Requires opencode ≥ 1.18.

```bash
# npm (recommended)
opencode plugin @sorenllm/opencode-forge --global
# or GitHub source
opencode plugin github:ChengZiiii/opencode-forge --global
```

Local development: add `"file:///<repo abs path>"` to the `plugin` array in
your opencode config. Single-file install: copy `dist/index.js` to
`~/.config/opencode/plugin/forge.js` — it is fully self-contained (the plan
discipline rides inside the /plan command template; there is no separate
skill file).

Note: do not enable opencode's experimental plan mode
(`OPENCODE_EXPERIMENTAL_PLAN_MODE`) together with forge — two plan mechanisms
would overlap.

## Configuration

Everything works with zero config. Optional knobs (your config, your files —
the plugin never writes them):

```jsonc
{
  "agent": {
    "forge": {
      "model": "provider/model",   // pick any model for forge
      "disable": true              // one-knob return to native: no forge,
                                   // build/plan restored, no tools/commands
    }
  },
  // per-plugin options ride the plugin entry as a [spec, options] tuple
  "plugin": [
    ["@sorenllm/opencode-forge", {
      "jobs": {
        "mode": "auto",              // "auto" (default) | "forge" | "native" — see the stage matrix below
        "keepBuiltinShell": false    // stage 0: keep the builtin shell visible alongside forge_shell
      },
      "watchdog": {
        "mode": "kill",              // "kill" (default) | "dry-run" | "off"
        "stallMs": 600000            // stall threshold, min 60000
      }
    }]
  ]
}
```

If you already have a `command.plan` or `command.goal` of your own, it wins
and the plugin's command of that name is not registered.

## Uninstall (four steps, restores native opencode)

1. Remove the plugin entry from the `plugin` array in
   `~/.config/opencode/opencode.json` (global installs).
2. Delete the package store dir:
   `~/.cache/opencode/packages/@sorenllm/opencode-forge/` (npm installs,
   scope-dir layout; for github installs it is
   `~/.cache/opencode/packages/github_ChengZiiii/opencode-forge/`).
3. Delete the `agent["forge"]` block from your config if you added one
   (otherwise the name lingers in the agent list).
4. Done — the hidden native `build`/`plan` agents come back automatically
   (the hide was runtime-only). Your `.opencode/plan/` and `.opencode/goal/`
   files are yours; delete them yourself if you want.
5. Optional runtime debris: delete `<tmp>/opencode-forge/` (job logs, the
   job registry ledger, the watchdog ledger, and the dispatch ledger — the
   file ledger table above lists everything).

## File ledger

What this plugin touches, exhaustively:

| Where | What | Lifetime |
| --- | --- | --- |
| `<project>/.opencode/plan/*.md` | plan files | user data — kept forever, uninstall never deletes |
| `<project>/.opencode/goal/*.md` | goal files (contract, Check Log, Turn Ledger) | user data — kept forever, uninstall never deletes |
| merged config object (RAM only) | forge agent, native build/plan `disable`, `command.plan`, `command.goal`, goal permission keys, `permission.forge_shell`, stage-0 builtin shell hide | vanishes when the plugin is removed; nothing is written to disk |
| `<tmp>/opencode-forge/jobs/<jobId>.log` | job output tee (full output; oldest rotated out above 50 files) | runtime debris — delete freely, also after uninstall |
| `<tmp>/opencode-forge/jobs/ledger.jsonl` | job registry ledger (bounded: 1 MB reset, 200 entries) | runtime debris — delete freely, also after uninstall |
| `<tmp>/opencode-forge/jobs/registry.json` | persistent survivor registry (bounded: 100 entries) | runtime debris — after uninstall, kill any still-running `survive` jobs yourself first |
| `<tmp>/opencode-forge/watchdog/log.jsonl` | watchdog interventions ledger (bounded: 200 entries, oldest rotated) | runtime debris — delete freely, also after uninstall |
| `<tmp>/opencode-forge/dispatch/ledger.jsonl` | dispatch ledger: resolved identity/depth, outcomes, tokens/cost, timeouts, transport interruptions, lost-on-exit, crew summaries (bounded, capped rotation) | runtime debris — delete freely, also after uninstall |
| `<project>/.opencode/forge.json`, `~/.config/opencode/forge.json` | your dispatch agent definitions (JSONC). **User data — the plugin only reads it, never writes or migrates it** | yours — version the project one, keep the global one out of sync tools if it holds machine-specific models |
| `~/.cache/opencode/packages/...` | installed package copy | written by the `opencode plugin` installer, not the plugin |
| `~/.config/opencode/opencode.json` | `plugin` array entry | written by the installer |

The plugin writes no temp files, no logs, nothing outside the table (a
`FORGE_GOAL_PROBE=1` env opt-in appends continuation diagnostics to the OS
temp dir for debugging).

## Goal mode (autonomous, host-verified objectives)

Three orthogonal workflows — pick per task, they never bind to each other:

| Workflow | decides | use when |
| --- | --- | --- |
| OpenSpec change | spec deltas, review gates | multi-session features with spec impact |
| `/plan` | approach + task order, you approve then it executes | single-task execution you want to review first |
| `/goal` | arm an objective + verification contract, the loop executes | well-defined objective with machine-checkable success |

`/goal <objective>` drafts a **contract**: goal, success criteria,
verification checks, constraints, non-goals, budgets. Contract markers in the
objective map to structured fields:

```
/goal make the release green --check "npm test" --check "npm run lint"
      --contains "CHANGELOG.md::## Unreleased"
      --success "zero failing tests" --constraint "no dependency bumps"
      --non-goal "refactoring" --max-turns 15 --max-minutes 30
```

Two check types, both **executed by the plugin on the host** (the model never
grades its own homework):

- `--check "cmd"` — shell command in the workspace; passes on exit 0,
  timeout-configurable (default 120 s, max 600 s).
- `--contains "file::text"` — file contract: the literal text must be present
  in that workspace file.

**Arming and the loop.** `goal_write` with `arm=true` pops one confirmation
dialog — your Allow IS the arm action; nothing autonomous runs before it.
From then on, whenever the session goes idle, the plugin re-prompts the agent
with a `[forge:goal-continue]` brief (with debounce, owner-checked, and
compaction-aware: autocontinue is suppressed for active-goal sessions so a
context compaction can never silently re-trigger the loop). Each continuation
turn is counted and recorded in the goal's Turn Ledger.

**Budgets and auto-pause.** `--max-turns` (default 25, hard ceiling 200) and
`--max-minutes` (default 60, hard ceiling 480). The loop pauses itself — with
a `stop_reason` in the frontmatter — on: budget exhaustion, two consecutive
no-progress continuation turns, three consecutive transport failures, or a
live draft plan appearing in the session (the only plan/goal interop: a draft
plan's write ban would wall the loop off, so the goal pauses instead of
burning turns against it). `/goal pause` (or `goal_pause` with a blocker
description) pauses by hand; `/goal resume` re-arms through another
confirmation dialog.

**Completion is fail-closed.** `goal_complete` re-executes every check itself
at the gate — results recorded in the Check Log never substitute for the
re-run — and requires one attestation per success criterion. Only then does
the user dialog appear. Revising the contract (`goal_write` with
`revise=true`) bumps the revision: earlier evidence no longer counts, but the
Check Log and Turn Ledger survive as an audit trail.

**Queueing.** One live goal per session; `/goal add ...` queues additional
goals (inert, no dialog). When the live goal reaches a terminal state,
`/goal resume` promotes the oldest queued goal into the now-free session.

**Run-mode limitation.** `opencode run` exits before the idle continuation
debounce fires, so the autonomous loop effectively requires a TUI/serve
session. Arming, checks, completion, pause/resume, and queueing all work in
run mode; `--auto` approves the gates, without it they auto-reject
(headless cannot silently pass a gate).

**Security boundary.** Verification shell commands run on your host, in the
workspace, via the plugin — that is the point (host-verified completion).
They are drafted by the model from your objective. Read them in the dialog
before allowing the arm; `--contains` contracts are strictly
workspace-relative (path escape is refused).

## Job supervisor (a shell that can never hang the session)

The builtin `shell` tool treats closed stdio pipes as completion — a
detached grandchild holding them open suspends the call indefinitely (the
multi-hour agent hangs behind upstream issues #47350 / #50316 / #49169).
Subagents have it worse: the native task tool has no timeout at all.
`forge_shell` is the replacement exec surface for the forge agent.

**`forge_shell`** completes on the FIRST of four conditions, and only the
exit condition is bound to the actual exit event (structural immunity to
the stdio-EOF bug):

| condition | knob | on trigger |
| --- | --- | --- |
| process exit | — | final; exit code + output tail returned |
| `success_pattern` regex matches new output | opt-in | completes as success; process kept alive by default (server semantics), `keep_alive: false` kills its tree |
| `idle_ms` with no new output | default 60000 | early return `still-running` + `jobId`; process stays alive |
| `max_wait_ms` hard cap | default 120000, max 600000 | early return `still-running`; never kills |

`run_in_background: true` skips all waiting and returns
`{jobId, logPath}` immediately. Every run pops one permission dialog
(`permission.forge_shell = "ask"`; an explicit `deny` in your config wins).
Every result form carries `cwd:` — the absolute directory the command
actually ran in. When the agent's narrative about the working directory
disagrees with that line, the line wins.

**`forge_jobs`** manages the registry: `list` / `poll {jobId, waitMs≤30s}`
(bounded wait for new output or exit, drains it) / `log {jobId, offset?,
limit?}` (line paging over the on-disk log) / `kill` (whole process tree) /
`clear` (drop a finished entry) / `handoff` (rebind ownership to the root
session so a subagent's job survives the subagent). Delegated agents are
instructed to poll their jobs before yielding a conclusion.

**Exit wakes.** A job that exits after its `forge_shell` call already
returned queues a single `[forge:job-complete]` message, delivered into the
owning session via `promptAsync` the next time it goes idle (exactly once;
`notify: false` opts out per job).

**Ownership.** Jobs belong to the session that created them. Session
deleted → its live session-scoped jobs are killed and the event is recorded
in a bounded ledger (`handoff` beforehand survives). Plugin unload disposes
everything it still owns.

### Host exit cleans up on every path (0.3.1)

Background jobs used to survive the opencode process as broken zombies (the
host's stdout pipe died with it, so per-request writers broke on the next
write). Jobs now die with the host on every exit path, layered:

1. **stdio is file-backed.** Job stdout/stderr ARE the log file (inherited
   fd) — the host holds no job pipes at all, so nothing can break, and a
   `survive` job (below) stays genuinely healthy after the host is gone.
2. **JS exit matrix.** `SIGINT` / `SIGTERM` / `process exit` /
   `uncaughtException` / `unhandledRejection` / plugin dispose all force-kill
   every live non-survive job (synchronous `taskkill /T /F` — fast enough to
   finish before the OS terminates the host; dispose gets a graceful pass
   with a 3s grace window first).
3. **OS fence (Windows).** One lazily-started PowerShell watcher holds a Job
   Object with `KILL_ON_JOB_CLOSE` around every spawned tree (periodic
   process-table sweep adopts late-born grandchildren). Host dies ANY way —
   including `taskkill /F`, where no JS handler can run — the watcher's stdin
   pipe dies with it, the handle closes, and the kernel kills the whole tree
   (~sub-second measured). POSIX has no kernel equivalent here (PDEATHSIG
   was rejected for its parent-thread pitfalls): process groups + the exit
   matrix carry it, and the next start's registry scan reports orphans.

Known boundaries: a host killed within ~1s of a job's start can leak that
job's grandchild (the fence watcher is still compiling); Chromium-family
processes that explicitly break away from the job object escape the fence
(deliberate: `BREAKAWAY_OK` is not set). Both are recorded in the ledger
when observable.

**Survive mode (explicit opt-out of death).** `forge_shell { survive: true }`
starts a job that OUTLIVES the host: it is recorded in
`<tmp>/opencode-forge/jobs/registry.json` (pid + command + log path), gets no
fence and no exit kill, and the NEXT opencode run adopts it automatically —
`forge_jobs list` shows it as `previous-run`, and poll/log/kill work on it
as usual. Config `jobs.survive: "always"` flips the per-call default; config
`jobs.survive: "deny"` disables survival entirely and a per-call
`survive: true` against it is an error (the explicit deny wins). Survivors
whose pid died are detected at next start, ledgered as orphans, and dropped
from the registry. Stop survivors explicitly — nothing else will.

### Stage matrix (future compatibility, by design)

OpenCode upstream is converging on native backgrounding (PRs #47231 /
#50276, umbrella #34366). The supervisor degrades ahead of it:

| stage | how you get there | builtin shell | forge_shell / forge_jobs |
| --- | --- | --- | --- |
| 0 — full forge path | default (`jobs.mode: "auto"`, no native support detected) | hidden on the plugin-created forge agent (runtime injection only) | registered; the exec surface |
| 1 — native backgrounding detected | automatic: `config.experimental` background flag, or the builtin shell's schema grows `run_in_background` | visible again | still registered as the additive layer (idle/success/wake supervision); its description now points plain backgrounding at the native parameter |
| 2 — native confirmed complete | manual only: `jobs.mode: "native"` (never auto-detected — completeness is a semantic judgement) | visible | retired; calls throw with a pointer to the native parameter |

Pin `jobs.mode: "forge"` to stay on stage 0 forever; `jobs.keepBuiltinShell:
true` keeps the builtin shell visible at any stage.

### Artifacts and uninstall additions

Job output lands in `<tmp>/opencode-forge/jobs/<jobId>.log` (the file IS the
job's stdout/stderr; oldest rotated out above 50 files; reads are windowed to
8 MB). Registry events append to
`<tmp>/opencode-forge/jobs/ledger.jsonl` (bounded, 1 MB reset, 200 entries),
and surviving jobs persist in `<tmp>/opencode-forge/jobs/registry.json`
(bounded to 100 entries; a stale `registry.json.lock` breaks itself after 5s).
These are runtime debris, not data — with ONE caveat: **if you uninstall with
`survive` jobs still running, killing them is on you** (`taskkill /PID <pid>
/F /T`, or just reboot); deleting the directory afterwards is safe and
complete.

## Worker dispatch (scoped subagents on a chosen model + depth)

`forge_dispatch {prompt, agent, depth}` spawns a child session that runs one
scoped task on the agent's pinned model at the requested reasoning depth. The
result is an honest report: the actual model/depth used, real token counts, a
self-computed cost (`null` when the model is unpriced), the
`depthTranslation` disclosure (`canonical high → native XHigh`, or
`verbatim`), and the worker's concluding report.

### forge.json — the dispatch configuration

Agents live in a dedicated `forge.json` (JSONC — comments allowed), resolved
by a three-level cascade with a single winning source (never merged):

1. `<project>/.opencode/forge.json` — project-level, versionable, team-shared
2. `~/.config/opencode/forge.json` — global
3. the built-in seed — `research {depths: [low, medium]}` and
   `review {depths: [medium, high, max]}`, both pinned to the placeholder
   `Local/GPT Luna` (an identity that never resolves: an unconfigured install
   fails every dispatch with the configuration recipe below)

```jsonc
{
  // forge dispatch agents — save the file; changes apply on the next dispatch, no restart
  "agents": {
    "research": {
      "model": "zai-coding-plan/glm-5.3", // exact "provider/model" string
      "depths": ["low", "medium"], // first entry is the default
      // "prompt": "optional role prompt riding inside the discipline wrapper",
      // "shape": "write", // default readonly denies mutating tools
      // "permission": { "bash": "deny" } // optional override; "task" is always denied
    }
  }
}
```

- **The plugin only ever reads this file.** It never creates, writes, or
  migrates it. Unconfigured? The first `forge_dispatch` error carries a
  machine-actionable recipe (detected identities, both file paths, the
  template, a verify dispatch) — or just ask your session AI to configure
  dispatch; `forge_dispatch_config` shows the exact live state.
- **Hot-apply**: the file is re-read (mtime-cached) before every dispatch and
  on every `forge_dispatch_config` call — edits take effect on the next
  dispatch, no host restart. One boundary: newly added agents materialize
  their hidden `forge-<agent>` entry only on the next config reload; the
  dispatch itself still works (the body names the agent), but a brand-new
  agent's first dispatch may need a host reload if the host validates agent
  names on session create.
- Each agent materializes as a hidden `mode: subagent` agent `forge-<agent>`
  carrying the role prompt (explicit `prompt` > built-in research/review
  defaults > generic worker) and a deny-style permission: `shape: "readonly"`
  (the default) denies `write`/`edit`/`bash`, `shape: "write"` allows them,
  an explicit `permission` map overrides the shape default — and `task` is
  ALWAYS denied (recursive dispatch stays physically impossible). Agents
  never carry a `model` field; the brain is bound per dispatch.

### The depth metalanguage

`depth` comes from the canonical five-word set `none | low | medium | high |
max`, or the model's **native level names verbatim** (escape hatch — e.g.
Qwen's `XHigh`). Translation to the provider's native parameter follows three
hard rules:

- **verbatim-first**: a meta word the model natively offers passes as-is
- **no interpolation**: a meta word with no counterpart errors listing both
  vocabularies — never a nearest guess
- **full disclosure**: the report always shows `canonical → native`

Per family: effort-style providers (OpenAI-compatible) receive
`reasoningEffort = <word>`; budget-style (Anthropic-style) receive a
published thinking tier — `low → 8192`, `medium → 16384`, `high → 24576`,
`max → 32768` budget tokens, `none → thinking off`; toggle-style (zai/GLM)
receive thinking on/off (that shape has no level slot — disclosed honestly).
A provider whose option shape the plugin does not know gets nothing injected,
disclosed as `not injected (unknown provider shape)`. The provider is the
final judge of every depth word: its raw errors flow back unedited.

### Legacy inline roster (advanced)

The pre-forge.json inline form still works when configured (the plugin
options `dispatch.roster` / `dispatch.tiers`): tier ids it defines keep their
exact-match resolution, one-retry-excluding-a-failed-identity semantics, and
startup dead-key warnings. Legacy tier ids win over forge.json agents of the
same name while inline options exist. Zero-config auto-generation of roster
entries was removed (configured ≠ usable) — dispatch without configuration is
the seed + recipe path above.

### Background dispatch and wake briefs

`forge_dispatch` takes `background: true`: it returns
`{dispatchId, agent, requested, resolved, depth, queuedAt}` immediately and
the full result arrives later as a coalesced `[forge:dispatch-complete]`
brief — debounced, never interrupting an active turn (delivery waits for an
idle), each terminal delivered exactly once, and merged into a single
combined re-prompt when a goal continuation fires on the same idle.
`forge_dispatch_list` recovers in-flight and recent terminal state (with
dispatchIds) after context compaction; `forge_dispatch_kill {dispatchId}`
stops polling, suppresses the brief, and ledgers `killed`. On host exit,
in-flight dispatches are ledgered `lost-on-exit` — sessions are host memory
objects, there are no orphan processes and no survive semantics.

**Transport-interruption recovery**: the child's prompt is delivered by a
turn-synchronous HTTP POST that stays open for the whole first turn. If that
POST dies at the transport layer (fetch abort / network failure — anything
that is not an HTTP error response), the dispatch does **not** fail: the
engine ledgers `transport-interrupted` (with the child sessionID) and falls
back to completion polling under the same deadline — the child session is a
host-side object and usually keeps running, so its result is still collected
and delivered normally. The message is never re-POSTed (the prompt may
already be delivering); a message that never arrived polls as waiting and
ends in the honest deadline `timeout`. Terminal reports and terminal ledger
rows carry the child sessionID, dispatchId, parentSessionID, and durationMs.

### Crew workflow (`/crew`)

`/crew <objective>` registers a crew: decompose the objective into
evidence-checked subtasks, dispatch them as background waves paced on
completion briefs (**never past the concurrency cap — launch the next batch
only as briefs free capacity**), at most ONE retry per failed subtask, then
`crew_close` with the full report. The close is a hard gate: every subtask
needs a PASS/FAIL verdict with evidence, a FAIL needs both failure reports,
and the report is cross-checked against the dispatch ledger — a dispatched
subtask missing from the report refuses the close (refusals never bother you
with a dialog). A valid close asks once, appends a crew summary to the
ledger, and ends the crew. Crew state is in-memory by design: a host restart
ends it honestly and the ledger keeps the history.

### Known pitfalls

- **Keyless endpoints × readonly agents**: free/keyless providers can return
  a deterministic EMPTY response for any toolset-reduced (readonly) agent —
  0 tokens, no parts. The plugin detects this and fails the dispatch honestly
  (`empty-response`, never counted as success); use a `shape: "write"` agent
  or a keyed provider for readonly work on such endpoints.
- **`opencode run` and background**: a finished run-mode session cannot be
  re-prompted, so completion briefs have nowhere to land — completions are
  ledger-only (read them via `forge_dispatch_list`). Background mode targets
  live TUI sessions; prefer sync under `opencode run`.
- **Host tool ceiling (~262s observed on 1.18.32)**: the host may kill a
  sync tool call that exceeds roughly 262 seconds even though the plugin's
  own deadline is higher. A same-family transport abort (~281s observed,
  2026-09-27 incident) can also kill the background dispatch's turn POST.
  Transport-interruption recovery (above) absorbs both: the dispatch falls
  back to polling and still delivers the child's result; keep `timeoutMs`
  modest anyway for sync-heavy workflows.
- **Child permission asks**: a worker that hits a permission ask surfaces the
  ask on the CHILD's session in the TUI. An unanswered ask stalls the child
  until the dispatch deadline — scope worker prompts to avoid permission
  boundaries (readonly tiers and workspace-relative paths help).

## Hang watchdog (a stuck builtin shell unblocks itself)

`forge_shell` is structurally immune to the stdio-EOF hang, but the builtin
`shell`/`bash` tool can still hang outside it — user-defined agents keep
the builtin shell, and the stage matrix above restores it at stage 1/2.
The watchdog is the independent backstop for those paths, in **every**
session (primary and delegated subagents alike):

1. The host's shell environment hook stamps each builtin shell call's
   process with a plugin-namespaced marker (`FORGE_WATCHDOG_MARK`), and the
   call is timed from start to end.
2. At 80% of the stall budget: a diagnostic entry (the session is busy —
   injecting a message would just queue, so nothing is sent to it).
3. At `watchdog.stallMs` (default 600000): the call's process tree is
   located and **killed** — the pipes hit EOF and the pending tool call
   resolves immediately with whatever output was captured.
4. If the call still hasn't returned after the kill, or no matching
   process exists (a hang with nothing to kill): an honest
   diagnostics-only `unresolved` report.

Location is exact where foreign process environments are readable (POSIX
`/proc/*/environ` marker match). On Windows they are not readable, so the
watchdog infers in two guarded waves, both restricted to processes created
during the stalled call: wave 1 matches descendants of the opencode host
process or processes whose command line carries the stalled call's own
command text; wave 2 — only when wave 1 found nothing, or killed and the
call still didn't return within the observation window — additionally
matches processes whose command lives in the stalled command's own
directory, which is exactly where the detached stdio holders of the
exit-with-inherited-stdio hang class sit. The locator never targets its
own probe processes, console hosts (`conhost.exe`), or anything created
before the call's time window. If the shell environment hook itself ever
stops firing (host API drift), the watchdog detects the missing marker and
degrades itself to dry-run instead of killing by inference alone.

**Modes** (`watchdog.mode`, default `kill`): `dry-run` records the exact
process list it *would* terminate and kills nothing — recommended for a
first observation round on a new host; `off` disables timing entirely.
`watchdog.stallMs` is clamped to a 60 s protection floor. Invalid option
values fall back to the defaults and the fallback is ledgered.

**Known trade-off.** The builtin shell exposes no output visibility, so
the watchdog cannot tell "hung" from "quietly working" — a legitimate
silent command longer than the threshold will be killed. That is the
deliberated price of stopping multi-hour hangs; the guidance layer already
routes legitimate long-running work to `forge_shell`, which has real idle
detection. On Windows, concurrent builtin shell calls started inside the
same window are inferred together (the rare case) — `dry-run` makes the
exact blast radius auditable before you trust `kill`.

**Retiring it.** When upstream ships exit-based completion for the builtin
shell, switch `watchdog.mode` to `dry-run` for an observation round, then
`off`.

### Watchdog ledger

Every intervention (warn / kill / dry-run candidate / unresolved /
config fallback) appends to `<tmp>/opencode-forge/watchdog/log.jsonl`
(bounded: 200 entries, oldest rotated out). Deleting the directory after
uninstall is safe and complete.

## Design stance (read before filing "bash is blocked" issues)

During a plan's draft phase every mutating tool — `bash` included — is
denied, and an `allow` in your config does not override it. Reconnaissance is
read/grep/glob; if you genuinely need a shell command to decide the plan,
approve the plan first (revising after approval is allowed via a new `/plan`).
The escape hatches are `plan_approve` and `/plan discard`, by design.

Separately, at stage 0 the builtin shell is hidden on the plugin-created
forge agent on purpose — `forge_shell` is the exec surface there (see the
job supervisor chapter above). A **user-defined** `agent.forge` entry,
`jobs.keepBuiltinShell: true`, or any stage ≥ 1 keeps the builtin shell
visible.

A process restart forgets the session binding: the write-ban soft-disables
(safety over strictness) and the next session's system notice + `/plan
resume` re-bind from the plan file on disk, which is the source of truth.

## Development

```bash
npm install
bun run typecheck     # tsc --noEmit
node --test tests/*.test.mjs
bun run bundle        # rebuild self-contained dist/index.js (committed)
```

Architecture: `plugin.ts` (dual entry — v1 `server` full-featured + v2
`setup` defensive forward-compat; the /plan and /goal command templates each
carry their own full discipline, hermes-style: the entry turn is the
rulebook) + `src/plan-file.ts` / `src/goal-file.ts`
(pure document cores, unit-tested, no opencode imports) + `src/run-check.ts`
(shell/file-contract runner with tree-kill timeouts and a workspace path
guard) + `src/proc.ts` (shared spawn/tree-kill muscle) + `src/job-manager.ts`
(job registry, ownership, wake queue — pure logic) + `src/job-runner.ts`
(four-condition race, pipe capture, log tee). Behavioral changes go through the
OpenSpec workflow in `openspec/` — see AGENTS.md. Common pitfalls live in
`../opencode-plugin-dev-pitfalls.md`.

## License

MIT
