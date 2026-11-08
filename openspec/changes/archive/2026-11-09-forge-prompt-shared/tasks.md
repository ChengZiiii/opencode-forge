# Tasks — forge-prompt-shared

- [x] 1. Core (`src/forge-config.ts`, `src/dispatch-tiers.ts`)
  - [x] 1.1 Per-file parse: capture `top.shared` (undefined/null → absent; non-string/trim-empty → ONE warn finding `shared-invalid` naming the file, field ignored; valid → trimmed value carried on the family/resolution entry beside ns/declaredPool)
  - [x] 1.2 `rolePromptFor(agentId, def, shared?)`: when shared is present, `shared + "\n\n" + existingChain`; the three-layer chain byte-identical to today (strict prepend, D1)
  - [x] 1.3 `forgeAgentDef` gains optional `sharedSeg` param threaded into rolePromptFor; description/provenance/permission/tools untouched
  - [x] 1.4 Global fallback file: its valid `shared` inherits to the global family (pool-namespace-ignored rule does NOT extend to shared — add the contrast comment)
  - [x] 1.5 Per-FILE resolution: agents from different pool files each get THEIR file's shared — no cross-pool bleed

- [x] 2. Wiring (`plugin.ts`)
  - [x] 2.1 v1 `server()` materialization loop passes each agent's file-level shared into forgeAgentDef
  - [x] 2.2 v2 `setup()` loop does the same (create-only semantics and guards untouched)

- [x] 3. Tests
  - [x] 3.1 hierarchical-pools (fake-fs): shared+explicit / shared+role-default / shared+generic compositions; invalid shared → one warn + ignored + agents still materialize; global-file shared inherits; TWO pools each with different shared (or one without) — per-file scoping; no shared → byte-identical materialized prompts
  - [x] 3.2 forge-subagents-wiring / dispatch-prompt: composition-order assertions incl. the mandate layers wrapping unchanged (shared enters the role slot, below the mandates)
  - [x] 3.3 Regression: all existing forge-config/hierarchical-pools/dispatch suites green untouched (byte-compat asserted)

- [x] 4. README + verification gates
  - [x] 4.1 README forge.json authoring section: the `shared` field, layering contract (common base beneath the unchanged chain), fail-soft rule, per-file scope, hot-apply
  - [x] 4.2 `bun run typecheck` — clean
  - [x] 4.3 `node --test tests/*.test.mjs` — full suite green (baseline + new, zero regressions)
  - [x] 4.4 `bun run bundle` + `npm pack --dry-run` — whitelist still exactly dist + README.md + package.json
