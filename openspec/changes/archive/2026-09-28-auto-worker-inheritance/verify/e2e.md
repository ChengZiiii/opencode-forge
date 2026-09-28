# E2E evidence — auto-worker-inheritance

## npm-channel E2E (release 0.6.0, real environment)

- Published @sorenllm/opencode-forge@0.6.0 (npm publish success line + double-publish EPUBLISH-over guard confirming server-side acceptance; packument CDN lagged ~5 min — cache refresh needed --prefer-online).
- forge.json: {scout:{}, broken:{model:...}} in a sandbox workspace; plugin cache refreshed to 0.6.0 (pair-check marker present).
- Startup line: `[forge:config] error: agents.broken: model and thoughtLevel form an atomic pair — model is set but thoughtLevel is missing; ... entry skipped, siblings still apply` — verbatim per spec.
- Auto dispatch: task -> forge-scout returned model `glm-coding-worker/glm-5.3` == the parent header model (inheritance verified).
- Vocabulary: task agents = explore, forge-scout, general, vision-agent — no forge-broken (BROKEN:NO).
