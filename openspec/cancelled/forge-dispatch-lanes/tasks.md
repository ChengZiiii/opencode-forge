# forge-dispatch-lanes — tasks

> Status: PROPOSED — awaiting user review of the design direction
> before any implementation (proposal Authorization note). Do not
> check these off until apply is approved.

## 1. Config core (src/forge-config.ts)

- [ ] 1.1 `lanes` node parse: models array, distribution (fail-soft
  default sequential), lane-level thoughtLevel; cascade merge; bad-def
  drop + warn.
- [ ] 1.2 Entry `lane` field: model XOR lane (conflict → error finding +
  entry skip); thoughtLevel pair rule generalized (model OR lane);
  unknown-lane reference → error finding + entry skip.

## 2. Materialization + resolution

- [ ] 2.1 `forgeAgentDef` disclosure: lane name + chain ids + "resolves
  per spawn" in the description (pool provenance unchanged).
- [ ] 2.2 Lane resolution at the dispatch pump: sequential order /
  round_robin rotation (in-memory cursor, hot-apply reset), gate/breaker
  skip with journal, per-hop resolved-identity journaling.
- [ ] 2.3 Demotion on failed terminal via the existing respawn seams;
  chain-exhausted honest failure naming lane + last member; cursor reset
  on success.
- [ ] 2.4 v1 chat.params per-spawn resolution; v2 runtime-model-pin
  context-hook fed the resolved identity.

## 3. Schema + mirror

- [ ] 3.1 `schema/forge.schema.json`: lanes node, entry lane field,
  generalized pair rule; drift-mirror test extended to lock them.

## 4. Tests + verify

- [ ] 4.1 Config matrix (D2 semantics), resolution matrix (D3), wiring
  (description/params/context-hook), schema mirror — per design test
  plan; full suite green (788+ baseline); typecheck; bundle.
- [ ] 4.2 `openspec validate --all`; git+file official-install verify
  round-trip paired; version bump + npm publish ONLY after user
  approval.
