# fix-dispatch-model-pin-shape

Session-create model record id must be the bare model id, not the provider-qualified key - the host composes providerID + '/' + id at runner select, so the full-key shape dies with a tripled key (production evidence 2026-11-22: adopted wish j-20261120-051455 died with Model unavailable: glm-coding-worker/glm-coding-worker/glm-5.3; sandbox probe reproduced variant-matrix)
