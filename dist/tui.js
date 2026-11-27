// src/tui/flow.ts
import { randomUUID } from "node:crypto";

// src/forge-config.ts
var AGENT_ID_RE = /^[a-z0-9-]+$/;
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
var BUILTIN_OVERRIDE_IDS = ["general", "explore"];
function validateAgentSet(raw, labelPrefix = "agents") {
  const findings = [];
  const agents = {};
  if (raw === undefined)
    return { agents, findings };
  if (!isRecord(raw)) {
    findings.push({ level: "error", code: "agents-not-object", message: `forge.json "${labelPrefix}" must be an object mapping agent ids to definitions — the agent set is empty` });
    return { agents, findings };
  }
  for (const [rawId, entry] of Object.entries(raw)) {
    let label = `${labelPrefix}.${rawId}`;
    let id = rawId;
    if (rawId.startsWith("forge-")) {
      id = rawId.replace(/^(forge-)+/, "");
      findings.push({ level: "warn", code: "agent-id-forge-prefix", message: `${label}: the forge- prefix is added automatically at materialization — stripped to "${id}"; rename the entry to silence this warning` });
    }
    if (!AGENT_ID_RE.test(id)) {
      findings.push({ level: "error", code: "agent-id-invalid", message: `${label}: agent id must match [a-z0-9-] — entry skipped` });
      continue;
    }
    if (agents[id] !== undefined) {
      findings.push({ level: "error", code: "agent-id-collision", message: `${label}: normalizes to "${id}" which is already defined — entry skipped (first definition wins)` });
      continue;
    }
    if (!isRecord(entry)) {
      findings.push({ level: "error", code: "agent-not-object", message: `${label}: definition must be an object — entry skipped` });
      continue;
    }
    if (entry.depths !== undefined) {
      findings.push({ level: "warn", code: "depths-deprecated", message: `${label}.depths is no longer used (static agents pin one thoughtLevel) — ignored; set "thoughtLevel" instead` });
    }
    let model;
    if (entry.model !== undefined) {
      if (nonEmptyString(entry.model)) {
        model = entry.model.trim();
      } else {
        findings.push({ level: "warn", code: "model-invalid", message: `${label}.model must be a non-empty string — field ignored (counts as absent for the model/thoughtLevel pair)` });
      }
    }
    let thoughtLevel;
    if (entry.thoughtLevel !== undefined) {
      if (nonEmptyString(entry.thoughtLevel)) {
        thoughtLevel = entry.thoughtLevel.trim();
        const normalized = thoughtLevel.toLowerCase();
        if (normalized !== thoughtLevel) {
          findings.push({ level: "warn", code: "thoughtlevel-normalized", message: `${label}.thoughtLevel "${thoughtLevel}" normalized to "${normalized}" (config is lowercase; the catalog decides wire casing)` });
        }
        thoughtLevel = normalized;
      } else {
        findings.push({ level: "warn", code: "thoughtlevel-invalid", message: `${label}.thoughtLevel must be a non-empty string — field ignored (counts as absent for the model/thoughtLevel pair)` });
      }
    }
    if (model === undefined !== (thoughtLevel === undefined)) {
      const presentHalf = model !== undefined ? "model" : "thoughtLevel";
      const missingHalf = model !== undefined ? "thoughtLevel" : "model";
      findings.push({ level: "error", code: "agent-half-configured", message: `${label}: model and thoughtLevel form an atomic pair — ${presentHalf} is set but ${missingHalf} is missing; set BOTH to pin the brain and depth, or NEITHER for an Auto worker — entry skipped, siblings still apply` });
      continue;
    }
    const def = {};
    if (model !== undefined) {
      def.model = model;
      def.thoughtLevel = thoughtLevel;
    }
    if (entry.prompt !== undefined) {
      if (nonEmptyString(entry.prompt)) {
        def.prompt = entry.prompt;
      } else {
        findings.push({ level: "warn", code: "prompt-invalid", message: `${label}.prompt must be a non-empty string — field ignored` });
      }
    }
    if (entry.shape !== undefined) {
      if (entry.shape === "readonly" || entry.shape === "write") {
        def.shape = entry.shape;
      } else {
        findings.push({ level: "warn", code: "shape-invalid", message: `${label}.shape must be "readonly" or "write" — defaulting to write (absent shape is write)` });
      }
    }
    if (entry.permission !== undefined) {
      if (isRecord(entry.permission) && Object.values(entry.permission).every((v) => typeof v === "string")) {
        def.permission = entry.permission;
      } else {
        findings.push({ level: "warn", code: "permission-invalid", message: `${label}.permission must map tool names to string values — field ignored` });
      }
    }
    agents[id] = def;
  }
  return { agents, findings };
}
function validateOverrideNode(raw, label) {
  if (raw === undefined || raw === null)
    return { overrides: {}, findings: [] };
  if (!isRecord(raw)) {
    return {
      overrides: {},
      findings: [{ level: "warn", code: "override-node-invalid", message: `${label}: the top-level "override" field must be an object mapping built-in ids ("general", "explore") to definitions — field ignored` }]
    };
  }
  const validated = validateAgentSet(raw, "override");
  const overrides = {};
  for (const [id, def] of Object.entries(validated.agents)) {
    if (!BUILTIN_OVERRIDE_IDS.includes(id)) {
      validated.findings.push({
        level: "warn",
        code: "override-id-unknown",
        message: `${label}: override.${id} is not a built-in subagent id — the built-ins are exactly ${BUILTIN_OVERRIDE_IDS.map((i) => `"${i}"`).join(", ")} (lowercase, case-sensitive: a capitalized key creates an ambiguous duplicate, never an override) — entry skipped`
      });
      continue;
    }
    overrides[id] = def;
  }
  return { overrides, findings: validated.findings };
}
function validatePoolField(v) {
  if (typeof v !== "string")
    return { ok: false };
  const trimmed = v.trim();
  if (trimmed.length < 1 || trimmed.length > 24 || !/^[a-z0-9-]+$/.test(trimmed))
    return { ok: false };
  return { ok: true, ns: trimmed };
}

// src/forge-config-edit.ts
var UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var AGENT_ID_RE2 = /^[a-z0-9-]+$/;
function normalizeWorkerId(rawId) {
  const findings = [];
  let id = rawId;
  if (rawId.startsWith("forge-")) {
    id = rawId.replace(/^(forge-)+/, "");
    findings.push({ level: "warn", code: "agent-id-forge-prefix", message: `id "${rawId}": the forge- prefix is added automatically at materialization — using "${id}"` });
  }
  return { id, findings };
}
function validateDraftShape(draft) {
  const findings = [];
  if (draft.mode === "pinned") {
    if (typeof draft.model !== "string" || draft.model.trim().length === 0 || typeof draft.thoughtLevel !== "string" || draft.thoughtLevel.trim().length === 0) {
      findings.push({ level: "error", code: "agent-half-configured", message: "pinned mode requires BOTH model and thoughtLevel — a pin with a missing half is refused (it would silently degrade to an Auto worker)" });
    }
  } else if (draft.model !== undefined || draft.thoughtLevel !== undefined) {
    findings.push({ level: "error", code: "auto-with-pin-fields", message: "auto mode cannot carry model or thoughtLevel — switch to pinned mode to set the pair" });
  }
  if (draft.prompt !== undefined && !(typeof draft.prompt === "string" && draft.prompt.trim().length > 0)) {
    findings.push({ level: "error", code: "prompt-invalid", message: "prompt must be a non-empty string" });
  }
  if (draft.shape !== undefined && draft.shape !== "readonly" && draft.shape !== "write") {
    findings.push({ level: "error", code: "shape-invalid", message: 'shape must be "readonly" or "write"' });
  }
  if (draft.permission !== undefined && !(typeof draft.permission === "object" && draft.permission !== null && !Array.isArray(draft.permission) && Object.values(draft.permission).every((v) => typeof v === "string"))) {
    findings.push({ level: "error", code: "permission-invalid", message: "permission must map tool names to string values" });
  }
  return findings;
}
function validatedDefOf(id, draft) {
  const entry = {};
  if (draft.mode === "pinned") {
    entry.model = draft.model;
    entry.thoughtLevel = draft.thoughtLevel;
  }
  if (draft.prompt !== undefined)
    entry.prompt = draft.prompt;
  if (draft.shape !== undefined)
    entry.shape = draft.shape;
  if (draft.permission !== undefined)
    entry.permission = draft.permission;
  const { id: normalizedId } = normalizeWorkerId(id);
  const validated = validateAgentSet({ [normalizedId]: entry }, "agents");
  const def = validated.agents[normalizedId] ?? {};
  return { ok: !validated.findings.some((f) => f.level === "error"), def, findings: validated.findings };
}
function validateWorkerDraft(id, draft, existingIds) {
  const { id: normalizedId, findings } = normalizeWorkerId(id);
  if (!normalizedId || !AGENT_ID_RE2.test(normalizedId)) {
    return { ok: false, findings: [...findings, { level: "error", code: "agent-id-invalid", message: `agent id must match [a-z0-9-] after forge- prefix stripping — "${id}" is invalid` }], normalizedId };
  }
  const normalizedExisting = new Set(existingIds.map((k) => normalizeWorkerId(k).id));
  if (normalizedExisting.has(normalizedId)) {
    return { ok: false, findings: [...findings, { level: "error", code: "agent-id-collision", message: `"${normalizedId}" already exists in this recipe (ids that normalize to the same word collide; first definition wins)` }], normalizedId };
  }
  const shapeFindings = validateDraftShape(draft);
  if (shapeFindings.some((f) => f.level === "error")) {
    return { ok: false, findings: [...findings, ...shapeFindings], normalizedId };
  }
  const check = validatedDefOf(normalizedId, draft);
  return { ok: check.ok, findings: [...findings, ...shapeFindings, ...check.findings], normalizedId };
}
function validateOverrideDraft(id, draft) {
  if (!BUILTIN_OVERRIDE_IDS.includes(id)) {
    return { ok: false, findings: [{ level: "error", code: "override-id-unknown", message: `override ids are exactly ${BUILTIN_OVERRIDE_IDS.map((i) => `"${i}"`).join(", ")} (lowercase, case-sensitive) — "${id}" is not a built-in subagent id (a forge- prefix never normalizes into an override id)` }], normalizedId: id };
  }
  const shapeFindings = validateDraftShape(draft);
  if (shapeFindings.some((f) => f.level === "error")) {
    return { ok: false, findings: shapeFindings, normalizedId: id };
  }
  const check = validatedDefOf(id, draft);
  return { ok: check.ok, findings: check.findings, normalizedId: id };
}
var commitLocks = new Map;

// src/dispatch-prompt.ts
var WORKER_MANDATES = [
  "Mandates (non-negotiable):",
  "- Use workspace-relative paths ONLY. Never write to or read from absolute paths outside this workspace; the workspace root is where you were started, not the filesystem root.",
  "- You are a background subagent. Your final message is your report. You cannot ask the user questions; report blockers to your caller instead.",
  "- Search with the builtin grep/glob tools and run commands with the builtin shell, within your permissions. For long-running commands use the shell's background parameter; the host wakes you when the command exits. Never poll or sleep to wait for completion.",
  "- Use -m / --no-edit when committing, so no interactive editor opens; editor and pager behavior belongs to the host's builtin shell.",
  "- If any tool call is refused or denied, report the refusal VERBATIM in your final answer and stop that line of work. Never improvise a workaround around a permission denial.",
  "- End with conclusions backed by evidence references (file:line, command output, or the exact file/content you produced)."
].join(`
`);

// src/dispatch-tiers.ts
var MUTATING_TOOLS = ["write", "edit", "patch", "applypatch", "apply", "multiedit"];
var PRIMARY_ONLY_WORKER_TOOLS = [
  "plan_write",
  "plan_tick",
  "plan_approve",
  "plan_close",
  "plan_reopen",
  "plan_discard",
  "goal_write",
  "goal_check",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "goal_discard",
  "crew_begin",
  "crew_close",
  "forge_sync"
];

// src/roster-compile.ts
var NATIVE_TOOL_VOCAB = {
  dispatchTool: "subagent",
  shell: "shell",
  question: "question",
  grep: "grep",
  glob: "glob",
  taskKey: "task",
  shellChannel: "execute",
  legacyShellKeys: ["shell", "bash"],
  mutatingFamily: [...MUTATING_TOOLS],
  primaryOnly: [...PRIMARY_ONLY_WORKER_TOOLS]
};
var VARIANT_DEPTH_WORDS = ["low", "medium", "high"];

