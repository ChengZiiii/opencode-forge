# E2E evidence — official-install run (task 7.2)

Environment: opencode 1.18.32, Windows, official `opencode plugin
git+file:///<repo> --global` installer (cache clone refreshed), XDG-isolated
sandbox config (plugin entry + glm-coding-worker provider), plugin commit
828b9c5 + crew_begin init-gate backstop.

## Run 1 — full phases (before the (f) assertion split)

- [PASS] sandbox config carries the official git+file plugin entry
- [PASS] (a) no forge_dispatch tool on the live host (transcript check)
- [PASS] (d) broken forge.json surfaces a parse-location finding (serve log
  carries `[forge:config] error: ... (line 1, column 3)`)
- [PASS] (b) the model dispatched the configured forge-research subagent
  (transcript names the subagent; reply carries its word)
- [PASS] (c) the child session ran on the PINNED model (child modelID:
  glm-5.3-flash)
- (f) split into mechanism/behavior after this run — see run 2.

## Run 2 — phase A (mechanism + behavior split)

- [PASS] (f.1) unconfigured /crew serves the hard-gate template
  (GET /config → command.crew.template contains "CREW IS NOT INITIALIZED")
- [PASS] (a) forge agent live; command map has no dispatch surface
- [PASS] (f.2, warn-only) behavioral relay — environment note: the paseo
  runtime broken shell.env hook rejects every builtin shell call in the
  sandbox, dragging the model turn past the deadline; warn-only by design.

## E2E-found product fixes folded back

1. crew_begin now enforces the initialization gate at the MECHANISM level
   (empty agent set → refusal with guidance), closing the gap where a model
   skipped the /crew template text — found live in run 0.
2. Driver lessons (test infra only): undici 300s headers timeout on the
   turn-synchronous POST → fire-and-forget + transcript polling (stable-x2,
   same discipline as the plugin); Windows shell:true orphans the serve
   grandchild → taskkill /T /F; random ports + zombie listening-line guard.

Driver: scripts/subagents-e2e.mjs
