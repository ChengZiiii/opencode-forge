# Design — hierarchical-pool-materialization

Baseline: `plugin.ts` single mutable `hostWorktree`/`forgeLoader` singleton (last-init-wins — the tear source), `src/forge-config.ts` two-layer loader (global base + nearest project file walking up from one anchor), per-agent materialization semantics unchanged since add-dispatch-suite/partition-tool-surfaces. Constraints carried over from the field: frontends share one host across projects; opencode re-initializes plugins with per-project directories during the host's lifetime (proven by the 14:24/14:26 tear); task vocabulary is host-global.

### D1 — Anchor freeze

The mutable singleton becomes an append-only **anchor set**. `server()` appends its effective directory (deduped by normalized form — resolved real path with case-folding on win32, so `C:/Temp1` vs `c:\temp1\` cannot double-add); the first entry is the *primary anchor* and is never replaced. No code path may remove an anchor or re-point "the" loader: the 14:24→14:26 class of tear (roster promised, gate empty, vocabulary stale) becomes structurally impossible. Rejected alternative: keep single-anchor + first-wins (would fix the tear but cannot express multi-project hosts — D2 is required by the workflow, not just the bug).

### D2 — Anchor-set accumulation

Every plugin (re)initialization directory joins the set. On a shared host, each dev line's workspace anchor joins as that line's sessions appear (the re-init events that used to be the bug become the discovery mechanism). The set lives in module state and dies with the host — restart re-seeds from the spawn anchor only, which is the documented, honest reset.

### D3 — Pool family resolution per anchor

For each anchor the plugin resolves a **family**:
- **Root pool**: nearest `.opencode/forge.json` walking up from the anchor (existing two-layer semantics: global base, per-id override by the project file) — unchanged from align-forge-config-discovery.
- **Sub-pools**: bounded descent from the anchor collecting every directory holding `.opencode/forge.json`. Bounds and order: **breadth-first, lexicographic sibling order** (deterministic — when the cap hits, which pools survived is a function of the tree, not of fs readdir whims); a dependency skip-list closed at exactly `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `.cache`, `.venv`, `venv`, `__pycache__`, `coverage` (exhaustive by design; extension means a spec change); a per-anchor scanned-directory budget (default 2,000 — at the cap no further directories are opened in that order); and an mtime cache keyed by directory so unchanged subtrees cost nothing on re-scan. File creation/deletion hot-applies on the next config hook (consistent with the existing hot-apply contract); a sub-pool file's own ancestor chain is NOT consulted (the root pool already carries it — no double counting).
- The scan is git-agnostic by design: plain-folder workspaces (repo collections + doc folders) resolve exactly like git workspaces. Doc folders without a forge.json simply have no sub-pool and fall to the root 总管.

### D4 — Pool identity and namespaces

**Pool identity = the absolute forge.json path.** Two anchors covering the same file (Temp1's subtree scan and a devAc-anchored line both reaching `devAc/.opencode/forge.json`) materialize it once. **Pool resolution order is deterministic**: the primary anchor's root pool first, then the remaining pools lexicographically by absolute file path — every collision rule below keys off this order.

Materialized ids: the **primary anchor's root pool keeps plain ids** (`forge-shader`) — a single-anchor host is byte-compatible with today; every other family materializes as `forge-<ns>-<id>` where `ns` = the file's `pool` field, else the sanitized directory basename (**lowercased; each run of characters outside `[a-z0-9-]` collapsed to a single `-`; leading/trailing `-` trimmed; empty result falls back to the literal `pool`**).

Collisions, two distinct classes with one resolution order:
- **Namespace collision** (two files deriving/declaring the same ns): in order, first file keeps the short ns; later files get an incrementing hyphen suffix (`-2`, `-3`, …) until unique across both derived and declared namespaces; error finding names both files.
- **Materialized-id collision** (primary plain `aa-shader` vs ns `aa` + `shader`, or ns `aa`+`b-shader` vs ns `aa-b`+`shader`): namespaces do NOT absorb this by construction (the primary pool has no namespace) — the earlier pool in resolution order wins and the later pool's colliding agent is skipped with an error finding. No silent shadowing, ever.

Id normalization (`forge-` stripping, charset) applies to the raw id BEFORE namespace composition; the namespace infix is never parsed back out of a materialized id. The global layer merges as the base of every family (per-id: family file overrides global within the family).

### D5 — Optional `pool` field

Top-level string in a forge.json: short (`[a-z0-9-]`, ≤24 chars), stable, directory-name-independent. Validation is field-level fail-soft: invalid value → warn finding + directory-name fallback; the family still materializes. Purpose is surface-only (shorter ids, rename-stability) — no dispatch, anchoring, permission, or isolation semantics attach to it. **AI-assist rule**: every surface that teaches the session AI how to write a forge.json on the user's explicit go-ahead (the unconfigured-gate guidance and the onboarding template) additionally mandates proposing a short stable pool name and including the field.

### D6 — Flip-immune, file-hot

The two change channels are separated: **anchor flips never mutate the vocabulary** (D1/D2); **file truth always does** (edits, creations, deletions hot-apply per the existing mtime contract). This keeps align-forge-config-discovery's hot-apply promise intact while killing the ambient channel that caused the tear.

### D7 — Roster and disclosure scale to pools

The `/crew` template's roster section groups by pool: the primary root pool first (plain ids), then each namespaced pool with its origin path; the pool list in disclosures is bounded (first 8 pools shown, remainder as "…and k more" with the full list kept in a finding). `crew_begin`'s origin disclosure (D8 of add-crew-execution-mode-gate) generalizes from "the launch anchor's forge.json" to an enumeration of pool origins (same bound, primary marked). The workspace-mismatch disclosure survives only for the residual case: a forge.json in the session's workspace that NO anchor's chain or subtree covers.

### D8 — Unconfigured gate under the union

"CREW IS NOT INITIALIZED" now means zero pools across the entire anchor set. The guidance text gains the two-axis explanation (pools follow directories on the host; session artifacts follow the session) and the AI-assist line from D5.

### D9 — What deliberately does NOT change

- plan/goal/crew **state anchoring** (session axis) — one `sessionAnchor()` chain, three consumers, zero code change.
- Per-agent materialization semantics (pinned pair / Auto, shapes, permissions, worker discipline, `task: deny`) — a namespaced id is just another `forge-*` family agent: tool-partition, dispatch tiers, and depth translation (keyed by materialized name) all work unmodified.
- Crew/goal harness mechanics (pending belt, gates, records, briefs) — only template/disclosure text moves.

### D10 — Honest limits (documented, not fixed)

- **Cross-project visibility on a shared host is physical**: the task registry is host-global; namespaces prevent collisions, not visibility. The roster's pool grouping is the disclosure.
- **Scan cost** is bounded but nonzero on first config per anchor; the mtime cache amortizes subsequent passes.
- **Primary-anchor luck**: whichever directory initializes first gets plain ids; on paseo-style hosts this is the spawn/first-project anchor. Functionally irrelevant (roster discloses), cosmetically variable.
- **Archive-order dependency**: `align-forge-config-discovery` must archive before this change (same base requirement; this change's MODIFIED text absorbs it in full).