// src/model-catalog.ts
function normalizeCatalog(raw) {
  const findings = [];
  if (!Array.isArray(raw)) {
    return { models: [], findings: [`catalog unavailable: expected an array of model rows, got ${raw === null ? "null" : typeof raw}`] };
  }
  const models = [];
  const seen = new Set;
  for (const row of raw) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      findings.push("catalog: skipped a non-object model row");
      continue;
    }
    const rec = row;
    const providerID = typeof rec.providerID === "string" && rec.providerID ? rec.providerID : typeof rec.provider === "string" && rec.provider ? rec.provider : null;
    const modelID = typeof rec.modelID === "string" && rec.modelID ? rec.modelID : typeof rec.id === "string" && rec.id ? rec.id : null;
    if (!providerID || !modelID) {
      findings.push(`catalog: skipped a model row missing provider/model identity (${JSON.stringify(Object.keys(rec))})`);
      continue;
    }
    const key = `${providerID}/${modelID}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    models.push({
      providerID,
      modelID,
      label: typeof rec.name === "string" && rec.name ? rec.name : key,
      variants: normalizeVariants(rec.variants),
      status: typeof rec.status === "string" ? rec.status : null,
      enabled: typeof rec.enabled === "boolean" ? rec.enabled : null,
      availability: "unverified"
    });
  }
  if (models.length === 0)
    findings.push("catalog: no usable model rows — treat as unknown, not as an empty authoritative list");
  return { models, findings };
}
function normalizeVariants(v) {
  if (Array.isArray(v)) {
    return v.map((entry) => typeof entry === "string" ? entry : entry !== null && typeof entry === "object" && typeof entry.id === "string" ? entry.id : null).filter((id) => id !== null);
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v);
  }
  return [];
}
var catalogLookup = (models) => (providerID, modelID) => models.find((m) => m.providerID === providerID && m.modelID === modelID);
function levelSupportFor(model, thoughtLevel) {
  const word = thoughtLevel.trim();
  if (model === undefined) {
    return { supported: false, word, unverified: true, note: "this provider/model identity is absent from the observed catalog — availability unknown" };
  }
  const hit = model.variants.find((v) => v.toLowerCase() === word.toLowerCase());
  if (hit !== undefined)
    return { supported: true, variant: hit };
  if (model.variants.length === 0) {
    return { supported: false, word, unverified: true, note: "the catalog exposes no variant metadata for this model — the level is unverified" };
  }
  return { supported: false, word, unverified: true, note: `"${word}" is not among the observed variants [${model.variants.join(", ")}] — usable under existing Forge depth semantics, but unverified by the catalog` };
}
function isVariantDepthWord(word) {
  return VARIANT_DEPTH_WORDS.includes(word);
}

// src/tui/catalog.ts
function catalogFromRows(raw) {
  const { models, findings } = normalizeCatalog(raw);
  return { models, known: true, findings, lookup: catalogLookup(models) };
}
var catalogUnknown = {
  models: [],
  known: false,
  findings: ["the host model catalog is not available — availability unknown, not an empty authoritative list"],
  lookup: () => {
    return;
  }
};
function providerOptions(models, extra) {
  const seen = new Map;
  for (const m of models)
    seen.set(m.providerID, (seen.get(m.providerID) ?? 0) + 1);
  const options = [...seen.entries()].map(([providerID, count]) => ({
    title: providerID,
    value: `provider:${providerID}`,
    description: `${count} model(s) in the observed catalog — availability unverified`,
    category: "Observed providers"
  }));
  if (extra?.manualEntryValue) {
    options.push({
      title: extra.manualEntryLabel ?? "Enter a provider/model identity manually…",
      value: extra.manualEntryValue,
      description: "for an existing raw value absent from the catalog (preserved, disclosed as unverified)",
      category: "Other"
    });
  }
  return options;
}
function modelOptions(models, providerID) {
  return models.filter((m) => m.providerID === providerID).map((m) => ({
    title: `${m.providerID} / ${m.modelID}`,
    value: `model:${m.modelID}`,
    description: m.variants.length > 0 ? `observed variants: ${m.variants.join(" ")}` : "no variant metadata — levels unverified",
    category: m.label === `${m.providerID}/${m.modelID}` ? undefined : m.label
  }));
}
function levelOptions(model, customValue) {
  const options = [];
  if (model !== undefined && model.variants.length > 0) {
    for (const v of model.variants) {
      const verdict = levelSupportFor(model, v);
      options.push({
        title: v,
        value: `level:${v}`,
        description: verdict.supported ? "observed variant — supported by catalog metadata" : verdict.note,
        category: "Observed variants"
      });
    }
  }
  for (const word of ["none", "low", "medium", "high", "max"]) {
    if (model !== undefined && model.variants.some((v) => v.toLowerCase() === word))
      continue;
    options.push({
      title: word,
      value: `level:${word}`,
      description: model === undefined ? "canonical depth word — target model unknown, level unverified" : model.variants.length === 0 ? `canonical depth word — model exposes no variant metadata; ${isVariantDepthWord(word) ? "compiles into the model string" : "rides per-spawn chat.params"}` : `not among the observed variants — usable under Forge depth semantics, unverified by the catalog`,
      category: "Canonical depth words"
    });
  }
  if (customValue !== undefined) {
    options.push({
      title: "Enter a custom level…",
      value: customValue,
      description: "native level name under existing Forge depth semantics — labelled unverified unless observed",
      category: "Other"
    });
  }
  return options;
}
function matchesQuery(query, texts) {
  const q = query.trim().toLowerCase();
  if (!q)
    return true;
  return texts.some((t) => typeof t === "string" && t.toLowerCase().includes(q));
}

// src/tui/entries.ts
function findingsFor(findings, labelPrefix, id) {
  const needle = `${labelPrefix}.${id}`;
  return findings.filter((f) => f.message.includes(needle));
}
function entryViewsOf(validated, rawEntries, kind, labelPrefix, findings) {
  const views = [];
  for (const [id, def] of Object.entries(validated)) {
    const raw = rawEntries[id];
    const rawModel = raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof raw.model === "string" ? raw.model : undefined;
    const rawLevel = raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof raw.thoughtLevel === "string" ? raw.thoughtLevel : undefined;
    const own = findingsFor(findings, labelPrefix, id);
    const halfConfigured = own.some((f) => f.code === "agent-half-configured");
    const mode = halfConfigured ? "half-configured" : def.model !== undefined ? "pinned" : "auto";
    views.push({
      id,
      kind,
      mode,
      def,
      rawModel,
      rawLevel,
      findings: own,
      promptPresent: def.prompt !== undefined,
      shape: def.shape,
      permissionKeys: def.permission ? Object.keys(def.permission) : []
    });
  }
  return views;
}
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function documentViewOf(doc) {
  const base = {
    path: doc.path,
    existed: doc.exists,
    readable: doc.readable,
    parseOk: false,
    parseError: null,
    workers: [],
    overrides: [],
    overridesLegal: doc.scope === "global",
    findings: [...doc.findings]
  };
  if (!doc.exists)
    return base;
  if (!doc.readable) {
    return { ...base, parseError: "the file exists but cannot be read — its content is unknown" };
  }
  if (doc.parseError !== null) {
    const e = doc.parseError;
    return { ...base, parseError: `${e.message}${e.line !== undefined ? ` (line ${e.line}, column ${e.column})` : ""}` };
  }
  const document = doc.document;
  if (!isObject(document)) {
    return {
      ...base,
      parseError: "the server snapshot carried no recognizable document — editing is refused for this target (fail-closed; browse only)",
      findings: [...base.findings, { level: "error", code: "document-payload-unrecognized", message: `${doc.path}: the server document payload was not a recognizable recipe object — no entries are shown and edits are refused` }]
    };
  }
  const isGlobal = doc.scope === "global";
  const agents = validateAgentSet(document.agents);
  const agentViews = entryViewsOf(agents.agents, isObject(document.agents) ? document.agents : {}, "worker", "agents", agents.findings);
  let overrideViews = [];
  const overrideFindings = [];
  if (isGlobal) {
    const overrides = validateOverrideNode(document.override, doc.path);
    overrideViews = entryViewsOf(overrides.overrides, isObject(document.override) ? document.override : {}, "override", "override", overrides.findings);
    overrideFindings.push(...overrides.findings);
  } else if (document.override !== undefined) {
    overrideFindings.push({ level: "warn", code: "override-node-ignored-workspace", message: `${doc.path}: the top-level "override" field is GLOBAL-layer-only — field ignored` });
  }
  return {
    ...base,
    parseOk: true,
    workers: agentViews,
    overrides: overrideViews,
    findings: [...base.findings, ...agents.findings, ...overrideFindings]
  };
}
function entryListOptions(entries, query, extraOptions) {
  const filtered = entries.filter((e) => matchesQuery(query, [e.id, e.rawModel, e.def?.prompt]));
  const rows = filtered.map((e) => ({
    title: entryTitle(e),
    value: `${e.kind}:${e.id}`,
    description: entryDescription(e),
    footer: entryFooter(e),
    category: e.kind === "override" ? "Global built-in overrides" : undefined
  }));
  return rows.concat(extraOptions ?? []);
}
function parseEntryValue(value) {
  const i = value.indexOf(":");
  if (i === -1)
    return null;
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  return kind === "worker" || kind === "override" ? { kind, id } : null;
}
var TITLE_MARKER = {
  create: "unsaved",
  "create-conflict": "create conflict",
  update: "unsaved",
  "update-missing": "update missing",
  delete: "delete"
};
function entryTitle(e) {
  const mode = e.mode === "pinned" ? "Pinned" : e.mode === "auto" ? "Auto" : e.mode === "half-configured" ? "INVALID" : "INVALID";
  const pending = e.pending !== undefined ? ` [${TITLE_MARKER[e.pending]}]` : "";
  return `${e.id} — ${mode}${pending}`;
}
function entryDescription(e) {
  if (e.pending === "delete")
    return "pending deletion";
  if (e.pending === "update")
    return "pending update";
  if (e.pending === "update-missing")
    return "pending update (entry gone)";
  if (e.pending === "create-conflict")
    return "pending create (id conflict)";
  if (e.pending === "create")
    return "pending create";
  return e.mode === "pinned" ? "pinned" : e.mode === "auto" ? "auto" : "invalid";
}
function entryFooter(e) {
  const parts = [];
  if (e.mode === "pinned")
    parts.push(`${e.rawModel ?? e.def?.model ?? "?"} @ ${e.rawLevel ?? e.def?.thoughtLevel ?? "?"}`);
  else if (e.mode === "auto")
    parts.push("auto — inherits the parent session's model");
  else if (e.mode === "half-configured")
    parts.push("INVALID — half-configured pair, skipped by the resolver");
  else
    parts.push("INVALID — skipped by the resolver");
  if (e.mode === "pinned" && e.def?.model !== undefined && e.rawModel !== undefined && e.rawModel !== e.def.model)
    parts.push(`raw "${e.rawModel}" (trimmed: "${e.def.model}")`);
  if (e.shape !== undefined)
    parts.push(`shape: ${e.shape}`);
  parts.push(e.promptPresent ? `custom prompt${e.def?.prompt !== undefined ? ` (${e.def.prompt.length} chars)` : ""}` : "no prompt");
  if (e.permissionKeys.length > 0)
    parts.push(`permissions: ${e.permissionKeys.join(", ")}`);
  if (e.pending === "update")
    parts.push("values shown are the PENDING draft — saved recipe unchanged until Save & Sync");
  if (e.pending === "update-missing")
    parts.push("the entry is GONE from the fresh saved recipe — keeping the draft re-edits it, but SAVING will be REFUSED until the entry exists again");
  if (e.pending === "delete")
    parts.push("pending deletion — saved recipe unchanged until Save & Sync");
  if (e.pending === "create")
    parts.push("pending creation — not yet in the saved recipe");
  if (e.pending === "create-conflict")
    parts.push("this id ALREADY exists in the saved recipe — the save will REFUSE this draft as a duplicate (siblings still apply)");
  if (e.findings.length > 0)
    parts.push(`findings from the saved recipe: ${e.findings.filter((f) => f.level === "error").length} error(s), ${e.findings.filter((f) => f.level !== "error").length} warn(s)`);
  return parts.join(" · ");
}

// src/tui/drafts.ts
function draftOfLoaded(def) {
  if (def === null)
    return { mode: "auto" };
  if (def.model !== undefined && def.thoughtLevel !== undefined) {
    return { mode: "pinned", model: def.model, thoughtLevel: def.thoughtLevel, prompt: def.prompt, shape: def.shape, permission: def.permission ? { ...def.permission } : undefined };
  }
  return { mode: "auto", prompt: def.prompt, shape: def.shape, permission: def.permission ? { ...def.permission } : undefined };
}
function normalizedPermission(d) {
  return d.permission !== undefined && Object.keys(d.permission).length > 0 ? d.permission : undefined;
}
function draftsEqual(a, b) {
  const norm = (d) => ({
    mode: d.mode,
    model: d.mode === "pinned" ? d.model : undefined,
    thoughtLevel: d.mode === "pinned" ? d.thoughtLevel : undefined,
    prompt: d.prompt,
    shape: d.shape,
    permission: normalizedPermission(d)
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
function changedFieldNames(a, b) {
  const normModel = (d) => d.mode === "pinned" ? d.model : undefined;
  const normLevel = (d) => d.mode === "pinned" ? d.thoughtLevel : undefined;
  const names = [];
  if (a.mode !== b.mode)
    names.push("mode");
  if (normModel(a) !== normModel(b))
    names.push("model");
  if (normLevel(a) !== normLevel(b))
    names.push("thoughtLevel");
  if (a.prompt !== b.prompt)
    names.push("prompt");
  if (a.shape !== b.shape)
    names.push("shape");
  if (JSON.stringify(normalizedPermission(a)) !== JSON.stringify(normalizedPermission(b)))
    names.push("permission");
  return names;
}
var GROUP_FIELDS = {
  pin: ["mode", "model", "thoughtLevel"],
  prompt: ["prompt"],
  shape: ["shape"],
  permission: ["permission"]
};
var ALL_GROUPS = Object.keys(GROUP_FIELDS);
function rebaseGroupsOf(names) {
  const s = new Set(names);
  return ALL_GROUPS.filter((g) => GROUP_FIELDS[g].some((f) => s.has(f)));
}
function groupValue(d, g) {
  switch (g) {
    case "pin":
      return JSON.stringify([d.mode, d.mode === "pinned" ? d.model : undefined, d.mode === "pinned" ? d.thoughtLevel : undefined]);
    case "prompt":
      return JSON.stringify(d.prompt ?? null);
    case "shape":
      return JSON.stringify(d.shape ?? null);
    case "permission":
      return JSON.stringify(normalizedPermission(d) ?? null);
  }
}
function rebaseUpdateDraft(pending, freshDef) {
  const base = pending.original;
  if (base === null)
    return { rebased: pending.draft, conflicts: [], touched: [] };
  const fresh = draftOfLoaded(freshDef);
  const touched = [...new Set([...pending.touchedGroups ?? [], ...rebaseGroupsOf(changedFieldNames(pending.draft, base))])];
  const external = rebaseGroupsOf(changedFieldNames(fresh, base));
  const conflicts = external.filter((g) => touched.includes(g) && groupValue(fresh, g) !== groupValue(pending.draft, g));
  const rebased = { ...pending.draft };
  for (const g of ALL_GROUPS) {
    if (touched.includes(g))
      continue;
    for (const f of GROUP_FIELDS[g]) {
      const value = fresh[f];
      if (value === undefined)
        delete rebased[f];
      else
        rebased[f] = value;
    }
  }
  if (rebased.mode === "auto") {
    delete rebased.model;
    delete rebased.thoughtLevel;
  }
  if (rebased.mode === "pinned" && (rebased.model === undefined || rebased.thoughtLevel === undefined) && !conflicts.includes("pin")) {
    conflicts.push("pin");
  }
  return { rebased, conflicts, touched };
}
function levelVerdictAfterModelChange(draft, catalog) {
  if (draft.mode !== "pinned" || !draft.model || !draft.thoughtLevel || !draft.model.includes("/"))
    return null;
  const [providerID, modelID] = splitModelId(draft.model);
  const verdict = levelSupportFor(catalog.lookup(providerID, modelID), draft.thoughtLevel);
  return verdict.supported ? { needsReconfirmation: false, note: `"${draft.thoughtLevel}" is an observed variant of ${draft.model}` } : { needsReconfirmation: true, note: verdict.note };
}
function splitModelId(model) {
  const i = model.indexOf("/");
  return i === -1 ? [model, ""] : [model.slice(0, i), model.slice(i + 1)];
}
function isNoOp(pending) {
  if (pending.op === "delete")
    return false;
  if (pending.original === null)
    return false;
  return draftsEqual(pending.draft, pending.original);
}

// src/host-guard.ts
function forgeServerEnablement(rows, forgeId = "forge") {
  if (!Array.isArray(rows)) {
    return { state: "unverifiable", reason: `plugin registry observation failed: expected an array of rows, got ${rows === null ? "null" : typeof rows}` };
  }
  const mine = rows.filter((r) => r !== null && typeof r === "object" && r.id === forgeId);
  if (mine.length === 0)
    return { state: "absent" };
  if (mine.length > 1)
    return { state: "unverifiable", reason: `${mine.length} registry rows carry id "${forgeId}" — enablement is ambiguous` };
  const row = mine[0];
  if (row.features?.server !== true) {
    return { state: "unverifiable", reason: `registry row for "${forgeId}" does not report features.server=true — the server part is not observable` };
  }
  const status = row.state?.status;
  if (status === "active")
    return { state: "active-observed" };
  if (status === "failed")
    return { state: "failed", error: typeof row.state?.error === "string" ? row.state.error : undefined };
  return { state: "unverifiable", reason: `registry row for "${forgeId}" reports status ${JSON.stringify(status ?? null)} — cannot verify an active server plugin` };
}
var LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
var OPENCODE_EXECUTABLES = new Set(["opencode", "opencode.exe"]);
var OPENCODE_WRAPPER_ENTRIES = new Set(["opencode", "opencode.exe", "opencode.js", "opencode.mjs", "opencode.cjs"]);
var WRAPPER_EXECUTABLES = new Set(["node", "deno", "bun", "bunx", "npx"]);
var RUN_SUBCOMMAND_WRAPPERS = new Set(["bun"]);

// src/tui/guard.ts
function enablementOf(rows, forgeId) {
  return forgeServerEnablement(rows, forgeId);
}
function echoVerdictOf(nonce, out, expected) {
  if (out === null || typeof out !== "object")
    return { provable: false, reason: "echo returned no payload" };
  const rec = out;
  if (rec.nonce !== nonce)
    return { provable: false, reason: "echo nonce mismatch — the transport answer is not from this request" };
  if (typeof rec.pluginID !== "string" || rec.pluginID === "")
    return { provable: false, reason: "echo payload carries no pluginID" };
  if (typeof rec.epoch !== "string" || rec.epoch === "" || typeof rec.generation !== "number" || !Number.isFinite(rec.generation)) {
    return { provable: false, reason: "echo payload carries no epoch/generation binding" };
  }
  if (expected !== undefined && (rec.epoch !== expected.epoch || rec.generation !== expected.generation)) {
    return {
      provable: false,
      reason: `server epoch/registration changed since this editor session opened (was ${expected.epoch}#${expected.generation}, now ${rec.epoch}#${rec.generation}) — in-flight previews are dropped and a fresh editor session is required`
    };
  }
  return { provable: true, epoch: rec.epoch, generation: rec.generation, pluginID: rec.pluginID, appVersion: typeof rec.appVersion === "string" ? rec.appVersion : "unknown" };
}
var SAFE_ERROR_TEXT_LIMIT = 200;
function maskSecrets(text) {
  return text.replace(/(authorization\s*[=:]\s*)[^\n]*/gi, "$1[masked]").replace(/\b(basic|bearer|token)(\s+)\S+/gi, "$1$2[masked]").replace(/(token|api[-_]?key|secret|password|credential)(\s*[=:]\s*)\S+/gi, "$1$2[masked]").replace(/eyJ[A-Za-z0-9._-]{10,}/g, "[masked-jwt]");
}
function disclosedText(value) {
  let text;
  if (typeof value === "string")
    text = value;
  else if (typeof value === "number" || typeof value === "bigint")
    text = String(value);
  else
    return;
  const masked = maskSecrets(text);
  return masked.length > SAFE_ERROR_TEXT_LIMIT ? `${masked.slice(0, SAFE_ERROR_TEXT_LIMIT)}…` : masked;
}
function readField(source, key) {
  try {
    return source[key];
  } catch {
    return;
  }
}
function boundedOnce(text) {
  return text.length > SAFE_ERROR_TEXT_LIMIT ? `${text.slice(0, SAFE_ERROR_TEXT_LIMIT)}…` : text;
}
function safeErrorText(err) {
  if (typeof err === "string") {
    const masked = maskSecrets(err);
    return masked.length > SAFE_ERROR_TEXT_LIMIT ? `${masked.slice(0, SAFE_ERROR_TEXT_LIMIT)}…` : masked;
  }
  if (err === null || err === undefined || typeof err !== "object") {
    return disclosedText(err) ?? "no error detail was provided";
  }
  const message = disclosedText(readField(err, "message"));
  const parts = [];
  const code = disclosedText(readField(err, "code"));
  if (code !== undefined && code !== "")
    parts.push(`code ${code}`);
  const type = disclosedText(readField(err, "type"));
  if (type !== undefined && type !== "")
    parts.push(`type ${type}`);
  const tag = disclosedText(readField(err, "_tag"));
  if (tag !== undefined && tag !== "")
    parts.push(`tag ${tag}`);
  let out;
  if (message !== undefined && message !== "") {
    out = parts.length > 0 ? `${parts.join(", ")}: ${message}` : message;
  } else if (parts.length > 0) {
    out = parts.join(", ");
  } else {
    out = "an unrecognized error object was received (no disclosable message/code) — see the server-side Forge log for the actual failure";
  }
  return boundedOnce(out);
}
function anchorableStartupScope(scope) {
  if (scope === null || scope === undefined)
    return false;
  if (scope.kind !== "home" && scope.kind !== "session")
    return false;
  if (scope.kind === "home") {
    if (scope.sessionID !== null)
      return false;
  } else {
    if (typeof scope.sessionID !== "string" || scope.sessionID.trim() === "")
      return false;
  }
  return typeof scope.anchor === "string" && scope.anchor.trim() !== "";
}

