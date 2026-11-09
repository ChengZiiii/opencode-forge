# Proposal: search-js-fallback

## Why

Field report (2026-11-09, a second machine without ripgrep): `forge_grep`/`forge_glob` are callable but functionally dead — every call returns `ripgrep (rg) not found — … fall back to the builtin grep/glob tools`, and the model dutifully abandons the forge pair. The 0.19.0 design legalized this: spec requirement "ripgrep resolution is fail-soft" mandates a fail-soft error when no rg resolves, so the tool's availability silently depends on a machine-level ripgrep install (winget on the dev box — pure accident of the verification environment; reproduced locally by scrubbing PATH: `resolveRgBinary` miss → wiring early-return).

Worse, the field case is the tool's own founding scenario: locating `Assets/SorenLibs` — a **junction** pointing outside the workspace (`C:\Users\chengsongren\Documents\BeyondLibs`). On that machine the chain played out as: forge_glob dead (no rg) → fail-soft guidance redirects to builtin glob → **builtin glob is structurally blind to junctions** (the exact blindness forge_search exists to fix) → forge_shell probing also missed it → the user had to fall back to hand-written recursive PowerShell. The remedy text is a lie for precisely the blind-spot case the pair was built for. The plugin's standing guarantee everywhere else is zero-dependency self-containment; the search pair is the sole exception. This is a spec-level defect, not just code.

## What Changes

- **Bundled pure-JS search engine** (`src/search-js.ts`, no new deps, no install scripts, bundles into `dist/index.js`): recursive walk with `follow`/`hidden` flags, `**/.git/**` exclusion, cycle guard, binary-file skip, and the same record shape `{path, line, text}` — feeding the EXISTING dedupe/disclosure/formatter post-pass unchanged.
- **Engine chain replaces fail-soft death**: `search.rgPath` override → rg on PATH → **bundled JS engine** (never a dead tool). A configured-but-broken rg (spawn failure) also falls through to the JS engine.
- **Engine disclosure footnote**: when the JS engine serves a call, the output ends with one line: `(engine: builtin-js — ripgrep not found; install ripgrep or set search.rgPath for the faster engine)`. Output parity otherwise unchanged (`Found N matches` header first line).
- **Bounded-walk guarantees, honestly disclosed**: file-count cap and per-file size cap on the JS engine, surfaced as truncation-style notices when hit (rg engine has no such caps and stays preferred whenever resolvable).
- Tool descriptions updated: "rg under the hood" → "ripgrep when available, bundled JS engine otherwise".
- **BREAKING**: none to the interface (params/output identical). The spec's fail-soft error path is REMOVED — the "missing ripgrep" scenario now returns live results instead of guidance.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `search-tools`: Requirement "ripgrep resolution is fail-soft" is replaced — resolution miss no longer fails the call; the bundled JS engine serves it with an engine-disclosure footnote. Requirement "Readonly-safe construction and family availability" is reworded engine-agnostically (fixed typed-parameter engine — rg argv or the bundled JS walker — no shell either way) with its scenarios carried in full.

## Impact

- `src/search-js.ts` (new, pure core + glob dialect subset matcher), `src/search-core.ts` (untouched), `plugin.ts` `runRgSearch` → engine-dispatching `runSearch` (resolution chain + footnote plumbing), tool descriptions.
- Tests: new `search-js` suite (glob dialect matrix, cycle guard, binary skip, caps, .git/hidden/follow semantics) + wiring tests covering the rg-less PATH end-to-end (scrubbed-PATH seam) + broken-override fall-through.
- Packaging: dist grows (self-contained, still 3-file whitelist, zero triggers), version 0.21.0.
- README: search section gains the engine chain + footnote documentation; the fail-soft remedies paragraph is replaced.
