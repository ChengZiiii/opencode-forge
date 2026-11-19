# v2-runtime-model-pin — Tasks

- [x] 1. Implement the runtime pin in `v2ContextInjection`: forge-family
  block resolves the pool def fresh, parses `def.model` via
  parseIdentity, rewrites `payload.model` (providerID + id + modelID,
  variant deleted) when pinned; malformed pins skip silently;
  `FORGE_MODEL_PROBE=1` traces rewrites — verify: unit tests
  (2026-11-20: implemented in plugin.ts v2ContextInjection forge-family
  block; parseIdentity added to models-dev import; depth channel now
  resolves against the pinned model)
- [x] 2. Unit tests (v2 mock harness): wired leg (pinned def → payload
  model rewritten to the parsed identity, variant gone), drift legs
  (no pin → untouched; unparsable pin → untouched, no throw; missing
  context payload model → no throw; non-forge agent → untouched) —
  verify: tests green
  (2026-11-20: tests/v2-session-commands.test.mjs "v2 model pin" —
  pinned/auto/badpin agents + missing-model payload leg; file 14/14)
- [x] 3. Sandbox full-chain E2E: pool agent pinned to
  `glm-coding-worker/glm-5.3`, dispatched via task, served record names
  the pinned model — verify: probe evidence in the sandbox marker log
  (2026-11-20: opencode serve 2.3.2 sandbox; ws-forge pool agent
  forge-live-swapper dispatched by a forge primary via task; child
  session ses_e0b2f4391ffei23r2Dz23AQLyi assistant record:
  model=glm-5.3/glm-coding-worker finish=stop text=OK — host default
  tidepool-alpha-free overridden by the pin; also: resolve hook fires
  but its rewrite does NOT propagate, context hook does)
- [x] 4. Docs: update v2-plugin-api-port design supersession item 11
  (model-pin drift) to "resolved via runtime pin (context hook)";
  AGENTS.md v2-drift list updated — verify: validate --all green,
  full suite green
  (2026-11-20: design.md item 11 superseded with the probe-ladder
  resolution + full-chain proof; AGENTS.md drift ① marked resolved)