// src/tui/flow.ts
var SEARCH_OPTION_VALUE = "__search__";
var NEW_WORKER_VALUE = "__new-worker__";
var NEW_OVERRIDE_VALUE = "__new-override__";
var CREATE_POOL_VALUE = "__create-pool__";
var SAVE_VALUE = "__save__";
var DISCARD_VALUE = "__discard__";
var SWITCH_VALUE = "__switch__";
var RELOAD_VALUE = "__reload__";
var RETRY_SYNC_VALUE = "__retry-sync__";
var RECEIPT_DETAIL_VALUE = "__receipt-detail__";
var SYNC_DETAIL_VALUE = "__sync-detail__";
var SOURCE_DETAIL_VALUE = "__source-detail__";
var SAVE_DETAIL_VALUE = "__save-detail__";
var DELETE_OPTION_VALUE = "__delete-entry__";
var PREVIEW_NEXT_VALUE = "__preview-next__";
var PREVIEW_PREV_VALUE = "__preview-prev__";
var PREVIEW_CONFIRM_VALUE = "__preview-confirm__";
var PREVIEW_CANCEL_VALUE = "__preview-cancel__";
var CUSTOM_LEVEL_VALUE = "__custom-level__";
var MANUAL_MODEL_VALUE = "__manual-model__";
var PERMISSION_KEY_CHOICES = ["shell", "execute", "question", "grep", "glob", ...MUTATING_TOOLS];
var PERMISSION_EFFECTS = ["allow", "ask", "deny"];
function forcedDenyKeys() {
  return ["task", "subagent", ...PRIMARY_ONLY_WORKER_TOOLS];
}
function createForgeConfigEditor(deps) {
  const state = {
    sessionID: null,
    anchorHint: null,
    view: "workspace",
    doc: null,
    workspaceHasPool: false,
    pending: [],
    pendingPool: null,
    catalog: catalogUnknown,
    lastSaveFailed: false,
    pendingSyncOutstanding: false,
    savedReceipt: null,
    lastReceipt: null,
    lastSyncResult: null,
    lastSaveDetail: null,
    listQuery: "",
    listCurrent: null,
    token: null
  };
  const ui = deps.ui;
  const rpc = deps.rpc;
  let connectionRevision = 0;
  const inform = (message, variant = "info", title = "Forge: Configure subagents") => {
    try {
      ui.toast({ title, message, variant, duration: 6000 });
    } catch {}
  };
  function findingsLines(view) {
    const lines = [];
    if (view.parseError !== null)
      lines.push(`UNPARSEABLE/UNREADABLE — ${view.parseError}`);
    for (const f of view.findings)
      lines.push(`${f.level}: ${f.message}`);
    return lines;
  }
  function catalogFindingLines() {
    return state.catalog.findings.slice(0, 4).map((f) => `catalog: ${f}`);
  }
  async function currentSession() {
    try {
      return await deps.sessionScope();
    } catch (err) {
      return { sessionID: null, anchor: null, kind: "unknown", reason: `session scope read failed: ${safeErrorText(err)}` };
    }
  }
  async function reverifySession() {
    const sc = await currentSession();
    if (sc.kind === "unknown") {
      return { ok: false, message: `the authoritative session scope is unavailable (${sc.reason ?? "unknown kind"}) — refusing against a possibly-stale scope` };
    }
    const S0 = deps.initialScope;
    if (!anchorableStartupScope(S0)) {
      return { ok: false, message: "the bound startup scope is missing or invalid (wiring defect) — refusing against a possibly-stale scope" };
    }
    const same = sc.kind === S0.kind && sc.sessionID === S0.sessionID && sc.anchor === S0.anchor;
    if (!same) {
      return { ok: false, message: `the scope changed since the editor opened (bound ${S0.kind}/${S0.sessionID ?? "home"} @ ${S0.anchor ?? "no anchor"} → now ${sc.kind}/${sc.sessionID ?? "home"} @ ${sc.anchor ?? "no anchor"}) — reopen /forge-config to re-resolve the scope (the saved receipt is never re-bound)` };
    }
    return { ok: true };
  }
  function docLabel(doc) {
    const created = doc.exists ? "" : doc.creatable ? " (absent — explicit creation required)" : " (absent — the server did not resolve a creation target)";
    return `${doc.path}${created}`;
  }
  let lastOpenFailureLine = null;
  async function openDocument(scope, opts) {
    const fail = (line) => {
      lastOpenFailureLine = line;
      if (opts?.quietFailure !== true)
        inform(line, "error");
    };
    const bound = await reverifySession();
    if (!bound.ok) {
      state.doc = null;
      state.token = null;
      fail(`Edit open refused — ${bound.message}.`);
      return false;
    }
    let out;
    try {
      out = await rpc.editOpen({ scope, sessionID: state.sessionID });
    } catch (err) {
      state.doc = null;
      state.token = null;
      fail(`The server document is unavailable (RPC editOpen failed: ${safeErrorText(err)}) — no document was bound and no save or sync is initiated. The transport or server Forge may be down; retry /forge-config later.`);
      return false;
    }
    if (!out.ok) {
      state.doc = null;
      state.token = null;
      fail(`The server cannot resolve this target — ${safeErrorText({ code: out.reason, message: out.message })} — no document, no writes, no syncs.`);
      return false;
    }
    const settled = await reverifySession();
    if (!settled.ok) {
      state.doc = null;
      state.token = null;
      fail(`Open discarded — ${settled.message} The editOpen response arrived after the scope changed and was thrown away unbound; reopen /forge-config to re-resolve the scope.`);
      return false;
    }
    const binding = editOpenBindingVerdictOf({ scope, sessionID: state.sessionID }, deps.initialScope, out);
    if (!binding.ok) {
      state.doc = null;
      state.token = null;
      fail(`Open discarded — the editOpen answer does not belong to this request/binding: ${binding.message} Nothing was bound; reopen /forge-config to re-resolve.`);
      return false;
    }
    if (scope === "workspace" && !out.exists && !out.creatable) {
      state.doc = null;
      state.token = null;
      fail(`Open refused — the server resolved the workspace pool at ${disclosedDir(out.path)} but reports it absent and NOT creatable (conflicting resolution; possibly an older server). Reload from the list once the file settles; nothing was bound.`);
      return false;
    }
    state.doc = {
      snapshotId: out.snapshotId,
      path: out.path,
      targetIdentity: out.targetIdentity,
      scope: out.scope,
      sessionID: out.sessionID,
      observedLocation: out.observedLocation,
      anchor: out.anchor,
      epoch: out.epoch,
      generation: out.generation,
      expiresAt: out.expiresAt,
      exists: out.exists,
      readable: out.readable,
      creatable: out.creatable,
      identityLabel: formatIdentity(out.identity),
      view: documentViewOf(out)
    };
    state.token = null;
    if (scope === "workspace")
      state.workspaceHasPool = out.exists;
    return true;
  }
  function formatIdentity(identity) {
    if (identity === null)
      return "no file identity (absent)";
    const parts = [`mtime ${identity.mtimeMs}`, `size ${identity.size}`];
    if (identity.dev !== undefined)
      parts.push(`dev ${identity.dev}`);
    if (identity.ino !== undefined)
      parts.push(`ino ${identity.ino}`);
    return parts.join(", ");
  }
  async function loadCatalog() {
    const loc = state.anchorHint ? { directory: state.anchorHint } : deps.data.location.default();
    try {
      await Promise.all([deps.data.location.provider.sync(loc), deps.data.location.model.sync(loc)]);
      state.catalog = catalogFromRows(deps.data.location.model.list(loc));
    } catch {
      state.catalog = catalogUnknown;
    }
  }
  async function scopeList() {
    for (;; ) {
      const outcome = await runListLoop();
      if (outcome === "quit")
        return;
    }
  }
  function entryViewOfDraft(p) {
    return {
      id: p.id,
      kind: p.kind,
      mode: p.draft.mode,
      def: p.draft.mode === "pinned" ? { model: p.draft.model, thoughtLevel: p.draft.thoughtLevel, prompt: p.draft.prompt, shape: p.draft.shape, permission: p.draft.permission } : { prompt: p.draft.prompt, shape: p.draft.shape, permission: p.draft.permission },
      rawModel: p.draft.model,
      rawLevel: p.draft.thoughtLevel,
      findings: [],
      promptPresent: p.draft.prompt !== undefined,
      shape: p.draft.shape,
      permissionKeys: p.draft.permission ? Object.keys(p.draft.permission) : []
    };
  }
  function entriesForView(view) {
    const base = state.view === "global" ? [...view.workers, ...view.overrides] : [...view.workers];
    const rows = [];
    const overlaid = new Set;
    for (const e of base) {
      const p = state.pending.find((q) => q.kind === e.kind && q.id === e.id);
      if (p === undefined) {
        rows.push(e);
        continue;
      }
      overlaid.add(`${p.kind}:${p.id}`);
      if (p.op === "delete")
        rows.push({ ...e, pending: "delete" });
      else if (p.op === "update")
        rows.push({ ...entryViewOfDraft(p), pending: "update", findings: e.findings });
      else
        rows.push({ ...entryViewOfDraft(p), pending: "create-conflict", findings: e.findings });
    }
    for (const p of state.pending) {
      if (state.view === "workspace" && p.kind === "override")
        continue;
      if (overlaid.has(`${p.kind}:${p.id}`))
        continue;
      if (p.op === "delete")
        continue;
      rows.push({ ...entryViewOfDraft(p), pending: p.op === "create" ? "create" : "update-missing" });
    }
    return rows;
  }
  function existingIdsOf(kind) {
    const view = state.doc?.view;
    const ids = kind === "worker" ? view?.workers.map((e) => e.id) ?? [] : view?.overrides.map((e) => e.id) ?? [];
    for (const p of state.pending)
      if (p.op === "create" && p.kind === kind)
        ids.push(p.id);
    return ids;
  }
  function draftFindingsText(pending) {
    const v = validateDraft(pending, existingIdsOf(pending.kind).filter((id) => !(pending.op === "create" && id === pending.id)));
    if (!v.ok)
      return v.findings.filter((f) => f.level === "error").map((f) => f.message).join("; ");
    const warns = v.findings.filter((f) => f.level === "warn");
    return warns.length > 0 ? warns.map((f) => f.message).join("; ") : "";
  }
  function validateDraft(pending, existingIds) {
    if (pending.op === "delete")
      return { ok: true, findings: [], normalizedId: pending.id };
    if (pending.kind === "override")
      return validateOverrideDraft(pending.id, pending.draft);
    const ids = pending.op === "create" ? existingIds : [];
    return validateWorkerDraft(pending.id, pending.draft, ids);
  }
  function shortSourceLabel(doc) {
    if (doc.scope === "workspace")
      return doc.exists ? "effective source" : "no pool — global fallback effective";
    return state.workspaceHasPool ? "fallback-only (not effective)" : "effective source (machine-wide)";
  }
  async function runListLoop() {
    for (;; ) {
      const doc = state.doc;
      const view = doc?.view ?? null;
      const entries = view !== null ? entriesForView(view) : [];
      const problem = view !== null ? findingsLines(view) : ["no server document is open — reload or switch scope"];
      const missingPool = doc !== null && doc.scope === "workspace" && !doc.exists;
      const needsPool = missingPool && state.pendingPool === null;
      const poolPending = missingPool && state.pendingPool !== null;
      const title = [
        state.view === "workspace" ? "Workspace workers" : "Global workers & overrides",
        doc !== null ? `(${shortSourceLabel(doc)})` : "",
        poolPending ? "(pool declaration pending save)" : "",
        state.pending.length > 0 ? `— ${state.pending.length} pending change(s)` : ""
      ].join(" ");
      const query = state.listQuery;
      const filtered = query ? entries.filter((e) => matchesEntry(query, e)) : entries;
      const options = entryListOptions(filtered, "", [
        { title: "Reload from server", value: RELOAD_VALUE, description: "fresh editOpen snapshot for this scope (drafts kept)", category: "List" },
        ...doc !== null ? [{ title: "Source / file details…", value: SOURCE_DETAIL_VALUE, description: "exact path, scope, anchor, server-issued target identity, snapshot binding", category: "List" }] : [],
        ...doc !== null && needsPool && doc.creatable ? [{ title: "Create a workspace pool file…", value: CREATE_POOL_VALUE, description: "stops the global fallback for this workspace (explicit, warned, pool name required)", category: "Create" }] : [],
        ...state.view === "global" ? [{ title: "New global override…", value: NEW_OVERRIDE_VALUE, description: "activate a general/explore override in the global recipe", category: "Create" }] : [],
        { title: "New worker…", value: NEW_WORKER_VALUE, description: state.view === "global" ? "worker in the GLOBAL fallback recipe" : poolPending ? "worker in the declared (pending) workspace pool" : needsPool ? "requires creating the workspace pool first" : "worker in the workspace pool", category: "Create" },
        ...entries.length > 0 ? [{ title: "Delete an entry…", value: DELETE_OPTION_VALUE, description: "pick the entry to delete (same deletion as the CtrlD shortcut)", category: "Delete" }] : [],
        { title: query ? `Search: "${query}" — change query…` : "Search entries…", value: SEARCH_OPTION_VALUE, description: `${filtered.length} of ${entries.length} shown`, category: "List" },
        { title: "Switch scope / source", value: SWITCH_VALUE, description: state.view === "workspace" ? "switch to the global view (the search and selection start fresh there)" : "switch to the workspace view (the search and selection start fresh there)", category: "List" },
        ...state.pending.length > 0 ? [
          { title: `${state.lastSaveFailed ? "Retry Save & Sync" : "Save & Sync"}`, value: SAVE_VALUE, description: "server prepare → preview → your explicit confirm → single-use commit; the confirmation enumerates every included entry", category: "Save" },
          { title: "Discard pending changes", value: DISCARD_VALUE, description: "drop all drafts without writing", category: "Save" }
        ] : [],
        ...state.savedReceipt !== null && state.pendingSyncOutstanding ? [{ title: "Retry sync (saved recipe)", value: RETRY_SYNC_VALUE, description: "server re-reads the CURRENT recipe — the saved patch is never replayed", category: "Save" }] : [],
        ...state.lastReceipt !== null ? [{ title: `Last save receipt detail (${state.lastReceipt.entries.length} entries)…`, value: RECEIPT_DETAIL_VALUE, description: "browse EVERY entry — id · action · honest outcome · summary (the toast is never the only detail)", category: "Receipt" }] : [],
        ...state.lastSyncResult !== null ? [{ title: `${state.lastSyncResult.ok ? "Last sync result" : "Last sync result (FAILED/UNCONFIRMED)"}…`, value: SYNC_DETAIL_VALUE, description: "the COMPLETE sync outcome — every error, conflict and note, never a truncated slice", category: "Receipt" }] : [],
        ...state.lastSaveDetail !== null ? [{ title: `${state.lastSaveDetail.title}…`, value: SAVE_DETAIL_VALUE, description: "the COMPLETE save/rebase outcome — every note, refusal (with its findings), drop and warning, never a truncated slice", category: "Receipt" }] : []
      ]);
      const action = { target: null, consumed: false };
      const picked = await ui.select({
        title: problem.length > 0 ? `${title} — FINDINGS: ${problem.length} item(s) (see Source / file details)` : title,
        ...state.listCurrent !== null ? { current: state.listCurrent } : {},
        options,
        actions: [
          {
            bind: "ctrl+d",
            title: "Delete",
            onTrigger: async (value) => {
              const parsed2 = typeof value === "string" ? parseEntryValue(value) : null;
              if (parsed2 === null)
                return;
              action.target = parsed2;
              action.consumed = false;
              await Promise.resolve();
              if (action.target !== parsed2 || action.consumed)
                return;
              try {
                ui.clear();
              } catch {
                action.consumed = true;
                if (state.doc !== doc)
                  return;
                await deleteFlow(parsed2.kind, parsed2.id);
              }
            }
          }
        ]
      });
      if (state.doc !== doc)
        continue;
      if (action.target !== null && !action.consumed) {
        const target = action.target;
        action.target = null;
        await deleteFlow(target.kind, target.id);
        continue;
      }
      if (picked === undefined) {
        if (state.pending.length > 0 || state.pendingPool !== null) {
          const stay = await ui.confirm({
            title: "Discard pending changes?",
            message: `${state.pending.length} pending change(s)${state.pendingPool !== null ? " and the pending pool declaration" : ""} are not saved. Closing now discards them.`,
            label: { confirm: "Discard", cancel: "Stay" }
          });
          if (stay !== true)
            continue;
          state.pending = [];
          state.pendingPool = null;
        }
        return "quit";
      }
      if (picked === SEARCH_OPTION_VALUE) {
        const q = await ui.prompt({ title: "Search entries (id / model / prompt text)", placeholder: state.listQuery });
        if (q !== undefined)
          state.listQuery = q.trim();
        continue;
      }
      if (picked === RELOAD_VALUE) {
        await freshOpenAndRebase();
        continue;
      }
      if (picked === CREATE_POOL_VALUE) {
        await createPoolFlow();
        continue;
      }
      if (picked === NEW_WORKER_VALUE) {
        if (doc !== null && needsPool)
          inform("Create the workspace pool file first — a worker entry needs its owning file.", "warning");
        else
          await newWorkerFlow();
        continue;
      }
      if (picked === NEW_OVERRIDE_VALUE) {
        await newOverrideFlow();
        continue;
      }
      if (picked === SWITCH_VALUE) {
        if (!await guardPendingOnSwitch())
          continue;
        const next = state.view === "workspace" ? "global" : "workspace";
        const opened = await openDocument(next);
        if (opened) {
          state.view = next;
          state.listQuery = "";
          state.listCurrent = null;
        }
        continue;
      }
      if (picked === SAVE_VALUE) {
        await saveFlow();
        continue;
      }
      if (picked === DISCARD_VALUE) {
        const sure = await ui.confirm({ title: "Discard pending changes?", message: `${state.pending.length} pending change(s)${state.pendingPool !== null ? " and the pending pool declaration" : ""} will be dropped without writing.`, label: { confirm: "Discard", cancel: "Keep" } });
        if (sure === true) {
          state.pending = [];
          state.pendingPool = null;
        }
        continue;
      }
      if (picked === RETRY_SYNC_VALUE) {
        await syncRetryFlow();
        continue;
      }
      if (picked === RECEIPT_DETAIL_VALUE) {
        const receipt = state.lastReceipt;
        if (receipt !== null) {
          await pagedEntryBrowser(receipt.entries.map((e) => ({
            badge: entryOutcomeLabel(e),
            action: e.action,
            kind: e.kind,
            id: e.id,
            summary: [
              ...e.summary,
              ...e.reason !== undefined && e.reason !== "" ? [`reason: ${e.reason}`] : [],
              ...e.findings.map((f) => `${f.level}: ${f.message}`)
            ]
          })), `Save receipt — per-entry outcomes (${receipt.outcome})${receipt.message ? ` — ${receipt.message}` : ""}`, null);
        }
        continue;
      }
      if (picked === SYNC_DETAIL_VALUE) {
        const sync = state.lastSyncResult;
        if (sync !== null)
          await pagedDetailBrowser(sync.title, sync.lines);
        continue;
      }
      if (picked === SAVE_DETAIL_VALUE) {
        const detail = state.lastSaveDetail;
        if (detail !== null)
          await pagedDetailBrowser(detail.title, detail.lines);
        continue;
      }
      if (picked === SOURCE_DETAIL_VALUE) {
        if (doc !== null)
          await pagedDetailBrowser("Source / file details", sourceDetailLines(doc));
        continue;
      }
      if (picked === DELETE_OPTION_VALUE) {
        if (entries.length === 0)
          continue;
        const victim = await ui.select({ title: "Delete which entry?", options: entryListOptions(entries, "", []) });
        const parsed2 = typeof victim === "string" ? parseEntryValue(victim) : null;
        if (parsed2 !== null)
          await deleteFlow(parsed2.kind, parsed2.id);
        continue;
      }
      const parsed = parseEntryValue(picked);
      if (parsed === null)
        continue;
      state.listCurrent = picked;
      const entry = entries.find((e) => e.kind === parsed.kind && e.id === parsed.id);
      if (entry === undefined)
        continue;
      if (doc !== null && needsPool && parsed.kind === "worker" && state.pendingPool === null) {
        const go = await ui.confirm({
          title: "This entry lives in the global recipe",
          message: `${entry.id} is a global fallback worker — the workspace has no pool file. Edit it in the Global view (its owning file)?`,
          label: { confirm: "Open Global view", cancel: "Back" }
        });
        if (go === true) {
          if (await guardPendingOnSwitch()) {
            const opened = await openDocument("global");
            if (opened) {
              state.view = "global";
              state.listQuery = "";
              state.listCurrent = null;
            }
          }
        }
        continue;
      }
      await entryMenu(parsed.kind, parsed.id, entry);
    }
  }
  function matchesEntry(query, e) {
    const q = query.trim().toLowerCase();
    if (!q)
      return true;
    return [e.id, e.rawModel, e.def?.prompt].some((t) => typeof t === "string" && t.toLowerCase().includes(q));
  }
  async function guardPendingOnSwitch() {
    if (state.pending.length === 0 && state.pendingPool === null)
      return true;
    const discard = await ui.confirm({ title: "Discard pending changes?", message: `${state.pending.length} pending change(s)${state.pendingPool !== null ? " and the pending pool declaration" : ""} target the current source. Switching scope discards them.`, label: { confirm: "Discard", cancel: "Stay" } });
    if (discard !== true)
      return false;
    state.pending = [];
    state.pendingPool = null;
    return true;
  }
  async function pickLevel(model, currentLevel) {
    const catalogModel = model && model.includes("/") ? state.catalog.lookup(...splitModelId(model)) : undefined;
    if (state.catalog.known === false)
      inform("The host model catalog is unavailable — level support cannot be verified; choices are labelled unverified.", "warning");
    for (;; ) {
      const options = levelOptions(catalogModel, CUSTOM_LEVEL_VALUE);
      const current = currentLevel !== undefined ? { title: `Keep current: ${currentLevel}`, value: `keep:${currentLevel}`, description: "preserve the existing raw value", category: "Current" } : undefined;
      const picked = await ui.select({ title: `Reasoning level${model ? ` for ${model}` : ""}${catalogModel ? "" : " (target model absent from catalog — unverified)"}`, options: current ? [current, ...options] : options });
      if (picked === undefined)
        return;
      if (picked === CUSTOM_LEVEL_VALUE) {
        const custom = await ui.prompt({ title: "Custom reasoning level (canonical: none|low|medium|high|max, or a native level name)", placeholder: currentLevel ?? "e.g. ultrathought" });
        if (custom === undefined || custom.trim() === "")
          continue;
        return custom.trim().toLowerCase();
      }
      if (picked.startsWith("keep:"))
        return currentLevel;
      if (picked.startsWith("level:")) {
        return picked.slice("level:".length);
      }
    }
  }
  async function pickModelAndLevel(draft) {
    let model;
    if (state.catalog.known && state.catalog.models.length > 0) {
      for (;; ) {
        const providerId = await ui.select({ title: "Provider (observed catalog)", options: providerOptions(state.catalog.models, { manualEntryValue: MANUAL_MODEL_VALUE }) });
        if (providerId === undefined)
          return null;
        if (providerId === MANUAL_MODEL_VALUE)
          break;
        const pid = providerId.slice("provider:".length);
        const picked = await ui.select({ title: `Model by ${pid}`, options: modelOptions(state.catalog.models, pid) });
        if (picked === undefined)
          continue;
        model = `${pid}/${picked.slice("model:".length)}`;
        break;
      }
    }
    if (model === undefined) {
      for (;; ) {
        const manual = await ui.prompt({ title: 'Exact provider/model identity (e.g. "glm/glm-5.3")', placeholder: "provider/model" });
        if (manual === undefined)
          return null;
        const trimmed = manual.trim();
        if (trimmed.includes("/") && !trimmed.startsWith("/") && !trimmed.endsWith("/")) {
          model = trimmed;
          if (state.catalog.lookup(...splitModelId(model)) === undefined) {
            inform(`${model} is absent from the observed catalog — preserved as an unverified identity.`, "warning");
          }
          break;
        }
        inform('Identity must look like "provider/model".', "warning");
      }
    }
    const previous = draft.mode === "pinned" ? draft.thoughtLevel : undefined;
    const level = await pickLevel(model, previous);
    if (level === undefined)
      return null;
    return { ...draft, mode: "pinned", model, thoughtLevel: level };
  }
  async function pickInitialMode(draft) {
    const modePicked = await ui.select({
      title: "Model mode (Auto/Pinned is an atomic pair)",
      options: [
        { title: "Auto — inherit the parent session's model", value: "auto", description: "removes BOTH model and thoughtLevel" },
        { title: "Pinned — exact provider/model + reasoning level", value: "pinned", description: state.catalog.known ? `${state.catalog.models.length} model(s) observed — availability unverified` : "catalog unavailable — manual identity only, unverified" }
      ]
    });
    if (modePicked === undefined)
      return null;
    if (modePicked === "auto")
      return { ...draft, mode: "auto", model: undefined, thoughtLevel: undefined };
    return pickModelAndLevel(draft);
  }
  async function editPromptFlow(pending) {
    const current = pending.draft.prompt;
    const picked = await ui.select({
      title: `Prompt ${current ? `(current: ${current.length} chars)` : "(not set)"}`,
      options: [
        { title: current !== undefined ? "Replace prompt" : "Set prompt", value: "replace", description: "opens a text prompt (empty input cancels)" },
        ...current !== undefined ? [{ title: "Remove prompt", value: "remove", description: "deletes the prompt member on save" }] : []
      ]
    });
    if (picked === undefined)
      return;
    if (picked === "remove") {
      pending.draft = { ...pending.draft, prompt: undefined };
      return;
    }
    const text = await ui.prompt({ title: `Role prompt for "${pending.id}" (multi-line supported; empty cancels)`, placeholder: current ? "new prompt text" : "role prompt text" });
    if (text === undefined || text.trim() === "")
      return;
    pending.draft = { ...pending.draft, prompt: text };
  }
  async function editShapeFlow(pending) {
    const picked = await ui.select({
      title: `Shape for "${pending.id}"`,
      options: [
        { title: "write (default)", value: "write", description: pending.draft.shape === undefined ? "no explicit shape member" : "sets shape: write" },
        { title: "readonly", value: "readonly", description: "write-family + execute denies at compile time" },
        ...pending.draft.shape !== undefined ? [{ title: "Clear explicit shape", value: "clear", description: "removes the member (default write applies)" }] : []
      ]
    });
    if (picked === undefined)
      return;
    pending.draft = { ...pending.draft, shape: picked === "clear" ? undefined : picked };
  }
  async function editPermissionFlow(pending) {
    for (;; ) {
      const perm = pending.draft.permission ?? {};
      const keyOptions = Object.entries(perm).map(([k, v]) => ({
        title: `${k}: ${v}`,
        value: `key:${k}`,
        description: forcedDenyKeys().includes(k) ? "forced deny by the compiler — editing here cannot lift it" : "select to change or remove",
        category: "Current overrides"
      }));
      const picked = await ui.select({
        title: `Permissions for "${pending.id}" (tool → effect)`,
        options: [
          ...keyOptions,
          { title: "Add permission key…", value: "add", description: `curated: ${PERMISSION_KEY_CHOICES.join(", ")} — or any custom tool name`, category: "Actions" },
          ...Object.keys(perm).length > 0 ? [{ title: "Clear all explicit permissions", value: "clear", description: "removes the member; mandatory worker restrictions still apply at compile time", category: "Actions" }] : []
        ]
      });
      if (picked === undefined)
        return;
      if (picked === "clear") {
        pending.draft = { ...pending.draft, permission: undefined };
        continue;
      }
      if (picked === "add") {
        const keyPicked = await ui.select({
          title: "Tool name",
          options: [
            ...PERMISSION_KEY_CHOICES.map((k) => ({ title: k, value: `k:${k}`, category: "Curated vocabulary" })),
            { title: "Custom tool name…", value: "k:__custom__", description: "any tool name the host exposes", category: "Other" }
          ]
        });
        if (keyPicked === undefined)
          continue;
        let key2 = keyPicked.slice(2);
        if (key2 === "__custom__") {
          const custom = await ui.prompt({ title: "Custom tool name", placeholder: "tool name" });
          if (custom === undefined || custom.trim() === "")
            continue;
          key2 = custom.trim();
        }
        const effectPicked = await ui.select({ title: `Effect for "${key2}"`, options: PERMISSION_EFFECTS.map((e) => ({ title: e, value: e })) });
        if (effectPicked === undefined)
          continue;
        pending.draft = { ...pending.draft, permission: { ...perm, [key2]: effectPicked } };
        continue;
      }
      const key = picked.slice("key:".length);
      const action = await ui.select({
        title: `Permission "${key}"`,
        options: [
          ...PERMISSION_EFFECTS.map((e) => ({ title: `Set ${e}`, value: `set:${e}`, description: perm[key] === e ? "current value" : undefined })),
          { title: "Remove this key", value: "remove", description: "deletes the member on save" }
        ]
      });
      if (action === undefined)
        continue;
      if (action === "remove") {
        const next = { ...perm };
        delete next[key];
        pending.draft = { ...pending.draft, permission: Object.keys(next).length > 0 ? next : undefined };
      } else {
        pending.draft = { ...pending.draft, permission: { ...perm, [key]: action.slice(4) } };
      }
    }
  }
  async function entryMenu(kind, id, entry) {
    const existing = pendingFor(kind, id);
    if (existing !== undefined && existing.op === "delete") {
      inform(`"${id}" already has a pending deletion (save to apply).`, "info");
      return;
    }
    const pending = detachPending(existing ?? {
      kind,
      op: "update",
      id,
      draft: draftOfLoaded(entry.def),
      original: draftOfLoaded(entry.def)
    });
    const publishWorking = () => {
      upsertPending(detachPending(pending));
    };
    const revisionAtOpen = connectionRevision;
    const pendingListAtOpen = state.pending;
    const docAtOpen = state.doc;
    const staleAfterAwait = () => connectionRevision !== revisionAtOpen || state.pending !== pendingListAtOpen || state.doc !== docAtOpen;
    const staleExit = () => {
      inform("The server document or pending list changed while this entry editor was open — every edit was held on a detached copy and NOTHING was published. Re-open the entry from the list to edit the current values.", "warning");
    };
    for (;; ) {
      const d = pending.draft;
      const findingsText = draftFindingsText(pending);
      const pendingNow = pendingFor(kind, id);
      const liveMode = pendingNow !== undefined ? d.mode === "pinned" ? "pinned" : "auto" : entry.mode;
      const liveTitle = entryTitle({ ...entry, mode: liveMode, pending: pendingNow !== undefined ? entry.pending ?? "update" : undefined });
      const picked = await ui.select({
        title: `${liveTitle}${findingsText ? " — DRAFT findings present (disclosed at save)" : ""}`,
        options: [
          ...d.mode === "pinned" ? [
            { title: "Model…", value: "model", description: "direct change — the mode STAYS Pinned, only the level is revalidated", footer: `current: ${d.model ?? "?"} @ ${d.thoughtLevel ?? "?"}` },
            { title: "Level…", value: "level", description: "change it ALONE — the model identity is unchanged", footer: `current level: ${d.thoughtLevel ?? "?"}` },
            { title: "Mode: Auto/Pinned…", value: "mode", description: "choosing Auto removes BOTH model and thoughtLevel", footer: "current: Pinned" }
          ] : [
            { title: "Mode: Auto/Pinned…", value: "mode", description: `choosing Pinned opens the provider/model/level pin chain${entry.mode === "half-configured" ? " — saving a valid draft repairs the half-configured pair" : ""}`, footer: `current: ${pendingNow !== undefined ? entry.mode === "half-configured" ? "Auto (repairs the half-configured pair)" : "Auto" : entry.mode === "half-configured" ? "INVALID (half-configured pair)" : entry.mode === "invalid" ? "INVALID" : "Auto"}` }
          ],
          { title: "Prompt…", value: "prompt", description: d.prompt ? "replace or remove the role prompt" : "set a role prompt", footer: d.prompt ? `current: ${d.prompt.length} chars` : "current: not set" },
          { title: "Shape…", value: "shape", description: "write (default) / readonly", footer: `current: ${d.shape ?? "write (default)"}` },
          { title: "Permissions…", value: "perm", description: "explicit tool → effect overrides", footer: d.permission && Object.keys(d.permission).length > 0 ? `current: ${Object.entries(d.permission).map(([k, v]) => `${k}:${v}`).join(", ")}` : "current: none explicit" },
          { title: "Save & Sync…", value: "save", description: state.pending.length > 0 ? "prepare the CURRENT pending batch — every included entry is enumerated on the confirmation page before anything is written" : "no pending changes yet — a save now would be a no-op" },
          { title: "Back (draft kept)", value: "back", description: "changes stay pending until Save & Sync" }
        ]
      });
      if (picked === undefined || picked === "back")
        return;
      if (picked === "model" && d.mode === "pinned") {
        const next = await pickModelAndLevel(pending.draft);
        if (staleAfterAwait())
          return staleExit();
        if (next !== null) {
          const carriedUnchanged = pending.draft.mode === "pinned" && next.mode === "pinned" && next.thoughtLevel === pending.draft.thoughtLevel && next.model !== pending.draft.model;
          if (carriedUnchanged) {
            const verdict = levelVerdictAfterModelChange(next, state.catalog);
            if (verdict !== null && verdict.needsReconfirmation) {
              const keep = await ui.confirm({ title: "Level needs revalidation", message: `${verdict.note}

Keep this level (labelled unverified) or pick again?`, label: { confirm: "Keep unverified level", cancel: "Pick again" } });
              if (staleAfterAwait())
                return staleExit();
              if (keep !== true)
                continue;
            }
          }
          pending.draft = next;
          publishWorking();
        }
        continue;
      }
      if (picked === "level" && d.mode === "pinned") {
        const level = await pickLevel(d.model, d.thoughtLevel);
        if (staleAfterAwait())
          return staleExit();
        if (level !== undefined && level !== d.thoughtLevel) {
          pending.draft = { ...pending.draft, thoughtLevel: level };
          publishWorking();
        }
        continue;
      }
      if (picked === "mode") {
        const choice = await ui.select({
          title: "Mode (Auto/Pinned is an atomic pair)",
          options: [
            { title: `Auto${d.mode === "auto" ? " (current)" : ""}`, value: "auto", description: "removes BOTH model and thoughtLevel" },
            { title: `Pinned${d.mode === "pinned" ? " (current)" : ""}`, value: "pinned", description: state.catalog.known ? "exact provider/model + reasoning level" : "catalog unavailable — manual identity only, unverified" }
          ]
        });
        if (staleAfterAwait())
          return staleExit();
        if (choice === undefined || choice === d.mode)
          continue;
        if (choice === "auto") {
          pending.draft = { ...pending.draft, mode: "auto", model: undefined, thoughtLevel: undefined };
          publishWorking();
          continue;
        }
        const next = await pickModelAndLevel(pending.draft);
        if (staleAfterAwait())
          return staleExit();
        if (next !== null) {
          pending.draft = next;
          publishWorking();
        }
        continue;
      }
      if (picked === "prompt") {
        await editPromptFlow(pending);
        if (staleAfterAwait())
          return staleExit();
        publishWorking();
        continue;
      }
      if (picked === "shape") {
        await editShapeFlow(pending);
        if (staleAfterAwait())
          return staleExit();
        publishWorking();
        continue;
      }
      if (picked === "perm") {
        await editPermissionFlow(pending);
        if (staleAfterAwait())
          return staleExit();
        publishWorking();
        continue;
      }
      if (picked === "save") {
        await saveFlow();
        return;
      }
    }
  }
  function pendingFor(kind, id) {
    return state.pending.find((p) => p.kind === kind && p.id === id);
  }
  function detachPending(p) {
    return {
      ...p,
      draft: {
        ...p.draft,
        ...p.draft.permission !== undefined ? { permission: { ...p.draft.permission } } : {}
      },
      original: p.original === null ? null : { ...p.original },
      touchedGroups: p.touchedGroups !== undefined ? [...p.touchedGroups] : undefined
    };
  }
  function upsertPending(pending) {
    if (pending.op === "update" && pending.original !== null) {
      pending.touchedGroups = [
        ...new Set([...pending.touchedGroups ?? [], ...rebaseGroupsOf(changedFieldNames(pending.draft, pending.original))])
      ];
    }
    const i = state.pending.findIndex((p) => p.kind === pending.kind && p.id === pending.id);
    if (isNoOp(pending)) {
      if (i >= 0)
        state.pending.splice(i, 1);
      return;
    }
    if (i >= 0)
      state.pending[i] = pending;
    else
      state.pending.push(pending);
  }
  async function newWorkerFlow() {
    let id;
    for (;; ) {
      const raw = await ui.prompt({ title: "Worker id ([a-z0-9-]; the forge- prefix is stripped automatically)", placeholder: "e.g. coder" });
      if (raw === undefined)
        return;
      const normalized = normalizeWorkerId(raw.trim());
      id = normalized.id;
      if (existingIdsOf("worker").includes(id)) {
        inform(`"${id}" collides with an existing worker (ids that normalize to the same word collide) — the save plan will REFUSE this draft; siblings still apply.`, "warning");
      }
      if (normalized.findings.length > 0)
        inform(normalized.findings.map((f) => f.message).join(" · "), "warning");
      break;
    }
    if (id === undefined)
      return;
    const pending = { kind: "worker", op: "create", id, draft: { mode: "auto" }, original: null };
    const next = await pickInitialMode(pending.draft);
    if (next === null)
      return;
    pending.draft = next;
    upsertPending(pending);
    inform(`"${id}" is a pending draft — Save & Sync writes it (a workspace creation replaces the global fallback for this roster).`, "info");
  }
  async function newOverrideFlow() {
    const picked = await ui.select({
      title: "Override which built-in? (global recipe, machine-wide)",
      options: [
        { title: "general", value: "general", description: "General-purpose built-in subagent" },
        { title: "explore", value: "explore", description: "Explore built-in subagent" }
      ]
    });
    if (picked === undefined)
      return;
    if (existingIdsOf("override").includes(picked)) {
      inform(`override.${picked} already exists — edit it from the list instead.`, "warning");
      return;
    }
    const pending = { kind: "override", op: "create", id: picked, draft: { mode: "auto" }, original: null };
    const next = await pickInitialMode(pending.draft);
    if (next === null)
      return;
    pending.draft = next;
    upsertPending(pending);
    inform(`override.${picked} activation is pending — Save & Sync activates ONLY this built-in; others keep their behavior.`, "info");
  }
  async function createPoolFlow() {
    const doc = state.doc;
    if (doc === null || doc.scope !== "workspace" || doc.exists || !doc.creatable)
      return;
    const confirmed = await ui.confirm({
      title: "Create a workspace pool file?",
      message: [
        `New file (on the connected server): ${doc.path}`,
        `Server-issued target identity: ${doc.targetIdentity}`,
        "Effect: this workspace stops using the global fallback — its roster becomes exactly this file (global workers no longer apply here).",
        "The file requires a valid declared pool name ([a-z0-9-], 1-24 chars).",
        "Nothing is written until you confirm Save & Sync with the server preview."
      ].join(`
`),
      label: { confirm: "Continue", cancel: "Cancel" }
    });
    if (confirmed !== true)
      return;
    for (;; ) {
      const suggested = sanitizeSuggestion(state.anchorHint ?? doc.path);
      const raw = await ui.prompt({ title: "Declared pool name ([a-z0-9-], 1-24 chars)", placeholder: suggested });
      if (raw === undefined)
        return;
      const check = validatePoolField(raw.trim());
      if (check.ok) {
        state.pendingPool = check.ns;
        inform(`Pool "${check.ns}" will be declared when the file is created on Save & Sync.`, "info");
        return;
      }
      inform(`"${raw.trim()}" is not a valid pool name ([a-z0-9-], 1-24 chars after trim).`, "warning");
    }
  }
  async function deleteFlow(kind, id) {
    const view = state.doc?.view;
    const entry = view !== undefined ? [...view.workers, ...view.overrides].find((e) => e.kind === kind && e.id === id) : undefined;
    if (entry === undefined) {
      const pendingCreate = state.pending.find((p) => p.kind === kind && p.id === id && p.op === "create");
      if (pendingCreate === undefined) {
        inform(`"${id}" is not in the current source.`, "warning");
        return;
      }
      const drop = await ui.confirm({ title: `Discard the pending creation of "${id}"?`, message: "Nothing has been written yet — this drops the unsaved draft.", label: { confirm: "Discard draft", cancel: "Keep" } });
      if (drop !== true)
        return;
      state.pending = state.pending.filter((p) => p !== pendingCreate);
      state.lastSaveFailed = false;
      inform(`Pending creation of "${id}" discarded.`, "info");
      return;
    }
    const existingIndex = state.pending.findIndex((p) => p.kind === kind && p.id === id);
    const confirmed = await ui.confirm({
      title: kind === "override" ? `Remove override.${id}?` : `Delete worker "${id}"?`,
      message: kind === "override" ? `Removes override.${id} from ${state.doc?.path ?? "the recipe"} — the built-in ${id} behavior returns machine-wide.
Confirming removes only this recipe entry on explicit Save & Sync.` : `Deletes ${id} from ${state.doc?.path ?? "the recipe"}.
Confirming removes only this recipe entry on explicit Save & Sync (its generated projection is garbage-collected by the server family sync).`,
      label: { confirm: kind === "override" ? "Remove override" : "Delete", cancel: "Cancel" }
    });
    if (confirmed !== true)
      return;
    if (existingIndex >= 0)
      state.pending.splice(existingIndex, 1);
    state.pending.push({ kind, op: "delete", id, draft: { mode: "auto" }, original: draftOfLoaded(entry.def) });
    state.lastSaveFailed = false;
    inform(`Deletion of "${id}" is pending — Save & Sync applies it.`, "info");
  }
  function opOf(pending) {
    const op = {
      opId: `${pending.kind}:${pending.op}:${pending.id}`,
      action: pending.op,
      kind: pending.kind,
      id: pending.id
    };
    if (pending.op !== "delete")
      op.draft = pending.draft;
    if (state.view === "workspace" && state.pendingPool !== null && pending.kind === "worker")
      op.pool = state.pendingPool;
    return op;
  }
  async function saveFlow() {
    if (state.pending.length === 0) {
      inform("No pending changes — nothing to save (zero writes).", "info");
      return;
    }
    if (state.doc === null) {
      inform("No server document is open — reload from the list first.", "error");
      return;
    }
    const sessionCheck = await reverifySession();
    if (!sessionCheck.ok) {
      inform(`Save refused — ${sessionCheck.message}`, "error");
      return;
    }
    const ops = state.pending.map(opOf);
    const revisionAtPrepare = connectionRevision;
    let out;
    try {
      out = await rpc.prepare({ snapshotId: state.doc.snapshotId, scope: state.doc.scope, sessionID: state.sessionID, ops });
    } catch (err) {
      state.lastSaveFailed = true;
      inform(`Prepare failed (RPC transport: ${safeErrorText(err)}) — zero writes. Drafts kept; if the connection broke, the next Save & Sync prepares fresh.`, "error");
      return;
    }
    if (!out.ok) {
      state.lastSaveFailed = true;
      if (out.reason === "conflict-reload") {
        const reload = await ui.confirm({
          title: "The file changed since the editor opened",
          message: `${out.message}

The server refused so your edit is not silently swallowed. Reload the document now? (Drafts are kept and re-checked against the fresh snapshot.)`,
          label: { confirm: "Reload", cancel: "Keep editing" }
        });
        if (reload === true) {
          await freshOpenAndRebase();
        }
        return;
      }
      const findings = (out.findings ?? []).map((f) => `${f.level}: ${f.message}`).join(`
`);
      inform(`Prepare refused (${out.reason}): ${out.message}${findings ? `
${findings}` : ""}
Drafts kept${["snapshot-unknown", "snapshot-expired", "epoch-stale"].includes(out.reason) ? " — use Reload from server for a fresh snapshot" : ""}.`, "error");
      return;
    }
    if (out.outcome === "no-op") {
      state.token = null;
      const matchedCount = ops.length - out.rejected.length;
      const matchedWording = matchedCount > 0 ? `${matchedCount} draft(s) already match the saved recipe` : "no draft matches — every one was refused by validation";
      const lines = [
        `Recipe prepare resolved to NO effective changes — ZERO WRITES: ${matchedWording}. The recipe file was not written; the sync/projection leg never ran.`,
        ...out.summary.map((l) => `note: ${l}`),
        ...out.rejected.flatMap((r) => [
          `REFUSED (kept pending): ${r.id} — ${r.message}`,
          ...r.reason !== "" ? [`    reason: ${r.reason}`] : [],
          ...r.findings.map((f) => `    ${f.level}: ${f.message}`)
        ]),
        ...out.findings.map((f) => `${f.level}: ${f.message}`),
        "The pending drafts are KEPT — drop them explicitly via 'Discard pending changes'."
      ];
      state.lastSaveDetail = { title: "Last save attempt — prepare no-op (zero writes)", lines };
      inform([
        `No effective changes — zero writes: ${matchedCount} draft(s) match the saved recipe, ${out.rejected.length} refused (nothing was written; the sync leg never ran).`,
        `${out.summary.length} note(s) — full detail under "Last save attempt detail". The pending drafts are KEPT.`,
        ...out.rejected.length > 0 ? [`RISK: ${out.rejected.length} entr(ies) REFUSED (kept pending) — their findings are in the detail view`] : []
      ].join(`
`), out.rejected.length > 0 ? "warning" : "info");
      return;
    }
    state.token = {
      token: out.token.token,
      expiresAt: out.token.expiresAt,
      epoch: out.token.epoch,
      generation: out.token.generation,
      preview: {
        path: out.preview.path,
        targetIdentity: out.preview.targetIdentity,
        scope: out.preview.scope,
        sessionID: out.preview.sessionID,
        oldText: out.preview.oldText,
        newText: out.preview.newText,
        createFile: out.preview.createFile,
        entries: out.preview.entries.map((e) => ({ opId: e.opId, id: e.id, kind: e.kind, action: e.action, summary: e.summary })),
        rejected: out.preview.rejected
      }
    };
    const proceed = await confirmPreview(state.token);
    if (proceed !== true) {
      state.token = null;
      inform("Cancelled — nothing was written (the prepared preview was dropped).", "info");
      return;
    }
    if (connectionRevision !== revisionAtPrepare) {
      state.token = null;
      state.lastSaveFailed = true;
      inform(`The server connection changed while the preview was open (revision ${connectionRevision}) — the prepared preview and token are VOID; nothing was committed. A fresh document/preview/confirmation is required; drafts are kept and rebased onto the fresh open.`, "error");
      await freshOpenAndRebase();
      return;
    }
    await commitFlow();
  }
  async function pagedEntryBrowser(rows, listTitle, confirmTitle) {
    const perPage = 10;
    const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
    const visited = new Set;
    let page = 0;
    for (;; ) {
      visited.add(page);
      const start = page * perPage;
      const slice = rows.slice(start, start + perPage);
      const pick = await ui.select({
        title: `${listTitle} — page ${page + 1} of ${pageCount} (entries ${start + 1}-${start + slice.length} of ${rows.length})`,
        options: [
          ...slice.map((r, i) => ({
            title: `${r.badge !== undefined ? `${r.badge}: ` : ""}${r.action} ${r.kind} "${r.id}"`,
            description: r.summary.length > 0 ? r.summary.join(" · ") : "(no per-entry detail lines)",
            value: `entry:${start + i}`,
            category: "Entry"
          })),
          ...page + 1 < pageCount ? [{ title: "Next page", value: PREVIEW_NEXT_VALUE, description: `entries ${start + perPage + 1}-${Math.min(start + perPage * 2, rows.length)}`, category: "Review" }] : [],
          ...page > 0 ? [{ title: "Previous page", value: PREVIEW_PREV_VALUE, category: "Review" }] : [],
          ...confirmTitle !== null && visited.size >= pageCount ? [{ title: confirmTitle, value: PREVIEW_CONFIRM_VALUE, category: "Review" }] : [],
          { title: confirmTitle === null ? "Close" : "Cancel — nothing is written", value: PREVIEW_CANCEL_VALUE, category: "Review" }
        ]
      });
      if (pick === PREVIEW_CANCEL_VALUE || pick === undefined)
        return "cancel";
      if (pick === PREVIEW_CONFIRM_VALUE)
        return "confirm";
      if (pick === PREVIEW_NEXT_VALUE) {
        page = Math.min(page + 1, pageCount - 1);
        continue;
      }
      if (pick === PREVIEW_PREV_VALUE) {
        page = Math.max(page - 1, 0);
        continue;
      }
      const row = rows[Number(String(pick).slice("entry:".length))];
      if (row !== undefined) {
        inform([`${row.action} ${row.kind} "${row.id}"${row.badge !== undefined ? ` — ${row.badge}` : ""}`, ...row.summary.map((l) => `    ${l}`)].join(`
`), "info");
      }
    }
  }
  async function pagedDetailBrowser(title, lines) {
    const perPage = 10;
    const pageCount = Math.max(1, Math.ceil(lines.length / perPage));
    let page = 0;
    for (;; ) {
      const start = page * perPage;
      const slice = lines.slice(start, start + perPage);
      const pick = await ui.select({
        title: `${title} — page ${page + 1} of ${pageCount}`,
        options: [
          ...slice.map((l, i) => ({
            title: l.length > 80 ? `${l.slice(0, 77)}…` : l,
            value: `line:${start + i}`,
            footer: l,
            ...l.length > 80 ? { description: `${l.length} chars — select to view the full line` } : {},
            category: "Detail"
          })),
          ...page + 1 < pageCount ? [{ title: "Next page", value: PREVIEW_NEXT_VALUE, description: `lines ${start + perPage + 1}-${Math.min(start + perPage * 2, lines.length)}`, category: "Review" }] : [],
          ...page > 0 ? [{ title: "Previous page", value: PREVIEW_PREV_VALUE, category: "Review" }] : [],
          { title: "Close", value: PREVIEW_CANCEL_VALUE, category: "Review" }
        ]
      });
      if (pick === PREVIEW_CANCEL_VALUE || pick === undefined)
        return;
      if (pick === PREVIEW_NEXT_VALUE) {
        page = Math.min(page + 1, pageCount - 1);
        continue;
      }
      if (pick === PREVIEW_PREV_VALUE) {
        page = Math.max(page - 1, 0);
        continue;
      }
      const index = Number(String(pick).slice("line:".length));
      const line = lines[index];
      if (line !== undefined)
        inform(line, "info", `${title} — line ${index + 1} (full)`);
    }
  }
  function sourceDetailLines(doc) {
    const findings = findingsLines(doc.view);
    return [
      `path: ${doc.path}`,
      `scope: ${doc.scope === "global" ? "global (machine-wide)" : "workspace"} · sessionID: ${doc.sessionID ?? "null (home)"}`,
      `observed location: ${doc.observedLocation ?? "(none)"}`,
      `anchor: ${doc.anchor ?? "(none)"}`,
      `server-issued target identity: ${doc.targetIdentity}`,
      `snapshot binding: epoch ${doc.epoch} · generation ${doc.generation} · expiresAt ${new Date(doc.expiresAt).toISOString()}`,
      `file: ${doc.exists ? "exists" : "absent"} · readable: ${doc.readable ? "yes" : "no"} · creatable: ${doc.creatable ? "yes" : "no"}`,
      `identity: ${doc.identityLabel}`,
      `pending changes: ${state.pending.length}${state.pendingPool !== null ? ` · pending pool declaration: ${state.pendingPool}` : ""}`,
      ...findings.length > 0 ? [`findings: ${findings.length} item(s) — full text below`, ...findings] : []
    ];
  }
  async function confirmPreview(prepared) {
    const p = prepared.preview;
    let pagedThrough = false;
    if (p.entries.length > 10) {
      const verdict = await pagedEntryBrowser(p.entries.map((e) => ({ action: e.action, kind: e.kind, id: e.id, summary: e.summary })), "Review preview", `All ${p.entries.length} entries reviewed — go to confirmation`);
      if (verdict !== "confirm")
        return false;
      pagedThrough = true;
    }
    const entryLines = pagedThrough ? [`All ${p.entries.length} change(s) were reviewed page-by-page above.`] : p.entries.flatMap((e) => [`• ${e.action} ${e.kind} "${e.id}":`, ...e.summary.slice(0, 6).map((l) => `    ${l}`)]);
    const summaryLines = [
      `File: ${p.path}`,
      `Scope: ${p.scope === "global" ? "global (machine-wide)" : `workspace (sessionID ${p.sessionID === null ? "null — home scope of the server-observed location" : p.sessionID})`}`,
      `Server-issued target identity: ${p.targetIdentity}`,
      "TARGET: the CONNECTED SERVER's filesystem — this editor never writes local files.",
      ...p.createFile ? ["NEW FILE will be created."] : [],
      ...entryLines,
      diffSummary(p.oldText, p.newText),
      ...p.rejected.map((r) => `REFUSED — NOT included (${r.id}): ${r.message}`),
      ...state.doc?.view.findings.slice(0, 4).map((f) => `${f.level}: ${f.message}`) ?? [],
      ...catalogFindingLines()
    ];
    return await ui.confirm({
      title: `Save & Sync ${p.entries.length} change(s)${p.rejected.length > 0 ? `, ${p.rejected.length} refused` : ""} to the connected server?`,
      message: summaryLines.join(`
`) || "no effective changes",
      label: { confirm: "Save & Sync", cancel: "Cancel" }
    }) === true;
  }
  async function commitFlow() {
    const prepared = state.token;
    if (prepared === null)
      return;
    const doc = state.doc;
    if (doc === null) {
      state.token = null;
      return;
    }
    const revisionAtCommit = connectionRevision;
    const nonce = randomUUID();
    let verdict;
    try {
      verdict = echoVerdictOf(nonce, await rpc.echo({ nonce }), { epoch: prepared.epoch, generation: prepared.generation });
    } catch (err) {
      verdict = { provable: false, reason: `echo failed (RPC transport: ${safeErrorText(err)})` };
    }
    if (!verdict.provable) {
      state.token = null;
      state.lastSaveFailed = true;
      inform(`Commit refused — ${verdict.reason}
Drafts kept. The next Save & Sync prepares a fresh preview for explicit confirmation.`, "error");
      return;
    }
    const sessionCheck = await reverifySession();
    if (!sessionCheck.ok) {
      state.token = null;
      state.lastSaveFailed = true;
      inform(`Commit refused — ${sessionCheck.message}`, "error");
      return;
    }
    if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
      state.token = null;
      state.lastSaveFailed = true;
      inform(`The server connection changed while the commit was being verified (revision ${connectionRevision}) — the prepared token is VOID; NOTHING was committed. A fresh document/preview/confirmation is required; drafts are kept.`, "error");
      await freshOpenAndRebase();
      return;
    }
    let out;
    try {
      out = await rpc.commit({ token: prepared.token, confirm: true, scope: doc.scope, sessionID: state.sessionID });
    } catch {
      if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
        state.token = null;
        state.lastSaveFailed = true;
        inform(`The server connection changed while the commit was in flight (revision ${connectionRevision}) — the commit outcome is UNADJUDICATED: no receipt lookup, no receipt consumption. Drafts stay pending; a fresh document is open; the next Save & Sync prepares fresh.`, "warning");
        await freshOpenAndRebase();
        return;
      }
      let receipt = null;
      try {
        const r = await rpc.receipt({ token: prepared.token });
        if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
          state.token = null;
          state.lastSaveFailed = true;
          inform(`The server connection changed while the commit receipt was being looked up (revision ${connectionRevision}) — the commit outcome stays UNKNOWN: the old receipt is not consumed, no sync starts. Drafts stay pending; a fresh document is open.`, "warning");
          await freshOpenAndRebase();
          return;
        }
        if (r.found)
          receipt = r.receipt;
      } catch {
        if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
          state.token = null;
          state.lastSaveFailed = true;
          inform(`The server connection changed while the commit receipt lookup failed (revision ${connectionRevision}) — the commit outcome stays UNKNOWN: the old receipt is not consumed, no sync starts. Drafts stay pending; a fresh document is open.`, "warning");
          await freshOpenAndRebase();
          return;
        }
        receipt = null;
      }
      state.token = null;
      if (receipt !== null) {
        await receiptFlow(receipt);
        return;
      }
      state.lastSaveFailed = true;
      const reopened = await freshOpenAndRebase();
      inform([
        "Commit outcome UNKNOWN (response lost, no receipt found) — nothing is replayed.",
        reopened === "ok" ? "A fresh server document is open (new snapshot/epoch); the drafts were rebased onto it and kept — Save & Sync prepares a NEW preview for explicit confirmation." : reopened === "rebase-cancelled" ? "The fresh document opened, but the draft rebase was CANCELLED (Esc) — no decision was recorded, the snapshot binding was released, the drafts are unchanged. Use 'Reload from server' to re-answer the rebase prompts; Save & Sync is refused until a document is open." : "The fresh document open failed too — use 'Reload from server' once the connection recovers; the drafts are kept."
      ].join(`
`), "error");
      return;
    }
    if (connectionRevision !== revisionAtCommit || state.token !== prepared) {
      state.token = null;
      state.lastSaveFailed = true;
      inform(`The server connection changed while the commit was in flight (revision ${connectionRevision}) — the commit outcome is UNADJUDICATED: the returned receipt is not consumed. Drafts stay pending; a fresh document is open; the next Save & Sync prepares fresh.`, "warning");
      await freshOpenAndRebase();
      return;
    }
    state.token = null;
    if (!out.ok) {
      state.lastSaveFailed = true;
      inform(`Commit refused (${out.reason}): ${out.message}
Drafts kept — the next Save & Sync prepares fresh.`, "error");
      return;
    }
    await receiptFlow(out.receipt);
  }
  function shortReceiptSummary(receipt, pendingLeft, refusedStillPendingCount) {
    const written = receipt.entries.filter((e) => e.outcome === "written").length;
    const unchanged = receipt.entries.filter((e) => e.outcome === "no-op").length;
    const refused = receipt.entries.filter((e) => e.outcome === "rejected").length;
    const lines = [
      receipt.outcome === "no-op" ? `no-op: zero writes — the file already matches (${unchanged} unchanged, ${refused} refused)` : `saved: ${written} change(s) → ${receipt.path} (${receipt.bytes} bytes, commit ${receipt.commitId.slice(0, 8)})`
    ];
    if (refused > 0) {
      const line = refusedAccountLine(refused, refusedStillPendingCount ?? refused);
      if (line !== null)
        lines.push(line);
    }
    if (unchanged > 0 && receipt.outcome !== "no-op")
      lines.push(`${unchanged} entr(ies) unchanged`);
    if (receipt.entries.length > 0 && receipt.entries.some((e) => e.outcome !== "written" && e.outcome !== "no-op" && e.outcome !== "rejected"))
      lines.push("RISK: some entries have no explicit server verdict (kept pending)");
    if (receipt.entries.length === 0)
      lines.push("the receipt carried no per-entry outcomes — every draft stays pending");
    if (pendingLeft > 0)
      lines.push(`${pendingLeft} draft(s) remain pending`);
    return lines;
  }
  function refusedAccountLine(total, stillPending) {
    if (total <= 0)
      return null;
    if (stillPending >= total)
      return `RISK: this save REFUSED ${total} entr(ies) — all still pending (findings under "Last save receipt detail")`;
    if (stillPending > 0)
      return `RISK: this save REFUSED ${total} entr(ies) — ${stillPending} still pending, ${total - stillPending} since dropped (findings under "Last save receipt detail")`;
    return `this save REFUSED ${total} entr(ies) — all since dropped from the pending list (details under "Last save receipt detail")`;
  }
  async function receiptFlow(receipt) {
    state.lastReceipt = receipt;
    if (receipt.outcome === "no-op") {
      state.pending = consumeReceiptEntries(receipt);
      state.lastSaveFailed = state.pending.length > 0;
      inform([...shortReceiptSummary(receipt, state.pending.length), "use 'Discard pending changes' to drop drafts explicitly — a no-op never clears them"].join(`
`), state.lastSaveFailed ? "warning" : "info", "Forge: Save & Sync receipt");
      return;
    }
    if (receipt.outcome !== "written") {
      const conflictish = receipt.outcome === "conflict" || receipt.outcome === "ownership-lost";
      const lines = [conflictish ? `CONFLICT (nothing overwritten): ${receipt.message}` : `WRITE ERROR (prior bytes intact): ${receipt.message}`];
      if (["conflict", "ownership-lost", "unparseable"].includes(receipt.outcome))
        lines.push("Use 'Reload from server' for a fresh snapshot (drafts are kept).");
      state.lastSaveFailed = true;
      inform([...lines, `${state.pending.length} draft(s) remain pending — Save & Sync again to prepare against the current file.`].join(`
`), "error", "Forge: Save & Sync receipt");
      return;
    }
    state.pending = consumeReceiptEntries(receipt);
    state.pendingPool = null;
    state.savedReceipt = receipt;
    const rejected = receipt.entries.filter((e) => e.outcome === "rejected");
    const refusedIds = rejected.map((e) => ({ kind: e.kind, id: e.id }));
    const refusedStillPending = () => state.pending.filter((p) => refusedIds.some((r) => r.kind === p.kind && r.id === p.id)).length;
    const syncReport = summarizeSync(receipt.sync);
    state.pendingSyncOutstanding = syncReport === null || !syncReport.ok;
    if (syncReport !== null) {
      state.lastSaveFailed = rejected.length > 0 || !syncReport.ok;
      recordSyncResult(`Sync report (from save receipt) — ${syncReport.ok ? "ok" : "failed/unconfirmed"}`, syncReport.ok, syncReport.lines);
    } else {
      state.lastSaveFailed = true;
    }
    const refreshed = await freshOpenAndRebase({ quietOpenFailure: true, quietRebaseCancel: true });
    const refusedStill = refusedStillPending();
    const saveToastLines = (syncLine) => [
      ...shortReceiptSummary(receipt, state.pending.length, refusedStill),
      ...syncLine !== null ? [syncLine] : []
    ];
    if (refreshed === "ok") {
      if (syncReport !== null) {
        inform(saveToastLines(syncReport.ok ? "sync: executed (details under 'Last sync result')" : "sync: failed/unconfirmed — retry available").join(`
`), state.lastSaveFailed ? "warning" : "success", "Forge: Save & Sync receipt");
      } else {
        await runSyncLegs(receipt.scope, receipt.commitId, refusedIds);
      }
      return;
    }
    const syncLineText = syncReport !== null ? syncReport.ok ? "sync: executed (details under 'Last sync result')" : "sync: failed/unconfirmed — retry available" : null;
    const refusedLine = refusedAccountLine(rejected.length, refusedStill);
    const retryMention = state.pendingSyncOutstanding ? "; for the pending sync, 'Retry sync (saved recipe)'" : "";
    if (refreshed === "rebase-cancelled") {
      inform([
        ...syncLineText !== null ? saveToastLines(syncLineText) : [],
        `saved — the post-save draft rebase was CANCELLED (Esc): no decision was recorded, the drafts and baselines are unchanged, and the fresh snapshot binding was released. Nothing is replayed. Recovery: 'Reload from server' re-answers the rebase prompts${retryMention}.`,
        ...syncReport === null && refusedLine !== null ? [refusedLine] : []
      ].join(`
`), "warning", "Forge: Save & Sync receipt");
      return;
    }
    inform([
      ...lastOpenFailureLine !== null ? [lastOpenFailureLine] : ["The fresh open after the save failed — no document is bound."],
      ...syncLineText !== null ? saveToastLines(syncLineText) : [],
      `saved — the receipt stays valid and accessible ("Last save receipt detail"); nothing is replayed. Recovery: 'Reload from server'${state.pendingSyncOutstanding ? " or, for the pending sync, 'Retry sync (saved recipe)'" : ""}.`,
      ...syncReport === null && refusedLine !== null ? [refusedLine] : []
    ].join(`
`), "warning", "Forge: Save & Sync receipt");
  }
  function entryOutcomeLabel(e) {
    return e.outcome === "written" ? "written" : e.outcome === "no-op" ? "no-op (unchanged)" : "REFUSED";
  }
  function consumeReceiptEntries(receipt) {
    const stillPending = [];
    for (const p of state.pending) {
      const key = `${p.kind}:${p.op}:${p.id}`;
      const outcome = receipt.entries.find((e) => e.opId === key);
      if (outcome === undefined || outcome.outcome === "rejected")
        stillPending.push(p);
    }
    return stillPending;
  }
  function groupLabel(g) {
    return g === "pin" ? "model/level pin (Auto/Pinned pair)" : g === "prompt" ? "prompt" : g === "shape" ? "shape" : "permissions";
  }
  async function rebaseDraftsOnFreshDocument(opts) {
    const freshDoc = state.doc;
    if (freshDoc === null || state.pending.length === 0)
      return;
    const freshEntryOf = (kind, id) => (kind === "worker" ? freshDoc.view.workers : freshDoc.view.overrides).find((e) => e.id === id);
    const working = state.pending.map((p) => ({ ...p }));
    const kept = [];
    const droppedNotes = [];
    let dropped = 0;
    let adopted = 0;
    const cancelRebase = () => {
      state.doc = null;
      state.token = null;
      if (opts?.silentCancel === true)
        return;
      inform("Rebase CANCELLED (Esc) — no decision was recorded: the drafts, baselines and pending list are UNCHANGED and the fresh snapshot binding was released, so nothing pairs the old draft values with the fresh bytes. Use 'Reload from server' to re-open the document and answer the rebase prompts; Save & Sync is refused until a document is open.", "warning");
    };
    for (const p of working) {
      if (p.op === "create") {
        const duplicate = freshEntryOf(p.kind, p.id) !== undefined || working.some((q) => q !== p && q.op === "create" && q.kind === p.kind && q.id === p.id);
        if (!duplicate) {
          kept.push(p);
          continue;
        }
        const keep2 = await ui.confirm({
          title: `Your new "${p.id}" already exists in the fresh document`,
          message: `The fresh server document contains ${p.kind} "${p.id}" — saving your create draft would be refused as a duplicate. Keep the draft (it stays refused until resolved) or drop it?`,
          label: { confirm: "Keep draft", cancel: "Drop draft" }
        });
        if (keep2 === undefined)
          return cancelRebase();
        if (keep2 === true)
          kept.push(p);
        else {
          dropped++;
          droppedNotes.push(`Dropped create draft "${p.id}" — it duplicates the fresh document.`);
        }
        continue;
      }
      if (p.op === "delete") {
        const freshEntry2 = freshEntryOf(p.kind, p.id);
        if (freshEntry2 === undefined) {
          dropped++;
          droppedNotes.push(`Dropped delete draft "${p.id}" — the entry is already gone from the fresh document (nothing left to delete).`);
          continue;
        }
        const changedExternally = p.original !== null && changedFieldNames(draftOfLoaded(freshEntry2.def), p.original).length > 0;
        if (!changedExternally) {
          kept.push(p);
          continue;
        }
        const proceed = await ui.confirm({
          title: `"${p.id}" changed on the server`,
          message: `The entry you are deleting changed on the server since the editor opened. Deleting now discards those external changes too. Delete anyway, or drop this delete draft (it stays pending for re-review)?`,
          label: { confirm: "Delete anyway", cancel: "Drop draft" }
        });
        if (proceed === undefined)
          return cancelRebase();
        if (proceed === true)
          kept.push(p);
        else {
          dropped++;
          droppedNotes.push(`Dropped the delete draft for "${p.id}" — re-review it against the fresh values.`);
        }
        continue;
      }
      const freshEntry = freshEntryOf(p.kind, p.id);
      if (freshEntry === undefined) {
        const keep2 = await ui.confirm({
          title: `"${p.id}" is gone from the fresh document`,
          message: `The entry you edited no longer exists in the fresh server document — saving the edit would be refused. Keep the draft or drop it?`,
          label: { confirm: "Keep draft", cancel: "Drop draft" }
        });
        if (keep2 === undefined)
          return cancelRebase();
        if (keep2 === true)
          kept.push(p);
        else {
          dropped++;
          droppedNotes.push(`Dropped the edit draft for "${p.id}" — the entry vanished server-side.`);
        }
        continue;
      }
      const rebase = rebaseUpdateDraft(p, freshEntry.def);
      if (rebase.conflicts.length === 0) {
        if (changedFieldNames(rebase.rebased, p.draft).length > 0)
          adopted++;
        p.draft = rebase.rebased;
        p.original = draftOfLoaded(freshEntry.def);
        kept.push(p);
        continue;
      }
      const keep = await ui.confirm({
        title: `"${p.id}": the server changed fields you also edited`,
        message: `Externally changed on the server: ${rebase.conflicts.map(groupLabel).join(", ")}. Your edits touch the same part(s). Keep YOUR values for them (every part you did not touch adopts the fresh value; the Auto/Pinned pair moves as one unit) or drop this draft?`,
        label: { confirm: "Keep my edits", cancel: "Drop draft" }
      });
      if (keep === undefined)
        return cancelRebase();
      if (keep === true) {
        p.draft = rebase.rebased;
        p.original = draftOfLoaded(freshEntry.def);
        kept.push(p);
      } else {
        dropped++;
        droppedNotes.push(`Dropped the edit draft for "${p.id}" — re-edit it against the fresh values.`);
      }
    }
    state.pending = kept;
    if (dropped > 0 || adopted > 0) {
      state.lastSaveDetail = {
        title: `Last rebase — ${kept.length} kept, ${dropped} dropped`,
        lines: [...droppedNotes, `kept: ${kept.length} (${adopted} adopted external changes into untouched fields)`]
      };
      inform(`Drafts rebased onto the fresh document: ${kept.length} kept (${adopted} adopted external changes into untouched fields), ${dropped} dropped — per-item detail under "Last save attempt detail".`, "info");
    }
  }
  async function freshOpenAndRebase(opts) {
    lastOpenFailureLine = null;
    const opened = await openDocument(state.view, { quietFailure: opts?.quietOpenFailure === true });
    if (!opened)
      return "open-failed";
    if (state.pending.length > 0) {
      await rebaseDraftsOnFreshDocument({ silentCancel: opts?.quietRebaseCancel === true });
      if (state.doc === null)
        return "rebase-cancelled";
    }
    return "ok";
  }
  const READINESS_DEADLINE_MS = 1e4;
  const READINESS_POLL_MS = 500;
  const defaultSleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function")
      timer.unref();
  });
  const defaultSchedule = (ms, callback) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      callback();
    }, ms);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function")
      timer.unref();
    return () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
    };
  };
  async function registryReadiness(anchor) {
    const nowMs = deps.now ?? (() => performance.now());
    const sleep = deps.sleep ?? defaultSleep;
    const schedule = deps.schedule ?? defaultSchedule;
    const deadlineAt = nowMs() + READINESS_DEADLINE_MS;
    const gate = { cancel: null };
    let timedOut = false;
    const deadlineGate = new Promise((_, reject) => {
      gate.cancel = schedule(READINESS_DEADLINE_MS, () => {
        timedOut = true;
        reject(new Error(`registry readiness exceeded its ${READINESS_DEADLINE_MS}ms budget`));
      });
    });
    deadlineGate.catch(() => {});
    try {
      for (;; ) {
        if (timedOut || nowMs() >= deadlineAt) {
          inform(`The forge plugin row did not become active at the bound location within ${READINESS_DEADLINE_MS}ms — the editor stays closed: zero reads, zero writes, zero syncs. Reopen /forge-config once the server Forge is active.`, "error");
          return false;
        }
        let enablement;
        try {
          const res = await Promise.race([deps.client.plugin.list({ location: { directory: anchor } }), deadlineGate]);
          enablement = enablementOf(res?.data, deps.pluginId ?? "forge");
        } catch (err) {
          inform(`The registry readiness probe failed — the editor stays closed: zero reads, zero writes, zero syncs (${safeErrorText(err)}). Reopen /forge-config once the server Forge is active.`, "error");
          return false;
        }
        if (enablement.state === "active-observed") {
          if (timedOut || nowMs() >= deadlineAt) {
            inform(`The forge plugin row did not become active at the bound location within ${READINESS_DEADLINE_MS}ms — the editor stays closed: zero reads, zero writes, zero syncs. Reopen /forge-config once the server Forge is active.`, "error");
            return false;
          }
          return true;
        }
        if (enablement.state === "failed") {
          inform(`The server Forge row reports FAILED — the editor stays closed: zero reads, zero writes, zero syncs (${JSON.stringify(enablement)}). Reopen /forge-config once the server Forge is active.`, "error");
          return false;
        }
        const wait = Math.max(0, Math.min(READINESS_POLL_MS, deadlineAt - nowMs()));
        try {
          await Promise.race([sleep(wait), deadlineGate]);
        } catch (err) {
          inform(`The registry readiness window ended mid-poll — the editor stays closed: zero reads, zero writes, zero syncs (${safeErrorText(err)}). Reopen /forge-config once the server Forge is active.`, "error");
          return false;
        }
      }
    } finally {
      gate.cancel?.();
    }
  }
  function renderSyncApply(app) {
    const lines = [];
    lines.push(`sync: ${app.outcome}`);
    lines.push(`file: ${app.path}`);
    const roster = (label, refs) => `${label}: ${refs.length > 0 ? refs.map((r) => r.nativeId).join(", ") : "(none)"}`;
    lines.push(roster("created", app.created));
    lines.push(roster("updated", app.updated));
    lines.push(`unchanged: ${app.unchanged.length > 0 ? app.unchanged.join(", ") : "(none)"}`);
    lines.push(`gced: ${app.gced.length > 0 ? app.gced.join(", ") : "(none)"}`);
    lines.push(`removedIds: ${app.removedIds.length > 0 ? app.removedIds.join(", ") : "(none)"}`);
    for (const e of app.errors)
      lines.push(`error: ${e.message}${e.nativeId !== undefined ? ` (${e.nativeId})` : ""}`);
    for (const c of app.conflicts)
      lines.push(`conflict: ${c.message}${c.winnerFile !== undefined ? ` (winner: ${c.winnerFile})` : ""}`);
    lines.push(...app.summary.map((t) => `note: ${t}`));
    lines.push(...app.findings.map((f) => `${f.level}: ${f.message}`));
    const st = app.appliedStatus;
    const observedBy = st.observedBy !== null && st.observedBy !== "" ? st.observedBy : "no proven native-registry observation";
    lines.push(`application: ${st.status} (observed by: ${observedBy})`);
    if (st.confirmedIds.length > 0)
      lines.push(`confirmed ids: ${st.confirmedIds.join(", ")}`);
    if (st.unconfirmedIds.length > 0)
      lines.push(`unconfirmed ids: ${st.unconfirmedIds.join(", ")}`);
    if (st.removedConfirmedIds.length > 0)
      lines.push(`removals confirmed: ${st.removedConfirmedIds.join(", ")}`);
    if (app.outcome === "unconfirmed" || app.outcome === "conflict") {
      lines.push("The saved recipe is kept; the explicit host-wide /forge sync remains the separate reconciliation path when disclosed.");
    }
    const okStatus = app.outcome === "applied" && app.applied === true;
    const short = [
      `sync: ${app.outcome} — created ${app.created.length}, updated ${app.updated.length}, unchanged ${app.unchanged.length}, removed ${app.removedIds.length}${app.gced.length > 0 ? `, gc ${app.gced.length}` : ""}`,
      `application: ${st.status}${st.confirmedIds.length > 0 ? ` (${st.confirmedIds.length} confirmed)` : ""}`
    ];
    if (app.errors.length > 0)
      short.push(`RISK: ${app.errors.length} error(s)`);
    if (app.conflicts.length > 0)
      short.push(`RISK: ${app.conflicts.length} conflict(s)`);
    if (st.unconfirmedIds.length > 0)
      short.push(`RISK: ${st.unconfirmedIds.length} unconfirmed id(s)`);
    if (!okStatus && app.outcome !== "noop")
      short.push("retry available under 'Retry sync (saved recipe)'");
    return { okStatus, short, lines };
  }
  function recordSyncResult(title, ok, lines) {
    state.lastSyncResult = { title, ok, lines };
  }
  function syncFail(lines, variant = "error") {
    state.lastSaveFailed = true;
    state.pendingSyncOutstanding = true;
    recordSyncResult(`Sync ${variant === "info" ? "cancelled" : variant === "warning" ? "outcome unknown/unconfirmed" : "failed/refused"}`, false, lines);
    inform(lines.join(`
`), variant, "Forge: Sync receipt");
  }
  async function runSyncLegs(scope, commitId, refusedFromSave = []) {
    const refusedTotal = refusedFromSave.length;
    const refusedNoteNow = () => refusedAccountLine(refusedTotal, state.pending.filter((p) => refusedFromSave.some((r) => r.kind === p.kind && r.id === p.id)).length) ?? "";
    const failSync = (lines, variant = "error") => {
      syncFail(refusedTotal > 0 ? [...lines, refusedNoteNow()] : lines, variant);
    };
    if (commitId === "") {
      failSync(["Sync refused — no saved receipt commit to bind (the TUI sync always binds the original save receipt's commitId)."]);
      return;
    }
    const preCheck = await reverifySession();
    if (!preCheck.ok) {
      failSync([`Sync refused — ${preCheck.message}`]);
      return;
    }
    const revisionAtPrepare = connectionRevision;
    let prep;
    try {
      prep = await rpc.sync({ scope, sessionID: state.sessionID, confirm: false, action: "prepare", commitId });
    } catch (err) {
      failSync([`Sync prepare failed (RPC transport: ${safeErrorText(err)}) — the saved recipe is untouched; retry later.`]);
      return;
    }
    if (prep.ok !== true) {
      failSync([`Sync prepare refused (${prep.reason}): ${prep.message}`, "The saved recipe is kept; nothing was written."]);
      return;
    }
    if (prep.action !== "prepare") {
      failSync(["Sync prepare received an apply-shaped answer — projection state UNKNOWN.", "Retry sync to prepare against current content."], "warning");
      return;
    }
    if (prep.outcome === "noop") {
      state.lastSaveFailed = false;
      state.pendingSyncOutstanding = false;
      const noopFindings = dedupeFindings([...prep.findings, ...prep.preview.findings]);
      const lines = [
        "The recipe itself WAS saved (commit bound) — the native projection already matches it, so this sync leg made ZERO WRITES.",
        ...prep.preview.files.map((f) => `file: ${f.op} ${f.nativeId} → ${f.dest}`),
        ...prep.preview.summary.map((t) => `note: ${t}`),
        ...noopFindings.map((f) => `${f.level}: ${f.message}`),
        ...refusedTotal > 0 ? [refusedNoteNow()] : []
      ];
      recordSyncResult("Sync prepare: the projection already matches (noop)", true, lines);
      inform([
        "The native projection already matches the saved recipe — nothing to sync (zero writes). The recipe itself was saved.",
        `${prep.preview.files.length} projection file(s) unchanged${noopFindings.length > 0 ? `, RISK: ${noopFindings.length} finding(s)` : ""} — full detail under "Last sync result".`,
        ...refusedTotal > 0 ? [refusedNoteNow()] : []
      ].join(`
`), "info");
      return;
    }
    const preview = prep.preview;
    const tokenValue = prep.token.token;
    const changed = preview.files.filter((f) => f.op !== "unchanged");
    const unchangedCount = preview.files.length - changed.length;
    const reviewRows = [
      ...changed.map((f) => ({ action: f.op, kind: "projection file", id: f.nativeId, summary: [`→ ${f.dest}`] })),
      ...preview.gc.map((g) => ({ action: "gc", kind: "generated file", id: g.nativeId, summary: [`remove ${g.dest}`] })),
      ...preview.summary.map((t) => ({ action: "note", kind: "server summary", id: "", summary: [t] }))
    ];
    let pagedThrough = false;
    if (reviewRows.length > 10) {
      const verdict2 = await pagedEntryBrowser(reviewRows, "Sync projection preview — changed files & garbage collection", `All ${reviewRows.length} preview row(s) reviewed — go to confirmation`);
      if (verdict2 !== "confirm") {
        failSync(["Cancelled — the prepared sync was dropped; nothing was written. 'Retry sync (saved recipe)' prepares fresh against the current recipe."], "info");
        return;
      }
      pagedThrough = true;
    }
    const savedIdentity = state.savedReceipt?.targetIdentity;
    const go = await ui.confirm({
      title: "Apply the native projection for this family?",
      message: [
        `File: ${preview.path}`,
        `Scope: ${preview.scope === "global" ? "global (machine-wide)" : `workspace (sessionID ${preview.sessionID ?? "null"})`}`,
        `Observed location: ${preview.observedLocation ?? "(none)"} · anchor: ${preview.anchor ?? "(none)"}`,
        ...state.savedReceipt !== null ? [`already SAVED: ${state.savedReceipt.path} (commit ${state.savedReceipt.commitId.slice(0, 8)})${refusedTotal > 0 ? ` — ${refusedNoteNow()}` : ""} — this confirmation covers ONLY the generated native projection`] : [],
        ...savedIdentity !== undefined ? [`Saved target identity (server-issued at save; re-verified by the server at apply): ${savedIdentity}`] : [],
        ...preview.family !== null ? [`Family: ${preview.family.ns} (${preview.family.file}) · ${preview.family.materializedIds.length} materialized id(s) — full roster in the sync result`] : [],
        `Overrides included: ${preview.overridesIncluded ? "yes (global family)" : "no"} · coverage: ${preview.coverage}`,
        ...pagedThrough ? [`All ${reviewRows.length} preview row(s) (${changed.length} changed, ${preview.gc.length} gc, ${preview.summary.length} server note(s)) were reviewed page-by-page above.`] : [...changed.slice(0, 10).map((f) => `• ${f.op} ${f.nativeId} → ${f.dest}`), ...preview.summary.map((t) => `note: ${t}`)],
        ...unchangedCount > 0 ? [`unchanged: ${unchangedCount} projection file(s) — listed in full in the sync result`] : [],
        ...preview.gc.length > 0 ? [`gc: ${preview.gc.length} stale generated file(s) will be garbage-collected`] : [],
        ...preview.findings.map((f) => `${f.level}: ${f.message}`),
        "This writes GENERATED projection files on the CONNECTED SERVER's filesystem. The previously saved patch is never replayed."
      ].join(`
`),
      label: { confirm: "Apply sync", cancel: "Cancel" }
    });
    if (go !== true) {
      failSync(["Cancelled — the prepared sync was dropped; nothing was written. 'Retry sync (saved recipe)' prepares fresh against the current recipe."], "info");
      return;
    }
    const applyCheck = await reverifySession();
    if (!applyCheck.ok) {
      failSync([`Sync apply refused — ${applyCheck.message}`, "The prepared sync was dropped; nothing was written."]);
      return;
    }
    if (connectionRevision !== revisionAtPrepare) {
      failSync([`The server connection changed while the sync preview was open (revision ${connectionRevision}) — the prepared sync token is VOID; nothing was applied. Retry sync prepares fresh.`], "error");
      return;
    }
    let app;
    try {
      app = await rpc.sync({ scope, sessionID: state.sessionID, confirm: true, action: "apply", token: tokenValue, commitId });
    } catch (err) {
      if (connectionRevision !== revisionAtPrepare) {
        failSync([`The server connection changed while the sync apply was in flight (revision ${connectionRevision}) — the apply outcome is UNKNOWN/unconfirmed: the old result is not consumed and the token's spent-state is not guessed.`, "'Retry sync (saved recipe)' prepares FRESH (new prepare → preview → your explicit confirmation) against the saved receipt's target."], "warning");
        return;
      }
      failSync([`Sync apply failed (RPC transport: ${safeErrorText(err)}) — the saved recipe is untouched; the prepared sync was consumed, retry prepares fresh.`]);
      return;
    }
    if (connectionRevision !== revisionAtPrepare) {
      failSync([`The server connection changed while the sync apply was in flight (revision ${connectionRevision}) — the returned apply outcome is treated as UNKNOWN/unconfirmed: not consumed, not worded as applied.`, "'Retry sync (saved recipe)' prepares FRESH (new prepare → preview → your explicit confirmation) against the saved receipt's target."], "warning");
      return;
    }
    if (app.ok !== true) {
      failSync([`Sync apply refused (${app.reason}): ${app.message}`, "The saved recipe is kept."]);
      return;
    }
    if (app.action !== "apply") {
      failSync(["Sync apply received a prepare-shaped answer — projection state UNKNOWN.", "Retry sync to re-prepare against current content."], "warning");
      return;
    }
    const verdict = renderSyncApply(app);
    const noop = app.outcome === "noop";
    state.lastSaveFailed = !verdict.okStatus && !noop;
    state.pendingSyncOutstanding = !verdict.okStatus && !noop;
    const finalLines = refusedTotal > 0 ? [...verdict.lines, refusedNoteNow()] : verdict.lines;
    const finalShort = refusedTotal > 0 ? [...verdict.short, refusedNoteNow()] : verdict.short;
    recordSyncResult(`Sync result — ${app.outcome}${noop ? " (nothing to do — clean end)" : ""}`, verdict.okStatus || noop, finalLines);
    inform(finalShort.join(`
`), verdict.okStatus || noop ? "success" : "warning", "Forge: Sync receipt");
  }
  async function syncRetryFlow() {
    const saved = state.savedReceipt;
    if (saved === null) {
      inform("No saved recipe receipt — run Save & Sync first (sync retry never invents a target).", "error");
      return;
    }
    const doc = state.doc;
    const bound = state.view === saved.scope && doc !== null && doc.scope === saved.scope && doc.targetIdentity === saved.targetIdentity;
    if (!bound) {
      const go = await ui.confirm({
        title: "Sync retry is bound to the saved target",
        message: `The open view is not the saved receipt's target. The saved target is the ${saved.scope === "global" ? "Global view" : "Workspace view"} (${saved.path}, identity ${saved.targetIdentity}). Nothing will be synced from this view — switch to the saved target now?`,
        label: { confirm: "Switch to saved target", cancel: "Stay" }
      });
      if (go === true) {
        if (state.view === saved.scope) {
          await freshOpenAndRebase();
          state.view = saved.scope;
        } else if (await guardPendingOnSwitch()) {
          const opened = await openDocument(saved.scope);
          if (opened) {
            state.view = saved.scope;
            state.listQuery = "";
            state.listCurrent = null;
          }
        }
      }
      return;
    }
    await runSyncLegs(saved.scope, saved.commitId);
  }
  function summarizeSync(report) {
    if (report === null || report === undefined)
      return null;
    if (typeof report !== "object")
      return null;
    const rec = report;
    if (typeof rec.outcome !== "string") {
      return { ok: false, lines: [`sync report (unrecognized shape): ${JSON.stringify(report).slice(0, 300)}`] };
    }
    const lines = [];
    lines.push(`sync: ${rec.outcome}`);
    if (typeof rec.path === "string")
      lines.push(`file: ${rec.path}`);
    const idList = (v) => Array.isArray(v) ? v.map((r) => r !== null && typeof r === "object" && typeof r.nativeId === "string" ? r.nativeId : "?").join(", ") : "";
    for (const [label, v] of [["created", rec.created], ["updated", rec.updated]]) {
      if (Array.isArray(v))
        lines.push(`${label}: ${v.length > 0 ? idList(v) : "(none)"}`);
    }
    if (Array.isArray(rec.gced))
      lines.push(`gced: ${rec.gced.length > 0 ? rec.gced.join(", ") : "(none)"}`);
    if (Array.isArray(rec.conflicts)) {
      for (const c of rec.conflicts) {
        if (c !== null && typeof c === "object") {
          const m = c.message;
          const w = c.winnerFile;
          lines.push(`conflict: ${typeof m === "string" ? m : "(unrecognized conflict entry)"}${typeof w === "string" ? ` (winner: ${w})` : ""}`);
        }
      }
    }
    const st = rec.appliedStatus;
    if (st !== null && typeof st === "object") {
      const s = st;
      if (typeof s.status === "string")
        lines.push(`application: ${s.status}`);
      const observedBy = typeof s.observedBy === "string" && s.observedBy !== "" ? s.observedBy : "no proven native-registry observation";
      lines.push(`observed by: ${observedBy}`);
      if (Array.isArray(s.confirmedIds) && s.confirmedIds.length > 0)
        lines.push(`confirmed ids: ${s.confirmedIds.filter((i) => typeof i === "string").join(", ")}`);
      if (Array.isArray(s.unconfirmedIds) && s.unconfirmedIds.length > 0)
        lines.push(`unconfirmed ids: ${s.unconfirmedIds.join(", ")}`);
      if (Array.isArray(s.removedConfirmedIds) && s.removedConfirmedIds.length > 0)
        lines.push(`removals confirmed: ${s.removedConfirmedIds.join(", ")}`);
    } else if (rec.applied === true) {
      lines.push("application: applied");
    } else if (rec.applied === false) {
      lines.push("application: unconfirmed");
    }
    const textLabels = { summary: "note", errors: "error", warnings: "warning", notes: "note" };
    for (const [key, label] of Object.entries(textLabels)) {
      const v = rec[key];
      if (Array.isArray(v)) {
        const texts = v.filter((t) => typeof t === "string");
        if (texts.length > 0)
          lines.push(...texts.map((t) => `${label}: ${t}`));
      }
    }
    const ok = rec.outcome === "applied" ? rec.applied === true : rec.outcome === "noop";
    return { ok, lines };
  }
  return {
    async open() {
      const S0 = deps.initialScope;
      if (!anchorableStartupScope(S0) || S0.anchor === null) {
        inform("Wiring defect: no bound startup scope/location — the editor cannot open: zero reads, zero writes, zero syncs.", "error");
        return;
      }
      state.sessionID = S0.sessionID;
      state.anchorHint = S0.anchor;
      const scopeUnchanged = async () => {
        const sc = await currentSession();
        const same = sc.kind === S0.kind && sc.sessionID === S0.sessionID && sc.anchor === S0.anchor;
        if (!same) {
          inform(`The scope changed while the editor was opening (bound ${S0.kind}/${S0.sessionID ?? "home"} @ ${S0.anchor ?? "no anchor"} → now ${sc.kind}/${sc.sessionID ?? "home"} @ ${sc.anchor ?? "no anchor"}) — this invocation is VOID; reopen /forge-config. Nothing was read or written.`, "warning");
        }
        return same;
      };
      if (!await registryReadiness(S0.anchor))
        return;
      if (!await scopeUnchanged())
        return;
      const nonce = randomUUID();
      let echo;
      try {
        echo = echoVerdictOf(nonce, await rpc.echo({ nonce }));
      } catch (err) {
        inform(`The forge-config RPC transport is unprovable (echo failed: ${safeErrorText(err)}) — the editor stays closed: zero reads, zero writes, zero syncs.`, "error");
        return;
      }
      if (!echo.provable) {
        inform(`The forge-config RPC transport is unprovable (${echo.reason}) — the editor stays closed: zero reads, zero writes, zero syncs.`, "error");
        return;
      }
      if (!await scopeUnchanged())
        return;
      await loadCatalog();
      if (!state.catalog.known)
        inform(state.catalog.findings.join(" · "), "warning");
      const opened = await openDocument("workspace");
      if (!opened)
        return;
      let unsubscribeConnected = null;
      try {
        unsubscribeConnected = deps.data.on("server.connected", () => {
          connectionRevision++;
          state.token = null;
          (async () => {
            const nonce2 = randomUUID();
            let verdict;
            try {
              verdict = echoVerdictOf(nonce2, await rpc.echo({ nonce: nonce2 }));
            } catch {
              inform(`The server reconnected but the transport echo failed — the held preview/token is already void (revision ${connectionRevision}); use 'Reload from server' when the connection recovers. Drafts are kept.`, "warning");
              return;
            }
            if (!verdict.provable) {
              inform(`The reconnected server is unprovable (${verdict.reason}) — the held preview/token is already void (revision ${connectionRevision}). Drafts are kept; nothing proceeds on an unprovable transport.`, "warning");
              return;
            }
            const docEpoch = state.doc?.epoch;
            const docGeneration = state.doc?.generation;
            if (docEpoch !== undefined && (verdict.epoch !== docEpoch || docGeneration !== undefined && verdict.generation !== docGeneration)) {
              await freshOpenAndRebase();
            }
            inform(`Server connection event (revision ${connectionRevision}): any held preview/token is VOID — the next Save & Sync prepares fresh and asks for a NEW confirmation.`, "warning");
          })();
        });
      } catch {}
      try {
        await scopeList();
      } finally {
        if (unsubscribeConnected !== null) {
          try {
            unsubscribeConnected();
          } catch {}
        }
      }
    }
  };
}
function dedupeFindings(findings) {
  const seen = new Set;
  return findings.filter((f) => {
    const key = `${f.level}|${f.code}|${f.message}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
function sanitizeSuggestion(seed) {
  const base = seed.split(/[\\/]/).filter(Boolean).pop() ?? "pool";
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "pool";
}
function diffSummary(before, after) {
  const b = before ?? "(new file)";
  const bLines = b === "(new file)" ? [] : b.split(`
`);
  const aLines = after.split(`
`);
  const added = aLines.filter((l) => !bLines.includes(l)).length;
  const removed = bLines.filter((l) => !aLines.includes(l)).length;
  return `diff: ${added} line(s) added, ${removed} line(s) removed${b === "(new file)" ? " (file created)" : ""}`;
}
function foldDirIdentity(p) {
  const windows = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p);
  return windows ? p.replace(/\//g, "\\").toLowerCase() : p;
}
function sameOptionalDir(a, b) {
  if (a === null || b === null || typeof a !== "string" || typeof b !== "string")
    return a === b;
  return foldDirIdentity(a) === foldDirIdentity(b);
}
function disclosedDir(value) {
  if (typeof value !== "string" || value.trim() === "")
    return "(absent)";
  return safeErrorText(value);
}
function editOpenBindingVerdictOf(request, startup, out) {
  if (out.scope !== request.scope) {
    const named = out.scope === "workspace" || out.scope === "global" ? `scope ${out.scope}` : "an unrecognized scope";
    return { ok: false, message: `the answer names ${named}, not the requested ${request.scope}` };
  }
  if (out.sessionID !== request.sessionID) {
    return { ok: false, message: `the answer session binding (${out.sessionID === null ? "home" : "another session"}) does not match the requested one (${request.sessionID === null ? "home" : "this session"})` };
  }
  if (typeof out.observedLocation !== "string" || out.observedLocation.trim() === "") {
    return { ok: false, message: "the answer carries no usable observed location (missing/blank/not a string) — the server cannot have observed this target" };
  }
  if (startup.kind === "home" && !sameOptionalDir(out.observedLocation, startup.anchor)) {
    return { ok: false, message: `the answer's observed location ${disclosedDir(out.observedLocation)} is not the bound startup location ${disclosedDir(startup.anchor)}` };
  }
  if (out.scope === "workspace") {
    if (!sameOptionalDir(out.anchor, out.observedLocation)) {
      return { ok: false, message: `the workspace answer's anchor ${disclosedDir(out.anchor)} does not match its observed location ${disclosedDir(out.observedLocation)}` };
    }
  } else if (out.anchor !== null) {
    return { ok: false, message: `the global answer carries an anchor ${disclosedDir(out.anchor)} — the global layer has no workspace anchor (expected null)` };
  }
  return { ok: true };
}

// rpc.ts
var CONFIG_RPC_DEFINITION_ID = "opencode-forge-config";
var scopeSchema = { type: "string", enum: ["workspace", "global"], description: "recipe scope" };
var sessionIDSchema = { type: ["string", "null"], description: "authoritative sessionID, or exactly null for the server-observed home scope" };
var fileIdentitySchema = {
  type: "object",
  properties: {
    mtimeMs: { type: "number" },
    size: { type: "integer" },
    dev: { type: "string" },
    ino: { type: "string" }
  },
  required: ["mtimeMs", "size"],
  additionalProperties: false
};
var nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
var findingSchema = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["warn", "error"] },
    code: { type: "string" },
    message: { type: "string" }
  },
  required: ["level", "code", "message"],
  additionalProperties: false
};
var findingsSchema = { type: "array", items: findingSchema };
var entryDraftSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["auto", "pinned"], description: "Auto/Pinned is an atomic pair: auto removes model+thoughtLevel, pinned requires both" },
    model: { type: "string" },
    thoughtLevel: { type: "string" },
    prompt: { type: "string" },
    shape: { type: "string", enum: ["readonly", "write"] },
    permission: { type: "object", additionalProperties: { type: "string" } }
  },
  required: ["mode"],
  additionalProperties: false
};
var opSchema = {
  type: "object",
  properties: {
    opId: { type: "string", description: "client correlation id, echoed per entry outcome" },
    action: { type: "string", enum: ["create", "update", "delete"] },
    kind: { type: "string", enum: ["worker", "override"] },
    id: { type: "string" },
    draft: entryDraftSchema,
    renameTo: { type: "string", description: "presence refuses the op — existing entry ids are immutable" },
    pool: { type: "string", description: "workspace worker creation on an absent file; one consistent pool per create-file batch" }
  },
  required: ["opId", "action", "kind", "id"],
  additionalProperties: false
};
var obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var parseErrorSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    line: { type: "integer" },
    column: { type: "integer" }
  },
  required: ["message"],
  additionalProperties: false
};
var editOpenOkSchema = {
  type: "object",
  properties: {
    ok: { const: true },
    snapshotId: { type: "string" },
    path: { type: "string" },
    targetIdentity: { type: "string", description: "server-issued identity of the resolved binding — disclosed before confirmation and bound into the token" },
    scope: scopeSchema,
    sessionID: sessionIDSchema,
    observedLocation: nullable({ type: "string" }),
    anchor: nullable({ type: "string" }),
    epoch: { type: "string" },
    generation: { type: "integer" },
    expiresAt: { type: "number" },
    exists: { type: "boolean" },
    readable: { type: "boolean" },
    creatable: { type: "boolean" },
    identity: nullable(fileIdentitySchema),
    raw: nullable({ type: "string" }),
    document: { description: "parsed JSONC document (unknown JSON value), or null" },
    parseError: nullable(parseErrorSchema),
    findings: findingsSchema
  },
  required: [
    "ok",
    "snapshotId",
    "path",
    "targetIdentity",
    "scope",
    "sessionID",
    "observedLocation",
    "anchor",
    "epoch",
    "generation",
    "expiresAt",
    "exists",
    "readable",
    "creatable",
    "identity",
    "raw",
    "document",
    "parseError",
    "findings"
  ],
  additionalProperties: false
};
var editOpenErrSchema = obj({
  ok: { const: false },
  reason: { type: "string", enum: ["scope-unresolved", "unavailable", "malformed-request"] },
  message: { type: "string" }
}, ["ok", "reason", "message"]);
var previewEntrySchema = obj({
  opId: { type: "string" },
  id: { type: "string" },
  kind: { type: "string", enum: ["worker", "override"] },
  action: { type: "string", enum: ["create", "update", "delete"] },
  entryKind: { type: "string", enum: ["create-file", "patch", "remove", "no-op"] },
  summary: { type: "array", items: { type: "string" } },
  findings: findingsSchema
}, ["opId", "id", "kind", "action", "entryKind", "summary", "findings"]);
var previewRejectedSchema = obj({
  opId: { type: "string" },
  id: { type: "string" },
  reason: { type: "string" },
  message: { type: "string" },
  findings: findingsSchema
}, ["opId", "id", "reason", "message", "findings"]);
var previewSchema = obj({
  path: { type: "string" },
  targetIdentity: { type: "string", description: "server-issued identity of the resolved binding (see editOpen)" },
  scope: scopeSchema,
  sessionID: sessionIDSchema,
  oldText: nullable({ type: "string" }),
  newText: { type: "string" },
  previewHash: { type: "string", description: "sha256 hex of newText — the canonical token content binding" },
  createFile: { type: "boolean", description: "derived from the edit-start snapshot (absent file), never from the last entry's plan kind" },
  identity: nullable(fileIdentitySchema),
  entries: { type: "array", items: previewEntrySchema },
  rejected: { type: "array", items: previewRejectedSchema }
}, ["path", "targetIdentity", "scope", "sessionID", "oldText", "newText", "previewHash", "createFile", "identity", "entries", "rejected"]);
var prepareTokenSchema = obj({
  token: { type: "string" },
  expiresAt: { type: "number" },
  epoch: { type: "string" },
  generation: { type: "integer" }
}, ["token", "expiresAt", "epoch", "generation"]);
var prepareOkTokenSchema = obj({
  ok: { const: true },
  outcome: { const: "token" },
  token: prepareTokenSchema,
  preview: previewSchema,
  findings: findingsSchema
}, ["ok", "outcome", "token", "preview", "findings"]);
var prepareOkNoopSchema = obj({
  ok: { const: true },
  outcome: { const: "no-op" },
  summary: { type: "array", items: { type: "string" } },
  rejected: { type: "array", items: previewRejectedSchema },
  findings: findingsSchema
}, ["ok", "outcome", "summary", "rejected", "findings"]);
var prepareRejectReasons = [
  "snapshot-unknown",
  "snapshot-expired",
  "epoch-stale",
  "scope-mismatch",
  "scope-unresolved",
  "conflict-reload",
  "unreadable",
  "unparseable",
  "invalid-op",
  "invalid-id",
  "invalid-pool",
  "invalid-scope",
  "duplicate",
  "not-found",
  "ambiguous",
  "no-valid-entries",
  "malformed-request",
  "unavailable"
];
var commitEntryOutcomeSchema = obj({
  opId: { type: "string" },
  id: { type: "string" },
  kind: { type: "string", enum: ["worker", "override"] },
  action: { type: "string", enum: ["create", "update", "delete"] },
  entryKind: { type: "string", enum: ["create-file", "patch", "remove", "no-op"] },
  outcome: { type: "string", enum: ["written", "no-op", "rejected"] },
  reason: { type: "string" },
  summary: { type: "array", items: { type: "string" } },
  findings: findingsSchema
}, ["opId", "id", "kind", "action", "entryKind", "outcome", "summary", "findings"]);
var commitReceiptSchema = {
  type: "object",
  properties: {
    commitId: { type: "string" },
    token: { type: "string" },
    outcome: {
      type: "string",
      enum: ["written", "no-op", "conflict", "ownership-lost", "write-failed", "missing", "unreadable", "unparseable"]
    },
    message: { type: "string" },
    path: { type: "string" },
    targetIdentity: { type: "string", description: "server-issued identity of the binding this receipt belongs to" },
    scope: scopeSchema,
    sessionID: sessionIDSchema,
    savedIdentity: nullable(fileIdentitySchema),
    bytes: { type: "integer", description: "real UTF-8 byte length of the published document" },
    entries: { type: "array", items: commitEntryOutcomeSchema },
    epoch: { type: "string" },
    generation: { type: "integer" },
    at: { type: "number" },
    sync: { anyOf: [{ type: "object" }, { type: "null" }], description: "server-side family-sync outcome slot (owned by the sync handlers); null until attached" }
  },
  required: [
    "commitId",
    "token",
    "outcome",
    "message",
    "path",
    "targetIdentity",
    "scope",
    "sessionID",
    "savedIdentity",
    "bytes",
    "entries",
    "epoch",
    "generation",
    "at"
  ],
  additionalProperties: true
};
var commitRejectReasons = [
  "token-unknown",
  "token-expired",
  "token-spent",
  "epoch-stale",
  "scope-mismatch",
  "scope-unresolved",
  "confirm-required",
  "malformed-request",
  "unavailable"
];
var syncRosterRefSchema = obj({ nativeId: { type: "string" }, fileName: { type: "string" } }, ["nativeId", "fileName"]);
var syncErrorItemSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    nativeId: { type: "string" },
    fileName: { type: "string" }
  },
  required: ["message"],
  additionalProperties: false
};
var syncConflictItemSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    nativeId: { type: "string" },
    fileName: { type: "string" },
    winnerFile: { type: "string" }
  },
  required: ["message"],
  additionalProperties: false
};
var syncPreviewSchema = obj({
  path: { type: "string" },
  scope: scopeSchema,
  sessionID: sessionIDSchema,
  observedLocation: nullable({ type: "string" }),
  anchor: nullable({ type: "string" }),
  family: nullable(obj({ file: { type: "string" }, ns: { type: "string" }, materializedIds: { type: "array", items: { type: "string" } } }, ["file", "ns", "materializedIds"])),
  overridesIncluded: { type: "boolean" },
  files: { type: "array", items: obj({ nativeId: { type: "string" }, fileName: { type: "string" }, dest: { type: "string" }, op: { type: "string", enum: ["create", "update", "unchanged"] } }, ["nativeId", "fileName", "dest", "op"]) },
  gc: { type: "array", items: obj({ nativeId: { type: "string" }, dest: { type: "string" } }, ["nativeId", "dest"]) },
  coverage: { const: "full" },
  summary: { type: "array", items: { type: "string" } },
  findings: findingsSchema
}, ["path", "scope", "sessionID", "observedLocation", "anchor", "family", "overridesIncluded", "files", "gc", "coverage", "summary", "findings"]);
var syncRejectReasons = [
  "invalid-input",
  "scope-unresolved",
  "no-coverage",
  "recipe-unusable",
  "directory-conflict",
  "token-unknown",
  "token-expired",
  "token-spent",
  "epoch-stale",
  "scope-mismatch",
  "stale-preview",
  "unavailable"
];
var forgeConfigRpcDefinition = {
  id: CONFIG_RPC_DEFINITION_ID,
  methods: {
    echo: {
      input: obj({ nonce: { type: "string" } }, ["nonce"]),
      errors: {},
      output: obj({
        nonce: { type: "string" },
        pluginID: { type: "string" },
        appVersion: { type: "string" },
        epoch: { type: "string", description: "current server epoch — observable for reconnect/epoch-change detection" },
        generation: { type: "integer", description: "current RPC registration generation" }
      }, ["nonce", "pluginID", "appVersion", "epoch", "generation"])
    },
    editOpen: {
      input: obj({ scope: scopeSchema, sessionID: sessionIDSchema }, ["scope", "sessionID"]),
      errors: {},
      output: { anyOf: [editOpenOkSchema, editOpenErrSchema] }
    },
    prepare: {
      input: obj({
        snapshotId: { type: "string" },
        scope: scopeSchema,
        sessionID: sessionIDSchema,
        ops: { type: "array", items: opSchema, maxItems: 32, description: "bounded previews: at most 32 ops (default cap; handler enforces its configured limit) and 262144 UTF-8 bytes per serialized draft" }
      }, ["snapshotId", "scope", "sessionID", "ops"]),
      errors: {},
      output: {
        anyOf: [
          prepareOkTokenSchema,
          prepareOkNoopSchema,
          obj({ ok: { const: false }, reason: { type: "string", enum: [...prepareRejectReasons] }, message: { type: "string" }, findings: findingsSchema }, ["ok", "reason", "message"])
        ]
      }
    },
    commit: {
      input: obj({
        token: { type: "string" },
        confirm: { type: "boolean", description: "must be EXACTLY true — explicit human confirmation (handler-enforced)" },
        scope: scopeSchema,
        sessionID: sessionIDSchema
      }, ["token", "confirm", "scope", "sessionID"]),
      errors: {},
      output: {
        anyOf: [
          obj({ ok: { const: true }, receipt: commitReceiptSchema }, ["ok", "receipt"]),
          obj({ ok: { const: false }, reason: { type: "string", enum: [...commitRejectReasons] }, message: { type: "string" } }, ["ok", "reason", "message"])
        ]
      }
    },
    receipt: {
      input: obj({ token: { type: "string" } }, ["token"]),
      errors: {},
      output: {
        anyOf: [
          obj({ found: { const: true }, receipt: commitReceiptSchema, epoch: { type: "string" }, generation: { type: "integer" } }, ["found", "receipt", "epoch", "generation"]),
          obj({ found: { const: false }, epoch: { type: "string" }, generation: { type: "integer" } }, ["found", "epoch", "generation"])
        ]
      }
    },
    sync: {
      input: {
        type: "object",
        properties: {
          scope: scopeSchema,
          sessionID: sessionIDSchema,
          confirm: { type: "boolean" },
          action: { type: "string", enum: ["prepare", "apply"] },
          token: { type: "string", description: "required for apply (the prepared sync token); prepare must not carry one" },
          commitId: { type: "string", description: "optional apply-side correlation to the commit receipt" }
        },
        required: ["scope", "sessionID", "confirm", "action"],
        additionalProperties: false
      },
      errors: {},
      output: {
        anyOf: [
          obj({
            ok: { const: true },
            action: { const: "prepare" },
            outcome: { const: "token" },
            token: prepareTokenSchema,
            preview: syncPreviewSchema,
            findings: findingsSchema
          }, ["ok", "action", "outcome", "token", "preview", "findings"]),
          obj({
            ok: { const: true },
            action: { const: "prepare" },
            outcome: { const: "noop" },
            preview: syncPreviewSchema,
            findings: findingsSchema
          }, ["ok", "action", "outcome", "preview", "findings"]),
          {
            type: "object",
            properties: {
              ok: { const: true },
              action: { const: "apply" },
              outcome: { type: "string", enum: ["applied", "unconfirmed", "conflict", "refused", "noop"] },
              applied: { type: "boolean" },
              path: { type: "string" },
              scope: scopeSchema,
              sessionID: sessionIDSchema,
              created: { type: "array", items: syncRosterRefSchema },
              updated: { type: "array", items: syncRosterRefSchema },
              unchanged: { type: "array", items: { type: "string" } },
              gced: { type: "array", items: { type: "string" } },
              errors: { type: "array", items: syncErrorItemSchema },
              removedIds: { type: "array", items: { type: "string" } },
              appliedStatus: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["applied", "unconfirmed"] },
                  observedBy: nullable({ type: "string" }),
                  confirmedIds: { type: "array", items: { type: "string" } },
                  removedConfirmedIds: { type: "array", items: { type: "string" } },
                  unconfirmedIds: { type: "array", items: { type: "string" } }
                },
                required: ["status", "observedBy", "confirmedIds", "removedConfirmedIds", "unconfirmedIds"],
                additionalProperties: false
              },
              conflicts: { type: "array", items: syncConflictItemSchema },
              summary: { type: "array", items: { type: "string" } },
              findings: findingsSchema,
              epoch: { type: "string" },
              generation: { type: "integer" },
              at: { type: "number" }
            },
            required: [
              "ok",
              "action",
              "outcome",
              "applied",
              "path",
              "scope",
              "sessionID",
              "created",
              "updated",
              "unchanged",
              "gced",
              "errors",
              "removedIds",
              "appliedStatus",
              "conflicts",
              "summary",
              "findings",
              "epoch",
              "generation",
              "at"
            ],
            additionalProperties: false
          },
          obj({
            ok: { const: false },
            action: { type: "string", enum: ["prepare", "apply", "unknown"] },
            reason: { type: "string", enum: [...syncRejectReasons] },
            message: { type: "string" }
          }, ["ok", "action", "reason", "message"])
        ]
      }
    }
  },
  events: {}
};

