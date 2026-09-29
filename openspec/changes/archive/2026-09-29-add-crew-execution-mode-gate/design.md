# Design: add-crew-execution-mode-gate

## Context

Current `/crew` discipline (crew-harness spec): decompose → `crew_begin {objective, subtasks}` → immediately "proceed with waves of parallel native task calls". Interlocks today: plan-draft refuses /crew; one crew per session; ask-gated crew_close. Nothing between registration and wave 1. The user's pipeline (macro plan → crew prep → **mode choice** → execution) has no encoded pause, and the goal path is unreachable because the model has already started executing in-turn.

Community survey grounding:
- **spec-kit / OpenSpec / Kiro / BMAD**: next phase = next human-invoked command (absence of trigger is the strongest gate).
- **LangGraph**: `interrupt_before` node interrupts — mechanical pause on state transition, resumable.
- **AutoGen**: termination predicates — "loop until acceptance" encoded as code.
- **BMAD v4**: story re-sharding — the loop may rewrite the decomposition artifact.

## Goals and Non-Goals

**Goals:**
1. A user decision point between crew registration and execution, enforced mechanically (belt), not just by template.
2. Three exits at the pause: waves now / convert to goal / standby.
3. A cheap re-shard exit (abandon) for wrong decompositions, including inside goal loops.
4. Crew/goal stay decoupled from plan (macro-contract source agnostic).

**Non-Goals:** plan/goal spec changes; new tools; cross-session persistence; changing goal-loop briefs; gating native (non-forge) task vocabulary beyond the pending belt.

## Decisions

### D0 — Decoupling red line (user-mandated)

