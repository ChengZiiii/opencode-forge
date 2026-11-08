# Design — forge-prompt-shared

## Context

`src/forge-config.ts` parses each pool file into `{agents, declaredPool, findings}` (mtime-cached,
per-file); `PoolFamily` entries carry `{file, ns, declaredPool, ids}` and the resolver maps agentId →
family. `src/dispatch-tiers.ts` composes the materialized prompt via
`materializeAgentPrompt({agent, shape, role: rolePromptFor(agentId, def)})` where `rolePromptFor` is the
three-layer chain (explicit def.prompt > ROLE_PROMPTS[research|review] > generic one-liner). Both the v1
`server()` and v2 `setup()` materializers iterate resolved agents.

The five-change batch discussion approved the pool-level shared segment and DROPPED the role-library
expansion (reference-only: `research`/`review` built-ins stay the whole catalog; no new named roles).

## Goals / Non-Goals

**Goals**: one `shared` write-point per pool file; deterministic layering; fail-soft like every other
field; byte-identical default when unused; hot-apply for free.

**Non-Goals**: no new role ids or catalog (dropped in the approved decision); no template/variable
interpolation in `shared` (plain string); no per-agent opt-OUT of `shared` (a pool that shares, shares —
an agent needing escape gets its own pool file or the author splits the pool; one more knob is one more
contract to test and explain); no cascade semantics (the opencode-aligning cascade and the POOL resolver
are different loaders — `shared` is a POOL-file feature only, the cascade never sees it).

## Decisions

### D1 — Layering: shared BENEATH the unchanged chain (adopted)

`rolePromptFor(agentId, def, shared?)` → `shared` ? `${shared}\n\n${chain}` : `${chain}` where `chain` is
the existing three-layer result, byte-for-byte. Approved reading of "显式 prompt 优先": explicit prompts
keep their priority over role defaults — `shared` is a common BASE, not a competing layer, so it can
neither be beaten by nor beat any existing layer. This makes the feature purely additive: any existing
pool's prompts are the no-shared baseline, and adding `shared` to a file is a strict prepend.

### D2 — Parse: top-level per-file, fail-soft, one finding (adopted)

In the per-file parse (where `declaredPool` is captured today): `top.shared` — undefined/null → absent;
non-string or trim-empty → findings.push({level:"warn", code:"shared-invalid", message:`${path}: the
top-level "shared" field must be a non-empty string — ignored`}) and absent; valid → captured trimmed.
Carried on the family/resolution entry beside `ns`/`declaredPool` so materializers resolve per-FILE
(agents from two different pool files each get THEIR file's shared — no cross-pool bleed, matching the
sole-ownership mental model).

### D3 — Global file: shared inherits, unlike pool (adopted)

The global loader already ignores `declaredPool` with a warn (namespace is fixed `global`); `shared` is
content, so the global family inherits it. One rule, zero exceptions elsewhere: whatever file an agent
came from, that file's valid `shared` rides beneath its chain.

### D4 — Materializers pass it through; v1/v2 parity (adopted)

`forgeAgentDef` gains an optional `sharedSeg` param (default undefined = byte-identical today) threaded
from both `server()` and `setup()` materialization loops. The description/provenance surface is untouched
— `shared` affects only the prompt body.

### D5 — Rejected alternatives

- **Per-agent `inheritShared: false` opt-out.** A second knob that composes badly with the three-layer
  chain (opt-out of a base?) and doubles the matrix. Rejected — pool file boundaries are the escape.
- **shared as a role-catalog entry (shared + role name indirection).** Reintroduces the dropped role
  library through the back door. Rejected.
- **Array-of-strings shared.** YAGNI; a single string with the author's own paragraphing is enough.
  Rejected.
- **Interpolation (`{{repo}}` etc.).** A template engine is a new subsystem with new failure modes;
  fail-soft string discipline stays. Rejected.

## Risks / Mitigations

- **Prompt bloat**: `shared` is one string per pool; authors own its length; the README shows a short
  conventions-style example.
- **Cross-family surprises**: D2's per-file resolution is asserted by a two-pool fake-fs test (agent A
  from pool 1 gets pool 1's shared; agent B from pool 2 gets pool 2's or none).
- **Byte-compat regressions**: the no-shared path is asserted byte-identical in tests (D1's strict
  prepend makes this structural).
- **Interaction with the exec-seal channel mandate / dispatch-prompt mandate**: those layers wrap the
  role prompt in `materializeAgentPrompt` — unchanged here; `shared` enters BELOW them (role slot), so
  mandate text precedence is untouched.