// tui.ts
var TUI_SDK_SPEC = ["@opencode", "plugin", "tui"].join("/");
async function loadTuiApi() {
  try {
    const mod = await import(TUI_SDK_SPEC);
    return mod ?? null;
  } catch {
    return null;
  }
}
function asCallable(value) {
  return typeof value === "function" ? value : null;
}
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}
function defaultSchedule(ms, callback) {
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    callback();
  }, ms);
  if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
    timer.unref();
  }
  return () => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
  };
}
function openSizedDialog(dialogObj, open, onDegraded) {
  const opened = open();
  try {
    const set = asCallable(dialogObj.set);
    if (set === null)
      throw new Error("ctx.ui.dialog.set is unavailable");
    set.call(dialogObj, { size: "xlarge", centered: true });
  } catch {
    onDegraded();
  }
  return opened;
}
function buildUi(ctx) {
  const ui = ctx.ui ?? {};
  const dialog = ui.dialog ?? {};
  let sizeHintShown = false;
  const discloseSizeDegradation = () => {
    if (sizeHintShown)
      return;
    sizeHintShown = true;
    try {
      const show = asCallable(ui.toast?.show);
      if (show !== null) {
        show({
          title: "Forge",
          message: "Could not widen this dialog; using host default size.",
          variant: "info",
          duration: 4000
        });
      }
    } catch {}
  };
  const sized = (open) => openSizedDialog(dialog, open, discloseSizeDegradation);
  return {
    select: (input) => {
      const fn = asCallable(dialog.select);
      if (fn === null)
        throw new Error("ctx.ui.dialog.select is unavailable");
      return sized(() => fn(input));
    },
    confirm: (input) => {
      const fn = asCallable(dialog.confirm);
      if (fn === null)
        throw new Error("ctx.ui.dialog.confirm is unavailable");
      return sized(() => fn(input));
    },
    prompt: (input) => {
      const fn = asCallable(dialog.prompt);
      if (fn === null)
        throw new Error("ctx.ui.dialog.prompt is unavailable");
      return sized(() => fn(input));
    },
    clear: () => {
      const fn = asCallable(dialog.clear);
      if (fn === null)
        throw new Error("ctx.ui.dialog.clear is unavailable — the CtrlD delete shortcut cannot close the list safely");
      return fn(undefined);
    },
    toast: (input) => {
      try {
        const show = asCallable(ui.toast?.show);
        if (show !== null)
          show(input);
      } catch {}
    },
    router: {
      current: () => {
        const current = asCallable(ui.router?.current);
        if (current === null)
          return;
        return current();
      }
    }
  };
}
function buildClient(ctx) {
  const client = ctx.client ?? {};
  const callOne = (method, label, input) => {
    const fn = asCallable(method);
    if (fn === null)
      throw new Error(`${label} is unavailable on the connected client`);
    return Promise.resolve(fn(input));
  };
  return {
    plugin: {
      list: async (input) => await callOne(client.plugin?.list, "client.plugin.list", input)
    },
    session: {
      get: async (input) => await callOne(client.session?.get, "client.session.get", input)
    },
    command: {
      list: async (input) => await callOne(client.command?.list, "client.command.list", input)
    },
    rpc: (definition) => {
      const fn = asCallable(client.rpc);
      if (fn === null)
        throw new Error("client.rpc is unavailable on the connected client");
      return fn(definition);
    }
  };
}
function buildData(ctx) {
  const location = ctx.data?.location ?? {};
  const provider = location?.provider ?? {};
  const model = location?.model ?? {};
  return {
    location: {
      provider: {
        sync: (l) => {
          const fn = asCallable(provider.sync);
          if (fn === null)
            throw new Error("data.location.provider.sync is unavailable");
          return fn(l);
        },
        list: (l) => {
          const fn = asCallable(provider.list);
          if (fn === null)
            throw new Error("data.location.provider.list is unavailable");
          return fn(l);
        }
      },
      model: {
        sync: (l) => {
          const fn = asCallable(model.sync);
          if (fn === null)
            throw new Error("data.location.model.sync is unavailable");
          return fn(l);
        },
        list: (l) => {
          const fn = asCallable(model.list);
          if (fn === null)
            throw new Error("data.location.model.list is unavailable");
          return fn(l);
        }
      },
      default: () => {
        const fn = asCallable(location?.default);
        if (fn === null)
          throw new Error("data.location.default is unavailable");
        return fn();
      }
    },
    on: (eventType, handler) => {
      const fn = asCallable(ctx.data?.on);
      if (fn === null)
        throw new Error("data.on is unavailable — live event subscription is not provided");
      return fn(eventType, handler);
    }
  };
}
function observedDirectory(ctx) {
  const dir = ctx.location?.directory;
  if (typeof dir === "string" && dir !== "")
    return dir;
  try {
    const fn = asCallable(ctx.data?.location?.default);
    if (fn === null)
      return null;
    const def = fn();
    const d = def?.directory;
    return typeof d === "string" && d !== "" ? d : null;
  } catch {
    return null;
  }
}
async function readSessionScope(ctx) {
  let routerView;
  try {
    const current = asCallable(ctx.ui?.router?.current);
    routerView = current !== null ? current() : undefined;
  } catch {
    routerView = undefined;
  }
  const routerType = typeof routerView?.type === "string" ? routerView.type : null;
  const routerSessionID = typeof routerView?.sessionID === "string" && routerView.sessionID !== "" ? routerView.sessionID : null;
  if (routerType !== "home" && routerType !== "session") {
    return {
      sessionID: null,
      anchor: null,
      kind: "unknown",
      reason: routerView === undefined ? "ui.router.current() is unavailable — the view cannot be identified; only a proven home view could use the observed location" : `ui.router.current() reports view ${JSON.stringify(routerType)} — neither home nor session; scope cannot be established`
    };
  }
  if (routerType === "home") {
    const observed = observedDirectory(ctx);
    if (observed !== null)
      return { sessionID: null, anchor: observed, kind: "home" };
    return { sessionID: null, anchor: null, kind: "unknown", reason: "the router reports the home view but no observed host location is available" };
  }
  const sessionID = routerSessionID;
  if (sessionID === null) {
    return { sessionID: null, anchor: null, kind: "unknown", reason: "the router reports a session view without a sessionID" };
  }
  let row;
  try {
    row = await buildClient(ctx).session.get({ sessionID });
  } catch (err) {
    return { sessionID, anchor: null, kind: "unknown", reason: `client.session.get failed: ${safeErrorText(err)}` };
  }
  if (row === null || typeof row !== "object") {
    return { sessionID, anchor: null, kind: "unknown", reason: "client.session.get returned no session record" };
  }
  if (row.id !== sessionID) {
    return {
      sessionID,
      anchor: null,
      kind: "unknown",
      reason: `the session record's id ${JSON.stringify(row.id ?? null)} does not match the router session ${JSON.stringify(sessionID)} — the record is not trusted`
    };
  }
  const dir = row.location?.directory;
  if (typeof dir === "string" && dir !== "")
    return { sessionID, anchor: dir, kind: "session" };
  return { sessionID, anchor: null, kind: "unknown", reason: "the session record carries no location.directory" };
}
var RPC_METHODS = ["echo", "editOpen", "prepare", "commit", "receipt", "sync"];
function buildRpcTransport(ctx, location) {
  if (typeof location !== "string" || location === "")
    return null;
  const client = buildClient(ctx);
  const opts = { location: { directory: location } };
  try {
    const raw = client.rpc(forgeConfigRpcDefinition);
    if (raw === null || typeof raw !== "object")
      return null;
    const methods = raw;
    const bound = {};
    for (const name of RPC_METHODS) {
      const fn = asCallable(methods[name]);
      if (fn === null)
        return null;
      bound[name] = async (input) => await fn(input, opts);
    }
    return bound;
  } catch {
    return null;
  }
}
async function runEditor(ctx, source) {
  const ui = buildUi(ctx);
  const gate = buildSlashGate(ctx);
  if (source === "slash") {
    const verdict = await Promise.race([slashNameTaken(ctx), checkDeadline(3000)]);
    const now = observedDirectory(ctx);
    if (gate !== null)
      gate.set(false, now);
    if (verdict !== false) {
      if (verdict === true) {
        disclose(ctx, "Your own /forge-config command was detected — this invocation reached Forge's alias, which is now withdrawn; your command's NEXT invocation reaches it.", "warning");
      } else {
        disclose(ctx, "The command registry could not be re-checked before opening (fail-closed) — /forge-config stays closed. The palette entry remains registered.", "warning");
      }
      return;
    }
    if (gate !== null)
      gate.set(true, now);
  } else {
    observeAndSetGate(ctx, gate);
  }
  const initialScope = await readSessionScope(ctx);
  if (!anchorableStartupScope(initialScope) || initialScope.anchor === null) {
    ui.toast({
      title: "Forge: Configure subagents",
      message: `Scope/location cannot be anchored (${initialScope.reason ?? "no legal startup scope"}) — the editor cannot open: zero reads, zero writes, zero syncs.`,
      variant: "error",
      duration: 8000
    });
    return;
  }
  const rpc = buildRpcTransport(ctx, initialScope.anchor);
  if (rpc === null) {
    ui.toast({
      title: "Forge: Configure subagents",
      message: "The forge-config RPC transport is unavailable (client.rpc or a method is missing) — the editor cannot open: zero reads, zero writes, zero syncs. Server-side /forge is unaffected.",
      variant: "error",
      duration: 8000
    });
    return;
  }
  const deps = {
    ui,
    client: buildClient(ctx),
    data: buildData(ctx),
    rpc,
    sessionScope: () => readSessionScope(ctx),
    initialScope,
    pluginId: "forge",
    sleep: defaultSleep,
    schedule: defaultSchedule,
    now: () => performance.now()
  };
  const editor = createForgeConfigEditor(deps);
  try {
    await editor.open();
  } catch (err) {
    ui.toast({ title: "Forge: Configure subagents", message: `The editor closed on an error — if a Save & Sync was confirmed, resolve its outcome via Retry sync / the server receipt (error: ${safeErrorText(err)})`, variant: "error", duration: 8000 });
  }
}
function buildSlashGate(ctx) {
  const memory = asCallable(ctx.storage?.memory);
  if (memory === null)
    return null;
  let pair;
  try {
    pair = memory("config-slash-gate", { initial: { allowed: false, location: null } });
  } catch {
    return null;
  }
  if (!Array.isArray(pair) || pair.length < 2)
    return null;
  const store = pair[0];
  const setter = asCallable(pair[1]);
  if (setter === null)
    return null;
  return {
    read: () => ({
      allowed: store.allowed === true,
      location: typeof store.location === "string" ? store.location : null
    }),
    set: (allowed, location) => {
      try {
        setter((draft) => {
          draft.allowed = allowed;
          draft.location = location;
        });
      } catch {}
    }
  };
}
function layerCommands(ctx, gate) {
  let slashAllowed = false;
  if (gate !== null) {
    const g = gate.read();
    const dir = observedDirectory(ctx);
    slashAllowed = g.allowed && (g.location === null || g.location === dir);
  }
  return {
    mode: "global",
    priority: 50,
    commands: [
      {
        id: "forge.config-slash",
        title: "Forge: Configure subagents (/forge-config)",
        group: "Forge",
        palette: false,
        ...slashAllowed ? { slash: { name: "forge-config" } } : {},
        enabled: () => true,
        suggested: false,
        run: () => runEditor(ctx, "slash")
      },
      {
        id: "forge.config",
        title: "Forge: Configure subagents",
        group: "Forge",
        palette: true,
        enabled: () => true,
        suggested: false,
        run: () => runEditor(ctx, "palette")
      }
    ],
    bindings: []
  };
}
function disclose(ctx, message, variant) {
  try {
    const show = asCallable(ctx.ui?.toast?.show);
    if (show !== null)
      show({ title: "Forge", message, variant, duration: 6000 });
  } catch {}
}
async function slashNameTaken(ctx) {
  const list = asCallable(ctx.client?.command?.list);
  if (list === null)
    return null;
  try {
    const directory = ctx.location?.directory;
    const res = await list({ location: typeof directory === "string" && directory !== "" ? { directory } : {} });
    const rows = res?.data;
    if (!Array.isArray(rows))
      return null;
    return rows.some((row) => row?.name === "forge-config");
  } catch {
    return null;
  }
}
function checkDeadline(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}
var unsubscribe = null;
var observationGeneration = 0;
async function observeAndSetGate(ctx, gate) {
  const generation = ++observationGeneration;
  const atLocation = observedDirectory(ctx);
  const verdict = await Promise.race([slashNameTaken(ctx), checkDeadline(3000)]);
  if (generation !== observationGeneration)
    return;
  if (observedDirectory(ctx) !== atLocation)
    return;
  if (gate !== null)
    gate.set(verdict === false, atLocation);
  if (verdict === true) {
    disclose(ctx, 'Your own "/forge-config" command was detected — Forge registered its palette entry only and did not overwrite your command.', "info");
  } else if (verdict === null) {
    disclose(ctx, "The command registry is not readable from this TUI — a user-defined /forge-config collision cannot be ruled out, so the /forge-config slash shortcut is withheld (fail-closed; the palette entry is active).", "warning");
  }
}
async function setupTui(ctx) {
  const gate = buildSlashGate(ctx);
  gate?.set(false, null);
  const layer = asCallable(ctx.keymap?.layer);
  if (layer === null) {
    disclose(ctx, "The TUI command surface is unavailable — the Forge palette entry was not registered. Server-side /forge is unaffected.", "warning");
    return;
  }
  try {
    layer(() => layerCommands(ctx, gate));
  } catch {
    disclose(ctx, "The TUI command surface is unavailable — the Forge palette entry was not registered. Server-side /forge is unaffected.", "warning");
    return;
  }
  if (gate === null) {
    disclose(ctx, "The reactive command gate (ctx.storage.memory) is unavailable in this host — the /forge-config slash shortcut is withheld entirely (fail-closed; the palette entry is active).", "warning");
  }
  await observeAndSetGate(ctx, gate);
  try {
    unsubscribe = buildData(ctx).on("command.updated", () => {
      observeAndSetGate(ctx, gate);
    });
  } catch {
    disclose(ctx, "Live command-registry change events are unavailable in this host — /forge-config collision detection relies on setup- and invocation-time checks.", "info");
  }
  return;
}
var api = await loadTuiApi();
var definition = {
  id: "forge",
  setup: setupTui,
  dispose: () => {
    const un = unsubscribe;
    unsubscribe = null;
    if (un !== null) {
      try {
        un();
      } catch {}
    }
  }
};
var tui_default = api?.Plugin?.define ? api.Plugin.define(definition) : definition;
export {
  readSessionScope,
  tui_default as default,
  buildUi,
  buildRpcTransport,
  buildData,
  buildClient
};