Crew and goal never require a plan artifact. The macro contract may arrive as an approved plan, an OpenSpec change document, or inline `/crew` objective text; the discipline is identical. The existing draft-refusal is mutual-exclusion safety interop (a draft's write ban cannot coexist with crew execution), not an ordering dependency — the spec wording keeps it under that framing. Rationale: the user also runs the OpenSpec workflow; hardwiring plan as crew's upstream would couple two of three macro-contract sources arbitrarily.

### D1 — Two-phase lifecycle

`crews` map entries gain `mode: "pending" | "executing" | "converted"`. `crew_begin` with `{objective, subtasks}` registers PENDING. Terminal states: closed-by-report (existing), abandoned (new), converted (new). `converted`/`abandoned` end the crew; a fresh `crew_begin` may follow immediately (re-shard / new objective).

*Rejected:* asking at registration time (the ask dialog is binary allow/deny — cannot express a three-way choice) — the pause must be conversational, with the belt as backstop.

### D2 — The pending belt

`tool.execute.before` handler: when the session's crew exists and `mode === "pending"`, ANY `task` call is refused with the three-choice message (any dispatch after registration is execution start — the recon phase precedes registration, so pre-registration task calls are unaffected). Belt does not fire when: no crew, mode `executing`, or crew already ended. Same mechanism family as the plan-draft write ban; consistent with the plugin's "discipline by mechanism, not vibes" philosophy.

### D3 — Mode transitions

Follow-up `crew_begin {execution: "waves" | "goal"}` (no objective/subtasks) arms a PENDING crew:
- `waves` → mode `executing`, belt lifts, the /crew template's wave discipline takes over.
- `goal` → crew ends as `converted` (lightweight record: no verdicts, no ask — the immediately following `goal_write(arm=true)` confirmation dialog IS the user gate; double-asking is friction). The conversion output instructs folding the declared subtask plan into the goal contract's criteria/checks.
- standby → no tool call; crew stays PENDING indefinitely; user may arm later, or abandon.

*Rejected:* a dedicated `crew_mode` tool (tool-surface growth for one boolean flip); implicit belt-lift on user message (untrackable — the belt must read plugin state, not chat).

### D4 — Abandon path (re-shard exit)

`crew_close {abandon: true, reason}` — ask-gated like normal close, but no verdict requirements; records an abandonment note. Usable from PENDING (standby cancel) and EXECUTING (wrong decomposition, including mid-goal-loop re-sharding). Normal report close is unchanged.

### D5 — Goal loop interaction

No goal-harness change. Inside an active goal loop, re-crew = abandon + fresh `crew_begin` (belt applies to the new pending crew too — the mode choice surfaces to the user in the continuation brief, which is correct: re-sharding decisions are user-visible). This mirrors BMAD re-sharding without touching goal contracts.

### D6 — Surface rewrite

`crew_begin` success output and the `/crew` template's registration step change from "Proceed with waves" to: roster confirmed + three-choice presentation + STOP (end the turn). The template keeps every other element (family guard, gate, JSONC template, waves/retry/close discipline — the wave text now scoped to the armed state).

### D7 — Crew plan disk record (compaction anchor)

`crew_begin` persists the declared subtask plan to `<session-anchor>/.opencode/crew/<date>-<slug>.md` (same pattern as goal contracts); arm / convert / abandon / close append their records to the same file. Anchoring contract: the crew record shares the exact `sessionAnchor()` chain with plan/goal artifacts — git-repo sessions anchor at the repo root; plain-folder sessions anchor at the session directory (the `isRootish` guard keeps degenerate global-project worktrees from landing records on the drive root or the launch anchor); the anchor follows the session's workspace, never the objective's scope. Purpose: (a) a human-inspectable record of what was registered; (b) a compaction anchor — after context compaction the model can re-read the file to recover the registered plan, while the in-memory crews map remains the mechanical truth the gates cross-check. Explicitly NOT a resume mechanism: host restart still kills the crew honestly; a stale record is dead weight superseded by the next `/crew` in that workspace. This answers the long-loop concern: the truth now survives compaction twice over (host state + disk); only the chat narrative is compressible.

### D8 — Host-pool origin disclosure

Field evidence (SorenUnityLabs@076b61d1 session, 2026-09-29): the workspace-mismatch disclosure fired correctly (proving session-anchored walk-up discovery works), but the `crew_begin` output never states WHERE the dispatchable set came from — the model narrated the paseo-launch-anchor pool as "the global layer", and the user read that as "project config treated as global". Fix in the same output rewrite as D6: whenever the registration output reports the dispatchable roster, it SHALL name the origin — the forge.json path the host materialized from (launch anchor) — and, when the mismatch disclosure fires, pair it with the remediation: workspace-layer roles enter the dispatch vocabulary only after a host restart anchored there; a cross-host universal pool belongs in `~/.config/opencode/forge.json`. No discovery-semantics change: the cascade itself is correct.

### D9 — Goal-delegated self-orchestration (amends D4)

The user's second composition: arm a goal (after plan / spec / a verbal agreement) and let the agent own the crew layer inside the loop — unattended. The pending pause would stall that loop on a question nobody answers, so authorization flows through the goal contract's ALREADY-GATED arming dialog:

- **One-call register+arm**: while a live ACTIVE goal governs the session (active + owned by this session, per the continuation-ownership semantics), `crew_begin {objective, subtasks, execution: "waves"}` is legal in a single call — the crew is born EXECUTING and never pends; the belt never fires for it.
- Without a governing goal, `execution` at registration is REFUSED with "register without execution — the pause is the user's decision point" (protects the standalone /crew template, which never instructs the field, from gutting the gate).
- **Gates go internal under a governing goal**: `crew_close` (report) and `{abandon}` drop the ask requirement — crew machinery is internal to the loop; the goal's own gates (arm / resume / complete / budget stop-reasons) remain the user boundary. `execution: "goal"` under a governing goal is refused (already governed — conversion is for standalone crews only).
- **Re-shard unattended**: abandon (no-ask) + fresh one-call `crew_begin` — the overnight loop can re-decompose without a human turn.
- The delegation directive lives in the goal continuation brief (goal-harness delta, one requirement): "own the crew layer — register with `execution:"waves"` in one call, dispatch forge-* waves, re-shard via abandon + fresh registration".

### D10 — Slash-free operation (invariant, both harnesses)

Neither harness requires its slash command: `goal_write(arm)` / `crew_begin` are always in the forge toolset, and the ask dialogs are the real authorization surfaces. The slash templates are discipline carriers (rulebooks), not capability gates — "开个 goal，让 agent 自己组 crew 干到验收" in plain chat must arm the full pipeline: goal dialog → loop → one-call crews. The template rewrites in D6 must not regress this (wiring tests already call tools without commands).

## Risks / Trade-offs

- **One extra turn of latency** per crew (the pause) — accepted; it is the point.
- **Belt false positives**: a model that dispatches tasks before registering is unaffected; after registering, dispatch IS execution — no legitimate bypass exists. Standby crews hold no resources (in-memory object).
- **Dual-purpose crew_begin** slightly overloads one tool — accepted over tool growth; the arm call is shape-disjoint (no subtasks/objective), so misfires are easy to reject precisely.
