var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/stop-scope.ts
function selectStopScope(invokingSession, children, childEnumeration, commands, commandEnumeration) {
  const findings = [];
  const eligible = new Set;
  let unknownChildren = !invokingSession || childEnumeration !== "complete";
  let unknownCommands = commandEnumeration !== "complete";
  if (!invokingSession)
    findings.push("Invoking session unknown");
  if (childEnumeration !== "complete")
    findings.push(`Child enumeration ${childEnumeration}; remaining count unknown`);
  if (unknownCommands)
    findings.push(`Shell enumeration ${commandEnumeration}; remaining count unknown`);
  for (const child of children) {
    if (child.id === invokingSession || child.lineage === "excluded" || child.dispatch === "excluded")
      continue;
    if (invokingSession && child.id && child.lineage === "confirmed" && child.dispatch === "confirmed" && children.every((other) => other.id !== child.id || other.lineage === "confirmed" && other.dispatch === "confirmed")) {
      eligible.add(child.id);
    } else {
      unknownChildren = true;
      findings.push(`Child ${child.id || "(unknown ID)"}: scope not confirmed`);
    }
  }
  const selected = new Map;
  for (const command of commands) {
    if (command.backgroundShell === "excluded" || command.ownership === "excluded")
      continue;
    if (command.ownership === "confirmed" && command.owner && !eligible.has(command.owner))
      continue;
    if (command.id && eligible.has(command.owner) && command.ownership === "confirmed" && command.backgroundShell === "confirmed" && commands.every((other) => other.id !== command.id || other.owner === command.owner && other.ownership === "confirmed" && other.backgroundShell === "confirmed")) {
      selected.set(command.id, command.owner);
    } else {
      unknownCommands = true;
      findings.push(`Command ${command.id || "(unknown ID)"}: scope not confirmed`);
    }
  }
  return {
    children: [...eligible],
    commands: [...selected].map(([id, owner]) => ({ id, owner })),
    unknownChildren,
    unknownCommands: unknownCommands || unknownChildren,
    nothingToStop: !unknownChildren && eligible.size === 0,
    findings
  };
}

// src/stop-native.ts
var record = (value) => value && typeof value === "object" ? value : {};
var unwrap = (value) => record(value).data ?? value;
var rows = (value) => {
  const data = unwrap(value);
  if (!Array.isArray(data))
    throw new Error("invalid enumeration");
  return data;
};
var STOP_LIST_LIMIT = 500;
async function stopNative(root, client) {
  const findings = new Set;
  const deadline = Date.now() + (client.deadlineMs ?? 8000);
  const bounded = async (call) => {
    const remaining = Math.min(client.timeoutMs ?? 1500, deadline - Date.now());
    if (remaining <= 0)
      throw new Error("deadline");
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), remaining);
      })]);
    } finally {
      if (timer !== undefined)
        clearTimeout(timer);
    }
  };
  const receipts = new Map;
  const receipt = (id, text) => {
    if (!receipts.has(id))
      receipts.set(id, new Set);
    receipts.get(id).add(text);
  };
  let empty = false;
  const requestedShells = new Map;
  const requestedInterrupts = new Set;
  for (let round = 0;round < 3; round++) {
    const candidates = [];
    let enumeration = "complete";
    const queue = [root];
    const visited = new Set(queue);
    const parents = new Map;
    for (let index = 0;index < queue.length && index < STOP_LIST_LIMIT; index++) {
      const parent = queue[index];
      try {
        const children = [];
        const cursors = new Set;
        let cursor;
        for (;; ) {
          try {
            const rawChildren = await bounded(() => client.children(parent, cursor));
            const page = rows(rawChildren);
            const next = record(record(rawChildren).cursor).next;
            if (typeof next === "string" && cursors.has(next)) {
              enumeration = "truncated";
              break;
            }
            children.push(...page.slice(0, STOP_LIST_LIMIT - children.length));
            if (children.length >= STOP_LIST_LIMIT) {
              enumeration = "truncated";
              break;
            }
            if (next == null)
              break;
            if (typeof next !== "string" || !next || !page.length) {
              enumeration = "truncated";
              break;
            }
            cursors.add(next);
            cursor = next;
          } catch {
            enumeration = "partial";
            findings.add(`Child enumeration unavailable for ${parent}`);
            break;
          }
        }
        if (!children.length)
          continue;
        let proof = new Set;
        try {
          for (const message of rows(await bounded(() => client.context(parent)))) {
            const m = record(message);
            if (m.type !== "assistant" && record(m.info).role !== "assistant" && m.role !== "assistant")
              continue;
            const parts = m.parts ?? m.content;
            for (const part of Array.isArray(parts) ? parts : []) {
              const p = record(part), state = record(p.state), metadata = record(state.metadata);
              if (p.type === "tool" && (p.name ?? p.tool) === "subagent" && state.status === "completed" && metadata.status === "running" && typeof metadata.sessionID === "string")
                proof.add(metadata.sessionID);
            }
          }
        } catch {
          enumeration = "partial";
          findings.add(`Dispatch evidence unavailable for ${parent}`);
        }
        for (const raw of children) {
          const child = record(raw);
          if (typeof child.id !== "string" || child.parentID !== parent || visited.has(child.id)) {
            enumeration = "partial";
            if (typeof child.id === "string")
              candidates.push({ id: child.id, lineage: "unknown", dispatch: "unknown" });
            continue;
          }
          const confirmed = proof.has(child.id);
          candidates.push({ id: child.id, lineage: "confirmed", dispatch: confirmed ? "confirmed" : "unknown" });
          if (confirmed) {
            visited.add(child.id);
            parents.set(child.id, parent);
            queue.push(child.id);
          }
        }
      } catch {
        enumeration = "partial";
        findings.add(`Child enumeration unavailable for ${parent}`);
      }
    }
    const disputed = new Set(candidates.filter((c) => c.lineage !== "confirmed" || c.dispatch !== "confirmed").map((c) => c.id));
    for (const candidate of candidates) {
      let ancestor = parents.get(candidate.id);
      while (ancestor && ancestor !== root) {
        if (disputed.has(ancestor)) {
          candidate.lineage = "unknown";
          break;
        }
        ancestor = parents.get(ancestor);
      }
    }
    if (queue.length > STOP_LIST_LIMIT)
      enumeration = "truncated";
    let commands = [], shellEnumeration = "complete";
    try {
      commands = rows(await bounded(() => client.shells())).map((raw) => {
        const shell = record(raw), owner = record(shell.metadata).sessionID;
        return { id: typeof shell.id === "string" ? shell.id : "", owner: typeof owner === "string" ? owner : "", ownership: typeof owner === "string" ? "confirmed" : "unknown", backgroundShell: "confirmed" };
      });
    } catch {
      shellEnumeration = "unavailable";
    }
    if (shellEnumeration === "complete" && commands.every((command) => command.id)) {
      for (const [id, owner] of requestedShells) {
        if (!commands.some((command) => command.id === id))
          receipt(owner, `Shell ${id}: confirmed no longer running after termination request`);
      }
    }
    const scope = selectStopScope(root, candidates, enumeration, commands, shellEnumeration);
    for (const finding of scope.findings)
      findings.add(finding);
    empty = scope.nothingToStop;
    const owners = new Set(scope.commands.map((c) => c.owner));
    for (const command of scope.commands) {
      if (requestedShells.get(command.id) === command.owner)
        continue;
      try {
        await bounded(() => client.removeShell(command.id));
        requestedShells.set(command.id, command.owner);
        receipt(command.owner, `Shell ${command.id}: termination requested (terminal outcome unconfirmed at request time)`);
      } catch {
        receipt(command.owner, `Shell ${command.id}: termination request failed or timed out; outcome unknown`);
      }
    }
    let active;
    try {
      const value = unwrap(await bounded(() => client.active()));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid active map");
      active = record(value);
    } catch {
      findings.add("Active session enumeration unavailable; terminal outcomes unknown");
    }
    for (const id of scope.children) {
      if (active && !(id in active) && !owners.has(id) && shellEnumeration === "complete" && commands.every((c) => c.ownership === "confirmed")) {
        receipt(id, requestedInterrupts.has(id) ? "Confirmed not running after interrupt request (not proof of task success)" : "Observed idle (not proof of cancellation or terminal outcome)");
        continue;
      }
      try {
        const result = record(unwrap(await bounded(() => client.interrupt(id))));
        requestedInterrupts.add(id);
        receipt(id, result.interrupted === false ? "Interrupt requested; host returned interrupted=false" : result.interrupted === true ? "Interrupt requested; host confirmed interrupt (not task success)" : "Interrupt requested; terminal outcome unconfirmed");
      } catch {
        receipt(id, "Interrupt request failed or timed out; outcome unknown");
      }
    }
    if (round < 2)
      try {
        await bounded(() => client.wait());
      } catch {
        findings.add("Revisit deadline reached; remaining outcomes unknown");
        break;
      }
  }
  return [
    "[forge stop receipt] Relay these observations; do not start more work.",
    ...empty && !receipts.size && !findings.size ? ["No native children to stop."] : [],
    ...[...receipts].map(([id, notes]) => `${id}: ${[...notes].join("; ")}`),
    ...findings,
    "Only explicit confirmations above establish observed stopped activity; task success is not established. The host may interrupt other activity as a collateral effect of a child interrupt; the scope above covers only explicit requests. In a sandbox observation, interrupting a child left its active parent running; this is not a general collateral-behavior guarantee. Interrupting the parent does not guarantee children stop; use /forge stop to request explicit child cancellation."
  ].join(`
`);
}

// src/search-authorized.ts
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

// src/search-js.ts
function escapeReChar(c) {
  return /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
}
function translateGlob(pat, strict = false) {
  let out = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === "*") {
      let stars = 0;
      while (pat[i] === "*") {
        stars++;
        i++;
      }
      if (stars >= 2 && pat[i] === "/") {
        i++;
        out += "(?:[^/]*/)*";
      } else if (stars >= 2) {
        out += ".*";
      } else if (pat[i] === "/") {
        i++;
        out += "[^/]*/";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      i++;
      out += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      let negated = false;
      if (pat[j] === "!" || pat[j] === "^") {
        negated = true;
        j++;
      }
      let close = -1;
      for (let k = j;k < pat.length; ) {
        if (pat[k] === "\\") {
          k += 2;
          continue;
        }
        if (pat[k] === "]") {
          close = k;
          break;
        }
        k++;
      }
      if (close === -1 || close === j) {
        if (strict)
          throw new Error("Invalid glob: unclosed or empty character class");
        out += "\\[";
        i++;
        continue;
      }
      let body = "";
      for (let m = j;m < close; m++) {
        const ch = pat[m];
        if (ch === "\\") {
          m++;
          const escaped = pat[m];
          if (escaped === undefined)
            break;
          body += escaped === "\\" || escaped === "]" ? "\\" + escaped : escaped;
          continue;
        }
        body += ch === "]" || ch === "\\" ? "\\" + ch : ch;
      }
      if (body.length === 0) {
        out += "\\[";
        i++;
        continue;
      }
      out += "[" + (negated ? "^" : "") + body + "]";
      i = close + 1;
    } else if (c === "{") {
      const close = pat.indexOf("}", i + 1);
      if (close === -1) {
        if (strict)
          throw new Error("Invalid glob: unclosed alternative");
        out += "\\{";
        i++;
        continue;
      }
      const alts = pat.slice(i + 1, close).split(",");
      out += "(?:" + alts.map((a) => translateGlob(a, strict)).join("|") + ")";
      i = close + 1;
    } else {
      out += escapeReChar(c);
      i++;
    }
  }
  return out;
}
var globRegexCache = new Map;
function globToRegExp(pattern) {
  const cached = globRegexCache.get(pattern);
  if (cached !== undefined)
    return cached;
  const source = translateGlob(pattern);
  const anchored = pattern.includes("/");
  const prefix = anchored ? "^" : "(?:^|/)";
  let re;
  try {
    re = new RegExp(prefix + source + "$");
  } catch {
    re = /$^/;
  }
  globRegexCache.set(pattern, re);
  return re;
}
function strictGlobToRegExp(pattern, anchored = pattern.includes("/")) {
  return new RegExp((anchored ? "^" : "(?:^|/)") + translateGlob(pattern, true) + "$");
}
function matchGlob(pattern, relPathFwd) {
  return globToRegExp(pattern).test(relPathFwd);
}
var MAX_WALK_ENTRIES = 200000;
var MAX_FILE_BYTES = 8 * 1024 * 1024;
var BINARY_SNIFF_BYTES = 8 * 1024;

// src/search-authorized.ts
var slash = (s) => s.split(sep).join("/");
var contains = (root, path) => {
  const r = relative(root, path);
  return r === "" || !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep);
};
var git = (p) => slash(p).split("/").some((part) => part === ".git" || process.platform === "win32" && part.toLowerCase() === ".git");
function ambiguousSearchPath(path) {
  return path.startsWith("~") || /^\\\\[?.]\\/.test(path) || process.platform === "win32" && /^\/(?:[a-z]:?|cygdrive\/[a-z]|mnt\/[a-z])(?:\/|$)/i.test(path) || /^[^/\\:]+:/.test(path) && !(process.platform === "win32" && /^[a-z]:[/\\]/i.test(path));
}
function parseGlobalExcludes(bytes) {
  for (const line of bytes.toString("utf8").split(String.fromCharCode(10))) {
    const value = line.trim();
    if (/^[#;]/.test(value) || !/excludesfile/i.test(value))
      continue;
    const match = /^excludesfile\s*=\s*(?:"([^"\s]+)"|([^"\s]+))$/i.exec(value);
    if (!match)
      throw new Error("Ambiguous global ignore config");
    const path = match[1] ?? match[2];
    if (path.includes("~") && !(path.startsWith("~/") && !path.slice(1).includes("~")))
      throw new Error("Ambiguous global ignore tilde expansion");
    return path;
  }
  return;
}
function jsGrep(bytes, input) {
  if (bytes.subarray(0, 8192).includes(0))
    return [];
  const pattern = input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
  const regex = new RegExp(pattern, input.caseSensitive === false ? "giu" : "gu");
  const lines = bytes.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  const result = [];
  for (let i = 0;i < lines.length; i++) {
    const text = lines[i];
    const body = text.replace(/\r?\n$/, "");
    const submatches = [];
    for (const m of body.matchAll(regex)) {
      const start = Buffer.byteLength(body.slice(0, m.index));
      submatches.push({ text: m[0], start, end: start + Buffer.byteLength(m[0]) });
      if (submatches.length === 100)
        break;
    }
    if (submatches.length)
      result.push({ line: i + 1, offset, text: text.length > 2000 ? text.slice(0, 2000) + "..." : text, submatches });
    if (result.length >= (input.limit ?? 100))
      break;
    offset += Buffer.byteLength(text);
  }
  return result;
}
async function authorizedSearch(kind, input, invocation, directory, project, seams) {
  const source = { type: "tool", messageID: invocation.messageID, id: invocation.id };
  const permission = { sessionID: invocation.sessionID, agent: invocation.agent, source };
  if (!invocation.sessionID || !invocation.agent || !invocation.messageID || !invocation.id)
    throw new Error("Search invocation context unavailable");
  const path = kind === "glob" && (input.path === "undefined" || input.path === "null") ? undefined : input.path;
  if (path && ambiguousSearchPath(path))
    throw new Error("Search path cannot be resolved in the local environment");
  if (kind === "grep" && !input.pattern || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
    throw new Error("Invalid search input");
  if (kind === "glob")
    strictGlobToRegExp(input.pattern);
  if (input.include)
    strictGlobToRegExp(input.include);
  const root = resolve(directory, path ?? ".");
  const checked = new Set, outside = new Set, skipped = new Set;
  const internal = (p) => contains(directory, p) || project !== parse(project).root && contains(project, p);
  async function authorize(p, dir, report = true) {
    if (internal(p))
      return true;
    const boundary = dir ? p : dirname(p);
    const resource = slash(join(boundary, "*"));
    if (checked.has(resource)) {
      if (report)
        outside.add(p);
      return true;
    }
    await seams.assert({ ...permission, action: "external_directory", resources: [resource], save: [resource] });
    checked.add(resource);
    if (report)
      outside.add(p);
    return true;
  }
  const rootReal = seams.realpath(root);
  const rootDir = seams.stat(rootReal).isDirectory();
  await authorize(root, kind === "glob" || rootDir);
  await seams.assert({ ...permission, action: kind, resources: [input.pattern], save: ["*"], metadata: kind === "grep" ? { root: ".", path, include: input.include, literal: input.literal, caseSensitive: input.caseSensitive, limit: input.limit } : { root: path ?? ".", path, hidden: input.hidden, limit: input.limit } });
  const records = [];
  const limit = input.limit ?? 100;
  const recordCap = Math.min(limit + 1, Number.MAX_SAFE_INTEGER);
  const recorded = new Map;
  const keyOf = (r) => JSON.stringify([r.real, r.match?.line]);
  const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.match?.line ?? 0) - (b.match?.line ?? 0);
  const positions = new Map;
  function swap(a, b) {
    const x = records[a], y = records[b];
    records[a] = y;
    records[b] = x;
    positions.set(x, b);
    positions.set(y, a);
  }
  function down(i) {
    while (2 * i + 1 < records.length) {
      let j = 2 * i + 1;
      if (j + 1 < records.length && compare(records[j + 1], records[j]) > 0)
        j++;
      if (compare(records[i], records[j]) >= 0)
        break;
      swap(i, j);
      i = j;
    }
  }
  let duplicates = 0, collectionCapped = false;
  function record2(path2, real, match) {
    const value = { path: path2, real, match }, key = keyOf(value);
    const previous = recorded.get(key);
    if (previous) {
      duplicates++;
      if (path2 < previous.path) {
        previous.path = path2;
        down(positions.get(previous));
      }
      return;
    }
    if (records.length >= recordCap) {
      collectionCapped = true;
      if (compare(value, records[0]) >= 0)
        return;
      const removed = records[0];
      recorded.delete(keyOf(removed));
      positions.delete(removed);
      records[0] = value;
      positions.set(value, 0);
      recorded.set(key, value);
      down(0);
      return;
    }
    recorded.set(key, value);
    let i = records.length;
    records.push(value);
    positions.set(value, i);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (compare(records[parent], value) >= 0)
        break;
      swap(i, parent);
      i = parent;
    }
  }
  const ancestors = new Set;
  let visited = 0, capped = false;
  const hidden = kind === "grep" || input.hidden !== false;
  const follow = input.follow !== false;
  const equal = (a, b) => normalize(a) === normalize(b);
  function ignored(rules, logical, directory2, anyGit2) {
    let excluded = false;
    for (const rule of rules) {
      if (rule.global && !anyGit2)
        continue;
      const path2 = slash(relative(rule.base, logical));
      if (rule.directory && !directory2)
        continue;
      if (rule.matcher.test(path2))
        excluded = !rule.negate;
    }
    return excluded;
  }
  function parseIgnoreRules(bytes, logical, rules) {
    for (let line of bytes.toString("utf8").split(/\r?\n/)) {
      line = line.trimEnd();
      if (!line || line.startsWith("#"))
        continue;
      const negate = line.startsWith("!");
      if (negate)
        line = line.slice(1);
      const directory2 = line.endsWith("/");
      if (directory2)
        line = line.slice(0, -1);
      const anchored = line.startsWith("/") || line.includes("/");
      if (line.startsWith("/"))
        line = line.slice(1);
      if (line) {
        try {
          rules.push({ base: logical, matcher: strictGlobToRegExp(line, anchored), negate, directory: directory2 });
        } catch {}
      }
    }
  }
  function loadIgnoreRules(logical, real, entries, rules) {
    if (kind === "grep" && !input.include) {
      for (const ignoreName of [".gitignore", ".ignore", ".rgignore"]) {
        if (!entries.includes(ignoreName))
          continue;
        const ignorePath = join(real, ignoreName);
        try {
          const info = seams.stat(ignorePath);
          if (info.isSymbolicLink() || !info.isFile() || seams.realpath(ignorePath) !== ignorePath || (info.size ?? 0) > MAX_FILE_BYTES)
            continue;
          const bytes = seams.read(ignorePath);
          if (bytes.length > MAX_FILE_BYTES)
            continue;
          parseIgnoreRules(bytes, logical, rules);
        } catch {}
      }
    }
  }
  async function visit(logical, candidate, explicit = false, rules = [], globMatch, anyGit2 = false) {
    if (++visited > MAX_WALK_ENTRIES) {
      capped = true;
      return;
    }
    if (git(logical) || git(candidate))
      return;
    const name = relative(root, logical) || relative(dirname(root), logical);
    if (!explicit && !hidden && name.split(sep).some((s) => s.startsWith(".")))
      return;
    let real, st;
    try {
      const lexical = seams.stat(candidate);
      if (lexical.isSymbolicLink() && !follow && !explicit)
        return;
      real = seams.realpath(candidate);
      if (git(real))
        return;
      st = seams.stat(real);
    } catch {
      return;
    }
    try {
      await authorize(real, st.isDirectory());
    } catch (error) {
      if (explicit || !(error instanceof Error) || !(["Tool.Error", "ToolError"].includes(error.name) || error._tag === "Tool.Error"))
        throw error;
      skipped.add(real);
      return;
    }
    try {
      if (!equal(seams.realpath(candidate), real) || !equal(seams.realpath(real), real)) {
        skipped.add(logical);
        return;
      }
    } catch {
      skipped.add(logical);
      return;
    }
    if (explicit && kind === "glob" && !st.isDirectory())
      throw new Error("Search path is not a directory");
    if (!explicit && ignored(rules, logical, st.isDirectory(), anyGit2) && (st.isDirectory() || kind === "grep" && !input.include))
      return;
    if (st.isDirectory()) {
      if (ancestors.has(real))
        return;
      ancestors.add(real);
      try {
        let entries;
        try {
          entries = seams.list(real).sort();
        } catch {
          return;
        }
        anyGit2 ||= entries.includes(".git");
        const localRules = [...rules];
        loadIgnoreRules(logical, real, entries, localRules);
        const matches = kind === "glob" && seams.glob ? seams.glob(input.pattern, entries.map((entry) => slash(relative(root, join(logical, entry))))) : undefined;
        for (let i = 0;i < entries.length; i++) {
          if (capped)
            break;
          const entry = entries[i];
          await visit(join(logical, entry), join(real, entry), false, localRules, matches?.[i], anyGit2);
        }
      } finally {
        ancestors.delete(real);
      }
    } else if (st.isFile()) {
      if (kind === "glob") {
        if (globMatch ?? matchGlob(input.pattern, slash(name)))
          record2(logical, real);
      } else if (!input.include || matchGlob(input.include, slash(name))) {
        if (typeof st.size === "number" && st.size > MAX_FILE_BYTES) {
          skipped.add(logical);
          return;
        }
        let bytes;
        try {
          bytes = seams.read(real);
        } catch {
          return;
        }
        if (bytes.length > MAX_FILE_BYTES) {
          skipped.add(logical);
          return;
        }
        for (const match of (seams.grep ?? jsGrep)(bytes, { ...input, limit: recordCap + 1 })) {
          record2(logical, real, match);
        }
      }
    }
  }
  if (kind === "glob" && !rootDir)
    throw new Error("Search path is not a directory");
  const inherited = [];
  let anyGit = false;
  if (kind === "grep" && !input.include) {
    if (seams.globalIgnore) {
      const source2 = seams.globalIgnore;
      const cwd = rootDir ? root : dirname(root);
      for (let p = cwd;; p = dirname(p)) {
        try {
          const marker = seams.stat(join(p, ".git"));
          if (marker.isFile() || marker.isDirectory() || marker.isSymbolicLink()) {
            anyGit = true;
            break;
          }
        } catch {}
        if (p === dirname(p))
          break;
      }
      async function readOptional(path2) {
        try {
          seams.stat(path2);
        } catch (error) {
          if (error.code === "ENOENT")
            return;
          throw error;
        }
        await authorize(path2, false, false);
        const real = seams.realpath(path2);
        await authorize(real, false, false);
        const st = seams.stat(real);
        if (!st.isFile() || (st.size ?? 0) > MAX_FILE_BYTES || !equal(seams.realpath(path2), real))
          throw new Error("Global ignore source unavailable");
        const bytes = seams.read(real);
        if (bytes.length > MAX_FILE_BYTES || !equal(seams.realpath(path2), real))
          throw new Error("Global ignore source changed");
        return bytes;
      }
      try {
        if (!isAbsolute(source2.home) || source2.xdg && !isAbsolute(source2.xdg))
          throw new Error("Unknown global ignore environment");
        const configDir = source2.xdg || join(source2.home, ".config");
        let excludes;
        for (const config of [join(source2.home, ".gitconfig"), join(configDir, "git", "config")]) {
          const bytes2 = await readOptional(config);
          if (bytes2 !== undefined)
            excludes = (source2.parseConfig ?? parseGlobalExcludes)(bytes2);
          if (excludes !== undefined)
            break;
        }
        const file = excludes === undefined ? join(configDir, "git", "ignore") : excludes.startsWith("~/") ? resolve(source2.home, excludes.slice(2)) : resolve(cwd, excludes);
        if (excludes !== undefined && (!excludes || ambiguousSearchPath(excludes) && !excludes.startsWith("~/")))
          throw new Error("Unknown global ignore path");
        const bytes = await readOptional(file);
        if (bytes !== undefined) {
          parseIgnoreRules(bytes, cwd, inherited);
          for (const rule of inherited)
            rule.global = true;
        }
      } catch (error) {
        if (seams.delegateNative)
          return seams.delegateNative();
        throw error;
      }
    }
    const parents = [];
    for (let p = dirname(root);p !== dirname(p) && internal(p); p = dirname(p))
      parents.unshift(p);
    for (const p of parents) {
      try {
        if (seams.realpath(p) !== p)
          continue;
        loadIgnoreRules(p, p, seams.list(p), inherited);
      } catch {}
    }
  }
  await visit(root, root, true, inherited, undefined, anyGit);
  records.sort(compare);
  const shown = records.slice(0, limit), truncated = records.length > shown.length || capped || collectionCapped;
  const outputRoot = path !== undefined && rootDir ? root : directory;
  const displayPath = (p) => path !== undefined && rootDir ? relative(root, p) : p;
  const output = shown.map((r) => {
    const entry = { path: relative(outputRoot, r.path), type: "file" };
    return r.match ? { entry, ...r.match } : entry;
  });
  const lines = kind === "grep" ? [shown.length ? `Found ${shown.length} matches` : "No matches found"] : shown.length ? [] : ["No files found"];
  let current = "";
  for (const r of shown) {
    if (!r.match)
      lines.push(displayPath(r.path));
    else {
      if (current !== r.path) {
        if (current)
          lines.push("");
        lines.push(displayPath(r.path) + ":");
        current = r.path;
      }
      lines.push(`  Line ${r.match.line}: ${r.match.text}`);
    }
  }
  if (truncated)
    lines.push("", `(Results are truncated: showing first ${shown.length} results. Consider using a more specific path or pattern.)`);
  for (const p of outside)
    lines.push(`outside-workspace target searched: ${p}`);
  for (const p of skipped)
    lines.push(`skipped target: ${p}`);
  if (duplicates)
    lines.push(`+${duplicates} duplicate paths merged`);
  lines.push(`(forge search: ${seams.engine?.() ?? ((kind === "grep" ? seams.grep : seams.glob) ? "ripgrep" : "builtin-js")})`);
  return { output, content: lines.join(`
`), metadata: { [kind === "grep" ? "matches" : "count"]: shown.length, truncated } };
}

// src/search-core.ts
import { join as winJoin } from "node:path";
import { join as posixJoin } from "node:path/posix";
import { existsSync as fsExistsSync } from "node:fs";
var RG_MISSING_REMEDIES = "install ripgrep (or set search.rgPath in forge config to an existing rg binary), or fall back to the builtin grep/glob tools for this search";
function resolveRgBinary(config, seams) {
  const platform = seams?.platform ?? process.platform;
  const sep2 = seams?.pathSep ?? (platform === "win32" ? ";" : ":");
  const exists = seams?.existsSync ?? fsExistsSync;
  const pathEnv = seams?.pathEnv ?? (process.env.PATH ?? "");
  if (typeof config?.rgPath === "string" && config.rgPath.length > 0 && exists(config.rgPath)) {
    return { ok: true, binary: config.rgPath, source: "config" };
  }
  const exe = platform === "win32" ? "rg.exe" : "rg";
  const join2 = platform === "win32" ? winJoin : posixJoin;
  for (const dir of pathEnv.split(sep2)) {
    if (dir.length === 0)
      continue;
    const candidate = join2(dir, exe);
    if (exists(candidate))
      return { ok: true, binary: candidate, source: "path" };
  }
  return {
    ok: false,
    error: `ripgrep (rg) not found — ${RG_MISSING_REMEDIES}`
  };
}

// plugin.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

// src/goal-activity.ts
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
function hasIdleBackgroundShell(raw, sessionID) {
  const background = raw?.background;
  return Array.isArray(background) && background.some((entry) => {
    if (!entry || typeof entry !== "object")
      return false;
    const e = entry;
    return e.kind === "shell" && e.sessionID === sessionID && typeof e.shellID === "string" && e.shellID.length > 0 && typeof e.command === "string";
  });
}
function idleBackgroundKnown(raw) {
  const background = raw?.background;
  return Array.isArray(background) && background.every((entry) => {
    if (!entry || typeof entry !== "object")
      return false;
    const e = entry;
    return e.kind === "shell" && typeof e.sessionID === "string" && typeof e.shellID === "string" && !!e.shellID && typeof e.command === "string";
  });
}
function settledGoalRounds(rounds, context) {
  const object = (x) => x && typeof x === "object" ? x : {};
  const messages = object(context).data ?? context;
  const settled = new Set;
  if (!Array.isArray(messages))
    return settled;
  const created = (m) => object(object(m).time).created;
  if (!messages.every((m) => typeof created(m) === "number"))
    return settled;
  const current = new Map;
  const ambiguous = new Set, seen = new Set;
  for (const raw of [...messages].sort((a, b) => Number(created(a)) - Number(created(b)))) {
    const m = object(raw);
    if (m.type === "assistant" && Array.isArray(m.content))
      for (const rawPart of m.content) {
        const p = object(rawPart), state = object(p.state), meta2 = object(state.metadata);
        const id2 = p.callID ?? p.id, child2 = meta2.sessionID;
        if (p.type !== "tool" || p.name !== "subagent" || state.status !== "completed" || typeof id2 !== "string" || typeof child2 !== "string")
          continue;
        if (rounds.has(id2) && rounds.get(id2) !== child2) {
          ambiguous.add(child2);
          continue;
        }
        const previous = current.get(child2);
        if (previous && previous !== id2 && !settled.has(previous))
          ambiguous.add(child2);
        current.set(child2, id2);
      }
    if (m.type !== "synthetic" || typeof m.id !== "string" || seen.has(m.id))
      continue;
    seen.add(m.id);
    const meta = object(m.metadata), child = meta.childID;
    if (meta.source !== "subagent" || typeof child !== "string" || ambiguous.has(child))
      continue;
    const id = current.get(child);
    if (!id || settled.has(id) || typeof m.text !== "string")
      continue;
    const match = /^<background-result kind="subagent" sessionID="([^"]+)" state="(completed|error|cancelled)" description="[^"]*">[\s\S]*<\/background-result>$/.exec(m.text);
    if (match && match[1] === child && match[2] === meta.state)
      settled.add(id);
  }
  return settled;
}
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function singleText(content) {
  if (!Array.isArray(content) || content.length !== 1)
    return;
  const part = record2(content[0]);
  return part?.type === "text" && typeof part.text === "string" ? part.text : undefined;
}
function checkInput(value) {
  const input = record2(value);
  if (!input)
    return;
  if (!Object.keys(input).length)
    return "{}";
  if (Object.keys(input).length !== 1 || !Array.isArray(input.items) || !input.items.every((n) => Number.isSafeInteger(n) && n > 0))
    return;
  return JSON.stringify({ items: input.items });
}
function completeResult(result) {
  const metadata = record2(result?.metadata);
  return !!result && [result.truncated, metadata?.truncated, result.error, metadata?.error].every((t) => t === undefined || t === false) && result.status !== "error" && metadata?.status !== "error";
}
function singleCompletedCheck(calls) {
  if (!Array.isArray(calls) || calls.length !== 1)
    return;
  const call = record2(calls[0]);
  return call?.tool === "goal_check" && call.status === "completed" ? checkInput(call.input) : undefined;
}
function consumeCheckWrapper(act, id, result, event) {
  const r = record2(result), output = record2(r?.output), metadata = record2(r?.metadata);
  if (!id || !event?.messageID || event.status !== "completed" || event.codemode !== false || !completeResult(r) || !completeResult(output))
    return false;
  if (!Array.isArray(output?.files) || output.files.length !== 0 || typeof output.output !== "string" || singleText(r?.content) !== output.output)
    return false;
  const input = singleCompletedCheck(metadata?.toolCalls);
  if (input === undefined || input !== singleCompletedCheck(output.toolCalls))
    return false;
  const matches = act.checkReceipts?.filter((p) => p.id !== id && p.messageID === event.messageID && p.input === input && p.output === output.output);
  if (matches?.length !== 1)
    return false;
  act.checkReceipts.splice(act.checkReceipts.indexOf(matches[0]), 1);
  return true;
}
function wrapperOtherActivity(result, event) {
  const r = record2(result), output = record2(r?.output), metadata = record2(r?.metadata);
  if (event?.status !== "completed" || !completeResult(r) || !completeResult(output))
    return false;
  const calls = metadata?.toolCalls;
  if (!Array.isArray(calls) || !isDeepStrictEqual(calls, output?.toolCalls))
    return false;
  return calls.some((raw) => {
    const call = record2(raw);
    return typeof call?.tool === "string" && call.tool !== "goal_check" && call.status === "completed";
  }) || Array.isArray(output?.files) && output.files.length > 0;
}
function rememberGoalCheck(act, selected, outcomes, output) {
  const complete = selected.length === outcomes.length && outcomes.every((o, i) => o.index === selected[i].n && o.comparable !== undefined);
  const evidence = complete ? createHash("sha256").update(JSON.stringify([act.scope, selected, outcomes.map((o) => o.comparable)])).digest("hex") : undefined;
  (act.goalChecks ??= []).push({ output, evidence });
}
function observeGoalActivity(act, tool, write, id, args, result, event) {
  if (tool === "subagent") {
    const r2 = record2(result), m2 = record2(r2?.metadata);
    if (!id || m2?.status !== "running" || typeof m2.sessionID !== "string" || !m2.sessionID || r2?.status === "error" || event?.status !== undefined && event.status !== "completed") {
      act.uncertain = true;
      return;
    }
  }
  if (id) {
    const key = JSON.stringify([event?.messageID, id, tool]);
    const observation = [args, result, event, write];
    const seen = act.seen ??= new Map;
    if (seen.has(key)) {
      if (!isDeepStrictEqual(seen.get(key), observation))
        act.uncertain = true;
      return;
    }
    for (const previous of seen.keys()) {
      const [messageID, callID, name] = JSON.parse(previous);
      if (messageID === (event?.messageID ?? null) && callID === id && name !== tool)
        act.uncertain = true;
    }
    try {
      seen.set(key, structuredClone(observation));
    } catch {
      act.uncertain = true;
    }
  }
  if (tool === "subagent") {
    act.dispatches = (act.dispatches ?? 0) + 1;
    if (write)
      act.writes++;
    act.other = true;
    return;
  }
  const check = ["goal_check", "shell", "bash"].includes(tool);
  if (write || tool === "plan_tick")
    act.writes++;
  if (check)
    act.checks++;
  if (!check) {
    if (tool === "execute" && !write) {
      if (consumeCheckWrapper(act, id, result, event))
        return;
      if (wrapperOtherActivity(result, event))
        act.other = true;
      else
        act.uncertain = true;
      return;
    }
    act.other = true;
    return;
  }
  const a = args;
  const r = result;
  const m = r?.metadata;
  if (tool === "goal_check") {
    const content = r?.output ?? r?.content;
    const output = typeof content === "string" ? content : singleText(content);
    const matches = act.goalChecks?.filter((pending2) => pending2.output === output);
    const pending = matches?.length === 1 ? matches[0] : undefined;
    const completed = event?.status === "completed" || typeof content === "string" && event?.status === undefined;
    if (pending && typeof output === "string" && completeResult(r) && completed) {
      act.goalChecks.splice(act.goalChecks.indexOf(pending), 1);
      if (pending.evidence) {
        (act.evidence ??= []).push(pending.evidence);
        const input = checkInput(args);
        if (event?.codemode === true) {
          if (id && event.messageID && event.status === "completed" && r?.output === undefined && singleText(r?.content) === output && input !== undefined) {
            (act.checkReceipts ??= []).push({ id, messageID: event.messageID, input, output });
          } else
            act.uncertain = true;
        } else if (event?.codemode !== false && typeof content !== "string")
          act.uncertain = true;
      } else
        act.uncertain = true;
    } else {
      act.uncertain = true;
    }
    return;
  }
  const command = a?.command ?? a?.cmd;
  const verification = typeof command === "string" && /^(?:npm test|npm run (?:test|typecheck)|npx tsc --noEmit|pytest)(?: -- [\w .-]+)?$/.test(command);
  if (!verification) {
    act.other = true;
    return;
  }
  if (!a || !Object.keys(a).length || !completeResult(r) || typeof r?.output !== "string" || m?.truncated !== false || !Number.isInteger(m.exitCode) || event?.status !== undefined && event.status !== "completed") {
    act.uncertain = true;
    return;
  }
  try {
    (act.evidence ??= []).push(JSON.stringify([act.scope, tool, a, m.exitCode, r.output]));
  } catch {
    act.uncertain = true;
  }
}
function classifyGoalActivity(act, previous) {
  if (!act)
    return { activity: false, repeated: false, uncertain: true };
  if (act.other)
    return { activity: true, repeated: false };
  if (act.uncertain || act.goalChecks?.length || act.checkReceipts?.length)
    return { activity: false, repeated: false, uncertain: true };
  if (act.evidence?.length) {
    const evidence = JSON.stringify(act.evidence);
    return { activity: evidence !== previous, repeated: evidence === previous, evidence };
  }
  return { activity: act.writes > 0 || act.checks > 0, repeated: false };
}

// node_modules/zod/v4/classic/external.js
var exports_external = {};
__export(exports_external, {
  xid: () => xid2,
  void: () => _void2,
  uuidv7: () => uuidv7,
  uuidv6: () => uuidv6,
  uuidv4: () => uuidv4,
  uuid: () => uuid2,
  util: () => exports_util,
  url: () => url,
  uppercase: () => _uppercase,
  unknown: () => unknown,
  union: () => union,
  undefined: () => _undefined3,
  ulid: () => ulid2,
  uint64: () => uint64,
  uint32: () => uint32,
  tuple: () => tuple,
  trim: () => _trim,
  treeifyError: () => treeifyError,
  transform: () => transform,
  toUpperCase: () => _toUpperCase,
  toLowerCase: () => _toLowerCase,
  toJSONSchema: () => toJSONSchema,
  templateLiteral: () => templateLiteral,
  symbol: () => symbol,
  superRefine: () => superRefine,
  success: () => success,
  stringbool: () => stringbool,
  stringFormat: () => stringFormat,
  string: () => string2,
  strictObject: () => strictObject,
  startsWith: () => _startsWith,
  size: () => _size,
  setErrorMap: () => setErrorMap,
  set: () => set,
  safeParseAsync: () => safeParseAsync2,
  safeParse: () => safeParse2,
  safeEncodeAsync: () => safeEncodeAsync2,
  safeEncode: () => safeEncode2,
  safeDecodeAsync: () => safeDecodeAsync2,
  safeDecode: () => safeDecode2,
  registry: () => registry,
  regexes: () => exports_regexes,
  regex: () => _regex,
  refine: () => refine,
  record: () => record3,
  readonly: () => readonly,
  property: () => _property,
  promise: () => promise,
  prettifyError: () => prettifyError,
  preprocess: () => preprocess,
  prefault: () => prefault,
  positive: () => _positive,
  pipe: () => pipe,
  partialRecord: () => partialRecord,
  parseAsync: () => parseAsync2,
  parse: () => parse4,
  overwrite: () => _overwrite,
  optional: () => optional,
  object: () => object,
  number: () => number2,
  nullish: () => nullish2,
  nullable: () => nullable,
  null: () => _null3,
  normalize: () => _normalize,
  nonpositive: () => _nonpositive,
  nonoptional: () => nonoptional,
  nonnegative: () => _nonnegative,
  never: () => never,
  negative: () => _negative,
  nativeEnum: () => nativeEnum,
  nanoid: () => nanoid2,
  nan: () => nan,
  multipleOf: () => _multipleOf,
  minSize: () => _minSize,
  minLength: () => _minLength,
  mime: () => _mime,
  maxSize: () => _maxSize,
  maxLength: () => _maxLength,
  map: () => map,
  lte: () => _lte,
  lt: () => _lt,
  lowercase: () => _lowercase,
  looseObject: () => looseObject,
  locales: () => exports_locales,
  literal: () => literal,
  length: () => _length,
  lazy: () => lazy,
  ksuid: () => ksuid2,
  keyof: () => keyof,
  jwt: () => jwt,
  json: () => json,
  iso: () => exports_iso,
  ipv6: () => ipv62,
  ipv4: () => ipv42,
  intersection: () => intersection,
  int64: () => int64,
  int32: () => int32,
  int: () => int,
  instanceof: () => _instanceof,
  includes: () => _includes,
  httpUrl: () => httpUrl,
  hostname: () => hostname2,
  hex: () => hex2,
  hash: () => hash,
  guid: () => guid2,
  gte: () => _gte,
  gt: () => _gt,
  globalRegistry: () => globalRegistry,
  getErrorMap: () => getErrorMap,
  function: () => _function,
  formatError: () => formatError,
  float64: () => float64,
  float32: () => float32,
  flattenError: () => flattenError,
  file: () => file,
  enum: () => _enum2,
  endsWith: () => _endsWith,
  encodeAsync: () => encodeAsync2,
  encode: () => encode2,
  emoji: () => emoji2,
  email: () => email2,
  e164: () => e1642,
  discriminatedUnion: () => discriminatedUnion,
  decodeAsync: () => decodeAsync2,
  decode: () => decode2,
  date: () => date3,
  custom: () => custom,
  cuid2: () => cuid22,
  cuid: () => cuid3,
  core: () => exports_core2,
  config: () => config,
  coerce: () => exports_coerce,
  codec: () => codec,
  clone: () => clone,
  cidrv6: () => cidrv62,
  cidrv4: () => cidrv42,
  check: () => check,
  catch: () => _catch2,
  boolean: () => boolean2,
  bigint: () => bigint2,
  base64url: () => base64url2,
  base64: () => base642,
  array: () => array,
  any: () => any,
  _function: () => _function,
  _default: () => _default2,
  _ZodString: () => _ZodString,
  ZodXID: () => ZodXID,
  ZodVoid: () => ZodVoid,
  ZodUnknown: () => ZodUnknown,
  ZodUnion: () => ZodUnion,
  ZodUndefined: () => ZodUndefined,
  ZodUUID: () => ZodUUID,
  ZodURL: () => ZodURL,
  ZodULID: () => ZodULID,
  ZodType: () => ZodType,
  ZodTuple: () => ZodTuple,
  ZodTransform: () => ZodTransform,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodSymbol: () => ZodSymbol,
  ZodSuccess: () => ZodSuccess,
  ZodStringFormat: () => ZodStringFormat,
  ZodString: () => ZodString,
  ZodSet: () => ZodSet,
  ZodRecord: () => ZodRecord,
  ZodRealError: () => ZodRealError,
  ZodReadonly: () => ZodReadonly,
  ZodPromise: () => ZodPromise,
  ZodPrefault: () => ZodPrefault,
  ZodPipe: () => ZodPipe,
  ZodOptional: () => ZodOptional,
  ZodObject: () => ZodObject,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodNumber: () => ZodNumber,
  ZodNullable: () => ZodNullable,
  ZodNull: () => ZodNull,
  ZodNonOptional: () => ZodNonOptional,
  ZodNever: () => ZodNever,
  ZodNanoID: () => ZodNanoID,
  ZodNaN: () => ZodNaN,
  ZodMap: () => ZodMap,
  ZodLiteral: () => ZodLiteral,
  ZodLazy: () => ZodLazy,
  ZodKSUID: () => ZodKSUID,
  ZodJWT: () => ZodJWT,
  ZodIssueCode: () => ZodIssueCode,
  ZodIntersection: () => ZodIntersection,
  ZodISOTime: () => ZodISOTime,
  ZodISODuration: () => ZodISODuration,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODate: () => ZodISODate,
  ZodIPv6: () => ZodIPv6,
  ZodIPv4: () => ZodIPv4,
  ZodGUID: () => ZodGUID,
  ZodFunction: () => ZodFunction,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFile: () => ZodFile,
  ZodError: () => ZodError,
  ZodEnum: () => ZodEnum,
  ZodEmoji: () => ZodEmoji,
  ZodEmail: () => ZodEmail,
  ZodE164: () => ZodE164,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodDefault: () => ZodDefault,
  ZodDate: () => ZodDate,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodCustom: () => ZodCustom,
  ZodCodec: () => ZodCodec,
  ZodCatch: () => ZodCatch,
  ZodCUID2: () => ZodCUID2,
  ZodCUID: () => ZodCUID,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodBoolean: () => ZodBoolean,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBigInt: () => ZodBigInt,
  ZodBase64URL: () => ZodBase64URL,
  ZodBase64: () => ZodBase64,
  ZodArray: () => ZodArray,
  ZodAny: () => ZodAny,
  TimePrecision: () => TimePrecision,
  NEVER: () => NEVER,
  $output: () => $output,
  $input: () => $input,
  $brand: () => $brand
});

// node_modules/zod/v4/core/index.js
var exports_core2 = {};
__export(exports_core2, {
  version: () => version,
  util: () => exports_util,
  treeifyError: () => treeifyError,
  toJSONSchema: () => toJSONSchema,
  toDotPath: () => toDotPath,
  safeParseAsync: () => safeParseAsync,
  safeParse: () => safeParse,
  safeEncodeAsync: () => safeEncodeAsync,
  safeEncode: () => safeEncode,
  safeDecodeAsync: () => safeDecodeAsync,
  safeDecode: () => safeDecode,
  registry: () => registry,
  regexes: () => exports_regexes,
  prettifyError: () => prettifyError,
  parseAsync: () => parseAsync,
  parse: () => parse2,
  locales: () => exports_locales,
  isValidJWT: () => isValidJWT,
  isValidBase64URL: () => isValidBase64URL,
  isValidBase64: () => isValidBase64,
  globalRegistry: () => globalRegistry,
  globalConfig: () => globalConfig,
  formatError: () => formatError,
  flattenError: () => flattenError,
  encodeAsync: () => encodeAsync,
  encode: () => encode,
  decodeAsync: () => decodeAsync,
  decode: () => decode,
  config: () => config,
  clone: () => clone,
  _xid: () => _xid,
  _void: () => _void,
  _uuidv7: () => _uuidv7,
  _uuidv6: () => _uuidv6,
  _uuidv4: () => _uuidv4,
  _uuid: () => _uuid,
  _url: () => _url,
  _uppercase: () => _uppercase,
  _unknown: () => _unknown,
  _union: () => _union,
  _undefined: () => _undefined2,
  _ulid: () => _ulid,
  _uint64: () => _uint64,
  _uint32: () => _uint32,
  _tuple: () => _tuple,
  _trim: () => _trim,
  _transform: () => _transform,
  _toUpperCase: () => _toUpperCase,
  _toLowerCase: () => _toLowerCase,
  _templateLiteral: () => _templateLiteral,
  _symbol: () => _symbol,
  _superRefine: () => _superRefine,
  _success: () => _success,
  _stringbool: () => _stringbool,
  _stringFormat: () => _stringFormat,
  _string: () => _string,
  _startsWith: () => _startsWith,
  _size: () => _size,
  _set: () => _set,
  _safeParseAsync: () => _safeParseAsync,
  _safeParse: () => _safeParse,
  _safeEncodeAsync: () => _safeEncodeAsync,
  _safeEncode: () => _safeEncode,
  _safeDecodeAsync: () => _safeDecodeAsync,
  _safeDecode: () => _safeDecode,
  _regex: () => _regex,
  _refine: () => _refine,
  _record: () => _record,
  _readonly: () => _readonly,
  _property: () => _property,
  _promise: () => _promise,
  _positive: () => _positive,
  _pipe: () => _pipe,
  _parseAsync: () => _parseAsync,
  _parse: () => _parse,
  _overwrite: () => _overwrite,
  _optional: () => _optional,
  _number: () => _number,
  _nullable: () => _nullable,
  _null: () => _null2,
  _normalize: () => _normalize,
  _nonpositive: () => _nonpositive,
  _nonoptional: () => _nonoptional,
  _nonnegative: () => _nonnegative,
  _never: () => _never,
  _negative: () => _negative,
  _nativeEnum: () => _nativeEnum,
  _nanoid: () => _nanoid,
  _nan: () => _nan,
  _multipleOf: () => _multipleOf,
  _minSize: () => _minSize,
  _minLength: () => _minLength,
  _min: () => _gte,
  _mime: () => _mime,
  _maxSize: () => _maxSize,
  _maxLength: () => _maxLength,
  _max: () => _lte,
  _map: () => _map,
  _lte: () => _lte,
  _lt: () => _lt,
  _lowercase: () => _lowercase,
  _literal: () => _literal,
  _length: () => _length,
  _lazy: () => _lazy,
  _ksuid: () => _ksuid,
  _jwt: () => _jwt,
  _isoTime: () => _isoTime,
  _isoDuration: () => _isoDuration,
  _isoDateTime: () => _isoDateTime,
  _isoDate: () => _isoDate,
  _ipv6: () => _ipv6,
  _ipv4: () => _ipv4,
  _intersection: () => _intersection,
  _int64: () => _int64,
  _int32: () => _int32,
  _int: () => _int,
  _includes: () => _includes,
  _guid: () => _guid,
  _gte: () => _gte,
  _gt: () => _gt,
  _float64: () => _float64,
  _float32: () => _float32,
  _file: () => _file,
  _enum: () => _enum,
  _endsWith: () => _endsWith,
  _encodeAsync: () => _encodeAsync,
  _encode: () => _encode,
  _emoji: () => _emoji2,
  _email: () => _email,
  _e164: () => _e164,
  _discriminatedUnion: () => _discriminatedUnion,
  _default: () => _default,
  _decodeAsync: () => _decodeAsync,
  _decode: () => _decode,
  _date: () => _date,
  _custom: () => _custom,
  _cuid2: () => _cuid2,
  _cuid: () => _cuid,
  _coercedString: () => _coercedString,
  _coercedNumber: () => _coercedNumber,
  _coercedDate: () => _coercedDate,
  _coercedBoolean: () => _coercedBoolean,
  _coercedBigint: () => _coercedBigint,
  _cidrv6: () => _cidrv6,
  _cidrv4: () => _cidrv4,
  _check: () => _check,
  _catch: () => _catch,
  _boolean: () => _boolean,
  _bigint: () => _bigint,
  _base64url: () => _base64url,
  _base64: () => _base64,
  _array: () => _array,
  _any: () => _any,
  TimePrecision: () => TimePrecision,
  NEVER: () => NEVER,
  JSONSchemaGenerator: () => JSONSchemaGenerator,
  JSONSchema: () => exports_json_schema,
  Doc: () => Doc,
  $output: () => $output,
  $input: () => $input,
  $constructor: () => $constructor,
  $brand: () => $brand,
  $ZodXID: () => $ZodXID,
  $ZodVoid: () => $ZodVoid,
  $ZodUnknown: () => $ZodUnknown,
  $ZodUnion: () => $ZodUnion,
  $ZodUndefined: () => $ZodUndefined,
  $ZodUUID: () => $ZodUUID,
  $ZodURL: () => $ZodURL,
  $ZodULID: () => $ZodULID,
  $ZodType: () => $ZodType,
  $ZodTuple: () => $ZodTuple,
  $ZodTransform: () => $ZodTransform,
  $ZodTemplateLiteral: () => $ZodTemplateLiteral,
  $ZodSymbol: () => $ZodSymbol,
  $ZodSuccess: () => $ZodSuccess,
  $ZodStringFormat: () => $ZodStringFormat,
  $ZodString: () => $ZodString,
  $ZodSet: () => $ZodSet,
  $ZodRegistry: () => $ZodRegistry,
  $ZodRecord: () => $ZodRecord,
  $ZodRealError: () => $ZodRealError,
  $ZodReadonly: () => $ZodReadonly,
  $ZodPromise: () => $ZodPromise,
  $ZodPrefault: () => $ZodPrefault,
  $ZodPipe: () => $ZodPipe,
  $ZodOptional: () => $ZodOptional,
  $ZodObjectJIT: () => $ZodObjectJIT,
  $ZodObject: () => $ZodObject,
  $ZodNumberFormat: () => $ZodNumberFormat,
  $ZodNumber: () => $ZodNumber,
  $ZodNullable: () => $ZodNullable,
  $ZodNull: () => $ZodNull,
  $ZodNonOptional: () => $ZodNonOptional,
  $ZodNever: () => $ZodNever,
  $ZodNanoID: () => $ZodNanoID,
  $ZodNaN: () => $ZodNaN,
  $ZodMap: () => $ZodMap,
  $ZodLiteral: () => $ZodLiteral,
  $ZodLazy: () => $ZodLazy,
  $ZodKSUID: () => $ZodKSUID,
  $ZodJWT: () => $ZodJWT,
  $ZodIntersection: () => $ZodIntersection,
  $ZodISOTime: () => $ZodISOTime,
  $ZodISODuration: () => $ZodISODuration,
  $ZodISODateTime: () => $ZodISODateTime,
  $ZodISODate: () => $ZodISODate,
  $ZodIPv6: () => $ZodIPv6,
  $ZodIPv4: () => $ZodIPv4,
  $ZodGUID: () => $ZodGUID,
  $ZodFunction: () => $ZodFunction,
  $ZodFile: () => $ZodFile,
  $ZodError: () => $ZodError,
  $ZodEnum: () => $ZodEnum,
  $ZodEncodeError: () => $ZodEncodeError,
  $ZodEmoji: () => $ZodEmoji,
  $ZodEmail: () => $ZodEmail,
  $ZodE164: () => $ZodE164,
  $ZodDiscriminatedUnion: () => $ZodDiscriminatedUnion,
  $ZodDefault: () => $ZodDefault,
  $ZodDate: () => $ZodDate,
  $ZodCustomStringFormat: () => $ZodCustomStringFormat,
  $ZodCustom: () => $ZodCustom,
  $ZodCodec: () => $ZodCodec,
  $ZodCheckUpperCase: () => $ZodCheckUpperCase,
  $ZodCheckStringFormat: () => $ZodCheckStringFormat,
  $ZodCheckStartsWith: () => $ZodCheckStartsWith,
  $ZodCheckSizeEquals: () => $ZodCheckSizeEquals,
  $ZodCheckRegex: () => $ZodCheckRegex,
  $ZodCheckProperty: () => $ZodCheckProperty,
  $ZodCheckOverwrite: () => $ZodCheckOverwrite,
  $ZodCheckNumberFormat: () => $ZodCheckNumberFormat,
  $ZodCheckMultipleOf: () => $ZodCheckMultipleOf,
  $ZodCheckMinSize: () => $ZodCheckMinSize,
  $ZodCheckMinLength: () => $ZodCheckMinLength,
  $ZodCheckMimeType: () => $ZodCheckMimeType,
  $ZodCheckMaxSize: () => $ZodCheckMaxSize,
  $ZodCheckMaxLength: () => $ZodCheckMaxLength,
  $ZodCheckLowerCase: () => $ZodCheckLowerCase,
  $ZodCheckLessThan: () => $ZodCheckLessThan,
  $ZodCheckLengthEquals: () => $ZodCheckLengthEquals,
  $ZodCheckIncludes: () => $ZodCheckIncludes,
  $ZodCheckGreaterThan: () => $ZodCheckGreaterThan,
  $ZodCheckEndsWith: () => $ZodCheckEndsWith,
  $ZodCheckBigIntFormat: () => $ZodCheckBigIntFormat,
  $ZodCheck: () => $ZodCheck,
  $ZodCatch: () => $ZodCatch,
  $ZodCUID2: () => $ZodCUID2,
  $ZodCUID: () => $ZodCUID,
  $ZodCIDRv6: () => $ZodCIDRv6,
  $ZodCIDRv4: () => $ZodCIDRv4,
  $ZodBoolean: () => $ZodBoolean,
  $ZodBigIntFormat: () => $ZodBigIntFormat,
  $ZodBigInt: () => $ZodBigInt,
  $ZodBase64URL: () => $ZodBase64URL,
  $ZodBase64: () => $ZodBase64,
  $ZodAsyncError: () => $ZodAsyncError,
  $ZodArray: () => $ZodArray,
  $ZodAny: () => $ZodAny
});

// node_modules/zod/v4/core/core.js
var NEVER = Object.freeze({
  status: "aborted"
});
function $constructor(name, initializer, params) {
  function init(inst, def) {
    var _a;
    Object.defineProperty(inst, "_zod", {
      value: inst._zod ?? {},
      enumerable: false
    });
    (_a = inst._zod).traits ?? (_a.traits = new Set);
    inst._zod.traits.add(name);
    initializer(inst, def);
    for (const k in _.prototype) {
      if (!(k in inst))
        Object.defineProperty(inst, k, { value: _.prototype[k].bind(inst) });
    }
    inst._zod.constr = _;
    inst._zod.def = def;
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a;
    const inst = params?.Parent ? new Definition : this;
    init(inst, def);
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $brand = Symbol("zod_brand");

class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
var globalConfig = {};
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// node_modules/zod/v4/core/util.js
var exports_util = {};
__export(exports_util, {
  unwrapMessage: () => unwrapMessage,
  uint8ArrayToHex: () => uint8ArrayToHex,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  stringifyPrimitive: () => stringifyPrimitive,
  shallowClone: () => shallowClone,
  safeExtend: () => safeExtend,
  required: () => required,
  randomString: () => randomString,
  propertyKeyTypes: () => propertyKeyTypes,
  promiseAllObject: () => promiseAllObject,
  primitiveTypes: () => primitiveTypes,
  prefixIssues: () => prefixIssues,
  pick: () => pick,
  partial: () => partial,
  optionalKeys: () => optionalKeys,
  omit: () => omit,
  objectClone: () => objectClone,
  numKeys: () => numKeys,
  nullish: () => nullish,
  normalizeParams: () => normalizeParams,
  mergeDefs: () => mergeDefs,
  merge: () => merge,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  joinValues: () => joinValues,
  issue: () => issue,
  isPlainObject: () => isPlainObject,
  isObject: () => isObject,
  hexToUint8Array: () => hexToUint8Array,
  getSizableOrigin: () => getSizableOrigin,
  getParsedType: () => getParsedType,
  getLengthableOrigin: () => getLengthableOrigin,
  getEnumValues: () => getEnumValues,
  getElementAtPath: () => getElementAtPath,
  floatSafeRemainder: () => floatSafeRemainder,
  finalizeIssue: () => finalizeIssue,
  extend: () => extend,
  escapeRegex: () => escapeRegex,
  esc: () => esc,
  defineLazy: () => defineLazy,
  createTransparentProxy: () => createTransparentProxy,
  cloneDef: () => cloneDef,
  clone: () => clone,
  cleanRegex: () => cleanRegex,
  cleanEnum: () => cleanEnum,
  captureStackTrace: () => captureStackTrace,
  cached: () => cached,
  base64urlToUint8Array: () => base64urlToUint8Array,
  base64ToUint8Array: () => base64ToUint8Array,
  assignProp: () => assignProp,
  assertNotEqual: () => assertNotEqual,
  assertNever: () => assertNever,
  assertIs: () => assertIs,
  assertEqual: () => assertEqual,
  assert: () => assert,
  allowsEval: () => allowsEval,
  aborted: () => aborted,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  Class: () => Class,
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function assertIs(_arg) {}
function assertNever(_x) {
  throw new Error;
}
function assert(_) {}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var EVALUATING = Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path) {
  if (!path)
    return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0;i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0;i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
function esc(str) {
  return JSON.stringify(str);
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(`Unknown data type: ${t}`);
  }
};
var propertyKeyTypes = new Set(["string", "number", "symbol"]);
var primitiveTypes = new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error("Object schemas containing refinements cannot be extended. Use `.safeExtend()` instead.");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = {
    ...schema._zod.def,
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: schema._zod.def.checks
  };
  return clone(schema, def);
}
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
  });
  return clone(a, def);
}
function partial(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const full = { ...iss, path: iss.path ?? [] };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0;i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0;i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  return base64ToUint8Array(base64 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex) {
  const cleanHex = hex.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0;i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

class Class {
  constructor(..._args) {}
}

// node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const fieldErrors = { _errors: [] };
  const processError = (error2) => {
    for (const issue2 of error2.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues });
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues });
      } else if (issue2.path.length === 0) {
        fieldErrors._errors.push(mapper(issue2));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue2.path.length) {
          const el = issue2.path[i];
          const terminal = i === issue2.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || { _errors: [] };
          } else {
            curr[el] = curr[el] || { _errors: [] };
            curr[el]._errors.push(mapper(issue2));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}
function treeifyError(error, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const result = { errors: [] };
  const processError = (error2, path = []) => {
    var _a, _b;
    for (const issue2 of error2.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }, issue2.path));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues }, issue2.path);
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues }, issue2.path);
      } else {
        const fullpath = [...path, ...issue2.path];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue2));
          continue;
        }
        let curr = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i];
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ?? (curr.properties = {});
            (_a = curr.properties)[el] ?? (_a[el] = { errors: [] });
            curr = curr.properties[el];
          } else {
            curr.items ?? (curr.items = []);
            (_b = curr.items)[el] ?? (_b[el] = { errors: [] });
            curr = curr.items[el];
          }
          if (terminal) {
            curr.errors.push(mapper(issue2));
          }
          i++;
        }
      }
    }
  };
  processError(error);
  return result;
}
function toDotPath(_path) {
  const segs = [];
  const path = _path.map((seg) => typeof seg === "object" ? seg.key : seg);
  for (const seg of path) {
    if (typeof seg === "number")
      segs.push(`[${seg}]`);
    else if (typeof seg === "symbol")
      segs.push(`[${JSON.stringify(String(seg))}]`);
    else if (/[^\w$]/.test(seg))
      segs.push(`[${JSON.stringify(seg)}]`);
    else {
      if (segs.length)
        segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}
function prettifyError(error) {
  const lines = [];
  const issues = [...error.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue2 of issues) {
    lines.push(`✖ ${issue2.message}`);
    if (issue2.path?.length)
      lines.push(`  → at ${toDotPath(issue2.path)}`);
  }
  return lines.join(`
`);
}

// node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var parse2 = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var encode = /* @__PURE__ */ _encode($ZodRealError);
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var decode = /* @__PURE__ */ _decode($ZodRealError);
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var encodeAsync = /* @__PURE__ */ _encodeAsync($ZodRealError);
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var decodeAsync = /* @__PURE__ */ _decodeAsync($ZodRealError);
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var safeEncode = /* @__PURE__ */ _safeEncode($ZodRealError);
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var safeDecode = /* @__PURE__ */ _safeDecode($ZodRealError);
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);
// node_modules/zod/v4/core/regexes.js
var exports_regexes = {};
__export(exports_regexes, {
  xid: () => xid,
  uuid7: () => uuid7,
  uuid6: () => uuid6,
  uuid4: () => uuid4,
  uuid: () => uuid,
  uppercase: () => uppercase,
  unicodeEmail: () => unicodeEmail,
  undefined: () => _undefined,
  ulid: () => ulid,
  time: () => time,
  string: () => string,
  sha512_hex: () => sha512_hex,
  sha512_base64url: () => sha512_base64url,
  sha512_base64: () => sha512_base64,
  sha384_hex: () => sha384_hex,
  sha384_base64url: () => sha384_base64url,
  sha384_base64: () => sha384_base64,
  sha256_hex: () => sha256_hex,
  sha256_base64url: () => sha256_base64url,
  sha256_base64: () => sha256_base64,
  sha1_hex: () => sha1_hex,
  sha1_base64url: () => sha1_base64url,
  sha1_base64: () => sha1_base64,
  rfc5322Email: () => rfc5322Email,
  number: () => number,
  null: () => _null,
  nanoid: () => nanoid,
  md5_hex: () => md5_hex,
  md5_base64url: () => md5_base64url,
  md5_base64: () => md5_base64,
  lowercase: () => lowercase,
  ksuid: () => ksuid,
  ipv6: () => ipv6,
  ipv4: () => ipv4,
  integer: () => integer,
  idnEmail: () => idnEmail,
  html5Email: () => html5Email,
  hostname: () => hostname,
  hex: () => hex,
  guid: () => guid,
  extendedDuration: () => extendedDuration,
  emoji: () => emoji,
  email: () => email,
  e164: () => e164,
  duration: () => duration,
  domain: () => domain,
  datetime: () => datetime,
  date: () => date,
  cuid2: () => cuid2,
  cuid: () => cuid,
  cidrv6: () => cidrv6,
  cidrv4: () => cidrv4,
  browserEmail: () => browserEmail,
  boolean: () => boolean,
  bigint: () => bigint,
  base64url: () => base64url,
  base64: () => base64
});
var cuid = /^[cC][^\s-]{8,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var extendedDuration = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var uuid4 = /* @__PURE__ */ uuid(4);
var uuid6 = /* @__PURE__ */ uuid(6);
var uuid7 = /* @__PURE__ */ uuid(7);
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var html5Email = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var rfc5322Email = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var unicodeEmail = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var idnEmail = unicodeEmail;
var browserEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var hostname = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/;
var domain = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var e164 = /^\+(?:[0-9]){6,14}[0-9]$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time2 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time2}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var bigint = /^-?\d+n?$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var _undefined = /^undefined$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
var hex = /^[0-9a-fA-F]*$/;
function fixedBase64(bodyLength, padding) {
  return new RegExp(`^[A-Za-z0-9+/]{${bodyLength}}${padding}$`);
}
function fixedBase64url(length) {
  return new RegExp(`^[A-Za-z0-9_-]{${length}}$`);
}
var md5_hex = /^[0-9a-fA-F]{32}$/;
var md5_base64 = /* @__PURE__ */ fixedBase64(22, "==");
var md5_base64url = /* @__PURE__ */ fixedBase64url(22);
var sha1_hex = /^[0-9a-fA-F]{40}$/;
var sha1_base64 = /* @__PURE__ */ fixedBase64(27, "=");
var sha1_base64url = /* @__PURE__ */ fixedBase64url(27);
var sha256_hex = /^[0-9a-fA-F]{64}$/;
var sha256_base64 = /* @__PURE__ */ fixedBase64(43, "=");
var sha256_base64url = /* @__PURE__ */ fixedBase64url(43);
var sha384_hex = /^[0-9a-fA-F]{96}$/;
var sha384_base64 = /* @__PURE__ */ fixedBase64(64, "");
var sha384_base64url = /* @__PURE__ */ fixedBase64url(64);
var sha512_hex = /^[0-9a-fA-F]{128}$/;
var sha512_base64 = /* @__PURE__ */ fixedBase64(86, "==");
var sha512_base64url = /* @__PURE__ */ fixedBase64url(86);

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a;
    (_a = inst2._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckBigIntFormat = /* @__PURE__ */ $constructor("$ZodCheckBigIntFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  const [minimum, maximum] = BIGINT_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (input < minimum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckMaxSize = /* @__PURE__ */ $constructor("$ZodCheckMaxSize", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size <= def.maximum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinSize = /* @__PURE__ */ $constructor("$ZodCheckMinSize", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size >= def.minimum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckSizeEquals = /* @__PURE__ */ $constructor("$ZodCheckSizeEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.size;
    bag.maximum = def.size;
    bag.size = def.size;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size === def.size)
      return;
    const tooBig = size > def.size;
    payload.issues.push({
      origin: getSizableOrigin(input),
      ...tooBig ? { code: "too_big", maximum: def.size } : { code: "too_small", minimum: def.size },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = new Set);
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function handleCheckPropertyResult(result, payload, property) {
  if (result.issues.length) {
    payload.issues.push(...prefixIssues(property, result.issues));
  }
}
var $ZodCheckProperty = /* @__PURE__ */ $constructor("$ZodCheckProperty", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    const result = def.schema._zod.run({
      value: payload.value[def.property],
      issues: []
    }, {});
    if (result instanceof Promise) {
      return result.then((result2) => handleCheckPropertyResult(result2, payload, def.property));
    }
    handleCheckPropertyResult(result, payload, def.property);
    return;
  };
});
var $ZodCheckMimeType = /* @__PURE__ */ $constructor("$ZodCheckMimeType", (inst, def) => {
  $ZodCheck.init(inst, def);
  const mimeSet = new Set(def.mime);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.mime = def.mime;
  });
  inst._zod.check = (payload) => {
    if (mimeSet.has(payload.value.type))
      return;
    payload.issues.push({
      code: "invalid_value",
      values: def.mime,
      input: payload.value.type,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join(`
`));
  }
}

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 1,
  patch: 8
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  inst["~standard"] = {
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  };
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = `ipv4`;
  });
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = `ipv6`;
  });
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error;
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error;
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error;
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error;
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base642 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base642.padEnd(Math.ceil(base642.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64url";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCustomStringFormat = /* @__PURE__ */ $constructor("$ZodCustomStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (def.fn(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value);
      } catch (_) {}
    if (typeof payload.value === "bigint")
      return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodBigIntFormat = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodCheckBigIntFormat.init(inst, def);
  $ZodBigInt.init(inst, def);
});
var $ZodSymbol = /* @__PURE__ */ $constructor("$ZodSymbol", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "symbol")
      return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUndefined = /* @__PURE__ */ $constructor("$ZodUndefined", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _undefined;
  inst._zod.values = new Set([undefined]);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "undefined",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodVoid = /* @__PURE__ */ $constructor("$ZodVoid", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodDate = /* @__PURE__ */ $constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {}
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate)
      return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? { received: "Invalid Date" } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === undefined) {
    if (key in input) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  for (const key of Object.keys(input)) {
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
    } else {
      handlePropertyResult(r, payload, key, input);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = new Set);
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
      } else {
        handlePropertyResult(r, payload, key, input);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      doc.write(`const ${id} = ${parseStr(key)};`);
      doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k])
          propValues[k] = new Set;
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map = new Map;
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map.set(v, o);
      }
    }
    return map;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback) {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  if (left.issues.length) {
    result.issues.push(...left.issues);
  }
  if (right.issues.length) {
    result.issues.push(...right.issues);
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const optStart = items.length - [...items].reverse().findIndex((item) => item._zod.optin !== "optional");
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = [];
    const proms = [];
    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          ...tooBig ? { code: "too_big", maximum: items.length } : { code: "too_small", minimum: items.length },
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
    }
    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) {
        if (i >= optStart)
          continue;
      }
      const result = item._zod.run({
        value: input[i],
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }
    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run({
          value: el,
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    if (def.keyType._zod.values) {
      const values = def.keyType._zod.values;
      payload.value = {};
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[key] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!values.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        if (keyResult.issues.length) {
          payload.issues.push({
            code: "invalid_key",
            origin: "record",
            issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
            input: key,
            path: [key],
            inst
          });
          payload.value[keyResult.value] = keyResult.value;
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodMap = /* @__PURE__ */ $constructor("$ZodMap", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    payload.value = new Map;
    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
      const valueResult = def.valueType._zod.run({ value, issues: [] }, ctx);
      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(Promise.all([keyResult, valueResult]).then(([keyResult2, valueResult2]) => {
          handleMapResult(keyResult2, valueResult2, payload, key, input, inst, ctx);
        }));
      } else {
        handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
  if (keyResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, keyResult.issues));
    } else {
      final.issues.push({
        code: "invalid_key",
        origin: "map",
        input,
        inst,
        issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  if (valueResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key,
        issues: valueResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  final.value.set(keyResult.value, valueResult.value);
}
var $ZodSet = /* @__PURE__ */ $constructor("$ZodSet", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type"
      });
      return payload;
    }
    const proms = [];
    payload.value = new Set;
    for (const item of input) {
      const result = def.valueType._zod.run({ value: item, issues: [] }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleSetResult(result2, payload)));
      } else
        handleSetResult(result, payload);
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleSetResult(result, final) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }
  final.value.add(result.value);
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  inst._zod.values = new Set(def.values);
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (inst._zod.values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodFile = /* @__PURE__ */ $constructor("$ZodFile", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File)
      return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === undefined) {
    return { issues: [], value: undefined };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, undefined]) : undefined;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === undefined) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodSuccess = /* @__PURE__ */ $constructor("$ZodSuccess", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError("ZodSuccess");
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.issues.length === 0;
        return payload;
      });
    }
    payload.value = result.issues.length === 0;
    return payload;
  };
});
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
var $ZodNaN = /* @__PURE__ */ $constructor("$ZodNaN", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type"
      });
      return payload;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodCodec = /* @__PURE__ */ $constructor("$ZodCodec", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left2) => handleCodecAResult(left2, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handleCodecAResult(right2, def, ctx));
      }
      return handleCodecAResult(right, def, ctx);
    }
  };
});
function handleCodecAResult(result, def, ctx) {
  if (result.issues.length) {
    result.aborted = true;
    return result;
  }
  const direction = ctx.direction || "forward";
  if (direction === "forward") {
    const transformed = def.transform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.out, ctx));
    }
    return handleCodecTxResult(result, transformed, def.out, ctx);
  } else {
    const transformed = def.reverseTransform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.in, ctx));
    }
    return handleCodecTxResult(result, transformed, def.in, ctx);
  }
}
function handleCodecTxResult(left, value, nextSchema, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return nextSchema._zod.run({ value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodTemplateLiteral = /* @__PURE__ */ $constructor("$ZodTemplateLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const regexParts = [];
  for (const part of def.parts) {
    if (typeof part === "object" && part !== null) {
      if (!part._zod.pattern) {
        throw new Error(`Invalid template literal part, no pattern found: ${[...part._zod.traits].shift()}`);
      }
      const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;
      if (!source)
        throw new Error(`Invalid template literal part: ${part._zod.traits}`);
      const start = source.startsWith("^") ? 1 : 0;
      const end = source.endsWith("$") ? source.length - 1 : source.length;
      regexParts.push(source.slice(start, end));
    } else if (part === null || primitiveTypes.has(typeof part)) {
      regexParts.push(escapeRegex(`${part}`));
    } else {
      throw new Error(`Invalid template literal part: ${part}`);
    }
  }
  inst._zod.pattern = new RegExp(`^${regexParts.join("")}$`);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "string") {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "template_literal",
        code: "invalid_type"
      });
      return payload;
    }
    inst._zod.pattern.lastIndex = 0;
    if (!inst._zod.pattern.test(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        code: "invalid_format",
        format: def.format ?? "template_literal",
        pattern: inst._zod.pattern.source
      });
      return payload;
    }
    return payload;
  };
});
var $ZodFunction = /* @__PURE__ */ $constructor("$ZodFunction", (inst, def) => {
  $ZodType.init(inst, def);
  inst._def = def;
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return function(...args) {
      const parsedArgs = inst._def.input ? parse2(inst._def.input, args) : args;
      const result = Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return parse2(inst._def.output, result);
      }
      return result;
    };
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return async function(...args) {
      const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
      const result = await Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return await parseAsync(inst._def.output, result);
      }
      return result;
    };
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new $ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1]
        }),
        output: inst._def.output
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output
    });
  };
  return inst;
});
var $ZodPromise = /* @__PURE__ */ $constructor("$ZodPromise", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({ value: inner, issues: [] }, ctx));
  };
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType._zod.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType._zod.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType._zod.optin ?? undefined);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType._zod.optout ?? undefined);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// node_modules/zod/v4/locales/index.js
var exports_locales = {};
__export(exports_locales, {
  zhTW: () => zh_TW_default,
  zhCN: () => zh_CN_default,
  yo: () => yo_default,
  vi: () => vi_default,
  ur: () => ur_default,
  uk: () => uk_default,
  ua: () => ua_default,
  tr: () => tr_default,
  th: () => th_default,
  ta: () => ta_default,
  sv: () => sv_default,
  sl: () => sl_default,
  ru: () => ru_default,
  pt: () => pt_default,
  ps: () => ps_default,
  pl: () => pl_default,
  ota: () => ota_default,
  no: () => no_default,
  nl: () => nl_default,
  ms: () => ms_default,
  mk: () => mk_default,
  lt: () => lt_default,
  ko: () => ko_default,
  km: () => km_default,
  kh: () => kh_default,
  ka: () => ka_default,
  ja: () => ja_default,
  it: () => it_default,
  is: () => is_default,
  id: () => id_default,
  hu: () => hu_default,
  he: () => he_default,
  frCA: () => fr_CA_default,
  fr: () => fr_default,
  fi: () => fi_default,
  fa: () => fa_default,
  es: () => es_default,
  eo: () => eo_default,
  en: () => en_default,
  de: () => de_default,
  da: () => da_default,
  cs: () => cs_default,
  ca: () => ca_default,
  be: () => be_default,
  az: () => az_default,
  ar: () => ar_default
});

// node_modules/zod/v4/locales/ar.js
var error = () => {
  const Sizable = {
    string: { unit: "حرف", verb: "أن يحوي" },
    file: { unit: "بايت", verb: "أن يحوي" },
    array: { unit: "عنصر", verb: "أن يحوي" },
    set: { unit: "عنصر", verb: "أن يحوي" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "مدخل",
    email: "بريد إلكتروني",
    url: "رابط",
    emoji: "إيموجي",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "تاريخ ووقت بمعيار ISO",
    date: "تاريخ بمعيار ISO",
    time: "وقت بمعيار ISO",
    duration: "مدة بمعيار ISO",
    ipv4: "عنوان IPv4",
    ipv6: "عنوان IPv6",
    cidrv4: "مدى عناوين بصيغة IPv4",
    cidrv6: "مدى عناوين بصيغة IPv6",
    base64: "نَص بترميز base64-encoded",
    base64url: "نَص بترميز base64url-encoded",
    json_string: "نَص على هيئة JSON",
    e164: "رقم هاتف بمعيار E.164",
    jwt: "JWT",
    template_literal: "مدخل"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `مدخلات غير مقبولة: يفترض إدخال ${issue2.expected}، ولكن تم إدخال ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `مدخلات غير مقبولة: يفترض إدخال ${stringifyPrimitive(issue2.values[0])}`;
        return `اختيار غير مقبول: يتوقع انتقاء أحد هذه الخيارات: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return ` أكبر من اللازم: يفترض أن تكون ${issue2.origin ?? "القيمة"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "عنصر"}`;
        return `أكبر من اللازم: يفترض أن تكون ${issue2.origin ?? "القيمة"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `أصغر من اللازم: يفترض لـ ${issue2.origin} أن يكون ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `أصغر من اللازم: يفترض لـ ${issue2.origin} أن يكون ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `نَص غير مقبول: يجب أن يبدأ بـ "${issue2.prefix}"`;
        if (_issue.format === "ends_with")
          return `نَص غير مقبول: يجب أن ينتهي بـ "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `نَص غير مقبول: يجب أن يتضمَّن "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `نَص غير مقبول: يجب أن يطابق النمط ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} غير مقبول`;
      }
      case "not_multiple_of":
        return `رقم غير مقبول: يجب أن يكون من مضاعفات ${issue2.divisor}`;
      case "unrecognized_keys":
        return `معرف${issue2.keys.length > 1 ? "ات" : ""} غريب${issue2.keys.length > 1 ? "ة" : ""}: ${joinValues(issue2.keys, "، ")}`;
      case "invalid_key":
        return `معرف غير مقبول في ${issue2.origin}`;
      case "invalid_union":
        return "مدخل غير مقبول";
      case "invalid_element":
        return `مدخل غير مقبول في ${issue2.origin}`;
      default:
        return "مدخل غير مقبول";
    }
  };
};
function ar_default() {
  return {
    localeError: error()
  };
}
// node_modules/zod/v4/locales/az.js
var error2 = () => {
  const Sizable = {
    string: { unit: "simvol", verb: "olmalıdır" },
    file: { unit: "bayt", verb: "olmalıdır" },
    array: { unit: "element", verb: "olmalıdır" },
    set: { unit: "element", verb: "olmalıdır" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Yanlış dəyər: gözlənilən ${issue2.expected}, daxil olan ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Yanlış dəyər: gözlənilən ${stringifyPrimitive(issue2.values[0])}`;
        return `Yanlış seçim: aşağıdakılardan biri olmalıdır: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çox böyük: gözlənilən ${issue2.origin ?? "dəyər"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        return `Çox böyük: gözlənilən ${issue2.origin ?? "dəyər"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çox kiçik: gözlənilən ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `Çox kiçik: gözlənilən ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Yanlış mətn: "${_issue.prefix}" ilə başlamalıdır`;
        if (_issue.format === "ends_with")
          return `Yanlış mətn: "${_issue.suffix}" ilə bitməlidir`;
        if (_issue.format === "includes")
          return `Yanlış mətn: "${_issue.includes}" daxil olmalıdır`;
        if (_issue.format === "regex")
          return `Yanlış mətn: ${_issue.pattern} şablonuna uyğun olmalıdır`;
        return `Yanlış ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Yanlış ədəd: ${issue2.divisor} ilə bölünə bilən olmalıdır`;
      case "unrecognized_keys":
        return `Tanınmayan açar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} daxilində yanlış açar`;
      case "invalid_union":
        return "Yanlış dəyər";
      case "invalid_element":
        return `${issue2.origin} daxilində yanlış dəyər`;
      default:
        return `Yanlış dəyər`;
    }
  };
};
function az_default() {
  return {
    localeError: error2()
  };
}
// node_modules/zod/v4/locales/be.js
function getBelarusianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error3 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "сімвал",
        few: "сімвалы",
        many: "сімвалаў"
      },
      verb: "мець"
    },
    array: {
      unit: {
        one: "элемент",
        few: "элементы",
        many: "элементаў"
      },
      verb: "мець"
    },
    set: {
      unit: {
        one: "элемент",
        few: "элементы",
        many: "элементаў"
      },
      verb: "мець"
    },
    file: {
      unit: {
        one: "байт",
        few: "байты",
        many: "байтаў"
      },
      verb: "мець"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "лік";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "масіў";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "увод",
    email: "email адрас",
    url: "URL",
    emoji: "эмодзі",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO дата і час",
    date: "ISO дата",
    time: "ISO час",
    duration: "ISO працягласць",
    ipv4: "IPv4 адрас",
    ipv6: "IPv6 адрас",
    cidrv4: "IPv4 дыяпазон",
    cidrv6: "IPv6 дыяпазон",
    base64: "радок у фармаце base64",
    base64url: "радок у фармаце base64url",
    json_string: "JSON радок",
    e164: "нумар E.164",
    jwt: "JWT",
    template_literal: "увод"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Няправільны ўвод: чакаўся ${issue2.expected}, атрымана ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Няправільны ўвод: чакалася ${stringifyPrimitive(issue2.values[0])}`;
        return `Няправільны варыянт: чакаўся адзін з ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getBelarusianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Занадта вялікі: чакалася, што ${issue2.origin ?? "значэнне"} павінна ${sizing.verb} ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `Занадта вялікі: чакалася, што ${issue2.origin ?? "значэнне"} павінна быць ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getBelarusianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Занадта малы: чакалася, што ${issue2.origin} павінна ${sizing.verb} ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `Занадта малы: чакалася, што ${issue2.origin} павінна быць ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Няправільны радок: павінен пачынацца з "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Няправільны радок: павінен заканчвацца на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Няправільны радок: павінен змяшчаць "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Няправільны радок: павінен адпавядаць шаблону ${_issue.pattern}`;
        return `Няправільны ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Няправільны лік: павінен быць кратным ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Нераспазнаны ${issue2.keys.length > 1 ? "ключы" : "ключ"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Няправільны ключ у ${issue2.origin}`;
      case "invalid_union":
        return "Няправільны ўвод";
      case "invalid_element":
        return `Няправільнае значэнне ў ${issue2.origin}`;
      default:
        return `Няправільны ўвод`;
    }
  };
};
function be_default() {
  return {
    localeError: error3()
  };
}
// node_modules/zod/v4/locales/ca.js
var error4 = () => {
  const Sizable = {
    string: { unit: "caràcters", verb: "contenir" },
    file: { unit: "bytes", verb: "contenir" },
    array: { unit: "elements", verb: "contenir" },
    set: { unit: "elements", verb: "contenir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "adreça electrònica",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "durada ISO",
    ipv4: "adreça IPv4",
    ipv6: "adreça IPv6",
    cidrv4: "rang IPv4",
    cidrv6: "rang IPv6",
    base64: "cadena codificada en base64",
    base64url: "cadena codificada en base64url",
    json_string: "cadena JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Tipus invàlid: s'esperava ${issue2.expected}, s'ha rebut ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Valor invàlid: s'esperava ${stringifyPrimitive(issue2.values[0])}`;
        return `Opció invàlida: s'esperava una de ${joinValues(issue2.values, " o ")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "com a màxim" : "menys de";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} contingués ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} fos ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "com a mínim" : "més de";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Massa petit: s'esperava que ${issue2.origin} contingués ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Massa petit: s'esperava que ${issue2.origin} fos ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Format invàlid: ha de començar amb "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Format invàlid: ha d'acabar amb "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Format invàlid: ha d'incloure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Format invàlid: ha de coincidir amb el patró ${_issue.pattern}`;
        return `Format invàlid per a ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Número invàlid: ha de ser múltiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clau${issue2.keys.length > 1 ? "s" : ""} no reconeguda${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clau invàlida a ${issue2.origin}`;
      case "invalid_union":
        return "Entrada invàlida";
      case "invalid_element":
        return `Element invàlid a ${issue2.origin}`;
      default:
        return `Entrada invàlida`;
    }
  };
};
function ca_default() {
  return {
    localeError: error4()
  };
}
// node_modules/zod/v4/locales/cs.js
var error5 = () => {
  const Sizable = {
    string: { unit: "znaků", verb: "mít" },
    file: { unit: "bajtů", verb: "mít" },
    array: { unit: "prvků", verb: "mít" },
    set: { unit: "prvků", verb: "mít" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "číslo";
      }
      case "string": {
        return "řetězec";
      }
      case "boolean": {
        return "boolean";
      }
      case "bigint": {
        return "bigint";
      }
      case "function": {
        return "funkce";
      }
      case "symbol": {
        return "symbol";
      }
      case "undefined": {
        return "undefined";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "pole";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "regulární výraz",
    email: "e-mailová adresa",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "datum a čas ve formátu ISO",
    date: "datum ve formátu ISO",
    time: "čas ve formátu ISO",
    duration: "doba trvání ISO",
    ipv4: "IPv4 adresa",
    ipv6: "IPv6 adresa",
    cidrv4: "rozsah IPv4",
    cidrv6: "rozsah IPv6",
    base64: "řetězec zakódovaný ve formátu base64",
    base64url: "řetězec zakódovaný ve formátu base64url",
    json_string: "řetězec ve formátu JSON",
    e164: "číslo E.164",
    jwt: "JWT",
    template_literal: "vstup"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Neplatný vstup: očekáváno ${issue2.expected}, obdrženo ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neplatný vstup: očekáváno ${stringifyPrimitive(issue2.values[0])}`;
        return `Neplatná možnost: očekávána jedna z hodnot ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je příliš velká: ${issue2.origin ?? "hodnota"} musí mít ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "prvků"}`;
        }
        return `Hodnota je příliš velká: ${issue2.origin ?? "hodnota"} musí být ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je příliš malá: ${issue2.origin ?? "hodnota"} musí mít ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "prvků"}`;
        }
        return `Hodnota je příliš malá: ${issue2.origin ?? "hodnota"} musí být ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Neplatný řetězec: musí začínat na "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Neplatný řetězec: musí končit na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neplatný řetězec: musí obsahovat "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neplatný řetězec: musí odpovídat vzoru ${_issue.pattern}`;
        return `Neplatný formát ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neplatné číslo: musí být násobkem ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Neznámé klíče: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neplatný klíč v ${issue2.origin}`;
      case "invalid_union":
        return "Neplatný vstup";
      case "invalid_element":
        return `Neplatná hodnota v ${issue2.origin}`;
      default:
        return `Neplatný vstup`;
    }
  };
};
function cs_default() {
  return {
    localeError: error5()
  };
}
// node_modules/zod/v4/locales/da.js
var error6 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "havde" },
    file: { unit: "bytes", verb: "havde" },
    array: { unit: "elementer", verb: "indeholdt" },
    set: { unit: "elementer", verb: "indeholdt" }
  };
  const TypeNames = {
    string: "streng",
    number: "tal",
    boolean: "boolean",
    array: "liste",
    object: "objekt",
    set: "sæt",
    file: "fil"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
        return "objekt";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-mailadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslæt",
    date: "ISO-dato",
    time: "ISO-klokkeslæt",
    duration: "ISO-varighed",
    ipv4: "IPv4-område",
    ipv6: "IPv6-område",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodet streng",
    base64url: "base64url-kodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ugyldigt input: forventede ${getTypeName(issue2.expected)}, fik ${getTypeName(parsedType(issue2.input))}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig værdi: forventede ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldigt valg: forventede en af følgende ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing)
          return `For stor: forventede ${origin ?? "value"} ${sizing.verb} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor: forventede ${origin ?? "value"} havde ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return `For lille: forventede ${origin} ${sizing.verb} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lille: forventede ${origin} havde ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: skal starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: skal ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: skal indeholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: skal matche mønsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldigt tal: skal være deleligt med ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukendte nøgler" : "Ukendt nøgle"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig nøgle i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldigt input: matcher ingen af de tilladte typer";
      case "invalid_element":
        return `Ugyldig værdi i ${issue2.origin}`;
      default:
        return `Ugyldigt input`;
    }
  };
};
function da_default() {
  return {
    localeError: error6()
  };
}
// node_modules/zod/v4/locales/de.js
var error7 = () => {
  const Sizable = {
    string: { unit: "Zeichen", verb: "zu haben" },
    file: { unit: "Bytes", verb: "zu haben" },
    array: { unit: "Elemente", verb: "zu haben" },
    set: { unit: "Elemente", verb: "zu haben" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "Zahl";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "Array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "Eingabe",
    email: "E-Mail-Adresse",
    url: "URL",
    emoji: "Emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-Datum und -Uhrzeit",
    date: "ISO-Datum",
    time: "ISO-Uhrzeit",
    duration: "ISO-Dauer",
    ipv4: "IPv4-Adresse",
    ipv6: "IPv6-Adresse",
    cidrv4: "IPv4-Bereich",
    cidrv6: "IPv6-Bereich",
    base64: "Base64-codierter String",
    base64url: "Base64-URL-codierter String",
    json_string: "JSON-String",
    e164: "E.164-Nummer",
    jwt: "JWT",
    template_literal: "Eingabe"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ungültige Eingabe: erwartet ${issue2.expected}, erhalten ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ungültige Eingabe: erwartet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ungültige Option: erwartet eine von ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Zu groß: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "Elemente"} hat`;
        return `Zu groß: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ist`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} hat`;
        }
        return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ist`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ungültiger String: muss mit "${_issue.prefix}" beginnen`;
        if (_issue.format === "ends_with")
          return `Ungültiger String: muss mit "${_issue.suffix}" enden`;
        if (_issue.format === "includes")
          return `Ungültiger String: muss "${_issue.includes}" enthalten`;
        if (_issue.format === "regex")
          return `Ungültiger String: muss dem Muster ${_issue.pattern} entsprechen`;
        return `Ungültig: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ungültige Zahl: muss ein Vielfaches von ${issue2.divisor} sein`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Unbekannte Schlüssel" : "Unbekannter Schlüssel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ungültiger Schlüssel in ${issue2.origin}`;
      case "invalid_union":
        return "Ungültige Eingabe";
      case "invalid_element":
        return `Ungültiger Wert in ${issue2.origin}`;
      default:
        return `Ungültige Eingabe`;
    }
  };
};
function de_default() {
  return {
    localeError: error7()
  };
}
// node_modules/zod/v4/locales/en.js
var parsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error8 = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Invalid input: expected ${issue2.expected}, received ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Too big: expected ${issue2.origin ?? "value"} to have ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue2.origin ?? "value"} to be ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Too small: expected ${issue2.origin} to have ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue2.origin} to be ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue2.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue2.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error8()
  };
}
// node_modules/zod/v4/locales/eo.js
var parsedType2 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "nombro";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "tabelo";
      }
      if (data === null) {
        return "senvalora";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error9 = () => {
  const Sizable = {
    string: { unit: "karaktrojn", verb: "havi" },
    file: { unit: "bajtojn", verb: "havi" },
    array: { unit: "elementojn", verb: "havi" },
    set: { unit: "elementojn", verb: "havi" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "enigo",
    email: "retadreso",
    url: "URL",
    emoji: "emoĝio",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datotempo",
    date: "ISO-dato",
    time: "ISO-tempo",
    duration: "ISO-daŭro",
    ipv4: "IPv4-adreso",
    ipv6: "IPv6-adreso",
    cidrv4: "IPv4-rango",
    cidrv6: "IPv6-rango",
    base64: "64-ume kodita karaktraro",
    base64url: "URL-64-ume kodita karaktraro",
    json_string: "JSON-karaktraro",
    e164: "E.164-nombro",
    jwt: "JWT",
    template_literal: "enigo"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Nevalida enigo: atendiĝis ${issue2.expected}, riceviĝis ${parsedType2(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nevalida enigo: atendiĝis ${stringifyPrimitive(issue2.values[0])}`;
        return `Nevalida opcio: atendiĝis unu el ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Tro granda: atendiĝis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementojn"}`;
        return `Tro granda: atendiĝis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Tro malgranda: atendiĝis ke ${issue2.origin} havu ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Tro malgranda: atendiĝis ke ${issue2.origin} estu ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nevalida karaktraro: devas komenciĝi per "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nevalida karaktraro: devas finiĝi per "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nevalida karaktraro: devas inkluzivi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nevalida karaktraro: devas kongrui kun la modelo ${_issue.pattern}`;
        return `Nevalida ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${issue2.keys.length > 1 ? "j" : ""} ŝlosilo${issue2.keys.length > 1 ? "j" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida ŝlosilo en ${issue2.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${issue2.origin}`;
      default:
        return `Nevalida enigo`;
    }
  };
};
function eo_default() {
  return {
    localeError: error9()
  };
}
// node_modules/zod/v4/locales/es.js
var error10 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "tener" },
    file: { unit: "bytes", verb: "tener" },
    array: { unit: "elementos", verb: "tener" },
    set: { unit: "elementos", verb: "tener" }
  };
  const TypeNames = {
    string: "texto",
    number: "número",
    boolean: "booleano",
    array: "arreglo",
    object: "objeto",
    set: "conjunto",
    file: "archivo",
    date: "fecha",
    bigint: "número grande",
    symbol: "símbolo",
    undefined: "indefinido",
    null: "nulo",
    function: "función",
    map: "mapa",
    record: "registro",
    tuple: "tupla",
    enum: "enumeración",
    union: "unión",
    literal: "literal",
    promise: "promesa",
    void: "vacío",
    never: "nunca",
    unknown: "desconocido",
    any: "cualquiera"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype) {
          return data.constructor.name;
        }
        return "object";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "dirección de correo electrónico",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "fecha y hora ISO",
    date: "fecha ISO",
    time: "hora ISO",
    duration: "duración ISO",
    ipv4: "dirección IPv4",
    ipv6: "dirección IPv6",
    cidrv4: "rango IPv4",
    cidrv6: "rango IPv6",
    base64: "cadena codificada en base64",
    base64url: "URL codificada en base64",
    json_string: "cadena JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrada inválida: se esperaba ${getTypeName(issue2.expected)}, recibido ${getTypeName(parsedType3(issue2.input))}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inválida: se esperaba ${stringifyPrimitive(issue2.values[0])}`;
        return `Opción inválida: se esperaba una de ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing)
          return `Demasiado grande: se esperaba que ${origin ?? "valor"} tuviera ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${origin ?? "valor"} fuera ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return `Demasiado pequeño: se esperaba que ${origin} tuviera ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Demasiado pequeño: se esperaba que ${origin} fuera ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Cadena inválida: debe comenzar con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cadena inválida: debe terminar en "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cadena inválida: debe incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cadena inválida: debe coincidir con el patrón ${_issue.pattern}`;
        return `Inválido ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Número inválido: debe ser múltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Llave${issue2.keys.length > 1 ? "s" : ""} desconocida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Llave inválida en ${getTypeName(issue2.origin)}`;
      case "invalid_union":
        return "Entrada inválida";
      case "invalid_element":
        return `Valor inválido en ${getTypeName(issue2.origin)}`;
      default:
        return `Entrada inválida`;
    }
  };
};
function es_default() {
  return {
    localeError: error10()
  };
}
// node_modules/zod/v4/locales/fa.js
var error11 = () => {
  const Sizable = {
    string: { unit: "کاراکتر", verb: "داشته باشد" },
    file: { unit: "بایت", verb: "داشته باشد" },
    array: { unit: "آیتم", verb: "داشته باشد" },
    set: { unit: "آیتم", verb: "داشته باشد" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "عدد";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "آرایه";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ورودی",
    email: "آدرس ایمیل",
    url: "URL",
    emoji: "ایموجی",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "تاریخ و زمان ایزو",
    date: "تاریخ ایزو",
    time: "زمان ایزو",
    duration: "مدت زمان ایزو",
    ipv4: "IPv4 آدرس",
    ipv6: "IPv6 آدرس",
    cidrv4: "IPv4 دامنه",
    cidrv6: "IPv6 دامنه",
    base64: "base64-encoded رشته",
    base64url: "base64url-encoded رشته",
    json_string: "JSON رشته",
    e164: "E.164 عدد",
    jwt: "JWT",
    template_literal: "ورودی"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ورودی نامعتبر: می‌بایست ${issue2.expected} می‌بود، ${parsedType3(issue2.input)} دریافت شد`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `ورودی نامعتبر: می‌بایست ${stringifyPrimitive(issue2.values[0])} می‌بود`;
        }
        return `گزینه نامعتبر: می‌بایست یکی از ${joinValues(issue2.values, "|")} می‌بود`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `خیلی بزرگ: ${issue2.origin ?? "مقدار"} باید ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "عنصر"} باشد`;
        }
        return `خیلی بزرگ: ${issue2.origin ?? "مقدار"} باید ${adj}${issue2.maximum.toString()} باشد`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `خیلی کوچک: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} ${sizing.unit} باشد`;
        }
        return `خیلی کوچک: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} باشد`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `رشته نامعتبر: باید با "${_issue.prefix}" شروع شود`;
        }
        if (_issue.format === "ends_with") {
          return `رشته نامعتبر: باید با "${_issue.suffix}" تمام شود`;
        }
        if (_issue.format === "includes") {
          return `رشته نامعتبر: باید شامل "${_issue.includes}" باشد`;
        }
        if (_issue.format === "regex") {
          return `رشته نامعتبر: باید با الگوی ${_issue.pattern} مطابقت داشته باشد`;
        }
        return `${Nouns[_issue.format] ?? issue2.format} نامعتبر`;
      }
      case "not_multiple_of":
        return `عدد نامعتبر: باید مضرب ${issue2.divisor} باشد`;
      case "unrecognized_keys":
        return `کلید${issue2.keys.length > 1 ? "های" : ""} ناشناس: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `کلید ناشناس در ${issue2.origin}`;
      case "invalid_union":
        return `ورودی نامعتبر`;
      case "invalid_element":
        return `مقدار نامعتبر در ${issue2.origin}`;
      default:
        return `ورودی نامعتبر`;
    }
  };
};
function fa_default() {
  return {
    localeError: error11()
  };
}
// node_modules/zod/v4/locales/fi.js
var error12 = () => {
  const Sizable = {
    string: { unit: "merkkiä", subject: "merkkijonon" },
    file: { unit: "tavua", subject: "tiedoston" },
    array: { unit: "alkiota", subject: "listan" },
    set: { unit: "alkiota", subject: "joukon" },
    number: { unit: "", subject: "luvun" },
    bigint: { unit: "", subject: "suuren kokonaisluvun" },
    int: { unit: "", subject: "kokonaisluvun" },
    date: { unit: "", subject: "päivämäärän" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "säännöllinen lauseke",
    email: "sähköpostiosoite",
    url: "URL-osoite",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-aikaleima",
    date: "ISO-päivämäärä",
    time: "ISO-aika",
    duration: "ISO-kesto",
    ipv4: "IPv4-osoite",
    ipv6: "IPv6-osoite",
    cidrv4: "IPv4-alue",
    cidrv6: "IPv6-alue",
    base64: "base64-koodattu merkkijono",
    base64url: "base64url-koodattu merkkijono",
    json_string: "JSON-merkkijono",
    e164: "E.164-luku",
    jwt: "JWT",
    template_literal: "templaattimerkkijono"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Virheellinen tyyppi: odotettiin ${issue2.expected}, oli ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Virheellinen syöte: täytyy olla ${stringifyPrimitive(issue2.values[0])}`;
        return `Virheellinen valinta: täytyy olla yksi seuraavista: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian suuri: ${sizing.subject} täytyy olla ${adj}${issue2.maximum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian suuri: arvon täytyy olla ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian pieni: ${sizing.subject} täytyy olla ${adj}${issue2.minimum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian pieni: arvon täytyy olla ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Virheellinen syöte: täytyy alkaa "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Virheellinen syöte: täytyy loppua "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Virheellinen syöte: täytyy sisältää "${_issue.includes}"`;
        if (_issue.format === "regex") {
          return `Virheellinen syöte: täytyy vastata säännöllistä lauseketta ${_issue.pattern}`;
        }
        return `Virheellinen ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: täytyy olla luvun ${issue2.divisor} monikerta`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return `Virheellinen syöte`;
    }
  };
};
function fi_default() {
  return {
    localeError: error12()
  };
}
// node_modules/zod/v4/locales/fr.js
var error13 = () => {
  const Sizable = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombre";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tableau";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrée",
    email: "adresse e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date et heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "durée ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "chaîne encodée en base64",
    base64url: "chaîne encodée en base64url",
    json_string: "chaîne JSON",
    e164: "numéro E.164",
    jwt: "JWT",
    template_literal: "entrée"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrée invalide : ${issue2.expected} attendu, ${parsedType3(issue2.input)} reçu`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrée invalide : ${stringifyPrimitive(issue2.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${joinValues(issue2.values, "|")} attendue`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : ${issue2.origin ?? "valeur"} doit ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "élément(s)"}`;
        return `Trop grand : ${issue2.origin ?? "valeur"} doit être ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : ${issue2.origin} doit ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : ${issue2.origin} doit être ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Chaîne invalide : doit commencer par "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chaîne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chaîne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chaîne invalide : doit correspondre au modèle ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entrée invalide`;
    }
  };
};
function fr_default() {
  return {
    localeError: error13()
  };
}
// node_modules/zod/v4/locales/fr-CA.js
var error14 = () => {
  const Sizable = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrée",
    email: "adresse courriel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date-heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "durée ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "chaîne encodée en base64",
    base64url: "chaîne encodée en base64url",
    json_string: "chaîne JSON",
    e164: "numéro E.164",
    jwt: "JWT",
    template_literal: "entrée"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrée invalide : attendu ${issue2.expected}, reçu ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrée invalide : attendu ${stringifyPrimitive(issue2.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "≤" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} ait ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} soit ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "≥" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : attendu que ${issue2.origin} ait ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : attendu que ${issue2.origin} soit ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Chaîne invalide : doit commencer par "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Chaîne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chaîne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chaîne invalide : doit correspondre au motif ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entrée invalide`;
    }
  };
};
function fr_CA_default() {
  return {
    localeError: error14()
  };
}
// node_modules/zod/v4/locales/he.js
var error15 = () => {
  const Sizable = {
    string: { unit: "אותיות", verb: "לכלול" },
    file: { unit: "בייטים", verb: "לכלול" },
    array: { unit: "פריטים", verb: "לכלול" },
    set: { unit: "פריטים", verb: "לכלול" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "קלט",
    email: "כתובת אימייל",
    url: "כתובת רשת",
    emoji: "אימוג'י",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "תאריך וזמן ISO",
    date: "תאריך ISO",
    time: "זמן ISO",
    duration: "משך זמן ISO",
    ipv4: "כתובת IPv4",
    ipv6: "כתובת IPv6",
    cidrv4: "טווח IPv4",
    cidrv6: "טווח IPv6",
    base64: "מחרוזת בבסיס 64",
    base64url: "מחרוזת בבסיס 64 לכתובות רשת",
    json_string: "מחרוזת JSON",
    e164: "מספר E.164",
    jwt: "JWT",
    template_literal: "קלט"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `קלט לא תקין: צריך ${issue2.expected}, התקבל ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `קלט לא תקין: צריך ${stringifyPrimitive(issue2.values[0])}`;
        return `קלט לא תקין: צריך אחת מהאפשרויות  ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `גדול מדי: ${issue2.origin ?? "value"} צריך להיות ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `גדול מדי: ${issue2.origin ?? "value"} צריך להיות ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `קטן מדי: ${issue2.origin} צריך להיות ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `קטן מדי: ${issue2.origin} צריך להיות ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `מחרוזת לא תקינה: חייבת להתחיל ב"${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `מחרוזת לא תקינה: חייבת להסתיים ב "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `מחרוזת לא תקינה: חייבת לכלול "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `מחרוזת לא תקינה: חייבת להתאים לתבנית ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} לא תקין`;
      }
      case "not_multiple_of":
        return `מספר לא תקין: חייב להיות מכפלה של ${issue2.divisor}`;
      case "unrecognized_keys":
        return `מפתח${issue2.keys.length > 1 ? "ות" : ""} לא מזוה${issue2.keys.length > 1 ? "ים" : "ה"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `מפתח לא תקין ב${issue2.origin}`;
      case "invalid_union":
        return "קלט לא תקין";
      case "invalid_element":
        return `ערך לא תקין ב${issue2.origin}`;
      default:
        return `קלט לא תקין`;
    }
  };
};
function he_default() {
  return {
    localeError: error15()
  };
}
// node_modules/zod/v4/locales/hu.js
var error16 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "legyen" },
    file: { unit: "byte", verb: "legyen" },
    array: { unit: "elem", verb: "legyen" },
    set: { unit: "elem", verb: "legyen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "szám";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tömb";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "bemenet",
    email: "email cím",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO időbélyeg",
    date: "ISO dátum",
    time: "ISO idő",
    duration: "ISO időintervallum",
    ipv4: "IPv4 cím",
    ipv6: "IPv6 cím",
    cidrv4: "IPv4 tartomány",
    cidrv6: "IPv6 tartomány",
    base64: "base64-kódolt string",
    base64url: "base64url-kódolt string",
    json_string: "JSON string",
    e164: "E.164 szám",
    jwt: "JWT",
    template_literal: "bemenet"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Érvénytelen bemenet: a várt érték ${issue2.expected}, a kapott érték ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Érvénytelen bemenet: a várt érték ${stringifyPrimitive(issue2.values[0])}`;
        return `Érvénytelen opció: valamelyik érték várt ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Túl nagy: ${issue2.origin ?? "érték"} mérete túl nagy ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elem"}`;
        return `Túl nagy: a bemeneti érték ${issue2.origin ?? "érték"} túl nagy: ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Túl kicsi: a bemeneti érték ${issue2.origin} mérete túl kicsi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Túl kicsi: a bemeneti érték ${issue2.origin} túl kicsi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Érvénytelen string: "${_issue.prefix}" értékkel kell kezdődnie`;
        if (_issue.format === "ends_with")
          return `Érvénytelen string: "${_issue.suffix}" értékkel kell végződnie`;
        if (_issue.format === "includes")
          return `Érvénytelen string: "${_issue.includes}" értéket kell tartalmaznia`;
        if (_issue.format === "regex")
          return `Érvénytelen string: ${_issue.pattern} mintának kell megfelelnie`;
        return `Érvénytelen ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Érvénytelen szám: ${issue2.divisor} többszörösének kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Érvénytelen kulcs ${issue2.origin}`;
      case "invalid_union":
        return "Érvénytelen bemenet";
      case "invalid_element":
        return `Érvénytelen érték: ${issue2.origin}`;
      default:
        return `Érvénytelen bemenet`;
    }
  };
};
function hu_default() {
  return {
    localeError: error16()
  };
}
// node_modules/zod/v4/locales/id.js
var error17 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "memiliki" },
    file: { unit: "byte", verb: "memiliki" },
    array: { unit: "item", verb: "memiliki" },
    set: { unit: "item", verb: "memiliki" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tanggal dan waktu format ISO",
    date: "tanggal format ISO",
    time: "jam format ISO",
    duration: "durasi format ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "rentang alamat IPv4",
    cidrv6: "rentang alamat IPv6",
    base64: "string dengan enkode base64",
    base64url: "string dengan enkode base64url",
    json_string: "string JSON",
    e164: "angka E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input tidak valid: diharapkan ${issue2.expected}, diterima ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak valid: diharapkan ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} memiliki ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} menjadi ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: diharapkan ${issue2.origin} memiliki ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: diharapkan ${issue2.origin} menjadi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak valid: harus dimulai dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak valid: harus berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak valid: harus menyertakan "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak valid: harus sesuai pola ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${issue2.origin}`;
      default:
        return `Input tidak valid`;
    }
  };
};
function id_default() {
  return {
    localeError: error17()
  };
}
// node_modules/zod/v4/locales/is.js
var parsedType3 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "númer";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "fylki";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error18 = () => {
  const Sizable = {
    string: { unit: "stafi", verb: "að hafa" },
    file: { unit: "bæti", verb: "að hafa" },
    array: { unit: "hluti", verb: "að hafa" },
    set: { unit: "hluti", verb: "að hafa" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "gildi",
    email: "netfang",
    url: "vefslóð",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dagsetning og tími",
    date: "ISO dagsetning",
    time: "ISO tími",
    duration: "ISO tímalengd",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded strengur",
    base64url: "base64url-encoded strengur",
    json_string: "JSON strengur",
    e164: "E.164 tölugildi",
    jwt: "JWT",
    template_literal: "gildi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Rangt gildi: Þú slóst inn ${parsedType3(issue2.input)} þar sem á að vera ${issue2.expected}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Rangt gildi: gert ráð fyrir ${stringifyPrimitive(issue2.values[0])}`;
        return `Ógilt val: má vera eitt af eftirfarandi ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Of stórt: gert er ráð fyrir að ${issue2.origin ?? "gildi"} hafi ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "hluti"}`;
        return `Of stórt: gert er ráð fyrir að ${issue2.origin ?? "gildi"} sé ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Of lítið: gert er ráð fyrir að ${issue2.origin} hafi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Of lítið: gert er ráð fyrir að ${issue2.origin} sé ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ógildur strengur: verður að byrja á "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ógildur strengur: verður að enda á "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ógildur strengur: verður að innihalda "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ógildur strengur: verður að fylgja mynstri ${_issue.pattern}`;
        return `Rangt ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Röng tala: verður að vera margfeldi af ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Óþekkt ${issue2.keys.length > 1 ? "ir lyklar" : "ur lykill"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Rangur lykill í ${issue2.origin}`;
      case "invalid_union":
        return "Rangt gildi";
      case "invalid_element":
        return `Rangt gildi í ${issue2.origin}`;
      default:
        return `Rangt gildi`;
    }
  };
};
function is_default() {
  return {
    localeError: error18()
  };
}
// node_modules/zod/v4/locales/it.js
var error19 = () => {
  const Sizable = {
    string: { unit: "caratteri", verb: "avere" },
    file: { unit: "byte", verb: "avere" },
    array: { unit: "elementi", verb: "avere" },
    set: { unit: "elementi", verb: "avere" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType4 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "vettore";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "indirizzo email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e ora ISO",
    date: "data ISO",
    time: "ora ISO",
    duration: "durata ISO",
    ipv4: "indirizzo IPv4",
    ipv6: "indirizzo IPv6",
    cidrv4: "intervallo IPv4",
    cidrv6: "intervallo IPv6",
    base64: "stringa codificata in base64",
    base64url: "URL codificata in base64",
    json_string: "stringa JSON",
    e164: "numero E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input non valido: atteso ${issue2.expected}, ricevuto ${parsedType4(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input non valido: atteso ${stringifyPrimitive(issue2.values[0])}`;
        return `Opzione non valida: atteso uno tra ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Troppo grande: ${issue2.origin ?? "valore"} deve avere ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementi"}`;
        return `Troppo grande: ${issue2.origin ?? "valore"} deve essere ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Troppo piccolo: ${issue2.origin} deve avere ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Troppo piccolo: ${issue2.origin} deve essere ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Stringa non valida: deve iniziare con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Stringa non valida: deve terminare con "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Stringa non valida: deve includere "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Stringa non valida: deve corrispondere al pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chiav${issue2.keys.length > 1 ? "i" : "e"} non riconosciut${issue2.keys.length > 1 ? "e" : "a"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${issue2.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${issue2.origin}`;
      default:
        return `Input non valido`;
    }
  };
};
function it_default() {
  return {
    localeError: error19()
  };
}
// node_modules/zod/v4/locales/ja.js
var error20 = () => {
  const Sizable = {
    string: { unit: "文字", verb: "である" },
    file: { unit: "バイト", verb: "である" },
    array: { unit: "要素", verb: "である" },
    set: { unit: "要素", verb: "である" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType4 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "数値";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "配列";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "入力値",
    email: "メールアドレス",
    url: "URL",
    emoji: "絵文字",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO日時",
    date: "ISO日付",
    time: "ISO時刻",
    duration: "ISO期間",
    ipv4: "IPv4アドレス",
    ipv6: "IPv6アドレス",
    cidrv4: "IPv4範囲",
    cidrv6: "IPv6範囲",
    base64: "base64エンコード文字列",
    base64url: "base64urlエンコード文字列",
    json_string: "JSON文字列",
    e164: "E.164番号",
    jwt: "JWT",
    template_literal: "入力値"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `無効な入力: ${issue2.expected}が期待されましたが、${parsedType4(issue2.input)}が入力されました`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `無効な入力: ${stringifyPrimitive(issue2.values[0])}が期待されました`;
        return `無効な選択: ${joinValues(issue2.values, "、")}のいずれかである必要があります`;
      case "too_big": {
        const adj = issue2.inclusive ? "以下である" : "より小さい";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `大きすぎる値: ${issue2.origin ?? "値"}は${issue2.maximum.toString()}${sizing.unit ?? "要素"}${adj}必要があります`;
        return `大きすぎる値: ${issue2.origin ?? "値"}は${issue2.maximum.toString()}${adj}必要があります`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "以上である" : "より大きい";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `小さすぎる値: ${issue2.origin}は${issue2.minimum.toString()}${sizing.unit}${adj}必要があります`;
        return `小さすぎる値: ${issue2.origin}は${issue2.minimum.toString()}${adj}必要があります`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `無効な文字列: "${_issue.prefix}"で始まる必要があります`;
        if (_issue.format === "ends_with")
          return `無効な文字列: "${_issue.suffix}"で終わる必要があります`;
        if (_issue.format === "includes")
          return `無効な文字列: "${_issue.includes}"を含む必要があります`;
        if (_issue.format === "regex")
          return `無効な文字列: パターン${_issue.pattern}に一致する必要があります`;
        return `無効な${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `無効な数値: ${issue2.divisor}の倍数である必要があります`;
      case "unrecognized_keys":
        return `認識されていないキー${issue2.keys.length > 1 ? "群" : ""}: ${joinValues(issue2.keys, "、")}`;
      case "invalid_key":
        return `${issue2.origin}内の無効なキー`;
      case "invalid_union":
        return "無効な入力";
      case "invalid_element":
        return `${issue2.origin}内の無効な値`;
      default:
        return `無効な入力`;
    }
  };
};
function ja_default() {
  return {
    localeError: error20()
  };
}
// node_modules/zod/v4/locales/ka.js
var parsedType4 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "რიცხვი";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "მასივი";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  const typeMap = {
    string: "სტრინგი",
    boolean: "ბულეანი",
    undefined: "undefined",
    bigint: "bigint",
    symbol: "symbol",
    function: "ფუნქცია"
  };
  return typeMap[t] ?? t;
};
var error21 = () => {
  const Sizable = {
    string: { unit: "სიმბოლო", verb: "უნდა შეიცავდეს" },
    file: { unit: "ბაიტი", verb: "უნდა შეიცავდეს" },
    array: { unit: "ელემენტი", verb: "უნდა შეიცავდეს" },
    set: { unit: "ელემენტი", verb: "უნდა შეიცავდეს" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "შეყვანა",
    email: "ელ-ფოსტის მისამართი",
    url: "URL",
    emoji: "ემოჯი",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "თარიღი-დრო",
    date: "თარიღი",
    time: "დრო",
    duration: "ხანგრძლივობა",
    ipv4: "IPv4 მისამართი",
    ipv6: "IPv6 მისამართი",
    cidrv4: "IPv4 დიაპაზონი",
    cidrv6: "IPv6 დიაპაზონი",
    base64: "base64-კოდირებული სტრინგი",
    base64url: "base64url-კოდირებული სტრინგი",
    json_string: "JSON სტრინგი",
    e164: "E.164 ნომერი",
    jwt: "JWT",
    template_literal: "შეყვანა"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `არასწორი შეყვანა: მოსალოდნელი ${issue2.expected}, მიღებული ${parsedType4(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `არასწორი შეყვანა: მოსალოდნელი ${stringifyPrimitive(issue2.values[0])}`;
        return `არასწორი ვარიანტი: მოსალოდნელია ერთ-ერთი ${joinValues(issue2.values, "|")}-დან`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `ზედმეტად დიდი: მოსალოდნელი ${issue2.origin ?? "მნიშვნელობა"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `ზედმეტად დიდი: მოსალოდნელი ${issue2.origin ?? "მნიშვნელობა"} იყოს ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `ზედმეტად პატარა: მოსალოდნელი ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `ზედმეტად პატარა: მოსალოდნელი ${issue2.origin} იყოს ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `არასწორი სტრინგი: უნდა იწყებოდეს "${_issue.prefix}"-ით`;
        }
        if (_issue.format === "ends_with")
          return `არასწორი სტრინგი: უნდა მთავრდებოდეს "${_issue.suffix}"-ით`;
        if (_issue.format === "includes")
          return `არასწორი სტრინგი: უნდა შეიცავდეს "${_issue.includes}"-ს`;
        if (_issue.format === "regex")
          return `არასწორი სტრინგი: უნდა შეესაბამებოდეს შაბლონს ${_issue.pattern}`;
        return `არასწორი ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `არასწორი რიცხვი: უნდა იყოს ${issue2.divisor}-ის ჯერადი`;
      case "unrecognized_keys":
        return `უცნობი გასაღებ${issue2.keys.length > 1 ? "ები" : "ი"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `არასწორი გასაღები ${issue2.origin}-ში`;
      case "invalid_union":
        return "არასწორი შეყვანა";
      case "invalid_element":
        return `არასწორი მნიშვნელობა ${issue2.origin}-ში`;
      default:
        return `არასწორი შეყვანა`;
    }
  };
};
function ka_default() {
  return {
    localeError: error21()
  };
}
// node_modules/zod/v4/locales/km.js
var error22 = () => {
  const Sizable = {
    string: { unit: "តួអក្សរ", verb: "គួរមាន" },
    file: { unit: "បៃ", verb: "គួរមាន" },
    array: { unit: "ធាតុ", verb: "គួរមាន" },
    set: { unit: "ធាតុ", verb: "គួរមាន" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType5 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "មិនមែនជាលេខ (NaN)" : "លេខ";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "អារេ (Array)";
        }
        if (data === null) {
          return "គ្មានតម្លៃ (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ទិន្នន័យបញ្ចូល",
    email: "អាសយដ្ឋានអ៊ីមែល",
    url: "URL",
    emoji: "សញ្ញាអារម្មណ៍",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "កាលបរិច្ឆេទ និងម៉ោង ISO",
    date: "កាលបរិច្ឆេទ ISO",
    time: "ម៉ោង ISO",
    duration: "រយៈពេល ISO",
    ipv4: "អាសយដ្ឋាន IPv4",
    ipv6: "អាសយដ្ឋាន IPv6",
    cidrv4: "ដែនអាសយដ្ឋាន IPv4",
    cidrv6: "ដែនអាសយដ្ឋាន IPv6",
    base64: "ខ្សែអក្សរអ៊ិកូដ base64",
    base64url: "ខ្សែអក្សរអ៊ិកូដ base64url",
    json_string: "ខ្សែអក្សរ JSON",
    e164: "លេខ E.164",
    jwt: "JWT",
    template_literal: "ទិន្នន័យបញ្ចូល"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${issue2.expected} ប៉ុន្តែទទួលបាន ${parsedType5(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${stringifyPrimitive(issue2.values[0])}`;
        return `ជម្រើសមិនត្រឹមត្រូវ៖ ត្រូវជាមួយក្នុងចំណោម ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `ធំពេក៖ ត្រូវការ ${issue2.origin ?? "តម្លៃ"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "ធាតុ"}`;
        return `ធំពេក៖ ត្រូវការ ${issue2.origin ?? "តម្លៃ"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `តូចពេក៖ ត្រូវការ ${issue2.origin} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `តូចពេក៖ ត្រូវការ ${issue2.origin} ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវចាប់ផ្តើមដោយ "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវបញ្ចប់ដោយ "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវមាន "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវតែផ្គូផ្គងនឹងទម្រង់ដែលបានកំណត់ ${_issue.pattern}`;
        return `មិនត្រឹមត្រូវ៖ ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `លេខមិនត្រឹមត្រូវ៖ ត្រូវតែជាពហុគុណនៃ ${issue2.divisor}`;
      case "unrecognized_keys":
        return `រកឃើញសោមិនស្គាល់៖ ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `សោមិនត្រឹមត្រូវនៅក្នុង ${issue2.origin}`;
      case "invalid_union":
        return `ទិន្នន័យមិនត្រឹមត្រូវ`;
      case "invalid_element":
        return `ទិន្នន័យមិនត្រឹមត្រូវនៅក្នុង ${issue2.origin}`;
      default:
        return `ទិន្នន័យមិនត្រឹមត្រូវ`;
    }
  };
};
function km_default() {
  return {
    localeError: error22()
  };
}

// node_modules/zod/v4/locales/kh.js
function kh_default() {
  return km_default();
}
// node_modules/zod/v4/locales/ko.js
var error23 = () => {
  const Sizable = {
    string: { unit: "문자", verb: "to have" },
    file: { unit: "바이트", verb: "to have" },
    array: { unit: "개", verb: "to have" },
    set: { unit: "개", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType5 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "입력",
    email: "이메일 주소",
    url: "URL",
    emoji: "이모지",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO 날짜시간",
    date: "ISO 날짜",
    time: "ISO 시간",
    duration: "ISO 기간",
    ipv4: "IPv4 주소",
    ipv6: "IPv6 주소",
    cidrv4: "IPv4 범위",
    cidrv6: "IPv6 범위",
    base64: "base64 인코딩 문자열",
    base64url: "base64url 인코딩 문자열",
    json_string: "JSON 문자열",
    e164: "E.164 번호",
    jwt: "JWT",
    template_literal: "입력"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `잘못된 입력: 예상 타입은 ${issue2.expected}, 받은 타입은 ${parsedType5(issue2.input)}입니다`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `잘못된 입력: 값은 ${stringifyPrimitive(issue2.values[0])} 이어야 합니다`;
        return `잘못된 옵션: ${joinValues(issue2.values, "또는 ")} 중 하나여야 합니다`;
      case "too_big": {
        const adj = issue2.inclusive ? "이하" : "미만";
        const suffix = adj === "미만" ? "이어야 합니다" : "여야 합니다";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "요소";
        if (sizing)
          return `${issue2.origin ?? "값"}이 너무 큽니다: ${issue2.maximum.toString()}${unit} ${adj}${suffix}`;
        return `${issue2.origin ?? "값"}이 너무 큽니다: ${issue2.maximum.toString()} ${adj}${suffix}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "이상" : "초과";
        const suffix = adj === "이상" ? "이어야 합니다" : "여야 합니다";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "요소";
        if (sizing) {
          return `${issue2.origin ?? "값"}이 너무 작습니다: ${issue2.minimum.toString()}${unit} ${adj}${suffix}`;
        }
        return `${issue2.origin ?? "값"}이 너무 작습니다: ${issue2.minimum.toString()} ${adj}${suffix}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `잘못된 문자열: "${_issue.prefix}"(으)로 시작해야 합니다`;
        }
        if (_issue.format === "ends_with")
          return `잘못된 문자열: "${_issue.suffix}"(으)로 끝나야 합니다`;
        if (_issue.format === "includes")
          return `잘못된 문자열: "${_issue.includes}"을(를) 포함해야 합니다`;
        if (_issue.format === "regex")
          return `잘못된 문자열: 정규식 ${_issue.pattern} 패턴과 일치해야 합니다`;
        return `잘못된 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `잘못된 숫자: ${issue2.divisor}의 배수여야 합니다`;
      case "unrecognized_keys":
        return `인식할 수 없는 키: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `잘못된 키: ${issue2.origin}`;
      case "invalid_union":
        return `잘못된 입력`;
      case "invalid_element":
        return `잘못된 값: ${issue2.origin}`;
      default:
        return `잘못된 입력`;
    }
  };
};
function ko_default() {
  return {
    localeError: error23()
  };
}
// node_modules/zod/v4/locales/lt.js
var parsedType5 = (data) => {
  const t = typeof data;
  return parsedTypeFromType(t, data);
};
var parsedTypeFromType = (t, data = undefined) => {
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "skaičius";
    }
    case "bigint": {
      return "sveikasis skaičius";
    }
    case "string": {
      return "eilutė";
    }
    case "boolean": {
      return "loginė reikšmė";
    }
    case "undefined":
    case "void": {
      return "neapibrėžta reikšmė";
    }
    case "function": {
      return "funkcija";
    }
    case "symbol": {
      return "simbolis";
    }
    case "object": {
      if (data === undefined)
        return "nežinomas objektas";
      if (data === null)
        return "nulinė reikšmė";
      if (Array.isArray(data))
        return "masyvas";
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
      return "objektas";
    }
    case "null": {
      return "nulinė reikšmė";
    }
  }
  return t;
};
var capitalizeFirstCharacter = (text) => {
  return text.charAt(0).toUpperCase() + text.slice(1);
};
function getUnitTypeFromNumber(number2) {
  const abs = Math.abs(number2);
  const last = abs % 10;
  const last2 = abs % 100;
  if (last2 >= 11 && last2 <= 19 || last === 0)
    return "many";
  if (last === 1)
    return "one";
  return "few";
}
var error24 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "simbolis",
        few: "simboliai",
        many: "simbolių"
      },
      verb: {
        smaller: {
          inclusive: "turi būti ne ilgesnė kaip",
          notInclusive: "turi būti trumpesnė kaip"
        },
        bigger: {
          inclusive: "turi būti ne trumpesnė kaip",
          notInclusive: "turi būti ilgesnė kaip"
        }
      }
    },
    file: {
      unit: {
        one: "baitas",
        few: "baitai",
        many: "baitų"
      },
      verb: {
        smaller: {
          inclusive: "turi būti ne didesnis kaip",
          notInclusive: "turi būti mažesnis kaip"
        },
        bigger: {
          inclusive: "turi būti ne mažesnis kaip",
          notInclusive: "turi būti didesnis kaip"
        }
      }
    },
    array: {
      unit: {
        one: "elementą",
        few: "elementus",
        many: "elementų"
      },
      verb: {
        smaller: {
          inclusive: "turi turėti ne daugiau kaip",
          notInclusive: "turi turėti mažiau kaip"
        },
        bigger: {
          inclusive: "turi turėti ne mažiau kaip",
          notInclusive: "turi turėti daugiau kaip"
        }
      }
    },
    set: {
      unit: {
        one: "elementą",
        few: "elementus",
        many: "elementų"
      },
      verb: {
        smaller: {
          inclusive: "turi turėti ne daugiau kaip",
          notInclusive: "turi turėti mažiau kaip"
        },
        bigger: {
          inclusive: "turi turėti ne mažiau kaip",
          notInclusive: "turi turėti daugiau kaip"
        }
      }
    }
  };
  function getSizing(origin, unitType, inclusive, targetShouldBe) {
    const result = Sizable[origin] ?? null;
    if (result === null)
      return result;
    return {
      unit: result.unit[unitType],
      verb: result.verb[targetShouldBe][inclusive ? "inclusive" : "notInclusive"]
    };
  }
  const Nouns = {
    regex: "įvestis",
    email: "el. pašto adresas",
    url: "URL",
    emoji: "jaustukas",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO data ir laikas",
    date: "ISO data",
    time: "ISO laikas",
    duration: "ISO trukmė",
    ipv4: "IPv4 adresas",
    ipv6: "IPv6 adresas",
    cidrv4: "IPv4 tinklo prefiksas (CIDR)",
    cidrv6: "IPv6 tinklo prefiksas (CIDR)",
    base64: "base64 užkoduota eilutė",
    base64url: "base64url užkoduota eilutė",
    json_string: "JSON eilutė",
    e164: "E.164 numeris",
    jwt: "JWT",
    template_literal: "įvestis"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Gautas tipas ${parsedType5(issue2.input)}, o tikėtasi - ${parsedTypeFromType(issue2.expected)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Privalo būti ${stringifyPrimitive(issue2.values[0])}`;
        return `Privalo būti vienas iš ${joinValues(issue2.values, "|")} pasirinkimų`;
      case "too_big": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.maximum)), issue2.inclusive ?? false, "smaller");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} ${sizing.verb} ${issue2.maximum.toString()} ${sizing.unit ?? "elementų"}`;
        const adj = issue2.inclusive ? "ne didesnis kaip" : "mažesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} turi būti ${adj} ${issue2.maximum.toString()} ${sizing?.unit}`;
      }
      case "too_small": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.minimum)), issue2.inclusive ?? false, "bigger");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} ${sizing.verb} ${issue2.minimum.toString()} ${sizing.unit ?? "elementų"}`;
        const adj = issue2.inclusive ? "ne mažesnis kaip" : "didesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} turi būti ${adj} ${issue2.minimum.toString()} ${sizing?.unit}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Eilutė privalo prasidėti "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Eilutė privalo pasibaigti "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Eilutė privalo įtraukti "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Eilutė privalo atitikti ${_issue.pattern}`;
        return `Neteisingas ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Skaičius privalo būti ${issue2.divisor} kartotinis.`;
      case "unrecognized_keys":
        return `Neatpažint${issue2.keys.length > 1 ? "i" : "as"} rakt${issue2.keys.length > 1 ? "ai" : "as"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Rastas klaidingas raktas";
      case "invalid_union":
        return "Klaidinga įvestis";
      case "invalid_element": {
        const origin = parsedTypeFromType(issue2.origin);
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} turi klaidingą įvestį`;
      }
      default:
        return "Klaidinga įvestis";
    }
  };
};
function lt_default() {
  return {
    localeError: error24()
  };
}
// node_modules/zod/v4/locales/mk.js
var error25 = () => {
  const Sizable = {
    string: { unit: "знаци", verb: "да имаат" },
    file: { unit: "бајти", verb: "да имаат" },
    array: { unit: "ставки", verb: "да имаат" },
    set: { unit: "ставки", verb: "да имаат" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "број";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "низа";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "внес",
    email: "адреса на е-пошта",
    url: "URL",
    emoji: "емоџи",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO датум и време",
    date: "ISO датум",
    time: "ISO време",
    duration: "ISO времетраење",
    ipv4: "IPv4 адреса",
    ipv6: "IPv6 адреса",
    cidrv4: "IPv4 опсег",
    cidrv6: "IPv6 опсег",
    base64: "base64-енкодирана низа",
    base64url: "base64url-енкодирана низа",
    json_string: "JSON низа",
    e164: "E.164 број",
    jwt: "JWT",
    template_literal: "внес"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Грешен внес: се очекува ${issue2.expected}, примено ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Грешана опција: се очекува една ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Премногу голем: се очекува ${issue2.origin ?? "вредноста"} да има ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "елементи"}`;
        return `Премногу голем: се очекува ${issue2.origin ?? "вредноста"} да биде ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Премногу мал: се очекува ${issue2.origin} да има ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Премногу мал: се очекува ${issue2.origin} да биде ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Неважечка низа: мора да започнува со "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Неважечка низа: мора да завршува со "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неважечка низа: мора да вклучува "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неважечка низа: мора да одгоара на патернот ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Грешен број: мора да биде делив со ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Непрепознаени клучеви" : "Непрепознаен клуч"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Грешен клуч во ${issue2.origin}`;
      case "invalid_union":
        return "Грешен внес";
      case "invalid_element":
        return `Грешна вредност во ${issue2.origin}`;
      default:
        return `Грешен внес`;
    }
  };
};
function mk_default() {
  return {
    localeError: error25()
  };
}
// node_modules/zod/v4/locales/ms.js
var error26 = () => {
  const Sizable = {
    string: { unit: "aksara", verb: "mempunyai" },
    file: { unit: "bait", verb: "mempunyai" },
    array: { unit: "elemen", verb: "mempunyai" },
    set: { unit: "elemen", verb: "mempunyai" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombor";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat e-mel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tarikh masa ISO",
    date: "tarikh ISO",
    time: "masa ISO",
    duration: "tempoh ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "julat IPv4",
    cidrv6: "julat IPv6",
    base64: "string dikodkan base64",
    base64url: "string dikodkan base64url",
    json_string: "string JSON",
    e164: "nombor E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input tidak sah: dijangka ${issue2.expected}, diterima ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak sah: dijangka ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} adalah ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: dijangka ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: dijangka ${issue2.origin} adalah ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak sah: mesti bermula dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak sah: mesti berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak sah: mesti mengandungi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak sah: mesti sepadan dengan corak ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${issue2.origin}`;
      default:
        return `Input tidak sah`;
    }
  };
};
function ms_default() {
  return {
    localeError: error26()
  };
}
// node_modules/zod/v4/locales/nl.js
var error27 = () => {
  const Sizable = {
    string: { unit: "tekens" },
    file: { unit: "bytes" },
    array: { unit: "elementen" },
    set: { unit: "elementen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "getal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "invoer",
    email: "emailadres",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum en tijd",
    date: "ISO datum",
    time: "ISO tijd",
    duration: "ISO duur",
    ipv4: "IPv4-adres",
    ipv6: "IPv6-adres",
    cidrv4: "IPv4-bereik",
    cidrv6: "IPv6-bereik",
    base64: "base64-gecodeerde tekst",
    base64url: "base64 URL-gecodeerde tekst",
    json_string: "JSON string",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "invoer"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ongeldige invoer: verwacht ${issue2.expected}, ontving ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ongeldige invoer: verwacht ${stringifyPrimitive(issue2.values[0])}`;
        return `Ongeldige optie: verwacht één van ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Te lang: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementen"} bevat`;
        return `Te lang: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} is`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Te kort: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} bevat`;
        }
        return `Te kort: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} is`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ongeldige tekst: moet met "${_issue.prefix}" beginnen`;
        }
        if (_issue.format === "ends_with")
          return `Ongeldige tekst: moet op "${_issue.suffix}" eindigen`;
        if (_issue.format === "includes")
          return `Ongeldige tekst: moet "${_issue.includes}" bevatten`;
        if (_issue.format === "regex")
          return `Ongeldige tekst: moet overeenkomen met patroon ${_issue.pattern}`;
        return `Ongeldig: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${issue2.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${issue2.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${issue2.origin}`;
      default:
        return `Ongeldige invoer`;
    }
  };
};
function nl_default() {
  return {
    localeError: error27()
  };
}
// node_modules/zod/v4/locales/no.js
var error28 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "å ha" },
    file: { unit: "bytes", verb: "å ha" },
    array: { unit: "elementer", verb: "å inneholde" },
    set: { unit: "elementer", verb: "å inneholde" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tall";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-postadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslett",
    date: "ISO-dato",
    time: "ISO-klokkeslett",
    duration: "ISO-varighet",
    ipv4: "IPv4-område",
    ipv6: "IPv6-område",
    cidrv4: "IPv4-spekter",
    cidrv6: "IPv6-spekter",
    base64: "base64-enkodet streng",
    base64url: "base64url-enkodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ugyldig input: forventet ${issue2.expected}, fikk ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig verdi: forventet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldig valg: forventet en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `For stor(t): forventet ${issue2.origin ?? "value"} til å ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor(t): forventet ${issue2.origin ?? "value"} til å ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `For lite(n): forventet ${issue2.origin} til å ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lite(n): forventet ${issue2.origin} til å ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: må starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: må ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: må inneholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: må matche mønsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: må være et multiplum av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukjente nøkler" : "Ukjent nøkkel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig nøkkel i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${issue2.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function no_default() {
  return {
    localeError: error28()
  };
}
// node_modules/zod/v4/locales/ota.js
var error29 = () => {
  const Sizable = {
    string: { unit: "harf", verb: "olmalıdır" },
    file: { unit: "bayt", verb: "olmalıdır" },
    array: { unit: "unsur", verb: "olmalıdır" },
    set: { unit: "unsur", verb: "olmalıdır" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numara";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "saf";
        }
        if (data === null) {
          return "gayb";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "giren",
    email: "epostagâh",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO hengâmı",
    date: "ISO tarihi",
    time: "ISO zamanı",
    duration: "ISO müddeti",
    ipv4: "IPv4 nişânı",
    ipv6: "IPv6 nişânı",
    cidrv4: "IPv4 menzili",
    cidrv6: "IPv6 menzili",
    base64: "base64-şifreli metin",
    base64url: "base64url-şifreli metin",
    json_string: "JSON metin",
    e164: "E.164 sayısı",
    jwt: "JWT",
    template_literal: "giren"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Fâsit giren: umulan ${issue2.expected}, alınan ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Fâsit giren: umulan ${stringifyPrimitive(issue2.values[0])}`;
        return `Fâsit tercih: mûteberler ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Fazla büyük: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"} sahip olmalıydı.`;
        return `Fazla büyük: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} olmalıydı.`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Fazla küçük: ${issue2.origin}, ${adj}${issue2.minimum.toString()} ${sizing.unit} sahip olmalıydı.`;
        }
        return `Fazla küçük: ${issue2.origin}, ${adj}${issue2.minimum.toString()} olmalıydı.`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Fâsit metin: "${_issue.prefix}" ile başlamalı.`;
        if (_issue.format === "ends_with")
          return `Fâsit metin: "${_issue.suffix}" ile bitmeli.`;
        if (_issue.format === "includes")
          return `Fâsit metin: "${_issue.includes}" ihtivâ etmeli.`;
        if (_issue.format === "regex")
          return `Fâsit metin: ${_issue.pattern} nakşına uymalı.`;
        return `Fâsit ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Fâsit sayı: ${issue2.divisor} katı olmalıydı.`;
      case "unrecognized_keys":
        return `Tanınmayan anahtar ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} için tanınmayan anahtar var.`;
      case "invalid_union":
        return "Giren tanınamadı.";
      case "invalid_element":
        return `${issue2.origin} için tanınmayan kıymet var.`;
      default:
        return `Kıymet tanınamadı.`;
    }
  };
};
function ota_default() {
  return {
    localeError: error29()
  };
}
// node_modules/zod/v4/locales/ps.js
var error30 = () => {
  const Sizable = {
    string: { unit: "توکي", verb: "ولري" },
    file: { unit: "بایټس", verb: "ولري" },
    array: { unit: "توکي", verb: "ولري" },
    set: { unit: "توکي", verb: "ولري" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "عدد";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "ارې";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ورودي",
    email: "بریښنالیک",
    url: "یو آر ال",
    emoji: "ایموجي",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "نیټه او وخت",
    date: "نېټه",
    time: "وخت",
    duration: "موده",
    ipv4: "د IPv4 پته",
    ipv6: "د IPv6 پته",
    cidrv4: "د IPv4 ساحه",
    cidrv6: "د IPv6 ساحه",
    base64: "base64-encoded متن",
    base64url: "base64url-encoded متن",
    json_string: "JSON متن",
    e164: "د E.164 شمېره",
    jwt: "JWT",
    template_literal: "ورودي"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ناسم ورودي: باید ${issue2.expected} وای, مګر ${parsedType6(issue2.input)} ترلاسه شو`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `ناسم ورودي: باید ${stringifyPrimitive(issue2.values[0])} وای`;
        }
        return `ناسم انتخاب: باید یو له ${joinValues(issue2.values, "|")} څخه وای`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `ډیر لوی: ${issue2.origin ?? "ارزښت"} باید ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "عنصرونه"} ولري`;
        }
        return `ډیر لوی: ${issue2.origin ?? "ارزښت"} باید ${adj}${issue2.maximum.toString()} وي`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `ډیر کوچنی: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} ${sizing.unit} ولري`;
        }
        return `ډیر کوچنی: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} وي`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `ناسم متن: باید د "${_issue.prefix}" سره پیل شي`;
        }
        if (_issue.format === "ends_with") {
          return `ناسم متن: باید د "${_issue.suffix}" سره پای ته ورسيږي`;
        }
        if (_issue.format === "includes") {
          return `ناسم متن: باید "${_issue.includes}" ولري`;
        }
        if (_issue.format === "regex") {
          return `ناسم متن: باید د ${_issue.pattern} سره مطابقت ولري`;
        }
        return `${Nouns[_issue.format] ?? issue2.format} ناسم دی`;
      }
      case "not_multiple_of":
        return `ناسم عدد: باید د ${issue2.divisor} مضرب وي`;
      case "unrecognized_keys":
        return `ناسم ${issue2.keys.length > 1 ? "کلیډونه" : "کلیډ"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `ناسم کلیډ په ${issue2.origin} کې`;
      case "invalid_union":
        return `ناسمه ورودي`;
      case "invalid_element":
        return `ناسم عنصر په ${issue2.origin} کې`;
      default:
        return `ناسمه ورودي`;
    }
  };
};
function ps_default() {
  return {
    localeError: error30()
  };
}
// node_modules/zod/v4/locales/pl.js
var error31 = () => {
  const Sizable = {
    string: { unit: "znaków", verb: "mieć" },
    file: { unit: "bajtów", verb: "mieć" },
    array: { unit: "elementów", verb: "mieć" },
    set: { unit: "elementów", verb: "mieć" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "liczba";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tablica";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "wyrażenie",
    email: "adres email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i godzina w formacie ISO",
    date: "data w formacie ISO",
    time: "godzina w formacie ISO",
    duration: "czas trwania ISO",
    ipv4: "adres IPv4",
    ipv6: "adres IPv6",
    cidrv4: "zakres IPv4",
    cidrv6: "zakres IPv6",
    base64: "ciąg znaków zakodowany w formacie base64",
    base64url: "ciąg znaków zakodowany w formacie base64url",
    json_string: "ciąg znaków w formacie JSON",
    e164: "liczba E.164",
    jwt: "JWT",
    template_literal: "wejście"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Nieprawidłowe dane wejściowe: oczekiwano ${issue2.expected}, otrzymano ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nieprawidłowe dane wejściowe: oczekiwano ${stringifyPrimitive(issue2.values[0])}`;
        return `Nieprawidłowa opcja: oczekiwano jednej z wartości ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za duża wartość: oczekiwano, że ${issue2.origin ?? "wartość"} będzie mieć ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementów"}`;
        }
        return `Zbyt duż(y/a/e): oczekiwano, że ${issue2.origin ?? "wartość"} będzie wynosić ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za mała wartość: oczekiwano, że ${issue2.origin ?? "wartość"} będzie mieć ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "elementów"}`;
        }
        return `Zbyt mał(y/a/e): oczekiwano, że ${issue2.origin ?? "wartość"} będzie wynosić ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nieprawidłowy ciąg znaków: musi zaczynać się od "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nieprawidłowy ciąg znaków: musi kończyć się na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nieprawidłowy ciąg znaków: musi zawierać "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nieprawidłowy ciąg znaków: musi odpowiadać wzorcowi ${_issue.pattern}`;
        return `Nieprawidłow(y/a/e) ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nieprawidłowa liczba: musi być wielokrotnością ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawidłowy klucz w ${issue2.origin}`;
      case "invalid_union":
        return "Nieprawidłowe dane wejściowe";
      case "invalid_element":
        return `Nieprawidłowa wartość w ${issue2.origin}`;
      default:
        return `Nieprawidłowe dane wejściowe`;
    }
  };
};
function pl_default() {
  return {
    localeError: error31()
  };
}
// node_modules/zod/v4/locales/pt.js
var error32 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "ter" },
    file: { unit: "bytes", verb: "ter" },
    array: { unit: "itens", verb: "ter" },
    set: { unit: "itens", verb: "ter" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "número";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "nulo";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "padrão",
    email: "endereço de e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "duração ISO",
    ipv4: "endereço IPv4",
    ipv6: "endereço IPv6",
    cidrv4: "faixa de IPv4",
    cidrv6: "faixa de IPv6",
    base64: "texto codificado em base64",
    base64url: "URL codificada em base64",
    json_string: "texto JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Tipo inválido: esperado ${issue2.expected}, recebido ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inválida: esperado ${stringifyPrimitive(issue2.values[0])}`;
        return `Opção inválida: esperada uma das ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Muito grande: esperado que ${issue2.origin ?? "valor"} tivesse ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${issue2.origin ?? "valor"} fosse ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Muito pequeno: esperado que ${issue2.origin} tivesse ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Muito pequeno: esperado que ${issue2.origin} fosse ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Texto inválido: deve começar com "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Texto inválido: deve terminar com "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Texto inválido: deve incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Texto inválido: deve corresponder ao padrão ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} inválido`;
      }
      case "not_multiple_of":
        return `Número inválido: deve ser múltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chave${issue2.keys.length > 1 ? "s" : ""} desconhecida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chave inválida em ${issue2.origin}`;
      case "invalid_union":
        return "Entrada inválida";
      case "invalid_element":
        return `Valor inválido em ${issue2.origin}`;
      default:
        return `Campo inválido`;
    }
  };
};
function pt_default() {
  return {
    localeError: error32()
  };
}
// node_modules/zod/v4/locales/ru.js
function getRussianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error33 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "символ",
        few: "символа",
        many: "символов"
      },
      verb: "иметь"
    },
    file: {
      unit: {
        one: "байт",
        few: "байта",
        many: "байт"
      },
      verb: "иметь"
    },
    array: {
      unit: {
        one: "элемент",
        few: "элемента",
        many: "элементов"
      },
      verb: "иметь"
    },
    set: {
      unit: {
        one: "элемент",
        few: "элемента",
        many: "элементов"
      },
      verb: "иметь"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "число";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "массив";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ввод",
    email: "email адрес",
    url: "URL",
    emoji: "эмодзи",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO дата и время",
    date: "ISO дата",
    time: "ISO время",
    duration: "ISO длительность",
    ipv4: "IPv4 адрес",
    ipv6: "IPv6 адрес",
    cidrv4: "IPv4 диапазон",
    cidrv6: "IPv6 диапазон",
    base64: "строка в формате base64",
    base64url: "строка в формате base64url",
    json_string: "JSON строка",
    e164: "номер E.164",
    jwt: "JWT",
    template_literal: "ввод"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Неверный ввод: ожидалось ${issue2.expected}, получено ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Неверный ввод: ожидалось ${stringifyPrimitive(issue2.values[0])}`;
        return `Неверный вариант: ожидалось одно из ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getRussianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Слишком большое значение: ожидалось, что ${issue2.origin ?? "значение"} будет иметь ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `Слишком большое значение: ожидалось, что ${issue2.origin ?? "значение"} будет ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getRussianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Слишком маленькое значение: ожидалось, что ${issue2.origin} будет иметь ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `Слишком маленькое значение: ожидалось, что ${issue2.origin} будет ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Неверная строка: должна начинаться с "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Неверная строка: должна заканчиваться на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неверная строка: должна содержать "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неверная строка: должна соответствовать шаблону ${_issue.pattern}`;
        return `Неверный ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Неверное число: должно быть кратным ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Нераспознанн${issue2.keys.length > 1 ? "ые" : "ый"} ключ${issue2.keys.length > 1 ? "и" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Неверный ключ в ${issue2.origin}`;
      case "invalid_union":
        return "Неверные входные данные";
      case "invalid_element":
        return `Неверное значение в ${issue2.origin}`;
      default:
        return `Неверные входные данные`;
    }
  };
};
function ru_default() {
  return {
    localeError: error33()
  };
}
// node_modules/zod/v4/locales/sl.js
var error34 = () => {
  const Sizable = {
    string: { unit: "znakov", verb: "imeti" },
    file: { unit: "bajtov", verb: "imeti" },
    array: { unit: "elementov", verb: "imeti" },
    set: { unit: "elementov", verb: "imeti" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "število";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tabela";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "vnos",
    email: "e-poštni naslov",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum in čas",
    date: "ISO datum",
    time: "ISO čas",
    duration: "ISO trajanje",
    ipv4: "IPv4 naslov",
    ipv6: "IPv6 naslov",
    cidrv4: "obseg IPv4",
    cidrv6: "obseg IPv6",
    base64: "base64 kodiran niz",
    base64url: "base64url kodiran niz",
    json_string: "JSON niz",
    e164: "E.164 številka",
    jwt: "JWT",
    template_literal: "vnos"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Neveljaven vnos: pričakovano ${issue2.expected}, prejeto ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neveljaven vnos: pričakovano ${stringifyPrimitive(issue2.values[0])}`;
        return `Neveljavna možnost: pričakovano eno izmed ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Preveliko: pričakovano, da bo ${issue2.origin ?? "vrednost"} imelo ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementov"}`;
        return `Preveliko: pričakovano, da bo ${issue2.origin ?? "vrednost"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Premajhno: pričakovano, da bo ${issue2.origin} imelo ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Premajhno: pričakovano, da bo ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Neveljaven niz: mora se začeti z "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Neveljaven niz: mora se končati z "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neveljaven niz: mora vsebovati "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neveljaven niz: mora ustrezati vzorcu ${_issue.pattern}`;
        return `Neveljaven ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno število: mora biti večkratnik ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${issue2.keys.length > 1 ? "i ključi" : " ključ"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven ključ v ${issue2.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${issue2.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function sl_default() {
  return {
    localeError: error34()
  };
}
// node_modules/zod/v4/locales/sv.js
var error35 = () => {
  const Sizable = {
    string: { unit: "tecken", verb: "att ha" },
    file: { unit: "bytes", verb: "att ha" },
    array: { unit: "objekt", verb: "att innehålla" },
    set: { unit: "objekt", verb: "att innehålla" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "antal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "lista";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "reguljärt uttryck",
    email: "e-postadress",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datum och tid",
    date: "ISO-datum",
    time: "ISO-tid",
    duration: "ISO-varaktighet",
    ipv4: "IPv4-intervall",
    ipv6: "IPv6-intervall",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodad sträng",
    base64url: "base64url-kodad sträng",
    json_string: "JSON-sträng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "mall-literal"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ogiltig inmatning: förväntat ${issue2.expected}, fick ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ogiltig inmatning: förväntat ${stringifyPrimitive(issue2.values[0])}`;
        return `Ogiltigt val: förväntade en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `För stor(t): förväntade ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        }
        return `För stor(t): förväntat ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `För lite(t): förväntade ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `För lite(t): förväntade ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ogiltig sträng: måste börja med "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ogiltig sträng: måste sluta med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ogiltig sträng: måste innehålla "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ogiltig sträng: måste matcha mönstret "${_issue.pattern}"`;
        return `Ogiltig(t) ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: måste vara en multipel av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Okända nycklar" : "Okänd nyckel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${issue2.origin ?? "värdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt värde i ${issue2.origin ?? "värdet"}`;
      default:
        return `Ogiltig input`;
    }
  };
};
function sv_default() {
  return {
    localeError: error35()
  };
}
// node_modules/zod/v4/locales/ta.js
var error36 = () => {
  const Sizable = {
    string: { unit: "எழுத்துக்கள்", verb: "கொண்டிருக்க வேண்டும்" },
    file: { unit: "பைட்டுகள்", verb: "கொண்டிருக்க வேண்டும்" },
    array: { unit: "உறுப்புகள்", verb: "கொண்டிருக்க வேண்டும்" },
    set: { unit: "உறுப்புகள்", verb: "கொண்டிருக்க வேண்டும்" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "எண் அல்லாதது" : "எண்";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "அணி";
        }
        if (data === null) {
          return "வெறுமை";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "உள்ளீடு",
    email: "மின்னஞ்சல் முகவரி",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO தேதி நேரம்",
    date: "ISO தேதி",
    time: "ISO நேரம்",
    duration: "ISO கால அளவு",
    ipv4: "IPv4 முகவரி",
    ipv6: "IPv6 முகவரி",
    cidrv4: "IPv4 வரம்பு",
    cidrv6: "IPv6 வரம்பு",
    base64: "base64-encoded சரம்",
    base64url: "base64url-encoded சரம்",
    json_string: "JSON சரம்",
    e164: "E.164 எண்",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${issue2.expected}, பெறப்பட்டது ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${stringifyPrimitive(issue2.values[0])}`;
        return `தவறான விருப்பம்: எதிர்பார்க்கப்பட்டது ${joinValues(issue2.values, "|")} இல் ஒன்று`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${issue2.origin ?? "மதிப்பு"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "உறுப்புகள்"} ஆக இருக்க வேண்டும்`;
        }
        return `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${issue2.origin ?? "மதிப்பு"} ${adj}${issue2.maximum.toString()} ஆக இருக்க வேண்டும்`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} ஆக இருக்க வேண்டும்`;
        }
        return `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${issue2.origin} ${adj}${issue2.minimum.toString()} ஆக இருக்க வேண்டும்`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `தவறான சரம்: "${_issue.prefix}" இல் தொடங்க வேண்டும்`;
        if (_issue.format === "ends_with")
          return `தவறான சரம்: "${_issue.suffix}" இல் முடிவடைய வேண்டும்`;
        if (_issue.format === "includes")
          return `தவறான சரம்: "${_issue.includes}" ஐ உள்ளடக்க வேண்டும்`;
        if (_issue.format === "regex")
          return `தவறான சரம்: ${_issue.pattern} முறைபாட்டுடன் பொருந்த வேண்டும்`;
        return `தவறான ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `தவறான எண்: ${issue2.divisor} இன் பலமாக இருக்க வேண்டும்`;
      case "unrecognized_keys":
        return `அடையாளம் தெரியாத விசை${issue2.keys.length > 1 ? "கள்" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} இல் தவறான விசை`;
      case "invalid_union":
        return "தவறான உள்ளீடு";
      case "invalid_element":
        return `${issue2.origin} இல் தவறான மதிப்பு`;
      default:
        return `தவறான உள்ளீடு`;
    }
  };
};
function ta_default() {
  return {
    localeError: error36()
  };
}
// node_modules/zod/v4/locales/th.js
var error37 = () => {
  const Sizable = {
    string: { unit: "ตัวอักษร", verb: "ควรมี" },
    file: { unit: "ไบต์", verb: "ควรมี" },
    array: { unit: "รายการ", verb: "ควรมี" },
    set: { unit: "รายการ", verb: "ควรมี" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "ไม่ใช่ตัวเลข (NaN)" : "ตัวเลข";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "อาร์เรย์ (Array)";
        }
        if (data === null) {
          return "ไม่มีค่า (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ข้อมูลที่ป้อน",
    email: "ที่อยู่อีเมล",
    url: "URL",
    emoji: "อิโมจิ",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "วันที่เวลาแบบ ISO",
    date: "วันที่แบบ ISO",
    time: "เวลาแบบ ISO",
    duration: "ช่วงเวลาแบบ ISO",
    ipv4: "ที่อยู่ IPv4",
    ipv6: "ที่อยู่ IPv6",
    cidrv4: "ช่วง IP แบบ IPv4",
    cidrv6: "ช่วง IP แบบ IPv6",
    base64: "ข้อความแบบ Base64",
    base64url: "ข้อความแบบ Base64 สำหรับ URL",
    json_string: "ข้อความแบบ JSON",
    e164: "เบอร์โทรศัพท์ระหว่างประเทศ (E.164)",
    jwt: "โทเคน JWT",
    template_literal: "ข้อมูลที่ป้อน"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ประเภทข้อมูลไม่ถูกต้อง: ควรเป็น ${issue2.expected} แต่ได้รับ ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `ค่าไม่ถูกต้อง: ควรเป็น ${stringifyPrimitive(issue2.values[0])}`;
        return `ตัวเลือกไม่ถูกต้อง: ควรเป็นหนึ่งใน ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "ไม่เกิน" : "น้อยกว่า";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `เกินกำหนด: ${issue2.origin ?? "ค่า"} ควรมี${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "รายการ"}`;
        return `เกินกำหนด: ${issue2.origin ?? "ค่า"} ควรมี${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "อย่างน้อย" : "มากกว่า";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `น้อยกว่ากำหนด: ${issue2.origin} ควรมี${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `น้อยกว่ากำหนด: ${issue2.origin} ควรมี${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องขึ้นต้นด้วย "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องลงท้ายด้วย "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องมี "${_issue.includes}" อยู่ในข้อความ`;
        if (_issue.format === "regex")
          return `รูปแบบไม่ถูกต้อง: ต้องตรงกับรูปแบบที่กำหนด ${_issue.pattern}`;
        return `รูปแบบไม่ถูกต้อง: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `ตัวเลขไม่ถูกต้อง: ต้องเป็นจำนวนที่หารด้วย ${issue2.divisor} ได้ลงตัว`;
      case "unrecognized_keys":
        return `พบคีย์ที่ไม่รู้จัก: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `คีย์ไม่ถูกต้องใน ${issue2.origin}`;
      case "invalid_union":
        return "ข้อมูลไม่ถูกต้อง: ไม่ตรงกับรูปแบบยูเนียนที่กำหนดไว้";
      case "invalid_element":
        return `ข้อมูลไม่ถูกต้องใน ${issue2.origin}`;
      default:
        return `ข้อมูลไม่ถูกต้อง`;
    }
  };
};
function th_default() {
  return {
    localeError: error37()
  };
}
// node_modules/zod/v4/locales/tr.js
var parsedType6 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error38 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "olmalı" },
    file: { unit: "bayt", verb: "olmalı" },
    array: { unit: "öğe", verb: "olmalı" },
    set: { unit: "öğe", verb: "olmalı" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "girdi",
    email: "e-posta adresi",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO tarih ve saat",
    date: "ISO tarih",
    time: "ISO saat",
    duration: "ISO süre",
    ipv4: "IPv4 adresi",
    ipv6: "IPv6 adresi",
    cidrv4: "IPv4 aralığı",
    cidrv6: "IPv6 aralığı",
    base64: "base64 ile şifrelenmiş metin",
    base64url: "base64url ile şifrelenmiş metin",
    json_string: "JSON dizesi",
    e164: "E.164 sayısı",
    jwt: "JWT",
    template_literal: "Şablon dizesi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Geçersiz değer: beklenen ${issue2.expected}, alınan ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Geçersiz değer: beklenen ${stringifyPrimitive(issue2.values[0])}`;
        return `Geçersiz seçenek: aşağıdakilerden biri olmalı: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çok büyük: beklenen ${issue2.origin ?? "değer"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "öğe"}`;
        return `Çok büyük: beklenen ${issue2.origin ?? "değer"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çok küçük: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `Çok küçük: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Geçersiz metin: "${_issue.prefix}" ile başlamalı`;
        if (_issue.format === "ends_with")
          return `Geçersiz metin: "${_issue.suffix}" ile bitmeli`;
        if (_issue.format === "includes")
          return `Geçersiz metin: "${_issue.includes}" içermeli`;
        if (_issue.format === "regex")
          return `Geçersiz metin: ${_issue.pattern} desenine uymalı`;
        return `Geçersiz ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Geçersiz sayı: ${issue2.divisor} ile tam bölünebilmeli`;
      case "unrecognized_keys":
        return `Tanınmayan anahtar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} içinde geçersiz anahtar`;
      case "invalid_union":
        return "Geçersiz değer";
      case "invalid_element":
        return `${issue2.origin} içinde geçersiz değer`;
      default:
        return `Geçersiz değer`;
    }
  };
};
function tr_default() {
  return {
    localeError: error38()
  };
}
// node_modules/zod/v4/locales/uk.js
var error39 = () => {
  const Sizable = {
    string: { unit: "символів", verb: "матиме" },
    file: { unit: "байтів", verb: "матиме" },
    array: { unit: "елементів", verb: "матиме" },
    set: { unit: "елементів", verb: "матиме" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "число";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "масив";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "вхідні дані",
    email: "адреса електронної пошти",
    url: "URL",
    emoji: "емодзі",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "дата та час ISO",
    date: "дата ISO",
    time: "час ISO",
    duration: "тривалість ISO",
    ipv4: "адреса IPv4",
    ipv6: "адреса IPv6",
    cidrv4: "діапазон IPv4",
    cidrv6: "діапазон IPv6",
    base64: "рядок у кодуванні base64",
    base64url: "рядок у кодуванні base64url",
    json_string: "рядок JSON",
    e164: "номер E.164",
    jwt: "JWT",
    template_literal: "вхідні дані"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Неправильні вхідні дані: очікується ${issue2.expected}, отримано ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Неправильні вхідні дані: очікується ${stringifyPrimitive(issue2.values[0])}`;
        return `Неправильна опція: очікується одне з ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Занадто велике: очікується, що ${issue2.origin ?? "значення"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "елементів"}`;
        return `Занадто велике: очікується, що ${issue2.origin ?? "значення"} буде ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Занадто мале: очікується, що ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Занадто мале: очікується, що ${issue2.origin} буде ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Неправильний рядок: повинен починатися з "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Неправильний рядок: повинен закінчуватися на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неправильний рядок: повинен містити "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неправильний рядок: повинен відповідати шаблону ${_issue.pattern}`;
        return `Неправильний ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Неправильне число: повинно бути кратним ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Нерозпізнаний ключ${issue2.keys.length > 1 ? "і" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Неправильний ключ у ${issue2.origin}`;
      case "invalid_union":
        return "Неправильні вхідні дані";
      case "invalid_element":
        return `Неправильне значення у ${issue2.origin}`;
      default:
        return `Неправильні вхідні дані`;
    }
  };
};
function uk_default() {
  return {
    localeError: error39()
  };
}

// node_modules/zod/v4/locales/ua.js
function ua_default() {
  return uk_default();
}
// node_modules/zod/v4/locales/ur.js
var error40 = () => {
  const Sizable = {
    string: { unit: "حروف", verb: "ہونا" },
    file: { unit: "بائٹس", verb: "ہونا" },
    array: { unit: "آئٹمز", verb: "ہونا" },
    set: { unit: "آئٹمز", verb: "ہونا" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "نمبر";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "آرے";
        }
        if (data === null) {
          return "نل";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ان پٹ",
    email: "ای میل ایڈریس",
    url: "یو آر ایل",
    emoji: "ایموجی",
    uuid: "یو یو آئی ڈی",
    uuidv4: "یو یو آئی ڈی وی 4",
    uuidv6: "یو یو آئی ڈی وی 6",
    nanoid: "نینو آئی ڈی",
    guid: "جی یو آئی ڈی",
    cuid: "سی یو آئی ڈی",
    cuid2: "سی یو آئی ڈی 2",
    ulid: "یو ایل آئی ڈی",
    xid: "ایکس آئی ڈی",
    ksuid: "کے ایس یو آئی ڈی",
    datetime: "آئی ایس او ڈیٹ ٹائم",
    date: "آئی ایس او تاریخ",
    time: "آئی ایس او وقت",
    duration: "آئی ایس او مدت",
    ipv4: "آئی پی وی 4 ایڈریس",
    ipv6: "آئی پی وی 6 ایڈریس",
    cidrv4: "آئی پی وی 4 رینج",
    cidrv6: "آئی پی وی 6 رینج",
    base64: "بیس 64 ان کوڈڈ سٹرنگ",
    base64url: "بیس 64 یو آر ایل ان کوڈڈ سٹرنگ",
    json_string: "جے ایس او این سٹرنگ",
    e164: "ای 164 نمبر",
    jwt: "جے ڈبلیو ٹی",
    template_literal: "ان پٹ"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `غلط ان پٹ: ${issue2.expected} متوقع تھا، ${parsedType7(issue2.input)} موصول ہوا`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `غلط ان پٹ: ${stringifyPrimitive(issue2.values[0])} متوقع تھا`;
        return `غلط آپشن: ${joinValues(issue2.values, "|")} میں سے ایک متوقع تھا`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `بہت بڑا: ${issue2.origin ?? "ویلیو"} کے ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "عناصر"} ہونے متوقع تھے`;
        return `بہت بڑا: ${issue2.origin ?? "ویلیو"} کا ${adj}${issue2.maximum.toString()} ہونا متوقع تھا`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `بہت چھوٹا: ${issue2.origin} کے ${adj}${issue2.minimum.toString()} ${sizing.unit} ہونے متوقع تھے`;
        }
        return `بہت چھوٹا: ${issue2.origin} کا ${adj}${issue2.minimum.toString()} ہونا متوقع تھا`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `غلط سٹرنگ: "${_issue.prefix}" سے شروع ہونا چاہیے`;
        }
        if (_issue.format === "ends_with")
          return `غلط سٹرنگ: "${_issue.suffix}" پر ختم ہونا چاہیے`;
        if (_issue.format === "includes")
          return `غلط سٹرنگ: "${_issue.includes}" شامل ہونا چاہیے`;
        if (_issue.format === "regex")
          return `غلط سٹرنگ: پیٹرن ${_issue.pattern} سے میچ ہونا چاہیے`;
        return `غلط ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `غلط نمبر: ${issue2.divisor} کا مضاعف ہونا چاہیے`;
      case "unrecognized_keys":
        return `غیر تسلیم شدہ کی${issue2.keys.length > 1 ? "ز" : ""}: ${joinValues(issue2.keys, "، ")}`;
      case "invalid_key":
        return `${issue2.origin} میں غلط کی`;
      case "invalid_union":
        return "غلط ان پٹ";
      case "invalid_element":
        return `${issue2.origin} میں غلط ویلیو`;
      default:
        return `غلط ان پٹ`;
    }
  };
};
function ur_default() {
  return {
    localeError: error40()
  };
}
// node_modules/zod/v4/locales/vi.js
var error41 = () => {
  const Sizable = {
    string: { unit: "ký tự", verb: "có" },
    file: { unit: "byte", verb: "có" },
    array: { unit: "phần tử", verb: "có" },
    set: { unit: "phần tử", verb: "có" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "số";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "mảng";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "đầu vào",
    email: "địa chỉ email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ngày giờ ISO",
    date: "ngày ISO",
    time: "giờ ISO",
    duration: "khoảng thời gian ISO",
    ipv4: "địa chỉ IPv4",
    ipv6: "địa chỉ IPv6",
    cidrv4: "dải IPv4",
    cidrv6: "dải IPv6",
    base64: "chuỗi mã hóa base64",
    base64url: "chuỗi mã hóa base64url",
    json_string: "chuỗi JSON",
    e164: "số E.164",
    jwt: "JWT",
    template_literal: "đầu vào"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Đầu vào không hợp lệ: mong đợi ${issue2.expected}, nhận được ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Đầu vào không hợp lệ: mong đợi ${stringifyPrimitive(issue2.values[0])}`;
        return `Tùy chọn không hợp lệ: mong đợi một trong các giá trị ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Quá lớn: mong đợi ${issue2.origin ?? "giá trị"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "phần tử"}`;
        return `Quá lớn: mong đợi ${issue2.origin ?? "giá trị"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Quá nhỏ: mong đợi ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Quá nhỏ: mong đợi ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Chuỗi không hợp lệ: phải bắt đầu bằng "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chuỗi không hợp lệ: phải kết thúc bằng "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chuỗi không hợp lệ: phải bao gồm "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chuỗi không hợp lệ: phải khớp với mẫu ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} không hợp lệ`;
      }
      case "not_multiple_of":
        return `Số không hợp lệ: phải là bội số của ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Khóa không được nhận dạng: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Khóa không hợp lệ trong ${issue2.origin}`;
      case "invalid_union":
        return "Đầu vào không hợp lệ";
      case "invalid_element":
        return `Giá trị không hợp lệ trong ${issue2.origin}`;
      default:
        return `Đầu vào không hợp lệ`;
    }
  };
};
function vi_default() {
  return {
    localeError: error41()
  };
}
// node_modules/zod/v4/locales/zh-CN.js
var error42 = () => {
  const Sizable = {
    string: { unit: "字符", verb: "包含" },
    file: { unit: "字节", verb: "包含" },
    array: { unit: "项", verb: "包含" },
    set: { unit: "项", verb: "包含" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "非数字(NaN)" : "数字";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "数组";
        }
        if (data === null) {
          return "空值(null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "输入",
    email: "电子邮件",
    url: "URL",
    emoji: "表情符号",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO日期时间",
    date: "ISO日期",
    time: "ISO时间",
    duration: "ISO时长",
    ipv4: "IPv4地址",
    ipv6: "IPv6地址",
    cidrv4: "IPv4网段",
    cidrv6: "IPv6网段",
    base64: "base64编码字符串",
    base64url: "base64url编码字符串",
    json_string: "JSON字符串",
    e164: "E.164号码",
    jwt: "JWT",
    template_literal: "输入"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `无效输入：期望 ${issue2.expected}，实际接收 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `无效输入：期望 ${stringifyPrimitive(issue2.values[0])}`;
        return `无效选项：期望以下之一 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `数值过大：期望 ${issue2.origin ?? "值"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "个元素"}`;
        return `数值过大：期望 ${issue2.origin ?? "值"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `数值过小：期望 ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `数值过小：期望 ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `无效字符串：必须以 "${_issue.prefix}" 开头`;
        if (_issue.format === "ends_with")
          return `无效字符串：必须以 "${_issue.suffix}" 结尾`;
        if (_issue.format === "includes")
          return `无效字符串：必须包含 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `无效字符串：必须满足正则表达式 ${_issue.pattern}`;
        return `无效${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `无效数字：必须是 ${issue2.divisor} 的倍数`;
      case "unrecognized_keys":
        return `出现未知的键(key): ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} 中的键(key)无效`;
      case "invalid_union":
        return "无效输入";
      case "invalid_element":
        return `${issue2.origin} 中包含无效值(value)`;
      default:
        return `无效输入`;
    }
  };
};
function zh_CN_default() {
  return {
    localeError: error42()
  };
}
// node_modules/zod/v4/locales/zh-TW.js
var error43 = () => {
  const Sizable = {
    string: { unit: "字元", verb: "擁有" },
    file: { unit: "位元組", verb: "擁有" },
    array: { unit: "項目", verb: "擁有" },
    set: { unit: "項目", verb: "擁有" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "輸入",
    email: "郵件地址",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO 日期時間",
    date: "ISO 日期",
    time: "ISO 時間",
    duration: "ISO 期間",
    ipv4: "IPv4 位址",
    ipv6: "IPv6 位址",
    cidrv4: "IPv4 範圍",
    cidrv6: "IPv6 範圍",
    base64: "base64 編碼字串",
    base64url: "base64url 編碼字串",
    json_string: "JSON 字串",
    e164: "E.164 數值",
    jwt: "JWT",
    template_literal: "輸入"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `無效的輸入值：預期為 ${issue2.expected}，但收到 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `無效的輸入值：預期為 ${stringifyPrimitive(issue2.values[0])}`;
        return `無效的選項：預期為以下其中之一 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `數值過大：預期 ${issue2.origin ?? "值"} 應為 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "個元素"}`;
        return `數值過大：預期 ${issue2.origin ?? "值"} 應為 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `數值過小：預期 ${issue2.origin} 應為 ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `數值過小：預期 ${issue2.origin} 應為 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `無效的字串：必須以 "${_issue.prefix}" 開頭`;
        }
        if (_issue.format === "ends_with")
          return `無效的字串：必須以 "${_issue.suffix}" 結尾`;
        if (_issue.format === "includes")
          return `無效的字串：必須包含 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `無效的字串：必須符合格式 ${_issue.pattern}`;
        return `無效的 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `無效的數字：必須為 ${issue2.divisor} 的倍數`;
      case "unrecognized_keys":
        return `無法識別的鍵值${issue2.keys.length > 1 ? "們" : ""}：${joinValues(issue2.keys, "、")}`;
      case "invalid_key":
        return `${issue2.origin} 中有無效的鍵值`;
      case "invalid_union":
        return "無效的輸入值";
      case "invalid_element":
        return `${issue2.origin} 中有無效的值`;
      default:
        return `無效的輸入值`;
    }
  };
};
function zh_TW_default() {
  return {
    localeError: error43()
  };
}
// node_modules/zod/v4/locales/yo.js
var error44 = () => {
  const Sizable = {
    string: { unit: "àmi", verb: "ní" },
    file: { unit: "bytes", verb: "ní" },
    array: { unit: "nkan", verb: "ní" },
    set: { unit: "nkan", verb: "ní" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nọ́mbà";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "akopọ";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ẹ̀rọ ìbáwọlé",
    email: "àdírẹ́sì ìmẹ́lì",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "àkókò ISO",
    date: "ọjọ́ ISO",
    time: "àkókò ISO",
    duration: "àkókò tó pé ISO",
    ipv4: "àdírẹ́sì IPv4",
    ipv6: "àdírẹ́sì IPv6",
    cidrv4: "àgbègbè IPv4",
    cidrv6: "àgbègbè IPv6",
    base64: "ọ̀rọ̀ tí a kọ́ ní base64",
    base64url: "ọ̀rọ̀ base64url",
    json_string: "ọ̀rọ̀ JSON",
    e164: "nọ́mbà E.164",
    jwt: "JWT",
    template_literal: "ẹ̀rọ ìbáwọlé"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ìbáwọlé aṣìṣe: a ní láti fi ${issue2.expected}, àmọ̀ a rí ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ìbáwọlé aṣìṣe: a ní láti fi ${stringifyPrimitive(issue2.values[0])}`;
        return `Àṣàyàn aṣìṣe: yan ọ̀kan lára ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Tó pọ̀ jù: a ní láti jẹ́ pé ${issue2.origin ?? "iye"} ${sizing.verb} ${adj}${issue2.maximum} ${sizing.unit}`;
        return `Tó pọ̀ jù: a ní láti jẹ́ ${adj}${issue2.maximum}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Kéré ju: a ní láti jẹ́ pé ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum} ${sizing.unit}`;
        return `Kéré ju: a ní láti jẹ́ ${adj}${issue2.minimum}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bẹ̀rẹ̀ pẹ̀lú "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ parí pẹ̀lú "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ ní "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bá àpẹẹrẹ mu ${_issue.pattern}`;
        return `Aṣìṣe: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nọ́mbà aṣìṣe: gbọ́dọ̀ jẹ́ èyà pípín ti ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Bọtìnì àìmọ̀: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Bọtìnì aṣìṣe nínú ${issue2.origin}`;
      case "invalid_union":
        return "Ìbáwọlé aṣìṣe";
      case "invalid_element":
        return `Iye aṣìṣe nínú ${issue2.origin}`;
      default:
        return "Ìbáwọlé aṣìṣe";
    }
  };
};
function yo_default() {
  return {
    localeError: error44()
  };
}
// node_modules/zod/v4/core/registries.js
var $output = Symbol("ZodOutput");
var $input = Symbol("ZodInput");

class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      if (this._idmap.has(meta.id)) {
        throw new Error(`ID ${meta.id} already exists in the registry`);
      }
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
var globalRegistry = /* @__PURE__ */ registry();
// node_modules/zod/v4/core/api.js
function _string(Class2, params) {
  return new Class2({
    type: "string",
    ...normalizeParams(params)
  });
}
function _coercedString(Class2, params) {
  return new Class2({
    type: "string",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
var TimePrecision = {
  Any: null,
  Minute: -1,
  Second: 0,
  Millisecond: 3,
  Microsecond: 6
};
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class2, params) {
  return new Class2({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
function _coercedNumber(Class2, params) {
  return new Class2({
    type: "number",
    coerce: true,
    checks: [],
    ...normalizeParams(params)
  });
}
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _float32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float32",
    ...normalizeParams(params)
  });
}
function _float64(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float64",
    ...normalizeParams(params)
  });
}
function _int32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "int32",
    ...normalizeParams(params)
  });
}
function _uint32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "uint32",
    ...normalizeParams(params)
  });
}
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _coercedBoolean(Class2, params) {
  return new Class2({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _bigint(Class2, params) {
  return new Class2({
    type: "bigint",
    ...normalizeParams(params)
  });
}
function _coercedBigint(Class2, params) {
  return new Class2({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _int64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "int64",
    ...normalizeParams(params)
  });
}
function _uint64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "uint64",
    ...normalizeParams(params)
  });
}
function _symbol(Class2, params) {
  return new Class2({
    type: "symbol",
    ...normalizeParams(params)
  });
}
function _undefined2(Class2, params) {
  return new Class2({
    type: "undefined",
    ...normalizeParams(params)
  });
}
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
function _any(Class2) {
  return new Class2({
    type: "any"
  });
}
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
function _void(Class2, params) {
  return new Class2({
    type: "void",
    ...normalizeParams(params)
  });
}
function _date(Class2, params) {
  return new Class2({
    type: "date",
    ...normalizeParams(params)
  });
}
function _coercedDate(Class2, params) {
  return new Class2({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _nan(Class2, params) {
  return new Class2({
    type: "nan",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _positive(params) {
  return _gt(0, params);
}
function _negative(params) {
  return _lt(0, params);
}
function _nonpositive(params) {
  return _lte(0, params);
}
function _nonnegative(params) {
  return _gte(0, params);
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxSize(maximum, params) {
  return new $ZodCheckMaxSize({
    check: "max_size",
    ...normalizeParams(params),
    maximum
  });
}
function _minSize(minimum, params) {
  return new $ZodCheckMinSize({
    check: "min_size",
    ...normalizeParams(params),
    minimum
  });
}
function _size(size, params) {
  return new $ZodCheckSizeEquals({
    check: "size_equals",
    ...normalizeParams(params),
    size
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _property(property, schema, params) {
  return new $ZodCheckProperty({
    check: "property",
    property,
    schema,
    ...normalizeParams(params)
  });
}
function _mime(types, params) {
  return new $ZodCheckMimeType({
    check: "mime_type",
    mime: types,
    ...normalizeParams(params)
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _union(Class2, options, params) {
  return new Class2({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
function _discriminatedUnion(Class2, discriminator, options, params) {
  return new Class2({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
function _intersection(Class2, left, right) {
  return new Class2({
    type: "intersection",
    left,
    right
  });
}
function _tuple(Class2, items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new Class2({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
function _record(Class2, keyType, valueType, params) {
  return new Class2({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _map(Class2, keyType, valueType, params) {
  return new Class2({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _set(Class2, valueType, params) {
  return new Class2({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
function _enum(Class2, values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _nativeEnum(Class2, entries, params) {
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _literal(Class2, value, params) {
  return new Class2({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
function _file(Class2, params) {
  return new Class2({
    type: "file",
    ...normalizeParams(params)
  });
}
function _transform(Class2, fn) {
  return new Class2({
    type: "transform",
    transform: fn
  });
}
function _optional(Class2, innerType) {
  return new Class2({
    type: "optional",
    innerType
  });
}
function _nullable(Class2, innerType) {
  return new Class2({
    type: "nullable",
    innerType
  });
}
function _default(Class2, innerType, defaultValue) {
  return new Class2({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
function _nonoptional(Class2, innerType, params) {
  return new Class2({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
function _success(Class2, innerType) {
  return new Class2({
    type: "success",
    innerType
  });
}
function _catch(Class2, innerType, catchValue) {
  return new Class2({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
function _pipe(Class2, in_, out) {
  return new Class2({
    type: "pipe",
    in: in_,
    out
  });
}
function _readonly(Class2, innerType) {
  return new Class2({
    type: "readonly",
    innerType
  });
}
function _templateLiteral(Class2, parts, params) {
  return new Class2({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
function _lazy(Class2, getter) {
  return new Class2({
    type: "lazy",
    getter
  });
}
function _promise(Class2, innerType) {
  return new Class2({
    type: "promise",
    innerType
  });
}
function _custom(Class2, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
function _stringbool(Classes, _params) {
  const params = normalizeParams(_params);
  let truthyArray = params.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  let falsyArray = params.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (params.case !== "sensitive") {
    truthyArray = truthyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
    falsyArray = falsyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
  }
  const truthySet = new Set(truthyArray);
  const falsySet = new Set(falsyArray);
  const _Codec = Classes.Codec ?? $ZodCodec;
  const _Boolean = Classes.Boolean ?? $ZodBoolean;
  const _String = Classes.String ?? $ZodString;
  const stringSchema = new _String({ type: "string", error: params.error });
  const booleanSchema = new _Boolean({ type: "boolean", error: params.error });
  const codec = new _Codec({
    type: "pipe",
    in: stringSchema,
    out: booleanSchema,
    transform: (input, payload) => {
      let data = input;
      if (params.case !== "sensitive")
        data = data.toLowerCase();
      if (truthySet.has(data)) {
        return true;
      } else if (falsySet.has(data)) {
        return false;
      } else {
        payload.issues.push({
          code: "invalid_value",
          expected: "stringbool",
          values: [...truthySet, ...falsySet],
          input: payload.value,
          inst: codec,
          continue: false
        });
        return {};
      }
    },
    reverseTransform: (input, _payload) => {
      if (input === true) {
        return truthyArray[0] || "true";
      } else {
        return falsyArray[0] || "false";
      }
    },
    error: params.error
  });
  return codec;
}
function _stringFormat(Class2, format, fnOrRegex, _params = {}) {
  const params = normalizeParams(_params);
  const def = {
    ...normalizeParams(_params),
    check: "string_format",
    type: "string",
    format,
    fn: typeof fnOrRegex === "function" ? fnOrRegex : (val) => fnOrRegex.test(val),
    ...params
  };
  if (fnOrRegex instanceof RegExp) {
    def.pattern = fnOrRegex;
  }
  const inst = new Class2(def);
  return inst;
}
// node_modules/zod/v4/core/to-json-schema.js
class JSONSchemaGenerator {
  constructor(params) {
    this.counter = 0;
    this.metadataRegistry = params?.metadata ?? globalRegistry;
    this.target = params?.target ?? "draft-2020-12";
    this.unrepresentable = params?.unrepresentable ?? "throw";
    this.override = params?.override ?? (() => {});
    this.io = params?.io ?? "output";
    this.seen = new Map;
  }
  process(schema, _params = { path: [], schemaPath: [] }) {
    var _a;
    const def = schema._zod.def;
    const formatMap = {
      guid: "uuid",
      url: "uri",
      datetime: "date-time",
      json_string: "json-string",
      regex: ""
    };
    const seen = this.seen.get(schema);
    if (seen) {
      seen.count++;
      const isCycle = _params.schemaPath.includes(schema);
      if (isCycle) {
        seen.cycle = _params.path;
      }
      return seen.schema;
    }
    const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
    this.seen.set(schema, result);
    const overrideSchema = schema._zod.toJSONSchema?.();
    if (overrideSchema) {
      result.schema = overrideSchema;
    } else {
      const params = {
        ..._params,
        schemaPath: [..._params.schemaPath, schema],
        path: _params.path
      };
      const parent = schema._zod.parent;
      if (parent) {
        result.ref = parent;
        this.process(parent, params);
        this.seen.get(parent).isParent = true;
      } else {
        const _json = result.schema;
        switch (def.type) {
          case "string": {
            const json = _json;
            json.type = "string";
            const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minLength = minimum;
            if (typeof maximum === "number")
              json.maxLength = maximum;
            if (format) {
              json.format = formatMap[format] ?? format;
              if (json.format === "")
                delete json.format;
            }
            if (contentEncoding)
              json.contentEncoding = contentEncoding;
            if (patterns && patterns.size > 0) {
              const regexes = [...patterns];
              if (regexes.length === 1)
                json.pattern = regexes[0].source;
              else if (regexes.length > 1) {
                result.schema.allOf = [
                  ...regexes.map((regex) => ({
                    ...this.target === "draft-7" || this.target === "draft-4" || this.target === "openapi-3.0" ? { type: "string" } : {},
                    pattern: regex.source
                  }))
                ];
              }
            }
            break;
          }
          case "number": {
            const json = _json;
            const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
            if (typeof format === "string" && format.includes("int"))
              json.type = "integer";
            else
              json.type = "number";
            if (typeof exclusiveMinimum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.minimum = exclusiveMinimum;
                json.exclusiveMinimum = true;
              } else {
                json.exclusiveMinimum = exclusiveMinimum;
              }
            }
            if (typeof minimum === "number") {
              json.minimum = minimum;
              if (typeof exclusiveMinimum === "number" && this.target !== "draft-4") {
                if (exclusiveMinimum >= minimum)
                  delete json.minimum;
                else
                  delete json.exclusiveMinimum;
              }
            }
            if (typeof exclusiveMaximum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.maximum = exclusiveMaximum;
                json.exclusiveMaximum = true;
              } else {
                json.exclusiveMaximum = exclusiveMaximum;
              }
            }
            if (typeof maximum === "number") {
              json.maximum = maximum;
              if (typeof exclusiveMaximum === "number" && this.target !== "draft-4") {
                if (exclusiveMaximum <= maximum)
                  delete json.maximum;
                else
                  delete json.exclusiveMaximum;
              }
            }
            if (typeof multipleOf === "number")
              json.multipleOf = multipleOf;
            break;
          }
          case "boolean": {
            const json = _json;
            json.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") {
              throw new Error("BigInt cannot be represented in JSON Schema");
            }
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") {
              throw new Error("Symbols cannot be represented in JSON Schema");
            }
            break;
          }
          case "null": {
            if (this.target === "openapi-3.0") {
              _json.type = "string";
              _json.nullable = true;
              _json.enum = [null];
            } else
              _json.type = "null";
            break;
          }
          case "any": {
            break;
          }
          case "unknown": {
            break;
          }
          case "undefined": {
            if (this.unrepresentable === "throw") {
              throw new Error("Undefined cannot be represented in JSON Schema");
            }
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") {
              throw new Error("Void cannot be represented in JSON Schema");
            }
            break;
          }
          case "never": {
            _json.not = {};
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") {
              throw new Error("Date cannot be represented in JSON Schema");
            }
            break;
          }
          case "array": {
            const json = _json;
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minItems = minimum;
            if (typeof maximum === "number")
              json.maxItems = maximum;
            json.type = "array";
            json.items = this.process(def.element, { ...params, path: [...params.path, "items"] });
            break;
          }
          case "object": {
            const json = _json;
            json.type = "object";
            json.properties = {};
            const shape = def.shape;
            for (const key in shape) {
              json.properties[key] = this.process(shape[key], {
                ...params,
                path: [...params.path, "properties", key]
              });
            }
            const allKeys = new Set(Object.keys(shape));
            const requiredKeys = new Set([...allKeys].filter((key) => {
              const v = def.shape[key]._zod;
              if (this.io === "input") {
                return v.optin === undefined;
              } else {
                return v.optout === undefined;
              }
            }));
            if (requiredKeys.size > 0) {
              json.required = Array.from(requiredKeys);
            }
            if (def.catchall?._zod.def.type === "never") {
              json.additionalProperties = false;
            } else if (!def.catchall) {
              if (this.io === "output")
                json.additionalProperties = false;
            } else if (def.catchall) {
              json.additionalProperties = this.process(def.catchall, {
                ...params,
                path: [...params.path, "additionalProperties"]
              });
            }
            break;
          }
          case "union": {
            const json = _json;
            const options = def.options.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, "anyOf", i]
            }));
            json.anyOf = options;
            break;
          }
          case "intersection": {
            const json = _json;
            const a = this.process(def.left, {
              ...params,
              path: [...params.path, "allOf", 0]
            });
            const b = this.process(def.right, {
              ...params,
              path: [...params.path, "allOf", 1]
            });
            const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
            const allOf = [
              ...isSimpleIntersection(a) ? a.allOf : [a],
              ...isSimpleIntersection(b) ? b.allOf : [b]
            ];
            json.allOf = allOf;
            break;
          }
          case "tuple": {
            const json = _json;
            json.type = "array";
            const prefixPath = this.target === "draft-2020-12" ? "prefixItems" : "items";
            const restPath = this.target === "draft-2020-12" ? "items" : this.target === "openapi-3.0" ? "items" : "additionalItems";
            const prefixItems = def.items.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, prefixPath, i]
            }));
            const rest = def.rest ? this.process(def.rest, {
              ...params,
              path: [...params.path, restPath, ...this.target === "openapi-3.0" ? [def.items.length] : []]
            }) : null;
            if (this.target === "draft-2020-12") {
              json.prefixItems = prefixItems;
              if (rest) {
                json.items = rest;
              }
            } else if (this.target === "openapi-3.0") {
              json.items = {
                anyOf: prefixItems
              };
              if (rest) {
                json.items.anyOf.push(rest);
              }
              json.minItems = prefixItems.length;
              if (!rest) {
                json.maxItems = prefixItems.length;
              }
            } else {
              json.items = prefixItems;
              if (rest) {
                json.additionalItems = rest;
              }
            }
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minItems = minimum;
            if (typeof maximum === "number")
              json.maxItems = maximum;
            break;
          }
          case "record": {
            const json = _json;
            json.type = "object";
            if (this.target === "draft-7" || this.target === "draft-2020-12") {
              json.propertyNames = this.process(def.keyType, {
                ...params,
                path: [...params.path, "propertyNames"]
              });
            }
            json.additionalProperties = this.process(def.valueType, {
              ...params,
              path: [...params.path, "additionalProperties"]
            });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") {
              throw new Error("Map cannot be represented in JSON Schema");
            }
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") {
              throw new Error("Set cannot be represented in JSON Schema");
            }
            break;
          }
          case "enum": {
            const json = _json;
            const values = getEnumValues(def.entries);
            if (values.every((v) => typeof v === "number"))
              json.type = "number";
            if (values.every((v) => typeof v === "string"))
              json.type = "string";
            json.enum = values;
            break;
          }
          case "literal": {
            const json = _json;
            const vals = [];
            for (const val of def.values) {
              if (val === undefined) {
                if (this.unrepresentable === "throw") {
                  throw new Error("Literal `undefined` cannot be represented in JSON Schema");
                }
              } else if (typeof val === "bigint") {
                if (this.unrepresentable === "throw") {
                  throw new Error("BigInt literals cannot be represented in JSON Schema");
                } else {
                  vals.push(Number(val));
                }
              } else {
                vals.push(val);
              }
            }
            if (vals.length === 0) {} else if (vals.length === 1) {
              const val = vals[0];
              json.type = val === null ? "null" : typeof val;
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.enum = [val];
              } else {
                json.const = val;
              }
            } else {
              if (vals.every((v) => typeof v === "number"))
                json.type = "number";
              if (vals.every((v) => typeof v === "string"))
                json.type = "string";
              if (vals.every((v) => typeof v === "boolean"))
                json.type = "string";
              if (vals.every((v) => v === null))
                json.type = "null";
              json.enum = vals;
            }
            break;
          }
          case "file": {
            const json = _json;
            const file = {
              type: "string",
              format: "binary",
              contentEncoding: "binary"
            };
            const { minimum, maximum, mime } = schema._zod.bag;
            if (minimum !== undefined)
              file.minLength = minimum;
            if (maximum !== undefined)
              file.maxLength = maximum;
            if (mime) {
              if (mime.length === 1) {
                file.contentMediaType = mime[0];
                Object.assign(json, file);
              } else {
                json.anyOf = mime.map((m) => {
                  const mFile = { ...file, contentMediaType: m };
                  return mFile;
                });
              }
            } else {
              Object.assign(json, file);
            }
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") {
              throw new Error("Transforms cannot be represented in JSON Schema");
            }
            break;
          }
          case "nullable": {
            const inner = this.process(def.innerType, params);
            if (this.target === "openapi-3.0") {
              result.ref = def.innerType;
              _json.nullable = true;
            } else {
              _json.anyOf = [inner, { type: "null" }];
            }
            break;
          }
          case "nonoptional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "success": {
            const json = _json;
            json.type = "boolean";
            break;
          }
          case "default": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.default = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "prefault": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            if (this.io === "input")
              _json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "catch": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            let catchValue;
            try {
              catchValue = def.catchValue(undefined);
            } catch {
              throw new Error("Dynamic catch values are not supported in JSON Schema");
            }
            _json.default = catchValue;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") {
              throw new Error("NaN cannot be represented in JSON Schema");
            }
            break;
          }
          case "template_literal": {
            const json = _json;
            const pattern = schema._zod.pattern;
            if (!pattern)
              throw new Error("Pattern not found in template literal");
            json.type = "string";
            json.pattern = pattern.source;
            break;
          }
          case "pipe": {
            const innerType = this.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "readonly": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.readOnly = true;
            break;
          }
          case "promise": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "optional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "lazy": {
            const innerType = schema._zod.innerType;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") {
              throw new Error("Custom types cannot be represented in JSON Schema");
            }
            break;
          }
          case "function": {
            if (this.unrepresentable === "throw") {
              throw new Error("Function types cannot be represented in JSON Schema");
            }
            break;
          }
          default: {}
        }
      }
    }
    const meta = this.metadataRegistry.get(schema);
    if (meta)
      Object.assign(result.schema, meta);
    if (this.io === "input" && isTransforming(schema)) {
      delete result.schema.examples;
      delete result.schema.default;
    }
    if (this.io === "input" && result.schema._prefault)
      (_a = result.schema).default ?? (_a.default = result.schema._prefault);
    delete result.schema._prefault;
    const _result = this.seen.get(schema);
    return _result.schema;
  }
  emit(schema, _params) {
    const params = {
      cycles: _params?.cycles ?? "ref",
      reused: _params?.reused ?? "inline",
      external: _params?.external ?? undefined
    };
    const root = this.seen.get(schema);
    if (!root)
      throw new Error("Unprocessed schema. This is a bug in Zod.");
    const makeURI = (entry) => {
      const defsSegment = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (params.external) {
        const externalId = params.external.registry.get(entry[0])?.id;
        const uriGenerator = params.external.uri ?? ((id2) => id2);
        if (externalId) {
          return { ref: uriGenerator(externalId) };
        }
        const id = entry[1].defId ?? entry[1].schema.id ?? `schema${this.counter++}`;
        entry[1].defId = id;
        return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
      }
      if (entry[1] === root) {
        return { ref: "#" };
      }
      const uriPrefix = `#`;
      const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
      const defId = entry[1].schema.id ?? `__schema${this.counter++}`;
      return { defId, ref: defUriPrefix + defId };
    };
    const extractToDef = (entry) => {
      if (entry[1].schema.$ref) {
        return;
      }
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);
      seen.def = { ...seen.schema };
      if (defId)
        seen.defId = defId;
      const schema2 = seen.schema;
      for (const key in schema2) {
        delete schema2[key];
      }
      schema2.$ref = ref;
    };
    if (params.cycles === "throw") {
      for (const entry of this.seen.entries()) {
        const seen = entry[1];
        if (seen.cycle) {
          throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
        }
      }
    }
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (schema === entry[0]) {
        extractToDef(entry);
        continue;
      }
      if (params.external) {
        const ext = params.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }
      const id = this.metadataRegistry.get(entry[0])?.id;
      if (id) {
        extractToDef(entry);
        continue;
      }
      if (seen.cycle) {
        extractToDef(entry);
        continue;
      }
      if (seen.count > 1) {
        if (params.reused === "ref") {
          extractToDef(entry);
          continue;
        }
      }
    }
    const flattenRef = (zodSchema, params2) => {
      const seen = this.seen.get(zodSchema);
      const schema2 = seen.def ?? seen.schema;
      const _cached = { ...schema2 };
      if (seen.ref === null) {
        return;
      }
      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref, params2);
        const refSchema = this.seen.get(ref).schema;
        if (refSchema.$ref && (params2.target === "draft-7" || params2.target === "draft-4" || params2.target === "openapi-3.0")) {
          schema2.allOf = schema2.allOf ?? [];
          schema2.allOf.push(refSchema);
        } else {
          Object.assign(schema2, refSchema);
          Object.assign(schema2, _cached);
        }
      }
      if (!seen.isParent)
        this.override({
          zodSchema,
          jsonSchema: schema2,
          path: seen.path ?? []
        });
    };
    for (const entry of [...this.seen.entries()].reverse()) {
      flattenRef(entry[0], { target: this.target });
    }
    const result = {};
    if (this.target === "draft-2020-12") {
      result.$schema = "https://json-schema.org/draft/2020-12/schema";
    } else if (this.target === "draft-7") {
      result.$schema = "http://json-schema.org/draft-07/schema#";
    } else if (this.target === "draft-4") {
      result.$schema = "http://json-schema.org/draft-04/schema#";
    } else if (this.target === "openapi-3.0") {} else {
      console.warn(`Invalid target: ${this.target}`);
    }
    if (params.external?.uri) {
      const id = params.external.registry.get(schema)?.id;
      if (!id)
        throw new Error("Schema is missing an `id` property");
      result.$id = params.external.uri(id);
    }
    Object.assign(result, root.def);
    const defs = params.external?.defs ?? {};
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        defs[seen.defId] = seen.def;
      }
    }
    if (params.external) {} else {
      if (Object.keys(defs).length > 0) {
        if (this.target === "draft-2020-12") {
          result.$defs = defs;
        } else {
          result.definitions = defs;
        }
      }
    }
    try {
      return JSON.parse(JSON.stringify(result));
    } catch (_err) {
      throw new Error("Error converting schema to JSON.");
    }
  }
}
function toJSONSchema(input, _params) {
  if (input instanceof $ZodRegistry) {
    const gen2 = new JSONSchemaGenerator(_params);
    const defs = {};
    for (const entry of input._idmap.entries()) {
      const [_, schema] = entry;
      gen2.process(schema);
    }
    const schemas = {};
    const external = {
      registry: input,
      uri: _params?.uri,
      defs
    };
    for (const entry of input._idmap.entries()) {
      const [key, schema] = entry;
      schemas[key] = gen2.emit(schema, {
        ..._params,
        external
      });
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = gen2.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const gen = new JSONSchemaGenerator(_params);
  gen.process(input);
  return gen.emit(input, _params);
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const schema = _schema;
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array": {
      return isTransforming(def.element, ctx);
    }
    case "object": {
      for (const key in def.shape) {
        if (isTransforming(def.shape[key], ctx))
          return true;
      }
      return false;
    }
    case "union": {
      for (const option of def.options) {
        if (isTransforming(option, ctx))
          return true;
      }
      return false;
    }
    case "intersection": {
      return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
    }
    case "tuple": {
      for (const item of def.items) {
        if (isTransforming(item, ctx))
          return true;
      }
      if (def.rest && isTransforming(def.rest, ctx))
        return true;
      return false;
    }
    case "record": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "map": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "set": {
      return isTransforming(def.valueType, ctx);
    }
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return isTransforming(def.innerType, ctx);
    case "lazy":
      return isTransforming(def.getter(), ctx);
    case "default": {
      return isTransforming(def.innerType, ctx);
    }
    case "prefault": {
      return isTransforming(def.innerType, ctx);
    }
    case "custom": {
      return false;
    }
    case "transform": {
      return true;
    }
    case "pipe": {
      return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
    }
    case "success": {
      return false;
    }
    case "catch": {
      return false;
    }
    case "function": {
      return false;
    }
    default:
  }
  throw new Error(`Unknown schema type: ${def.type}`);
}
// node_modules/zod/v4/core/json-schema.js
var exports_json_schema = {};
// node_modules/zod/v4/classic/iso.js
var exports_iso = {};
__export(exports_iso, {
  time: () => time2,
  duration: () => duration2,
  datetime: () => datetime2,
  date: () => date2,
  ZodISOTime: () => ZodISOTime,
  ZodISODuration: () => ZodISODuration,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODate: () => ZodISODate
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
    },
    addIssue: {
      value: (issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    addIssues: {
      value: (issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
    }
  });
};
var ZodError = $constructor("ZodError", initializer2);
var ZodRealError = $constructor("ZodError", initializer2, {
  Parent: Error
});

// node_modules/zod/v4/classic/parse.js
var parse4 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/zod/v4/classic/schemas.js
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.check = (...checks2) => {
    return inst.clone({
      ...def,
      checks: [
        ...def.checks ?? [],
        ...checks2.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    });
  };
  inst.clone = (def2, params) => clone(inst, def2, params);
  inst.brand = () => inst;
  inst.register = (reg, meta) => {
    reg.add(inst, meta);
    return inst;
  };
  inst.parse = (data, params) => parse4(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  inst.refine = (check, params) => inst.check(refine(check, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(_overwrite(fn));
  inst.optional = () => optional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([inst, arg]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def2) => _default2(inst, def2);
  inst.prefault = (def2) => prefault(inst, def2);
  inst.catch = (params) => _catch2(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, { description });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(undefined).success;
  inst.isNullable = () => inst.safeParse(null).success;
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(_regex(...args));
  inst.includes = (...args) => inst.check(_includes(...args));
  inst.startsWith = (...args) => inst.check(_startsWith(...args));
  inst.endsWith = (...args) => inst.check(_endsWith(...args));
  inst.min = (...args) => inst.check(_minLength(...args));
  inst.max = (...args) => inst.check(_maxLength(...args));
  inst.length = (...args) => inst.check(_length(...args));
  inst.nonempty = (...args) => inst.check(_minLength(1, ...args));
  inst.lowercase = (params) => inst.check(_lowercase(params));
  inst.uppercase = (params) => inst.check(_uppercase(params));
  inst.trim = () => inst.check(_trim());
  inst.normalize = (...args) => inst.check(_normalize(...args));
  inst.toLowerCase = () => inst.check(_toLowerCase());
  inst.toUpperCase = () => inst.check(_toUpperCase());
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function guid2(params) {
  return _guid(ZodGUID, params);
}
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function uuid2(params) {
  return _uuid(ZodUUID, params);
}
function uuidv4(params) {
  return _uuidv4(ZodUUID, params);
}
function uuidv6(params) {
  return _uuidv6(ZodUUID, params);
}
function uuidv7(params) {
  return _uuidv7(ZodUUID, params);
}
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
function httpUrl(params) {
  return _url(ZodURL, {
    protocol: /^https?$/,
    hostname: exports_regexes.domain,
    ...exports_util.normalizeParams(params)
  });
}
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function emoji2(params) {
  return _emoji2(ZodEmoji, params);
}
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function nanoid2(params) {
  return _nanoid(ZodNanoID, params);
}
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid3(params) {
  return _cuid(ZodCUID, params);
}
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid22(params) {
  return _cuid2(ZodCUID2, params);
}
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ulid2(params) {
  return _ulid(ZodULID, params);
}
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function xid2(params) {
  return _xid(ZodXID, params);
}
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ksuid2(params) {
  return _ksuid(ZodKSUID, params);
}
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv42(params) {
  return _ipv4(ZodIPv4, params);
}
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv62(params) {
  return _ipv6(ZodIPv6, params);
}
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv42(params) {
  return _cidrv4(ZodCIDRv4, params);
}
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv62(params) {
  return _cidrv6(ZodCIDRv6, params);
}
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base642(params) {
  return _base64(ZodBase64, params);
}
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base64url2(params) {
  return _base64url(ZodBase64URL, params);
}
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function e1642(params) {
  return _e164(ZodE164, params);
}
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function jwt(params) {
  return _jwt(ZodJWT, params);
}
var ZodCustomStringFormat = /* @__PURE__ */ $constructor("ZodCustomStringFormat", (inst, def) => {
  $ZodCustomStringFormat.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function stringFormat(format, fnOrRegex, _params = {}) {
  return _stringFormat(ZodCustomStringFormat, format, fnOrRegex, _params);
}
function hostname2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hostname", exports_regexes.hostname, _params);
}
function hex2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hex", exports_regexes.hex, _params);
}
function hash(alg, params) {
  const enc = params?.enc ?? "hex";
  const format = `${alg}_${enc}`;
  const regex = exports_regexes[format];
  if (!regex)
    throw new Error(`Unrecognized hash format: ${format}`);
  return _stringFormat(ZodCustomStringFormat, format, regex, params);
}
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(_gt(0, params));
  inst.nonnegative = (params) => inst.check(_gte(0, params));
  inst.negative = (params) => inst.check(_lt(0, params));
  inst.nonpositive = (params) => inst.check(_lte(0, params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  inst.step = (value, params) => inst.check(_multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
function float32(params) {
  return _float32(ZodNumberFormat, params);
}
function float64(params) {
  return _float64(ZodNumberFormat, params);
}
function int32(params) {
  return _int32(ZodNumberFormat, params);
}
function uint32(params) {
  return _uint32(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodBigInt = /* @__PURE__ */ $constructor("ZodBigInt", (inst, def) => {
  $ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.positive = (params) => inst.check(_gt(BigInt(0), params));
  inst.negative = (params) => inst.check(_lt(BigInt(0), params));
  inst.nonpositive = (params) => inst.check(_lte(BigInt(0), params));
  inst.nonnegative = (params) => inst.check(_gte(BigInt(0), params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  const bag = inst._zod.bag;
  inst.minValue = bag.minimum ?? null;
  inst.maxValue = bag.maximum ?? null;
  inst.format = bag.format ?? null;
});
function bigint2(params) {
  return _bigint(ZodBigInt, params);
}
var ZodBigIntFormat = /* @__PURE__ */ $constructor("ZodBigIntFormat", (inst, def) => {
  $ZodBigIntFormat.init(inst, def);
  ZodBigInt.init(inst, def);
});
function int64(params) {
  return _int64(ZodBigIntFormat, params);
}
function uint64(params) {
  return _uint64(ZodBigIntFormat, params);
}
var ZodSymbol = /* @__PURE__ */ $constructor("ZodSymbol", (inst, def) => {
  $ZodSymbol.init(inst, def);
  ZodType.init(inst, def);
});
function symbol(params) {
  return _symbol(ZodSymbol, params);
}
var ZodUndefined = /* @__PURE__ */ $constructor("ZodUndefined", (inst, def) => {
  $ZodUndefined.init(inst, def);
  ZodType.init(inst, def);
});
function _undefined3(params) {
  return _undefined2(ZodUndefined, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
});
function any() {
  return _any(ZodAny);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodVoid = /* @__PURE__ */ $constructor("ZodVoid", (inst, def) => {
  $ZodVoid.init(inst, def);
  ZodType.init(inst, def);
});
function _void2(params) {
  return _void(ZodVoid, params);
}
var ZodDate = /* @__PURE__ */ $constructor("ZodDate", (inst, def) => {
  $ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  const c = inst._zod.bag;
  inst.minDate = c.minimum ? new Date(c.minimum) : null;
  inst.maxDate = c.maximum ? new Date(c.maximum) : null;
});
function date3(params) {
  return _date(ZodDate, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
  inst.nonempty = (params) => inst.check(_minLength(1, params));
  inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(_length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
function keyof(schema) {
  const shape = schema._zod.def.shape;
  return _enum2(Object.keys(shape));
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  exports_util.defineLazy(inst, "shape", () => def.shape);
  inst.keyof = () => _enum2(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({ ...inst._zod.def, catchall });
  inst.passthrough = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.loose = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.strict = () => inst.clone({ ...inst._zod.def, catchall: never() });
  inst.strip = () => inst.clone({ ...inst._zod.def, catchall: undefined });
  inst.extend = (incoming) => {
    return exports_util.extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return exports_util.safeExtend(inst, incoming);
  };
  inst.merge = (other) => exports_util.merge(inst, other);
  inst.pick = (mask) => exports_util.pick(inst, mask);
  inst.omit = (mask) => exports_util.omit(inst, mask);
  inst.partial = (...args) => exports_util.partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => exports_util.required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    get shape() {
      exports_util.assignProp(this, "shape", shape ? exports_util.objectClone(shape) : {});
      return this.shape;
    },
    ...exports_util.normalizeParams(params)
  };
  return new ZodObject(def);
}
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      exports_util.assignProp(this, "shape", exports_util.objectClone(shape));
      return this.shape;
    },
    catchall: never(),
    ...exports_util.normalizeParams(params)
  });
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      exports_util.assignProp(this, "shape", exports_util.objectClone(shape));
      return this.shape;
    },
    catchall: unknown(),
    ...exports_util.normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...exports_util.normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...exports_util.normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodTuple = /* @__PURE__ */ $constructor("ZodTuple", (inst, def) => {
  $ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst.rest = (rest) => inst.clone({
    ...inst._zod.def,
    rest
  });
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...exports_util.normalizeParams(params)
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record3(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
function partialRecord(keyType, valueType, params) {
  const k = clone(keyType);
  k._zod.values = undefined;
  return new ZodRecord({
    type: "record",
    keyType: k,
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodMap = /* @__PURE__ */ $constructor("ZodMap", (inst, def) => {
  $ZodMap.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function map(keyType, valueType, params) {
  return new ZodMap({
    type: "map",
    keyType,
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodSet = /* @__PURE__ */ $constructor("ZodSet", (inst, def) => {
  $ZodSet.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function set(valueType, params) {
  return new ZodSet({
    type: "set",
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...exports_util.normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...exports_util.normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum2(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...exports_util.normalizeParams(params)
  });
}
function nativeEnum(entries, params) {
  return new ZodEnum({
    type: "enum",
    entries,
    ...exports_util.normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...exports_util.normalizeParams(params)
  });
}
var ZodFile = /* @__PURE__ */ $constructor("ZodFile", (inst, def) => {
  $ZodFile.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (size, params) => inst.check(_minSize(size, params));
  inst.max = (size, params) => inst.check(_maxSize(size, params));
  inst.mime = (types, params) => inst.check(_mime(Array.isArray(types) ? types : [types], params));
});
function file(params) {
  return _file(ZodFile, params);
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(exports_util.issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(exports_util.issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
function nullish2(innerType) {
  return optional(nullable(innerType));
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default2(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : exports_util.shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : exports_util.shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodSuccess = /* @__PURE__ */ $constructor("ZodSuccess", (inst, def) => {
  $ZodSuccess.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function success(innerType) {
  return new ZodSuccess({
    type: "success",
    innerType
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch2(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodNaN = /* @__PURE__ */ $constructor("ZodNaN", (inst, def) => {
  $ZodNaN.init(inst, def);
  ZodType.init(inst, def);
});
function nan(params) {
  return _nan(ZodNaN, params);
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodCodec = /* @__PURE__ */ $constructor("ZodCodec", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodCodec.init(inst, def);
});
function codec(in_, out, params) {
  return new ZodCodec({
    type: "pipe",
    in: in_,
    out,
    transform: params.decode,
    reverseTransform: params.encode
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodTemplateLiteral = /* @__PURE__ */ $constructor("ZodTemplateLiteral", (inst, def) => {
  $ZodTemplateLiteral.init(inst, def);
  ZodType.init(inst, def);
});
function templateLiteral(parts, params) {
  return new ZodTemplateLiteral({
    type: "template_literal",
    parts,
    ...exports_util.normalizeParams(params)
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodPromise = /* @__PURE__ */ $constructor("ZodPromise", (inst, def) => {
  $ZodPromise.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function promise(innerType) {
  return new ZodPromise({
    type: "promise",
    innerType
  });
}
var ZodFunction = /* @__PURE__ */ $constructor("ZodFunction", (inst, def) => {
  $ZodFunction.init(inst, def);
  ZodType.init(inst, def);
});
function _function(params) {
  return new ZodFunction({
    type: "function",
    input: Array.isArray(params?.input) ? tuple(params?.input) : params?.input ?? array(unknown()),
    output: params?.output ?? unknown()
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
});
function check(fn) {
  const ch = new $ZodCheck({
    check: "custom"
  });
  ch._zod.check = fn;
  return ch;
}
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
  return _superRefine(fn);
}
function _instanceof(cls, params = {
  error: `Input not instance of ${cls.name}`
}) {
  const inst = new ZodCustom({
    type: "custom",
    check: "custom",
    fn: (data) => data instanceof cls,
    abort: true,
    ...exports_util.normalizeParams(params)
  });
  inst._zod.bag.Class = cls;
  return inst;
}
var stringbool = (...args) => _stringbool({
  Codec: ZodCodec,
  Boolean: ZodBoolean,
  String: ZodString
}, ...args);
function json(params) {
  const jsonSchema = lazy(() => {
    return union([string2(params), number2(), boolean2(), _null3(), array(jsonSchema), record3(string2(), jsonSchema)]);
  });
  return jsonSchema;
}
function preprocess(fn, schema) {
  return pipe(transform(fn), schema);
}
// node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
function setErrorMap(map2) {
  config({
    customError: map2
  });
}
function getErrorMap() {
  return config().customError;
}
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
// node_modules/zod/v4/classic/coerce.js
var exports_coerce = {};
__export(exports_coerce, {
  string: () => string3,
  number: () => number3,
  date: () => date4,
  boolean: () => boolean3,
  bigint: () => bigint3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
function bigint3(params) {
  return _coercedBigint(ZodBigInt, params);
}
function date4(params) {
  return _coercedDate(ZodDate, params);
}

// node_modules/zod/v4/classic/external.js
config(en_default());
// node_modules/@opencode-ai/plugin/dist/tool.js
function tool(input) {
  return input;
}
tool.schema = exports_external;
// plugin.ts
import { closeSync, fstatSync, openSync, readSync, appendFileSync, existsSync, lstatSync as lstatSync3, mkdirSync as mkdirSync3, readdirSync, readFileSync as readFileSync5, realpathSync as realpathSync4, renameSync as renameSync3, statSync as statSync4, unlinkSync as unlinkSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename2, dirname as dirname4, isAbsolute as isAbsolute3, join as join5, relative as relative3 } from "node:path";
import { tmpdir as tmpdir2, homedir } from "node:os";

// src/plan-file.ts
class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
  }
}
var TERMINAL = ["done", "abandoned", "superseded"];
var LEGAL_TRANSITIONS = {
  draft: ["approved", "abandoned", "superseded"],
  approved: ["done", "abandoned", "superseded"],
  done: ["approved"],
  abandoned: [],
  superseded: []
};
var SECTION_ORDER = [
  "Goal",
  "Non-Goals",
  "Context Findings",
  "Approach and Alternatives",
  "Task List",
  "Risks",
  "Acceptance Criteria"
];
var SECTION_ALIASES = {
  Goal: /^(#*)\s*(goal|目标)\s*$/i,
  "Non-Goals": /^(#*)\s*(non-goals?|out of scope|非目标)\s*$/i,
  "Context Findings": /^(#*)\s*(context( findings?)?|findings|上下文发现|上下文)\s*$/i,
  "Approach and Alternatives": /^(#*)\s*(approach( and alternatives)?|方案与备选|方案)\s*$/i,
  "Task List": /^(#*)\s*(tasks?|task list|任务清单|任务)\s*$/i,
  Risks: /^(#*)\s*(risks?|风险)\s*$/i,
  "Acceptance Criteria": /^(#*)\s*(acceptance criteria|验收标准|验收)\s*$/i,
  "Verification Checks": /^(#*)\s*(verification checks|验证检查)\s*$/i,
  "Check Log": /^(#*)\s*(check log|检查日志)\s*$/i
};
function isTerminal(status) {
  return TERMINAL.includes(status);
}
function canTransition(from, to) {
  const legal = LEGAL_TRANSITIONS[from];
  return Array.isArray(legal) && legal.includes(to);
}
function slugify(goal) {
  const slug = goal.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return slug || "plan";
}
function localDate(d = new Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function planFileName(date5, slug, existingNames = []) {
  const taken = new Set(existingNames);
  let base = `${date5}-${slug}`;
  let name = `${base}.md`;
  let i = 2;
  while (taken.has(name)) {
    name = `${base}-${i}.md`;
    i++;
  }
  return name;
}
function validatePlanInput(input) {
  const missing = [];
  const reqStr = (v) => typeof v === "string" && v.trim().length > 0;
  if (!reqStr(input.goal))
    missing.push("goal");
  if (!reqStr(input.context))
    missing.push("context");
  if (!reqStr(input.approach))
    missing.push("approach");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || !input.tasks.every(reqStr)) {
    missing.push("tasks (at least one non-empty task)");
  }
  if (!reqStr(input.risks))
    missing.push("risks");
  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0 || !input.acceptance.every(reqStr)) {
    missing.push("acceptance (at least one criterion)");
  }
  return missing;
}
function frontmatterBlock(status, created, updated, goal) {
  const goalLine = goal.replace(/\r?\n/g, " ").trim();
  return [
    "---",
    `status: ${status}`,
    `created: ${created}`,
    `updated: ${updated}`,
    `goal: ${goalLine}`,
    "---",
    ""
  ].join(`
`);
}
function renderPlan(input, now, createdOverride) {
  const missing = validatePlanInput(input);
  if (missing.length > 0) {
    throw new PlanError(`Plan content incomplete; missing: ${missing.join(", ")}`);
  }
  const goal = input.goal.trim();
  const nonGoals = (input.nonGoals ?? []).filter((s) => s.trim().length > 0);
  const parts = [
    frontmatterBlock("draft", createdOverride ?? now, now, goal),
    "## Goal",
    "",
    goal,
    "",
    "## Non-Goals",
    "",
    nonGoals.length > 0 ? nonGoals.map((s) => `- ${s.trim()}`).join(`
`) : "(no non-goals declared for this task)",
    "",
    "## Context Findings",
    "",
    input.context.trim(),
    "",
    "## Approach and Alternatives",
    "",
    input.approach.trim(),
    "",
    "## Task List",
    "",
    input.tasks.map((t, i) => `- [ ] ${i + 1}. ${t.trim()}`).join(`
`),
    "",
    "## Risks",
    "",
    input.risks.trim(),
    "",
    "## Acceptance Criteria",
    "",
    input.acceptance.map((a, i) => `${i + 1}. ${a.trim()}`).join(`
`),
    ""
  ];
  const checks3 = input.checks ?? [];
  if (checks3.length > 0) {
    parts.push("## Verification Checks", "", checks3.map((c, i) => `${i + 1}. ${renderPlanCheck(c)}`).join(`
`), "", "## Check Log", "", "(no checks recorded yet)", "");
  }
  return parts.join(`
`);
}
function renderPlanCheck(item) {
  if (item.kind === "shell") {
    const t = item.timeoutSec ?? 120;
    return `shell \`${item.cmd}\` (timeout ${t}s)`;
  }
  return `contains \`${item.file}\` :: \`${item.text}\``;
}
var PLAN_SHELL_LINE_RE = /^\s*(\d+)[.、)]\s*shell\s+`([^`]*)`(?:\s+\(timeout\s+(\d+)s?\))?$/i;
var PLAN_CONTAINS_LINE_RE = /^\s*(\d+)[.、)]\s*contains\s+`([^`]*)`\s*::\s*`([^`]*)`$/i;
function parseChecksSection(section) {
  const checks3 = [];
  const seen = new Set;
  for (const line of section.split(/\r?\n/)) {
    const shell = line.match(PLAN_SHELL_LINE_RE);
    if (shell) {
      if (seen.has(Number(shell[1])))
        throw new PlanError(`Duplicate verification item number: ${shell[1]}`);
      seen.add(Number(shell[1]));
      checks3.push({ kind: "shell", cmd: shell[2], ...shell[3] ? { timeoutSec: Number(shell[3]) } : {} });
      continue;
    }
    const contains2 = line.match(PLAN_CONTAINS_LINE_RE);
    if (contains2) {
      if (seen.has(Number(contains2[1])))
        throw new PlanError(`Duplicate verification item number: ${contains2[1]}`);
      seen.add(Number(contains2[1]));
      checks3.push({ kind: "contains", file: contains2[2], text: contains2[3] });
    }
  }
  return checks3;
}
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m)
    throw new PlanError("plan file is missing frontmatter");
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv)
      fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length) };
}
function matchSectionHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#"))
    return null;
  for (const key of Object.keys(SECTION_ALIASES)) {
    if (SECTION_ALIASES[key].test(trimmed))
      return key;
  }
  return null;
}
function splitSections(body) {
  const sections = new Map;
  const claimed = new Set;
  let current = null;
  const buf = [];
  const flush = () => {
    if (current !== null)
      sections.set(current, buf.join(`
`).trim());
    buf.length = 0;
  };
  for (const line of body.split(/\r?\n/)) {
    const header = matchSectionHeader(line);
    if (header === null || claimed.has(header)) {
      if (current !== null)
        buf.push(line);
      continue;
    }
    flush();
    claimed.add(header);
    current = header;
  }
  flush();
  return sections;
}
var TASK_RE = /^-\s*\[([ xX])\]\s*(\d+)\.\s*(.*)$/;
var TICKED_RE = /<!--\s*ticked:\s*([^>]*?)\s*-->/;
var ACCEPT_RE = /^\s*(\d+)[.、)]\s*(.+)$/;
function parsePlan(text) {
  const { fm, body } = parseFrontmatter(text);
  const status = fm.status ?? "draft";
  if (!["draft", "approved", "done", "abandoned", "superseded"].includes(status)) {
    throw new PlanError(`Unknown plan status: ${fm.status}`);
  }
  const sections = splitSections(body);
  for (const key of SECTION_ORDER) {
    if (!sections.has(key)) {
      throw new PlanError(`Plan is missing section: ${key}`);
    }
  }
  const tasks = [];
  const seen = new Set;
  for (const line of (sections.get("Task List") ?? "").split(/\r?\n/)) {
    const m = line.match(TASK_RE);
    if (!m)
      continue;
    const n = Number(m[2]);
    if (seen.has(n))
      throw new PlanError(`Duplicate task number: ${n}`);
    seen.add(n);
    const ticked = m[3].match(TICKED_RE);
    tasks.push({
      n,
      done: m[1].toLowerCase() === "x",
      text: m[3].replace(TICKED_RE, "").trim(),
      ...ticked ? { tickedAt: ticked[1] } : {}
    });
  }
  if (tasks.length === 0)
    throw new PlanError("Task list is empty or malformed");
  const acceptance = [];
  for (const line of (sections.get("Acceptance Criteria") ?? "").split(/\r?\n/)) {
    const m = line.match(ACCEPT_RE);
    if (m)
      acceptance.push(m[2].trim());
  }
  const checks3 = parseChecksSection(sections.get("Verification Checks") ?? "");
  return {
    status,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    goal: fm.goal ?? "",
    sections,
    tasks,
    acceptance,
    checks: checks3
  };
}
function parsePlanLoose(text) {
  try {
    return parsePlan(text);
  } catch {
    return null;
  }
}
function setUpdated(text, now) {
  if (/^updated:.*$/m.test(text)) {
    return text.replace(/^updated:.*$/m, `updated: ${now}`);
  }
  return text.replace(/^---\r?\n/, `---
updated: ${now}
`);
}
function tickTask(text, n, now) {
  const lines = text.split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    if (found)
      return line;
    const m = line.match(TASK_RE);
    if (!m || Number(m[2]) !== n)
      return line;
    if (m[1].toLowerCase() === "x") {
      throw new PlanError(`Task ${n} is already ticked; refusing duplicate tick`);
    }
    found = true;
    const body = m[3].replace(TICKED_RE, "").trim();
    return `- [x] ${n}. ${body} <!-- ticked: ${now} -->`;
  });
  if (!found)
    throw new PlanError(`Task number ${n} does not exist`);
  return setUpdated(out.join(`
`), now);
}
function transitionStatus(text, to, now) {
  const { fm } = parseFrontmatter(text);
  const from = fm.status ?? "draft";
  if (from === to)
    throw new PlanError(`Plan is already ${to}`);
  if (!canTransition(from, to)) {
    throw new PlanError(`Illegal status transition: ${from} -> ${to} (legal path: draft -> approved -> done; done -> approved via plan_reopen; draft/approved -> abandoned/superseded)`);
  }
  const next = text.replace(/^status:.*$/m, `status: ${to}`);
  return setUpdated(next, now);
}
function appendTerminalSection(text, kind, opts = {}, now = new Date().toISOString()) {
  if (!["closed", "abandoned", "superseded"].includes(kind)) {
    throw new PlanError(`Unknown terminal section kind: ${kind}`);
  }
  const lines = [`## ${now} — ${kind}`, ""];
  const reason = (opts.reason ?? "").trim();
  lines.push(`reason: ${reason.length > 0 ? reason : "(none given)"}`);
  const successor = (opts.successor ?? "").trim();
  if (successor.length > 0)
    lines.push(`successor: ${successor}`);
  if (opts.checks && opts.checks.length > 0) {
    lines.push("checks:");
    for (const c of opts.checks) {
      lines.push(`- ${c.pass ? "PASS" : "FAIL"} — ${c.criterion.trim()}`);
      lines.push(`  evidence: ${c.evidence.trim() || "(none)"}`);
    }
  }
  if (opts.outcomes && opts.outcomes.length > 0) {
    const limit = opts.outcomeOutputLimit ?? 2048;
    lines.push("verification:");
    for (const o of opts.outcomes) {
      lines.push(`- #${o.index} ${o.ok ? "OK" : "FAIL"} (${o.durationMs}ms) \`${o.label.replace(/\r?\n/g, " ")}\``);
      const flat = (o.detail || "(no output)").replace(/\r?\n/g, " ");
      lines.push(`  output: ${flat.length > limit ? `${flat.slice(0, limit)}…` : flat}`);
    }
  }
  const base = text.replace(/\r?\n$/, "");
  return `${base}

${lines.join(`
`)}
`;
}
function appendReopenSection(text, now = new Date().toISOString(), reason) {
  const lines = [`## ${now} — reopened`, ""];
  const r = (reason ?? "").trim();
  lines.push(`reason: ${r.length > 0 ? r : "(none given)"}`);
  const base = text.replace(/\r?\n$/, "");
  return `${base}

${lines.join(`
`)}
`;
}
function appendPlanCheckLog(text, runId, outcomes, now, detailLimit = 400) {
  const doc2 = parsePlan(text);
  const existing = new Set((doc2.sections.get("Check Log") ?? "").split(/\r?\n/).map((l) => l.match(/^-\s*\S+\s+run=(\S+)\s+(#\d+)\s+/)).filter((m) => m !== null).map((m) => `${m[1]} ${m[2]}`));
  const add = outcomes.filter((o) => !existing.has(`${runId} #${o.index}`)).map((o) => {
    const label = o.label.replace(/\r?\n/g, " ");
    const flat = (o.detail || "(no output)").replace(/\r?\n/g, " ");
    const detail = flat.length > detailLimit ? `${flat.slice(0, detailLimit)}…` : flat;
    return `- ${now} run=${runId} #${o.index} ${o.ok ? "OK" : "FAIL"} (${o.durationMs ?? 0}ms) \`${label}\` :: ${detail}`;
  });
  if (add.length === 0)
    return setUpdated(text, now);
  const lines = text.split(/\r?\n/);
  const logHeaderIdx = lines.findIndex((l) => SECTION_ALIASES["Check Log"].test(l.trim()));
  if (logHeaderIdx === -1)
    throw new PlanError("Plan is missing section: Check Log");
  const placeholderIdx = lines.indexOf("(no checks recorded yet)", logHeaderIdx);
  if (placeholderIdx !== -1 && placeholderIdx < logHeaderIdx + 4)
    lines.splice(placeholderIdx, 1);
  let lastLog = -1;
  for (let i = logHeaderIdx + 1;i < lines.length; i++) {
    if (lines[i].startsWith("- "))
      lastLog = i;
    else if (lines[i].trim() !== "")
      break;
  }
  const at = lastLog === -1 ? logHeaderIdx + 2 : lastLog + 1;
  lines.splice(at, 0, ...add);
  return setUpdated(lines.join(`
`), now);
}
function progressOf(doc2) {
  return { total: doc2.tasks.length, done: doc2.tasks.filter((t) => t.done).length };
}
function closeCheckFailures(doc2, checks3) {
  const failures = [];
  const unticked = doc2.tasks.filter((t) => !t.done).map((t) => t.n);
  if (unticked.length > 0) {
    failures.push(`Unticked tasks remain: ${unticked.join(", ")}`);
  }
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const byCriterion = new Map(checks3.map((c) => [norm(c.criterion), c]));
  doc2.acceptance.forEach((criterion, i) => {
    const check2 = byCriterion.get(norm(criterion));
    if (!check2) {
      failures.push(`Acceptance criterion ${i + 1} has no self-check: ${criterion}`);
    } else if (!check2.pass) {
      failures.push(`Acceptance criterion ${i + 1} self-check failed: ${criterion} (evidence: ${check2.evidence || "none"})`);
    }
  });
  return failures;
}
function rankActivePlans(entries) {
  return entries.map((e) => ({ name: e.name, doc: parsePlanLoose(e.text) })).filter((e) => e.doc !== null && !isTerminal(e.doc.status)).sort((a, b) => a.doc.updated < b.doc.updated ? 1 : a.doc.updated > b.doc.updated ? -1 : a.name.localeCompare(b.name));
}

// src/goal-file.ts
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

class GoalError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoalError";
  }
}
var DEFAULT_MAX_TURNS = 25;
var DEFAULT_MAX_MINUTES = 60;
var HARD_MAX_TURNS = 200;
var HARD_MAX_MINUTES = 480;
var DEFAULT_TIMEOUT_SEC = 120;
var MAX_TIMEOUT_SEC = 600;
var TRANSPORT_FAILURE_LIMIT = 3;
var NO_PROGRESS_LIMIT = 2;
var TERMINAL2 = ["completed", "abandoned"];
var LEGAL_TRANSITIONS2 = {
  queued: ["active", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "abandoned"],
  completed: [],
  abandoned: []
};
var SECTION_ORDER2 = [
  "Goal",
  "Success Criteria",
  "Verification Checks",
  "Constraints",
  "Non-Goals",
  "Check Log",
  "Turn Ledger"
];
var SECTION_HEADERS = {
  Goal: /^(#*)\s*goal\s*$/i,
  "Success Criteria": /^(#*)\s*success criteria\s*$/i,
  "Verification Checks": /^(#*)\s*verification checks\s*$/i,
  Constraints: /^(#*)\s*constraints\s*$/i,
  "Non-Goals": /^(#*)\s*non-goals?\s*$/i,
  "Check Log": /^(#*)\s*check log\s*$/i,
  "Turn Ledger": /^(#*)\s*turn ledger\s*$/i
};
var SHELL_LINE_RE = /^\s*(\d+)[.、)]\s*shell\s+`([^`]*)`(?:\s+\(timeout\s+(\d+)s?\))?$/i;
var CONTAINS_LINE_RE = /^\s*(\d+)[.、)]\s*contains\s+`([^`]*)`\s*::\s*`([^`]*)`$/i;
var NUMBERED_RE = /^\s*(\d+)[.、)]\s+(.+)$/;
var LEDGER_RE = /^-\s*turn\s+(\d+)\s+rev(\d+)\s+(\S+)\s+activity=(yes|no)\s+\(writes=(\d+)\s+checks=(\d+)\)$/;
function isGoalTerminal(status) {
  return TERMINAL2.includes(status);
}
function isGoalLive(status) {
  return status === "active" || status === "paused";
}
function canTransitionGoal(from, to) {
  const legal = LEGAL_TRANSITIONS2[from];
  return Array.isArray(legal) && legal.includes(to);
}
function slugifyGoal(goal) {
  const slug = goal.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return slug || "goal";
}
function localDateNow(d = new Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function goalFileName(date5, slug, existingNames = []) {
  const taken = new Set(existingNames);
  let base = `${date5}-${slug}`;
  let name = `${base}.md`;
  let i = 2;
  while (taken.has(name)) {
    name = `${base}-${i}.md`;
    i++;
  }
  return name;
}
function atomicWrite(file2, text) {
  const tmp = `${file2}.${process.pid}-${Math.random().toString(36).slice(2, 6)}.tmp`;
  writeFileSync(tmp, text, { flag: "wx" });
  try {
    renameSync(tmp, file2);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
function validateGoalInput(input) {
  const missing = [];
  const reqStr = (v) => typeof v === "string" && v.trim().length > 0;
  if (!reqStr(input.goal))
    missing.push("goal");
  if (!Array.isArray(input.criteria) || input.criteria.length === 0 || !input.criteria.every(reqStr)) {
    missing.push("criteria (at least one success criterion)");
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    missing.push("checks (at least one verification item)");
  } else {
    for (const c of input.checks) {
      if (c.kind === "shell" && !reqStr(c.cmd)) {
        missing.push("checks (a shell item has an empty command)");
        break;
      }
      if (c.kind === "contains" && (!reqStr(c.file) || !reqStr(c.text))) {
        missing.push("checks (a contains item has an empty file or text)");
        break;
      }
    }
  }
  if (!reqStr(input.constraints))
    missing.push("constraints");
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > HARD_MAX_TURNS)) {
    missing.push(`maxTurns (integer 1-${HARD_MAX_TURNS})`);
  }
  if (input.maxMinutes !== undefined && (!Number.isInteger(input.maxMinutes) || input.maxMinutes < 1 || input.maxMinutes > HARD_MAX_MINUTES)) {
    missing.push(`maxMinutes (integer 1-${HARD_MAX_MINUTES})`);
  }
  return missing;
}
function renderCheck(item) {
  if (item.kind === "shell") {
    const t = item.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    return `shell \`${item.cmd}\` (timeout ${t}s)`;
  }
  return `contains \`${item.file}\` :: \`${item.text}\``;
}
function frontmatterBlock2(meta) {
  const lines = [
    "---",
    `status: ${meta.status}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `revision: ${meta.revision}`
  ];
  if (meta.armedAt)
    lines.push(`armed_at: ${meta.armedAt}`);
  if (meta.session)
    lines.push(`session: ${meta.session}`);
  lines.push(`max_turns: ${meta.maxTurns}`, `turns_used: ${meta.turnsUsed}`, `max_minutes: ${meta.maxMinutes}`);
  if (meta.status === "paused" && meta.stopReason)
    lines.push(`stop_reason: ${meta.stopReason}`);
  if (meta.status === "paused" && meta.blocker)
    lines.push(`blocker: ${JSON.stringify(meta.blocker)}`);
  lines.push("---", "");
  return lines.join(`
`);
}
function renderGoal(input, meta) {
  const missing = validateGoalInput(input);
  if (missing.length > 0) {
    throw new GoalError(`Goal contract incomplete; missing: ${missing.join(", ")}`);
  }
  const goal = input.goal.trim();
  const nonGoals = (input.nonGoals ?? []).filter((s) => s.trim().length > 0);
  const parts = [
    frontmatterBlock2({
      status: meta.status,
      created: meta.created ?? meta.now,
      updated: meta.now,
      revision: meta.revision ?? 1,
      session: meta.session,
      maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
      turnsUsed: meta.turnsUsed ?? 0,
      maxMinutes: input.maxMinutes ?? DEFAULT_MAX_MINUTES,
      ...meta.armedAt ? { armedAt: meta.armedAt } : {},
      ...meta.status === "paused" && meta.stopReason ? { stopReason: meta.stopReason, blocker: meta.blocker } : {}
    }),
    "## Goal",
    "",
    goal,
    "",
    "## Success Criteria",
    "",
    input.criteria.map((c, i) => `${i + 1}. ${c.trim()}`).join(`
`),
    "",
    "## Verification Checks",
    "",
    input.checks.map((c, i) => `${i + 1}. ${renderCheck(c)}`).join(`
`),
    "",
    "## Constraints",
    "",
    input.constraints.trim(),
    "",
    "## Non-Goals",
    "",
    nonGoals.length > 0 ? nonGoals.map((s) => `- ${s.trim()}`).join(`
`) : "(no non-goals declared)",
    "",
    "## Check Log",
    "",
    "(no checks recorded yet)",
    "",
    "## Turn Ledger",
    "",
    "(no continuation turns yet)",
    ""
  ];
  return parts.join(`
`);
}
function parseFrontmatter2(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m)
    throw new GoalError("goal file is missing frontmatter");
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv)
      fm[kv[1]] = kv[2].trim();
  }
  return { fm, header: m[0], body: text.slice(m[0].length) };
}
function matchSectionHeader2(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#"))
    return null;
  for (const key of Object.keys(SECTION_HEADERS)) {
    if (SECTION_HEADERS[key].test(trimmed))
      return key;
  }
  return null;
}
function splitSections2(body) {
  const sections = new Map;
  let current = null;
  const buf = [];
  const flush = () => {
    if (current !== null)
      sections.set(current, buf.join(`
`).trim());
    buf.length = 0;
  };
  for (const line of body.split(/\r?\n/)) {
    const header = matchSectionHeader2(line);
    if (header !== null) {
      flush();
      current = header;
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}
function parseGoal(text) {
  const { fm, body } = parseFrontmatter2(text);
  const status = fm.status ?? "queued";
  if (!["queued", "active", "paused", "completed", "abandoned"].includes(status)) {
    throw new GoalError(`Unknown goal status: ${fm.status}`);
  }
  const sections = splitSections2(body);
  for (const key of SECTION_ORDER2) {
    if (!sections.has(key)) {
      throw new GoalError(`Goal is missing section: ${key}`);
    }
  }
  const criteria = [];
  const seenCriterion = new Set;
  for (const line of (sections.get("Success Criteria") ?? "").split(/\r?\n/)) {
    const m = line.match(NUMBERED_RE);
    if (!m)
      continue;
    if (seenCriterion.has(Number(m[1])))
      throw new GoalError(`Duplicate success criterion number: ${m[1]}`);
    seenCriterion.add(Number(m[1]));
    criteria.push(m[2].trim());
  }
  if (criteria.length === 0)
    throw new GoalError("Success criteria are empty or malformed");
  const checks3 = [];
  const seenCheck = new Set;
  for (const line of (sections.get("Verification Checks") ?? "").split(/\r?\n/)) {
    const shell = line.match(SHELL_LINE_RE);
    if (shell) {
      if (seenCheck.has(Number(shell[1])))
        throw new GoalError(`Duplicate verification item number: ${shell[1]}`);
      seenCheck.add(Number(shell[1]));
      checks3.push({ kind: "shell", cmd: shell[2], ...shell[3] ? { timeoutSec: Number(shell[3]) } : {} });
      continue;
    }
    const contains2 = line.match(CONTAINS_LINE_RE);
    if (contains2) {
      if (seenCheck.has(Number(contains2[1])))
        throw new GoalError(`Duplicate verification item number: ${contains2[1]}`);
      seenCheck.add(Number(contains2[1]));
      checks3.push({ kind: "contains", file: contains2[2], text: contains2[3] });
    }
  }
  if (checks3.length === 0)
    throw new GoalError("Verification checks are empty or malformed");
  const log = (sections.get("Check Log") ?? "").split(/\r?\n/).filter((l) => l.startsWith("- "));
  const ledger = [];
  for (const line of (sections.get("Turn Ledger") ?? "").split(/\r?\n/)) {
    const m = line.match(LEDGER_RE);
    if (m) {
      ledger.push({ turn: Number(m[1]), revision: Number(m[2]), at: m[3], activity: m[4] === "yes", writes: Number(m[5]), checks: Number(m[6]) });
    }
  }
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
  };
  let blocker;
  if (status === "paused" && fm.blocker) {
    try {
      const value = JSON.parse(fm.blocker);
      if (typeof value === "string")
        blocker = value;
    } catch {}
  }
  return {
    status,
    created: fm.created ?? "",
    armedAt: fm.armed_at ?? "",
    updated: fm.updated ?? "",
    revision: Math.max(1, num(fm.revision, 1)),
    session: fm.session ?? "",
    maxTurns: Math.max(1, num(fm.max_turns, DEFAULT_MAX_TURNS)),
    turnsUsed: num(fm.turns_used, 0),
    maxMinutes: Math.max(1, num(fm.max_minutes, DEFAULT_MAX_MINUTES)),
    ...status === "paused" && fm.stop_reason ? { stopReason: fm.stop_reason } : {},
    ...blocker !== undefined ? { blocker } : {},
    goal: (sections.get("Goal") ?? "").split(/\r?\n/)[0]?.trim() ?? "",
    criteria,
    checks: checks3,
    constraints: sections.get("Constraints") ?? "",
    nonGoals: (sections.get("Non-Goals") ?? "").split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(1).trim()),
    log,
    ledger
  };
}
function parseGoalLoose(text) {
  try {
    return parseGoal(text);
  } catch {
    return null;
  }
}
function setFm(text, key, value) {
  const { header, body } = parseFrontmatter2(text);
  const re = new RegExp(`^${key}:[^\\r\\n]*`, "m");
  if (re.test(header))
    return header.replace(re, () => `${key}: ${value}`) + body;
  return header.replace(/^---(\r?\n)/, (_, eol) => `---${eol}${key}: ${value}${eol}`) + body;
}
function deleteFm(text, key) {
  const { header, body } = parseFrontmatter2(text);
  return header.replace(new RegExp(`^${key}:[^\\r\\n]*\\r?\\n`, "gm"), "") + body;
}
function setUpdated2(text, now) {
  return setFm(text, "updated", now);
}
function transitionGoal(text, to, now, opts = {}) {
  const { fm } = parseFrontmatter2(text);
  const from = fm.status ?? "queued";
  if (from === to)
    throw new GoalError(`Goal is already ${to}`);
  if (!canTransitionGoal(from, to)) {
    throw new GoalError(`Illegal goal status transition: ${from} -> ${to} (legal paths: queued -> active; active <-> paused; active -> completed; queued/active/paused -> abandoned)`);
  }
  let next = setFm(text, "status", to);
  if (to === "paused") {
    if (!opts.stopReason)
      throw new GoalError("Pausing requires a stop reason (user/blocker/no-progress/budget-turns/budget-time/draft-conflict/transport-failures)");
    next = setFm(next, "stop_reason", opts.stopReason);
    if (opts.blocker)
      next = setFm(next, "blocker", JSON.stringify(opts.blocker));
  }
  if (to === "active") {
    if (!opts.session)
      throw new GoalError("Arming/resuming requires the owning session id");
    next = setFm(next, "session", opts.session);
    next = setFm(next, "armed_at", now);
    next = deleteFm(next, "blocker");
    next = deleteFm(next, "stop_reason");
  }
  return setUpdated2(next, now);
}
function incTurns(text, now) {
  const doc2 = parseGoal(text);
  const next = setFm(text, "turns_used", String(doc2.turnsUsed + 1));
  return setUpdated2(next, now);
}
function bumpBudget(text, addTurns, now) {
  const doc2 = parseGoal(text);
  const capped = Math.min(doc2.maxTurns + addTurns, HARD_MAX_TURNS);
  const next = setFm(text, "max_turns", String(capped));
  return setUpdated2(next, now);
}
function budgetState(doc2) {
  if (doc2.turnsUsed >= doc2.maxTurns)
    return "budget-turns";
  const start = Date.parse(doc2.armedAt || doc2.created);
  if (Number.isFinite(start) && Date.now() - start > doc2.maxMinutes * 60000)
    return "budget-time";
  return "ok";
}
var LOG_SIG_RE = /^-\s*\S+\s+run=(\S+)\s+(rev\d+)\s+(#\d+)\s+/;
function appendCheckLog(text, runId, outcomes, now) {
  const doc2 = parseGoal(text);
  const existing = new Set(doc2.log.map((l) => l.match(LOG_SIG_RE)).filter((m) => m !== null).map((m) => `${m[1]} ${m[2]} ${m[3]}`));
  const add = outcomes.filter((o) => !existing.has(`${runId} rev${doc2.revision} #${o.index}`)).map((o) => {
    const label = o.label.replace(/\r?\n/g, " ");
    const flat = (o.detail || "(no output)").replace(/\r?\n/g, " ");
    const detail = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
    return `- ${now} run=${runId} rev${doc2.revision} #${o.index} ${o.ok ? "OK" : "FAIL"} (${o.durationMs ?? 0}ms) \`${label}\` :: ${detail}`;
  });
  if (add.length === 0)
    return setUpdated2(text, now);
  const lines = text.split(/\r?\n/);
  const logHeaderIdx = lines.findIndex((l) => SECTION_HEADERS["Check Log"].test(l.trim()));
  if (logHeaderIdx === -1)
    throw new GoalError("Goal is missing section: Check Log");
  const placeholderIdx = lines.indexOf("(no checks recorded yet)", logHeaderIdx);
  if (placeholderIdx !== -1)
    lines.splice(placeholderIdx, 1);
  let lastLog = -1;
  for (let i = logHeaderIdx + 1;i < lines.length; i++) {
    if (lines[i].startsWith("- "))
      lastLog = i;
    else if (lines[i].trim() !== "")
      break;
  }
  const at = lastLog === -1 ? logHeaderIdx + 2 : lastLog + 1;
  lines.splice(at, 0, ...add);
  return setUpdated2(lines.join(`
`), now);
}
function appendLedger(text, entry, now) {
  const lines = text.split(/\r?\n/);
  const line = `- turn ${entry.turn} rev${entry.revision} ${entry.at} activity=${entry.activity ? "yes" : "no"} (writes=${entry.writes} checks=${entry.checks})`;
  const headerIdx = lines.findIndex((l) => SECTION_HEADERS["Turn Ledger"].test(l.trim()));
  if (headerIdx === -1)
    throw new GoalError("Goal is missing section: Turn Ledger");
  const phIdx = lines.indexOf("(no continuation turns yet)", headerIdx);
  if (phIdx !== -1)
    lines.splice(phIdx, 1);
  const re = new RegExp(`^-\\s*turn\\s+${entry.turn}\\s+rev\\d+\\s+`);
  const existingIdx = lines.findIndex((l, i) => i > headerIdx && re.test(l));
  if (existingIdx !== -1) {
    lines[existingIdx] = line;
  } else {
    let lastLedger = -1;
    for (let i = headerIdx + 1;i < lines.length; i++) {
      if (lines[i].startsWith("- "))
        lastLedger = i;
      else if (lines[i].trim() !== "")
        break;
    }
    const at = lastLedger === -1 ? headerIdx + 2 : lastLedger + 1;
    lines.splice(at, 0, line);
  }
  return setUpdated2(lines.join(`
`), now);
}
function carryHistory(newText, oldDoc) {
  let out = newText;
  if (oldDoc.log.length > 0) {
    out = out.replace("(no checks recorded yet)", () => oldDoc.log.join(`
`));
  }
  if (oldDoc.ledger.length > 0) {
    const lines = oldDoc.ledger.map((e) => `- turn ${e.turn} rev${e.revision} ${e.at} activity=${e.activity ? "yes" : "no"} (writes=${e.writes} checks=${e.checks})`);
    out = out.replace("(no continuation turns yet)", () => lines.join(`
`));
  }
  return out;
}
function rankLiveGoals(entries) {
  return entries.map((e) => ({ name: e.name, doc: parseGoalLoose(e.text) })).filter((e) => e.doc !== null && isGoalLive(e.doc.status)).sort((a, b) => a.doc.updated < b.doc.updated ? 1 : a.doc.updated > b.doc.updated ? -1 : a.name.localeCompare(b.name));
}
function rankQueuedGoals(entries) {
  return entries.map((e) => ({ name: e.name, doc: parseGoalLoose(e.text) })).filter((e) => e.doc !== null && e.doc.status === "queued").sort((a, b) => a.doc.created > b.doc.created ? 1 : a.doc.created < b.doc.created ? -1 : a.name.localeCompare(b.name));
}
function completeCheckFailures(doc2, attestations) {
  const failures = [];
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const byCriterion = new Map(attestations.map((a) => [norm(a.criterion), a]));
  doc2.criteria.forEach((criterion, i) => {
    const a = byCriterion.get(norm(criterion));
    if (!a) {
      failures.push(`Success criterion ${i + 1} has no self-attestation: ${criterion}`);
    } else if (!a.pass) {
      failures.push(`Success criterion ${i + 1} attested as unmet: ${criterion} (evidence: ${a.evidence || "none"})`);
    }
  });
  if (attestations.length > doc2.criteria.length) {
    failures.push(`${attestations.length - doc2.criteria.length} attestation(s) do not match any criterion of revision ${doc2.revision}`);
  }
  return failures;
}

// src/run-check.ts
import { spawn as spawn2 } from "node:child_process";
import { readFileSync } from "node:fs";
import { join as join3, resolve as resolve2, sep as sep2 } from "node:path";

// src/proc.ts
import { spawn, spawnSync as spawnSync2 } from "node:child_process";

// src/shell-select.ts
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname as dirname2, join as join2 } from "node:path";
var hostConfiguredShell;
var memo;
var DENY = new Set(["fish", "nu"]);
function shellName(bin) {
  return basename(bin).replace(/\.exe$/i, "").toLowerCase();
}
function classify(bin) {
  const name = shellName(bin);
  if (name === "pwsh" || name === "powershell")
    return { bin, family: "ps", login: false };
  if (name === "cmd")
    return { bin, family: "cmd", login: false };
  return { bin, family: "posix", login: name === "bash" || name === "zsh" };
}
function defaultWhich(platform, env) {
  return (bin) => {
    try {
      const r = spawnSync(platform === "win32" ? "where" : "which", [bin], {
        env,
        windowsHide: true,
        timeout: 5000
      });
      if (r.status !== 0 || !r.stdout)
        return;
      const first = r.stdout.toString().split(/\r?\n/).find((l) => l.trim());
      return first?.trim() || undefined;
    } catch {
      return;
    }
  };
}
function defaultStat(file2) {
  return statSync(file2, { throwIfNoEntry: false }) ?? undefined;
}
function gitBash(which, stat) {
  const git2 = which("git");
  if (!git2)
    return;
  const candidate = join2(dirname2(dirname2(git2)), "bin", "bash.exe");
  return stat(candidate)?.isFile() ? candidate : undefined;
}
function resolveShell(deps = {}) {
  const hasDeps = Object.keys(deps).length > 0;
  if (!hasDeps && memo)
    return memo;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const which = deps.which ?? defaultWhich(platform, env);
  const stat = deps.stat ?? defaultStat;
  const pick2 = (candidate) => {
    if (!candidate)
      return;
    if (DENY.has(shellName(candidate)))
      return;
    const resolved = /^[a-z]:[\\/]/i.test(candidate) || candidate.includes("/") || candidate.includes("\\") ? stat(candidate)?.isFile() ? candidate : which(candidate) : which(candidate);
    return resolved ? classify(resolved) : undefined;
  };
  let result = pick2(hostConfiguredShell);
  if (!result && platform === "win32") {
    result = pick2("pwsh") ?? pick2("powershell") ?? pick2(gitBash(which, stat)) ?? pick2(env.COMSPEC || "cmd.exe");
  }
  if (!result && platform !== "win32") {
    result = pick2(env.SHELL) ?? pick2("bash") ?? pick2("/bin/sh");
  }
  if (!result) {
    result = platform === "win32" ? { bin: env.COMSPEC || "cmd.exe", family: "cmd", login: false } : { bin: "/bin/sh", family: "posix", login: false };
  }
  if (!hasDeps)
    memo = result;
  return result;
}

// src/proc.ts
var NON_INTERACTIVE_ENV = {
  GIT_EDITOR: ":",
  EDITOR: ":",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_MERGE_AUTOEDIT: "no"
};
function shellSpawn(spawnFn, cmd, opts = {}) {
  const shell = opts.shell ?? resolveShell();
  const argv = shell.family === "ps" ? ["-NoProfile", "-Command", `${cmd}
exit $LASTEXITCODE`] : shell.family === "cmd" ? ["/c", cmd] : shell.login ? ["-l", "-c", cmd] : ["-c", cmd];
  return spawnFn(shell.bin, argv, {
    ...opts.cwd !== undefined ? { cwd: opts.cwd } : {},
    env: { ...process.env, ...NON_INTERACTIVE_ENV, ...opts.env },
    windowsHide: opts.windowsHide ?? true,
    detached: opts.detached ?? process.platform !== "win32",
    ...opts.stdio !== undefined ? { stdio: opts.stdio } : {}
  });
}
function treeKillPlan(platform, pid, force = true) {
  if (platform === "win32")
    return { kind: "taskkill", args: force ? ["/pid", String(pid), "/F", "/T"] : ["/pid", String(pid), "/T"] };
  return { kind: "group", signal: force ? "SIGKILL" : "SIGTERM" };
}
function killTree(child, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (!child.pid) {
    child.kill();
    return;
  }
  const plan = treeKillPlan(platform, child.pid);
  if (plan.kind === "taskkill") {
    try {
      (opts.spawnFn ?? spawn)("taskkill", plan.args, { windowsHide: true, stdio: "ignore" });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, plan.signal);
    } catch {
      child.kill(plan.signal);
    }
  }
}

// src/run-check.ts
var OUTPUT_LIMIT = 2048;
var defaultShellRunner = (cmd, opts) => new Promise((resolveRun) => {
  let child;
  try {
    child = shellSpawn(spawn2, cmd, { cwd: opts.cwd });
  } catch (err) {
    resolveRun({ code: null, output: "", timedOut: false, spawnError: String(err) });
    return;
  }
  let output = "";
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, opts.timeoutMs);
  const failsafe = setTimeout(() => settle({ code: null, output, timedOut: true, spawnError: "timeout settle fallback" }), opts.timeoutMs + 30000);
  failsafe.unref?.();
  const settle = (r) => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(failsafe);
    resolveRun(r);
  };
  child.stdout?.on("data", (d) => {
    if (output.length < OUTPUT_LIMIT * 2)
      output += d.toString();
  });
  child.stderr?.on("data", (d) => {
    if (output.length < OUTPUT_LIMIT * 2)
      output += d.toString();
  });
  child.on("error", (err) => settle({ code: null, output, timedOut, spawnError: err.message }));
  child.on("close", (code) => settle({ code, output, timedOut }));
});
var shellRunner = defaultShellRunner;
function truncateOutput(output) {
  const flat = output.replace(/\r?\n/g, " ⏎ ").trim();
  return flat.length > OUTPUT_LIMIT ? `${flat.slice(0, OUTPUT_LIMIT)}…` : flat;
}
function insideWorktree(worktree, file2) {
  const root = resolve2(worktree);
  const abs = resolve2(root, file2);
  return abs === root || abs.startsWith(root + sep2);
}
async function runShellItem(item, index, worktree) {
  const timeoutSec = Math.min(item.timeoutSec ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
  const started = Date.now();
  const r = await shellRunner(item.cmd, { cwd: worktree, timeoutMs: timeoutSec * 1000 });
  const durationMs = Date.now() - started;
  if (r.spawnError) {
    return { index, kind: "shell", label: item.cmd, ok: false, detail: `spawn failed: ${r.spawnError}`, durationMs };
  }
  if (r.timedOut) {
    return { index, kind: "shell", label: item.cmd, ok: false, detail: `timed out after ${timeoutSec}s (partial output: ${truncateOutput(r.output) || "none"})`, durationMs };
  }
  const displayed = truncateOutput(r.output);
  return {
    index,
    kind: "shell",
    label: item.cmd,
    ok: r.code === 0,
    detail: `exit=${r.code} ${displayed}`.trim(),
    durationMs,
    comparable: Number.isInteger(r.code) && r.output.length <= OUTPUT_LIMIT && displayed.length <= OUTPUT_LIMIT ? JSON.stringify([r.code, r.output]) : undefined
  };
}
function runContainsItem(item, index, worktree) {
  const started = Date.now();
  const label = `${item.file} :: ${item.text}`;
  if (!insideWorktree(worktree, item.file)) {
    return { index, kind: "contains", label, ok: false, detail: "path escapes the workspace boundary", durationMs: Date.now() - started };
  }
  const abs = join3(worktree, item.file);
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return { index, kind: "contains", label, ok: false, detail: `cannot read file: ${err.message}`, durationMs: Date.now() - started };
  }
  const ok = content.includes(item.text);
  return {
    index,
    kind: "contains",
    label,
    ok,
    detail: ok ? `found in ${item.file} (${content.length} chars)` : `required text not found in ${item.file} (${content.length} chars)`,
    durationMs: Date.now() - started,
    comparable: JSON.stringify([ok, content.length])
  };
}
async function runChecks(checks3, worktree) {
  const outcomes = [];
  for (let i = 0;i < checks3.length; i++) {
    const item = checks3[i];
    outcomes.push(item.kind === "shell" ? await runShellItem(item, i + 1, worktree) : runContainsItem(item, i + 1, worktree));
  }
  return outcomes;
}
function outcomesAllOk(outcomes) {
  return outcomes.every((o) => o.ok);
}
function formatOutcomes(outcomes) {
  return outcomes.map((o) => `#${o.index} [${o.ok ? "PASS" : "FAIL"}] (${o.kind}) ${o.label}
    ${o.detail}`).join(`
`);
}

// src/models-dev.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4, resolve as resolve3 } from "node:path";
import { tmpdir } from "node:os";
var DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
function parseIdentity(identity) {
  const slash2 = identity.indexOf("/");
  if (slash2 <= 0 || slash2 === identity.length - 1)
    return null;
  return { provider: identity.slice(0, slash2), model: identity.slice(slash2 + 1) };
}
function modelDepthShape(catalog, identity) {
  if (!catalog)
    return null;
  const parsed = parseIdentity(identity);
  if (!parsed)
    return null;
  const entry = catalog.providers?.[parsed.provider]?.models?.[parsed.model];
  if (!entry)
    return null;
  if (entry.reasoningShape === "toggle")
    return { shape: "toggle" };
  if (entry.reasoningShape === "budget_tokens")
    return { shape: "budget_tokens" };
  if (entry.reasoningShape === "effort")
    return { shape: "effort", ladder: entry.reasoningOptions ? [...entry.reasoningOptions] : [] };
  return null;
}
function modelsDevCacheDir(base) {
  return join4(base ?? join4(tmpdir(), "opencode-forge"), "models-dev");
}
function namedLevels(rows2) {
  const out = [];
  for (const r of rows2) {
    if (r && typeof r === "object" && r.type === "effort") {
      const values = r.values;
      if (Array.isArray(values)) {
        for (const v of values)
          if (typeof v === "string")
            out.push(v);
      }
    }
  }
  return out;
}
function shapeOf(rows2) {
  for (const r of rows2) {
    if (r && typeof r === "object") {
      const t = r.type;
      if (t === "effort" || t === "toggle" || t === "budget_tokens")
        return t;
    }
  }
  return;
}
function reduceModelsDev(raw) {
  const catalog = { providers: {} };
  const providers = raw?.constructor === Object ? raw : null;
  if (!providers)
    return catalog;
  for (const [providerID, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider))
      continue;
    const models = provider.models;
    if (!models || typeof models !== "object" || Array.isArray(models))
      continue;
    const out = { models: {} };
    for (const [modelID, model] of Object.entries(models)) {
      if (!model || typeof model !== "object" || Array.isArray(model))
        continue;
      const m = model;
      const rows2 = Array.isArray(m.reasoning_options) ? m.reasoning_options : undefined;
      const shape = rows2 !== undefined ? shapeOf(rows2) : undefined;
      const options = rows2 !== undefined && shape === "effort" ? namedLevels(rows2) : undefined;
      const cost = m.cost && typeof m.cost === "object" ? m.cost : undefined;
      out.models[modelID] = {
        ...shape !== undefined ? { reasoningShape: shape } : {},
        ...options && options.length > 0 ? { reasoningOptions: options } : {},
        ...cost ? { cost } : {}
      };
    }
    catalog.providers[providerID] = out;
  }
  return catalog;
}
async function loadModelsDevSnapshot(opts = {}) {
  const url2 = opts.url ?? process.env.OPENCODE_MODELS_URL ?? DEFAULT_MODELS_DEV_URL;
  const cacheDir = modelsDevCacheDir(opts.cacheDir);
  const cacheFile = join4(cacheDir, "snapshot.json");
  const fetcher = opts.fetcher;
  if (fetcher) {
    try {
      const res = await fetcher(url2, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
      if (res.ok)
        return { catalog: reduceModelsDev(JSON.parse(await res.text())), degraded: false, source: url2 };
    } catch {}
    return { catalog: { providers: {} }, degraded: true, source: "fetch-failed" };
  }
  const timeoutMs = opts.timeoutMs ?? 8000;
  const key = JSON.stringify([resolve3(cacheDir), url2, timeoutMs]);
  const pending = pendingLoads.get(key);
  if (pending)
    return pending;
  const load = loadCachedSnapshot(url2, cacheDir, cacheFile, timeoutMs);
  pendingLoads.set(key, load);
  try {
    return await load;
  } finally {
    pendingLoads.delete(key);
  }
}
var pendingLoads = new Map;
async function loadCachedSnapshot(url2, cacheDir, cacheFile, timeoutMs) {
  try {
    const res = await fetch(url2, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const catalog = reduceModelsDev(JSON.parse(await res.text()));
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync2(cacheFile, JSON.stringify(catalog));
      } catch {}
      return { catalog, degraded: false, source: url2 };
    }
  } catch {}
  try {
    const cached2 = JSON.parse(readFileSync2(cacheFile, "utf8"));
    if (cached2 && typeof cached2 === "object" && cached2.providers)
      return { catalog: cached2, degraded: true, source: "cache" };
  } catch {}
  return { catalog: { providers: {} }, degraded: true, source: "unavailable" };
}

// src/crew-gate.ts
var object2 = (x) => x && typeof x === "object" ? x : {};
function crewAcceptedRound(id, args, raw) {
  const event = object2(raw), result = object2(event.result), metadata = object2(result.metadata);
  if (!id || event.status !== "completed" || metadata.status !== "running" || typeof metadata.sessionID !== "string" || typeof args.agent !== "string")
    return null;
  return { id, childID: metadata.sessionID, agent: args.agent, description: String(args.description ?? ""), prompt: String(args.prompt ?? "") };
}
function crossCheckCrewEvidence(report, declared, evidence) {
  const gaps = [];
  if (!evidence.readable || evidence.inFlight.length)
    gaps.push("native session enumeration is incomplete or work remains in flight");
  const messages = object2(evidence.context).data ?? evidence.context;
  const rounds = evidence.rounds;
  for (const sub of report)
    for (const id of sub.rounds ?? []) {
      if (!rounds.some((r) => r.id === id))
        gaps.push(`${sub.title}: unknown dispatch reference ${id}`);
    }
  if (!Array.isArray(messages))
    return rounds.length ? [...gaps, "native result context unavailable"] : gaps;
  const assigned = new Map;
  for (const round of rounds) {
    const explicit = report.filter((s) => s.rounds?.includes(round.id));
    const matches = explicit.length ? declared.filter((s) => explicit.some((r) => normTitle(r.title) === normTitle(s.title))) : declared.filter((s) => normTitle(round.description) === normTitle(s.title) || round.prompt.toLowerCase().includes(`subtask: ${normTitle(s.title)}
`));
    if (matches.length !== 1) {
      gaps.push(`dispatch ${round.id}: cannot associate a unique declared subtask`);
      continue;
    }
    const key = normTitle(matches[0].title);
    assigned.set(key, [...assigned.get(key) ?? [], round]);
  }
  const results = new Map;
  const current = new Map;
  const seenNotifications = new Set;
  const ambiguous = new Set;
  const created = (raw) => object2(object2(raw).time).created;
  const ordered = messages.every((m) => typeof created(m) === "number") ? [...messages].sort((a, b) => Number(created(a)) - Number(created(b))) : messages;
  for (const raw of ordered) {
    const m = object2(raw);
    if (m.type === "assistant" && Array.isArray(m.content))
      for (const rawPart of m.content) {
        const p = object2(rawPart), state = object2(p.state), metadata = object2(state.metadata);
        const id = p.callID ?? p.id;
        const childID = metadata.sessionID;
        if (p.type === "tool" && p.name === "subagent" && state.status === "completed" && metadata.status === "running" && typeof id === "string" && typeof childID === "string") {
          const known = rounds.find((r) => r.id === id);
          if (known && known.childID !== childID) {
            ambiguous.add(known.childID);
            continue;
          }
          const previous = current.get(childID);
          if (previous && previous.id !== id && !results.has(previous.id))
            ambiguous.add(childID);
          current.set(childID, { id, childID });
        }
      }
    if (m.type !== "synthetic")
      continue;
    const meta = object2(m.metadata), text = typeof m.text === "string" ? m.text : "";
    if (meta.source !== "subagent" || typeof meta.childID !== "string")
      continue;
    if (typeof m.id === "string") {
      if (seenNotifications.has(m.id))
        continue;
      seenNotifications.add(m.id);
    }
    const round = current.get(meta.childID);
    const match = /^<background-result kind="subagent" sessionID="[^"]+" state="(completed|error|cancelled)" description="[^"]*">\s*([\s\S]*?)\s*<\/background-result>$/.exec(text);
    if (round && !ambiguous.has(round.childID) && match && meta.state === match[1] && !results.has(round.id))
      results.set(round.id, { state: match[1], text: match[2] });
  }
  for (const sub of report) {
    const related = assigned.get(normTitle(sub.title)) ?? [];
    if (!related.length) {
      if (sub.rounds?.length)
        gaps.push(`${sub.title}: referenced native dispatch evidence is missing`);
      continue;
    }
    if (related.length > 2) {
      gaps.push(`${sub.title}: at most one retry`);
      continue;
    }
    if (related.some((r) => !r.agent.startsWith("forge-")) && !/\bnative\b/i.test(sub.evidence))
      gaps.push(`${sub.title}: native fallback must be disclosed`);
    const last = related[related.length - 1], result = results.get(last.id);
    const row = evidence.settled.find((r) => r.childID === last.childID);
    if (related.some((r) => !evidence.settled.some((child) => child.childID === r.childID)))
      gaps.push(`${sub.title}: accepted work is missing from the settled host view`);
    if (related.length === 2 && sub.attempts?.length !== 2)
      gaps.push(`${sub.title}: record both attempts`);
    if (sub.verdict.toUpperCase() === "PASS") {
      if (related.some((r) => !results.has(r.id)) || result?.state !== "completed" || row?.outcome !== "succeeded" || !result.text.trim() || result.text === "Subagent completed without a text response.")
        gaps.push(`${sub.title}: PASS requires verified successful round evidence, not merely a terminal session`);
    }
  }
  return gaps;
}
function normTitle(t) {
  return String(t ?? "").trim().toLowerCase();
}
function validateCrewReport(report, declared) {
  const gaps = [];
  if (!Array.isArray(report) || report.length === 0) {
    return { ok: false, gaps: ["the report lists no subtasks — a crew completion report must cover every declared subtask"] };
  }
  const declaredTitles = new Set;
  for (const s of Array.isArray(declared) ? declared : []) {
    const t = normTitle(s?.title);
    if (t)
      declaredTitles.add(t);
  }
  const covered = new Set;
  report.forEach((sub, i) => {
    const label = sub?.title?.trim() || `subtask #${i + 1}`;
    const key = normTitle(sub?.title);
    if (!sub?.title?.trim())
      gaps.push(`${label}: missing title`);
    else if (covered.has(key))
      gaps.push(`${label}: duplicate report entry for the same title`);
    covered.add(key);
    const verdict = String(sub?.verdict ?? "").toUpperCase();
    if (verdict !== "PASS" && verdict !== "FAIL")
      gaps.push(`${label}: verdict must be PASS or FAIL (got "${sub?.verdict ?? ""}")`);
    if (!String(sub?.evidence ?? "").trim())
      gaps.push(`${label}: missing evidence statement`);
    if (verdict === "FAIL" && (!Array.isArray(sub?.attempts) || sub.attempts.length < 2)) {
      gaps.push(`${label}: FAIL requires both failure reports (the attempt and the one retry) in attempts[]`);
    }
    if (key && declaredTitles.size > 0 && !declaredTitles.has(key)) {
      gaps.push(`${label}: not part of the plan registered at crew_begin (renegade work) — fold discoveries into an existing subtask's verdict notes, or discard and re-crew with the full plan`);
    }
  });
  for (const t of declaredTitles) {
    if (!covered.has(t)) {
      const original = (Array.isArray(declared) ? declared : []).find((s) => normTitle(s?.title) === t)?.title ?? t;
      gaps.push(`"${original}": declared at crew_begin but has no verdict in the report — a declared subtask was silently dropped`);
    }
  }
  return { ok: gaps.length === 0, gaps };
}

// src/native-child-gate.ts
var unreadable = () => ({ readable: false, inFlight: [], settled: [] });
function entryInFlight(entry) {
  if (entry === undefined)
    return false;
  if (entry !== null && typeof entry === "object" && entry.type === "idle")
    return false;
  return true;
}
function nativeChildOutcome(value) {
  return value === "succeeded" || value === "failed" || value === "interrupted" ? value : null;
}
async function walkNativeChildren(client, sessionID) {
  if (!sessionID)
    return unreadable();
  try {
    const deadline = Date.now() + (client.deadlineMs ?? 8000);
    const bounded = async (call) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("native child walk deadline");
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("native child walk timeout")), remaining);
        })]);
      } finally {
        if (timer !== undefined)
          clearTimeout(timer);
      }
    };
    if (typeof client?.session?.list !== "function")
      return unreadable();
    const rows2 = [];
    const cursors = new Set;
    const ids = new Set;
    let cursor;
    let count = 0;
    for (let page = 0;; page++) {
      if (page >= 500)
        return unreadable();
      const raw = await bounded(() => client.session.list({ parentID: sessionID, ...cursor ? { cursor } : {} }));
      const envelope = raw;
      const body = envelope?.data ?? raw;
      const list = Array.isArray(body) ? body : Array.isArray(body?.sessions) ? body.sessions : null;
      let next;
      for (const layer of body === raw ? [envelope] : [envelope, body]) {
        if (layer?.truncated || layer?.partial || layer?.error)
          return unreadable();
        if (layer?.cursor === undefined)
          continue;
        const metadata = layer.cursor;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
          return unreadable();
        const token = metadata.next ?? null;
        if (token !== null && (typeof token !== "string" || !token))
          return unreadable();
        if (next !== undefined && next !== token)
          return unreadable();
        next = token;
      }
      if (list === null || (count += list.length) >= 500 || list.some((row) => !row || typeof row.id !== "string" || !row.id))
        return unreadable();
      for (const s of list) {
        const id = s.id;
        if (ids.has(id))
          return unreadable();
        ids.add(id);
        if (s.parentID !== sessionID)
          continue;
        rows2.push({ childID: id, outcome: nativeChildOutcome(s.outcome) });
      }
      if (next == null)
        break;
      if (!list.length || cursors.has(next))
        return unreadable();
      cursors.add(next);
      cursor = next;
    }
    if (rows2.length === 0)
      return { readable: true, inFlight: [], settled: [] };
    if (typeof client?.session?.status !== "function")
      return unreadable();
    const st = await bounded(() => client.session.status());
    const map2 = st?.data;
    if (!map2 || typeof map2 !== "object" || Array.isArray(map2))
      return unreadable();
    const inFlight = [];
    const settled = [];
    for (const row of rows2) {
      if (entryInFlight(map2[row.childID]))
        inFlight.push(row.childID);
      else
        settled.push(row);
    }
    return { readable: true, inFlight, settled };
  } catch {
    return unreadable();
  }
}
async function nativeSessionBusy(client, sessionID) {
  if (!sessionID)
    return null;
  try {
    if (typeof client?.session?.status !== "function")
      return null;
    const st = await client.session.status();
    const map2 = st?.data;
    if (!map2 || typeof map2 !== "object" || Array.isArray(map2))
      return null;
    return entryInFlight(map2[sessionID]);
  } catch {
    return null;
  }
}
function createNativeChildTracker() {
  const children = new Map;
  return {
    mark(childID, parentID) {
      if (!childID || !parentID)
        return;
      const existing = children.get(childID);
      if (existing && existing.terminal)
        return;
      children.set(childID, { childID, parentID, terminal: false });
    },
    terminalize(childID, outcome) {
      const row = children.get(childID);
      if (!row)
        return null;
      if (!row.terminal || row.outcome !== outcome) {
        row.terminal = true;
        row.outcome = outcome;
      }
      let lastChildTerminal = true;
      for (const r of children.values()) {
        if (r.parentID === row.parentID && !r.terminal) {
          lastChildTerminal = false;
          break;
        }
      }
      return { parentID: row.parentID, lastChildTerminal };
    },
    drop(childID) {
      children.delete(childID);
    },
    forgetParent(parentID) {
      for (const [id, row] of [...children]) {
        if (row.parentID === parentID)
          children.delete(id);
      }
    },
    runningChildren(parentID) {
      const ids = [];
      for (const row of children.values()) {
        if (row.parentID === parentID && !row.terminal)
          ids.push(row.childID);
      }
      return ids;
    },
    rows() {
      return children;
    }
  };
}
function nativeChildEventOutcome(type) {
  if (type === "session.execution.succeeded")
    return "succeeded";
  if (type === "session.execution.failed")
    return "failed";
  if (type === "session.execution.interrupted")
    return "interrupted";
  return null;
}
function nativeChildDigestLine(childID, outcome) {
  if (outcome === "interrupted") {
    return `native child ${childID} interrupted — DEAD (aborted mid-run; its dispatch sentence timed out or was killed): re-dispatch the subtask or record the loss in the close report`;
  }
  if (outcome === null) {
    return `native child ${childID} is no longer running but the host reports no outcome for it (deleted mid-run, or its row carries none) — treat the subtask as UNVERIFIED: re-dispatch it or record the loss in the close report`;
  }
  return `native child ${childID} ${outcome}`;
}

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
var READONLY_DISCIPLINE = (agent) => `You are forge-${agent}, a readonly worker: you gather, read, run read-only checks, and REPORT. Your restrictions are the design, not obstacles — do not attempt to work around them; report what you found instead.`;
var WRITE_DISCIPLINE = (agent) => `You are forge-${agent}, a worker executing scoped assignments handed to you through the subagent tool. Do exactly the assigned work, nothing else: no refactoring beyond scope, no unrelated files, no side quests.`;
function materializeAgentPrompt(input) {
  const frame = input.shape === "readonly" ? READONLY_DISCIPLINE(input.agent) : WRITE_DISCIPLINE(input.agent);
  return [frame, "", "Your role:", input.role.trim(), "", WORKER_MANDATES].join(`
`);
}

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
function workerPermissionFor(def) {
  const explicit = def.permission ?? {};
  const permission = {};
  if (Object.hasOwn(explicit, "*"))
    permission["*"] = explicit["*"];
  permission.question = "deny";
  if (def.shape === "readonly") {
    for (const tool3 of MUTATING_TOOLS)
      permission[tool3] = "deny";
    permission.execute = "deny";
  }
  for (const [tool3, effect] of Object.entries(explicit)) {
    if (tool3 !== "*" && tool3 !== "shell" && tool3 !== "bash" && tool3 !== "task" && tool3 !== "subagent" && !PRIMARY_ONLY_WORKER_TOOLS.includes(tool3)) {
      Object.defineProperty(permission, tool3, { value: effect, enumerable: true, writable: true, configurable: true });
    }
  }
  const shell = explicit.shell === "deny" || explicit.bash === "deny" ? "deny" : explicit.shell ?? explicit.bash;
  if (shell !== undefined)
    permission.shell = shell;
  permission.task = "deny";
  permission.subagent = "deny";
  for (const tool3 of PRIMARY_ONLY_WORKER_TOOLS)
    permission[tool3] = "deny";
  return permission;
}
var ROLE_PROMPTS = {
  research: "You are a research worker: search, read, and run read-only checks to answer the assigned question. Report findings as a compact brief with sources and file:line evidence; state plainly what could not be verified.",
  review: "You are a review worker: read the diff or files under review, run read-only checks/tests, and report findings as a prioritized list, each with file:line evidence and a concrete fix suggestion. End with a single-line verdict."
};
function rolePromptFor(agentId, def, shared) {
  const chain = def?.prompt && def.prompt.trim().length > 0 ? def.prompt : ROLE_PROMPTS[agentId] ?? `You are a ${agentId} worker. Execute the assigned work exactly as scoped.`;
  return shared === undefined ? chain : `${shared}

${chain}`;
}
function poolProvenanceLine(provenance) {
  if ("global" in provenance) {
    return `Pool 'global' — origin: the global fallback layer.`;
  }
  return `Pool '${provenance.ns}' — origin ${provenance.file}; dispatchable only from sessions whose workspace pool is this file.`;
}
function agentDescriptionFor(agentId, def, provenance) {
  const shape = def.shape === "readonly" ? "readonly" : "write";
  const brain = def.model !== undefined ? `pinned ${def.model}` : "auto — inherits the parent session's model at dispatch";
  const base = `forge subagent "${agentId}" (${shape}, ${brain}) — dispatch via the subagent tool with agent "forge-${agentId}".`;
  return provenance === undefined ? base : `${base} ${poolProvenanceLine(provenance)}`;
}
function forgeAgentDef(agentId, def, provenance, sharedSeg) {
  const shape = def.shape ?? "write";
  const permission = workerPermissionFor(def);
  const entry = {
    description: agentDescriptionFor(agentId, def, provenance),
    mode: "subagent",
    prompt: materializeAgentPrompt({
      agent: agentId,
      shape,
      role: rolePromptFor(agentId, def, sharedSeg)
    }),
    permission
  };
  if (def.model !== undefined)
    entry.model = def.model;
  return entry;
}
function effectiveReadonlyShape(def) {
  if (def.shape !== "readonly")
    return false;
  const perm = def.permission ?? {};
  for (const t of [...MUTATING_TOOLS, "bash", "shell", "execute"]) {
    const v = perm[t];
    if (v !== undefined && v !== "deny")
      return false;
  }
  return true;
}

// src/dispatch-depth.ts
var META_DEPTHS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
var BUDGET_TIERS = {
  minimal: 1024,
  low: 8192,
  medium: 16384,
  high: 24576,
  xhigh: 28672,
  max: 32768
};
function noMapping(depth, channel, shapeVocabulary) {
  return {
    kind: "no-mapping",
    channel,
    message: `depth "${depth}" has no channel on this shape (${channel} — the endpoint cannot express it). Shape vocabulary: ${shapeVocabulary.join(", ") || "(none)"}. Dictionary words: ${META_DEPTHS.join(", ")}. The plugin never interpolates; fix the pinned thoughtLevel or the model's wire shape.`,
    shapeVocabulary,
    dictionary: [...META_DEPTHS]
  };
}
function ladderWord(ladder, depth) {
  if (ladder === null)
    return null;
  for (const w of ladder)
    if (w.toLowerCase() === depth)
      return w;
  return null;
}
function translateDepth(depth, channel) {
  const d = depth.trim().toLowerCase();
  if (channel.kind === "effort" || channel.kind === "adaptive-effort") {
    const native = channel.kind === "effort" ? ladderWord(channel.ladder, d) : null;
    if (native !== null) {
      return {
        kind: "verbatim",
        channel: channel.kind,
        word: native,
        confirmed: true,
        disclose: `canonical ${d} → native "${native}" (catalog-confirmed)`
      };
    }
    const why = channel.kind === "effort" && channel.ladder !== null ? `catalog ladder does not list "${d}"` : "no catalog ladder for this endpoint";
    return {
      kind: "verbatim",
      channel: channel.kind,
      word: d,
      confirmed: false,
      disclose: `verbatim (unverified — ${why}; the provider judges)`
    };
  }
  if (channel.kind === "toggle") {
    if (d === "none")
      return { kind: "off", channel: "toggle", disclose: "canonical none → native thinking:off" };
    return noMapping(d, "toggle", ["none (thinking on/off only)"]);
  }
  if (d === "none")
    return { kind: "off", channel: "budget", disclose: "canonical none → native thinking:off" };
  const budget = BUDGET_TIERS[d];
  if (budget !== undefined) {
    return { kind: "tiered", channel: "budget", budgetTokens: budget, disclose: `canonical ${d} → native thinking budget:${budget}` };
  }
  return noMapping(d, "budget", ["none", ...Object.keys(BUDGET_TIERS)]);
}
function applyDepthTranslation(options, t) {
  if (t.kind === "verbatim") {
    if (t.channel === "adaptive-effort") {
      options.effort = t.word;
    } else {
      options.reasoningEffort = t.word;
    }
  } else if (t.kind === "tiered") {
    options.thinking = { type: "enabled", budget_tokens: t.budgetTokens };
  } else if (t.kind === "off") {
    options.thinking = { type: "disabled" };
  }
}
function resolvePinnedDepth(thoughtLevel, channel) {
  const t = translateDepth(thoughtLevel, channel);
  if (t.kind === "no-mapping")
    return { translation: null, findingMessage: t.message };
  return { translation: t };
}

// src/forge-config.ts
import { readFileSync as readFileSync3, realpathSync, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute2, relative as relative2 } from "node:path";
function sanitizeJsonc(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  let pendingComma = false;
  const flushComma = (nextChar) => {
    if (pendingComma) {
      if (nextChar !== "}" && nextChar !== "]")
        out.push(",");
      pendingComma = false;
    }
  };
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== `
`) {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(text[i] === "*" && i + 1 < n)) {
        out.push(text[i] === `
` ? `
` : " ");
        i++;
      }
      if (i < n) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (c === '"') {
      flushComma(c);
      out.push(c);
      i++;
      while (i < n && text[i] !== '"') {
        out.push(text[i]);
        if (text[i] === "\\") {
          i++;
          if (i < n)
            out.push(text[i]);
        }
        i++;
      }
      if (i < n) {
        out.push('"');
        i++;
      }
      continue;
    }
    if (c === ",") {
      pendingComma = true;
      out.push(" ");
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === `
` || c === "\r") {
      out.push(c);
      i++;
      continue;
    }
    flushComma(c);
    out.push(c);
    i++;
  }
  return out.join("");
}
function lineColumnAt(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0;i < offset && i < text.length; i++) {
    if (text[i] === `
`) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
function locateJsonError(text) {
  const n = text.length;
  let i = 0;
  const stack = [];
  const ws = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === `
` || text[i] === "\r"))
      i++;
  };
  const fail = (why) => {
    const { line, column } = lineColumnAt(text, Math.min(i, n));
    return { message: `${why} (line ${line}, column ${column})`, line, column };
  };
  const skipString = () => {
    if (text[i] !== '"')
      return null;
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === "\\")
        i++;
      i++;
    }
    if (i >= n)
      return "unterminated string";
    i++;
    return null;
  };
  let expectValue = true;
  ws();
  if (i >= n)
    return { message: "empty document", line: 1, column: 1 };
  for (;; ) {
    ws();
    if (i >= n)
      return stack.length === 0 ? null : fail("unexpected end of document");
    const top = stack[stack.length - 1];
    const c = text[i];
    if (expectValue) {
      if (c === "{") {
        stack.push("o");
        i++;
        expectValue = false;
        continue;
      }
      if (c === "[") {
        stack.push("a");
        i++;
        continue;
      }
      if (c === "}") {
        return fail(`expected a value before '}'`);
      }
      if (c === "]") {
        if (top === "a" || top === "av") {
          stack.pop();
          expectValue = false;
          if (stack.length === 0) {
            ws();
            return i >= n ? null : fail(`unexpected token '${text[i]}' after top-level value`);
          }
          i++;
          continue;
        }
        return fail(`unexpected ']'`);
      }
      if (c === '"') {
        const err = skipString();
        if (err)
          return fail(err);
        expectValue = false;
        if (top === "o")
          stack[stack.length - 1] = "ov";
        if (top === "a")
          stack[stack.length - 1] = "av";
        continue;
      }
      if (c === "-" || c >= "0" && c <= "9" || c === "t" || c === "f" || c === "n") {
        while (i < n && !`{}[],:" 	
\r`.includes(text[i]))
          i++;
        expectValue = false;
        if (top === "a")
          stack[stack.length - 1] = "av";
        continue;
      }
      return fail(`unexpected token '${c}'`);
    }
    if (top === "o") {
      if (c === '"') {
        const err = skipString();
        if (err)
          return fail(err);
        ws();
        if (text[i] !== ":")
          return fail("expected ':' after object key");
        i++;
        expectValue = true;
        continue;
      }
      return fail(`expected '"' or '}' in object, got '${c}'`);
    }
    if (top === "ov" || top === "av") {
      if (c === ",") {
        i++;
        expectValue = true;
        if (top === "ov")
          stack[stack.length - 1] = "o";
        else
          stack[stack.length - 1] = "a";
        continue;
      }
      if (top === "ov" && c === "}" || top === "av" && c === "]") {
        stack.pop();
        if (stack.length === 0) {
          i++;
          ws();
          return i >= n ? null : fail(`unexpected token '${text[i]}' after top-level value`);
        }
        i++;
        continue;
      }
      return fail(`expected ',' or closing bracket, got '${c}'`);
    }
    if (c === "]") {
      stack.pop();
      if (stack.length === 0) {
        i++;
        ws();
        return i >= n ? null : fail(`unexpected token '${text[i]}' after top-level value`);
      }
      i++;
      continue;
    }
    return fail(`unexpected token '${c}'`);
  }
}
function parseForgeJsonc(text) {
  const sanitized = sanitizeJsonc(text);
  let parsed;
  try {
    parsed = JSON.parse(sanitized);
  } catch {
    const located = locateJsonError(sanitized);
    return {
      ok: false,
      error: located ?? { message: "invalid JSON", line: 1, column: 1 }
    };
  }
  return { ok: true, config: parsed };
}
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
function parseMaterializeKnob(v, label) {
  if (v === undefined || v === null)
    return { value: undefined, findings: [] };
  if (v === "native" || v === "runtime")
    return { value: v, findings: [] };
  return {
    value: undefined,
    findings: [{ level: "warn", code: "materialize-invalid", message: `${label}.materialize must be "native" or "runtime" — field ignored (the default applies)` }]
  };
}
function parseSyncKnob(v, label) {
  if (v === undefined || v === null)
    return { auto: false, findings: [] };
  if (v === "auto")
    return { auto: true, findings: [] };
  return {
    auto: false,
    findings: [{ level: "warn", code: "sync-invalid", message: `${label}.sync must be "auto" (the only opt-in) — field ignored; the default posture applies (staleness gate + in-band forge_sync)` }]
  };
}
function legacyRuntimeOptionFindings(top, label, recipe = true) {
  const findings = [];
  for (const key of recipe ? ["jobs", "watchdog", "dispatch"] : ["jobs", "watchdog"]) {
    if (isRecord(top) && Object.prototype.hasOwnProperty.call(top, key)) {
      findings.push({ level: "warn", code: "legacy-runtime-option-in-recipe", message: `${label}: top-level "${key}" configures a retired runtime — ignored` });
    }
  }
  return findings;
}
function legacyDispatchEnvFindings(env) {
  return [
    "DEBUG",
    "JOURNAL_MAX",
    "MAX_ATTEMPTS",
    "NOTIFY_INTERVAL_MS",
    "POLL_INTERVAL_MS",
    "POLL_SLICE_MS",
    "POLL_TIMEOUT_MS",
    "QUEUE_MAX",
    "RECONCILE_FLOOR_MS",
    "RETRY_BACKOFF_MS",
    "STALE_FLOOR_MS",
    "STALE_MODE",
    "STALE_MS"
  ].map((suffix) => `FORGE_DISPATCH_${suffix}`).filter((key) => env[key] !== undefined).map((key) => ({
    level: "warn",
    code: "legacy-dispatch-env",
    message: `${key} configures a retired runtime — ignored`
  }));
}
function parseTopLevelKnobs(top, label) {
  const findings = [];
  const rec = top !== null && typeof top === "object" ? top : {};
  const mat = parseMaterializeKnob(rec.materialize, label);
  findings.push(...mat.findings);
  const sync = parseSyncKnob(rec.sync, label);
  findings.push(...sync.findings);
  return { materialize: mat.value, syncAuto: sync.auto, findings };
}
function forgeConfigPaths(opts) {
  const sep3 = opts.projectDir?.includes("\\") && !opts.projectDir?.includes("/") ? "\\" : "/";
  const project = opts.projectDir ? `${opts.projectDir}${sep3}.opencode${sep3}forge.json` : "";
  const global = opts.homeDir ? `${opts.homeDir}${sep3}.config${sep3}opencode${sep3}forge.json` : "";
  return { project, global };
}
function isFsRoot(p) {
  return p === "" || p === "/" || p === "\\" || /^[A-Za-z]:[\\/]?$/.test(p);
}
function parentDirOf(p) {
  let s = p;
  while (s.endsWith("/") || s.endsWith("\\")) {
    if (isFsRoot(s))
      return null;
    s = s.slice(0, -1);
    if (isFsRoot(s))
      return null;
  }
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0)
    return null;
  const parent = s.slice(0, i + 1);
  return parent === "" ? null : parent;
}
function forgeCandidateAt(dir) {
  const sep3 = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const base = dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}${sep3}`;
  return `${base}.opencode${sep3}forge.json`;
}
function discoverProjectFileWith(stat, anchor) {
  let dir = (anchor ?? "").trim();
  if (!dir)
    return null;
  for (;; ) {
    const candidate = forgeCandidateAt(dir);
    if (stat(candidate) !== null)
      return candidate;
    const parent = parentDirOf(dir);
    if (parent === null || parent === dir)
      return null;
    dir = parent;
  }
}
function recipeFileStat(path) {
  try {
    const root = process.env.FORGE_TEST_FIXTURE_ROOT;
    if (root) {
      const within = (rel) => rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute2(rel);
      if (!within(relative2(root, path)) || !within(relative2(realpathSync(root), realpathSync(path))))
        return null;
    }
    const s = statSync2(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
function createForgeConfigLoader(deps) {
  const stat = deps.stat ?? recipeFileStat;
  const readFile = deps.readFile ?? ((path) => readFileSync3(path, "utf8"));
  const globalPath = forgeConfigPaths({ homeDir: deps.homeDir }).global;
  const cache = new Map;
  const readCandidate = (path, source) => {
    const st = stat(path);
    if (st === null) {
      cache.delete(path);
      return null;
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
      return hit.result;
    const text = readFile(path);
    const parsed = parseForgeJsonc(text);
    let result;
    if (!parsed.ok) {
      result = {
        agents: {},
        source,
        path,
        projectPath: source === "project" ? path : null,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${parsed.error.message}${parsed.error.line !== undefined ? ` (line ${parsed.error.line}, column ${parsed.error.column})` : ""} — this layer contributes no agents until the file parses`
          }
        ]
      };
    } else {
      const top = parsed.config;
      if (top !== undefined && !isRecord(top)) {
        result = {
          agents: {},
          source,
          path,
          projectPath: source === "project" ? path : null,
          findings: [{ level: "error", code: "config-not-object", message: `${path}: top level must be an object — this layer contributes no agents` }]
        };
      } else {
        const validated = validateAgentSet(top === undefined ? undefined : top.agents);
        result = { agents: validated.agents, source, path, projectPath: source === "project" ? path : null, findings: validated.findings };
        result.findings.push(...legacyRuntimeOptionFindings(top, path));
      }
    }
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, result });
    return result;
  };
  return {
    load() {
      const projectPath = discoverProjectFileWith(stat, deps.projectDir ?? "");
      const project = projectPath ? readCandidate(projectPath, "project") : null;
      const global = globalPath ? readCandidate(globalPath, "global") : null;
      if (project && global) {
        return {
          agents: { ...global.agents, ...project.agents },
          source: "project+global",
          path: project.path,
          projectPath: project.path,
          findings: [...global.findings, ...project.findings]
        };
      }
      if (project)
        return { agents: project.agents, source: "project", path: project.path, projectPath: project.path, findings: project.findings };
      if (global)
        return { agents: global.agents, source: "global", path: global.path, projectPath: null, findings: global.findings };
      return { agents: {}, source: "none", path: null, projectPath: null, findings: [] };
    }
  };
}
function sanitizeNamespace(name) {
  const collapsed = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return collapsed || "pool";
}
function validatePoolField(v) {
  if (typeof v !== "string")
    return { ok: false };
  const trimmed = v.trim();
  if (trimmed.length < 1 || trimmed.length > 24 || !/^[a-z0-9-]+$/.test(trimmed))
    return { ok: false };
  return { ok: true, ns: trimmed };
}
function poolFileCompliance(top) {
  const pool = isRecord(top) ? top.pool : undefined;
  if (pool === undefined || pool === null) {
    return { compliant: false, violation: 'missing top-level pool field — declare "pool": "<namespace>" ([a-z0-9-], 1-24 chars) to make this file crew-compliant' };
  }
  if (!validatePoolField(pool).ok) {
    return { compliant: false, violation: `invalid top-level pool field ${JSON.stringify(String(pool))} — expected a string of [a-z0-9-], 1-24 chars after trim` };
  }
  return { compliant: true, violation: "" };
}
function dirBasename(dir) {
  let s = dir;
  while (s.length > 1 && (s.endsWith("/") || s.endsWith("\\")))
    s = s.slice(0, -1);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? s : s.slice(i + 1);
}
function codepointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function createPoolResolver(deps) {
  const stat = deps.stat ?? recipeFileStat;
  const readFile = deps.readFile ?? ((path) => readFileSync3(path, "utf8"));
  const globalPath = forgeConfigPaths({ homeDir: deps.homeDir }).global;
  const fileCache = new Map;
  const readPool = (path) => {
    const st = stat(path);
    if (st === null) {
      fileCache.delete(path);
      return null;
    }
    const hit = fileCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
      return hit.parsed;
    let parsed = null;
    const text = readFile(path);
    const doc2 = parseForgeJsonc(text);
    if (!doc2.ok) {
      parsed = {
        agents: {},
        declaredPool: null,
        shared: null,
        overrides: null,
        findings: [
          {
            level: "error",
            code: "config-parse-error",
            message: `${path}: ${doc2.error.message}${doc2.error.line !== undefined ? ` (line ${doc2.error.line}, column ${doc2.error.column})` : ""} — this pool contributes no agents until the file parses`
          }
        ]
      };
    } else if (doc2.config !== undefined && !isRecord(doc2.config)) {
      parsed = { agents: {}, declaredPool: null, shared: null, overrides: null, findings: [{ level: "error", code: "config-not-object", message: `${path}: top level must be an object — this pool contributes no agents` }] };
    } else {
      const top = doc2.config === undefined ? undefined : doc2.config;
      const validated = validateAgentSet(top === undefined ? undefined : top.agents);
      validated.findings.push(...legacyRuntimeOptionFindings(top, path));
      let overrides = null;
      if (top?.override !== undefined && top.override !== null) {
        if (path === globalPath) {
          const ov = validateOverrideNode(top.override, path);
          validated.findings.push(...ov.findings);
          overrides = ov.overrides;
        } else {
          validated.findings.push({ level: "warn", code: "override-node-ignored-workspace", message: `${path}: the top-level "override" field is GLOBAL-layer-only (workspace pools always compile namespaced as forge-<ns>-<id>) — field ignored` });
        }
      }
      const sharedRaw = top === undefined ? undefined : top.shared;
      let shared = null;
      if (sharedRaw !== undefined && sharedRaw !== null) {
        if (typeof sharedRaw === "string" && sharedRaw.trim().length > 0) {
          shared = sharedRaw.trim();
        } else {
          validated.findings.push({ level: "warn", code: "shared-invalid", message: `${path}: the top-level "shared" field must be a non-empty string — ignored` });
        }
      }
      parsed = { agents: validated.agents, declaredPool: top === undefined ? null : top.pool, shared, overrides, findings: validated.findings };
    }
    fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parsed });
    return parsed;
  };
  const workspacePoolOf = (anchor) => {
    const dir = (anchor ?? "").trim();
    if (!dir)
      return null;
    return discoverProjectFileWith(stat, dir);
  };
  return {
    workspacePoolOf,
    resolve(anchorsInput) {
      const anchors = [];
      for (const a of anchorsInput) {
        const t = (a ?? "").trim();
        if (t && !anchors.includes(t))
          anchors.push(t);
      }
      const findings = [];
      const globalParsed = globalPath ? readPool(globalPath) : null;
      if (globalParsed)
        findings.push(...globalParsed.findings);
      const uniqueFiles = new Set;
      for (const anchor of anchors) {
        const f = workspacePoolOf(anchor);
        if (f)
          uniqueFiles.add(f);
      }
      if (globalPath && globalParsed)
        uniqueFiles.add(globalPath);
      for (const file2 of fileCache.keys()) {
        if (!uniqueFiles.has(file2))
          fileCache.delete(file2);
      }
      const orderedFiles = [...uniqueFiles].sort(codepointCompare);
      const families = [];
      for (const file2 of orderedFiles) {
        const parsed = readPool(file2);
        if (parsed && file2 !== globalPath)
          findings.push(...parsed.findings);
        let declaredPool = null;
        if (parsed) {
          if (file2 === globalPath) {
            if (parsed.declaredPool !== undefined && parsed.declaredPool !== null) {
              findings.push({ level: "warn", code: "pool-field-ignored-global", message: `${file2}: the declared "pool" field ${JSON.stringify(String(parsed.declaredPool))} is ignored — the global fallback namespace is fixed to "global"` });
            }
          } else {
            const v = validatePoolField(parsed.declaredPool);
            if (parsed.declaredPool !== undefined && parsed.declaredPool !== null) {
              if (v.ok) {
                declaredPool = v.ns;
              } else {
                findings.push({ level: "warn", code: "pool-field-invalid", message: `${file2}: invalid "pool" field ${JSON.stringify(String(parsed.declaredPool))} (expected [a-z0-9-], 1-24 chars) — falling back to the directory-derived namespace` });
              }
            }
          }
        }
        families.push({ file: file2, parsed, ns: "", declaredPool, shared: parsed?.shared ?? null });
      }
      const allDeclared = new Set;
      for (const f of families)
        if (f.declaredPool)
          allDeclared.add(f.declaredPool);
      const usedNs = new Map;
      for (const f of families) {
        const base = f.file === globalPath ? "global" : f.declaredPool ?? sanitizeNamespace(dirBasename(parentDirLabel(parentDirLabel(f.file))));
        let ns = base;
        let suffix = 2;
        while ((usedNs.has(ns) || ns !== base && allDeclared.has(ns)) && suffix < 100) {
          ns = `${base}-${suffix++}`;
        }
        const owner = usedNs.get(base);
        if (owner !== undefined && owner !== f.file) {
          findings.push({ level: "error", code: "pool-namespace-collision", message: `namespace "${base}" is already used by ${owner} — ${f.file} materializes under "${ns}" instead` });
        }
        f.ns = ns;
        usedNs.set(ns, f.file);
      }
      const agents = {};
      const origins = [];
      for (const f of families) {
        const own = f.parsed?.agents ?? {};
        const ids = [];
        for (const rawId of Object.keys(own)) {
          const matId = `${f.ns}-${rawId}`;
          const existing = agents[matId];
          if (existing !== undefined) {
            findings.push({ level: "error", code: "materialized-id-collision", message: `materialized agent forge-${matId} from ${f.file} collides with the one from ${existing.file} — the earlier pool in resolution order wins, this agent is skipped` });
            continue;
          }
          agents[matId] = { materializedId: matId, def: own[rawId], ns: f.ns, file: f.file, shared: f.shared };
          ids.push(matId);
        }
        origins.push({ file: f.file, ns: f.ns, declaredPool: f.declaredPool, shared: f.shared, materializedIds: ids });
      }
      return { families: origins, agents, overrides: globalParsed?.overrides ?? {}, findings };
    }
  };
}
function parentDirLabel(filePath) {
  let s = filePath;
  while (s.length > 1 && (s.endsWith("/") || s.endsWith("\\")))
    s = s.slice(0, -1);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? s : s.slice(0, i);
}

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
var GENERATED_MARKER = "<!-- GENERATED BY forge_sync";
function generatedHeader(recipeFile) {
  return `${GENERATED_MARKER} — edit the recipe (${recipeFile}), not this file. -->`;
}
function sameProjection(existing, expected) {
  return existing.replace(/\r\n/g, `
`) === expected.replace(/\r\n/g, `
`);
}
function modelStringFor(def) {
  if (def.model === undefined)
    return;
  if (def.thoughtLevel !== undefined && VARIANT_DEPTH_WORDS.includes(def.thoughtLevel)) {
    return `${def.model}#${def.thoughtLevel}`;
  }
  return def.model;
}
function overrideToolsFaceFor(shape) {
  const face = {};
  face[NATIVE_TOOL_VOCAB.taskKey] = false;
  for (const k of NATIVE_TOOL_VOCAB.legacyShellKeys)
    face[k] = false;
  if (shape === "readonly") {
    for (const t of NATIVE_TOOL_VOCAB.mutatingFamily)
      face[t] = false;
    face[NATIVE_TOOL_VOCAB.shellChannel] = false;
  }
  return face;
}
function toolsFaceFor(shape, permission) {
  const { task: _legacy, ...native } = workerPermissionFor({ shape, permission });
  return native;
}
function frontmatterFor(input) {
  const lines = ["---", `description: ${JSON.stringify(input.description)}`, "mode: subagent"];
  if (input.model !== undefined)
    lines.push(`model: ${JSON.stringify(input.model)}`);
  if (input.tools) {
    lines.push("tools:");
    for (const [k, v] of Object.entries(input.tools))
      lines.push(`  ${k}: ${v}`);
  }
  if (input.permissions) {
    lines.push("permissions:");
    for (const [action, effect] of Object.entries(input.permissions)) {
      lines.push(`  - action: ${JSON.stringify(action)}`, '    resource: "*"', `    effect: ${JSON.stringify(effect)}`);
    }
  }
  lines.push("---");
  return lines.join(`
`);
}
function compileRosterEntry(input) {
  const shape = input.def.shape === "readonly" ? "readonly" : "write";
  const description = agentDescriptionFor(input.matId, input.def, input.provenance);
  const model = modelStringFor(input.def);
  const permissions = toolsFaceFor(shape, input.def.permission);
  const recipeFile = "global" in input.provenance ? "the global fallback layer" : input.provenance.file;
  const body = materializeAgentPrompt({
    agent: input.matId,
    shape,
    role: rolePromptFor(input.matId, input.def, input.shared)
  });
  return {
    fileName: `forge-${input.matId}.md`,
    content: `${frontmatterFor({ description, model, permissions })}

${generatedHeader(recipeFile)}

${body}
`
  };
}
var OVERRIDE_DEFAULT_PROMPTS = {
  general: "You are the user-overridden built-in General subagent. Do the dispatched work directly and report a compact result with evidence.",
  explore: "You are the user-overridden built-in Explore subagent. Search and read the codebase for the dispatched question; report a compact brief with file:line evidence."
};
function compileOverrideEntry(input) {
  if (!BUILTIN_OVERRIDE_IDS.includes(input.id))
    return null;
  const shape = input.def.shape === "readonly" ? "readonly" : "write";
  const description = `Built-in ${input.id} override — pinned by the global forge.json "override" node (${input.def.model !== undefined ? "pinned model" : "Auto worker"}).`;
  const model = modelStringFor(input.def);
  const tools = overrideToolsFaceFor(shape);
  const body = input.def.prompt !== undefined && input.def.prompt.trim().length > 0 ? input.def.prompt : OVERRIDE_DEFAULT_PROMPTS[input.id];
  return {
    fileName: `${input.id}.md`,
    content: `${frontmatterFor({ description, model, tools })}

${generatedHeader(input.recipeFile)}

${body}
`
  };
}
function agentDirFor(poolFile) {
  const sep3 = poolFile.includes("\\") && !poolFile.includes("/") ? "\\" : "/";
  const parts = poolFile.split(/[\\/]/);
  parts.pop();
  const dirName = parts.pop();
  const base = parts.join(sep3);
  return `${base}${sep3}${dirName}${sep3}agent`;
}
function globalAgentDirFor(opts) {
  const cfg = (opts.configDir ?? "").trim();
  if (cfg) {
    const sep4 = cfg.includes("\\") && !cfg.includes("/") ? "\\" : "/";
    return cfg.endsWith(sep4) ? `${cfg}agent` : `${cfg}${sep4}agent`;
  }
  const sep3 = opts.homeDir.includes("\\") && !opts.homeDir.includes("/") ? "\\" : "/";
  const base = opts.homeDir.endsWith(sep3) ? opts.homeDir : `${opts.homeDir}${sep3}`;
  return `${base}.config${sep3}opencode${sep3}agent`;
}
function planOverrideSync(overrides, opts) {
  const files = [];
  for (const id of BUILTIN_OVERRIDE_IDS) {
    const def = overrides[id];
    if (def === undefined)
      continue;
    const compiled = compileOverrideEntry({ id, def, recipeFile: opts.recipeFile });
    if (compiled !== null)
      files.push(compiled);
  }
  return files.length > 0 ? { kind: "override", dir: opts.dir, files } : null;
}
function overrideSyncFindings(plan, deps) {
  const findings = [];
  for (const id of BUILTIN_OVERRIDE_IDS) {
    const name = `${id}.md`;
    const dest = joinPath(plan.dir, name);
    const expected = plan.files.find((file2) => file2.fileName === name);
    try {
      if (deps.stat?.(dest) == null) {
        if (expected)
          findings.push(`missing override artifact: ${dest}`);
        continue;
      }
      const existing = deps.readFile(dest);
      if (!existing.includes(GENERATED_MARKER)) {
        if (expected)
          findings.push(`override collision: hand-written file ${dest}`);
      } else if (!expected || existing !== expected.content) {
        findings.push(`stale generated override: ${dest}`);
      }
    } catch {
      findings.push(`unreadable override artifact: ${dest}`);
    }
  }
  return findings;
}
function provenanceFor(origin, globalPoolFile, platform) {
  const fold = (p) => platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
  return fold(origin.file) === fold(globalPoolFile) ? { global: true } : { ns: origin.ns, file: origin.file };
}
function rosterAgentDirFor(poolFile, opts) {
  return "global" in provenanceFor({ file: poolFile, ns: "" }, opts.globalPoolFile, opts.platform ?? process.platform) ? opts.globalAgentDir ?? agentDirFor(poolFile) : agentDirFor(poolFile);
}
function compileResolvedRosterEntry(resolution, matId, opts) {
  const agent = resolution.agents[matId];
  const provenance = provenanceFor(agent, opts.globalPoolFile, opts.platform ?? process.platform);
  return compileRosterEntry({ matId, def: agent.def, provenance, shared: agent.shared ?? undefined });
}
function planRosterSync(resolution, opts) {
  const plans = [];
  for (const family of resolution.families) {
    const files = family.materializedIds.map((matId) => ({ matId, ...compileResolvedRosterEntry(resolution, matId, opts) }));
    plans.push({ kind: "family", family, dir: rosterAgentDirFor(family.file, opts), files });
  }
  return plans;
}
function joinPath(dir, name) {
  const sep3 = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep3) ? `${dir}${name}` : `${dir}${sep3}${name}`;
}
function executeRosterSync(plans, deps = {}) {
  const stat = deps.stat ?? (() => null);
  const readFile = deps.readFile ?? (() => {
    throw new Error("readFile unavailable");
  });
  const writeFile = deps.writeFile ?? (() => {
    throw new Error("writeFile unavailable");
  });
  const rename = deps.rename ?? (() => {
    throw new Error("rename unavailable");
  });
  const unlink = deps.unlink ?? (() => {
    throw new Error("unlink unavailable");
  });
  const readdir = deps.readdir ?? (() => null);
  const mkdir = deps.mkdir ?? (() => {});
  const out = { created: [], updated: [], unchanged: [], gced: [], errors: [] };
  for (const plan of plans) {
    try {
      mkdir(plan.dir);
    } catch {}
    const wanted = new Set(plan.files.map((f) => f.fileName));
    for (const file2 of plan.files) {
      const dest = joinPath(plan.dir, file2.fileName);
      let tmp = null;
      try {
        const existing = stat(dest) !== null ? readFile(dest) : null;
        if (existing !== null && !existing.includes(GENERATED_MARKER)) {
          out.errors.push(`${dest}: collision refused — a hand-written file of this exact name already exists; sync never overwrites it. Fold your changes into the recipe, or rename/remove the hand-written file.`);
          continue;
        }
        if (existing !== null && (plan.kind === "family" ? sameProjection(existing, file2.content) : existing === file2.content)) {
          out.unchanged.push(dest);
          continue;
        }
        const tempPath = `${dest}.new`;
        if (stat(tempPath) !== null) {
          out.errors.push(`${tempPath}: temporary file already exists; sync leaves it untouched`);
          continue;
        }
        tmp = tempPath;
        writeFile(tmp, file2.content);
        rename(tmp, dest);
        tmp = null;
        if (existing === null)
          out.created.push(dest);
        else
          out.updated.push(dest);
      } catch (err) {
        if (tmp !== null) {
          try {
            unlink(tmp);
          } catch {}
        }
        out.errors.push(`${dest}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const gcEligible = (name) => {
      if (!name.endsWith(".md"))
        return false;
      if (plan.kind === "override")
        return BUILTIN_OVERRIDE_IDS.some((id) => name === `${id}.md`);
      return name.startsWith("forge-");
    };
    try {
      const listing = readdir(plan.dir);
      if (listing !== null) {
        for (const name of listing) {
          if (!gcEligible(name))
            continue;
          if (wanted.has(name))
            continue;
          const dest = joinPath(plan.dir, name);
          try {
            if (!readFile(dest).includes(GENERATED_MARKER))
              continue;
            unlink(dest);
            out.gced.push(dest);
          } catch (err) {
            out.errors.push(`${dest}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch {}
  }
  return out;
}
function staleCheckForPool(poolFile, expectedMatIds, deps = {}, expectedContentOf, artifactDir) {
  if (poolFile === null)
    return { stale: false, reason: "no workspace pool — global-fallback roster, no per-workspace artifacts gate" };
  const stat = deps.stat ?? (() => null);
  const readFile = deps.readFile ?? (() => {
    throw new Error("readFile unavailable");
  });
  const recipe = stat(poolFile);
  const dir = artifactDir ?? agentDirFor(poolFile);
  if (expectedContentOf) {
    const wanted = new Set(expectedMatIds.map((id) => `forge-${id}.md`));
    for (const name of deps.readdir?.(dir) ?? []) {
      if (!name.startsWith("forge-") || !name.endsWith(".md") || wanted.has(name))
        continue;
      try {
        if (readFile(joinPath(dir, name)).includes(GENERATED_MARKER)) {
          return { stale: true, reason: `orphaned generated artifact: ${joinPath(dir, name)} — ${recipe === null ? "recipe missing" : "entry removed from recipe"}` };
        }
      } catch {
        return { stale: true, reason: `artifact ${joinPath(dir, name)} unreadable` };
      }
    }
    if (recipe === null && expectedMatIds.length > 0)
      return { stale: true, reason: `recipe missing: ${poolFile}` };
  }
  if (recipe === null)
    return { stale: false, reason: "recipe file not statable" };
  if (expectedMatIds.length === 0)
    return { stale: false, reason: "recipe contributes no agents" };
  let newest = -Infinity;
  let missing = [];
  for (const matId of expectedMatIds) {
    const st = stat(joinPath(dir, `forge-${matId}.md`));
    if (st === null)
      missing.push(`forge-${matId}.md`);
    else if (st.mtimeMs > newest)
      newest = st.mtimeMs;
  }
  if (missing.length > 0) {
    return { stale: true, reason: `missing artifact(s): ${missing.join(", ")} — the recipe has agents but no compiled file for them` };
  }
  if (expectedContentOf) {
    for (const matId of expectedMatIds) {
      try {
        const existing = readFile(joinPath(dir, `forge-${matId}.md`));
        if (!existing.includes(GENERATED_MARKER)) {
          return { stale: true, reason: `hand-written collision: ${joinPath(dir, `forge-${matId}.md`)} differs from what it compiles to` };
        }
        if (!sameProjection(existing, expectedContentOf(matId))) {
          return { stale: true, reason: `recipe ${poolFile} — the compiled forge-${matId}.md differs from what it compiles to` };
        }
      } catch {
        return { stale: true, reason: `artifact for forge-${matId} unreadable` };
      }
    }
    return { stale: false, reason: "compiled content is current" };
  }
  if (recipe.mtimeMs > newest) {
    return { stale: true, reason: `recipe ${poolFile} is newer (mtime ${recipe.mtimeMs}) than the newest compiled artifact (mtime ${newest})` };
  }
  return { stale: false, reason: "artifacts are at least as new as the recipe" };
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
var nullable2 = (schema) => ({ anyOf: [schema, { type: "null" }] });
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
var obj = (properties, required2) => ({ type: "object", properties, required: required2, additionalProperties: false });
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
    observedLocation: nullable2({ type: "string" }),
    anchor: nullable2({ type: "string" }),
    epoch: { type: "string" },
    generation: { type: "integer" },
    expiresAt: { type: "number" },
    exists: { type: "boolean" },
    readable: { type: "boolean" },
    creatable: { type: "boolean" },
    identity: nullable2(fileIdentitySchema),
    raw: nullable2({ type: "string" }),
    document: { description: "parsed JSONC document (unknown JSON value), or null" },
    parseError: nullable2(parseErrorSchema),
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
  oldText: nullable2({ type: "string" }),
  newText: { type: "string" },
  previewHash: { type: "string", description: "sha256 hex of newText — the canonical token content binding" },
  createFile: { type: "boolean", description: "derived from the edit-start snapshot (absent file), never from the last entry's plan kind" },
  identity: nullable2(fileIdentitySchema),
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
    savedIdentity: nullable2(fileIdentitySchema),
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
  observedLocation: nullable2({ type: "string" }),
  anchor: nullable2({ type: "string" }),
  family: nullable2(obj({ file: { type: "string" }, ns: { type: "string" }, materializedIds: { type: "array", items: { type: "string" } } }, ["file", "ns", "materializedIds"])),
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
                  observedBy: nullable2({ type: "string" }),
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

// src/config-rpc-protocol.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { lstatSync as lstatSync2, realpathSync as realpathSync3 } from "node:fs";

// src/forge-config-edit.ts
import { lstatSync, linkSync, mkdirSync as mkdirSync2, readFileSync as readFileSync4, realpathSync as realpathSync2, renameSync as renameSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, resolve as resolve4 } from "node:path";

// src/jsonc-edit.ts
function skipWsAndComments(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === `
`) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== `
`)
        i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/"))
        i++;
      i = Math.min(i + 2, n);
      continue;
    }
    break;
  }
  return i;
}
function scanStringEnd(text, i) {
  i++;
  const n = text.length;
  while (i < n) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"')
      return i + 1;
    i++;
  }
  return null;
}
function scanLiteralEnd(text, i) {
  const n = text.length;
  while (i < n && !`,{}[]/ 	\r
`.includes(text[i]))
    i++;
  return i;
}
function scanValue(text, i) {
  const start = skipWsAndComments(text, i);
  if (start >= text.length)
    return { ok: false, detail: "unexpected end of document where a value was expected" };
  const c = text[start];
  if (c === '"') {
    const end = scanStringEnd(text, start);
    return end === null ? { ok: false, detail: "unterminated string" } : { ok: true, start, end };
  }
  if (c === "{")
    return scanObject(text, start);
  if (c === "[")
    return scanArray(text, start);
  return { ok: true, start, end: scanLiteralEnd(text, start) };
}
function scanObject(text, i) {
  const start = i;
  const members = [];
  let j = skipWsAndComments(text, i + 1);
  const n = text.length;
  for (;; ) {
    if (j >= n)
      return { ok: false, detail: "unterminated object (missing '}')" };
    if (text[j] === "}")
      return { ok: true, start, end: j + 1, members };
    if (text[j] !== '"')
      return { ok: false, detail: `expected a quoted key in object, found ${JSON.stringify(text[j])}` };
    const keyStart = j;
    const keyEnd = scanStringEnd(text, j);
    if (keyEnd === null)
      return { ok: false, detail: "unterminated string (object key)" };
    let key;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return { ok: false, detail: "invalid object key encoding" };
    }
    j = skipWsAndComments(text, keyEnd);
    if (j >= n || text[j] !== ":")
      return { ok: false, detail: "expected ':' after object key" };
    const value = scanValue(text, j + 1);
    if (!value.ok)
      return value;
    members.push({ key, keyStart, valueStart: value.start, valueEnd: value.end });
    j = skipWsAndComments(text, value.end);
    if (j >= n)
      return { ok: false, detail: "unterminated object (missing '}')" };
    if (text[j] === ",") {
      j = skipWsAndComments(text, j + 1);
      continue;
    }
    if (text[j] === "}")
      return { ok: true, start, end: j + 1, members };
    return { ok: false, detail: `expected ',' or '}' in object, found ${JSON.stringify(text[j])}` };
  }
}
function scanArray(text, i) {
  const start = i;
  let j = skipWsAndComments(text, i + 1);
  const n = text.length;
  for (;; ) {
    if (j >= n)
      return { ok: false, detail: "unterminated array (missing ']')" };
    if (text[j] === "]")
      return { ok: true, start, end: j + 1 };
    const value = scanValue(text, j);
    if (!value.ok)
      return value;
    j = skipWsAndComments(text, value.end);
    if (j >= n)
      return { ok: false, detail: "unterminated array (missing ']')" };
    if (text[j] === ",") {
      j = skipWsAndComments(text, j + 1);
      continue;
    }
    if (text[j] === "]")
      return { ok: true, start, end: j + 1 };
    return { ok: false, detail: `expected ',' or ']' in array, found ${JSON.stringify(text[j])}` };
  }
}
function scanTopLevelKeys(text) {
  const i = skipWsAndComments(text, 0);
  if (i >= text.length)
    return { ok: false, reason: "unparseable", detail: "empty document" };
  if (text[i] !== "{")
    return { ok: false, reason: "unparseable", detail: "top level must be an object" };
  const obj2 = scanObject(text, i);
  if (!obj2.ok)
    return { ok: false, reason: "unparseable", detail: obj2.detail };
  const after = skipWsAndComments(text, obj2.end);
  if (after < text.length)
    return { ok: false, reason: "unparseable", detail: "unexpected content after the top-level object" };
  return { ok: true, top: obj2.members.map((m) => ({ key: m.key, value: { start: m.valueStart, end: m.valueEnd } })) };
}
function locateEntry(text, container, entryKey) {
  const top = scanTopLevelKeys(text);
  if (!top.ok)
    return top;
  const containers = top.top.filter((m2) => m2.key === container);
  if (containers.length === 0)
    return { ok: false, reason: "container-missing", detail: `no top-level "${container}" object in this document` };
  if (containers.length > 1)
    return { ok: false, reason: "ambiguous", detail: `top-level "${container}" is defined ${containers.length} times — the edit target is ambiguous` };
  const range = containers[0].value;
  if (text[skipWsAndComments(text, range.start)] !== "{")
    return { ok: false, reason: "container-not-object", detail: `top-level "${container}" is not an object` };
  const obj2 = scanObject(text, range.start);
  if (!obj2.ok)
    return { ok: false, reason: "unparseable", detail: obj2.detail };
  const entries = obj2.members.filter((m2) => m2.key === entryKey);
  if (entries.length === 0)
    return { ok: false, reason: "not-found", detail: `"${container}" has no entry "${entryKey}"` };
  if (entries.length > 1)
    return { ok: false, reason: "ambiguous", detail: `"${container}.${entryKey}" is defined ${entries.length} times — the edit target is ambiguous` };
  const m = entries[0];
  return { ok: true, entry: { start: m.valueStart, end: m.valueEnd }, container: { start: range.start, end: range.end }, member: { start: m.keyStart, end: m.valueEnd } };
}
function objectFields(text, range) {
  if (text[skipWsAndComments(text, range.start)] !== "{")
    return { ok: false, reason: "container-not-object", detail: "the target is not an object" };
  const obj2 = scanObject(text, range.start);
  if (!obj2.ok)
    return { ok: false, reason: "unparseable", detail: obj2.detail };
  return {
    ok: true,
    fields: obj2.members.map((m) => ({ key: m.key, member: { start: m.keyStart, end: m.valueEnd }, value: { start: m.valueStart, end: m.valueEnd } }))
  };
}
function detectEol(text) {
  return text.includes(`\r
`) ? `\r
` : `
`;
}
function indentFor(text, pos, fallback = "  ") {
  let i = pos;
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t"))
    i--;
  if (i === 0)
    return fallback;
  const prev = text[i - 1];
  if (prev === `
` || prev === "\r")
    return text.slice(i, pos) || fallback;
  return fallback;
}
function memberLineStart(text, member) {
  let i = member.start;
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t"))
    i--;
  const ownsLine = i > 0 && (text[i - 1] === `
` || text[i - 1] === "\r");
  return { start: ownsLine ? i : member.start, ownsLine };
}
function removeMemberSlice(text, member) {
  const line = memberLineStart(text, member);
  const start = line.start;
  const j = skipWsAndComments(text, member.end);
  if (j < text.length && text[j] === ",") {
    return `${text.slice(0, start)}${text.slice(member.end, j)}${text.slice(j + 1)}`;
  }
  let end = member.end;
  while (end < text.length && (text[end] === " " || text[end] === "\t"))
    end++;
  if (line.ownsLine && text[end] === "\r" && text[end + 1] === `
`)
    end += 2;
  else if (line.ownsLine && text[end] === `
`)
    end += 1;
  let k = start - 1;
  while (k >= 0 && (text[k] === " " || text[k] === "\t" || text[k] === "\r" || text[k] === `
`))
    k--;
  if (k >= 0 && text[k] === ",")
    return `${text.slice(0, k)}${text.slice(end)}`;
  return `${text.slice(0, start)}${text.slice(end)}`;
}
function insertField(text, range, key, valueJson) {
  if (text[skipWsAndComments(text, range.start)] !== "{")
    return { ok: false, reason: "container-not-object", detail: "the target is not an object" };
  const obj2 = scanObject(text, range.start);
  if (!obj2.ok)
    return { ok: false, reason: "unparseable", detail: obj2.detail };
  if (obj2.members.some((m) => m.key === key))
    return { ok: false, reason: "ambiguous", detail: `"${key}" already exists — insert refused` };
  const eol = detectEol(text);
  const keyJson = JSON.stringify(key);
  if (obj2.members.length > 0) {
    const indent = indentFor(text, obj2.members[0].keyStart);
    const at = obj2.members[obj2.members.length - 1].valueEnd;
    return { ok: true, text: `${text.slice(0, at)},${eol}${indent}${keyJson}: ${valueJson}${text.slice(at)}` };
  }
  const close = range.end - 1;
  const inner = text.slice(range.start + 1, close);
  if (inner.includes(`
`)) {
    const memberIndent = `${indentFor(text, close, "")}  `;
    return { ok: true, text: `${text.slice(0, close)}${memberIndent}${keyJson}: ${valueJson}${text.slice(close)}` };
  }
  return { ok: true, text: `${text.slice(0, close)}${keyJson}: ${valueJson}${text.slice(close)}` };
}
function replaceFieldValue(text, value, replacementJson) {
  return { ok: true, text: `${text.slice(0, value.start)}${replacementJson}${text.slice(value.end)}` };
}
function removeField(text, member) {
  return { ok: true, text: removeMemberSlice(text, member) };
}
function insertEntry(text, containerKey, entryKey, entryJson, opts) {
  const top = scanTopLevelKeys(text);
  if (!top.ok)
    return top;
  const containers = top.top.filter((m) => m.key === containerKey);
  if (containers.length > 1)
    return { ok: false, reason: "ambiguous", detail: `top-level "${containerKey}" is defined ${containers.length} times — the edit target is ambiguous` };
  if (containers.length === 1) {
    const range = containers[0].value;
    if (text[skipWsAndComments(text, range.start)] !== "{")
      return { ok: false, reason: "container-not-object", detail: `top-level "${containerKey}" is not an object` };
    const obj3 = scanObject(text, range.start);
    if (!obj3.ok)
      return { ok: false, reason: "unparseable", detail: obj3.detail };
    if (obj3.members.some((m) => m.key === entryKey))
      return { ok: false, reason: "ambiguous", detail: `"${containerKey}.${entryKey}" already exists — create refused` };
    return insertField(text, range, entryKey, entryJson);
  }
  if (opts?.createContainer === false)
    return { ok: false, reason: "container-missing", detail: `no top-level "${containerKey}" object in this document` };
  const eol = detectEol(text);
  const containerJson = `{${JSON.stringify(entryKey)}: ${entryJson}}`;
  const containerKeyJson = JSON.stringify(containerKey);
  if (top.top.length > 0) {
    const indent = indentFor(text, firstMemberKeyStart(text));
    const at = top.top[top.top.length - 1].value.end;
    return { ok: true, text: `${text.slice(0, at)},${eol}${indent}${containerKeyJson}: ${containerJson}${text.slice(at)}` };
  }
  const obj2 = scanObject(text, skipWsAndComments(text, 0));
  if (!obj2.ok)
    return { ok: false, reason: "unparseable", detail: obj2.detail };
  const close = obj2.end - 1;
  return { ok: true, text: `${text.slice(0, close)}${containerKeyJson}: ${containerJson}${text.slice(close)}` };
}
function firstMemberKeyStart(text) {
  const obj2 = scanObject(text, skipWsAndComments(text, 0));
  return obj2.ok && obj2.members.length > 0 ? obj2.members[0].keyStart : 0;
}
function removeEntry(text, container, entryKey) {
  const loc = locateEntry(text, container, entryKey);
  if (!loc.ok)
    return loc;
  return { ok: true, text: removeMemberSlice(text, loc.member) };
}

// src/file-identity.ts
import { statSync as statSync3 } from "node:fs";

class UnsafeIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeIdentityError";
  }
}
function isUnsafeIdentityError(err) {
  return err instanceof UnsafeIdentityError;
}
var CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
function canonicalIdComponent(value, label) {
  if (value === undefined)
    return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UnsafeIdentityError(`${label} ${String(value)} is not a non-negative safe integer — refusing the identity`);
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new UnsafeIdentityError(`${label} must be a non-negative decimal string or a safe integer, got ${typeof value} — refusing the identity`);
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new UnsafeIdentityError(`${label} must be a non-negative decimal string, got ${JSON.stringify(value)}`);
  }
  if (!CANONICAL_DECIMAL.test(value))
    return BigInt(value).toString();
  return value;
}
function normalizeFileIdentity(id) {
  if (typeof id.mtimeMs !== "number" || !Number.isFinite(id.mtimeMs)) {
    throw new UnsafeIdentityError(`mtimeMs ${String(id.mtimeMs)} is not a finite number — refusing the identity`);
  }
  if (typeof id.size !== "number" || !Number.isSafeInteger(id.size) || id.size < 0) {
    throw new UnsafeIdentityError(`size ${String(id.size)} is not a non-negative safe integer — refusing the identity`);
  }
  return {
    mtimeMs: id.mtimeMs,
    size: id.size,
    dev: canonicalIdComponent(id.dev, "dev"),
    ino: canonicalIdComponent(id.ino, "ino")
  };
}
function safeBigintNumber(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new UnsafeIdentityError(`${label} ${value.toString()} is not a non-negative safe integer — refusing the identity`);
  }
  return n;
}
function identityFromBigintStats(st) {
  const mtimeNs = st.mtimeNs;
  const seconds = mtimeNs / 1000000000n;
  const nanos = mtimeNs % 1000000000n;
  return normalizeFileIdentity({
    mtimeMs: Number(seconds) * 1000 + Number(nanos) / 1e6,
    size: safeBigintNumber(st.size, "size"),
    dev: st.dev.toString(),
    ino: st.ino.toString()
  });
}
function defaultIdentityStat(path) {
  let st;
  try {
    st = statSync3(path, { bigint: true });
  } catch {
    return null;
  }
  return identityFromBigintStats(st);
}
function identityMatches(a, b) {
  if (a.mtimeMs !== b.mtimeMs || a.size !== b.size)
    return false;
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined && (a.dev !== b.dev || a.ino !== b.ino))
    return false;
  return true;
}

// src/forge-config-edit.ts
var UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function defaultReadFile(path) {
  return UTF8_STRICT.decode(readFileSync4(path));
}
function strictDecode(bytes) {
  if (typeof bytes === "string") {
    for (const ch of bytes) {
      const cp = ch.codePointAt(0);
      if (cp >= 55296 && cp <= 57343)
        throw new Error("invalid UTF-8 content: lone surrogate (lossy decode) detected");
    }
    return bytes;
  }
  if (bytes instanceof Uint8Array)
    return UTF8_STRICT.decode(bytes);
  return UTF8_STRICT.decode(Buffer.from(bytes));
}
function snapshotRecipe(deps) {
  const stat = deps.stat ?? defaultIdentityStat;
  const readFile = deps.readFile ?? defaultReadFile;
  const rawStat = stat(deps.path);
  const st = rawStat === null ? null : normalizeFileIdentity(rawStat);
  if (st === null) {
    return { path: deps.path, exists: false, readable: false, raw: null, stat: null, parse: null };
  }
  let raw = null;
  try {
    raw = strictDecode(readFile(deps.path));
  } catch {
    return { path: deps.path, exists: true, readable: false, raw: null, stat: st, parse: null };
  }
  const parsed = parseForgeJsonc(raw);
  const parse6 = parsed.ok ? { ok: true, value: parsed.config } : { ok: false, message: `${parsed.error.message}${parsed.error.line !== undefined ? ` (line ${parsed.error.line}, column ${parsed.error.column})` : ""}` };
  return { path: deps.path, exists: true, readable: true, raw, stat: st, parse: parse6 };
}
var EDITABLE_FIELDS = ["model", "thoughtLevel", "prompt", "shape", "permission"];
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
  const check2 = validatedDefOf(normalizedId, draft);
  return { ok: check2.ok, findings: [...findings, ...shapeFindings, ...check2.findings], normalizedId };
}
function validateOverrideDraft(id, draft) {
  if (!BUILTIN_OVERRIDE_IDS.includes(id)) {
    return { ok: false, findings: [{ level: "error", code: "override-id-unknown", message: `override ids are exactly ${BUILTIN_OVERRIDE_IDS.map((i) => `"${i}"`).join(", ")} (lowercase, case-sensitive) — "${id}" is not a built-in subagent id (a forge- prefix never normalizes into an override id)` }], normalizedId: id };
  }
  const shapeFindings = validateDraftShape(draft);
  if (shapeFindings.some((f) => f.level === "error")) {
    return { ok: false, findings: shapeFindings, normalizedId: id };
  }
  const check2 = validatedDefOf(id, draft);
  return { ok: check2.ok, findings: check2.findings, normalizedId: id };
}
var planErr = (reason, message, findings = []) => ({ ok: false, reason, message, detail: message, findings });
function foldJsoncReason(reason) {
  if (reason === "container-missing")
    return "not-found";
  if (reason === "container-not-object")
    return "unparseable";
  return reason;
}
function deepEqual(a, b) {
  if (a === b)
    return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return false;
  if (Array.isArray(a) !== Array.isArray(b))
    return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length)
    return false;
  return ka.every((k) => (k in b) && deepEqual(a[k], b[k]));
}
function patchEntryFields(raw, container, id, setFields, removeFields) {
  let working = raw;
  const summary = [];
  for (const key of EDITABLE_FIELDS) {
    const want = setFields[key];
    const shouldRemove = removeFields.includes(key);
    if (want === undefined && !shouldRemove)
      continue;
    if (key === "permission" && want !== undefined && typeof want === "object" && want !== null && !Array.isArray(want)) {
      const patched = patchPermissionSubKeys(working, container, id, want);
      if (!patched.ok)
        return patched;
      if (patched.subPatched) {
        working = patched.text;
        summary.push(...patched.notes);
        continue;
      }
    }
    const loc = locateEntry(working, container, id);
    if (!loc.ok)
      return { ok: false, message: `entry became unlocatable mid-plan: ${loc.detail}` };
    const fields = objectFields(working, loc.entry);
    if (!fields.ok)
      return { ok: false, message: `the "${container}.${id}" entry is not an object — refusing a field-level edit` };
    const matches = fields.fields.filter((f) => f.key === key);
    if (matches.length > 1) {
      return { ok: false, message: `"${container}.${id}.${key}" is defined ${matches.length} times — ambiguous edit target, refusing` };
    }
    const have = matches[0];
    if (want !== undefined) {
      const wantJson = JSON.stringify(want);
      if (have !== undefined) {
        const currentText = working.slice(have.value.start, have.value.end);
        const current = parseForgeJsonc(currentText);
        if (current.ok && deepEqual(current.config, want))
          continue;
        if ((key === "model" || key === "thoughtLevel") && current.ok && typeof current.config === "string" && typeof want === "string") {
          const haveNorm = key === "model" ? current.config.trim() : current.config.trim().toLowerCase();
          const wantNorm = key === "model" ? want.trim() : want.trim().toLowerCase();
          if (haveNorm === wantNorm)
            continue;
        }
        const replaced = replaceFieldValue(working, have.value, wantJson);
        working = replaced.text;
        summary.push(`set ${id}.${key} = ${wantJson}`);
      } else {
        const inserted = insertField(working, loc.entry, key, wantJson);
        if (!inserted.ok)
          return { ok: false, message: `could not add ${id}.${key}: ${inserted.detail}` };
        working = inserted.text;
        summary.push(`add ${id}.${key} = ${wantJson}`);
      }
    } else if (shouldRemove && have !== undefined) {
      const removed = removeField(working, have.member);
      working = removed.text;
      summary.push(`remove ${id}.${key}`);
    }
  }
  return { ok: true, text: working, summary };
}
function patchPermissionSubKeys(raw, container, id, want) {
  let working = raw;
  const notes = [];
  const currentMapOf = (text) => {
    const loc = locateEntry(text, container, id);
    if (!loc.ok)
      return { ok: false, message: `entry became unlocatable mid-plan: ${loc.detail}` };
    const fields = objectFields(text, loc.entry);
    if (!fields.ok)
      return { ok: false, message: `the "${container}.${id}" entry is not an object — refusing a field-level edit` };
    const perms = fields.fields.filter((f) => f.key === "permission");
    if (perms.length === 0)
      return { ok: true, map: {} };
    if (perms.length > 1)
      return { ok: false, message: `"${container}.${id}.permission" is defined ${perms.length} times — ambiguous edit target, refusing` };
    const parsed = parseForgeJsonc(text.slice(perms[0].value.start, perms[0].value.end));
    if (!parsed.ok || typeof parsed.config !== "object" || parsed.config === null || Array.isArray(parsed.config)) {
      return { ok: false, message: "not-a-map" };
    }
    return { ok: true, map: parsed.config };
  };
  const first = currentMapOf(working);
  if (!first.ok && first.message !== "not-a-map")
    return first;
  if (!first.ok)
    return { ok: true, text: raw, notes: [], subPatched: false };
  for (const subKey of Object.keys(first.map)) {
    if (subKey in want)
      continue;
    const r = permissionSubKeyOp(working, container, id, subKey, null);
    if (!r.ok)
      return r;
    working = r.text;
    if (r.changed)
      notes.push(`remove ${id}.permission.${subKey}`);
  }
  for (const [subKey, value] of Object.entries(want)) {
    const r = permissionSubKeyOp(working, container, id, subKey, value);
    if (!r.ok)
      return r;
    working = r.text;
    if (r.changed)
      notes.push(`set ${id}.permission.${subKey} = ${JSON.stringify(value)}`);
  }
  return { ok: true, text: working, notes, subPatched: true };
}
function permissionSubKeyOp(raw, container, id, subKey, value) {
  const loc = locateEntry(raw, container, id);
  if (!loc.ok)
    return { ok: false, message: `entry became unlocatable mid-plan: ${loc.detail}` };
  const fields = objectFields(raw, loc.entry);
  if (!fields.ok)
    return { ok: false, message: `the "${container}.${id}" entry is not an object — refusing a field-level edit` };
  const perms = fields.fields.filter((f) => f.key === "permission");
  if (perms.length === 0) {
    if (value === null)
      return { ok: true, text: raw, changed: false };
    const mapJson = `{${JSON.stringify(subKey)}: ${JSON.stringify(value)}}`;
    const inserted2 = insertField(raw, loc.entry, "permission", mapJson);
    if (!inserted2.ok)
      return { ok: false, message: `could not add ${id}.permission: ${inserted2.detail}` };
    return { ok: true, text: inserted2.text, changed: true };
  }
  if (perms.length > 1)
    return { ok: false, message: `"${container}.${id}.permission" is defined ${perms.length} times — ambiguous edit target, refusing` };
  const mapRange = perms[0].value;
  const parsed = parseForgeJsonc(raw.slice(mapRange.start, mapRange.end));
  if (!parsed.ok || typeof parsed.config !== "object" || parsed.config === null || Array.isArray(parsed.config)) {
    return { ok: false, message: `"${container}.${id}.permission" is not a map — refusing a sub-key edit` };
  }
  const sub = objectFields(raw, mapRange);
  if (!sub.ok)
    return { ok: false, message: sub.detail };
  const hits = sub.fields.filter((f) => f.key === subKey);
  if (hits.length > 1)
    return { ok: false, message: `"${container}.${id}.permission.${subKey}" is defined ${hits.length} times — ambiguous edit target, refusing` };
  const have = hits[0];
  if (value === null) {
    if (have === undefined)
      return { ok: true, text: raw, changed: false };
    const removed = removeField(raw, have.member);
    return { ok: true, text: removed.text, changed: true };
  }
  const wantJson = JSON.stringify(value);
  if (have !== undefined) {
    const current = parseForgeJsonc(raw.slice(have.value.start, have.value.end));
    if (current.ok && deepEqual(current.config, value))
      return { ok: true, text: raw, changed: false };
    const replaced = replaceFieldValue(raw, have.value, wantJson);
    return { ok: true, text: replaced.text, changed: true };
  }
  const inserted = insertField(raw, mapRange, subKey, wantJson);
  if (!inserted.ok)
    return { ok: false, message: `could not add ${id}.permission.${subKey}: ${inserted.detail}` };
  return { ok: true, text: inserted.text, changed: true };
}
function buildInitialFile(opts) {
  const lines = ["{"];
  if (opts.pool !== undefined) {
    lines.push(`  "pool": ${JSON.stringify(opts.pool)},`);
  }
  lines.push(`  "${opts.container}": {`);
  lines.push(`    ${JSON.stringify(opts.id)}: ${opts.entryJson}`);
  lines.push("  }");
  lines.push("}");
  return `${lines.join(`
`)}
`;
}
function entryJsonOf(def) {
  const ordered = {};
  for (const key of EDITABLE_FIELDS) {
    if (def[key] !== undefined)
      ordered[key] = def[key];
  }
  return JSON.stringify(ordered);
}
function existingEntryIds(raw, container) {
  const top = scanTopLevelKeys(raw);
  if (!top.ok)
    return { ok: false, message: top.detail };
  const found = top.top.find((m) => m.key === container);
  if (!found)
    return { ok: true, ids: [] };
  const fields = objectFields(raw, found.value);
  if (!fields.ok)
    return { ok: false, message: fields.detail };
  return { ok: true, ids: fields.fields.map((f) => f.key) };
}
function patchInputsOf(draft, def) {
  const setFields = {};
  const removeFields = [];
  if (draft.mode === "pinned") {
    setFields.model = def.model;
    setFields.thoughtLevel = def.thoughtLevel;
  } else {
    removeFields.push("model", "thoughtLevel");
  }
  if (draft.prompt !== undefined)
    setFields.prompt = def.prompt;
  if (draft.shape !== undefined)
    setFields.shape = def.shape;
  if (draft.permission !== undefined)
    setFields.permission = def.permission;
  return { setFields, removeFields };
}
function planEntryEdit(snapshot, op, opts, container, kind) {
  const findings = [];
  if (op.renameTo !== undefined && op.renameTo !== op.id) {
    return planErr("invalid-id", "renaming an existing entry id is not supported — create the new id explicitly and delete the old one", findings);
  }
  if (kind === "override") {
    if (!BUILTIN_OVERRIDE_IDS.includes(op.id)) {
      if (opts.scope === "workspace")
        return planErr("invalid-scope", "override entries live only on the GLOBAL recipe (~/.config/opencode/forge.json) — a workspace pool file may not carry them", findings);
      return planErr("invalid-id", `override ids are exactly ${BUILTIN_OVERRIDE_IDS.map((i) => `"${i}"`).join(", ")} (lowercase, case-sensitive) — "${op.id}" is not a built-in subagent id (a forge- prefix never normalizes into an override id)`, findings);
    }
    if (opts.scope === "workspace") {
      return planErr("invalid-scope", "override entries live only on the GLOBAL recipe (~/.config/opencode/forge.json) — a workspace pool file may not carry them", findings);
    }
  }
  if (!snapshot.exists) {
    if (op.action !== "create") {
      return planErr("not-found", `no recipe file at ${snapshot.path} — nothing to ${op.action}`, findings);
    }
    const wantsPool = kind === "worker" && opts.scope !== "global";
    if (wantsPool && opts.pool === undefined) {
      return planErr("invalid-pool", "creating a workspace pool file requires a valid declared pool name ([a-z0-9-], 1-24 chars) — pass opts.pool", findings);
    }
    if (wantsPool && !validatePoolField(opts.pool).ok) {
      return planErr("invalid-pool", `"${String(opts.pool)}" is not a valid pool namespace ([a-z0-9-], 1-24 chars after trim)`, findings);
    }
    const validate = kind === "worker" ? validateWorkerDraft(op.id, op.draft ?? { mode: "auto" }, []) : validateOverrideDraft(op.id, op.draft ?? { mode: "auto" });
    findings.push(...validate.findings);
    if (!validate.ok) {
      const isId = validate.findings.some((f) => f.level === "error" && (f.code === "agent-id-invalid" || f.code === "agent-id-collision" || f.code === "override-id-unknown"));
      return planErr(isId ? "invalid-id" : "invalid-draft", validate.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings);
    }
    const check3 = validatedDefOf(validate.normalizedId, op.draft ?? { mode: "auto" });
    const content = buildInitialFile({ pool: wantsPool ? opts.pool : undefined, container, id: validate.normalizedId, entryJson: entryJsonOf(check3.def) });
    if (!parseForgeJsonc(content).ok) {
      return planErr("unparseable", "the initial document this plan produces does not parse — refusing", findings);
    }
    if (kind === "worker" && wantsPool) {
      findings.push({ level: "warn", code: "tui-fallback-replaced", message: `creating "${validate.normalizedId}" in this workspace pool replaces the global fallback for this roster` });
    }
    return {
      ok: true,
      plan: {
        kind: "create-file",
        action: "create",
        path: snapshot.path,
        container,
        id: validate.normalizedId,
        newText: content,
        summary: [`create ${container}.${validate.normalizedId} in ${snapshot.path}${wantsPool ? ` (pool "${opts.pool}")` : " (global)"}`]
      },
      findings
    };
  }
  if (snapshot.raw === null) {
    return planErr("unreadable", `the recipe at ${snapshot.path} exists but cannot be read (unreadable bytes or invalid UTF-8) — refusing every edit, including creation`, findings);
  }
  const raw = snapshot.raw;
  const parse6 = snapshot.parse;
  if (parse6 === null || !parse6.ok) {
    const detail = parse6 && !parse6.ok ? parse6.message : "unparseable document";
    return planErr("unparseable", `${snapshot.path}: ${detail} — broken documents are never edited in place; fix the syntax first`, findings);
  }
  if (parse6.value === null || typeof parse6.value !== "object" || Array.isArray(parse6.value)) {
    return planErr("unparseable", `${snapshot.path}: top level must be an object — refusing to edit`, findings);
  }
  if (kind === "worker") {
    if (op.action === "create") {
      const existing = existingEntryIds(raw, container);
      if (!existing.ok)
        return planErr("unparseable", existing.message, findings);
      const validate2 = validateWorkerDraft(op.id, op.draft ?? { mode: "auto" }, existing.ids);
      findings.push(...validate2.findings);
      if (!validate2.ok) {
        const isDup = validate2.findings.some((f) => f.code === "agent-id-collision");
        const isId = validate2.findings.some((f) => f.code === "agent-id-invalid");
        return planErr(isDup ? "duplicate" : isId ? "invalid-id" : "invalid-draft", validate2.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings);
      }
      const check4 = validatedDefOf(validate2.normalizedId, op.draft ?? { mode: "auto" });
      const inserted = insertEntry(raw, container, validate2.normalizedId, entryJsonOf(check4.def), { createContainer: true });
      if (!inserted.ok)
        return planErr(inserted.reason === "ambiguous" ? "duplicate" : foldJsoncReason(inserted.reason), inserted.detail, findings);
      if (!parseForgeJsonc(inserted.text).ok)
        return planErr("unparseable", "the patched document does not parse — refusing", findings);
      if (opts.scope !== "global") {
        findings.push({ level: "warn", code: "tui-fallback-replaced", message: `creating "${validate2.normalizedId}" in this workspace pool replaces the global fallback for this roster` });
      }
      return {
        ok: true,
        plan: {
          kind: "patch",
          action: "create",
          path: snapshot.path,
          container,
          id: validate2.normalizedId,
          newText: inserted.text,
          summary: [`create ${container}.${validate2.normalizedId} in ${snapshot.path}`]
        },
        findings
      };
    }
    const loc2 = locateEntry(raw, container, op.id);
    if (!loc2.ok)
      return planErr(foldJsoncReason(loc2.reason), `${container}.${op.id}: ${loc2.detail}`, findings);
    if (op.action === "delete") {
      const removed = removeEntry(raw, container, op.id);
      if (!removed.ok)
        return planErr(foldJsoncReason(removed.reason), removed.detail, findings);
      if (!parseForgeJsonc(removed.text).ok)
        return planErr("unparseable", "the patched document does not parse — refusing", findings);
      return {
        ok: true,
        plan: {
          kind: "remove",
          action: "delete",
          path: snapshot.path,
          container,
          id: op.id,
          newText: removed.text,
          summary: [`delete ${container}.${op.id} from ${snapshot.path}`]
        },
        findings
      };
    }
    const validate = validateWorkerDraft(op.id, op.draft ?? { mode: "auto" }, []);
    findings.push(...validate.findings);
    if (!validate.ok) {
      return planErr("invalid-draft", validate.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings);
    }
    const check3 = validatedDefOf(op.id, op.draft ?? { mode: "auto" });
    const { setFields: setFields2, removeFields: removeFields2 } = patchInputsOf(op.draft ?? { mode: "auto" }, check3.def);
    const patched2 = patchEntryFields(raw, container, op.id, setFields2, removeFields2);
    if (!patched2.ok)
      return planErr("ambiguous", patched2.message, findings);
    if (!parseForgeJsonc(patched2.text).ok)
      return planErr("unparseable", "the patched document does not parse — refusing", findings);
    if (patched2.text === raw) {
      return {
        ok: true,
        plan: { kind: "no-op", action: "update", path: snapshot.path, container, id: op.id, newText: raw, summary: ["no field changes"] },
        findings
      };
    }
    return {
      ok: true,
      plan: {
        kind: "patch",
        action: "update",
        path: snapshot.path,
        container,
        id: op.id,
        newText: patched2.text,
        summary: patched2.summary
      },
      findings
    };
  }
  const validateOverride = validateOverrideDraft(op.id, op.draft ?? { mode: "auto" });
  findings.push(...validateOverride.findings);
  if (!validateOverride.ok) {
    return planErr("invalid-draft", validateOverride.findings.filter((f) => f.level === "error").map((f) => f.message).join("; "), findings);
  }
  if (op.action === "create") {
    const existing = existingEntryIds(raw, container);
    if (!existing.ok)
      return planErr("unparseable", existing.message, findings);
    const normalizedExisting = new Set(existing.ids.map((k) => normalizeWorkerId(k).id));
    if (normalizedExisting.has(op.id)) {
      return planErr("duplicate", `override.${op.id} already exists — a key that normalizes onto it (forge-${op.id}) holds the slot (first definition wins); update it instead`, findings);
    }
    const check3 = validatedDefOf(op.id, op.draft ?? { mode: "auto" });
    const inserted = insertEntry(raw, container, op.id, entryJsonOf(check3.def), { createContainer: true });
    if (!inserted.ok)
      return planErr(inserted.reason === "ambiguous" ? "duplicate" : foldJsoncReason(inserted.reason), inserted.detail, findings);
    if (!parseForgeJsonc(inserted.text).ok)
      return planErr("unparseable", "the patched document does not parse — refusing", findings);
    return {
      ok: true,
      plan: {
        kind: "patch",
        action: "create",
        path: snapshot.path,
        container: "override",
        id: op.id,
        newText: inserted.text,
        summary: [`activate override.${op.id} in ${snapshot.path} (machine-wide)`]
      },
      findings
    };
  }
  const loc = locateEntry(raw, "override", op.id);
  if (!loc.ok)
    return planErr(foldJsoncReason(loc.reason), `override.${op.id}: ${loc.detail}`, findings);
  if (op.action === "delete") {
    const removed = removeEntry(raw, "override", op.id);
    if (!removed.ok)
      return planErr(foldJsoncReason(removed.reason), removed.detail, findings);
    if (!parseForgeJsonc(removed.text).ok)
      return planErr("unparseable", "the patched document does not parse — refusing", findings);
    return {
      ok: true,
      plan: {
        kind: "remove",
        action: "delete",
        path: snapshot.path,
        container: "override",
        id: op.id,
        newText: removed.text,
        summary: [`remove override.${op.id} from ${snapshot.path} (built-in behavior returns)`]
      },
      findings
    };
  }
  const check2 = validatedDefOf(op.id, op.draft ?? { mode: "auto" });
  const { setFields, removeFields } = patchInputsOf(op.draft ?? { mode: "auto" }, check2.def);
  const patched = patchEntryFields(raw, "override", op.id, setFields, removeFields);
  if (!patched.ok)
    return planErr("ambiguous", patched.message, findings);
  if (!parseForgeJsonc(patched.text).ok)
    return planErr("unparseable", "the patched document does not parse — refusing", findings);
  if (patched.text === raw) {
    return {
      ok: true,
      plan: { kind: "no-op", action: "update", path: snapshot.path, container: "override", id: op.id, newText: raw, summary: ["no field changes"] },
      findings
    };
  }
  return {
    ok: true,
    plan: {
      kind: "patch",
      action: "update",
      path: snapshot.path,
      container: "override",
      id: op.id,
      newText: patched.text,
      summary: patched.summary
    },
    findings
  };
}
function planWorkerEdit(snapshot, op, opts) {
  return planEntryEdit(snapshot, op, opts ?? {}, "agents", "worker");
}
function planOverrideEdit(snapshot, op, opts) {
  return planEntryEdit(snapshot, op, opts ?? {}, "override", "override");
}
var tempCounter = 0;
function normalizedStat(st) {
  return st === null ? null : normalizeFileIdentity(st);
}
function commitRecipeEdit(snapshot, plan, deps = {}) {
  const path = plan.path ?? snapshot.path;
  if (deps.recheckOwnership !== undefined && deps.recheckOwnership() === false) {
    return { ok: false, reason: "ownership-lost", message: "the owning scope re-check failed — the target's owning pool or anchor changed since the snapshot" };
  }
  const stat = deps.stat ?? defaultIdentityStat;
  const readFile = deps.readFile ?? defaultReadFile;
  const sampledIdentity = (p) => {
    try {
      return { identity: normalizedStat(stat(p)), refusal: null };
    } catch (err) {
      if (!isUnsafeIdentityError(err))
        throw err;
      return { identity: null, refusal: { ok: false, reason: "write-failed", message: `unsafe file identity for ${p}: ${err.message} — refusing before any write (no temp, no publish)` } };
    }
  };
  if (plan.kind === "no-op") {
    const sampledNoop = sampledIdentity(path);
    if (sampledNoop.refusal !== null)
      return sampledNoop.refusal;
    const noopIdentity = sampledNoop.identity;
    if (noopIdentity === null)
      return { ok: false, reason: "missing", message: `${path} no longer exists` };
    let noopRaw;
    try {
      noopRaw = strictDecode(readFile(path));
    } catch (err) {
      return { ok: false, reason: "unreadable", message: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (snapshot.raw !== null && noopRaw !== snapshot.raw) {
      return { ok: false, reason: "conflict", message: `${path} changed since the snapshot — the no-op verdict is stale; reload` };
    }
    if (snapshot.stat !== null && !identityMatches(noopIdentity, snapshot.stat)) {
      return { ok: false, reason: "conflict", message: `${path}'s identity changed since the snapshot — the no-op verdict is stale; reload` };
    }
    return { ok: true, outcome: "no-op", bytes: 0 };
  }
  const sampledPre = sampledIdentity(path);
  if (sampledPre.refusal !== null)
    return sampledPre.refusal;
  const identity = sampledPre.identity;
  if (plan.kind === "create-file") {
    if (identity !== null)
      return { ok: false, reason: "conflict", message: `${path} appeared since the snapshot — reload before creating` };
  } else {
    if (identity === null)
      return { ok: false, reason: "missing", message: `${path} no longer exists` };
    let currentRaw;
    try {
      currentRaw = strictDecode(readFile(path));
    } catch (err) {
      return { ok: false, reason: "unreadable", message: `cannot read ${path} before replace: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (snapshot.raw !== null && currentRaw !== snapshot.raw) {
      return { ok: false, reason: "conflict", message: `${path} changed since the snapshot — refusing to overwrite newer contents; reload` };
    }
    if (snapshot.stat !== null && !identityMatches(identity, snapshot.stat)) {
      return { ok: false, reason: "conflict", message: `${path}'s identity changed since the snapshot — refusing; reload` };
    }
    if (currentRaw === plan.newText)
      return { ok: true, outcome: "no-op", bytes: 0 };
    const curParsed = parseForgeJsonc(currentRaw);
    const newParsed = parseForgeJsonc(plan.newText);
    if (curParsed.ok && newParsed.ok && deepEqual(curParsed.config, newParsed.config)) {
      return { ok: true, outcome: "no-op", bytes: 0 };
    }
  }
  if (parseForgeJsonc(plan.newText).ok === false) {
    return { ok: false, reason: "unparseable", message: "the planned document does not parse — refusing to write" };
  }
  let refusal = null;
  try {
    if (deps.writeFile !== undefined) {
      if (deps.rename === undefined) {
        return { ok: false, reason: "write-failed", message: "the injected fs provides writeFile without rename — no atomic publish surface; refusing (fail closed)" };
      }
      const publishLink = deps.link;
      if (plan.kind === "create-file" && publishLink === undefined) {
        return { ok: false, reason: "write-failed", message: "creation on an injected fs requires an exclusive publish surface (link) — a rename publish could cover a competing creation; refusing before any write" };
      }
      const renamePublish = deps.rename;
      const temp = `${path}.forge-tui-${process.pid}-${++tempCounter}.tmp`;
      let tempOwned = false;
      try {
        if (plan.kind === "create-file" && deps.mkdir !== undefined) {
          try {
            deps.mkdir(dirname3(path));
          } catch {}
        }
        deps.writeFile(temp, plan.newText);
        tempOwned = true;
        if (deps.recheckOwnership !== undefined && deps.recheckOwnership() === false) {
          refusal = { reason: "ownership-lost", message: "ownership re-check failed after the temp write — the save was aborted before the publish" };
        } else {
          const stale = plan.kind === "create-file" ? verifyCreateAbsent(path, { stat }) : verifyFreshness(snapshot, path, { stat, readFile });
          if (stale !== null) {
            refusal = { reason: "conflict", message: stale };
          } else if (plan.kind === "create-file") {
            const finalStale = verifyCreateAbsent(path, { stat });
            refusal = finalStale !== null ? { reason: "conflict", message: finalStale } : exclusiveInjectedPublish({ link: publishLink, rename: renamePublish }, temp, path, plan.newText, readFile);
          } else {
            renamePublish(temp, path);
            const landed = strictDecode(readFile(path));
            if (landed !== plan.newText) {
              refusal = { reason: "conflict", message: `${path} changed while the save was in flight — application refused; reload` };
            }
          }
        }
      } finally {
        if (tempOwned && deps.unlink !== undefined) {
          try {
            deps.unlink(temp);
          } catch {}
        }
      }
    } else {
      refusal = atomicRealWrite(path, snapshot, plan, { stat, readFile, recheckOwnership: deps.recheckOwnership });
    }
  } catch (err) {
    return { ok: false, reason: "write-failed", message: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (refusal !== null)
    return { ok: false, reason: refusal.reason, message: refusal.message };
  return { ok: true, outcome: "written", bytes: plan.newText.length };
}
function verifyFreshness(snapshot, path, deps) {
  const st = normalizedStat(deps.stat(path));
  if (st === null)
    return `${path} no longer exists`;
  if (snapshot.raw !== null) {
    let currentRaw;
    try {
      currentRaw = strictDecode(deps.readFile(path));
    } catch (err) {
      return `cannot read ${path} before replace: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (currentRaw !== snapshot.raw)
      return `${path} changed since the snapshot — refusing to overwrite newer contents; reload`;
  }
  if (snapshot.stat !== null && !identityMatches(st, snapshot.stat)) {
    return `${path}'s identity changed since the snapshot — refusing; reload`;
  }
  return null;
}
function assertRealDirAncestors(dir) {
  let cur = resolve4(dir);
  const chain = [];
  while (true) {
    chain.unshift(cur);
    const parent = dirname3(cur);
    if (parent === cur)
      break;
    cur = parent;
  }
  for (const dirPath of chain) {
    let st;
    try {
      st = lstatSync(dirPath);
    } catch (err) {
      if (err.code === "ENOENT")
        continue;
      throw new Error(`unsafe creation root: cannot inspect ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (st.isSymbolicLink())
      throw new Error(`unsafe creation root: ${dirPath} is a symlink/junction — the creation could land outside the intended tree`);
    if (!st.isDirectory())
      throw new Error(`unsafe creation root: ${dirPath} is not a directory`);
  }
}
function atomicRealWrite(path, snapshot, plan, deps) {
  const isCreate = plan.kind === "create-file";
  if (!isCreate) {
    const lst = lstatSync(path);
    if (lst.isSymbolicLink())
      throw new Error(`unsafe target: ${path} is a symlink — replace the link target's real file instead`);
    if (lst.nlink > 1)
      throw new Error(`unsafe target: ${path} is hard-linked (${lst.nlink} names) — the write would leak across identities`);
    const real = realpathOf(path);
    if (real !== null && foldPath(real) !== foldPath(path))
      throw new Error(`unsafe target: ${path} resolves to ${real}`);
  } else {
    assertRealDirAncestors(dirname3(path));
    try {
      mkdirSync2(dirname3(path), { recursive: true });
    } catch {}
    const real = realpathOf(dirname3(path));
    if (real !== null && foldPath(real) !== foldPath(resolve4(dirname3(path)))) {
      throw new Error(`unsafe creation root: ${dirname3(path)} resolves to ${real} — refusing to create through a redirected parent`);
    }
  }
  let ownedTemp = "";
  try {
    for (let attempt = 0;attempt < 5; attempt++) {
      const candidate = `${path}.forge-tui-${process.pid}-${++tempCounter}.tmp`;
      try {
        writeFileSync3(candidate, plan.newText, { flag: "wx", mode: 384 });
        ownedTemp = candidate;
        break;
      } catch (err) {
        const code = err.code;
        if (code === "EEXIST") {
          if (attempt < 4)
            continue;
          break;
        }
        throw err;
      }
    }
    if (ownedTemp === "") {
      return { reason: "write-failed", message: `could not acquire an exclusive temp name next to ${path} (5 attempts, all occupied) — refusing rather than touching foreign files` };
    }
    const temp = ownedTemp;
    if (deps.recheckOwnership !== undefined && deps.recheckOwnership() === false) {
      return { reason: "ownership-lost", message: "ownership re-check failed after the temp write — the save was aborted before the publish" };
    }
    const stale = isCreate ? verifyCreateAbsent(path, deps) : verifyFreshness(snapshot, path, deps);
    if (stale !== null)
      return { reason: "conflict", message: stale };
    if (isCreate) {
      try {
        linkSync(temp, path);
      } catch (err) {
        if (err.code === "EEXIST") {
          return { reason: "conflict", message: `${path} appeared while the save was in flight — creation refused (no-clobber); reload` };
        }
        throw new Error(`exclusive publish unavailable on this filesystem (${err instanceof Error ? err.message : String(err)}) — creation refused (fail closed)`);
      }
      return null;
    }
    renameSync2(temp, path);
    return null;
  } finally {
    if (ownedTemp !== "") {
      try {
        unlinkSync2(ownedTemp);
      } catch {}
    }
  }
}
function verifyCreateAbsent(path, deps) {
  if (normalizedStat(deps.stat(path)) !== null)
    return `${path} appeared since the snapshot — creation refused (no-clobber); reload`;
  return null;
}
function exclusiveInjectedPublish(deps, temp, path, newText, readFile) {
  const publish = deps.link ?? deps.rename;
  try {
    publish(temp, path);
  } catch (err) {
    if (err.code === "EEXIST") {
      return { reason: "conflict", message: `${path} appeared while the save was in flight — creation refused (no-clobber); reload` };
    }
    throw err;
  }
  const landed = strictDecode(readFile(path));
  if (landed !== newText) {
    return { reason: "conflict", message: `${path} changed while the save was in flight — application refused; reload` };
  }
  return null;
}
function realpathOf(path) {
  try {
    return realpathSync2(path);
  } catch {
    return null;
  }
}
function foldPath(p) {
  return process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
}
var commitLocks = new Map;
function withCommitLock(path, fn) {
  const key = foldPath(path);
  const prev = commitLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {
    return;
  }, () => {
    return;
  });
  commitLocks.set(key, tail);
  tail.then(() => {
    if (commitLocks.get(key) === tail)
      commitLocks.delete(key);
  });
  return run;
}

// src/config-rpc-protocol.ts
var DEFAULT_TTL = { snapshot: 6 * 60 * 60 * 1000, token: 5 * 60 * 1000, receipt: 6 * 60 * 60 * 1000 };
var DEFAULT_LIMITS = { snapshots: 64, tokens: 128, receipts: 256 };
var defaultHash = (text) => createHash2("sha256").update(text, "utf8").digest("hex");
function parseOf(text) {
  const p = parseForgeJsonc(text);
  return p.ok ? { ok: true, value: p.config } : { ok: false, message: `${p.error.message}${p.error.line !== undefined ? ` (line ${p.error.line}, column ${p.error.column})` : ""}` };
}
function foldPath2(p) {
  return process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
}
function defaultLstat(p) {
  try {
    const st = lstatSync2(p, { bigint: true });
    const identity = identityFromBigintStats(st);
    return { exists: true, isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), isFile: st.isFile(), nlink: safeBigintNumber(st.nlink, "nlink"), mtimeMs: identity.mtimeMs, size: identity.size };
  } catch (err) {
    if (err.code === "ENOENT")
      return { exists: false };
    throw err;
  }
}
function defaultRealpath(p) {
  return realpathSync3(p);
}
function guardReadableTarget(path, seams) {
  const lstat = seams.lstat ?? defaultLstat;
  const realpath = seams.realpath ?? defaultRealpath;
  const resolved = path.replace(/\//g, "\\");
  const parts = resolved.split(/\\/).filter(Boolean);
  let walk = parts[0] ?? "";
  for (let i = 1;i < parts.length - 1; i++) {
    walk = `${walk}\\${parts[i]}`.replace(/^\\+/, "\\");
    let st;
    try {
      st = lstat(walk);
    } catch (err) {
      return { ok: false, message: `unsafe target: cannot inspect ${walk}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!st.exists)
      break;
    if (st.isSymlink)
      return { ok: false, message: `unsafe target: ${walk} is a symlink/junction — refusing to read or write through it` };
    if (!st.isDirectory)
      return { ok: false, message: `unsafe target: ${walk} is not a directory` };
  }
  let finalSt;
  try {
    finalSt = lstat(path);
  } catch (err) {
    return { ok: false, message: `unsafe target: cannot inspect ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (finalSt.exists) {
    if (finalSt.isSymlink)
      return { ok: false, message: `unsafe target: ${path} is a symlink — replace the link target's real file instead` };
    if (!finalSt.isFile)
      return { ok: false, message: `unsafe target: ${path} is not a regular file` };
    if (finalSt.nlink > 1)
      return { ok: false, message: `unsafe target: ${path} is hard-linked (${finalSt.nlink} names) — the write would leak across identities` };
    let real;
    try {
      real = realpath(path);
    } catch (err) {
      return { ok: false, message: `unsafe target: cannot resolve ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (foldPath2(real) !== foldPath2(path)) {
      return { ok: false, message: `unsafe target: ${path} resolves to ${real}` };
    }
  }
  return { ok: true };
}
function createConfigRpcStore(deps) {
  const randomId = deps.randomId ?? (() => randomUUID());
  const hash2 = deps.hash ?? defaultHash;
  const ttl = { ...DEFAULT_TTL, ...deps.ttlMs };
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const maxOps = deps.maxOps ?? 32;
  const maxDraftBytes = deps.maxDraftBytes ?? 262144;
  const maxContextBytes = deps.maxContextBytes ?? 1024 * 1024;
  const fs = deps.fs ?? {};
  const snapshots = new Map;
  const tokens = new Map;
  const receipts = new Map;
  let epochOverride = null;
  const epochNow = () => epochOverride ?? deps.epoch();
  const now = () => deps.clock();
  const epochLive = (bound) => {
    const cur = epochNow();
    return cur.epoch === bound.epoch && cur.generation === bound.generation;
  };
  const insertBounded = (map2, key, value, max) => {
    if (map2.size >= max && !map2.has(key)) {
      const oldest = map2.keys().next();
      if (!oldest.done)
        map2.delete(oldest.value);
    }
    map2.set(key, value);
  };
  const sweep = () => {
    const t = now();
    let evictedReceipts = 0;
    for (const [id, entry] of receipts) {
      if (t > entry.expiresAt) {
        receipts.delete(id);
        evictedReceipts++;
      }
    }
    return { evictedSnapshots: 0, evictedTokens: 0, evictedReceipts };
  };
  const targetIdentityOf = (binding) => `cfgt-${hash2(`${binding.scope}
${binding.path}
${binding.observedLocation ?? ""}
${binding.anchor ?? ""}`).slice(0, 32)}`;
  const bindingOf = (base) => ({ ...base, targetIdentity: targetIdentityOf(base) });
  const INVALID = Symbol("config-rpc-invalid-session");
  const asSessionID = (v) => {
    if (v === null)
      return null;
    if (typeof v === "string")
      return v;
    return INVALID;
  };
  const onlyKeys = (input, keys) => {
    if (typeof input !== "object" || input === null)
      return false;
    return Object.keys(input).every((k) => keys.includes(k));
  };
  const echo = (input, ctx) => {
    const cur = epochNow();
    return {
      nonce: typeof input?.nonce === "string" ? input.nonce : "",
      pluginID: ctx.pluginID,
      appVersion: ctx.appVersion,
      epoch: cur.epoch,
      generation: cur.generation
    };
  };
  const editOpen = (input) => {
    sweep();
    if (!onlyKeys(input, ["scope", "sessionID"])) {
      return { ok: false, reason: "malformed-request", message: "malformed editOpen request — unexpected top-level field(s) are refused" };
    }
    const sessionID = asSessionID(input?.sessionID);
    if (sessionID === INVALID || input?.scope !== "workspace" && input?.scope !== "global") {
      return { ok: false, reason: "scope-unresolved", message: 'malformed editOpen request — scope must be "workspace"|"global" and sessionID a string or exactly null' };
    }
    const resolved = deps.resolver({ scope: input.scope, sessionID });
    if (!resolved.ok) {
      return { ok: false, reason: "scope-unresolved", message: resolved.message };
    }
    if (resolved.target.observedLocation === null || resolved.target.observedLocation === undefined) {
      return { ok: false, reason: "scope-unresolved", message: "the server cannot observe a location for this target right now — no snapshot is issued (fail closed)" };
    }
    const guard = guardReadableTarget(resolved.target.path, fs);
    if (!guard.ok) {
      return { ok: false, reason: "scope-unresolved", message: `${guard.message} — no snapshot is issued` };
    }
    const snapshot = snapshotRecipe({ path: resolved.target.path, stat: fs.stat, readFile: fs.readFile });
    if (input.scope === "workspace" && !resolved.target.creatable && !snapshot.exists) {
      return { ok: false, reason: "scope-unresolved", message: `the owning workspace pool ${resolved.target.path} reads back absent while its creation is not authoritatively anchored — conflicted resolution; no snapshot handle is issued, reopen to re-resolve` };
    }
    if (snapshot.exists && snapshot.stat !== null) {
      let post;
      try {
        post = (fs.lstat ?? defaultLstat)(resolved.target.path);
      } catch (err) {
        return { ok: false, reason: "scope-unresolved", message: `unsafe target: ${resolved.target.path} changed while being read (inspect failed: ${err instanceof Error ? err.message : String(err)}) — no snapshot is issued` };
      }
      const st0 = snapshot.stat;
      const swapped = !post.exists || post.isSymlink || !post.isFile || post.mtimeMs === undefined || post.mtimeMs !== st0.mtimeMs || post.size !== undefined && post.size !== st0.size;
      if (swapped) {
        return { ok: false, reason: "scope-unresolved", message: `unsafe target: ${resolved.target.path} changed while being read — refusing (no bytes disclosed); reload` };
      }
    }
    const t = now();
    const cur = epochNow();
    const binding = bindingOf({
      path: resolved.target.path,
      scope: input.scope,
      sessionID,
      observedLocation: resolved.target.observedLocation,
      anchor: resolved.target.anchor
    });
    const snapshotId = randomId();
    const entry = {
      snapshotId,
      binding,
      snapshot,
      epoch: { ...cur },
      createdAt: t,
      expiresAt: t + ttl.snapshot
    };
    insertBounded(snapshots, snapshotId, entry, limits.snapshots);
    const findings = [];
    if (!snapshot.exists && !resolved.target.creatable) {
      findings.push({ level: "warn", code: "target-not-creatable", message: `no recipe at ${binding.path} and the server cannot authoritatively anchor a creation here — browsing only, writes unavailable` });
    }
    if (snapshot.exists && !snapshot.readable) {
      findings.push({ level: "warn", code: "target-unreadable", message: `the recipe at ${binding.path} exists but cannot be decoded (strict UTF-8) — every edit is refused` });
    }
    return {
      ok: true,
      snapshotId,
      path: binding.path,
      targetIdentity: binding.targetIdentity,
      scope: binding.scope,
      sessionID: binding.sessionID,
      observedLocation: binding.observedLocation,
      anchor: binding.anchor,
      epoch: cur.epoch,
      generation: cur.generation,
      expiresAt: entry.expiresAt,
      exists: snapshot.exists,
      readable: snapshot.readable,
      creatable: resolved.target.creatable === true,
      identity: snapshot.stat,
      raw: snapshot.raw,
      document: snapshot.parse && snapshot.parse.ok ? snapshot.parse.value : null,
      parseError: snapshot.parse && !snapshot.parse.ok ? { message: snapshot.parse.message } : null,
      findings
    };
  };
  function planBatch(entry, ops) {
    const baseline = entry.snapshot;
    const entries = [];
    const rejected = [];
    const findings = [];
    let acc = baseline.raw ?? "";
    let createdFile = false;
    for (const op of ops) {
      if (op.renameTo !== undefined) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: "invalid-id", message: "renaming an existing entry id is not supported — create the new id explicitly and delete the old one", findings: [] });
        continue;
      }
      if (op.kind !== "worker" && op.kind !== "override") {
        rejected.push({ opId: op.opId, id: op.id, kind: "worker", action: op.action, reason: "invalid-op", message: `op kind must be "worker" or "override"`, findings: [] });
        continue;
      }
      if (op.action !== "create" && op.action !== "update" && op.action !== "delete") {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: "create", reason: "invalid-op", message: `op action must be "create", "update" or "delete"`, findings: [] });
        continue;
      }
      const draft = op.draft;
      if (draft !== undefined && Buffer.byteLength(JSON.stringify(draft), "utf8") > maxDraftBytes) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: "invalid-op", message: `the draft exceeds the bounded preview size (${maxDraftBytes} UTF-8 bytes) — refusing this op only`, findings: [] });
        continue;
      }
      const planOp = { action: op.action, id: op.id, draft };
      const opts = { scope: entry.binding.scope, pool: op.pool };
      const result = op.kind === "worker" ? planWorkerEdit(currentSnapshot(baseline, acc, createdFile || baseline.exists), planOp, opts) : planOverrideEdit(currentSnapshot(baseline, acc, createdFile || baseline.exists), planOp, opts);
      findings.push(...result.findings);
      if (!result.ok) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: result.reason, message: result.message, findings: result.findings.filter((f) => f.level === "error") });
        continue;
      }
      if (result.plan.path !== entry.binding.path) {
        rejected.push({ opId: op.opId, id: op.id, kind: op.kind, action: op.action, reason: "invalid-op", message: "internal: planned path drifted from the resolved binding — refusing the op", findings: [] });
        continue;
      }
      acc = result.plan.newText;
      if (result.plan.kind === "create-file")
        createdFile = true;
      entries.push({
        opId: op.opId,
        id: result.plan.id,
        kind: op.kind,
        action: op.action,
        entryKind: result.plan.kind,
        summary: result.plan.summary,
        findings: result.findings
      });
    }
    return { accText: acc, entries, rejected, findings };
  }
  function currentSnapshot(baseline, acc, exists) {
    if (exists && baseline.exists)
      return { ...baseline, raw: acc, parse: parseOf(acc) };
    if (exists && !baseline.exists) {
      return { path: baseline.path, exists: true, readable: true, raw: acc, stat: null, parse: parseOf(acc) };
    }
    return baseline;
  }
  const prepare = (input) => {
    sweep();
    if (!onlyKeys(input, ["snapshotId", "scope", "sessionID", "ops"])) {
      return { ok: false, reason: "malformed-request", message: "malformed prepare request — unexpected top-level field(s) are refused" };
    }
    const entry = typeof input?.snapshotId === "string" ? snapshots.get(input.snapshotId) : undefined;
    if (entry === undefined) {
      return { ok: false, reason: "snapshot-unknown", message: "unknown snapshot handle — open the editor (editOpen) again" };
    }
    if (!epochLive(entry.epoch)) {
      snapshots.delete(entry.snapshotId);
      return { ok: false, reason: "epoch-stale", message: "the server epoch or RPC registration generation changed — every handle and token issued before it is refused; reopen the editor" };
    }
    const t = now();
    if (t > entry.expiresAt) {
      snapshots.delete(entry.snapshotId);
      return { ok: false, reason: "snapshot-expired", message: "the edit-start snapshot handle expired — reopen the editor (no auto-renewal)" };
    }
    const sessionID = asSessionID(input?.sessionID);
    if (sessionID === INVALID || input?.scope !== entry.binding.scope || input.sessionID !== entry.binding.sessionID) {
      return { ok: false, reason: "scope-mismatch", message: "stated scope/sessionID do not exactly match the snapshot binding (null against null)" };
    }
    if (!Array.isArray(input.ops)) {
      return { ok: false, reason: "invalid-op", message: "ops must be an array" };
    }
    if (input.ops.length > maxOps) {
      return { ok: false, reason: "invalid-op", message: `a prepare carries at most ${maxOps} ops (bounded previews) — got ${input.ops.length}` };
    }
    const resolved = deps.resolver({ scope: entry.binding.scope, sessionID: entry.binding.sessionID });
    if (!resolved.ok) {
      return { ok: false, reason: "scope-unresolved", message: resolved.message };
    }
    if (resolved.target.path !== entry.binding.path || resolved.target.observedLocation !== entry.binding.observedLocation || resolved.target.anchor !== entry.binding.anchor) {
      return { ok: false, reason: "scope-mismatch", message: "the target no longer resolves under the edit-start binding (owner, path or observed location changed) — reopen the editor" };
    }
    const fresh = freshnessOf(baselineOf(entry.snapshot));
    if (fresh !== null)
      return fresh;
    if (!entry.snapshot.exists && resolved.target.creatable !== true) {
      return { ok: false, reason: "scope-unresolved", message: `no recipe at ${entry.binding.path} and the server cannot authoritatively anchor a creation here — writes unavailable` };
    }
    if (entry.snapshot.exists && !entry.snapshot.readable) {
      return { ok: false, reason: "unreadable", message: `the recipe at ${entry.binding.path} was unreadable when the editor opened (invalid UTF-8) — refusing every edit; reload after fixing the encoding` };
    }
    if (entry.snapshot.exists && entry.snapshot.readable && entry.snapshot.parse !== null && !entry.snapshot.parse.ok) {
      return { ok: false, reason: "unparseable", message: `${entry.binding.path}: ${entry.snapshot.parse.message} — broken documents are never edited in place; fix the syntax first` };
    }
    const batch = planBatch(entry, input.ops);
    const allFindings = [...batch.findings];
    if (batch.entries.length === 0) {
      const first = batch.rejected[0];
      return {
        ok: false,
        reason: "no-valid-entries",
        message: first !== undefined ? `${batch.rejected.length} of ${input.ops.length} entries rejected — ${first.message}` : "no entries to save",
        findings: allFindings
      };
    }
    const createFile = !entry.snapshot.exists;
    const anyChange = batch.entries.some((e) => e.entryKind !== "no-op");
    if (!anyChange) {
      return {
        ok: true,
        outcome: "no-op",
        summary: batch.entries.flatMap((e) => e.summary),
        rejected: batch.rejected.map(({ opId, id, reason, message, findings }) => ({ opId, id, reason, message, findings })),
        findings: allFindings
      };
    }
    const cur = epochNow();
    const token = randomId();
    const expiresAt = t + ttl.token;
    const newText = batch.accText;
    const tokenEntry = {
      token,
      binding: entry.binding,
      snapshotId: entry.snapshotId,
      raw: entry.snapshot.raw,
      identity: entry.snapshot.stat,
      newText,
      previewHash: hash2(newText),
      createFile,
      writeKind: createFile ? "create-file" : "patch",
      entries: batch.entries,
      rejected: batch.rejected,
      epoch: { ...cur },
      createdAt: t,
      expiresAt,
      spent: false
    };
    insertBounded(tokens, token, tokenEntry, limits.tokens);
    const preview = {
      path: entry.binding.path,
      targetIdentity: entry.binding.targetIdentity,
      scope: entry.binding.scope,
      sessionID: entry.binding.sessionID,
      oldText: entry.snapshot.raw,
      newText,
      previewHash: tokenEntry.previewHash,
      createFile,
      identity: entry.snapshot.stat,
      entries: batch.entries.map((e) => ({
        opId: e.opId,
        id: e.id,
        kind: e.kind,
        action: e.action,
        entryKind: e.entryKind,
        summary: e.summary,
        findings: e.findings
      })),
      rejected: batch.rejected.map(({ opId, id, reason, message, findings }) => ({ opId, id, reason, message, findings }))
    };
    return {
      ok: true,
      outcome: "token",
      token: { token, expiresAt, epoch: cur.epoch, generation: cur.generation },
      preview,
      findings: allFindings
    };
  };
  function freshnessOf(baseline) {
    const stat = fs.stat;
    const readFile = fs.readFile;
    const path = baseline.path;
    const st = snapshotRecipe({ path, stat, readFile });
    if (baseline.exists) {
      if (!st.exists) {
        return { ok: false, reason: "conflict-reload", message: `${path} no longer exists — the edit-start snapshot is stale; reload` };
      }
      if (!st.readable) {
        return { ok: false, reason: "unreadable", message: `${path} cannot be decoded since the editor opened — refusing (never a lossy rewrite source); reload` };
      }
      if (baseline.raw !== null && st.raw !== baseline.raw) {
        return { ok: false, reason: "conflict-reload", message: `${path} changed since the editor opened — refusing to overwrite newer contents; reload` };
      }
      if (baseline.stat !== null && st.stat !== null) {
        const a = baseline.stat;
        const b = st.stat;
        if (a.mtimeMs !== b.mtimeMs || a.size !== b.size) {
          return { ok: false, reason: "conflict-reload", message: `${path}'s identity changed since the editor opened — refusing; reload` };
        }
        if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined && (a.dev !== b.dev || a.ino !== b.ino)) {
          return { ok: false, reason: "conflict-reload", message: `${path} was deleted and recreated since the editor opened — refusing; reload` };
        }
      }
      return null;
    }
    if (st.exists) {
      return { ok: false, reason: "conflict-reload", message: `${path} appeared since the editor opened — reload before creating` };
    }
    return null;
  }
  const commit = async (input) => {
    sweep();
    if (!onlyKeys(input, ["token", "confirm", "scope", "sessionID"])) {
      return { ok: false, reason: "malformed-request", message: "malformed commit request — unexpected top-level field(s) are refused" };
    }
    if (input?.confirm !== true) {
      return { ok: false, reason: "confirm-required", message: "commit requires confirm === true — an unconfirmed preview is never written" };
    }
    const entry = typeof input?.token === "string" ? tokens.get(input.token) : undefined;
    if (entry === undefined) {
      return { ok: false, reason: "token-unknown", message: "unknown preview token — an earlier attempt under this id cannot be confirmed (it may or may not have written); do not replay, prepare fresh against current content" };
    }
    if (entry.spent) {
      return { ok: false, reason: "token-spent", message: "the token was already used — at most one write per token; look the receipt up by token instead of replaying" };
    }
    if (!epochLive(entry.epoch)) {
      tokens.delete(entry.token);
      return { ok: false, reason: "epoch-stale", message: "the server epoch or RPC registration generation changed — this attempt wrote nothing; any earlier attempt under this token is NOT adjudicated here (query the receipt; found:false = UNKNOWN)" };
    }
    const t = now();
    if (t > entry.expiresAt) {
      tokens.delete(entry.token);
      return { ok: false, reason: "token-expired", message: "the preview token expired — this attempt wrote nothing; any earlier attempt under this token is NOT adjudicated here (query the receipt; found:false = UNKNOWN). Run a fresh prepare (no auto-renewal)" };
    }
    const sessionID = asSessionID(input?.sessionID);
    if (sessionID === INVALID || input?.scope !== entry.binding.scope || input.sessionID !== entry.binding.sessionID) {
      return { ok: false, reason: "scope-mismatch", message: "stated scope/sessionID do not exactly match the token binding (null against null) — this attempt wrote nothing and the unspent token stays usable for the correct binding" };
    }
    const pre = resolveBinding(entry);
    if (pre !== null)
      return pre;
    return withCommitLock(entry.binding.path, () => {
      if (entry.spent) {
        return { ok: false, reason: "token-spent", message: "the token was used by a competing commit while this attempt waited — at most one write per token; look the receipt up by token" };
      }
      if (!epochLive(entry.epoch)) {
        tokens.delete(entry.token);
        return { ok: false, reason: "epoch-stale", message: "the server epoch or registration generation changed while the commit was pending — this attempt wrote nothing" };
      }
      const t2 = now();
      if (t2 > entry.expiresAt) {
        tokens.delete(entry.token);
        return { ok: false, reason: "token-expired", message: "the preview token expired while the commit was pending — this attempt wrote nothing (no auto-renewal)" };
      }
      if (tokens.get(entry.token) !== entry) {
        return { ok: false, reason: "token-unknown", message: "the token is no longer registered (bounded-store eviction while the commit was pending) — its earlier outcome cannot be confirmed from here; re-prepare against current content" };
      }
      const inLockScope = resolveBinding(entry);
      if (inLockScope !== null)
        return inLockScope;
      const fresh = freshnessOf(baselineOfToken(entry));
      if (fresh !== null) {
        entry.spent = true;
        const receipt3 = buildReceipt(entry, "conflict", fresh.message, { at: t2, savedIdentity: null, bytes: 0 });
        recordReceipt(receipt3, entry.epoch, t2, null);
        return { ok: true, receipt: receipt3 };
      }
      let context = null;
      if (deps.beforeCommit !== undefined) {
        let captureError = null;
        try {
          const captured = deps.beforeCommit({
            scope: entry.binding.scope,
            sessionID: entry.binding.sessionID,
            path: entry.binding.path,
            binding: { path: entry.binding.path, observedLocation: entry.binding.observedLocation, anchor: entry.binding.anchor, targetIdentity: entry.binding.targetIdentity },
            newText: entry.newText
          });
          if (captured === null || typeof captured !== "object" || Array.isArray(captured)) {
            captureError = "beforeCommit returned a non-object baseline";
          } else if (Buffer.byteLength(JSON.stringify(captured), "utf8") > maxContextBytes) {
            captureError = `beforeCommit baseline exceeds the bounded context size (${maxContextBytes} UTF-8 bytes)`;
          } else {
            context = captured;
          }
        } catch (err) {
          captureError = `beforeCommit failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (captureError !== null) {
          entry.spent = true;
          const at0 = now();
          const receipt3 = buildReceipt(entry, "write-failed", `${captureError} — refusing before the publish`, { at: at0, savedIdentity: null, bytes: 0 });
          recordReceipt(receipt3, entry.epoch, at0, null);
          return { ok: true, receipt: receipt3 };
        }
      }
      entry.spent = true;
      const recheckOwnership = () => {
        try {
          const r = deps.resolver({ scope: entry.binding.scope, sessionID: entry.binding.sessionID });
          if (!r.ok)
            return false;
          if (r.target.path !== entry.binding.path || r.target.observedLocation !== entry.binding.observedLocation || r.target.anchor !== entry.binding.anchor)
            return false;
          if (entry.createFile && r.target.creatable !== true)
            return false;
          if (deps.reverify !== undefined && !deps.reverify({ scope: entry.binding.scope, sessionID: entry.binding.sessionID, path: entry.binding.path, observedLocation: entry.binding.observedLocation, anchor: entry.binding.anchor }))
            return false;
          return true;
        } catch {
          return false;
        }
      };
      let result;
      try {
        result = commitRecipeEdit(baselineSnapshotFor(entry), { kind: entry.writeKind, path: entry.binding.path, newText: entry.newText }, {
          stat: fs.stat,
          readFile: fs.readFile,
          writeFile: fs.writeFile,
          rename: fs.rename,
          link: fs.link,
          unlink: fs.unlink,
          mkdir: fs.mkdir,
          recheckOwnership
        });
      } catch (err) {
        result = { ok: false, reason: "write-failed", message: `write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const at = now();
      if (!result.ok) {
        const receipt3 = buildReceipt(entry, result.reason, result.message, { at, savedIdentity: null, bytes: 0 });
        recordReceipt(receipt3, entry.epoch, at, null);
        return { ok: true, receipt: receipt3 };
      }
      if (result.outcome === "written") {
        const post2 = postWriteIdentity(entry.binding.path);
        const receipt3 = buildReceipt(entry, "written", post2.unsafe ? "saved — the write succeeded, but the post-write identity could not be sampled losslessly (unsafe identity; receipt carries no saved identity)" : "saved", { at, savedIdentity: post2.identity, bytes: Buffer.byteLength(entry.newText, "utf8") });
        recordReceipt(receipt3, entry.epoch, at, context);
        return { ok: true, receipt: receipt3 };
      }
      const post = postWriteIdentity(entry.binding.path);
      const receipt2 = buildReceipt(entry, "no-op", post.unsafe ? "no changes — nothing written — the post-write identity could not be sampled losslessly (unsafe identity; receipt carries no saved identity)" : "no changes — nothing written", { at, savedIdentity: post.identity, bytes: 0 });
      recordReceipt(receipt2, entry.epoch, at, context);
      return { ok: true, receipt: receipt2 };
    });
  };
  function resolveBinding(entry) {
    let r;
    try {
      r = deps.resolver({ scope: entry.binding.scope, sessionID: entry.binding.sessionID });
    } catch (err) {
      return { ok: false, reason: "scope-unresolved", message: `authoritative resolution failed: ${err instanceof Error ? err.message : String(err)} — nothing was written` };
    }
    if (!r.ok)
      return { ok: false, reason: "scope-unresolved", message: r.message };
    if (r.target.path !== entry.binding.path || r.target.observedLocation !== entry.binding.observedLocation || r.target.anchor !== entry.binding.anchor) {
      return { ok: false, reason: "scope-mismatch", message: "the target no longer resolves under the token binding (owner, path or observed location changed) — nothing was written" };
    }
    if (entry.createFile && r.target.creatable !== true) {
      return { ok: false, reason: "scope-unresolved", message: "the server no longer anchors a creation at the bound target — nothing was written" };
    }
    return null;
  }
  function baselineOf(snap) {
    return { path: snap.path, exists: snap.exists, readable: snap.readable, raw: snap.raw, stat: snap.stat };
  }
  function baselineOfToken(entry) {
    return { path: entry.binding.path, exists: !entry.createFile, readable: !entry.createFile, raw: entry.raw, stat: entry.identity };
  }
  function baselineSnapshotFor(entry) {
    return {
      path: entry.binding.path,
      exists: !entry.createFile,
      readable: !entry.createFile,
      raw: entry.raw,
      stat: entry.identity,
      parse: entry.raw !== null ? parseOf(entry.raw) : null
    };
  }
  function statOf(path) {
    try {
      const st = fs.stat !== undefined ? fs.stat(path) : snapshotRecipe({ path }).stat;
      return st === null ? null : normalizeFileIdentity(st);
    } catch (err) {
      if (isUnsafeIdentityError(err))
        throw err;
      return null;
    }
  }
  function postWriteIdentity(path) {
    try {
      return { identity: statOf(path), unsafe: false };
    } catch (err) {
      if (!isUnsafeIdentityError(err))
        throw err;
      return { identity: null, unsafe: true };
    }
  }
  function buildReceipt(entry, outcome, message, extra) {
    const cur = epochNow();
    const entries = [
      ...entry.entries.map((e) => {
        const reasonField = outcome === "written" || outcome === "no-op" ? undefined : outcome;
        return {
          opId: e.opId,
          id: e.id,
          kind: e.kind,
          action: e.action,
          entryKind: e.entryKind,
          outcome: outcome === "written" ? e.entryKind === "no-op" ? "no-op" : "written" : outcome === "no-op" ? "no-op" : "rejected",
          ...reasonField !== undefined ? { reason: reasonField } : {},
          summary: e.summary,
          findings: e.findings
        };
      }),
      ...entry.rejected.map((r) => ({
        opId: r.opId,
        id: r.id,
        kind: r.kind,
        action: r.action,
        entryKind: "no-op",
        outcome: "rejected",
        reason: r.reason,
        summary: [],
        findings: r.findings
      }))
    ];
    return {
      commitId: randomId(),
      token: entry.token,
      outcome,
      message,
      path: entry.binding.path,
      targetIdentity: entry.binding.targetIdentity,
      scope: entry.binding.scope,
      sessionID: entry.binding.sessionID,
      savedIdentity: extra.savedIdentity,
      bytes: extra.bytes,
      entries,
      epoch: cur.epoch,
      generation: cur.generation,
      at: extra.at,
      sync: null
    };
  }
  function recordReceipt(receipt2, epoch, at, context) {
    const store = { receipt: receipt2, epoch: { ...epoch }, createdAt: at, expiresAt: at + ttl.receipt, context };
    insertBounded(receipts, receipt2.token, store, limits.receipts);
  }
  const receipt = (input) => {
    sweep();
    if (!onlyKeys(input, ["token"])) {
      const cur0 = epochNow();
      return { found: false, epoch: cur0.epoch, generation: cur0.generation };
    }
    const cur = epochNow();
    const hit = typeof input?.token === "string" ? receipts.get(input.token) : undefined;
    if (hit === undefined || hit.epoch.epoch !== cur.epoch || hit.epoch.generation !== cur.generation) {
      return { found: false, epoch: cur.epoch, generation: cur.generation };
    }
    return { found: true, receipt: hit.receipt, epoch: cur.epoch, generation: cur.generation };
  };
  const attachSyncOutcome = (commitId, sync) => {
    sweep();
    for (const entry of receipts.values()) {
      if (entry.receipt.commitId === commitId) {
        entry.receipt.sync = sync;
        return true;
      }
    }
    return false;
  };
  const getCommitContext = (commitId) => {
    sweep();
    const cur = epochNow();
    if (typeof commitId !== "string" || commitId.length === 0) {
      return { found: false, epoch: cur.epoch, generation: cur.generation };
    }
    for (const entry of receipts.values()) {
      if (entry.receipt.commitId !== commitId)
        continue;
      if (entry.epoch.epoch !== cur.epoch || entry.epoch.generation !== cur.generation)
        break;
      if (entry.receipt.outcome !== "written" && entry.receipt.outcome !== "no-op")
        break;
      if (entry.context === null)
        break;
      return { found: true, context: entry.context, commitId, token: entry.receipt.token, epoch: cur.epoch, generation: cur.generation };
    }
    return { found: false, epoch: cur.epoch, generation: cur.generation };
  };
  const handlers = (plugin) => ({
    echo: (input) => echo(input, plugin),
    editOpen: (input) => editOpen(input),
    prepare: (input) => prepare(input),
    commit: (input) => commit(input),
    receipt: (input) => receipt(input)
  });
  return {
    echo,
    editOpen,
    prepare,
    commit,
    receipt,
    handlers,
    attachSyncOutcome,
    getCommitContext,
    sweep,
    size: () => ({ snapshots: snapshots.size, tokens: tokens.size, receipts: receipts.size }),
    rotateEpoch: (next) => {
      epochOverride = { ...next };
    }
  };
}

// src/config-rpc-host.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var configRpcEpochState = { epoch: randomUUID2(), generation: 0 };
function currentConfigRpcEpoch() {
  return { ...configRpcEpochState };
}
function rotateConfigRpcEpoch() {
  configRpcEpochState.generation += 1;
  return { ...configRpcEpochState };
}
function resolveConfigTarget(acc, observedLocation, req) {
  let anchor;
  let location;
  if (req.sessionID !== null) {
    const live = acc.sessionAnchorOf(req.sessionID);
    if (live === null || live.trim() === "") {
      return { ok: false, reason: "scope-unresolved", message: `no authoritative anchor for session ${req.sessionID} — the server has no live workspace statement for it (session.moved / live map / ledger all empty); scope stays unresolved rather than guessed` };
    }
    anchor = live;
    location = live;
  } else {
    if (observedLocation === null || observedLocation.trim() === "") {
      return { ok: false, reason: "scope-unresolved", message: "this registration has no server-observed location — a null-session (home) scope is not resolvable here; refuse rather than widen to a wildcard" };
    }
    anchor = observedLocation;
    location = observedLocation;
  }
  if (req.scope === "global") {
    const globalPath = acc.globalPoolPath();
    return {
      ok: true,
      target: {
        path: globalPath,
        observedLocation: location,
        anchor: null,
        creatable: !acc.pathExists(globalPath)
      }
    };
  }
  const pool = acc.workspacePoolOf(anchor);
  if (pool !== null && pool.trim() !== "") {
    return { ok: true, target: { path: pool, observedLocation: location, anchor, creatable: false } };
  }
  if (!acc.knownWorkspaceRoot(anchor)) {
    return { ok: false, reason: "scope-unresolved", message: `${anchor} has no owning pool file and is not a host-initialized workspace root — creation cannot be authoritatively anchored here${req.sessionID !== null ? " (a session identity does not substitute for the host's root registration)" : ""}` };
  }
  return { ok: true, target: { path: forgeConfigPaths({ projectDir: anchor }).project, observedLocation: location, anchor, creatable: true } };
}
function reverifyConfigTarget(acc, observedLocation, req) {
  try {
    const r = resolveConfigTarget(acc, observedLocation, { scope: req.scope, sessionID: req.sessionID });
    if (!r.ok)
      return false;
    const t = r.target;
    if (!acc.samePath(t.path, req.path))
      return false;
    if (!sameOptionalPath(t.observedLocation, req.observedLocation, acc))
      return false;
    if (!sameOptionalPath(t.anchor, req.anchor, acc))
      return false;
    if (req.scope === "workspace" && t.creatable && !acc.knownWorkspaceRoot(t.anchor ?? ""))
      return false;
    return true;
  } catch {
    return false;
  }
}
function sameOptionalPath(a, b, acc) {
  if (a === null || b === null)
    return a === b;
  return acc.samePath(a, b);
}
function hostStat(path) {
  return defaultIdentityStat(path);
}
function createConfigRpcHostDeps(acc, opts = {}) {
  const observedLocation = opts.observedLocation ?? null;
  const resolver = (req) => resolveConfigTarget(acc, observedLocation, req);
  const reverify = (req) => reverifyConfigTarget(acc, observedLocation, req);
  const fs = { stat: hostStat, ...opts.fs };
  return {
    clock: opts.clock ?? (() => Date.now()),
    randomId: opts.randomId,
    hash: opts.hash,
    epoch: currentConfigRpcEpoch,
    resolver,
    reverify,
    ttlMs: opts.ttlMs,
    limits: opts.limits,
    fs,
    beforeCommit: opts.beforeCommit
  };
}

// src/config-rpc-sync.ts
import { createHash as createHash3, randomUUID as randomUUID3 } from "node:crypto";
import { normalize as normalize2, resolve as resolvePath } from "node:path";

// src/family-sync.ts
function selectFamilyPlans(plans, familyFile) {
  return { plans: plans.filter((p) => p.family.file === familyFile) };
}
function findFamily(resolution, familyFile) {
  return resolution.families.find((f) => f.file === familyFile) ?? null;
}
function canonicalJson(v) {
  if (v === undefined)
    return "null";
  if (v === null || typeof v !== "object")
    return JSON.stringify(v) ?? "null";
  if (Array.isArray(v))
    return `[${v.map(canonicalJson).join(",")}]`;
  const rec = v;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
}
function familyProjectionSnapshot(resolution) {
  const ownerByMatId = {};
  const contentByMatId = {};
  for (const family of resolution.families) {
    for (const matId of family.materializedIds) {
      ownerByMatId[matId] = family.file;
      contentByMatId[matId] = canonicalJson(resolution.agents[matId] ?? null);
    }
  }
  return { ownerByMatId, contentByMatId };
}
function baselineSnapshotOf(resolution) {
  return {
    ...familyProjectionSnapshot(resolution),
    collisionFindings: resolution.findings.filter((f) => f.code === "materialized-id-collision").map((f) => f.message)
  };
}
function collisionFindings(resolution, familyFile) {
  return resolution.findings.filter((f) => f.code === "materialized-id-collision" && f.message.includes(familyFile)).map((f) => f.message);
}
function projectionDiffConflicts(beforeSnap, after, selected) {
  const conflicts = [];
  const afterSnap = familyProjectionSnapshot(after);
  const ids = new Set([...Object.keys(beforeSnap.ownerByMatId), ...Object.keys(afterSnap.ownerByMatId)]);
  for (const matId of ids) {
    const beforeOwner = beforeSnap.ownerByMatId[matId];
    const afterOwner = afterSnap.ownerByMatId[matId];
    const beforeContent = beforeSnap.contentByMatId[matId];
    const afterContent = afterSnap.contentByMatId[matId];
    if (beforeOwner !== undefined && afterOwner === undefined) {
      if (beforeOwner !== selected) {
        conflicts.push(`materialized id "${matId}" (forge-${matId}) is no longer materialized — family ${beforeOwner}'s projection needs GC/reconciliation outside the selected family`);
      }
      continue;
    }
    if (beforeOwner === undefined && afterOwner !== undefined) {
      if (afterOwner !== selected) {
        conflicts.push(`materialized id "${matId}" (forge-${matId}) is newly materialized by family ${afterOwner} — a family-scoped sync never writes another family's projection`);
      }
      continue;
    }
    if (beforeOwner !== afterOwner) {
      const other = beforeOwner !== selected ? beforeOwner : afterOwner;
      conflicts.push(`materialized id "${matId}" (forge-${matId}) winner moved from ${String(beforeOwner)} to ${String(afterOwner)} — family ${String(other)}'s projection needs reconciliation outside the selected family`);
      continue;
    }
    if (beforeContent !== afterContent && afterOwner !== selected) {
      conflicts.push(`materialized id "${matId}" (forge-${matId}) projection content changed inside family ${afterOwner} — a family-scoped sync never rewrites another family's projection`);
    }
  }
  return conflicts;
}
function crossFamilyWinnerConflictsFromBaseline(before, after, familyFile) {
  if (before === null) {
    return [...collisionFindings(after, familyFile), "cross-family winner drift cannot be ruled out (no pre-save baseline to diff) — application must stay unconfirmed"];
  }
  const seen = new Set(before.collisionFindings);
  const conflicts = after.findings.filter((f) => f.code === "materialized-id-collision" && f.message.includes(familyFile) && !seen.has(f.message)).map((f) => f.message);
  conflicts.push(...projectionDiffConflicts(before, after, familyFile));
  return conflicts;
}

// src/config-rpc-sync.ts
var DEFAULT_TTL_MS = 5 * 60 * 1000;
var DEFAULT_MAX_TOKENS = 64;
var foldPathOf = (p) => process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
var sha256 = (text) => createHash3("sha256").update(text, "utf8").digest("hex");
function canonicalJson2(v) {
  if (v === undefined)
    return "null";
  if (v === null || typeof v !== "object")
    return JSON.stringify(v) ?? "null";
  if (Array.isArray(v))
    return `[${v.map(canonicalJson2).join(",")}]`;
  const rec = v;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson2(rec[k])}`).join(",")}}`;
}
var SYNC_INPUT_KEYS = new Set(["scope", "sessionID", "confirm", "action", "token", "commitId"]);
function validateInput(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "malformed sync request — expected an object" } };
  }
  const rec = raw;
  for (const key of Object.keys(rec)) {
    if (!SYNC_INPUT_KEYS.has(key)) {
      return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: `unknown sync request field "${key}" — the sync surface accepts exactly scope/sessionID/confirm/action/token/commitId` } };
    }
  }
  const scope = rec.scope;
  if (scope !== "workspace" && scope !== "global") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync scope must be "workspace" or "global"' } };
  }
  const sessionID = rec.sessionID;
  if (sessionID !== null && typeof sessionID !== "string") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync sessionID must be a string or exactly null" } };
  }
  const action = rec.action;
  if (action !== "prepare" && action !== "apply") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync action must be "prepare" or "apply"' } };
  }
  if (typeof rec.confirm !== "boolean") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync confirm must be a boolean" } };
  }
  if (action === "prepare" && rec.confirm !== false) {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync prepare is pure read — confirm must be false; run action "apply" with confirm true to execute' } };
  }
  if (action === "apply") {
    if (rec.confirm !== true) {
      return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync apply requires confirm === true — an unconfirmed plan is never executed" } };
    }
    if (typeof rec.token !== "string" || rec.token.length === 0) {
      return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: 'sync apply requires the token returned by action "prepare"' } };
    }
  }
  if (rec.token !== undefined && typeof rec.token !== "string") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync token must be a string when present" } };
  }
  if (rec.commitId !== undefined && typeof rec.commitId !== "string") {
    return { refuse: { ok: false, action: "unknown", reason: "invalid-input", message: "sync commitId must be a string when present" } };
  }
  return {
    input: {
      scope,
      sessionID,
      confirm: rec.confirm,
      action,
      token: typeof rec.token === "string" ? rec.token : undefined,
      commitId: typeof rec.commitId === "string" ? rec.commitId : undefined
    }
  };
}
function planFingerprintOf(plans, hash2) {
  const surface = plans.map((p) => p.kind === "family" ? { kind: p.kind, family: { file: p.family.file, ns: p.family.ns, materializedIds: p.family.materializedIds }, dir: p.dir, files: p.files.map((f) => ({ matId: f.matId, fileName: f.fileName, content: f.content })) } : { kind: p.kind, dir: p.dir, files: p.files.map((f) => ({ fileName: f.fileName, content: f.content })) });
  return hash2(canonicalJson2(surface));
}
function recipeUsableFor(resolution, file2, stat) {
  if ((stat ?? (() => null))(file2) === null)
    return false;
  return !resolution.findings.some((f) => (f.code === "config-parse-error" || f.code === "config-not-object") && f.message.startsWith(`${file2}:`));
}
function planFamilySync(resolution, familyFile, dirs, opts) {
  const plans = selectFamilyPlans(planRosterSync(resolution, { globalPoolFile: dirs.globalPoolFile, globalAgentDir: dirs.globalAgentDir, platform: opts?.platform }), familyFile).plans;
  if (foldPathOf(familyFile) === foldPathOf(dirs.globalPoolFile)) {
    const overridePlan = planOverrideSync(resolution.overrides ?? {}, { dir: dirs.globalAgentDir, recipeFile: dirs.globalPoolFile });
    plans.push(overridePlan ?? { kind: "override", dir: dirs.globalAgentDir, files: [] });
  }
  return plans;
}
function joinPath2(dir, name) {
  const sep3 = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep3) ? `${dir}${name}` : `${dir}${sep3}${name}`;
}
function previewOpOf(plan, dest, content, fs) {
  let existing = null;
  try {
    if ((fs.stat ?? (() => null))(dest) !== null)
      existing = fs.readFile ? fs.readFile(dest) : null;
  } catch {
    existing = null;
  }
  if (existing === null)
    return { op: "create" };
  const same = plan.kind === "family" ? existing.replace(/\r\n/g, `
`) === content.replace(/\r\n/g, `
`) : existing === content;
  return { op: same ? "unchanged" : "update" };
}
function gcCandidatesForPlan(plan, fs) {
  const wanted = new Set(plan.files.map((f) => f.fileName));
  const gcEligible = (name) => {
    if (!name.endsWith(".md"))
      return false;
    if (plan.kind === "override")
      return name === "general.md" || name === "explore.md";
    return name.startsWith("forge-");
  };
  const out = [];
  let listing = null;
  try {
    listing = fs.readdir ? fs.readdir(plan.dir) : null;
  } catch {
    listing = null;
  }
  if (listing === null)
    return out;
  for (const name of listing) {
    if (!gcEligible(name))
      continue;
    if (wanted.has(name))
      continue;
    const dest = joinPath2(plan.dir, name);
    let marked = false;
    try {
      marked = (fs.readFile ? fs.readFile(dest) : "").includes("<!-- GENERATED BY forge_sync");
    } catch {
      marked = false;
    }
    if (!marked)
      continue;
    out.push({ nativeId: nativeIdOfFileName(name), dest });
  }
  return out;
}
function nativeIdOfFileName(name) {
  return name.replace(/\.md$/, "");
}
function nativeIdOfPlanFile(plan, file2) {
  if (plan.kind === "family" && typeof file2.matId === "string")
    return `forge-${file2.matId}`;
  return file2.fileName.replace(/\.md$/, "");
}
function canonicalPathOf(p) {
  return foldPathOf(normalize2(resolvePath(p)));
}
function directoryOverlapConflicts(resolution, selectedPlans, familyFile, dirs) {
  const selectedDirs = new Set(selectedPlans.map((p) => canonicalPathOf(p.dir)));
  const conflicts = [];
  for (const p of planRosterSync(resolution, { globalPoolFile: dirs.globalPoolFile, globalAgentDir: dirs.globalAgentDir })) {
    if (p.kind !== "family")
      continue;
    if (canonicalPathOf(p.family.file) === canonicalPathOf(familyFile))
      continue;
    if (selectedDirs.has(canonicalPathOf(p.dir))) {
      conflicts.push(`unselected family ${p.family.file} shares the artifact directory of the selected sync (${p.dir}) — a family-scoped sync would garbage-collect another family's projection; use the host-wide sync instead`);
    }
  }
  return conflicts;
}
function compiledBodyOf(content) {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  if (m === null)
    return null;
  return content.slice(m[0].length).replace(/^\r?\n/, "").replace(/\r\n/g, `
`);
}
function modelStringFromContent(content) {
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  if (fm === null)
    return;
  const m = /^model: ("((?:[^"\\]|\\.)*)"|(.+))$/m.exec(fm[0]);
  if (m === null)
    return;
  if (m[2] !== undefined)
    return JSON.parse(`"${m[2]}"`);
  return m[3]?.trim();
}
function compiledPermissionFaceOf(content) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (fm === null)
    return null;
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => l === "permissions:");
  if (start >= 0) {
    const out = {};
    for (let i = start + 1;i < lines.length; i++) {
      const action = /^ {2}- action: ("(?:[^"\\]|\\.)*")$/.exec(lines[i]);
      if (action === null)
        break;
      const resource = /^ {4}resource: ("(?:[^"\\]|\\.)*")$/.exec(lines[i + 1] ?? "");
      const effect = /^ {4}effect: ("(?:[^"\\]|\\.)*")$/.exec(lines[i + 2] ?? "");
      if (resource === null || effect === null)
        return null;
      if (JSON.parse(resource[1]) !== "*")
        return null;
      out[JSON.parse(action[1])] = JSON.parse(effect[1]);
      i += 2;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  const toolsStart = lines.findIndex((l) => l === "tools:");
  if (toolsStart >= 0) {
    const out = {};
    for (let i = toolsStart + 1;i < lines.length; i++) {
      const entry = /^ {2}([A-Za-z0-9_]+): (true|false)$/.exec(lines[i]);
      if (entry === null)
        break;
      out[entry[1]] = entry[2] === "false" ? "deny" : "allow";
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}
function modelObserved(expected, rowModel) {
  if (expected === undefined)
    return rowModel === undefined || rowModel === null || rowModel === "";
  const hash2 = expected.indexOf("#");
  const base = hash2 < 0 ? expected : expected.slice(0, hash2);
  const variant = hash2 < 0 ? undefined : expected.slice(hash2 + 1);
  if (typeof rowModel === "string") {
    const at = rowModel.indexOf("#");
    const rowBase = at < 0 ? rowModel : rowModel.slice(0, at);
    const rowVariant = at < 0 ? undefined : rowModel.slice(at + 1);
    return rowBase === base && (variant === undefined ? rowVariant === undefined || rowVariant === "" : rowVariant === variant);
  }
  if (rowModel !== null && typeof rowModel === "object") {
    const rec = rowModel;
    const modelId = typeof rec.id === "string" ? rec.id : typeof rec.modelID === "string" ? rec.modelID : undefined;
    if (typeof rec.providerID === "string" && typeof modelId === "string") {
      if (`${rec.providerID}/${modelId}` !== base)
        return false;
      const rowVariant = typeof rec.variant === "string" && rec.variant !== "" ? rec.variant : undefined;
      return variant === rowVariant;
    }
  }
  return false;
}
function normalizeRuleset(rowPermissions) {
  if (Array.isArray(rowPermissions)) {
    const rules = [];
    for (const entry of rowPermissions) {
      if (entry === null || typeof entry !== "object")
        return null;
      const rec = entry;
      if (typeof rec.action !== "string" || typeof rec.effect !== "string")
        return null;
      rules.push({ action: rec.action, resource: typeof rec.resource === "string" ? rec.resource : undefined, effect: rec.effect });
    }
    return rules;
  }
  if (rowPermissions !== null && typeof rowPermissions === "object") {
    const rec = rowPermissions;
    if (!Object.values(rec).every((v) => typeof v === "string"))
      return null;
    return Object.entries(rec).map(([action, effect]) => ({ action, effect }));
  }
  return null;
}
function permissionAliasesOf(action) {
  if (action === "task")
    return ["task", "subagent"];
  if (action === "bash")
    return ["bash", "shell"];
  return [action];
}
function permissionsObserved(face, rowPermissions) {
  if (face === null)
    return true;
  const rules = normalizeRuleset(rowPermissions);
  if (rules === null)
    return false;
  for (const [action, effect] of Object.entries(face)) {
    const names = permissionAliasesOf(action);
    let globalEffective;
    let globalSeen = false;
    let proofValid = true;
    for (const rule of rules) {
      if (rule.action !== "*" && !names.includes(rule.action))
        continue;
      if (rule.resource === undefined || rule.resource === "*") {
        globalSeen = true;
        globalEffective = rule.effect;
        proofValid = true;
      } else if (globalSeen && rule.effect !== globalEffective) {
        proofValid = false;
      }
    }
    if (!globalSeen || !proofValid || globalEffective !== effect)
      return false;
  }
  return true;
}
function createConfigRpcSyncHandler(deps) {
  const now = deps.clock ?? (() => Date.now());
  const randomId = deps.randomId ?? (() => randomUUID3());
  const hash2 = deps.hash ?? sha256;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const tokens = new Map;
  const sweep = () => {
    const t = now();
    const cur = deps.epoch();
    for (const [id, entry] of tokens) {
      if (t > entry.expiresAt || entry.epoch.epoch !== cur.epoch || entry.epoch.generation !== cur.generation)
        tokens.delete(id);
    }
  };
  const sameBinding = (a, b) => a === null || b === null ? a === b : foldPathOf(a) === foldPathOf(b);
  const baselineFor = (commitId) => {
    if (typeof deps.getCommitContext !== "function")
      return null;
    let ctx;
    try {
      ctx = deps.getCommitContext(commitId);
    } catch {
      return null;
    }
    if (!ctx.found)
      return null;
    return readBaselineShape(ctx.context);
  };
  function readBaselineShape(raw) {
    if (raw === null || typeof raw !== "object")
      return null;
    const rec = raw;
    if (rec.v !== 1 || rec.coverage !== "full" && rec.coverage !== "unknown")
      return null;
    if (typeof rec.ownerFile !== "string" || rec.ownerFile === "")
      return null;
    const before = rec.before;
    if (before === null || typeof before !== "object" || typeof before.ownerByMatId !== "object" || typeof before.contentByMatId !== "object" || !Array.isArray(before.collisionFindings))
      return null;
    return {
      v: 1,
      at: typeof rec.at === "number" ? rec.at : 0,
      coverage: rec.coverage,
      reason: typeof rec.reason === "string" ? rec.reason : undefined,
      ownerFile: rec.ownerFile,
      anchor: rec.anchor === null || typeof rec.anchor === "string" ? rec.anchor : null,
      observedLocation: rec.observedLocation === null || typeof rec.observedLocation === "string" ? rec.observedLocation : null,
      familyNs: rec.familyNs === null || typeof rec.familyNs === "string" ? rec.familyNs : null,
      materializedIds: Array.isArray(rec.materializedIds) ? rec.materializedIds.filter((x) => typeof x === "string") : [],
      before
    };
  }
  const buildPreview = (raw) => {
    const fs = deps.rosterFs();
    const snapshot = deps.resolvePools();
    if (snapshot === null) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "no-coverage", message: "the host's authoritative anchor registry cannot resolve a full pool picture — sync is refused rather than answered from a partial set; initialize the workspace (or retry once the host has seen it)" } };
    }
    const resolution = snapshot.resolution;
    const resolved = deps.resolveScope({ scope: raw.scope, sessionID: raw.sessionID });
    if (!resolved.ok) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "scope-unresolved", message: resolved.message } };
    }
    const familyFile = resolved.target.path;
    const dirs = deps.rosterDirs();
    const globalFile = dirs.globalPoolFile;
    const isGlobalFamily = foldPathOf(familyFile) === foldPathOf(globalFile);
    if (!recipeUsableFor(resolution, familyFile, fs.stat)) {
      const exists = (fs.stat ?? (() => null))(familyFile) !== null;
      return { ok: false, output: { ok: false, action: "prepare", reason: exists ? "recipe-unusable" : "stale-preview", message: exists ? `${familyFile} does not parse — broken documents are disclosed, never synced in place; fix the syntax first` : `${familyFile} is absent — nothing to project for this scope${resolved.target.creatable ? " (creating it is an edit-path save, not a sync)" : ""}` } };
    }
    const family = findFamily(resolution, familyFile);
    const plans = planFamilySync(resolution, familyFile, dirs);
    const overlaps = directoryOverlapConflicts(resolution, plans, familyFile, dirs);
    if (overlaps.length > 0) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "directory-conflict", message: overlaps.join("; ") } };
    }
    const findings = resolution.findings.filter((f) => f.level === "warn" || f.level === "error").map((f) => ({ level: f.level, code: f.code, message: f.message }));
    const familyBytes = snapshot.readOf(familyFile);
    if (familyBytes === null) {
      return { ok: false, output: { ok: false, action: "prepare", reason: "recipe-unusable", message: `${familyFile} was not part of the authoritative resolution's reads — refusing rather than hashing a second read of possibly different bytes` } };
    }
    const contentHash = hash2(familyBytes);
    const files = [];
    const summary = [];
    for (const plan of plans) {
      for (const file2 of plan.files) {
        const dest = joinPath2(plan.dir, file2.fileName);
        const { op } = previewOpOf(plan, dest, file2.content, fs);
        files.push({ nativeId: nativeIdOfPlanFile(plan, file2), fileName: file2.fileName, dest, op });
        if (op !== "unchanged")
          summary.push(`${op}: ${dest}`);
      }
    }
    const gc = plans.flatMap((p) => gcCandidatesForPlan(p, fs));
    for (const g of gc)
      summary.push(`gc: ${g.dest} (${g.nativeId})`);
    const preview = {
      path: familyFile,
      scope: raw.scope,
      sessionID: raw.sessionID,
      observedLocation: resolved.target.observedLocation,
      anchor: resolved.target.anchor,
      family: family === null ? null : { file: family.file, ns: family.ns, materializedIds: [...family.materializedIds] },
      overridesIncluded: isGlobalFamily,
      files,
      gc,
      coverage: "full",
      summary,
      findings
    };
    return { ok: true, preview, plans, familyFile, contentHash, fingerprint: planFingerprintOf(plans, hash2), gcFingerprint: hash2(canonicalJson2(gc)), gc, snapshot };
  };
  const savedBaselineConflict = (commitId, familyFile, snap) => {
    const baseline = baselineFor(commitId);
    if (baseline === null) {
      return { ok: false, reason: "no-coverage", message: `the commit baseline for ${commitId} is unknown, evicted or malformed — whether that save wrote is UNKNOWN and a dependent sync is refused with zero writes; re-run the save flow, or sync current state standalone (without commitId)` };
    }
    if (baseline.coverage !== "full") {
      return { ok: false, reason: "no-coverage", message: `the save's pre-publish baseline is not a full resolution (${baseline.reason ?? "unknown coverage"}) — dependent sync refused with zero writes` };
    }
    if (foldPathOf(baseline.ownerFile) !== foldPathOf(familyFile)) {
      return { ok: false, reason: "scope-mismatch", message: `the owning family moved after the confirmed save (baseline owner ${baseline.ownerFile} vs resolved ${familyFile}) — a sync must never follow a new owner the human did not confirm; re-open the editor` };
    }
    const flips = crossFamilyWinnerConflictsFromBaseline(baseline.before, snap.resolution, familyFile);
    if (flips.length > 0) {
      return { ok: false, reason: "directory-conflict", message: `the save changed cross-family collision winners — family-scoped sync refused before any write (zero artifact writes): ${flips.join("; ")}; the explicit host-wide sync is the recovery lever` };
    }
    return { ok: true };
  };
  const prepare = (input) => {
    sweep();
    if (input.commitId !== undefined && typeof deps.getCommitContext === "function") {
      let found = false;
      try {
        found = deps.getCommitContext(input.commitId).found === true;
      } catch {
        found = false;
      }
      if (!found) {
        return { ok: false, action: "prepare", reason: "no-coverage", message: `the commit ${input.commitId} this sync would correlate to has no retained pre-save context — the save's evidence is missing (never reconstructed); run the save flow again, or sync current state standalone (without commitId)` };
      }
    }
    const built = buildPreview(input);
    if (!built.ok)
      return built.output;
    const cur = deps.epoch();
    const t = now();
    if (input.commitId !== undefined) {
      const baseline = savedBaselineConflict(input.commitId, built.familyFile, built.snapshot);
      if (!baseline.ok)
        return { ok: false, action: "prepare", reason: baseline.reason, message: baseline.message };
    }
    if (built.preview.files.every((f) => f.op === "unchanged") && built.gc.length === 0) {
      return { ok: true, action: "prepare", outcome: "noop", preview: built.preview, findings: built.preview.findings };
    }
    const token = `synctok-${randomId()}`;
    const entry = {
      token,
      scope: input.scope,
      sessionID: input.sessionID,
      observedLocation: built.preview.observedLocation,
      anchor: built.preview.anchor,
      familyFile: built.familyFile,
      contentHash: built.contentHash,
      planFingerprint: built.fingerprint,
      gcFingerprint: built.gcFingerprint,
      commitId: input.commitId,
      epoch: { ...cur },
      createdAt: t,
      expiresAt: t + ttlMs,
      spent: false
    };
    if (tokens.size >= maxTokens && !tokens.has(token)) {
      const oldest = tokens.keys().next();
      if (!oldest.done)
        tokens.delete(oldest.value);
    }
    tokens.set(token, entry);
    return {
      ok: true,
      action: "prepare",
      outcome: "token",
      token: { token, expiresAt: entry.expiresAt, epoch: cur.epoch, generation: cur.generation },
      preview: built.preview,
      findings: built.preview.findings
    };
  };
  const apply = async (input) => {
    const fail = (reason, message) => ({ ok: false, action: "apply", reason, message });
    const entry = typeof input.token === "string" ? tokens.get(input.token) : undefined;
    if (entry === undefined) {
      sweep();
      return fail("token-unknown", "unknown sync token — nothing was executed; run a fresh prepare against current content");
    }
    const pre = deps.epoch();
    if (entry.epoch.epoch !== pre.epoch || entry.epoch.generation !== pre.generation) {
      tokens.clear();
      return fail("epoch-stale", "the server epoch or RPC registration generation changed — every sync token issued before it is refused; re-prepare");
    }
    const tPre = now();
    if (tPre > entry.expiresAt) {
      tokens.delete(entry.token);
      return fail("token-expired", "the sync token expired — nothing was executed; run a fresh prepare (no auto-renewal)");
    }
    if (entry.spent)
      return fail("token-spent", "the sync token was already used — at most one execution per token; run a fresh prepare to retry");
    if (input.scope !== entry.scope || input.sessionID !== entry.sessionID) {
      return fail("scope-mismatch", "the request's scope/sessionID do not exactly match the sync token binding — nothing was executed");
    }
    if ((input.commitId ?? null) !== (entry.commitId ?? null)) {
      return fail("invalid-input", input.commitId === undefined ? `this sync token was prepared as a DEPENDENT sync of commit ${entry.commitId} — the apply must carry the same commitId (the correlation is part of the token binding)` : `the apply carries commitId ${input.commitId} but its prepare bound ${entry.commitId === undefined ? "no commitId" : entry.commitId} — a sync cannot correlate to a receipt its prepare never bound; re-prepare with the commitId to run the baseline-checked dependent sync`);
    }
    const resolved = deps.resolveScope({ scope: entry.scope, sessionID: entry.sessionID });
    if (!resolved.ok)
      return fail("scope-unresolved", resolved.message);
    if (foldPathOf(resolved.target.path) !== foldPathOf(entry.familyFile) || !sameBinding(resolved.target.observedLocation, entry.observedLocation) || !sameBinding(resolved.target.anchor, entry.anchor)) {
      return fail("scope-mismatch", "the target no longer resolves under the sync token binding (owner, path, session location or anchor changed) — re-prepare against current state");
    }
    const preSnap = deps.resolvePools();
    if (preSnap === null)
      return fail("no-coverage", "the host's authoritative anchor registry cannot resolve a full pool picture — sync is refused (no partial-set execution)");
    const commitEvidence = (commitId) => {
      if (typeof deps.getCommitContext !== "function") {
        return { ok: false, message: `the sync correlates to commit ${commitId} but no commit-context seam is available — whether that save wrote is UNKNOWN; refused with zero writes` };
      }
      let found = false;
      try {
        found = deps.getCommitContext(commitId).found === true;
      } catch {
        found = false;
      }
      if (!found) {
        return { ok: false, message: `the commit ${commitId} this sync correlates to has no retained pre-save context (evicted, cross-epoch or unknown) — whether that save wrote is UNKNOWN; the correlated sync is refused with zero writes (re-run the save flow to re-establish evidence)` };
      }
      return { ok: true };
    };
    if (typeof input.commitId === "string") {
      const evidence = commitEvidence(input.commitId);
      if (!evidence.ok)
        return fail("no-coverage", evidence.message);
    }
    const verifyState = (snap) => {
      const fs = deps.rosterFs();
      const res = snap.resolution;
      const family = findFamily(res, entry.familyFile);
      if (family === null)
        return { ok: false, reason: "stale-preview", message: `${entry.familyFile} no longer materializes as the owning family — re-prepare against current state` };
      const dirs = deps.rosterDirs();
      const plans = planFamilySync(res, entry.familyFile, dirs);
      const overlaps = directoryOverlapConflicts(res, plans, entry.familyFile, dirs);
      if (overlaps.length > 0)
        return { ok: false, reason: "directory-conflict", message: overlaps.join("; ") };
      if (planFingerprintOf(plans, hash2) !== entry.planFingerprint)
        return { ok: false, reason: "stale-preview", message: "the planned projection changed since prepare — re-prepare against current content (a saved patch is never replayed)" };
      const gc = plans.flatMap((p) => gcCandidatesForPlan(p, fs));
      if (hash2(canonicalJson2(gc)) !== entry.gcFingerprint)
        return { ok: false, reason: "stale-preview", message: "the garbage-collection candidates changed since prepare — re-prepare against current state" };
      const familyBytes = snap.readOf(entry.familyFile);
      if (familyBytes === null)
        return { ok: false, reason: "recipe-unusable", message: `${entry.familyFile} was not part of the authoritative resolution's reads — refusing rather than hashing a second read of possibly different bytes` };
      if (hash2(familyBytes) !== entry.contentHash)
        return { ok: false, reason: "stale-preview", message: `${entry.familyFile} changed since prepare — re-prepare against current content` };
      return { ok: true, plans, gc };
    };
    const preState = verifyState(preSnap);
    if (!preState.ok)
      return fail(preState.reason, preState.message);
    const preBaseline = entry.commitId === undefined ? { ok: true } : savedBaselineConflict(entry.commitId, entry.familyFile, preSnap);
    if (!preBaseline.ok)
      return fail(preBaseline.reason, preBaseline.message);
    const execResult = await withCommitLock(entry.familyFile, async () => {
      const cur = deps.epoch();
      if (entry.epoch.epoch !== cur.epoch || entry.epoch.generation !== cur.generation) {
        tokens.clear();
        return fail("epoch-stale", "the epoch or registration generation changed while the apply was pending — refused, nothing was executed");
      }
      const t2 = now();
      if (t2 > entry.expiresAt) {
        tokens.delete(entry.token);
        return fail("token-expired", "the sync token expired while the apply was pending — nothing was executed; re-prepare (no auto-renewal)");
      }
      if (entry.spent)
        return fail("token-spent", "the sync token was used by a competing apply — at most one execution per token");
      if (input.scope !== entry.scope || input.sessionID !== entry.sessionID) {
        return fail("scope-mismatch", "the request's scope/sessionID stopped matching the sync token binding — nothing was executed");
      }
      const inLockScope = deps.resolveScope({ scope: entry.scope, sessionID: entry.sessionID });
      if (!inLockScope.ok || foldPathOf(inLockScope.target.path) !== foldPathOf(entry.familyFile) || !sameBinding(inLockScope.target.observedLocation, entry.observedLocation) || !sameBinding(inLockScope.target.anchor, entry.anchor)) {
        return fail("scope-mismatch", "the binding re-resolution changed while the apply was pending — refused, nothing was executed; re-prepare");
      }
      const snap = deps.resolvePools();
      if (snap === null)
        return fail("no-coverage", "coverage became unresolvable while the apply was pending — refused, nothing was executed");
      const inLock = verifyState(snap);
      if (!inLock.ok)
        return fail(inLock.reason, inLock.message);
      const inLockBaseline = entry.commitId === undefined ? { ok: true } : savedBaselineConflict(entry.commitId, entry.familyFile, snap);
      if (!inLockBaseline.ok)
        return fail(inLockBaseline.reason, inLockBaseline.message);
      if (typeof input.commitId === "string") {
        const inLockEvidence = commitEvidence(input.commitId);
        if (!inLockEvidence.ok)
          return fail("no-coverage", `${inLockEvidence.message} (re-checked inside the commit lock before any write)`);
      }
      entry.spent = true;
      const outcome = executeRosterSync(inLock.plans, deps.rosterFs());
      const after = deps.resolvePools();
      const conflicts = after === null ? ["post-sync coverage could not be re-resolved — application stays unconfirmed"] : crossFamilyWinnerConflictsFromBaseline(baselineSnapshotOf(snap.resolution), after.resolution, entry.familyFile);
      const removedIds = outcome.gced.map((dest) => nativeIdOfFileName(dest.split(/[\\/]/).pop() ?? dest));
      const changedNative = [];
      for (const p of inLock.plans) {
        if (p.kind === "family") {
          for (const f of p.files) {
            const dest = joinPath2(p.dir, f.fileName);
            if (!outcome.created.includes(dest) && !outcome.updated.includes(dest))
              continue;
            changedNative.push({ plan: p, fileName: f.fileName, matId: f.matId, content: f.content });
          }
        } else {
          for (const f of p.files) {
            const dest = joinPath2(p.dir, f.fileName);
            if (!outcome.created.includes(dest) && !outcome.updated.includes(dest))
              continue;
            changedNative.push({ plan: p, fileName: f.fileName, content: f.content });
          }
        }
      }
      const summary = [
        ...outcome.created.map((d) => `created: ${d}`),
        ...outcome.updated.map((d) => `updated: ${d}`),
        ...outcome.unchanged.length ? [`unchanged: ${outcome.unchanged.length} file(s) already current`] : [],
        ...outcome.gced.length ? [`gc'd: ${outcome.gced.join(", ")}`] : [],
        ...outcome.errors.length ? [`errors: ${outcome.errors.join("; ")}`] : [],
        ...conflicts.length ? [`conflicts (disclosed, not reconciled): ${conflicts.join("; ")}`] : []
      ];
      const findings = after === null ? [] : after.resolution.findings.filter((f) => f.level === "warn" || f.level === "error").map((f) => ({ level: f.level, code: f.code, message: f.message }));
      const refOf = new Map;
      for (const p of inLock.plans) {
        for (const f of p.files)
          refOf.set(joinPath2(p.dir, f.fileName), { nativeId: nativeIdOfPlanFile(p, f), fileName: f.fileName });
      }
      const refFor = (dest) => {
        const hit = refOf.get(dest);
        if (hit !== undefined)
          return hit;
        const fileName = dest.split(/[\\/]/).pop() ?? dest;
        return { nativeId: nativeIdOfFileName(fileName), fileName };
      };
      const createdRefs = outcome.created.map(refFor);
      const updatedRefs = outcome.updated.map(refFor);
      const errorItems = outcome.errors.map((message) => {
        const hit = [...refOf.keys()].find((d) => message.startsWith(`${d}:`));
        return hit === undefined ? { message } : { message, ...refOf.get(hit) };
      });
      const conflictItems = conflicts.map((message) => ({ message }));
      const base = {
        ok: true,
        action: "apply",
        path: entry.familyFile,
        scope: entry.scope,
        sessionID: entry.sessionID,
        created: createdRefs,
        updated: updatedRefs,
        unchanged: outcome.unchanged,
        gced: outcome.gced,
        errors: errorItems,
        removedIds,
        conflicts: conflictItems,
        summary,
        findings,
        epoch: cur.epoch,
        generation: cur.generation,
        at: t2
      };
      const changedIds = changedNative.map((c) => nativeIdOfPlanFile(c.plan, { matId: c.matId, fileName: c.fileName }));
      const erroredIds = [];
      for (const p of inLock.plans) {
        for (const f of p.files) {
          const dest = joinPath2(p.dir, f.fileName);
          if (outcome.created.includes(dest) || outcome.updated.includes(dest))
            continue;
          if (outcome.errors.some((e) => e.startsWith(`${dest}:`) || e.startsWith(`${dest}.new:`)))
            erroredIds.push(nativeIdOfPlanFile(p, f));
        }
      }
      if (conflicts.length > 0) {
        return { ...base, outcome: "conflict", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } };
      }
      if (outcome.errors.length > 0 && outcome.created.length === 0 && outcome.updated.length === 0 && outcome.gced.length === 0) {
        return { ...base, outcome: "refused", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [] } };
      }
      if (outcome.created.length === 0 && outcome.updated.length === 0 && outcome.gced.length === 0) {
        return { ...base, outcome: "noop", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [] } };
      }
      const observer = deps.listNativeAgents;
      if (typeof observer !== "function") {
        return { ...base, outcome: "unconfirmed", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } };
      }
      let rows2 = null;
      try {
        rows2 = await observer();
      } catch {
        rows2 = null;
      }
      if (rows2 === null) {
        return { ...base, outcome: "unconfirmed", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } };
      }
      const byId = new Map;
      for (const row of rows2) {
        if (row === null || typeof row !== "object" || typeof row.id !== "string" || row.id.trim() === "") {
          return { ...base, outcome: "unconfirmed", applied: false, appliedStatus: { status: "unconfirmed", observedBy: null, confirmedIds: [], removedConfirmedIds: [], unconfirmedIds: [...changedIds, ...erroredIds, ...removedIds] } };
        }
        byId.set(row.id, row);
      }
      const confirmedIds = [];
      const unconfirmedIds = [];
      for (const c of changedNative) {
        const nativeId = nativeIdOfPlanFile(c.plan, { matId: c.matId, fileName: c.fileName });
        const row = byId.get(nativeId);
        const observed = row !== undefined && modelObserved(modelStringFromContent(c.content), row.model) && systemObserved(compiledBodyOf(c.content), row.system) && permissionsObserved(compiledPermissionFaceOf(c.content), row.permissions);
        if (observed)
          confirmedIds.push(nativeId);
        else
          unconfirmedIds.push(nativeId);
      }
      const removedConfirmedIds = removedIds.filter((id) => !byId.has(id));
      const removedUnconfirmed = removedIds.filter((id) => byId.has(id));
      const allConfirmed = unconfirmedIds.length === 0 && removedUnconfirmed.length === 0 && erroredIds.length === 0 && outcome.errors.length === 0;
      return {
        ...base,
        outcome: allConfirmed ? "applied" : "unconfirmed",
        applied: allConfirmed,
        appliedStatus: {
          status: allConfirmed ? "applied" : "unconfirmed",
          observedBy: "host-agent-list",
          confirmedIds,
          removedConfirmedIds,
          unconfirmedIds: [...unconfirmedIds, ...erroredIds, ...removedUnconfirmed]
        }
      };
    });
    if (execResult === null) {
      return { ok: false, action: "apply", reason: "unavailable", message: "sync execution produced no verdict — nothing is claimed" };
    }
    if (execResult.ok && execResult.action === "apply" && typeof input.commitId === "string" && typeof deps.attachSyncOutcome === "function") {
      const appliedResult = execResult;
      let attached = false;
      try {
        attached = deps.attachSyncOutcome(input.commitId, {
          action: "sync",
          outcome: appliedResult.outcome,
          applied: appliedResult.applied,
          path: appliedResult.path,
          created: appliedResult.created,
          updated: appliedResult.updated,
          gced: appliedResult.gced,
          conflicts: appliedResult.conflicts,
          appliedStatus: appliedResult.appliedStatus,
          at: appliedResult.at
        });
      } catch {
        attached = false;
      }
      if (!attached) {
        appliedResult.summary.push(`note: the sync outcome could not be attached to receipt ${input.commitId} (unknown or evicted — the sync result above remains authoritative)`);
      }
    }
    return execResult;
  };
  return async (raw) => {
    const checked = validateInput(raw);
    if ("refuse" in checked)
      return checked.refuse;
    try {
      return checked.input.action === "prepare" ? prepare(checked.input) : await apply(checked.input);
    } catch (err) {
      return { ok: false, action: checked.input.action, reason: "unavailable", message: `sync ${checked.input.action} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}
function systemObserved(expected, rowSystem) {
  if (expected === null)
    return false;
  return typeof rowSystem === "string" && rowSystem === expected;
}
function captureSyncBaseline(req, resolvePools, clock) {
  const at = clock();
  const snap = resolvePools();
  if (snap === null) {
    return { v: 1, at, coverage: "unknown", reason: "no-coverage", ownerFile: req.ownerFile, anchor: req.anchor, observedLocation: req.observedLocation, familyNs: null, materializedIds: [], before: { ownerByMatId: {}, contentByMatId: {}, collisionFindings: [] } };
  }
  const family = findFamily(snap.resolution, req.ownerFile);
  return {
    v: 1,
    at,
    coverage: "full",
    ownerFile: req.ownerFile,
    anchor: req.anchor,
    observedLocation: req.observedLocation,
    familyNs: family?.ns ?? null,
    materializedIds: family ? [...family.materializedIds] : [],
    before: baselineSnapshotOf(snap.resolution)
  };
}

// plugin.ts
var FORGE_AGENT = "forge";
var FORGE_STATE_TOOLS = [
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
var FORGE_TOOL_SET = new Set(FORGE_STATE_TOOLS);
var FORGE_STATE_TOOL_SET = new Set(FORGE_STATE_TOOLS);
var FORGE_PROMPT = `You are forge — the single general-purpose coding agent. You handle every task directly: exploration, planning, implementation, and verification. There is no agent switching.

Workflow modes are strictly user-initiated. Never enter plan or goal mode — and never call a plan_* or goal_* tool — unless the user ran /plan or /goal, unmistakably asked for that mode (e.g. "plan first", "set a goal"), or the session already carries a [forge:plan-notice] / [forge:goal-notice] for a mode they started. Ordinary task requests are normal work. Mode-specific rules arrive with those commands and notices; when a notice is present, follow it.

Subagent dispatch (native \`subagent\` tool): when the work suits a scoped worker, prefer a configured \`forge-*\` subagent whose description matches the job. If none matches, say so plainly to the user and dispatch a host agent through the native \`subagent\` tool instead, subject to existing permissions and approvals. Native calls run in the background; use available host completion messages and session records as evidence, not repeated polling. Never assume unknown outcomes are settled. For ordinary commands, use the host shell when permitted; long commands can use \`background\` and host completion notifications rather than polling or sleeping. Git commits should use \`-m\` or \`--no-edit\`. Never create or edit files under .opencode/plan/ or .opencode/goal/ directly; use their state tools within the user-authorized mode.`;
var PLAN_COMMAND_TEMPLATE = [
  '(forge plan harness routing. Argument: "$ARGUMENTS")',
  "",
  "FAMILY GUARD (step 0, before anything else): if you do not have the plan_write tool in your available tools, you are not in a forge session — STOP now: execute nothing below (including the directory listing), and tell the user that /plan belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
  "",
  "Inspect the current .opencode/plan/ directory using read/glob when needed for routing; treat an absent directory as empty.",
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  "- Argument empty: for every non-terminal plan (status draft or approved) in that directory, read its frontmatter and numbered checkboxes, then report to the user: path, status, progress (x/y ticked). Ask whether to resume one or start something new.",
  '- Argument "resume": pick the most recently updated non-terminal plan, summarize its remaining unticked steps to the user in one short list, then continue according to its status: if draft, remain read-only and follow user review and approval below; if approved, execute the remaining steps — tick each step the moment it is done (plan_tick). If none exists, say so.',
  '- Argument "discard": call the plan_discard tool with a short reason, then tell the user the plan was abandoned and writes are restored. If the work is NOT ending but moving to another harness — crew orchestration (/crew) or a goal contract (/goal) — pass supersede with the successor artifact path (e.g. ".opencode/crew/2026-10-01-....md") so the plan is marked superseded instead, with the successor recorded in the plan file.',
  "- Any other argument: treat it as the plan goal — you are now in planning mode for this goal. Follow the plan discipline below end to end.",
  "",
  "## Plan discipline",
  "",
  "Plans are short-horizon, single-goal documents (.opencode/plan/<date>-<slug>.md). The harness enforces the hard parts (draft write-ban, approval gate, verification at close); you supply the engineering judgment. Never edit or create plan files by hand — every change goes through the plan_* tools.",
  "",
  "1. Reconnaissance and alignment (read-only): explore with read/grep/glob, and use the native subagent tool for breadth evidence from effective-readonly forge scouts both BEFORE and DURING the draft. Only dispatch workers with a current, compatible definition and effective host permissions that match an explicitly readonly recipe, deny all file-mutating tools (write/edit/patch family), and explicitly deny shell. Respect ordinary host permissions; if eligibility is unknown or denied, stay with permitted read tools and disclose the limitation. The host delivers the background scout's findings in its completion message. Remain read-only: all write tools and the builtin shell are DENIED while a draft exists (plan_* tools manage the plan). Write-shaped workers, readonly workers with shell, and non-forge agents must wait for approval; do not attempt them, do not ask the user to bypass. Gather concrete evidence with file:line references (verified findings, not guesses). If the goal is ambiguous or leaves meaningful choices open (scope, approach, acceptance), settle them with the user FIRST — 1-3 focused questions — and only write the draft once the shape is agreed; never plan against assumptions the user could settle in one line.",
  "2. Draft (plan_write): call plan_write with structured fields; the tool renders and validates the fixed sections, so a malformed plan cannot exist. Quality bar: goal = one line, the outcome not the activity; context = verified findings with file:line evidence, including what you ruled out and why; approach = the chosen approach AND at least one rejected alternative with the reason (a plan with no considered alternative is a guess); tasks = 3-8 concrete, independently verifiable steps, each doable in one sitting ('improve the code' is invalid; 'extract the timeout constant into config.ts and default it to 3000' is valid); risks = what could break, blast radius, rollback path; acceptance = criteria verifiable by a command, a file, or an observable behavior (vague criteria will fail the close); nonGoals = explicit out-of-scope items. To revise after feedback, call plan_write again — while in draft it overwrites the same file.",
  `3. User review, then approval (plan_approve): after plan_write, present the plan in chat — goal, chosen approach with one line why, the numbered steps, the acceptance criteria — then STOP: end your turn and wait. The user owns the review, at their own pace: feedback → revise with plan_write, re-present, and wait again; rejection → /plan discard (or re-plan together); explicit go-ahead (e.g. "execute", "批准", "looks good") → call plan_approve — its confirmation dialog is the final hard gate, and the user's Allow starts execution. Never call plan_approve in the same turn that presents a draft, and never implement before approval succeeds.`,
  "4. Execution (tick as you go): after approval succeeds, execute directly or dispatch via the native subagent tool, subject to ordinary host permissions. Work tasks in order; call plan_tick with the numbered step immediately after EACH step's work is actually done — never batch ticks, never tick ahead of reality (tick timestamps are an audit trail). If the plan turns out wrong mid-execution, do not silently improvise: tell the user what changed and either finish the affected step or ask about revising (/plan with the same goal re-enters planning).",
  "5. Completion (plan_close): when all tasks are ticked, self-check EVERY acceptance criterion with concrete evidence (file:line, command output, test result), then call plan_close — NO confirmation dialog appears. If the plan declares Verification Checks, the plugin itself re-runs the frozen check set on the host (fail-closed: a failing check refuses the close, records the run in the plan's Check Log, and the plan stays approved — that is the design working, not an inconvenience); otherwise your per-criterion self-checks gate the close. Either way an evidence summary is written into the plan file for the user to review asynchronously.",
  "",
  "Boundaries: /plan discard abandons the plan (terminal, file kept as history, writes restored) — pass supersede (the successor artifact path) when the work moves to crew/goal rather than ends, marking it superseded; /plan resume continues an unfinished plan from its remaining tasks. Work expected to span multiple sessions or days of multi-file change, or needing multi-round requirement review, is spec work (e.g. OpenSpec), not plan work — say so once and let the user choose.",
  ""
].join(`
`);
var GOAL_COMMAND_TEMPLATE = [
  '(forge goal harness routing. Argument: "$ARGUMENTS")',
  "",
  "FAMILY GUARD (step 0, before anything else): if you do not have the goal_write tool in your available tools, you are not in a forge session — STOP now: execute nothing below (including the directory listing), and tell the user that /goal belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
  "",
  "Current .opencode/goal/ directory:",
  "!`ls -1 .opencode/goal 2>/dev/null || echo '(empty)'`",
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  "- Argument empty: for every non-terminal goal in the directory above, read its frontmatter and report to the user: path, status (queued/active/paused + stop_reason), revision, turns_used/max_turns budget. Mention queued goals and the /goal next promotion option. Ask whether to resume/promote one or arm something new.",
  '- Argument "pause": call the goal_pause tool (with the blocker text as `blocker` when there is one), then tell the user the goal is paused, that already accepted work may finish, and how to resume.',
  `- Argument "resume": call the goal_resume tool for the session's paused goal (optionally with addTurns if the user asked for more budget). If no live goal exists but queued goals do, promote the oldest via goal_resume instead. The user confirms in a dialog.`,
  '- Argument "next": promote the oldest queued goal via the goal_resume tool (no live goal must remain). The user confirms in a dialog.',
  '- Argument "discard" (also "stop"/"cancel"/"off"): call the goal_discard tool. The user confirms in a dialog.',
  '- Argument starting with "add " (or the user clearly wants to queue without arming): create a NEW contract from the rest of the argument and call goal_write with arm=false — never revise an existing goal for an add, never omit arm. It becomes a queued, inert goal (no dialog).',
  '- Any other argument: treat it as a goal statement. Extract contract markers into the structured goal_write fields: --check "cmd" becomes a shell verification item, --contains "file::text" a file-contract item, --success "..." an extra success criterion, --constraint "..." goes into constraints, --non-goal "..." into nonGoals, --max-turns N and --max-minutes N set budgets. Draft a complete contract (goal, criteria, checks, constraints, non-goals), SHOW the verification items verbatim to the user, then call goal_write with arm=true — a confirmation dialog arms the autonomous loop. If this session already has a live goal, say so and offer revise/queue/discard instead.',
  "",
  "Goal files are host-managed: never edit or create anything under .opencode/goal/ by hand — contract changes go through goal_write (each revision bump invalidates evidence collected under earlier revisions), state changes through the goal_* tools. Likewise never enter the goal loop or call any goal_* tool unless the user ran /goal or explicitly asked for a goal loop.",
  ""
].join(`
`);
var GLOBAL_RECIPE_SCAFFOLD_JSONC = [
  "{",
  "  // GLOBAL forge.json — the machine-wide FALLBACK roster (sole ownership:",
  "  // the nearest .opencode/forge.json walking up from a session's worktree",
  "  // IS that session's whole roster when it exists; this layer is a",
  "  // fallback, never a merge). Agents here materialize as forge-global-<id>",
  "  // in the host's global agent dir once forge_sync runs.",
  '  "agents": {',
  '    // "research": { "model": "provider/model", "thoughtLevel": "low",',
  '    //   "shape": "readonly", "prompt": "short role description" },',
  "  },",
  "  // OPTIONAL built-in overrides: uncomment and fill an entry to pin the",
  "  // host's built-in General/Explore subagents machine-wide. Keys are the",
  `  // built-ins' exact LOWERCASE ids ("general" / "explore") — capitalized`,
  "  // files create ambiguous duplicates, never overrides. Activating an",
  "  // entry REPLACES the built-in's prompt wholesale (vendor text is never",
  "  // copied) — write your own general/explore prompt. model+thoughtLevel",
  "  // pin brain and depth (an ATOMIC pair); leaving both out of an active",
  "  // entry keeps the Auto worker (inherits the parent session's model —",
  "  // the official default). forge_sync compiles an active entry to",
  "  // <global agent dir>/general.md|explore.md (GENERATED marker; re-comment",
  "  // the entry and sync again to garbage-collect it). A hand-written file",
  "  // of the same name is NEVER overwritten — sync refuses and discloses.",
  '  // "override": {',
  '  //   "general": { "model": "provider/model", "thoughtLevel": "low",',
  '  //     "prompt": "You are my general-purpose worker. ..." },',
  '  //   "explore": { "model": "provider/model", "thoughtLevel": "low",',
  '  //     "shape": "readonly", "prompt": "You are my codebase scout. ..." },',
  "  // },",
  "}"
].join(`
`);
function forgeFamilyGuard(command) {
  return `FAMILY GUARD (step 0, before anything else): if you do not have the forge_sync tool in your available tools, you are not in a forge session — STOP now: execute nothing below, and tell the user that ${command} belongs to the forge agent, who should switch to forge (Tab) and rerun it there.`;
}
var FORGE_BOUNDARIES_TEXT = `Boundaries: this command never writes anything by itself — every write goes through forge_sync or the normal write tool on the user's explicit go-ahead, transcript-visible. The staleness gate, the in-band sync default, and sync:"auto" behave exactly as without this command.`;
var SYNC_LEVER_BODY = `call the forge_sync tool NOW and report its output verbatim to the user — every created/updated/unchanged/gc'd file and any error line. This is the manual force lever: the default posture (staleness gate + in-band sync; the sync:"auto" opt-in) is unchanged, so report the diff and stop there.`;
var INIT_WORKSPACE_LEAD = "draft THIS workspace's recipe (.opencode/forge.json) in-band with the user.";
var INIT_FLOW_BODY = "First check whether the file already exists — if it does, REFUSE to change it: read it, present a review of the existing recipe (pool namespace, roles, shapes, pinned models) and offer edits the user must explicitly approve; NEVER overwrite or rewrite it. When it does not exist: interview the user briefly (or infer from the project context — language, build system, the roles the work needs) and propose a JSONC recipe covering the pool namespace, the roles (ids as plain role words WITHOUT the forge- prefix), each agent's shape (readonly for read-only roles, write for implementers), and the model+thoughtLevel atomic pair (both to pin, neither for an Auto worker). Show the proposed file, then write it ONLY on the user's explicit go-ahead — the write goes through the normal write tool so it lands in the transcript. The file hot-applies at the next config hook; no restart is needed, and a crew retry then passes.";
var INIT_GLOBAL_SCAFFOLD_NOTE = "The global scaffold ships the built-in override entries (general/explore) fully COMMENTED OUT — inert until the user uncomments and fills one (activating an override replaces the built-in's prompt wholesale; the scaffold's inline comments say the same).";
var INIT_GLOBAL_BODY = `same drafting flow for the GLOBAL recipe (~/.config/opencode/forge.json) — refuse-and-review when it already exists, draft in-band otherwise, write only on explicit go-ahead. ${INIT_GLOBAL_SCAFFOLD_NOTE}`;
var FORGE_HELP_ROUTE_LINE = "- Argument empty or unknown: tell the user the four forms in one short list — /forge sync (force a roster sync NOW and show the diff), /forge init (draft this workspace's forge.json in-band), /forge init global (draft the global forge.json with commented built-in override entries), /forge stop (request stop of confirmed native child sessions) — and stop.";
var STOP_LEVER_BODY = [
  '- Argument "stop": relay the command receipt for confirmed native child sessions; do not issue additional cancellation requests. Do not claim anything was stopped without confirmation. Do not launch further work.',
  "Boundaries: cancellation is USER intent only; do not touch unrelated sessions or commands. Interrupting the parent does not guarantee children stop; use /forge stop for explicit child cancellation. Report unknown outcomes honestly."
].join(`
`);
var FORGE_COMMAND_TEMPLATE = [
  '(forge roster levers. Argument: "$ARGUMENTS")',
  "",
  forgeFamilyGuard("/forge"),
  "",
  "Route on the argument above (decide silently; do not recite this routing text to the user):",
  `- Argument "sync": ${SYNC_LEVER_BODY}`,
  `- Argument "init": ${INIT_WORKSPACE_LEAD} ${INIT_FLOW_BODY}`,
  `- Argument "init global": ${INIT_GLOBAL_BODY} Scaffold shape:`,
  ...GLOBAL_RECIPE_SCAFFOLD_JSONC.split(`
`).map((l) => `  ${l}`),
  `- ${STOP_LEVER_BODY}`,
  FORGE_HELP_ROUTE_LINE,
  "",
  FORGE_BOUNDARIES_TEXT,
  ""
].join(`
`);
function isRootish(p) {
  if (!p)
    return true;
  return p === "/" || p === "\\" || /^[A-Za-z]:[\\/]?$/.test(p);
}
function effectiveWorktree(worktree, fallback) {
  const wt = (worktree ?? "").trim();
  if (!isRootish(wt))
    return wt;
  return (fallback ?? "").trim();
}
var sessions = new Map;
var sessionMovedAnchors = new Map;
var anchorMovedNotes = new Set;
var rpcAnchorRequestContext = new AsyncLocalStorage;
function noteSessionMoved(sessionID, directory) {
  if (typeof sessionID !== "string" || !sessionID)
    return;
  if (typeof directory !== "string" || !directory || isRootish(directory))
    return;
  sessionMovedAnchors.set(sessionID, directory);
  const existing = sessions.get(sessionID);
  if (existing) {
    existing.worktree = directory;
  }
}
function movedEventFields(fields) {
  const loc = fields.location;
  const directory = loc !== null && typeof loc === "object" && typeof loc.directory === "string" ? loc.directory : typeof fields.directory === "string" ? fields.directory : undefined;
  return { sessionID: fields.sessionID ?? fields.sessionId, directory };
}
var sessionAgents = new Map;
function isForgeFamilyAgent(name) {
  if (typeof name !== "string")
    return false;
  const n = name.toLowerCase();
  return n === FORGE_AGENT || n.startsWith("forge-");
}
function assertHarnessAgent(tool3, speaker) {
  if (!tool3 || !FORGE_STATE_TOOL_SET.has(tool3) || speaker === FORGE_AGENT)
    return;
  if (speaker && !isForgeFamilyAgent(speaker)) {
    throw new Error(`[forge:partition] Tool refused: "${tool3}" belongs to the forge agent family and the current agent ("${speaker}") is outside it. Switch to forge (Tab) to use forge tooling.`);
  }
  if (speaker?.toLowerCase().startsWith("forge-")) {
    throw new Error(`[forge:partition] Tool refused: "${tool3}" is a harness state tool reserved for the primary forge agent; "${speaker}" is a forge worker. Report your findings back to the orchestrating session — the primary agent calls ${tool3} at the gate.`);
  }
  throw new Error(`[forge:partition] Tool refused: "${tool3}" is reserved for the primary forge agent; primary identity is not established. Switch to forge (Tab) to use forge tooling.`);
}
function sessionIsForgeFamily(sessionID) {
  if (!sessionID)
    return false;
  return isForgeFamilyAgent(sessionAgents.get(sessionID));
}
function noteToolAgent(context) {
  if (context && typeof context.sessionID === "string" && context.sessionID && typeof context.agent === "string" && context.agent) {
    sessionAgents.set(context.sessionID, context.agent);
  }
}
var hostAnchors = [];
var observedRecipeFiles = new Set;
var poolResolver = null;
var poolResolution = null;
var poolGateUnknownNotes = new Set;
var anchorPrefNotes = new Set;
var foldPath3 = (p) => process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
function globalPoolPathOf() {
  return forgeConfigPaths({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global;
}
var CONFIG_RPC_UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function strictUtf8Read(path) {
  return CONFIG_RPC_UTF8_STRICT.decode(readFileSync5(path));
}
var v2HostSeen = false;
var v2MaterializeMode = "native";
function nativeRosterActive() {
  return v2HostSeen && v2MaterializeMode === "native";
}
function realRosterFs() {
  const fixtureRoot = process.env.FORGE_TEST_FIXTURE_ROOT;
  const checkPath = (path) => {
    if (!fixtureRoot)
      return;
    const within = (root2, candidate) => {
      const rel = relative3(root2, candidate);
      return !isAbsolute3(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
    };
    const refused = () => new Error(`test fixture root refused roster path: ${path}`);
    if (!within(fixtureRoot, path))
      throw refused();
    const root = realpathSync4(fixtureRoot);
    let cursor = path;
    while (true) {
      try {
        lstatSync3(cursor);
      } catch (err) {
        if (err.code !== "ENOENT")
          throw err;
        const parent = dirname4(cursor);
        if (parent === cursor || !within(fixtureRoot, parent))
          throw refused();
        cursor = parent;
        continue;
      }
      if (!within(root, realpathSync4(cursor)))
        throw refused();
      return;
    }
  };
  return {
    stat: (path) => {
      try {
        checkPath(path);
        const s = statSync4(path);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      checkPath(path);
      return readFileSync5(path, "utf8");
    },
    writeFile: (path, data) => {
      checkPath(dirname4(path));
      checkPath(path);
      writeFileSync4(path, data);
    },
    rename: (from, to) => {
      checkPath(dirname4(from));
      checkPath(from);
      checkPath(dirname4(to));
      checkPath(to);
      renameSync3(from, to);
    },
    unlink: (path) => {
      checkPath(dirname4(path));
      checkPath(path);
      unlinkSync3(path);
    },
    readdir: (path) => {
      try {
        checkPath(path);
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    mkdir: (path) => {
      checkPath(path);
      mkdirSync3(path, { recursive: true });
    }
  };
}
function readGlobalKnobs(path, deps) {
  try {
    const text = deps?.readFile ? deps.readFile(path) : readFileSync5(path, "utf8");
    const parsed = parseForgeJsonc(text);
    if (!parsed.ok)
      return { materialize: undefined, syncAuto: false };
    const knobs = parseTopLevelKnobs(parsed.config, "global forge.json");
    for (const f of knobs.findings)
      console.warn(`[forge:sync] ${f.level}: ${f.message}`);
    return { materialize: knobs.materialize, syncAuto: knobs.syncAuto };
  } catch {
    return { materialize: undefined, syncAuto: false };
  }
}
function runRosterSync() {
  const resolution = resolvePools();
  const overrideDir = globalAgentDirFor({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir(), configDir: process.env.OPENCODE_CONFIG_DIR });
  const rosterDirs = { globalPoolFile: globalPoolPathOf(), globalAgentDir: overrideDir };
  const overridePlan = resolution ? planOverrideSync(resolution.overrides ?? {}, {
    dir: overrideDir,
    recipeFile: globalPoolPathOf()
  }) : null;
  if (!resolution) {
    return { lines: ["[forge:sync] No forge.json recipe is visible to this host — nothing to compile (the recipe is the authority; native files are only its projection)."], errorCount: 0 };
  }
  const missingRecipeNotes = [];
  const candidateFiles = new Set([globalPoolPathOf(), ...observedRecipeFiles, ...hostAnchors.map((anchor) => forgeConfigPaths({ projectDir: anchor }).project)]);
  for (const file2 of candidateFiles) {
    const fixtureRoot = process.env.FORGE_TEST_FIXTURE_ROOT;
    if (fixtureRoot) {
      const rel = relative3(fixtureRoot, file2);
      if (isAbsolute3(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
        continue;
    }
    if (recipeFileStat(file2) !== null)
      continue;
    const verdict = staleCheckForPool(file2, [], realRosterFs(), rosterContentOf(resolution), rosterAgentDirFor(file2, rosterDirs));
    if (verdict.stale)
      missingRecipeNotes.push(`  finding [warn]: ${verdict.reason}; restore the recipe or explicitly manage its generated files (sync leaves them untouched).`);
  }
  if (resolution.families.length === 0 && overridePlan === null) {
    return { lines: ["[forge:sync] No forge.json recipe is visible to this host — nothing to compile (the recipe is the authority; native files are only its projection).", ...missingRecipeNotes], errorCount: 0 };
  }
  const recipeUsable = (file2) => recipeFileStat(file2) !== null && !resolution.findings.some((f) => (f.code === "config-parse-error" || f.code === "config-not-object") && f.message.startsWith(`${file2}:`));
  const plans = planRosterSync(resolution, rosterDirs).filter((p) => recipeUsable(p.family.file));
  if (recipeUsable(globalPoolPathOf()))
    plans.push(overridePlan ?? { kind: "override", dir: overrideDir, files: [] });
  const outcome = executeRosterSync(plans, realRosterFs());
  const lines = [`[forge:sync] Compiled ${plans.reduce((n, p) => n + p.files.length, 0)} roster file(s) across ${plans.filter((p) => p.files.length > 0).length} pool(s):`, ...missingRecipeNotes];
  if (foldPath3(agentDirFor(rosterDirs.globalPoolFile)) !== foldPath3(overrideDir))
    lines.push(`  global artifacts use ${overrideDir}; former recipe-sibling path ${agentDirFor(rosterDirs.globalPoolFile)} is not scanned or cleaned by this global sync.`);
  if (outcome.created.length)
    lines.push(`  created: ${outcome.created.join(", ")}`);
  if (outcome.updated.length)
    lines.push(`  updated: ${outcome.updated.join(", ")}`);
  if (outcome.unchanged.length)
    lines.push(`  unchanged: ${outcome.unchanged.length} file(s) already current`);
  if (outcome.gced.length)
    lines.push(`  gc'd (entries removed from the recipe): ${outcome.gced.join(", ")}`);
  if (outcome.errors.length)
    lines.push(`  errors: ${outcome.errors.join("; ")}`);
  for (const f of resolution.findings) {
    if (f.level !== "warn" && f.level !== "error")
      continue;
    lines.push(`  finding [${f.level}] ${f.code}: ${f.message}`);
    if (f.level === "error" || f.code === "override-node-ignored-workspace")
      console.warn(`[forge:sync] ${f.level}: ${f.message}`);
  }
  lines.push("The host hot-applies the files — no restart. Edit the RECIPE (forge.json), never the generated files; forge_sync re-emits.");
  return { lines, errorCount: outcome.errors.length + resolution.findings.filter((f) => f.level === "error").length };
}
function rosterContentOf(resolution) {
  const globalPoolFile = globalPoolPathOf();
  return (matId) => compileResolvedRosterEntry(resolution, matId, { globalPoolFile }).content;
}
function rosterStaleRefusal(anchor) {
  const resolution = resolvePools();
  const poolFile = anchor ? sessionPoolFileOf(anchor) : null;
  const fam = resolution?.families.find((f) => foldPath3(f.file) === foldPath3(poolFile ?? globalPoolPathOf()));
  const file2 = fam ? fam.file : poolFile;
  const verdict = staleCheckForPool(file2, fam ? fam.materializedIds : [], realRosterFs(), resolution ? rosterContentOf(resolution) : undefined, file2 === null ? undefined : rosterAgentDirFor(file2, { globalPoolFile: globalPoolPathOf(), globalAgentDir: globalAgentDirFor({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir(), configDir: process.env.OPENCODE_CONFIG_DIR }) }));
  if (!verdict.stale)
    return null;
  return `[forge:crew] Roster stale refused: this session's native roster artifacts are out of date with the recipe — ${verdict.reason}. ` + `One-step fix: call the forge_sync tool NOW (it recompiles .opencode/agent/forge-*.md atomically, in-band, transcript-visible; the host hot-applies without a restart), then retry this registration. ` + `The recipe (forge.json) stays the authority — the gate only refuses dispatching against a stale projection.`;
}
function anchorPath(dir) {
  const p = (dir ?? "").trim();
  if (!p)
    return "";
  try {
    return realpathSync4(p);
  } catch {
    return p;
  }
}
function anchorKey(path) {
  return process.platform === "win32" ? path.replace(/\//g, "\\").toLowerCase() : path;
}
function normalizeAnchorDir(dir) {
  return anchorKey(anchorPath(dir));
}
function rememberHostAnchor(dir) {
  if (process.env.FORGE_ANCHOR_PROBE) {
    try {
      appendFileSync(join5(probeTmp(), "forge-anchor-probe.log"), `${new Date().toISOString()} rememberHostAnchor(${JSON.stringify(dir)}) cwd=${JSON.stringify(process.cwd())}
`);
    } catch {}
  }
  const path = anchorPath(dir);
  const normalized = anchorKey(path);
  if (!normalized)
    return;
  if (!hostAnchors.some((anchor) => anchorKey(anchor) === normalized))
    hostAnchors.push(path);
  if (!poolResolver) {
    poolResolver = createPoolResolver({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() });
  }
}
function resolvePools() {
  if (process.env.FORGE_ANCHOR_PROBE) {
    try {
      appendFileSync(join5(probeTmp(), "forge-anchor-probe.log"), `${new Date().toISOString()} resolvePools: resolver=${poolResolver ? "set" : "null"} anchors=${JSON.stringify([...hostAnchors])}
`);
    } catch {}
  }
  if (!poolResolver || hostAnchors.length === 0)
    return null;
  const resolution = poolResolver.resolve(hostAnchors);
  for (const family of resolution.families)
    observedRecipeFiles.add(family.file);
  return resolution;
}
var sessionAnchorLoaders = new Map;
function loaderForAnchor(anchor) {
  const key = anchor || "-";
  let l = sessionAnchorLoaders.get(key);
  if (!l) {
    l = createForgeConfigLoader({ projectDir: anchor });
    sessionAnchorLoaders.set(key, l);
    while (sessionAnchorLoaders.size > 8) {
      const oldest = sessionAnchorLoaders.keys().next().value;
      if (oldest === undefined)
        break;
      sessionAnchorLoaders.delete(oldest);
    }
  }
  return l;
}
function sessionPoolFileOf(anchor) {
  if (poolResolver)
    return poolResolver.workspacePoolOf(anchor);
  return loaderForAnchor(anchor).load().projectPath;
}
function crewPoolComplianceRefusal(anchor) {
  const poolFile = sessionPoolFileOf(anchor);
  if (poolFile === null)
    return null;
  let text;
  try {
    text = readFileSync5(poolFile, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `[forge:crew] Pool compliance refused: this session's workspace pool file (${poolFile}) could not be read (${reason}). ` + `Repair the file so it is readable JSONC declaring a valid top-level "pool" namespace ([a-z0-9-], 1-24 chars) — REQUIRED for crew-governed dispatch. ` + `The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`;
  }
  const parsed = parseForgeJsonc(text);
  if (!parsed.ok) {
    return `[forge:crew] Pool compliance refused: this session's workspace pool file (${poolFile}) does not parse (${parsed.error.message} at line ${parsed.error.line}). ` + `Repair the file so it parses and declares a valid top-level "pool" namespace ([a-z0-9-], 1-24 chars) — REQUIRED for crew-governed dispatch. ` + `The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`;
  }
  const verdict = poolFileCompliance(parsed.config);
  if (verdict.compliant)
    return null;
  const fam = resolvePools()?.families.find((f) => foldPath3(f.file) === foldPath3(poolFile));
  const suggested = fam?.ns ?? sanitizeNamespace(basename2(dirname4(dirname4(poolFile))));
  return `[forge:crew] Pool compliance refused: this session's workspace pool file (${poolFile}) is non-compliant — ${verdict.violation}. ` + `Minimal fix: add or repair the top-level "pool": "${suggested}" field (a [a-z0-9-] string, 1-24 chars — REQUIRED for crew-governed dispatch). ` + `The gate lifts hot-apply: the next resolve after the repair admits registration/dispatch; no host restart.`;
}
var CREW_WAVE_RULE = "A wave is the set of native `subagent` calls made together by the orchestrating session (agent = the selected worker). Reuse of a sessionID starts another work round; duplicate observations of one round count once. Children work in the background; use host completion messages and available session evidence to verify settlement. Launch the next wave ONLY after every work round of the previous wave is verified settled. Partial, truncated or unknown views, idle or missing sessions, and unresolved outcomes do not establish settlement; end your turn and wait for the rest, without polling or sleeping. A diagnostic is not permission to launch another wave.";
var CREW_NATIVE_FALLBACK_RULE = "Native fallback: when the pool offers no forge worker fitting a subtask or the pool is degraded, disclose the gap and suggest configuring the missing role; use the native `subagent` tool for a non-forge agent (e.g. general) only when permitted, with the same relay contract (artifact path, scoped prompt, evidence demands) and RECORD the fallback (wave notes + the subtask's close evidence says it ran native). Respect all approvals and host permissions.";
var CREW_COMPLIANCE_NATIVE_EXIT = " Repair the pool before retrying the refused operation; respect existing approvals and permissions.";
var crews = new Map;
function crewRecordPathFor(worktree, objective) {
  const dir = join5(worktree, ".opencode", "crew");
  const date5 = localDateNow();
  const slug = slugifyGoal(objective) || "crew";
  let name = `${date5}-${slug}.md`;
  let n = 2;
  while (existsSync(join5(dir, name)))
    name = `${date5}-${slug}-${n++}.md`;
  return join5(dir, name);
}
function writeCrewRecord(path, objective, anchor, subtasks, lineage) {
  mkdirSync3(join5(path, ".."), { recursive: true });
  writeFileSync4(path, [
    `# Crew Record: ${objective}`,
    "",
    `- registered: ${nowIso()}`,
    `- anchor: ${anchor}`,
    ...lineage ? [`- lineage: ${lineage}`] : [],
    "",
    `## Declared plan (${subtasks.length})`,
    ...subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
    ""
  ].join(`
`) + `
`, "utf8");
}
function appendCrewRecord(path, heading, lines) {
  if (!path)
    return;
  try {
    appendFileSync(path, [`## ${nowIso()} — ${heading}`, ...lines, ""].join(`
`) + `
`, "utf8");
  } catch {}
}
function governingGoalFor(sessionID) {
  if (!sessionID)
    return false;
  const state = stateForBan(sessionID);
  if (!state)
    return false;
  const goal = resolveLiveGoal(state);
  return Boolean(goal && goal.doc.status === "active" && goal.doc.session === sessionID);
}
function crewPendingChoiceLines() {
  return [
    "[forge:crew] The crew is PENDING — execution has NOT started. Present the execution-mode choice to the user and END YOUR TURN (do not start any subagent work while the crew pends):",
    `RELAY FIRST: tell the user the crew record path (it leads this output) alongside this choice — the record is on disk from the registration moment, and the user must hear it.`,
    `  1. supervised waves NOW — when the user says go, call crew_begin {execution: "waves"} and run the wave discipline; waves auto-advance on session idle until crew_close only after verified settlement of the previous wave (the engine stops after a stall — nudge or re-shard);`,
    `  2. convert to a goal contract — call crew_begin {execution: "goal"} (the crew ends as a conversion record; no extra dialog here), then draft goal_write with arm=true folding the declared subtasks into criteria/checks — the arm dialog is the user's gate;`,
    `  3. standby — no call; the crew waits until armed or abandoned.`
  ];
}
var modelsDevCatalog = null;
var depthFindingNotes = new Map;
var sessionDepths = new Map;
var OPENAI_FAMILY = new Set(["openai", "opencode", "openrouter", "groq", "xai", "azure", "github-copilot", "deepseek", "together", "vercel", "opus"]);
var ANTHROPIC_FAMILY = new Set(["anthropic"]);
var ZAI_FAMILY = new Set(["zai", "zai-coding-plan"]);
function dispatchProviderFamily(providerID) {
  if (OPENAI_FAMILY.has(providerID))
    return "openai";
  if (ANTHROPIC_FAMILY.has(providerID))
    return "anthropic";
  if (ZAI_FAMILY.has(providerID))
    return "zai";
  return null;
}
function isAdaptiveAnthropic(modelID) {
  const id = modelID.toLowerCase();
  const m = /^claude-(?:(?:opus|sonnet|haiku)[-.])?(\d+)(?:[.-](\d+))?/.exec(id);
  if (!m)
    return false;
  const major = Number(m[1]);
  const minor = m[2] !== undefined ? Number(m[2]) : 0;
  return major > 4 || major === 4 && minor >= 7;
}
function resolveDepthChannel(providerID, modelID) {
  if (dispatchProviderFamily(providerID) === "anthropic") {
    return isAdaptiveAnthropic(modelID) ? { kind: "adaptive-effort" } : { kind: "budget" };
  }
  const shape = modelDepthShape(modelsDevCatalog, `${providerID}/${modelID}`);
  if (shape) {
    if (shape.shape === "effort")
      return { kind: "effort", ladder: shape.ladder };
    if (shape.shape === "toggle")
      return { kind: "toggle" };
    return { kind: "budget" };
  }
  const family = dispatchProviderFamily(providerID);
  if (family === "openai")
    return { kind: "effort", ladder: null };
  if (family === "zai")
    return { kind: "toggle" };
  return { kind: "effort", ladder: null };
}
var anchorClientShared = null;
function sharedAnchorClient() {
  return anchorClientShared;
}
function forgeRuntimeTmp() {
  return process.env.FORGE_TEST_RUNTIME_DIR || undefined;
}
function forgeRuntimeRoot() {
  return join5(forgeRuntimeTmp() ?? tmpdir2(), "opencode-forge");
}
function sessionAnchorLedgerPath() {
  return join5(process.env.FORGE_TEST_FORGE_HOME ?? forgeRuntimeTmp() ?? tmpdir2(), "opencode-forge", "session-anchors.jsonl");
}
function modelsDevCacheRoot() {
  return forgeRuntimeRoot();
}
async function refreshModelsDevCatalog(skipFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH === "1", timeoutMs) {
  if (skipFetch) {
    modelsDevCatalog = null;
    return;
  }
  try {
    const snapshot = await loadModelsDevSnapshot({ cacheDir: modelsDevCacheRoot(), timeoutMs });
    modelsDevCatalog = snapshot.catalog;
  } catch {
    modelsDevCatalog = null;
  }
}
function probeTmp() {
  return forgeRuntimeTmp() ?? tmpdir2();
}
var __runtimeNamespaceTestSurface = {
  tmp: forgeRuntimeTmp,
  root: forgeRuntimeRoot,
  modelsDevCacheRoot,
  modelsDevCacheDir: () => modelsDevCacheDir(modelsDevCacheRoot()),
  probeTmp,
  sessionAnchorLedgerPath
};
var sessionAnchorLedgerFsFactory = null;
var sessionAnchorLedgerWarned = false;
var sessionAnchorLedgerAppends = 0;
var SESSION_ANCHOR_LEDGER_CAP = 200;
var poolGateLedgerNotes = new Set;
var sessionAnchorLedgerMemo = new Map;
function sessionAnchorLedgerFs() {
  const filePath = sessionAnchorLedgerPath();
  if (sessionAnchorLedgerFsFactory)
    return sessionAnchorLedgerFsFactory(filePath);
  return {
    read: () => {
      try {
        return readFileSync5(filePath, "utf8");
      } catch {
        return "";
      }
    },
    write: (text) => {
      mkdirSync3(dirname4(filePath), { recursive: true });
      writeFileSync4(filePath, text, "utf8");
    },
    append: (text) => {
      mkdirSync3(dirname4(filePath), { recursive: true });
      appendFileSync(filePath, text, "utf8");
    }
  };
}
function sessionAnchorLedgerWarnOnce(scope, err) {
  if (sessionAnchorLedgerWarned)
    return;
  sessionAnchorLedgerWarned = true;
  console.warn(`[forge:pool] session-anchor ledger ${scope} failed (fail-soft; resolution degrades to the live chain): ${err instanceof Error ? err.message : String(err)}`);
}
function ledgerParseEntries(text) {
  const latest = new Map;
  if (!text)
    return latest;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s)
      continue;
    try {
      const e = JSON.parse(s);
      if (typeof e.sessionID === "string" && e.sessionID && typeof e.worktree === "string" && e.worktree)
        latest.set(e.sessionID, e.worktree);
    } catch {}
  }
  return latest;
}
function sessionAnchorLedgerLookup(sessionID) {
  try {
    return ledgerParseEntries(sessionAnchorLedgerFs().read()).get(sessionID) ?? "";
  } catch (err) {
    sessionAnchorLedgerWarnOnce("read", err);
    return "";
  }
}
function noteSessionAnchorLedgerBinding(sessionID, worktree) {
  try {
    if (!sessionID || !worktree || isRootish(worktree))
      return;
    if (sessionPoolFileOf(worktree) === null)
      return;
    const folded = foldPath3(worktree);
    if (sessionAnchorLedgerMemo.get(sessionID) === folded)
      return;
    const fsx = sessionAnchorLedgerFs();
    fsx.append(JSON.stringify({ sessionID, worktree, ts: nowIso() }) + `
`);
    sessionAnchorLedgerMemo.set(sessionID, folded);
    sessionAnchorLedgerAppends++;
    if (sessionAnchorLedgerAppends > SESSION_ANCHOR_LEDGER_CAP) {
      const latest = ledgerParseEntries(fsx.read());
      while (latest.size > SESSION_ANCHOR_LEDGER_CAP) {
        const oldest = latest.keys().next().value;
        if (oldest === undefined)
          break;
        latest.delete(oldest);
      }
      const rewritten = [...latest.entries()].map(([sid, wt]) => JSON.stringify({ sessionID: sid, worktree: wt, ts: nowIso() })).join(`
`);
      fsx.write(rewritten ? rewritten + `
` : "");
      sessionAnchorLedgerAppends = latest.size;
    }
  } catch (err) {
    sessionAnchorLedgerWarnOnce("write", err);
  }
}
function anchorProbeLog(kind, sessionID, payload) {
  try {
    appendFileSync(process.env.FORGE_ANCHOR_PROBE, JSON.stringify({ t: new Date().toISOString(), kind, sessionID, ...payload }) + `
`);
  } catch {}
}
async function resolveSessionAnchorForPools(anchorClient, sessionID) {
  if (!sessionID)
    return "";
  let authoritative = "";
  try {
    const rec = anchorClient?.session?.get ? await anchorClient.session.get({ path: { id: sessionID } }) : undefined;
    const anchor = effectiveWorktree(rec?.worktree, rec?.directory ?? rec?.location?.directory);
    if (anchor && !isRootish(anchor))
      authoritative = anchor;
    if (process.env.FORGE_ANCHOR_PROBE)
      anchorProbeLog("rec", sessionID, { rec: rec ?? null, authoritative });
  } catch {}
  const mapped = sessions.get(sessionID)?.worktree ?? "";
  if (process.env.FORGE_ANCHOR_PROBE)
    anchorProbeLog("map", sessionID, { mapped });
  const moved = sessionMovedAnchors.get(sessionID) ?? "";
  if (moved && (authoritative === "" || foldPath3(moved) !== foldPath3(authoritative))) {
    if (!anchorMovedNotes.has(sessionID)) {
      anchorMovedNotes.add(sessionID);
      console.warn(`[forge:pool] session ${sessionID}: dispatch anchor re-resolved from the host's session.moved event (${moved}) — the session.get seam still reports the pre-move location${authoritative ? ` (${authoritative})` : ""}; the moved workspace wins this resolution.`);
    }
    return moved;
  }
  if (authoritative === "")
    return resolveAnchorViaLedger(sessionID, mapped);
  if (mapped && !isRootish(mapped) && foldPath3(mapped) !== foldPath3(authoritative) && sessionPoolFileOf(authoritative) === null && sessionPoolFileOf(mapped) !== null) {
    if (!anchorPrefNotes.has(sessionID)) {
      anchorPrefNotes.add(sessionID);
      console.warn(`[forge:pool] session ${sessionID}: the authoritative session record anchors to a POOL-LESS directory (${authoritative}) while the session's live binding owns a pool (${mapped}) — the pooled binding wins this resolution (restart-resume rebind shape).`);
    }
    return mapped;
  }
  return resolveAnchorViaLedger(sessionID, authoritative);
}
function resolveAnchorViaLedger(sessionID, resolved) {
  if (resolved && !isRootish(resolved) && sessionPoolFileOf(resolved) !== null)
    return resolved;
  const hit = sessionAnchorLedgerLookup(sessionID);
  if (!hit || isRootish(hit) || sessionPoolFileOf(hit) === null)
    return resolved;
  const existing = sessions.get(sessionID);
  if (existing) {
    if (!isRootish(hit))
      existing.worktree = hit;
  } else {
    sessions.set(sessionID, { sessionID, worktree: hit });
  }
  if (!poolGateLedgerNotes.has(sessionID)) {
    poolGateLedgerNotes.add(sessionID);
    console.warn(`[forge:pool] session ${sessionID}: dispatch anchor re-bound from the persisted session-anchor ledger (${hit}) — the resumed session's authoritative record is pool-less and the in-memory map was empty (restart-resume rebind shape).`);
  }
  return hit;
}
async function poolGateRefusal(anchorClient, sessionID, target, requireEntry = false, deferMissing) {
  const anchor = await resolveSessionAnchorForPools(anchorClient, sessionID);
  return poolGateRefusalAtAnchor(anchor, sessionID, target, requireEntry, deferMissing);
}
function poolGateRefusalAtAnchor(anchor, sessionID, target, requireEntry = false, deferMissing) {
  const resolution = resolvePools();
  const agentId = target.slice("forge-".length);
  const entry = resolution?.agents[agentId];
  if (!entry && !requireEntry)
    return null;
  if (!anchor) {
    if (!poolGateUnknownNotes.has(sessionID)) {
      poolGateUnknownNotes.add(sessionID);
      console.warn(`[forge:pool] session ${sessionID}: task dispatch to ${target} passed an UNGATED pool check — the session's workspace could not be established (fail-open belt posture; pool ownership unscoped).`);
    }
    return null;
  }
  const sessionPool = sessionPoolFileOf(anchor);
  const allowed = sessionPool ?? globalPoolPathOf();
  if (!entry) {
    const stale = nativeRosterActive() ? rosterStaleRefusal(anchor) : null;
    const refusal = stale ?? `[forge:pool] Dispatch refused: "${target}" is not a materialized forge subagent and is not dispatchable from this session. ` + `This session's dispatchable roster is ${sessionPool ? `its workspace pool (${sessionPool})` : `the global fallback (${globalPoolPathOf()})`}. ` + `Exits: open a session in the role's workspace, or configure the role into this workspace's pool (its .opencode/forge.json), or into the global layer (${globalPoolPathOf()}).`;
    if (deferMissing) {
      deferMissing(refusal);
      return null;
    }
    return refusal;
  }
  if (allowed === null || foldPath3(entry.file) !== foldPath3(allowed)) {
    return `[forge:pool] Dispatch refused: "${target}" belongs to the pool ${entry.file} — not dispatchable from this session. ` + `This session's dispatchable roster is ${sessionPool ? `its workspace pool (${sessionPool})` : `the global fallback (${globalPoolPathOf()})`}. ` + `Exits: open a session in that pool's workspace, or configure the role into this workspace's pool (its .opencode/forge.json), or into the global layer (${globalPoolPathOf()}).`;
  }
  return null;
}
function crewPendingRefusal(sessionID) {
  const pendingCrew = sessionID ? crews.get(sessionID) : undefined;
  if (pendingCrew && pendingCrew.mode === "pending") {
    return `[forge:crew] Dispatch refused: the crew "${pendingCrew.objective}" is PENDING (registered, not armed). Present the execution-mode choice to the user — supervised waves now / convert to a goal contract / standby — then arm per their choice with crew_begin {execution: "waves" | "goal"}. Reconnaissance task calls are free only BEFORE registration.`;
  }
  return null;
}
async function crewComplianceRefusalFor(anchorClient, sessionID, target) {
  if (!(target && target.toLowerCase().startsWith("forge-")))
    return null;
  const crew = crews.get(sessionID);
  if (!(crew && (crew.mode === "pending" || crew.mode === "executing")))
    return null;
  const anchor = await resolveSessionAnchorForPools(anchorClient, sessionID);
  return crewComplianceRefusalAtAnchor(anchor, sessionID, target);
}
function crewComplianceRefusalAtAnchor(anchor, sessionID, target) {
  if (!anchor || !target.toLowerCase().startsWith("forge-"))
    return null;
  const crew = crews.get(sessionID);
  if (!(crew && (crew.mode === "pending" || crew.mode === "executing")))
    return null;
  const complianceRefusal = crewPoolComplianceRefusal(anchor);
  return complianceRefusal ? complianceRefusal + CREW_COMPLIANCE_NATIVE_EXIT : null;
}
function draftDispatchRefusalForState(state, target) {
  const active = state ? resolveActivePlan(state) : null;
  if (!(active && active.doc.status === "draft"))
    return null;
  const agentId = target !== undefined && target.toLowerCase().startsWith("forge-") ? target.slice("forge-".length) : undefined;
  const def = agentId !== undefined ? resolvePools()?.agents[agentId]?.def : undefined;
  if (def !== undefined && effectiveReadonlyShape(def)) {
    return null;
  }
  const roster = [];
  const pools = resolvePools();
  if (pools) {
    for (const [id, entry] of Object.entries(pools.agents))
      if (effectiveReadonlyShape(entry.def))
        roster.push(`forge-${id}`);
  }
  roster.sort();
  return `[forge] A plan is in draft; dispatch is denied for this target. ` + (roster.length > 0 ? `Readonly recon scouts ARE dispatchable during draft: ${roster.join(", ")}. ` : `No readonly worker is configured — define one in forge.json with an explicit "shape": "readonly" to enable draft-phase reconnaissance. `) + `Write-shaped workers and native agents wait for approval (plan_approve); /plan discard to abandon the plan.`;
}
function nativeDraftDispatchRefusal(state, target) {
  const pool = sessionPoolFileOf(state.worktree) ?? globalPoolPathOf();
  const resolution = resolvePools();
  const scouts = Object.entries(resolution?.agents ?? {}).filter(([, entry]) => pool !== null && foldPath3(entry.file) === foldPath3(pool) && effectiveReadonlyShape(entry.def) && (entry.def.permission?.shell === "deny" || entry.def.permission?.bash === "deny"));
  const roster = rosterStaleRefusal(state.worktree) ? [] : scouts.map(([id]) => "forge-" + id).sort();
  if (target && roster.includes(target))
    return null;
  return "[forge] A plan is in draft; dispatch is denied for this target. " + (roster.length ? "Qualified readonly recon scouts: " + roster.join(", ") + ". " : "No current qualified shell-denied readonly scout. Define a readonly worker in forge.json with explicit shape readonly and shell permission deny. ") + "Wait for plan_approve or /plan discard.";
}
var WRITE_TOOLS = new Set([
  ...NATIVE_TOOL_VOCAB.mutatingFamily,
  ...NATIVE_TOOL_VOCAB.legacyShellKeys,
  NATIVE_TOOL_VOCAB.dispatchTool,
  NATIVE_TOOL_VOCAB.taskKey
]);
function isWriteTool(name) {
  const n = name.toLowerCase();
  return WRITE_TOOLS.has(n) || n.includes("patch");
}
function nowIso() {
  return new Date().toISOString();
}
function planDirOf(worktree) {
  return join5(worktree, ".opencode", "plan");
}
function readPlanDir(worktree) {
  const dir = planDirOf(worktree);
  if (!existsSync(dir))
    return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((name) => ({ name, text: readFileSync5(join5(dir, name), "utf8") }));
}
function ensureSession(sessionID, worktree) {
  const existing = sessions.get(sessionID);
  if (existing) {
    if (!isRootish(worktree)) {
      existing.worktree = worktree;
      noteSessionAnchorLedgerBinding(sessionID, worktree);
    }
    return existing;
  }
  const state = { sessionID, worktree };
  sessions.set(sessionID, state);
  if (!isRootish(worktree))
    noteSessionAnchorLedgerBinding(sessionID, worktree);
  return state;
}
function sessionAnchor(context) {
  const viaDir = effectiveWorktree(context.worktree, context.directory);
  if (viaDir && !isRootish(viaDir))
    return viaDir;
  return hostWorktree || (context.worktree ?? "").trim() || (context.directory ?? "").trim();
}
function worktreeFor(context) {
  noteToolAgent(context);
  return sessionAnchor(context) || context.worktree;
}
function resolveActivePlan(state) {
  if (state.planPath && existsSync(state.planPath)) {
    const doc2 = parsePlanLoose(readFileSync5(state.planPath, "utf8"));
    if (doc2 && !isTerminal(doc2.status))
      return { path: state.planPath, doc: doc2 };
    state.planPath = undefined;
  }
  const ranked = rankActivePlans(readPlanDir(state.worktree));
  if (ranked.length === 0)
    return null;
  const path = join5(planDirOf(state.worktree), ranked[0].name);
  state.planPath = path;
  return { path, doc: ranked[0].doc };
}
function relFrom(worktree, path) {
  const rel = relative3(worktree, path);
  return rel && !rel.startsWith("..") ? rel.replaceAll("\\", "/") : path;
}
var planWriteTool = tool({
  description: "Only used inside the /plan flow (the user ran /plan, asked to plan first, or a [forge:plan-notice] is present) — never self-initiate planning. Create or revise the session's plan (structured planning document, written to .opencode/plan/<date>-<slug>.md, status draft). The only sanctioned write while planning. Takes structured fields; the tool renders and validates the fixed sections — you cannot produce a malformed plan file.",
  args: {
    goal: tool.schema.string().describe("One-line task goal (used for the filename slug and the Goal section)"),
    context: tool.schema.string().describe("Context Findings: what the reconnaissance actually found, with file:line evidence references"),
    approach: tool.schema.string().describe("Approach and Alternatives: chosen approach AND rejected alternatives with reasons"),
    tasks: tool.schema.array(tool.schema.string()).describe("Ordered task list; the tool numbers them 1..N as checkboxes"),
    risks: tool.schema.string().describe("Risks: known risks and mitigations"),
    acceptance: tool.schema.array(tool.schema.string()).describe("Acceptance Criteria: verifiable criteria, checked one by one at plan_close"),
    nonGoals: tool.schema.array(tool.schema.string()).optional().describe("Non-Goals: explicit out-of-scope items"),
    checks: tool.schema.array(tool.schema.object({
      shell: tool.schema.string().optional().describe("Shell command the plugin itself re-runs on the host at plan_close (fail-closed)"),
      containsFile: tool.schema.string().optional().describe("File contract: workspace-relative file path"),
      containsText: tool.schema.string().optional().describe("File contract: required literal text in that file"),
      timeoutSec: tool.schema.number().int().positive().optional().describe("Shell timeout in seconds (default 120, max 600)")
    })).optional().describe("Verification Checks: optional structured completion gate, goal-harness-shaped. Rendered into the plan file and FROZEN from approval on — plan_close re-runs exactly this set on the host (fail-closed); a plan without checks keeps the per-criterion self-check close instead")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const active = resolveActivePlan(state);
    const now = nowIso();
    let checks3;
    if (args.checks) {
      try {
        checks3 = coerceChecks(args.checks);
      } catch (err) {
        throw new PlanError(err.message);
      }
    }
    let path;
    let created;
    let mode;
    if (active && active.doc.status === "draft") {
      path = active.path;
      created = active.doc.created || undefined;
      mode = "revised";
    } else if (active) {
      throw new PlanError(`A plan in ${active.doc.status} state is already active (${relFrom(state.worktree, active.path)}). Finish it with plan_close, or /plan discard it before planning something new.`);
    } else {
      const dir = planDirOf(state.worktree);
      mkdirSync3(dir, { recursive: true });
      path = join5(dir, planFileName(localDate(), slugify(args.goal), readdirSync(dir).filter((f) => f.endsWith(".md"))));
      mode = "created";
    }
    const { checks: rawChecks, ...fields } = args;
    const text = renderPlan({ ...fields, ...checks3 && checks3.length > 0 ? { checks: checks3 } : {} }, now, created);
    atomicWrite(path, text);
    state.planPath = path;
    const doc2 = parsePlan(text);
    context.metadata({ title: `${mode === "created" ? "Create" : "Revise"} plan: ${doc2.goal}` });
    return {
      title: `plan ${mode}: ${doc2.goal}`,
      output: [
        `Plan ${mode === "created" ? "created" : "revised"}: ${relFrom(state.worktree, path)}`,
        `Status: draft (${doc2.tasks.length} tasks, ${doc2.acceptance.length} acceptance criteria).`,
        ...doc2.checks.length > 0 ? [`Verification Checks: ${doc2.checks.length} items frozen into the file — plan_close re-runs them on the host, fail-closed (no close dialog).`] : [],
        "Next: briefly present the goal, chosen approach, and task list to the user, then call plan_approve to request approval (a user confirmation dialog appears). Until approval, all write operations are denied."
      ].join(`
`)
    };
  }
});
var planTickTool = tool({
  description: "Mark plan task number n as done: sets its checkbox to [x] and stamps a completion timestamp. Call it IMMEDIATELY after finishing each numbered task — never batch ticks, never tick before the work is done. Only valid while the plan is approved.",
  args: {
    n: tool.schema.number().int().positive().describe("Task number exactly as it appears in the plan's Task List")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const active = resolveActivePlan(state);
    if (!active)
      throw new PlanError("No usable plan in this workspace (.opencode/plan/ has no non-terminal plan).");
    if (active.doc.status !== "approved") {
      throw new PlanError(`Plan status is ${active.doc.status}; only an approved plan can be ticked. Get user approval via plan_approve first.`);
    }
    const next = tickTask(readFileSync5(active.path, "utf8"), args.n, nowIso());
    atomicWrite(active.path, next);
    const doc2 = parsePlan(next);
    const p = progressOf(doc2);
    context.metadata({ title: `Tick task ${args.n} (${p.done}/${p.total})` });
    return {
      title: `task ${args.n} done (${p.done}/${p.total})`,
      output: p.done === p.total ? `Task ${args.n} done (${p.done}/${p.total}, all complete). Self-check every acceptance criterion with concrete evidence, then call plan_close — it re-runs the plan's frozen verification checks itself on the host (fail-closed; no confirmation dialog).` : `Task ${args.n} done and ticked (${p.done}/${p.total}). Continue with the next task.`
    };
  }
});
async function gate(ask, permission, title) {
  if (typeof ask !== "function") {
    throw new Error(`[forge:gate] The ${permission} confirmation gate has no confirmation channel on this host (the plugin's initialization for this directory captured no permission interface), so "${title}" was REFUSED (fail-closed; state is unchanged, nothing was approved).`);
  }
  const watchdogMs = resolveGateAskWatchdogMs();
  if (watchdogMs <= 0) {
    await ask({ permission, patterns: ["*"], always: [], metadata: { title } });
    return;
  }
  let decided = false;
  const decision = (async () => ask({ permission, patterns: ["*"], always: [], metadata: { title } }))();
  decision.then(() => {
    decided = true;
  }, () => {
    decided = true;
  });
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (!decided) {
        console.warn(`[gate-watchdog] warn: no adjudication arrived within ${Math.round(watchdogMs / 1000)}s for the ${permission} confirmation gate (${title}) — refusing the call fail-closed.`);
        reject(new Error(`[gate-watchdog] no adjudication arrived within ${Math.round(watchdogMs / 1000)}s for the ${permission} confirmation gate — REFUSED (fail-closed; state is unchanged, nothing was approved). ` + `The confirmation dialog may not be rendering (the known TUI wedge) or is simply unanswered. A late click on the stale dialog cannot approve this refused call: ` + `re-run the action when the user can actually see and answer the dialog.`));
      }
    }, watchdogMs);
  });
  try {
    await Promise.race([decision, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}
var GATE_ASK_WATCHDOG_DEFAULT_MS = 300000;
function resolveGateAskWatchdogMs(env = process.env) {
  const raw = Number(env.FORGE_GATE_ASK_WATCHDOG_MS);
  if (!Number.isFinite(raw) || raw < 0)
    return GATE_ASK_WATCHDOG_DEFAULT_MS;
  return Math.min(raw, 3600000);
}
var GATE_PERMISSION_KEYS = [
  "plan_approve",
  "goal_write",
  "goal_complete",
  "goal_resume",
  "goal_discard",
  "crew_close"
];
var planApproveTool = tool({
  description: "Approve the session's draft plan (draft -> approved). Call it ONLY after presenting the plan and receiving the user's explicit go-ahead in chat — never in the same turn that presents the draft. The permission layer pins this call to a confirmation dialog — the user's Allow is the final hard gate and lifts the draft-phase write ban. Optionally pass a one-line summary of what changed since the last revision.",
  args: {
    summary: tool.schema.string().optional().describe("One-line summary presented alongside the approval request")
  },
  execute: async (_args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const active = resolveActivePlan(state);
    if (!active)
      throw new PlanError("No plan awaiting approval. Create one with plan_write first.");
    if (active.doc.status !== "draft") {
      throw new PlanError(`Plan status is ${active.doc.status}; only a draft plan can be approved.`);
    }
    await gate(context.ask, "plan_approve", `Approve plan: ${active.doc.goal}`);
    atomicWrite(active.path, transitionStatus(readFileSync5(active.path, "utf8"), "approved", nowIso()));
    context.metadata({ title: `Plan approved: ${active.doc.goal}` });
    return {
      title: "plan approved",
      output: `Plan approved by the user (approved): ${relFrom(state.worktree, active.path)}. The draft-phase write ban is lifted. Execute tasks one by one, calling plan_tick immediately after each; when all are done, self-check and call plan_close (plugin-verified, no dialog).`
    };
  }
});
var planCloseTool = tool({
  description: "Close the session's plan (approved -> done). The completion gate is PLUGIN-VERIFIED — there is NO confirmation dialog. Plans with declared Verification Checks: the frozen check set is re-executed by the plugin on the host right now, fail-closed (any failing command, timeout, or unmet file contract refuses the close, appends the failing run to the plan's Check Log, and the plan stays approved — fix the work and retry; the model cannot change the checks at close time). Plans without declared checks: pass one self-check entry per acceptance criterion (pass + concrete evidence); a failing or missing check refuses the close. Either way a dated evidence-summary terminal section (per-check OK/FAIL with truncated output, or per-criterion PASS/evidence) is appended in the SAME atomic write as the done flip. The user reviews the evidence asynchronously; plan_reopen rolls back.",
  args: {
    checks: tool.schema.array(tool.schema.object({
      criterion: tool.schema.string().describe("The acceptance criterion text, copied verbatim from the plan"),
      pass: tool.schema.boolean().describe("Whether the criterion is met"),
      evidence: tool.schema.string().describe("Concrete evidence: file:line, command output, test result")
    })).optional().describe("Self-checks: one entry per acceptance criterion, in plan order. Required for plans without declared Verification Checks; optional extra evidence otherwise")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const active = resolveActivePlan(state);
    if (!active)
      throw new PlanError("No plan to close.");
    if (active.doc.status !== "approved") {
      throw new PlanError(`Plan status is ${active.doc.status}; only an approved plan (all tasks complete) can be closed.`);
    }
    const closedAt = nowIso();
    if (active.doc.checks.length > 0) {
      const unticked = active.doc.tasks.filter((t) => !t.done).map((t) => t.n);
      if (unticked.length > 0) {
        throw new PlanError(`Completion gate check failed:
- Unticked tasks remain: ${unticked.join(", ")}
Tick every task before closing.`);
      }
      const outcomes = await runChecks(active.doc.checks, state.worktree);
      if (!outcomesAllOk(outcomes)) {
        const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`;
        atomicWrite(active.path, appendPlanCheckLog(readFileSync5(active.path, "utf8"), runId, outcomes, nowIso()));
        throw new PlanError(`Completion gate: verification re-run failed (fail-closed). The plan stays approved; the failing run is recorded in the plan's Check Log.
${formatOutcomes(outcomes.filter((o) => !o.ok))}
Fix the work and retry — the frozen check set is re-run at every close and cannot be changed here.`);
      }
      const selfChecks = args.checks ?? [];
      const closed2 = appendTerminalSection(transitionStatus(readFileSync5(active.path, "utf8"), "done", closedAt), "closed", {
        reason: "completion gate passed (plugin-verified)",
        ...selfChecks.length > 0 ? { checks: selfChecks } : {},
        outcomes: outcomes.map((o) => ({ index: o.index, ok: o.ok, label: o.label, detail: o.detail, durationMs: o.durationMs })),
        outcomeOutputLimit: OUTPUT_LIMIT
      }, closedAt);
      atomicWrite(active.path, closed2);
      context.metadata({ title: `Plan done: ${active.doc.goal}` });
      return {
        title: "plan done",
        output: `Plan completed and closed (done, plugin-verified): ${relFrom(state.worktree, active.path)}. All ${outcomes.length} frozen verification items re-run passing at the gate. Terminal section "## ${closedAt} — closed" appended with the per-check evidence summary.`
      };
    }
    if (!args.checks) {
      throw new PlanError(`Completion gate check failed:
- This plan declares no verification checks; pass one self-check entry per acceptance criterion (criterion/pass/evidence).`);
    }
    const failures = closeCheckFailures(active.doc, args.checks);
    if (failures.length > 0) {
      throw new PlanError(`Completion gate check failed:
- ${failures.join(`
- `)}
Fix the implementation and retry, or revise the plan first.`);
    }
    const closed = appendTerminalSection(transitionStatus(readFileSync5(active.path, "utf8"), "done", closedAt), "closed", { reason: "completion gate passed (plugin-verified)", checks: args.checks }, closedAt);
    atomicWrite(active.path, closed);
    context.metadata({ title: `Plan done: ${active.doc.goal}` });
    return {
      title: "plan done",
      output: `Plan completed and closed (done, plugin-verified): ${relFrom(state.worktree, active.path)}. All ${args.checks.length} self-checks passed. Terminal section "## ${closedAt} — closed" appended with the per-criterion verdicts.`
    };
  }
});
var planReopenTool = tool({
  description: "Reopen the session's done plan (done -> approved) — the explicit rollback window after a plugin-verified close. Call it ONLY on the user's explicit instruction (they read the close evidence and asked to reopen); NEVER self-initiate. Appends a dated `— reopened` section (parser-inert), rebinds this session to the plan, and restores the approved workflow: plan_tick / plan_close (a later close re-runs the SAME frozen checks and appends a second dated close section; the frontmatter status is the single current truth). No dialog — this is a discipline-layer tool.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply and in the appended reopened section, verbatim")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    let target = null;
    if (state.planPath && existsSync(state.planPath)) {
      const doc2 = parsePlanLoose(readFileSync5(state.planPath, "utf8"));
      if (doc2)
        target = { path: state.planPath, doc: doc2 };
    }
    if (!target || target.doc.status !== "done") {
      const done = readPlanDir(state.worktree).map((e) => ({ name: e.name, doc: parsePlanLoose(e.text) })).filter((e) => e.doc !== null && e.doc.status === "done").sort((a, b) => a.doc.updated < b.doc.updated ? 1 : a.doc.updated > b.doc.updated ? -1 : a.name.localeCompare(b.name))[0];
      if (done)
        target = { path: join5(planDirOf(state.worktree), done.name), doc: done.doc };
    }
    if (!target || target.doc.status !== "done") {
      throw new PlanError("No done plan to reopen in this workspace (only a closed plan can be reopened).");
    }
    const now = nowIso();
    const next = appendReopenSection(transitionStatus(readFileSync5(target.path, "utf8"), "approved", now), now, args.reason);
    atomicWrite(target.path, next);
    state.planPath = target.path;
    const p = progressOf(target.doc);
    context.metadata({ title: `Plan reopened: ${target.doc.goal}` });
    return {
      title: "plan reopened",
      output: `Plan reopened (done -> approved): ${relFrom(state.worktree, target.path)} (${p.done}/${p.total} tasks still ticked). Session rebound to it; continue with plan_tick / plan_close — the frozen verification checks re-run at the next close.${args.reason ? ` Reason: ${args.reason}` : ""}`
    };
  }
});
var planDiscardTool = tool({
  description: "Abandon the session's active plan (draft/approved -> abandoned) and lift the draft write ban. Pass `supersede` (the successor artifact's path or identifier, e.g. a .opencode/crew/ or .opencode/goal/ file) when the work is not ending but moving to another harness (crew orchestration, a goal contract): the plan then becomes superseded instead of abandoned, with the successor recorded. Either way a dated terminal section carrying the reason verbatim (a missing reason lands as `reason: (none given)`) is appended to the file in the SAME write as the status flip, and the file stays in .opencode/plan/ as history. Invoke via /plan discard or directly when the user cancels the task.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply and in the appended terminal section, verbatim"),
    supersede: tool.schema.string().optional().describe("Successor artifact's path or identifier (crew record, goal contract, ...); when present the plan becomes superseded instead of abandoned and this value is persisted as the successor reference")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const active = resolveActivePlan(state);
    if (!active)
      throw new PlanError("No plan to abandon in this workspace.");
    const successor = (args.supersede ?? "").trim();
    const superseding = successor.length > 0;
    const target = superseding ? "superseded" : "abandoned";
    const exitedAt = nowIso();
    const next = appendTerminalSection(transitionStatus(readFileSync5(active.path, "utf8"), target, exitedAt), superseding ? "superseded" : "abandoned", { reason: args.reason, ...superseding ? { successor } : {} }, exitedAt);
    atomicWrite(active.path, next);
    state.planPath = undefined;
    const section = `## ${exitedAt} — ${target}`;
    context.metadata({ title: superseding ? `Plan superseded: ${active.doc.goal}` : `Plan abandoned: ${active.doc.goal}` });
    return {
      title: superseding ? "plan superseded" : "plan abandoned",
      output: superseding ? `Plan superseded (not abandoned): ${relFrom(state.worktree, active.path)}. Terminal section "${section}" appended (successor: ${successor}). Write operations are restored.` : `Plan abandoned: ${relFrom(state.worktree, active.path)}. Terminal section "${section}" appended. Write operations are restored.`
    };
  }
});
function goalDirOf(worktree) {
  return join5(worktree, ".opencode", "goal");
}
function readGoalDir(worktree) {
  const dir = goalDirOf(worktree);
  if (!existsSync(dir))
    return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((name) => ({ name, text: readFileSync5(join5(dir, name), "utf8") }));
}
function resolveSessionGoal(state) {
  if (state.goalPath && existsSync(state.goalPath)) {
    const doc2 = parseGoalLoose(readFileSync5(state.goalPath, "utf8"));
    if (doc2 && !isGoalTerminal(doc2.status))
      return { path: state.goalPath, doc: doc2 };
    state.goalPath = undefined;
  }
  const live = rankLiveGoals(readGoalDir(state.worktree))[0];
  if (live) {
    const path = join5(goalDirOf(state.worktree), live.name);
    state.goalPath = path;
    return { path, doc: live.doc };
  }
  return null;
}
function resolveLiveGoal(state) {
  const g = resolveSessionGoal(state);
  return g && (g.doc.status === "active" || g.doc.status === "paused") ? g : null;
}
function coerceChecks(rows2) {
  const items = [];
  for (const c of rows2) {
    if ([c.shell, c.containsFile, c.containsText].some((v) => typeof v === "string" && v.includes("`"))) {
      throw new GoalError("Verification items must not contain backticks (they break the goal file format)");
    }
    if (typeof c.shell === "string" && c.shell.trim()) {
      items.push({ kind: "shell", cmd: c.shell.trim(), ...c.timeoutSec ? { timeoutSec: Math.min(Math.max(1, c.timeoutSec), 600) } : {} });
    } else if (typeof c.containsFile === "string" && c.containsFile.trim() && typeof c.containsText === "string" && c.containsText.trim()) {
      items.push({ kind: "contains", file: c.containsFile.trim(), text: c.containsText });
    } else {
      throw new GoalError("Each verification item needs either `shell` or both `containsFile` and `containsText`");
    }
  }
  return items;
}
var goalWriteTool = tool({
  description: "Only used inside the /goal flow (the user ran /goal or explicitly asked for a goal loop) — never self-initiate. Create or revise the session's goal contract (written to .opencode/goal/<date>-<slug>.md). Creating with arm=true arms the autonomous continuation loop — a user confirmation dialog IS the arm action; arm=false only queues an inert goal (/goal add). While this session already has a live goal, creating another is refused — pass revise=true to edit the current contract instead (bumps the revision; evidence from earlier revisions no longer counts; budgets carry over unless explicitly changed). Orthogonal to plans: never reads plan state.",
  args: {
    goal: tool.schema.string().describe("One-line goal statement (the semantic completion requirement)"),
    criteria: tool.schema.array(tool.schema.string()).describe("Success Criteria: numbered, verifiable outcomes"),
    checks: tool.schema.array(tool.schema.object({
      shell: tool.schema.string().optional().describe("Shell command the plugin itself executes on the host"),
      containsFile: tool.schema.string().optional().describe("File contract: workspace-relative file path"),
      containsText: tool.schema.string().optional().describe("File contract: required literal text in that file"),
      timeoutSec: tool.schema.number().int().positive().optional().describe("Shell timeout in seconds (default 120, max 600)")
    })).describe("Verification Checks: at least one; each item is a shell command or a file::text contract"),
    constraints: tool.schema.string().describe("Constraints: boundaries the work must respect"),
    nonGoals: tool.schema.array(tool.schema.string()).optional().describe("Non-Goals: explicit out-of-scope items"),
    maxTurns: tool.schema.number().int().positive().optional().describe("Turn budget (default 25, hard max 200)"),
    maxMinutes: tool.schema.number().int().positive().optional().describe("Wall-clock budget in minutes (default 60, hard max 480)"),
    arm: tool.schema.boolean().optional().describe("true = arm the loop now (user dialog); false = queue inert (/goal add)"),
    revise: tool.schema.boolean().optional().describe("true = edit the existing goal's contract instead of refusing (revision bump)")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const now = nowIso();
    const checks3 = coerceChecks(args.checks);
    const input = {
      goal: args.goal,
      criteria: args.criteria,
      checks: checks3,
      constraints: args.constraints,
      ...args.nonGoals ? { nonGoals: args.nonGoals } : {},
      ...args.maxTurns ? { maxTurns: args.maxTurns } : {},
      ...args.maxMinutes ? { maxMinutes: args.maxMinutes } : {}
    };
    const existing = resolveSessionGoal(state);
    if (existing && args.revise !== true) {
      throw new GoalError(`This session already has a goal: ${relFrom(state.worktree, existing.path)} (status: ${existing.doc.status}). Re-run goal_write with revise=true to edit its contract, /goal add to queue a new one, or goal_discard to abandon it first.`);
    }
    if (existing) {
      const text2 = carryHistory(renderGoal({
        ...input,
        ...input.maxTurns === undefined ? { maxTurns: existing.doc.maxTurns } : {},
        ...input.maxMinutes === undefined ? { maxMinutes: existing.doc.maxMinutes } : {}
      }, {
        now,
        status: existing.doc.status,
        created: existing.doc.created,
        revision: existing.doc.revision + 1,
        ...existing.doc.session ? { session: existing.doc.session } : {},
        turnsUsed: existing.doc.turnsUsed,
        ...existing.doc.armedAt ? { armedAt: existing.doc.armedAt } : {},
        ...existing.doc.status === "paused" && existing.doc.stopReason ? { stopReason: existing.doc.stopReason, blocker: existing.doc.blocker } : {}
      }), existing.doc);
      atomicWrite(existing.path, text2);
      const doc3 = parseGoal(text2);
      const retry = goalNativeRecheck.get(doc3.session);
      const flight = continuationInFlight.get(doc3.session) ?? goalDeadlineTimers.get(doc3.session);
      if (doc3.status === "active" && (retry || flight)) {
        goalStopNativeRecheck(doc3.session);
        goalArmNativeRecheck(doc3.session, (retry || flight).client, { path: existing.path, doc: doc3 }, retry ? retry.deadlineOnly : false);
        goalArmDeadline(doc3.session, (retry || flight).client, { path: existing.path, doc: doc3 });
      }
      context.metadata({ title: `Revise goal (rev ${doc3.revision}): ${doc3.goal}` });
      return {
        title: `goal revised (rev ${doc3.revision})`,
        output: [
          `Goal contract revised: ${relFrom(state.worktree, existing.path)} (revision ${doc3.revision}).`,
          `Evidence recorded under earlier revisions no longer counts. Status stays ${doc3.status}; budget stays ${doc3.turnsUsed}/${doc3.maxTurns} turns.`
        ].join(`
`)
      };
    }
    const arm = args.arm !== false;
    if (arm) {
      const plan = resolveActivePlan(state);
      if (plan && plan.doc.status === "draft") {
        throw new GoalError(`This session has a plan in draft (${relFrom(state.worktree, plan.path)}); autonomous execution cannot arm against the planning-phase write ban. Approve the plan (plan_approve) or discard it (/plan discard) first.`);
      }
      await gate(context.ask, "goal_write", `Arm goal: ${args.goal}`);
    }
    const dir = goalDirOf(state.worktree);
    mkdirSync3(dir, { recursive: true });
    const name = goalFileName(localDateNow(), slugifyGoal(args.goal), readdirSync(dir).filter((f) => f.endsWith(".md")));
    const path = join5(dir, name);
    const text = renderGoal(input, {
      now,
      status: arm ? "active" : "queued",
      ...arm ? { session: context.sessionID, armedAt: now } : {}
    });
    atomicWrite(path, text);
    state.goalPath = path;
    const doc2 = parseGoal(text);
    context.metadata({ title: `${arm ? "Arm" : "Queue"} goal: ${doc2.goal}` });
    return {
      title: `goal ${arm ? "armed" : "queued"}: ${doc2.goal}`,
      output: arm ? [
        `Goal armed: ${relFrom(state.worktree, path)} (revision 1, ${doc2.criteria.length} criteria, ${doc2.checks.length} verification items, budget ${doc2.maxTurns} turns / ${doc2.maxMinutes} min).`,
        "The loop is intended to continue this session on eligible idle turns until the goal completes, pauses, or the budget runs out. Work the criteria; call goal_check whenever you believe they hold; goal_complete re-runs every check itself and asks the user. If globally blocked with no independent authorized work remaining, call goal_pause with the concrete blocker. If a local issue leaves independent authorized work, continue that work. End your turn during genuine host waiting rather than polling."
      ].join(`
`) : `Goal queued (inert): ${relFrom(state.worktree, path)}. It never runs until promoted via /goal next or goal_resume (user dialog).`
    };
  }
});
var goalCheckTool = tool({
  description: "Run the goal's verification items on the host (shell commands executed by the plugin in the workspace, file contracts re-read from disk) and append the dated, revision-stamped results to the goal's Check Log. Advisory feedback — only goal_complete has gating authority.",
  args: {
    items: tool.schema.array(tool.schema.number().int().positive()).optional().describe("Optional subset of verification item numbers; omit to run all")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const goal = resolveSessionGoal(state);
    if (!goal || goal.doc.status !== "active" && goal.doc.status !== "paused") {
      throw new GoalError("No live goal in this workspace (active or paused). Arm one with /goal <objective> first.");
    }
    const wanted = args.items ? new Set(args.items) : null;
    const selected = goal.doc.checks.map((c, i) => ({ c, n: i + 1 })).filter((x) => !wanted || wanted.has(x.n));
    if (selected.length === 0)
      throw new GoalError("None of the given item numbers exist in this goal's Verification Checks.");
    const activity = turnActivity.get(context.sessionID);
    const outcomes = await runChecks(selected.map((x) => x.c), state.worktree);
    outcomes.forEach((o, i) => {
      o.index = selected[i].n;
    });
    const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = appendCheckLog(readFileSync5(goal.path, "utf8"), runId, outcomes, nowIso());
    atomicWrite(goal.path, next);
    const ok = outcomesAllOk(outcomes);
    context.metadata({ title: `goal_check: ${outcomes.filter((o) => o.ok).length}/${outcomes.length} pass` });
    const output = [
      `Host verification run (revision ${goal.doc.revision}), recorded in the Check Log:`,
      formatOutcomes(outcomes),
      ok ? "All selected items pass. Proceed to goal_complete (it re-runs everything itself at the gate)." : "Failing items remain — fix the work, then re-run goal_check."
    ].join(`
`);
    if (activity && turnActivity.get(context.sessionID) === activity)
      rememberGoalCheck(activity, selected, outcomes, output);
    return { title: `goal_check ${ok ? "all pass" : "failing"}`, output };
  }
});
var goalCompleteTool = tool({
  description: "Close the goal (active -> completed). Re-executes EVERY verification item itself on the host right now (fail-closed: any failing shell command, timeout, missing file, or absent contract text refuses completion) and requires a per-criterion attestation array (pass + concrete evidence). Only then does the user confirmation dialog appear — the user's Allow closes the goal.",
  args: {
    attestations: tool.schema.array(tool.schema.object({
      criterion: tool.schema.string().describe("The success criterion text, copied verbatim from the goal"),
      pass: tool.schema.boolean().describe("Whether the criterion is met"),
      evidence: tool.schema.string().describe("Concrete evidence: file:line, command output, test result")
    })).describe("One entry per success criterion of the current revision, in goal order")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const goal = resolveSessionGoal(state);
    if (!goal || goal.doc.status !== "active") {
      throw new GoalError(`No active goal to complete (status: ${goal?.doc.status ?? "none"}). goal_resume an active loop first.`);
    }
    const outcomes = await runChecks(goal.doc.checks, state.worktree);
    const failures = outcomes.filter((o) => !o.ok);
    if (failures.length > 0) {
      const runId2 = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`;
      atomicWrite(goal.path, appendCheckLog(readFileSync5(goal.path, "utf8"), runId2, outcomes, nowIso()));
      throw new GoalError(`Completion gate: verification re-run failed (fail-closed). The goal stays active.
${formatOutcomes(failures)}
Fix the work and retry; recorded results never substitute for the gate's own re-run.`);
    }
    const attestationFailures = completeCheckFailures(goal.doc, args.attestations);
    if (attestationFailures.length > 0) {
      throw new GoalError(`Completion gate: self-attestation failed (revision ${goal.doc.revision}).
- ${attestationFailures.join(`
- `)}`);
    }
    await gate(context.ask, "goal_complete", `Complete goal: ${goal.doc.goal}`);
    const runId = `${nowIso()}-${Math.random().toString(36).slice(2, 8)}`;
    let text = appendCheckLog(readFileSync5(goal.path, "utf8"), runId, outcomes, nowIso());
    text = transitionGoal(text, "completed", nowIso());
    atomicWrite(goal.path, text);
    context.metadata({ title: `Goal completed: ${goal.doc.goal}` });
    return {
      title: "goal completed",
      output: `Goal completed and closed: ${relFrom(state.worktree, goal.path)}. All ${outcomes.length} verification items re-run passing at the gate; ${args.attestations.length} attestations recorded.`
    };
  }
});
var goalPauseTool = tool({
  description: "Pause the session's live goal (active -> paused); do not start further autonomous work. Already accepted host work may finish; cancellation is not promised. Always safe, no confirmation needed. Pass the blocker text when pausing because you are stuck (stop_reason blocker); omit it for a user-requested pause.",
  args: {
    blocker: tool.schema.string().optional().describe("Specific blocker that prevents progress (recorded as stop_reason blocker)")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const goal = resolveSessionGoal(state);
    if (!goal || goal.doc.status !== "active") {
      throw new GoalError(`No active goal to pause (status: ${goal?.doc.status ?? "none"}).`);
    }
    const stopReason = args.blocker?.trim() ? "blocker" : "user";
    atomicWrite(goal.path, transitionGoal(readFileSync5(goal.path, "utf8"), "paused", nowIso(), { stopReason, blocker: args.blocker?.trim() }));
    engineForgetSession(context.sessionID);
    if (goal.doc.session && goal.doc.session !== context.sessionID)
      engineForgetSession(goal.doc.session);
    context.metadata({ title: `Goal paused (${stopReason}): ${goal.doc.goal}` });
    return {
      title: `goal paused (${stopReason})`,
      output: `Goal paused: ${relFrom(state.worktree, goal.path)} (stop_reason: ${stopReason}${args.blocker ? ` — ${args.blocker}` : ""}). Do not start further autonomous work; already accepted host work may finish. /goal resume or an explicit "continue" from the user re-arms it through a confirmation dialog.`
    };
  }
});
var goalResumeTool = tool({
  description: "Re-arm a paused goal, or promote the oldest queued goal (/goal next). A user confirmation dialog IS the re-arm action. Optionally tops up the turn budget (hard-capped). Ownership rebinds to this session. When the goal is paused and the user explicitly says continue/resume, this is the tool to call; ordinary chat must never reactivate a goal.",
  args: {
    addTurns: tool.schema.number().int().positive().optional().describe("Extra turns to add to the budget (capped by the hard ceiling)")
  },
  execute: async (args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    let goal = resolveSessionGoal(state);
    if (!goal || goal.doc.status === "queued") {
      const oldest = rankQueuedGoals(readGoalDir(state.worktree))[0];
      if (oldest) {
        const path = join5(goalDirOf(state.worktree), oldest.name);
        state.goalPath = path;
        goal = { path, doc: oldest.doc };
      }
    }
    if (!goal || goal.doc.status !== "paused" && goal.doc.status !== "queued") {
      throw new GoalError(`No paused or queued goal to resume (status: ${goal?.doc.status ?? "none"}).`);
    }
    const promoting = goal.doc.status === "queued";
    await gate(context.ask, "goal_resume", `${promoting ? "Promote" : "Resume"} goal: ${goal.doc.goal}`);
    let text = readFileSync5(goal.path, "utf8");
    const confirmed = parseGoalLoose(text);
    if (!confirmed || confirmed.status !== goal.doc.status || confirmed.revision !== goal.doc.revision || confirmed.armedAt !== goal.doc.armedAt || confirmed.session !== goal.doc.session || confirmed.created !== goal.doc.created) {
      throw new GoalError("Goal authorization changed while awaiting confirmation; retry goal_resume.");
    }
    if (args.addTurns)
      text = bumpBudget(text, args.addTurns, nowIso());
    text = transitionGoal(text, "active", nowIso(), { session: context.sessionID });
    atomicWrite(goal.path, text);
    state.goalPath = goal.path;
    engineForgetSession(context.sessionID);
    const doc2 = parseGoal(text);
    context.metadata({ title: `${promoting ? "Goal promoted" : "Goal resumed"}: ${doc2.goal}` });
    return {
      title: promoting ? "goal promoted" : "goal resumed",
      output: `Goal ${promoting ? "promoted from the queue and armed" : "resumed"}: ${relFrom(state.worktree, goal.path)} (budget ${doc2.turnsUsed}/${doc2.maxTurns} turns, owned by this session). The loop continues on the next idle.`
    };
  }
});
var goalDiscardTool = tool({
  description: "Abandon the session's goal (live or queued -> abandoned) and stop the loop. A user confirmation dialog IS the discard action — abandoning the user's objective is the user's decision. The file stays in .opencode/goal/ as history.",
  args: {
    reason: tool.schema.string().optional().describe("Short reason recorded in the reply")
  },
  execute: async (_args, context) => {
    const state = ensureSession(context.sessionID, worktreeFor(context));
    const goal = resolveSessionGoal(state);
    if (!goal)
      throw new GoalError("No goal to discard in this workspace.");
    await gate(context.ask, "goal_discard", `Discard goal: ${goal.doc.goal}`);
    atomicWrite(goal.path, transitionGoal(readFileSync5(goal.path, "utf8"), "abandoned", nowIso()));
    state.goalPath = undefined;
    engineForgetSession(context.sessionID);
    context.metadata({ title: `Goal abandoned: ${goal.doc.goal}` });
    return {
      title: "goal abandoned",
      output: `Goal abandoned: ${relFrom(state.worktree, goal.path)}${_args.reason ? ` (${_args.reason})` : ""}. The file remains as history; the loop is stopped.`
    };
  }
});
function bindChildToDirectory(childSessionID, directory) {
  if (!childSessionID || !directory || isRootish(directory))
    return;
  ensureSession(childSessionID, directory);
}
var CREW_INIT_TEMPLATE = [
  '(forge crew orchestration. Argument: "$ARGUMENTS")',
  "",
  "FAMILY GUARD (step 0, before anything else): if you do not have the crew_begin tool in your available tools, you are not in a forge session — STOP now and tell the user that /crew belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
  "",
  "CREW IS NOT INITIALIZED: no forge subagent is materialized for this session's roster (neither the workspace pool nor the global fallback yields an agent). Refuse to enter orchestration and tell the user this feature needs a one-time setup, offering BOTH options:",
  "",
  "1. The user configures it themselves — create either layer, SOLE OWNERSHIP (the same workspace-ownership strictness as opencode's native MCP config): the workspace pool is the NEAREST .opencode/forge.json walking up from this session's worktree, and when it exists it IS the session's whole roster; the global layer serves only as the fallback when the workspace has none — a fallback, NOT a merge (a workspace with a pool never sees global agents; nested forge.json files deeper in the workspace subtree are ignored entirely):",
  "{paths}",
  "",
  "Two axes, distinct: POOLS follow workspaces (sole ownership above — dispatch is gated to the session's own pool / the global fallback); SESSION ARTIFACTS (plan/goal/crew records) follow the session. A forge.json in another workspace is not dispatchable from this session.",
  "",
  '2. Or, ONLY if the user explicitly asks you to configure it in this conversation, you may write the file yourself through the normal write path. NEVER write forge.json without that explicit go-ahead. When you configure it: name ids as PLAIN role words WITHOUT the `forge-` prefix (a `forge-`-prefixed id doubles up and is auto-stripped with a warning) — every pool materializes as `forge-<ns>-<id>` under its `pool` namespace (the global fallback materializes as `forge-global-<id>`). Give EVERY agent a SHORT prompt derived from the role the user asked for — one or two sentences describing its job (the user trims or extends from there); write a long prompt ONLY when the user explicitly asks for that agent. Give EVERY agent an EXPLICIT `shape`: `readonly` for read-only roles (reviewer/scout/planner — denies write/edit/bash and the patch family), `write` for implementers and build drivers. ALWAYS include the top-level `pool` namespace (a [a-z0-9-] word up to 24 chars — e.g. "aa" for a specialist pool): it is REQUIRED for crew-governed dispatch (the compliance gate) and keeps the materialized ids stable across directory renames.',
  "",
  'Template (JSONC — comments allowed): ids are plain role words (research, coder, ...) — every pool materializes as `forge-<ns>-<id>` (the global fallback materializes as `forge-global-<id>`); `model` + `thoughtLevel` are an ATOMIC PAIR — set BOTH to pin the brain and depth (model = exact provider/model identity; thoughtLevel = none/low/medium/high/max or a native level name), or NEITHER for an Auto worker that inherits the parent session\'s model; exactly one of the two is rejected. Optional per agent: `prompt` — a short role description; an explicit prompt FULLY overrides the built-in role (only the ids `research` and `review` carry built-ins; any other id without a prompt gets a generic one-liner and will not know its job). Optional per agent: `shape` — an ABSENT shape defaults to WRITE (open permissions — the compatibility-preserving default for existing pools); `shape: "readonly"` is the explicit seal that denies the mutating-tool family (write/edit/bash + patch/applypatch/apply/multiedit) for read-only roles. Top level: `pool` — the file\'s namespace, REQUIRED for crew-governed dispatch.',
  "{template}",
  "",
  "After the file is saved: file edits, creations, and deletions apply at the next config hook — NO host restart is needed, and a DELETED pool file un-materializes its agents (deletion is real — no zombie pools survive on disk truth)."
].join(`
`);
function crewOrchestrationTemplate(resolution) {
  const families = resolution?.families ?? [];
  const globalPath = forgeConfigPaths({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global;
  const otherLines = families.map((f) => {
    const label = `pool ${f.ns} (forge-${f.ns}-*)`;
    return `  - ${label} — origin ${f.file} — NOT dispatchable from this session (unless this session's worktree is owned by that pool / it is the global fallback): ${f.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`;
  });
  return [
    '(forge crew orchestration. Argument: "$ARGUMENTS")',
    "",
    "FAMILY GUARD (step 0, before anything else): if you do not have the crew_begin tool in your available tools, you are not in a forge session — STOP now and tell the user that /crew belongs to the forge agent, who should switch to forge (Tab) and rerun it there.",
    "",
    "Configured forge subagents (native subagent tool). ROSTER OWNERSHIP (sole ownership): THIS session's dispatchable roster is its WORKSPACE pool — the nearest .opencode/forge.json walking up from this session's worktree — or, when the workspace has none, the GLOBAL fallback layer (a fallback, not a merge; forge.json files nested deeper in the workspace subtree are ignored, same as opencode's native MCP config). Check this workspace's pool:",
    '  - this workspace pool (when the path prints, its agents ARE the roster): !`ls .opencode/forge.json 2>/dev/null || echo "(no workspace pool — the global fallback applies)"`',
    `  - global fallback layer: ${globalPath} — dispatchable ONLY when the workspace has no pool of its own`,
    ...otherLines.length > 0 ? ["Other pools materialized on this host — each NOT dispatchable from this session (open a session in that workspace, or configure the role into this workspace's pool / the global layer):", ...otherLines] : [],
    "",
    "You are entering CREW ORCHESTRATION discipline for this session (single subject: do not switch agents). The macro contract above the crew may come from an approved plan, a spec change, or inline text — the discipline is identical in all three cases and never requires a plan. Follow it exactly:",
    "",
    '1. REGISTER: call `crew_begin` with the objective AND the declared subtask plan (subtasks[]: one {title} per subtask, optionally naming the intended forge-* agent). When the macro contract descends from a plan artifact, pass its path as the optional `lineage` argument (e.g. lineage: ".opencode/plan/2026-10-01-my-plan.md") — the descent is recorded as a first-class line in the crew record header; lineage is never inferred. Reconnaissance BEFORE registration is subject to ordinary host permissions and existing approvals. If crew_begin refuses (a crew is already active here, or a plan draft is active), STOP and tell the user why — never start a second crew. A wrong plan is fixed by abandoning and re-crewing (crew_close {abandon: true, reason}), never by improvising outside the declared plan.',
    `2. THE PAUSE: registration enters a PENDING crew — execution has NOT started. STOP and present the user the three execution-mode choices (supervised waves now / convert to a goal contract / standby), then END YOUR TURN. Arm per the user's choice: waves → crew_begin {execution: "waves"} (waves then continue on session idle only after verified settlement and while authorization remains — if stalled, seek the user’s decision or re-shard within existing approvals); conversion → crew_begin {execution: "goal"} followed by goal_write (arm=true — its dialog is the user's gate) folding the declared subtasks into criteria/checks; standby → no call. EXCEPTION: while a live active goal governs this session, register with execution: "waves" in the SAME call — the crew is born armed (the goal contract already authorized orchestration) and crew_close / abandon stay ask-free under that goal.`,
    `3. WAVES, NEVER FLOODS (armed crews only): ${CREW_WAVE_RULE} GUI / computer-use subtasks are mutually exclusive within a wave (the desktop is a singleton resource — at most ONE in flight; non-GUI subtasks still parallelize freely), and GUI walkthroughs use the \`computer\` tool rather than DIY shell screenshot pipelines. ${CREW_NATIVE_FALLBACK_RULE}`,
    "4. CONTRACT RELAY (lineage-descended crews): when the macro contract descends from an on-disk artifact (the lineage names a plan artifact, a spec change directory, or a goal contract), every subtask's dispatch prompt MUST explicitly carry that artifact's path — or the exact slice the subtask works from (a delta file path, a quoted criteria section) — so the dispatched worker reads the contract itself, never your paraphrase of it. A large artifact is relayed by its exact slice; it is NEVER dropped for being too long to inline. Every close-report evidence statement MUST name the contract (or slice) the subtask worked against.",
    "5. MISSING ROLE: when a subtask needs a role no configured forge-* agent matches, tell the user about the gap — suggest configuring the missing role in forge.json. Use only an authorized native subagent for that work.",
    "6. VERIFY: judge each subtask strictly against its acceptance-evidence statement using the child's report and verified evidence. Associate the declared title with the work rounds (including a reused session), attempts and any recorded fallback. A host terminal outcome alone does not establish PASS; unknown or incomplete evidence cannot establish PASS.",
    "7. RETRY AT MOST ONCE: a failed subtask may be retried once with an adjusted prompt or agent, subject to existing approvals. Keep both attempts visible; only verified successful evidence supports PASS after a failure. If the retry also fails, record FAIL with BOTH failure reports visible (attempts[]). Do not retry twice, do not paper over a failure.",
    "8. CLOSE: when all work rounds are verified settled and every declared subtask has a verdict, call `crew_close` with the full report (title/verdict/evidence per subtask; attempts[] for FAILs). The gate cross-checks the report against the declared plan — a declared subtask missing from the report refuses the close, and so does an undeclared one. The user confirms the closing dialog under existing approval rules."
  ].join(`
`);
}
var crewBeginTool = tool({
  description: `Register this session's crew (from /crew) with its DECLARED subtask plan — the crew starts PENDING: the execution-mode choice (waves / convert to goal / standby) is the user's. Dual-purpose: called with {execution} ONLY (no objective/subtasks) it ARMS the pending crew — "waves" lifts the dispatch belt, "goal" ends the crew as a conversion record (the following goal_write arm dialog is the user's gate). One-call register+arm ({objective, subtasks, execution:"waves"}) is legal ONLY while a live active goal governs the session (born armed, never pends). Refuses: active crew, plan draft, missing/duplicated subtasks, a non-compliant workspace pool file (missing/invalid top-level "pool" namespace — required for crew-governed dispatch). Crew state is in-memory: a host restart ends it honestly.`,
  args: {
    objective: tool.schema.string().optional().describe("One-line crew objective (from /crew) — required on registration, ABSENT on the arm call"),
    execution: tool.schema.string().optional().describe('Arm action: "waves" (supervised waves — lifts the belt) or "goal" (convert to a goal contract). Alone = arm the pending crew; with objective+subtasks = one-call born-armed registration, legal only under a governing active goal.'),
    subtasks: tool.schema.array(tool.schema.object({
      title: tool.schema.string().describe("Short unique subtask title — the crew_close report must use these exact titles"),
      agent: tool.schema.string().optional().describe("Intended forge-* agent id for this subtask, when one matches")
    })).optional().describe("The declared subtask plan (REQUIRED on registration, ABSENT on the arm call) — decompose the objective into these before any execution; crew_close cross-checks the report against exactly this list"),
    lineage: tool.schema.string().optional().describe("Free-text origin of the macro contract — e.g. the plan artifact path this crew descends from (.opencode/plan/<date>-<slug>.md). Recorded as a first-class lineage: line in the crew record header and disclosed in the registration output. Explicit argument only — never inferred from recently-terminal plans.")
  },
  execute: async (args, context) => {
    noteToolAgent(context);
    const state = await stateForCheck(context.sessionID, sharedAnchorClient());
    const active = state ? resolveActivePlan(state) : null;
    if (active && active.doc.status === "draft") {
      throw new Error("[forge:crew] A plan is in draft; crew orchestration is denied during planning. Three exits: " + "plan_approve puts the plan to user approval (an APPROVED plan does not block /crew — only a draft does); " + "/plan discard abandons the plan outright; " + '/plan discard {supersede: "<successor path or id>"} moves the work into this crew (the plan becomes superseded, the successor recorded).');
    }
    const resolution = resolvePools();
    const anchorClient = sharedAnchorClient();
    const anchor = anchorClient && typeof anchorClient.session?.get === "function" ? await resolveSessionAnchorForPools(anchorClient, context.sessionID) || sessionAnchor(context) : sessionAnchor(context);
    if (anchor)
      ensureSession(context.sessionID, anchor);
    const sessionLoaded = anchor ? loaderForAnchor(anchor).load() : null;
    const sessionProject = sessionLoaded?.projectPath ?? null;
    const globalPoolPath = forgeConfigPaths({ homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global;
    const sessionPool = sessionProject;
    const sessionFamily = resolution?.families.find((f) => foldPath3(f.file) === foldPath3(sessionPool ?? globalPoolPath)) ?? null;
    const sessionCovered = sessionPool === null || sessionFamily !== null;
    const sessionRosterIds = sessionFamily ? sessionFamily.materializedIds : [];
    if (sessionRosterIds.length === 0) {
      const paths = forgeConfigPaths({ projectDir: anchor || undefined, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() });
      const lines2 = [
        `[forge:crew] CREW IS NOT INITIALIZED: no forge subagent is materialized for this session's roster (neither the workspace pool nor the global fallback yields an agent). Crew orchestration is unavailable until the user sets it up.`,
        `Two layers, SOLE OWNERSHIP: the workspace pool — the NEAREST .opencode/forge.json walking up from this session's worktree (${paths.project}) — IS the whole roster when it exists; the global layer (${paths.global}) serves only as the fallback when the workspace has none (a fallback, NOT a merge; forge.json files nested deeper in the workspace subtree are ignored — the same workspace-ownership strictness as opencode's native MCP config).`,
        "Two axes, distinct: POOLS follow workspaces (sole ownership above — dispatch is gated to the session's own pool / the global fallback); SESSION ARTIFACTS (plan/goal/crew records) follow the session. A forge.json in another workspace is not dispatchable from this session.",
        `Template (JSONC): the top-level "pool" field names this file's namespace (short stable [a-z0-9-] up to 24 chars — REQUIRED for crew-governed dispatch; every pool materializes as forge-<ns>-<id>, the global fallback materializes as forge-global-<id>); {"pool": "short-stable-namespace", "agents": {"research": {"model": "provider/model", "thoughtLevel": "low", "shape": "readonly", "prompt": "short role description"}}} — an absent shape defaults to WRITE (open permissions); "shape": "readonly" is the explicit seal denying write/edit/bash + the patch family for read-only roles.`,
        "Agent ids are plain role words WITHOUT the `forge-` prefix — every pool materializes as `forge-<ns>-<id>` under its `pool` namespace (the global fallback materializes as `forge-global-<id>`); a prefixed id is auto-stripped with a warning.",
        "The user may configure it themselves, or ask you to write the file — only on their explicit go-ahead. When you write it: give every agent a SHORT prompt from the role the user asked for (one or two sentences; long only on explicit request), give every agent an EXPLICIT shape (readonly for read-only roles like reviewer/scout/planner; write for implementers and build drivers), and INCLUDE the top-level `pool` namespace — it is REQUIRED for crew-governed dispatch (the compliance gate refuses a missing or invalid field) and keeps ids stable across directory renames. File edits, creations, and deletions apply at the next config hook — no host restart needed, and a DELETED pool file un-materializes its agents (deletion is real).",
        "Levers: the user can also run /forge init (draft this workspace's forge.json in-band, refuse-and-review when one exists) or /forge init global (draft the global layer, built-in override entries shipped commented out) — the explicit one-command starters for exactly this setup."
      ];
      if (sessionLoaded && Object.keys(sessionLoaded.agents).length > 0 && sessionProject && !sessionCovered) {
        lines2.push(`NOTE: this session's workspace DOES have a forge.json (${sessionProject}) with usable agents — but this host has NOT materialized it (no initialization in that workspace). Re-initialize the host in that workspace, or move the agents into the global layer (${globalPoolPath}).`);
      }
      throw new Error(lines2.join(`
`));
    }
    const execution = typeof args.execution === "string" ? args.execution.trim().toLowerCase() : "";
    if (execution && execution !== "waves" && execution !== "goal") {
      throw new Error('[forge:crew] execution must be "waves" or "goal".');
    }
    const objectiveText = String(args.objective ?? "").trim();
    const raw = Array.isArray(args.subtasks) ? args.subtasks : [];
    if (execution && !objectiveText && raw.length === 0) {
      const crew = crews.get(context.sessionID);
      if (!crew) {
        throw new Error("[forge:crew] No active crew to arm (crew state is in-memory and dies on host restart). Register one first: crew_begin {objective, subtasks}.");
      }
      if (crew.mode !== "pending") {
        throw new Error(`[forge:crew] This crew is already armed (${crew.mode}) — execute "${crew.objective}" instead of re-arming.`);
      }
      if (execution === "goal" && governingGoalFor(context.sessionID)) {
        throw new Error('[forge:crew] execution:"goal" is refused under a governing goal — this session already runs inside an active goal contract. Run supervised waves (arm or one-call register), or pause/discard the goal first if conversion is truly intended.');
      }
      if (execution === "goal") {
        crews.delete(context.sessionID);
        appendCrewRecord(crew.recordPath, "converted to goal", [
          "The crew ends here as a conversion record; the objective moves to a goal contract.",
          ...crew.subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`)
        ]);
        return {
          title: `crew converted: ${crew.objective.slice(0, 60)}`,
          output: [
            `[forge:crew] Crew ended as a CONVERSION record: ${crew.objective}`,
            "Now draft the goal contract: goal_write with arm=true, folding the declared subtasks below into its criteria and verification checks. The arm confirmation dialog is the user's gate for the whole autonomous path — do not ask again here.",
            `Declared subtasks to fold in (${crew.subtasks.length}):`,
            ...crew.subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
            `[forge:crew] Relay: the goal loop owns this plan from here — its continuation turns may re-register it as a BORN-ARMED crew in ONE call (crew_begin {objective, subtasks, execution: "waves"} — no pause mid-loop); the arming dialog already authorized this orchestration.`,
            "Preserve the subtask STRUCTURE inside the goal contract (criteria or constraints) — keep the declared titles and their forge-* agent assignments verbatim enough to re-register; do not dissolve them into prose.",
            'Born-armed registration sketch to adapt: crew_begin {objective: <this objective>, subtasks: [the declared subtasks with their agents], execution: "waves"}.'
          ].join(`
`)
        };
      }
      crew.goalGoverned = governingGoalFor(context.sessionID);
      crew.mode = "executing";
      appendCrewRecord(crew.recordPath, "armed (waves)", ["The user chose supervised waves; the dispatch belt is lifted."]);
      return {
        title: `crew armed: ${crew.objective.slice(0, 60)}`,
        output: [
          `[forge:crew] Crew ARMED for supervised waves: ${crew.objective}`,
          `Waves auto-advance on session idle until crew_close only after verified settlement of the previous wave (the engine stops after a stall — nudge or re-shard).`,
          `Declared plan (${crew.subtasks.length}):`,
          ...crew.subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
          `Proceed with the wave discipline: ${CREW_WAVE_RULE} Record per-subtask evidence verdicts, at most one retry, then crew_close with the full report covering every declared subtask under existing user approval rules.`,
          CREW_NATIVE_FALLBACK_RULE
        ].join(`
`)
      };
    }
    if (!objectiveText)
      throw new Error("crew_begin requires a non-empty objective (from /crew <objective>).");
    if (raw.length === 0)
      throw new Error("[forge:crew] crew_begin requires subtasks[] — declare the plan before executing (decompose the objective into titled subtasks).");
    const seen = new Set;
    const subtasks = [];
    for (const s of raw) {
      const title = String(s?.title ?? "").trim();
      if (!title)
        throw new Error("[forge:crew] every subtask needs a non-empty title.");
      const key = title.toLowerCase();
      if (seen.has(key))
        throw new Error(`[forge:crew] duplicate subtask title "${title}" — titles must be unique (they are the crew_close matching key).`);
      seen.add(key);
      const agent = String(s?.agent ?? "").trim();
      subtasks.push(agent ? { title, agent } : { title });
    }
    const existing = crews.get(context.sessionID);
    if (existing) {
      throw new Error(`[forge:crew] This session already has an active crew: "${existing.objective}" (started ${existing.startedAt}). Finish and close it with crew_close before starting another.`);
    }
    if (execution === "waves" && !governingGoalFor(context.sessionID)) {
      throw new Error("[forge:crew] crew_begin cannot self-arm outside a governing goal: register with {objective, subtasks} only — the pause is the user's decision point, armed by a follow-up crew_begin {execution} call per their choice.");
    }
    if (execution === "goal") {
      throw new Error('[forge:crew] execution:"goal" converts an already-registered PENDING crew — register the plan first (no execution), then convert. Under a governing goal, only "waves" one-call arming is legal (the loop already owns the goal).');
    }
    if (anchor) {
      const complianceRefusal = crewPoolComplianceRefusal(anchor);
      if (complianceRefusal)
        throw new Error(complianceRefusal);
    }
    if (nativeRosterActive()) {
      const staleRefusal = rosterStaleRefusal(anchor);
      if (staleRefusal)
        throw new Error(staleRefusal);
    }
    const governed = execution === "waves";
    const lineage = String(args.lineage ?? "").trim();
    const anchorDir = anchor || hostWorktree;
    let recordPath = null;
    let recordNote = "";
    if (anchorDir) {
      try {
        recordPath = crewRecordPathFor(anchorDir, objectiveText);
        writeCrewRecord(recordPath, objectiveText, anchorDir, subtasks, lineage || undefined);
        recordNote = `Crew record (inspectable history; NOT a resume mechanism): ${relFrom(anchorDir, recordPath)}`;
      } catch {
        recordPath = null;
        recordNote = "Crew record could not be written (fail-soft; the crew still runs).";
      }
    }
    crewEngineForgetSession(context.sessionID);
    crews.set(context.sessionID, { objective: objectiveText, startedAt: nowIso(), subtasks, mode: governed ? "executing" : "pending", recordPath, goalGoverned: governed });
    appendCrewRecord(recordPath, governed ? "registered (born armed under a governing goal)" : "registered (pending)", subtasks.map((s, i) => `${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`));
    let disclosure = "";
    if (sessionProject && !sessionCovered) {
      const localOnly = Object.keys(sessionLoaded?.agents ?? {});
      if (localOnly.length > 0) {
        disclosure = `
[forge:crew] NOTE: this session's workspace has its own forge.json (${sessionProject}) defining ${localOnly.map((id) => `forge-<ns>-${id} (namespaced by its pool)`).join(", ")} — NOT dispatchable from this session (this host has not materialized that file). Re-initialize the host in that workspace, or move the agents into the global layer (${globalPoolPath}).`;
      }
    }
    const families = resolution?.families ?? [];
    const familyLines = [];
    if (sessionFamily) {
      familyLines.push(`   - DISPATCHABLE from this session — ${sessionPool ? "workspace pool" : "global fallback"}: ${sessionFamily.file} — ${sessionFamily.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`);
    }
    for (const f of families.slice(0, 8)) {
      if (f === sessionFamily)
        continue;
      const label = `pool ${f.ns} (forge-${f.ns}-*)`;
      familyLines.push(`   - NOT dispatchable from this session — ${label}: ${f.file} — ${f.materializedIds.map((id) => `forge-${id}`).join(", ") || "no agents"}`);
    }
    if (families.length > 8)
      familyLines.push(`   - …and ${families.length - 8} more pools`);
    const lines = [
      ...recordNote ? [recordNote] : [],
      ...lineage ? [
        `Lineage: ${lineage}`,
        `RELAY RULE: this crew descends from ${lineage} — every dispatch prompt must explicitly carry the artifact path (or its exact slice), and every close-report evidence statement must name the contract it worked against.`
      ] : [],
      governed ? `[forge:crew] Crew registered UNDER THE GOVERNING GOAL — born armed, never pends. Objective: ${objectiveText}` : `[forge:crew] Crew registered PENDING for this session (execution has NOT started). Objective: ${objectiveText}`,
      `Declared plan (${subtasks.length}):`,
      ...subtasks.map((s, i) => `  ${i + 1}. ${s.title}${s.agent ? ` → ${s.agent}` : ""}`),
      `Session roster origins — sole ownership (dispatch gated to this session's workspace pool / the global fallback); ${families.length} pool${families.length === 1 ? "" : "s"} materialized on this host:`,
      ...familyLines,
      ...disclosure ? [disclosure] : []
    ];
    if (governed) {
      lines.push("Goal-delegated orchestration: the governing goal contract already authorized this crew — run the wave discipline NOW (crew gates stay internal to the loop; crew_close and abandon are ask-free under this goal), and re-shard via crew_close {abandon: true, reason} + a fresh one-call crew_begin when the decomposition proves wrong.", "This crew is driven by the goal engine's own continuations (no separate crew briefs); standalone waves auto-advance on session idle until crew_close only after verified settlement of the previous wave (the engine stops after a stall — nudge or re-shard).", `Wave discipline: ${CREW_WAVE_RULE} Record per-subtask evidence verdicts, at most one retry, then crew_close with the full report covering every declared subtask under existing approval rules.`, CREW_NATIVE_FALLBACK_RULE);
    } else {
      lines.push(...crewPendingChoiceLines());
    }
    return {
      title: `crew registered: ${objectiveText.slice(0, 60)}`,
      output: lines.join(`
`)
    };
  }
});
var crewCloseTool = tool({
  description: "Close this session's crew. Two paths: (a) final report — the gate cross-checks the report against the declared subtask plan (every declared subtask needs a verdict and an evidence statement; an undeclared subtask refuses the close; FAIL requires both failure reports); (b) abandon {abandon: true, reason} — the re-shard exit: no verdict requirements, ends the crew with an abandonment record, frees the session for a fresh crew_begin. Both paths are ask-gated UNLESS a live active goal governs the session (then ask-free — the goal's own gates are the user boundary).",
  args: {
    report: tool.schema.array(tool.schema.object({
      title: tool.schema.string().describe("Subtask title — must match a title declared at crew_begin"),
      verdict: tool.schema.string().describe("PASS or FAIL"),
      evidence: tool.schema.string().describe("Acceptance evidence: what the result contained that satisfies the acceptance statement"),
      attempts: tool.schema.array(tool.schema.string()).optional().describe("Both attempts when retried, including both failure reports for FAIL"),
      rounds: tool.schema.array(tool.schema.string()).optional().describe("Optional native dispatch call IDs when the dispatch description does not identify this declared title")
    })).optional().describe("The full crew report — one entry per declared subtask (not needed when abandoning)"),
    abandon: tool.schema.boolean().optional().describe("true = abandon the crew (re-shard / standby-cancel): ends it with an abandonment record, no verdicts required"),
    reason: tool.schema.string().optional().describe("Why the crew is abandoned (recorded in the crew record)")
  },
  execute: async (args, context) => {
    noteToolAgent(context);
    const crew = crews.get(context.sessionID);
    if (!crew)
      throw new Error("[forge:crew] No active crew in this session (crew state is in-memory and dies on host restart). Start one with /crew <objective>.");
    if (args.abandon === true) {
      const reason = String(args.reason ?? "").trim() || "(no reason given)";
      if (!governingGoalFor(context.sessionID))
        await gate(context.ask, "crew_close", `Abandon crew: ${crew.objective}`);
      crews.delete(context.sessionID);
      appendCrewRecord(crew.recordPath, "abandoned", [`mode at abandon: ${crew.mode}`, `reason: ${reason}`, "The session is free for a fresh crew_begin (re-shard or new objective)."]);
      return {
        title: `crew abandoned: ${crew.objective.slice(0, 60)}`,
        output: [
          `[forge:crew] Crew ABANDONED: ${crew.objective}`,
          `mode at abandon: ${crew.mode}`,
          `reason: ${reason}`,
          "The session is free for a fresh crew_begin — register the corrected plan next (it starts PENDING again unless a governing goal arms it in the same call)."
        ].join(`
`)
      };
    }
    const report = args.report ?? [];
    const check2 = validateCrewReport(report, crew.subtasks);
    if (check2.ok) {
      const read = context.crewCloseEvidence;
      const evidence = read ? await read() : { rounds: crew.rounds ?? [], readable: false, inFlight: [], settled: [], context: null };
      check2.gaps.push(...crossCheckCrewEvidence(report, crew.subtasks, evidence));
      check2.ok = check2.gaps.length === 0;
    }
    if (!check2.ok) {
      throw new Error(`[forge:crew] crew_close refused — the report does not match the declared plan:
${check2.gaps.map((g) => `- ${g}`).join(`
`)}
The crew stays active; complete or correct the report and call crew_close again.`);
    }
    if (!governingGoalFor(context.sessionID))
      await gate(context.ask, "crew_close", `Close crew: ${crew.objective}`);
    crews.delete(context.sessionID);
    const fails = report.filter((r) => String(r.verdict).toUpperCase() === "FAIL").length;
    appendCrewRecord(crew.recordPath, "closed", [
      `subtasks: ${report.length} (PASS ${report.length - fails}, FAIL ${fails})`,
      ...report.map((r) => `- ${r.title}: ${String(r.verdict).toUpperCase()} — ${String(r.evidence).slice(0, 200)}`)
    ]);
    return {
      title: `crew closed: ${crew.objective.slice(0, 60)}`,
      output: [
        `[forge:crew] Crew closed: ${crew.objective}`,
        `subtasks: ${report.length} (PASS ${report.length - fails}, FAIL ${fails})`,
        ...report.map((r) => `- ${r.title}: ${String(r.verdict).toUpperCase()} — ${String(r.evidence).slice(0, 200)}`),
        crew.recordPath ? `Crew record (history): ${crew.recordPath}` : "This output is the crew's record (crew state is in-memory; nothing persists)."
      ].join(`
`)
    };
  }
});
var forgeSyncTool = tool({
  description: "Compile the forge.json recipe(s) this host can see into native agent files (.opencode/agent/forge-<ns>-<id>.md): mode:subagent stamped, pinned model with variant where the depth word maps, the shape's tools face, and the dispatch mandates baked into the prompt. Writes are atomic; entries that left the recipe are garbage-collected; the output discloses every created/updated/GC'd file. The host hot-applies without a restart. Call it after ANY recipe edit (the crew gate refuses registration against stale artifacts), or when a dispatch reports a missing forge worker on a native-mode host.",
  args: {},
  execute: async (_args, context) => {
    noteToolAgent(context);
    const { lines, errorCount } = runRosterSync();
    return {
      title: errorCount > 0 ? "forge sync: completed with errors" : "forge sync: roster compiled",
      output: lines.join(`
`)
    };
  }
});
function forgeTools() {
  const tools = {
    plan_write: planWriteTool,
    plan_tick: planTickTool,
    plan_approve: planApproveTool,
    plan_close: planCloseTool,
    plan_reopen: planReopenTool,
    plan_discard: planDiscardTool,
    goal_write: goalWriteTool,
    goal_check: goalCheckTool,
    goal_complete: goalCompleteTool,
    goal_pause: goalPauseTool,
    goal_resume: goalResumeTool,
    goal_discard: goalDiscardTool
  };
  tools.crew_begin = crewBeginTool;
  tools.crew_close = crewCloseTool;
  tools.forge_sync = forgeSyncTool;
  for (const [name, def] of Object.entries(tools)) {
    if (!FORGE_STATE_TOOL_SET.has(name))
      continue;
    tools[name] = {
      ...def,
      async execute(args, context) {
        const speaker = v2AgentNameOf(context) ?? sessionAgents.get(context.sessionID);
        assertHarnessAgent(name, speaker);
        return def.execute(args, context);
      }
    };
  }
  return tools;
}
var hostWorktree = "";
var v2InitializedDirs = new Set;
function banSeedAllowed() {
  return v2InitializedDirs.size <= 1;
}
function stateForBan(sessionID) {
  if (!sessionID)
    return null;
  const existing = sessions.get(sessionID);
  if (existing)
    return existing;
  if (!hostWorktree || !banSeedAllowed())
    return null;
  return ensureSession(sessionID, hostWorktree);
}
async function stateForCheck(sessionID, anchorClient) {
  if (!sessionID)
    return null;
  const known = stateForBan(sessionID);
  if (known)
    return known;
  if (banSeedAllowed())
    return null;
  const directory = await hostSessionDirectory(anchorClient ?? null, sessionID);
  return directory ? ensureSession(sessionID, directory) : null;
}
function banBaseDirectory(state) {
  return state?.worktree ?? (banSeedAllowed() ? hostWorktree : "");
}
var IDLE_DEBOUNCE_MS = Number(process.env.FORGE_GOAL_DEBOUNCE_MS ?? 2000);
var idleTimers = new Map;
var continuationInFlight = new Map;
var disposedGoalClients = new WeakSet;
function disposeGoalClient(client) {
  disposedGoalClients.add(client);
  for (const [id, pending] of idleTimers) {
    if (pending.client !== client)
      continue;
    clearTimeout(pending.timer);
    idleTimers.delete(id);
  }
  for (const [id, flight] of continuationInFlight) {
    if (flight.client !== client)
      continue;
    continuationInFlight.delete(id);
    const pending = pendingContinuationTurn.get(id);
    if (pending?.client === client && pending.turn === undefined) {
      pendingContinuationTurn.delete(id);
      turnActivity.delete(id);
    }
  }
  for (const [id, pending] of goalDeadlineTimers) {
    if (pending.client === client)
      goalStopDeadline(id);
  }
  for (const [id, pending] of goalNativeRecheck) {
    if (pending.client === client) {
      goalStopNativeRecheck(id);
      goalNativeWatch.delete(id);
    }
  }
  for (const [id, pending] of crewNativeRecheck) {
    if (pending.client === client)
      crewStopNativeRecheck(id);
  }
}
var goalNativeWatch = new Map;
var goalAcceptedCalls = new Map;
var goalBackgroundHeld = new Set;
var goalDeadlineTimers = new Map;
function goalStopDeadline(sessionID) {
  const pending = goalDeadlineTimers.get(sessionID);
  if (pending)
    clearTimeout(pending.timer);
  goalDeadlineTimers.delete(sessionID);
}
function goalArmDeadline(sessionID, client, goal) {
  goalStopDeadline(sessionID);
  const deadline = Date.parse(goal.doc.armedAt || goal.doc.created) + goal.doc.maxMinutes * 60000;
  const timer = setTimeout(() => {
    if (goalDeadlineTimers.get(sessionID)?.timer !== timer)
      return;
    goalDeadlineTimers.delete(sessionID);
    if (disposedGoalClients.has(client))
      return;
    const state = sessions.get(sessionID);
    const fresh = state && resolveLiveGoal(state);
    if (!state || !fresh || fresh.path !== goal.path || fresh.doc.status !== "active" || fresh.doc.session !== sessionID || fresh.doc.revision !== goal.doc.revision || fresh.doc.armedAt !== goal.doc.armedAt)
      return;
    if (budgetState(fresh.doc) === "budget-time")
      autoPauseGoal(client, state, fresh, "budget-time", false);
    else if (Date.now() <= deadline)
      goalArmDeadline(sessionID, client, fresh);
  }, Math.max(1, deadline - Date.now() + 1));
  timer.unref?.();
  goalDeadlineTimers.set(sessionID, { timer, client });
}
var goalNativeRecheck = new Map;
function goalStopNativeRecheck(sessionID) {
  const pending = goalNativeRecheck.get(sessionID);
  if (pending)
    clearTimeout(pending.timer);
  goalNativeRecheck.delete(sessionID);
}
function goalNativeViewHeld(sessionID, view) {
  if (!view.readable)
    return true;
  const watched = goalNativeWatch.get(sessionID) ?? new Set;
  for (const child of view.inFlight)
    watched.add(child);
  for (const row of view.settled) {
    if (row.outcome)
      watched.delete(row.childID);
    else
      watched.add(row.childID);
  }
  if (watched.size)
    goalNativeWatch.set(sessionID, watched);
  else
    goalNativeWatch.delete(sessionID);
  return watched.size > 0 || view.settled.some((row) => !row.outcome);
}
function goalArmNativeRecheck(sessionID, client, goal, deadlineOnly = false) {
  if (goalNativeRecheck.has(sessionID) || disposedGoalClients.has(client))
    return;
  const deadline = Date.parse(goal.doc.armedAt || goal.doc.created) + goal.doc.maxMinutes * 60000;
  const remaining = Math.max(1, deadline - Date.now() + 1);
  const ceiling = crewNativeCeiling.get(sessionID)?.disclosed;
  const interval = CREW_NATIVE_CHILD_RECHECK_MS > 0 ? CREW_NATIVE_CHILD_RECHECK_MS : remaining;
  const delay = ceiling || deadlineOnly ? remaining : Math.min(interval, remaining);
  const timer = setTimeout(() => {
    if (goalNativeRecheck.get(sessionID)?.timer !== timer)
      return;
    goalNativeRecheck.delete(sessionID);
    const state = sessions.get(sessionID);
    const fresh = state && resolveLiveGoal(state);
    if (!fresh || fresh.path !== goal.path || fresh.doc.status !== "active" || fresh.doc.session !== sessionID || fresh.doc.revision !== goal.doc.revision || fresh.doc.armedAt !== goal.doc.armedAt)
      return;
    if (!idleTimers.has(sessionID))
      continueIfEligible(client, sessionID, deadlineOnly);
  }, delay);
  timer.unref?.();
  goalNativeRecheck.set(sessionID, { timer, client, deadlineOnly });
}
var transportFails = new Map;
var noProgressStreak = new Map;
var turnActivity = new Map;
var previousGoalEvidence = new Map;
var pendingContinuationTurn = new Map;
function matchingGoalTurn(text, pending) {
  const fresh = parseGoalLoose(text);
  const admitted = pending.goal.doc;
  return fresh && fresh.created === admitted.created && fresh.revision === admitted.revision && fresh.session === admitted.session && fresh.armedAt === admitted.armedAt ? fresh : null;
}
function ledgerGoalTurn(pending) {
  const act = pending.activity;
  const classification = classifyGoalActivity(act, pending.previous);
  if (pending.turn !== undefined) {
    try {
      const text = readFileSync5(pending.goal.path, "utf8");
      if (matchingGoalTurn(text, pending)) {
        atomicWrite(pending.goal.path, appendLedger(text, {
          turn: pending.turn,
          revision: pending.goal.doc.revision,
          at: nowIso(),
          activity: classification.activity,
          writes: act.writes,
          checks: act.checks
        }, nowIso()));
      }
    } catch (err) {
      goalProbe(`ledger append failed session=${pending.goal.doc.session} err=${String(err)}`);
    }
  }
  return classification;
}
function goalProbe(line) {
  if (process.env.FORGE_GOAL_PROBE) {
    try {
      appendFileSync(join5(probeTmp(), "forge-goal-probe.log"), `${new Date().toISOString()} ${line}
`);
    } catch {}
  }
}
function engineForgetSession(sessionID) {
  goalStopDeadline(sessionID);
  goalStopNativeRecheck(sessionID);
  goalNativeWatch.delete(sessionID);
  goalBackgroundHeld.delete(sessionID);
  crewNativeCeiling.delete(sessionID);
  const t = idleTimers.get(sessionID);
  if (t)
    clearTimeout(t.timer);
  idleTimers.delete(sessionID);
  continuationInFlight.delete(sessionID);
  transportFails.delete(sessionID);
  noProgressStreak.delete(sessionID);
  previousGoalEvidence.delete(sessionID);
  const pending = pendingContinuationTurn.get(sessionID);
  if (pending?.turn !== undefined)
    ledgerGoalTurn(pending);
  turnActivity.delete(sessionID);
  pendingContinuationTurn.delete(sessionID);
}
var CREW_NO_PROGRESS_LIMIT = 3;
var crewPendingTurn = new Set;
var crewTurnActivity = new Map;
var crewNoProgress = new Map;
var crewStalled = new Set;
function crewEngineForgetSession(sessionID) {
  crewPendingTurn.delete(sessionID);
  crewTurnActivity.delete(sessionID);
  crewNoProgress.delete(sessionID);
  crewStalled.delete(sessionID);
  crewNativeChildren.forgetParent(sessionID);
  crewNativeCeiling.delete(sessionID);
  crewChildDigest.delete(sessionID);
  crewNativeWatch.delete(sessionID);
  crewStopNativeRecheck(sessionID);
}
var CREW_NATIVE_CHILD_CEILING_MS = Number(process.env.FORGE_CREW_NATIVE_CHILD_CEILING_MS ?? 900000);
var CREW_CHILD_RESUME_DEBOUNCE_MS = Number(process.env.FORGE_CREW_CHILD_RESUME_DEBOUNCE_MS ?? 500);
var crewNativeChildren = createNativeChildTracker();
var crewNativeCeiling = new Map;
var crewChildDigest = new Map;
var crewGateNow = () => Date.now();
function setCrewNativeChildClockForTests(now) {
  crewGateNow = typeof now === "function" ? now : () => Date.now();
}
var crewNativeWatch = new Map;
function crewWatchChild(sessionID, childID) {
  if (!sessionID || !childID)
    return;
  let watched = crewNativeWatch.get(sessionID);
  if (!watched) {
    watched = new Set;
    crewNativeWatch.set(sessionID, watched);
  }
  watched.add(childID);
}
function crewNativeWatchParentOf(childID) {
  for (const [sessionID, watched] of crewNativeWatch)
    if (watched.has(childID))
      return sessionID;
  return null;
}
function crewReportNativeChildTerminal(sessionID, childID, outcome, client) {
  const watched = crewNativeWatch.get(sessionID);
  if (!watched || !watched.delete(childID))
    return;
  const lines = crewChildDigest.get(sessionID) ?? [];
  lines.push(nativeChildDigestLine(childID, outcome));
  crewChildDigest.set(sessionID, lines);
  goalProbe(`crew native child settled child=${childID} outcome=${outcome ?? "unknown"} parent=${sessionID} stillWaiting=${watched.size}`);
  if (watched.size > 0)
    return;
  crewStopNativeRecheck(sessionID);
  if (client) {
    scheduleIdleContinuation(client, sessionID, CREW_CHILD_RESUME_DEBOUNCE_MS);
  }
}
function crewNativeViewHeld(sessionID, view) {
  return !view.readable || view.inFlight.length > 0 || view.settled.some((row) => !row.outcome && !crewNativeChildren.rows().get(row.childID)?.outcome) || (crewNativeWatch.get(sessionID)?.size ?? 0) > 0;
}
function crewDiscloseNativeHold(sessionID, objective) {
  const now = crewGateNow();
  const mark = crewNativeCeiling.get(sessionID);
  if (!mark)
    crewNativeCeiling.set(sessionID, { firstSuppressedAt: now, disclosed: false });
  else if (!mark.disclosed && now - mark.firstSuppressedAt >= CREW_NATIVE_CHILD_CEILING_MS) {
    crewNativeCeiling.set(sessionID, { firstSuppressedAt: mark.firstSuppressedAt, disclosed: true });
    console.warn(`[forge:crew-continue] native-child ceiling: crew "${objective.slice(0, 80)}" remains held; terminal evidence unavailable. No continuation authorized.`);
  }
}
function crewObserveNativeWalk(sessionID, view) {
  if (!view.readable)
    return;
  const busy = new Set(view.inFlight);
  for (const childID of view.inFlight)
    crewWatchChild(sessionID, childID);
  const watched = crewNativeWatch.get(sessionID);
  if (!watched || watched.size === 0)
    return;
  const outcomes = new Map(view.settled.map((row) => [row.childID, row.outcome]));
  for (const childID of [...watched]) {
    if (busy.has(childID))
      continue;
    const outcome = outcomes.get(childID) ?? crewNativeChildren.rows().get(childID)?.outcome;
    if (outcome)
      crewReportNativeChildTerminal(sessionID, childID, outcome, null);
  }
}
var CREW_NATIVE_CHILD_RECHECK_MS = Number(process.env.FORGE_CREW_NATIVE_CHILD_RECHECK_MS ?? 5000);
var crewNativeRecheck = new Map;
function crewArmNativeRecheck(sessionID, client) {
  if (client && disposedGoalClients.has(client) || crewNativeRecheck.has(sessionID))
    return;
  if (!Number.isFinite(CREW_NATIVE_CHILD_RECHECK_MS) || CREW_NATIVE_CHILD_RECHECK_MS <= 0)
    return;
  const timer = setTimeout(() => {
    if (crewNativeRecheck.get(sessionID)?.timer !== timer)
      return;
    crewNativeRecheck.delete(sessionID);
    crewNativeRecheckTick(sessionID, client);
  }, CREW_NATIVE_CHILD_RECHECK_MS);
  if (typeof timer.unref === "function")
    timer.unref?.();
  crewNativeRecheck.set(sessionID, { timer, client });
}
function crewStopNativeRecheck(sessionID) {
  const armed = crewNativeRecheck.get(sessionID);
  if (armed)
    clearTimeout(armed.timer);
  crewNativeRecheck.delete(sessionID);
}
async function crewNativeRecheckTick(sessionID, client) {
  try {
    const crew = crews.get(sessionID);
    if (!client || disposedGoalClients.has(client) || !crew || crew.mode !== "executing" || crewStalled.has(sessionID))
      return;
    if (continuationInFlight.has(sessionID) || idleTimers.has(sessionID))
      return;
    const view = await walkNativeChildren(nativeChildWalkerOf(client), sessionID);
    if (disposedGoalClients.has(client))
      return;
    crewObserveNativeWalk(sessionID, view);
    if (crewNativeViewHeld(sessionID, view)) {
      crewDiscloseNativeHold(sessionID, crew.objective);
      crewArmNativeRecheck(sessionID, client);
      return;
    }
    goalProbe(`crew native-child recheck clear session=${sessionID}`);
    scheduleIdleContinuation(client, sessionID, CREW_CHILD_RESUME_DEBOUNCE_MS);
  } catch {}
}
function nativeChildWalkerOf(client) {
  return client.nativeChildWalker ?? client;
}
function noteCrewNativeChildEvent(type, fields, client) {
  try {
    if (type === "session.created") {
      const info = fields.info ?? fields.session;
      const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId");
      const parentID = info !== null && typeof info === "object" && typeof info.parentID === "string" && info.parentID ? info.parentID : v2PickStr(fields, "parentID", "parentId");
      if (id && parentID)
        crewNativeChildren.mark(id, parentID);
      return;
    }
    if (type === "session.deleted") {
      const info = fields.info;
      const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId");
      if (!id)
        return;
      crewNativeChildren.drop(id);
      const watchedBy = crewNativeWatchParentOf(id);
      if (watchedBy)
        crewArmNativeRecheck(watchedBy, client);
      return;
    }
    const outcome = nativeChildEventOutcome(type);
    if (outcome) {
      const id = v2PickStr(fields, "sessionID", "sessionId");
      if (!id)
        return;
      const note = crewNativeChildren.terminalize(id, outcome);
      const parentID = note?.parentID ?? crewNativeWatchParentOf(id);
      if (parentID)
        crewReportNativeChildTerminal(parentID, id, outcome, client);
      return;
    }
    if (type === "session.status" || type === "session.idle") {
      const id = v2PickStr(fields, "sessionID", "sessionId");
      if (!id)
        return;
      const st = fields.status;
      const idle = type === "session.idle" || st !== null && typeof st === "object" && st.type === "idle";
      if (!idle)
        return;
      const parentID = crewNativeWatchParentOf(id);
      if (parentID)
        crewArmNativeRecheck(parentID, client);
    }
  } catch {}
}
function crewContinueBrief(crew, childDigest = []) {
  return [
    `[forge:crew-continue] The crew "${crew.objective}" is armed (waves) — continue the wave discipline.`,
    `Declared plan (every subtask needs a verdict at close):`,
    ...crew.subtasks.map((s, i) => `${i + 1}. ${s.title}`),
    ...childDigest.length > 0 ? [`Native child outcomes since the last brief (one line per child — an interrupted child is DEAD, never silently stranded):`, ...childDigest.map((l) => `- ${l}`)] : [],
    `Wave discipline: ${CREW_WAVE_RULE} Collect verified per-subtask evidence verdicts from the reports; terminal status alone is not PASS. Keep at most one retry per subtask, then crew_close with the full report and existing approvals. Stalled or wrong decomposition? crew_close {abandon: true, reason} to re-shard.`
  ].join(`
`);
}
async function continueCrewIfEligible(client, state, sessionID) {
  const crew = crews.get(sessionID);
  if (!crew || crew.mode !== "executing" || crew.goalGoverned) {
    goalProbe(`crew skip: no executing crew session=${sessionID}`);
    return;
  }
  if (crewStalled.has(sessionID)) {
    goalProbe(`crew skip: stalled session=${sessionID}`);
    return;
  }
  if (!sessionIsForgeFamily(sessionID)) {
    goalProbe(`crew skip: agent switched to non-forge before send session=${sessionID}`);
    return;
  }
  const walker = nativeChildWalkerOf(client);
  const view = await walkNativeChildren(walker, sessionID);
  if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew || crew.goalGoverned || governingGoalFor(sessionID))
    return;
  crewObserveNativeWalk(sessionID, view);
  if (crewNativeViewHeld(sessionID, view)) {
    crewDiscloseNativeHold(sessionID, crew.objective);
    crewArmNativeRecheck(sessionID, client);
    return;
  }
  crewNativeCeiling.delete(sessionID);
  if (crewPendingTurn.has(sessionID)) {
    crewPendingTurn.delete(sessionID);
    const act = crewTurnActivity.get(sessionID);
    if (act && (act.dispatches > 0 || act.writes > 0)) {
      crewNoProgress.delete(sessionID);
    } else {
      const n = (crewNoProgress.get(sessionID) ?? 0) + 1;
      crewNoProgress.set(sessionID, n);
      goalProbe(`crew no-progress session=${sessionID} streak=${n}`);
      if (n >= CREW_NO_PROGRESS_LIMIT) {
        crewStalled.add(sessionID);
        crewTurnActivity.delete(sessionID);
        console.warn(`[forge:crew-continue] stalled: crew "${crew.objective.slice(0, 80)}" produced ${n} activity-free continuation turns — the engine stops continuing it (the crew stays registered; nudge the session, crew_close the report, or crew_close {abandon: true, reason} to re-shard).`);
        return;
      }
    }
  }
  if (typeof client.session.status === "function") {
    try {
      const st = await client.session.status({ path: { id: sessionID } });
      const t = st?.[sessionID]?.type;
      if (t && t !== "idle") {
        goalProbe(`crew skip: session busy again session=${sessionID} status=${t}`);
        return;
      }
    } catch (err) {
      goalProbe(`crew skip: status check failed session=${sessionID} err=${String(err)}`);
      return;
    }
  } else {
    const busy = await nativeSessionBusy(walker, sessionID);
    if (busy === true) {
      goalProbe(`crew skip: session busy again session=${sessionID} status=active`);
      return;
    }
  }
  if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew || crew.goalGoverned || governingGoalFor(sessionID) || !sessionIsForgeFamily(sessionID))
    return;
  try {
    const childDigest = crewChildDigest.get(sessionID) ?? [];
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: crewContinueBrief(crew, childDigest) }] }
    });
    if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew)
      return;
    if (childDigest.length > 0)
      crewChildDigest.delete(sessionID);
    crewStopNativeRecheck(sessionID);
    transportFails.delete(sessionID);
    crewPendingTurn.add(sessionID);
    crewTurnActivity.set(sessionID, { dispatches: 0, writes: 0 });
    goalProbe(`crew continued session=${sessionID} objective="${crew.objective.slice(0, 60)}"`);
  } catch (err) {
    if (disposedGoalClients.has(client) || crews.get(sessionID) !== crew)
      return;
    const n = (transportFails.get(sessionID) ?? 0) + 1;
    transportFails.set(sessionID, n);
    goalProbe(`crew transport failure session=${sessionID} count=${n} err=${String(err)}`);
    if (n >= TRANSPORT_FAILURE_LIMIT) {
      crewStalled.add(sessionID);
      crewPendingTurn.delete(sessionID);
      crewTurnActivity.delete(sessionID);
      console.warn(`[forge:crew-continue] stopped: ${n} consecutive delivery failures for crew "${crew.objective.slice(0, 80)}" — the engine stops continuing it (the crew stays registered; nudge the session or crew_close when back).`);
    }
  }
}
function goalBriefText(state, goal) {
  const d = goal.doc;
  const structureText = [...d.criteria, d.constraints.trim()].filter(Boolean).join(`
`);
  const structured = /\bforge-[a-z0-9-]+\b/.test(structureText) || /^\s*\d+[.).]/m.test(structureText);
  const crewLayerBase = `Crew layer: you own it under this goal — when parallel decomposition serves a criterion, register crews with crew_begin {objective, subtasks, execution: "waves"} in ONE call (born armed; no pause mid-loop), follow the native subagent wave discipline below, and re-shard a wrong decomposition via crew_close {abandon: true, reason} plus a fresh registration. Preserve existing user approvals, host permissions and goal stop conditions. Your goal turns drive the crew — no separate crew idle briefs fire under this goal.`;
  const crewLayerLine = structured ? `${crewLayerBase} The contract carries a subtask structure — PREFER re-registering it as a born-armed crew (one call, execution: "waves") over self-executing the whole plan in this session; drive the crew through your goal turns and keep per-subtask evidence for the close report.` : crewLayerBase;
  return [
    `[forge:goal-continue] Continue the active goal (revision ${d.revision}): ${d.goal}`,
    `Success criteria:
${d.criteria.map((c, i) => `${i + 1}. ${c}`).join(`
`)}`,
    `Verification items (the plugin runs these itself; never fake their output):
${d.checks.map((c, i) => `${i + 1}. ${c.kind === "shell" ? `shell \`${c.cmd}\`` : `contains \`${c.file}\` :: \`${c.text}\``}`).join(`
`)}`,
    d.constraints.trim() ? `Constraints: ${d.constraints.trim()}` : "",
    `Per-turn discipline: meaningful read-only reconnaissance and review, real changes, commits, and checks or failure diagnosis with new evidence are productive work, including outside git. No write, shell command, or git diff is required every turn. Repeating a check with the same input and complete result without new evidence or other activity is not progress; unknown or truncated evidence does not establish equality. Do not repeat checks merely to fill a turn. For genuine host waiting (outstanding child work, background commands, permissions or user responses), end your turn rather than polling or sleeping. Waiting is not work; the intended two-turn no-progress threshold applies only to clearly empty work turns.`,
    `Budget: ${d.turnsUsed}/${d.maxTurns} turns used. The wall-clock minute limit continues during waiting; stop on either budget limit or when goal authorization ends, and wait for the user's explicit decision before resuming. Do not start new autonomous work after a pause or loss of authorization, including crew fallback or session reuse; already accepted host work may finish. A goal-governed crew must not become standalone automatically. Call goal_check when criteria hold, then goal_complete (it re-runs every check itself and asks the user). If globally blocked, call goal_pause with the concrete blocker; if independent work remains, continue that work — do not spin.`,
    crewLayerLine,
    `For a crew under this goal: ${CREW_WAVE_RULE} Treat verified waiting as distinct from work or no-progress; do not assume the host can observe every wait. Collect verified evidence for each declared subtask; a completion notification is not by itself PASS.`,
    `Goal file: ${relFrom(state.worktree, goal.path)}`
  ].filter((s) => s.length > 0).join(`
`);
}
function wrapupBriefText(goal, reason, repeatedEvidence = false) {
  return [
    `[forge:goal-wrapup] The goal loop is stopping (stop_reason: ${reason}); the goal is now PAUSED.`,
    `Goal (revision ${goal.doc.revision}): ${goal.doc.goal}`,
    ...repeatedEvidence ? ["Repeated identical check input and result added no observable evidence; see the Turn Ledger."] : [],
    "Produce a concise handoff summary and nothing else: what is done, what remains, the single next concrete step. Do not continue working the goal in this turn."
  ].join(`
`);
}
async function autoPauseGoal(client, state, goal, reason, wrapup, repeatedEvidence = false) {
  goalProbe(`auto-pause session=${state.sessionID} reason=${reason} wrapup=${wrapup}`);
  atomicWrite(goal.path, transitionGoal(readFileSync5(goal.path, "utf8"), "paused", nowIso(), { stopReason: reason }));
  engineForgetSession(state.sessionID);
  if (wrapup && goal.doc.session) {
    try {
      await client.session.prompt({
        path: { id: goal.doc.session },
        body: { parts: [{ type: "text", text: wrapupBriefText(goal, reason, repeatedEvidence) }] }
      });
    } catch (err) {
      goalProbe(`wrapup delivery failed session=${state.sessionID} err=${String(err)}`);
    }
  }
}
async function continueIfEligible(client, sessionID, backgroundWaiting = false) {
  if (disposedGoalClients.has(client))
    return;
  if (continuationInFlight.has(sessionID))
    return;
  const flight = { client };
  continuationInFlight.set(sessionID, flight);
  const stillCurrent = () => !disposedGoalClients.has(client) && continuationInFlight.get(sessionID) === flight;
  try {
    let state = sessions.get(sessionID);
    if (!state) {
      try {
        const info = await client.session.get({ path: { id: sessionID } });
        if (!stillCurrent())
          return;
        const wt = effectiveWorktree(info?.worktree, info?.directory ?? info?.location?.directory);
        if (!wt) {
          goalProbe(`skip: no worktree for lazy seed session=${sessionID}`);
          return;
        }
        state = ensureSession(sessionID, wt);
        goalProbe(`lazy-seeded session=${sessionID} worktree=${wt}`);
      } catch (err) {
        goalProbe(`lazy-seed failed session=${sessionID} err=${String(err)}`);
        return;
      }
    }
    if (!stillCurrent())
      return;
    const ownedGoal = resolveLiveGoal(state);
    const governedCrew = crews.get(sessionID);
    backgroundWaiting ||= goalBackgroundHeld.has(sessionID);
    if (ownedGoal?.doc.status === "active" && ownedGoal.doc.session === sessionID)
      goalArmDeadline(sessionID, client, ownedGoal);
    if (backgroundWaiting) {
      goalStopNativeRecheck(sessionID);
      if (ownedGoal?.doc.status === "active" && ownedGoal.doc.session === sessionID)
        goalArmNativeRecheck(sessionID, client, ownedGoal, true);
    }
    if (ownedGoal?.doc.status === "active" && ownedGoal.doc.session === sessionID && !backgroundWaiting) {
      const walker = nativeChildWalkerOf(client);
      const view = await walkNativeChildren(walker, sessionID);
      if (!stillCurrent())
        return;
      const ownerBusy = await nativeSessionBusy(walker, sessionID);
      if (!stillCurrent())
        return;
      const current = resolveLiveGoal(state);
      if (!current || current.path !== ownedGoal.path || current.doc.status !== "active" || current.doc.session !== sessionID || current.doc.revision !== ownedGoal.doc.revision || current.doc.armedAt !== ownedGoal.doc.armedAt)
        return;
      let roundHeld = false;
      const rounds = goalAcceptedCalls.get(sessionID);
      if (rounds?.size) {
        let settled = new Set;
        try {
          settled = settledGoalRounds(rounds, await client.session.context?.({ sessionID }));
        } catch {}
        if (!stillCurrent())
          return;
        const latest = resolveLiveGoal(state);
        if (!latest || latest.path !== ownedGoal.path || latest.doc.status !== "active" || latest.doc.session !== sessionID || latest.doc.revision !== ownedGoal.doc.revision || latest.doc.armedAt !== ownedGoal.doc.armedAt)
          return;
        roundHeld = [...rounds.keys()].some((id) => !settled.has(id));
      }
      backgroundWaiting = goalNativeViewHeld(sessionID, view) || ownerBusy !== false || roundHeld || goalBackgroundHeld.has(sessionID);
      if (governedCrew?.goalGoverned)
        crewObserveNativeWalk(sessionID, view);
      if (backgroundWaiting) {
        crewDiscloseNativeHold(sessionID, governedCrew?.objective ?? ownedGoal.doc.goal);
        goalArmNativeRecheck(sessionID, client, ownedGoal, goalBackgroundHeld.has(sessionID));
      } else {
        goalStopNativeRecheck(sessionID);
      }
    }
    const pending = pendingContinuationTurn.get(sessionID);
    let accountedContinuationTurn = false;
    let turnHadActivity = false;
    let repeatedEvidence = false;
    let uncertainActivity = false;
    const waitingGoal = backgroundWaiting ? resolveLiveGoal(state) : null;
    const deferSettlement = waitingGoal?.doc.status === "active" && waitingGoal.doc.session === sessionID && pending?.goal.path === waitingGoal.path && pending.goal.doc.revision === waitingGoal.doc.revision && pending.goal.doc.armedAt === waitingGoal.doc.armedAt;
    if (pending && deferSettlement)
      pending.waited = true;
    if (pending?.turn !== undefined && !deferSettlement) {
      pendingContinuationTurn.delete(sessionID);
      turnActivity.delete(sessionID);
      const classification = ledgerGoalTurn(pending);
      const currentGoal = resolveLiveGoal(state);
      accountedContinuationTurn = currentGoal?.path === pending.goal.path && currentGoal.doc.revision === pending.goal.doc.revision && currentGoal.doc.armedAt === pending.goal.doc.armedAt && currentGoal.doc.session === sessionID;
      turnHadActivity = classification.activity;
      repeatedEvidence = classification.repeated;
      uncertainActivity = classification.uncertain === true;
      if (accountedContinuationTurn && classification.evidence)
        previousGoalEvidence.set(sessionID, classification.evidence);
      else
        previousGoalEvidence.delete(sessionID);
    }
    const goal = resolveLiveGoal(state);
    if (goal?.doc.status === "paused" && goal.doc.session === sessionID)
      return;
    if (!goal || goal.doc.status !== "active" || !goal.doc.session || goal.doc.session !== sessionID) {
      goalProbe(`no live active goal owned by session=${sessionID} — crew branch`);
      await continueCrewIfEligible(client, state, sessionID);
      return;
    }
    if (!sessionIsForgeFamily(sessionID)) {
      goalProbe(`skip: agent switched to non-forge before send session=${sessionID}`);
      return;
    }
    if (backgroundWaiting) {
      if (resolveActivePlan(state)?.doc.status === "draft") {
        await autoPauseGoal(client, state, goal, "draft-conflict", false);
        return;
      }
      const bs2 = budgetState(goal.doc);
      if (bs2 !== "ok")
        await autoPauseGoal(client, state, goal, bs2, false);
      return;
    }
    if (accountedContinuationTurn) {
      if (turnHadActivity) {
        noProgressStreak.delete(sessionID);
      } else if (!pending?.waited && !uncertainActivity) {
        const n = (noProgressStreak.get(sessionID) ?? 0) + 1;
        noProgressStreak.set(sessionID, n);
        goalProbe(`no-progress session=${sessionID} streak=${n}`);
        if (n >= NO_PROGRESS_LIMIT) {
          await autoPauseGoal(client, state, goal, "no-progress", true, repeatedEvidence);
          return;
        }
      }
    }
    const plan = resolveActivePlan(state);
    if (plan && plan.doc.status === "draft") {
      await autoPauseGoal(client, state, goal, "draft-conflict", false);
      return;
    }
    const bs = budgetState(goal.doc);
    if (bs !== "ok") {
      await autoPauseGoal(client, state, goal, bs, true);
      return;
    }
    if (typeof client.session.status === "function") {
      try {
        const st = await client.session.status({ path: { id: sessionID } });
        const t = st?.[sessionID]?.type;
        if (t && t !== "idle") {
          goalProbe(`skip: session busy again session=${sessionID} status=${t}`);
          return;
        }
      } catch (err) {
        goalProbe(`skip: status check failed session=${sessionID} err=${String(err)}`);
        return;
      }
    }
    const stillAuthorized = () => {
      if (!stillCurrent())
        return false;
      const fresh2 = parseGoalLoose(readFileSync5(goal.path, "utf8"));
      return fresh2?.status === "active" && fresh2.session === sessionID && fresh2.revision === goal.doc.revision && fresh2.armedAt === goal.doc.armedAt;
    };
    if (!stillAuthorized())
      return;
    const pendingTurn = {
      client,
      goal,
      activity: { writes: 0, checks: 0, scope: JSON.stringify([state.worktree, goal.path, goal.doc.revision, goal.doc.armedAt]) },
      previous: previousGoalEvidence.get(sessionID)
    };
    try {
      const briefText = goalBriefText(state, goal);
      pendingContinuationTurn.set(sessionID, pendingTurn);
      turnActivity.set(sessionID, pendingTurn.activity);
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: briefText }] }
      });
    } catch (err) {
      if (!stillAuthorized()) {
        if (pendingContinuationTurn.get(sessionID) === pendingTurn) {
          pendingContinuationTurn.delete(sessionID);
          turnActivity.delete(sessionID);
        }
        return;
      }
      pendingContinuationTurn.delete(sessionID);
      turnActivity.delete(sessionID);
      const n = (transportFails.get(sessionID) ?? 0) + 1;
      transportFails.set(sessionID, n);
      goalProbe(`transport failure session=${sessionID} count=${n} err=${String(err)}`);
      if (n >= TRANSPORT_FAILURE_LIMIT) {
        await autoPauseGoal(client, state, goal, "transport-failures", false);
      }
      return;
    }
    const text = readFileSync5(goal.path, "utf8");
    const fresh = matchingGoalTurn(text, pendingTurn);
    if (disposedGoalClients.has(client) || !fresh || !stillCurrent() && fresh.status === "active") {
      if (pendingContinuationTurn.get(sessionID) === pendingTurn) {
        pendingContinuationTurn.delete(sessionID);
        turnActivity.delete(sessionID);
      }
      return;
    }
    atomicWrite(goal.path, incTurns(text, nowIso()));
    pendingTurn.turn = fresh.turnsUsed + 1;
    if (!stillCurrent() || fresh.status !== "active") {
      ledgerGoalTurn(pendingTurn);
      if (pendingContinuationTurn.get(sessionID) === pendingTurn) {
        pendingContinuationTurn.delete(sessionID);
        turnActivity.delete(sessionID);
      }
      return;
    }
    transportFails.delete(sessionID);
    goalProbe(`continued session=${sessionID} turn=${pendingTurn.turn}/${fresh.maxTurns}`);
  } catch (err) {
    goalProbe(`continuation aborted session=${sessionID} err=${String(err)}`);
  } finally {
    if (stillCurrent())
      continuationInFlight.delete(sessionID);
  }
}
function scheduleIdleContinuation(client, sessionID, debounceMs = IDLE_DEBOUNCE_MS, backgroundWaiting = false) {
  if (disposedGoalClients.has(client))
    return;
  if (!sessionIsForgeFamily(sessionID)) {
    goalProbe(`skip: non-forge agent at schedule session=${sessionID}`);
    return;
  }
  const state = sessions.get(sessionID);
  if (state) {
    const goal = resolveLiveGoal(state);
    if (goal?.doc.status === "paused" && goal.doc.session === sessionID)
      return;
  }
  const existing = idleTimers.get(sessionID);
  if (existing)
    clearTimeout(existing.timer);
  const pending = { client, timer: setTimeout(() => {
    if (idleTimers.get(sessionID) !== pending)
      return;
    idleTimers.delete(sessionID);
    continueIfEligible(client, sessionID, backgroundWaiting);
  }, Math.max(0, debounceMs)) };
  idleTimers.set(sessionID, pending);
}
function harvestSessionEnd(sessionID) {
  sessionDepths.delete(sessionID);
  sessionAgents.delete(sessionID);
  poolGateUnknownNotes.delete(sessionID);
  anchorPrefNotes.delete(sessionID);
  poolGateLedgerNotes.delete(sessionID);
  sessionAnchorLedgerMemo.delete(sessionID);
  sessionMovedAnchors.delete(sessionID);
  anchorMovedNotes.delete(sessionID);
  crews.delete(sessionID);
  crewEngineForgetSession(sessionID);
  goalAcceptedCalls.delete(sessionID);
  engineForgetSession(sessionID);
}
var v2HostAnchors = new Map;
function v2AnchorCandidates(ctx, includeCwd = true) {
  const out = [];
  try {
    for (const reader of [ctx.location?.worktree, ctx.location?.directory]) {
      const v = typeof reader === "function" ? reader() : reader;
      if (typeof v === "string" && v)
        out.push(v);
    }
  } catch {}
  if (includeCwd)
    out.push(process.cwd());
  return out;
}
function v2ToolInputSchema(args) {
  try {
    const z = tool.schema;
    if (typeof z.object === "function" && typeof z.toJSONSchema === "function") {
      const schema = z.toJSONSchema(z.object(args ?? {}), { io: "input" });
      if (schema !== null && typeof schema === "object") {
        const out = { ...schema };
        delete out.$schema;
        return out;
      }
    }
  } catch {}
  return { type: "object", properties: {} };
}
function wrapV2ToolResult(res) {
  if (res !== null && typeof res === "object" && "output" in res) {
    const r = res;
    return typeof r.title === "string" ? { content: r.output, title: r.title } : { content: r.output };
  }
  return { content: res };
}
var HOST_DIRECTORY_WALK_MAX = 8;
async function hostSessionDirectory(anchorClient, sessionID) {
  const get = anchorClient?.session?.get;
  if (!sessionID || typeof get !== "function")
    return "";
  const seen = new Set;
  let id = sessionID;
  while (id && seen.size < HOST_DIRECTORY_WALK_MAX) {
    if (seen.has(id))
      return "";
    seen.add(id);
    let rec;
    try {
      rec = await get({ path: { id } });
    } catch {
      return "";
    }
    if (rec === null || typeof rec !== "object")
      return "";
    const r = rec;
    const str = (v) => typeof v === "string" ? v : "";
    const here = effectiveWorktree(str(r.worktree), str(r.directory) || str(r.location?.directory));
    if (here && !isRootish(here))
      return here;
    id = typeof r.parentID === "string" ? r.parentID : "";
  }
  return "";
}
async function v2ToolContext(raw, anchorClient = anchorClientShared, assertFn = null) {
  const c = raw ?? {};
  const pickStr = (...keys) => {
    for (const k of keys) {
      const v = c[k];
      if (typeof v === "string" && v)
        return v;
    }
    return;
  };
  const out = { ...c };
  if (out.sessionID === undefined)
    out.sessionID = pickStr("sessionId", "session_id");
  if (out.worktree === undefined)
    out.worktree = pickStr("worktree", "directory");
  if (out.worktree === undefined && typeof out.sessionID === "string")
    out.worktree = sessions.get(out.sessionID)?.worktree;
  if (out.worktree === undefined && typeof out.sessionID === "string" && out.sessionID)
    out.worktree = await hostSessionDirectory(anchorClient, out.sessionID) || undefined;
  let defaultDirectory = null;
  if (out.worktree === undefined) {
    out.worktree = hostWorktree;
    if (typeof out.sessionID === "string" && out.sessionID)
      defaultDirectory = hostWorktree || null;
  }
  if (typeof out.ask !== "function" && assertFn && typeof out.sessionID === "string" && out.sessionID) {
    const sid = out.sessionID;
    const agentId = typeof out.agent === "string" && out.agent ? out.agent : undefined;
    const askHost = assertFn;
    out.ask = (askInput) => askHost({
      sessionID: sid,
      ...agentId !== undefined ? { agent: agentId } : {},
      action: askInput.permission,
      resources: Array.isArray(askInput.patterns) ? askInput.patterns : ["*"],
      metadata: askInput.metadata
    });
  }
  if (typeof out.metadata !== "function")
    out.metadata = () => {};
  return { context: out, defaultDirectory };
}
var V2_DEFAULT_DIRECTORY_NOTE = "[forge] The host gave no workspace for this session (no directory in the session record), so this call ran in the plugin's default directory";
function nameDefaultDirectory(wrapped, defaultDirectory) {
  if (defaultDirectory === null || typeof wrapped.content !== "string")
    return wrapped;
  return { ...wrapped, content: `${wrapped.content}

${V2_DEFAULT_DIRECTORY_NOTE}: ${defaultDirectory}` };
}
var __sessionAnchorTestSurface = {
  hostSessionDirectory,
  resolveSessionAnchorForPools,
  workspacePoolOf: sessionPoolFileOf,
  resolvePools,
  resolveToolContext: (raw, anchorClient, assertFn) => v2ToolContext(raw, anchorClient ?? undefined, assertFn ?? null),
  worktreeOf: (sessionID) => sessions.get(sessionID)?.worktree ?? null,
  bindChildToDirectory,
  sessionAnchorLedgerPath,
  noteLedgerBinding: noteSessionAnchorLedgerBinding,
  setSessionAnchorLedgerFs: (factory) => {
    sessionAnchorLedgerFsFactory = factory;
    poolGateLedgerNotes.clear();
    sessionAnchorLedgerMemo.clear();
    sessionAnchorLedgerAppends = 0;
  },
  resetSessionBindings: () => {
    sessions.clear();
    anchorPrefNotes.clear();
    poolGateUnknownNotes.clear();
    poolGateLedgerNotes.clear();
    sessionAnchorLedgerMemo.clear();
    sessionAnchorLedgerAppends = 0;
  },
  sessionAnchorLedgerText: () => {
    try {
      return sessionAnchorLedgerFs().read();
    } catch {
      return null;
    }
  },
  initializedDirectories: () => [...v2InitializedDirs],
  resetInitializedDirectories: () => {
    v2InitializedDirs.clear();
  },
  stateForBan: (sessionID) => stateForBan(sessionID),
  stateForCheck: (sessionID, anchorClient) => stateForCheck(sessionID, anchorClient ?? null),
  boundaryBaseOf: (sessionID) => banBaseDirectory(stateForBan(sessionID))
};
function v2PickStr(src, ...keys) {
  if (src === null || typeof src !== "object")
    return;
  const o = src;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v)
      return v;
  }
  return;
}
function v2AgentNameOf(src) {
  if (src === null || typeof src !== "object")
    return;
  const a = src.agent;
  if (typeof a === "string" && a)
    return a;
  if (a !== null && typeof a === "object") {
    const n = a.name;
    if (typeof n === "string" && n)
      return n;
  }
  return;
}
var V2_PERMISSION_DOORS = new Set(GATE_PERMISSION_KEYS);
var __permissionDoorsTestSurface = {
  gateKeys: GATE_PERMISSION_KEYS,
  v2Doors: V2_PERMISSION_DOORS
};
function v2RegisterPermissionBelt(ctx) {
  if (typeof ctx.permission?.hook !== "function")
    return;
  try {
    Promise.resolve(ctx.permission.hook("evaluate", async (raw) => {
      try {
        const evalInput = raw !== null && typeof raw === "object" ? raw : null;
        if (!evalInput || typeof evalInput.effect !== "string")
          return;
        const meta = evalInput.metadata !== null && typeof evalInput.metadata === "object" ? evalInput.metadata : {};
        const name = evalInput.action === NATIVE_TOOL_VOCAB.dispatchTool ? evalInput.action : (typeof meta.tool === "string" ? meta.tool : undefined) ?? (typeof evalInput.action === "string" ? evalInput.action : undefined);
        if (process.env.FORGE_PERM_PROBE) {
          try {
            appendFileSync(join5(probeTmp(), "forge-perm-probe.log"), `${new Date().toISOString()} v2-evaluate name=${JSON.stringify(name)} effect=${evalInput.effect} raw=${JSON.stringify(raw).slice(0, 300)}
`);
          } catch {}
        }
        if (typeof name === "string" && V2_PERMISSION_DOORS.has(name)) {
          if (evalInput.effect !== "deny")
            evalInput.effect = "ask";
          return;
        }
        if (typeof name === "string" && isWriteTool(name)) {
          const sessionID = typeof evalInput.sessionID === "string" ? evalInput.sessionID : undefined;
          const state = stateForBan(sessionID);
          const active = state ? resolveActivePlan(state) : null;
          if (active && active.doc.status === "draft") {
            if (evalInput.action === NATIVE_TOOL_VOCAB.dispatchTool && state) {
              const resources = evalInput.resources;
              const target = Array.isArray(resources) && resources.length === 1 && typeof resources[0] === "string" ? resources[0] : undefined;
              const refusal = nativeDraftDispatchRefusal(state, target);
              if (!refusal)
                return;
              evalInput.effect = "deny";
              evalInput.message = refusal;
              return;
            }
            evalInput.effect = "deny";
            evalInput.message = "[forge] A plan is in draft; write operations are denied. Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan.";
          }
        }
      } catch {}
    })).catch(() => {});
  } catch {}
}
function v2ToolEventArgs(raw) {
  if (raw === null || typeof raw !== "object")
    return { tool: undefined, sessionID: undefined, id: undefined, args: {} };
  const o = raw;
  const tool3 = typeof o.tool === "string" ? o.tool : undefined;
  const sessionID = v2PickStr(o, "sessionID", "sessionId");
  const id = v2PickStr(o, "id", "callID");
  const rawArgs = o.input ?? o.args ?? o.arguments;
  const args = rawArgs !== null && typeof rawArgs === "object" ? rawArgs : {};
  return { tool: tool3, sessionID, id, args };
}
function v2AnchorClient(ctx) {
  const rawGet = typeof ctx.session?.get === "function" ? ctx.session.get.bind(ctx.session) : undefined;
  if (!rawGet)
    return null;
  const get = async (opts) => {
    const sid = v2SessionIdOf(opts);
    return sid !== undefined ? rawGet({ sessionID: sid }) : rawGet(opts);
  };
  return { session: { get } };
}
function v2RegisterToolHooks(ctx, anchorClient) {
  if (typeof ctx.tool?.hook !== "function")
    return;
  try {
    Promise.resolve(ctx.tool.hook("execute.before", async (raw) => {
      const { tool: tool3, sessionID, args } = v2ToolEventArgs(raw);
      const evAgent = v2AgentNameOf(raw);
      if (evAgent && sessionID)
        sessionAgents.set(sessionID, evAgent);
      if (process.env.FORGE_PERM_PROBE) {
        try {
          appendFileSync(join5(probeTmp(), "forge-perm-probe.log"), `${new Date().toISOString()} v2-before tool=${JSON.stringify(tool3)} session=${JSON.stringify(sessionID)}
`);
        } catch {}
      }
      const nativeDispatch = tool3 === NATIVE_TOOL_VOCAB.dispatchTool;
      const goalWork = typeof tool3 === "string" && (isWriteTool(tool3) || tool3 === "goal_check");
      const initialState = goalWork && sessionID ? sessions.get(sessionID) : undefined;
      const initialGoal = initialState ? resolveLiveGoal(initialState) : null;
      const initialArm = initialGoal?.doc.session === sessionID ? initialGoal : null;
      const nativeTarget = nativeDispatch && typeof args.agent === "string" ? args.agent : undefined;
      const nativeAnchor = nativeDispatch && sessionID ? await resolveSessionAnchorForPools(anchorClient, sessionID) : "";
      if (nativeAnchor && sessionID)
        ensureSession(sessionID, nativeAnchor);
      if (tool3 === "task") {
        const target = typeof args.subagent_type === "string" ? args.subagent_type : typeof args.agent === "string" ? args.agent : undefined;
        const speaker = sessionID ? sessionAgents.get(sessionID) : undefined;
        if (speaker !== undefined && !isForgeFamilyAgent(speaker)) {
          if (target && target.toLowerCase().startsWith("forge-")) {
            throw new Error(`[forge:partition] Dispatch refused: "${target}" is a forge-family worker and the current agent ("${speaker}") is outside the forge family. Use the native general/explore subagents, or switch to the forge agent to dispatch forge-* workers.`);
          }
        }
        if (target && target.toLowerCase().startsWith("forge-") && sessionID) {
          const poolRefusal = await poolGateRefusal(anchorClient, sessionID, target);
          if (poolRefusal)
            throw new Error(poolRefusal);
        }
        const pendingRefusal = crewPendingRefusal(sessionID);
        if (pendingRefusal)
          throw new Error(pendingRefusal);
        if (target && target.toLowerCase().startsWith("forge-") && sessionID) {
          const complianceRefusal = await crewComplianceRefusalFor(anchorClient, sessionID, target);
          if (complianceRefusal)
            throw new Error(complianceRefusal);
        }
      }
      if (tool3 === "write" || tool3 === "edit") {
        const raw2 = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
        if (raw2) {
          const state = sessionID ? await stateForCheck(sessionID, anchorClient) : null;
          const base = banBaseDirectory(state);
          const abs = (isAbsolute3(raw2) ? raw2 : join5(base || "/", raw2)).replaceAll("\\", "/").toLowerCase();
          if (abs.includes("/.opencode/plan/") || abs.includes("/.opencode/goal/")) {
            throw new Error(`[forge:partition] Write refused: "${raw2}" is inside the forge state directories (.opencode/plan, .opencode/goal), which belong to the forge agent in this workspace.`);
          }
        }
      }
      if (typeof tool3 === "string" && isWriteTool(tool3)) {
        const state = await stateForCheck(sessionID, anchorClient);
        const active = state ? resolveActivePlan(state) : null;
        if (active && active.doc.status === "draft") {
          if (nativeDispatch && state) {
            const refusal = nativeDraftDispatchRefusal(state, nativeTarget);
            if (refusal)
              throw new Error(refusal);
          } else if (tool3 === "task") {
            const target = typeof args.subagent_type === "string" ? args.subagent_type : typeof args.agent === "string" ? args.agent : undefined;
            const refusal = draftDispatchRefusalForState(state, target);
            if (refusal)
              throw new Error(refusal);
          } else {
            throw new Error(`[forge] A plan is in draft; write operations are denied (${tool3}). Switch back to the forge agent to present it and complete plan approval (plan_approve), or run /plan discard to abandon the plan.`);
          }
        }
      }
      assertHarnessAgent(tool3, evAgent ?? (sessionID ? sessionAgents.get(sessionID) : undefined));
      if (sessionID && typeof tool3 === "string") {
        const speaker = sessionAgents.get(sessionID);
        if (speaker !== undefined) {
          if (!isForgeFamilyAgent(speaker) && FORGE_TOOL_SET.has(tool3)) {
            throw new Error(`[forge:partition] Tool refused: "${tool3}" belongs to the forge agent family and the current agent ("${speaker}") is outside it. Switch to forge (Tab) to use forge tooling.`);
          }
          if (isForgeFamilyAgent(speaker) && speaker.toLowerCase() !== FORGE_AGENT && FORGE_STATE_TOOL_SET.has(tool3)) {
            throw new Error(`[forge:partition] Tool refused: "${tool3}" is a harness state tool reserved for the primary forge agent; "${speaker}" is a forge worker. Report your findings back to the orchestrating session — the primary agent calls ${tool3} at the gate.`);
          }
        }
      }
      let missingPoolRefusal;
      let dispatchAnchor = nativeAnchor;
      if (nativeDispatch && nativeTarget?.toLowerCase().startsWith("forge-") && sessionID) {
        dispatchAnchor = await resolveSessionAnchorForPools(anchorClient, sessionID);
        const poolRefusal = poolGateRefusalAtAnchor(dispatchAnchor, sessionID, nativeTarget, true, (refusal) => {
          missingPoolRefusal = refusal;
        });
        if (poolRefusal)
          throw new Error(poolRefusal);
      }
      if (nativeDispatch) {
        const pendingRefusal = crewPendingRefusal(sessionID);
        if (pendingRefusal)
          throw new Error(pendingRefusal);
      }
      if (nativeDispatch && nativeTarget?.toLowerCase().startsWith("forge-") && sessionID && dispatchAnchor) {
        const complianceRefusal = crewComplianceRefusalAtAnchor(dispatchAnchor, sessionID, nativeTarget);
        if (complianceRefusal)
          throw new Error(complianceRefusal);
        if (nativeRosterActive()) {
          const stale = rosterStaleRefusal(dispatchAnchor);
          if (stale)
            throw new Error(stale);
        }
      }
      if (missingPoolRefusal)
        throw new Error(missingPoolRefusal);
      if (goalWork && sessionID) {
        const state = sessions.get(sessionID);
        const fresh = state ? resolveLiveGoal(state) : null;
        const owns = fresh?.doc.session === sessionID;
        const forgeSpeaker = sessionIsForgeFamily(sessionID);
        if (forgeSpeaker && owns && fresh?.doc.status === "paused" || crews.get(sessionID)?.goalGoverned && (!owns || fresh?.doc.status !== "active") || initialArm && (!owns || fresh?.doc.status !== "active" || fresh.path !== initialArm.path || fresh.doc.revision !== initialArm.doc.revision || fresh.doc.armedAt !== initialArm.doc.armedAt)) {
          throw new Error("[forge:goal] Autonomous work refused: the goal is paused or its authorization changed. Ask the user to resume or explicitly re-arm before starting new work.");
        }
      }
    })).catch(() => {});
    Promise.resolve(ctx.tool.hook("execute.after", async (raw) => {
      try {
        const { tool: tool3, sessionID, id, args } = v2ToolEventArgs(raw);
        if (typeof tool3 !== "string" || !sessionID)
          return;
        const act = turnActivity.get(sessionID);
        const event = raw;
        const activityEvent = {
          messageID: typeof event.messageID === "string" ? event.messageID : undefined,
          status: event.status,
          codemode: typeof event.codemode === "boolean" ? event.codemode : undefined
        };
        if (tool3 === "subagent") {
          const result = event.result;
          const metadata = result?.metadata;
          const accepted = event.status === "completed" && id && metadata?.status === "running" && typeof metadata.sessionID === "string" && metadata.sessionID;
          const state = sessions.get(sessionID);
          const goal = state && resolveLiveGoal(state);
          const owns = goal?.doc.status === "active" && goal.doc.session === sessionID;
          const seen = goalAcceptedCalls.get(sessionID) ?? new Map;
          if (accepted && id && !seen.has(id)) {
            if (owns) {
              seen.set(id, metadata.sessionID);
              goalAcceptedCalls.set(sessionID, seen);
              const watched = goalNativeWatch.get(sessionID) ?? new Set;
              watched.add(metadata.sessionID);
              goalNativeWatch.set(sessionID, watched);
            }
            if (act)
              observeGoalActivity(act, tool3, isWriteTool(tool3), id, args, result, activityEvent);
          } else if (!accepted && act)
            observeGoalActivity(act, tool3, isWriteTool(tool3), id, args, undefined, activityEvent);
        } else if (act)
          observeGoalActivity(act, tool3, isWriteTool(tool3), id, event.codemode === true ? event.input : args, event.result ?? event.output, activityEvent);
        const crew = crews.get(sessionID);
        if (crew?.mode === "executing" && tool3 === NATIVE_TOOL_VOCAB.dispatchTool) {
          const round = crewAcceptedRound(id, args, raw);
          if (round && !crew.rounds?.some((r) => r.id === round.id)) {
            (crew.rounds ??= []).push(round);
            appendCrewRecord(crew.recordPath, "wave dispatch", [`${round.description}: ${round.id} → ${round.childID} (${round.agent}${round.agent.startsWith("forge-") ? "" : ", native fallback"})`]);
          }
        }
        const crewAct = crewTurnActivity.get(sessionID);
        if (crewAct) {
          if (id && crewAct.seen?.has(id))
            return;
          if (id)
            (crewAct.seen ??= new Set).add(id);
          if (tool3 === "subagent" || tool3 === "task")
            crewAct.dispatches++;
          if (isWriteTool(tool3))
            crewAct.writes++;
        }
      } catch {}
    })).catch(() => {});
  } catch {}
}
function v2ContextInjection(raw) {
  const o = raw !== null && typeof raw === "object" ? raw : {};
  const sessionID = v2PickStr(o, "sessionID", "sessionId");
  if (!sessionID)
    return;
  const agentName = v2AgentNameOf(o);
  if (agentName)
    sessionAgents.set(sessionID, agentName);
  if (agentName && agentName.startsWith("forge-")) {
    const agentId = agentName.slice("forge-".length);
    const pinnedDef = resolvePools()?.agents[agentId]?.def;
    if (pinnedDef?.model) {
      const identity = parseIdentity(pinnedDef.model);
      if (identity && o.model && typeof o.model === "object") {
        const before = JSON.stringify(o.model);
        const m = o.model;
        const resolvedModel = typeof m.modelID === "string" ? m.modelID : typeof m.id === "string" ? m.id : "";
        const identityEquals = m.providerID === identity.provider && resolvedModel === identity.model;
        const recipeDepth = typeof pinnedDef.thoughtLevel === "string" ? pinnedDef.thoughtLevel : "";
        m.providerID = identity.provider;
        m.id = identity.model;
        m.modelID = identity.model;
        if (identityEquals) {} else if (VARIANT_DEPTH_WORDS.includes(recipeDepth)) {
          m.variant = recipeDepth;
        } else {
          delete m.variant;
        }
        if (process.env.FORGE_MODEL_PROBE) {
          try {
            appendFileSync(join5(probeTmp(), "forge-model-probe.log"), `${new Date().toISOString()} sid=${sessionID} agent=${agentName} rewrite ${before} -> ${JSON.stringify(o.model)}
`);
          } catch {}
        }
      }
    }
    const frozen = sessionDepths.get(sessionID);
    if (frozen) {
      if (frozen.translation) {
        if (o.options === null || typeof o.options !== "object")
          o.options = {};
        applyDepthTranslation(o.options, frozen.translation);
      }
    } else {
      const def = pinnedDef;
      if (def?.thoughtLevel) {
        const modelObj = o.model;
        const providerID = typeof modelObj?.providerID === "string" ? modelObj.providerID : "";
        const modelID = typeof modelObj?.modelID === "string" ? modelObj.modelID : typeof modelObj?.id === "string" ? modelObj.id : "";
        const channel = resolveDepthChannel(providerID, modelID);
        const { translation, findingMessage } = resolvePinnedDepth(def.thoughtLevel, channel);
        sessionDepths.set(sessionID, { translation });
        if (translation) {
          if (o.options === null || typeof o.options !== "object")
            o.options = {};
          applyDepthTranslation(o.options, translation);
        } else if (findingMessage && !depthFindingNotes.has(agentId)) {
          depthFindingNotes.set(agentId, findingMessage);
          console.warn(`[forge:depth] agent forge-${agentId}: ${findingMessage}`);
        }
      }
    }
  }
  if (!sessionIsForgeFamily(sessionID))
    return;
  if (!Array.isArray(o.system))
    o.system = [];
  const system = o.system;
  const crewActive = crews.get(sessionID);
  if (crewActive && !system.some((s) => typeof s === "string" && s.startsWith("[forge:crew-active]"))) {
    const modeText = crewActive.mode === "pending" ? "PENDING (present the execution-mode choice; do not start subagent work until the user authorizes execution)" : "armed (executing)";
    system.push(`[forge:crew-active] A crew is ${modeText} in this session: "${crewActive.objective}" (started ${crewActive.startedAt}). A second /crew must be refused; wait without polling or sleeping for verified settlement of all work rounds and collect evidence for every declared subtask before crew_close (terminal status alone is not PASS), or crew_close {abandon: true, reason} to re-shard, subject to existing approvals.`);
  }
  const state = sessions.get(sessionID);
  if (!state)
    return;
  const active = resolveActivePlan(state);
  if (active) {
    const p = progressOf(active.doc);
    const rel = relFrom(state.worktree, active.path);
    const rule = active.doc.status === "draft" ? "while in draft, write operations are denied at the tool layer; present the plan then end your turn to await the user's review — on feedback revise via plan_write and re-present; call plan_approve only after the user explicitly approves in chat (their confirmation dialog is the final gate); /plan discard to abandon" : "call plan_tick immediately after each completed task; when all are done, self-check every acceptance criterion and call plan_close — the plugin re-runs the frozen verification checks itself (fail-closed, no dialog) and writes an evidence summary the user reviews asynchronously";
    system.push(`[forge:plan-notice] This session is bound to a plan: ${rel} (status: ${active.doc.status}, ${p.done}/${p.total} tasks done). Rule: ${rule}. If the user has not mentioned this plan yet, relay its path and progress to them in one short line at the start of your reply.`);
  }
  const goal = resolveLiveGoal(state);
  if (goal) {
    const rel = relFrom(state.worktree, goal.path);
    const d = goal.doc;
    const rule = d.status === "active" ? "work the success criteria within the approved contract and remaining budgets; wait for verified settlement of any outstanding crew rounds before advancing; during genuine host waiting end your turn without polling or sleeping, the minute budget still runs; meaningful read-only work, commits and checks with new evidence are productive, no write, shell command or git diff is required every turn, and repeated identical checks without new evidence are not progress; stop at either budget limit or loss of authorization, do not start further autonomous work (already accepted host work may finish); call goal_check for host-run feedback and goal_complete at the gate (it re-runs every check itself and asks the user); if globally blocked call goal_pause with the concrete blocker, but if independent authorized work remains after a local issue continue that work" : "the goal is paused; if the user clearly asks to continue (e.g. 'continue'/'resume'), call goal_resume — the user confirms in a dialog; ordinary chat never reactivates it; do not start new autonomous work, including goal-governed crew work; already accepted host work may finish";
    system.push(`[forge:goal-notice] This session is bound to a goal: ${rel} (status: ${d.status}${d.stopReason ? `, stopped: ${d.stopReason}` : ""}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Rule: ${rule}. If the user has not mentioned the goal yet, relay its path and status to them in one short line at the start of your reply.`);
  }
}
function v2CompactionInjection(raw) {
  const o = raw !== null && typeof raw === "object" ? raw : {};
  const sessionID = v2PickStr(o, "sessionID", "sessionId");
  if (!sessionID)
    return;
  if (!sessionIsForgeFamily(sessionID))
    return;
  const state = sessions.get(sessionID);
  if (!state)
    return;
  const goal = resolveLiveGoal(state);
  if (!goal)
    return;
  const d = goal.doc;
  if (!Array.isArray(o.context))
    o.context = [];
  o.context.push(`[forge:goal-brief] A live goal governs this session: ${relFrom(state.worktree, goal.path)} (status: ${d.status}, revision ${d.revision}, ${d.turnsUsed}/${d.maxTurns} turns used). Goal: ${d.goal}. Success criteria:
${d.criteria.map((c, i) => `${i + 1}. ${c}`).join(`
`)}
Post-compaction turns must keep following this goal and its constraints.`);
}
async function v2RegisterSessionHooks(ctx, goalClient) {
  const out = { disposables: [], idleHook: false };
  if (typeof ctx.session?.hook !== "function")
    return out;
  const register = async (name, cb) => {
    try {
      const registration = await ctx.session.hook(name, cb);
      if (registration !== null && typeof registration === "object" && typeof registration.dispose === "function") {
        out.disposables.push(() => registration.dispose());
      }
      return true;
    } catch {
      return false;
    }
  };
  await register("prompt", async (raw) => {
    try {
      const sessionID = v2PickStr(raw, "sessionID", "sessionId");
      if (!sessionID)
        return;
      const agent = v2AgentNameOf(raw);
      if (agent)
        sessionAgents.set(sessionID, agent);
    } catch {}
  });
  await register("context", async (raw) => {
    try {
      v2ContextInjection(raw);
    } catch {}
  });
  await register("compaction", async (raw) => {
    try {
      v2CompactionInjection(raw);
    } catch {}
  });
  out.idleHook = await register("experimental.idle", async (raw) => {
    const sessionID = v2PickStr(raw, "sessionID", "sessionId");
    if (!sessionID)
      return;
    if (hasIdleBackgroundShell(raw, sessionID))
      goalBackgroundHeld.add(sessionID);
    else if (idleBackgroundKnown(raw))
      goalBackgroundHeld.delete(sessionID);
    v2HandleIdle(sessionID, goalClient, goalBackgroundHeld.has(sessionID));
  });
  return out;
}
async function v2StopNative(ctx, sessionID) {
  const svc = discoverServiceHttp();
  const request = async (path, method = "GET") => {
    if (!svc)
      throw new Error("service unavailable");
    const url2 = new URL(svc.url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url2.hostname))
      throw new Error("non-local service");
    const res = await fetch(svc.url + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(1500),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` }
    });
    if (!res.ok)
      throw new Error("stop service request failed");
    return res.status === 204 ? undefined : await res.json();
  };
  let directory = "";
  return stopNative(sessionID, {
    children: async (parent, cursor) => {
      if (ctx.session?.list) {
        try {
          return await ctx.session.list({ parentID: parent, limit: STOP_LIST_LIMIT, ...cursor ? { cursor } : {} });
        } catch {}
      }
      return request(`/api/session?parentID=${encodeURIComponent(parent)}&limit=${STOP_LIST_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    },
    context: async (parent) => {
      if (!ctx.session?.context)
        throw new Error("context unavailable");
      return ctx.session.context({ sessionID: parent });
    },
    shells: async () => {
      if (!svc)
        throw new Error("service unavailable");
      if (!directory) {
        const rec = await ctx.session?.get?.({ sessionID });
        directory = rec?.location?.directory ?? rec?.directory ?? "";
      }
      if (!directory)
        throw new Error("directory unknown");
      return request(`/api/shell?location[directory]=${encodeURIComponent(directory)}`);
    },
    active: () => request("/api/session/active"),
    removeShell: (id) => request(`/api/shell/${encodeURIComponent(id)}?location[directory]=${encodeURIComponent(directory)}`, "DELETE"),
    interrupt: async (id) => {
      if (!ctx.session?.interrupt)
        throw new Error("interrupt unavailable");
      return ctx.session.interrupt({ sessionID: id });
    },
    wait: () => new Promise((resolve5) => setTimeout(resolve5, 200))
  });
}
async function v2RegisterCommands(ctx) {
  if (typeof ctx.command?.transform !== "function")
    return;
  try {
    await ctx.command.transform((editor) => {
      const addFn = editor?.add;
      if (typeof addFn !== "function") {
        console.warn("forge: command domain editor drifted — add() missing; commands not registered");
        return;
      }
      const addTemplateCommand = (name, template, description) => {
        addFn({
          name,
          description,
          execute: async (input) => {
            const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined;
            if (!sessionID || typeof ctx.session?.prompt !== "function")
              return;
            const promptShape = input?.prompt;
            const typed = promptShape && typeof promptShape === "object" && typeof promptShape.text === "string" ? promptShape.text : undefined;
            const stop = name === "forge" && typed?.trim() === "stop";
            if (!stop) {
              let record4;
              try {
                record4 = await ctx.session.get?.({ sessionID });
              } catch {}
              if (record4?.agent !== FORGE_AGENT || record4.parentID !== undefined) {
                throw new Error(`[forge:command] /${name} belongs to the primary forge agent. Switch to forge (Tab) and rerun it there.`);
              }
            }
            const text = stop ? await v2StopNative(ctx, sessionID) : composeCommandPrompt(template().split(`
`).filter((line) => !line.startsWith("FAMILY GUARD (step 0")).join(`
`), typed);
            const delivery = typeof input?.delivery === "string" && input.delivery ? input.delivery : undefined;
            try {
              await ctx.session.prompt(delivery ? { sessionID, text, delivery } : { sessionID, text });
            } catch (e) {
              if (!delivery)
                throw e;
              const head = `${e?.name ?? ""} ${e?.message ?? String(e)}`;
              if (!/schema/i.test(head))
                throw e;
              console.warn(`forge: command '${name}' delivery hint rejected by host prompt schema — delivering without it (${head.slice(0, 120)})`);
              await ctx.session.prompt({ sessionID, text });
            }
          }
        });
      };
      addTemplateCommand("plan", () => PLAN_COMMAND_TEMPLATE, "forge plan harness: no argument lists in-progress plans; resume continues the latest; discard abandons it; a goal enters planning discipline");
      addTemplateCommand("goal", () => GOAL_COMMAND_TEMPLATE, "forge goal harness (autonomous, host-verified): no argument lists goals; pause/resume/discard drive the loop; add queues; next promotes; an objective drafts a contract and arms it (--check/--contains markers become verification items)");
      const registrationResolution = resolvePools();
      const registrationAgentCount = Object.keys(registrationResolution?.agents ?? {}).length;
      const crewTemplate = () => {
        const res = resolvePools();
        if (Object.keys(res?.agents ?? {}).length > 0)
          return crewOrchestrationTemplate(res ?? null);
        const anchorDir = hostAnchors[0] ?? undefined;
        return CREW_INIT_TEMPLATE.replaceAll("{paths}", `   - ${forgeConfigPaths({ projectDir: anchorDir, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).project}
   - ${forgeConfigPaths({ projectDir: anchorDir, homeDir: process.env.FORGE_TEST_FORGE_HOME ?? homedir() }).global}`).replaceAll("{template}", JSON.stringify({ pool: "namespace (REQUIRED for crew-governed dispatch, [a-z0-9-] up to 24 chars — every pool materializes as forge-<ns>-<id>; the global fallback materializes as forge-global-<id>)", agents: { research: { model: "provider/model", thoughtLevel: "low", shape: "readonly", prompt: "short role description — what this agent does" }, coder: { model: "provider/model", thoughtLevel: "low", shape: "write", prompt: "short role description — what this agent does" } } }, null, 2).split(`
`).map((l) => "   " + l).join(`
`));
      };
      addTemplateCommand("crew", crewTemplate, registrationAgentCount > 0 ? "forge crew orchestration: register a declared subtask plan, execute it in waves of native subagent calls, close with an evidence-checked report" : "forge crew orchestration — NOT INITIALIZED: no forge subagents configured; invoking it shows the one-time setup guidance");
      addTemplateCommand("forge", () => FORGE_COMMAND_TEMPLATE, "forge roster levers: sync forces an immediate forge_sync and shows the diff; init drafts the workspace forge.json in-band (refuses when one exists — review instead); init global drafts the global forge.json with the built-in override entries commented out; stop requests cancellation of confirmed native children");
    });
  } catch (e) {
    const head = e instanceof Error ? e.message : String(e);
    console.warn(`forge: command domain registration drifted — ${head.slice(0, 160)}`);
  }
}
function composeCommandPrompt(template, typed) {
  const text = typeof typed === "string" ? typed : "";
  if (!text.trim())
    return template;
  if (template.includes("$ARGUMENTS"))
    return template.replaceAll("$ARGUMENTS", () => text);
  return `${template}

${text}`;
}
function v2PromptInputOf(opts) {
  if (opts === null || typeof opts !== "object")
    return null;
  const o = opts;
  const sid = typeof o.path?.id === "string" && o.path.id ? o.path.id : typeof o.sessionID === "string" ? o.sessionID : undefined;
  if (!sid)
    return null;
  const parts = Array.isArray(o.body?.parts) ? o.body.parts : [];
  const textPart = parts.find((p) => p !== null && typeof p === "object" && typeof p.text === "string");
  const text = textPart?.text ?? (typeof o.body?.text === "string" ? o.body.text : undefined);
  if (typeof text !== "string" || !text)
    return null;
  return { sessionID: sid, text };
}
var serviceHttpCache;
var serviceHttpLastFail = 0;
function defaultServiceFileReachable() {
  if (process.env.NODE_TEST_CONTEXT)
    return false;
  return !process.execArgv.some((a) => a === "--test" || a.startsWith("--test-"));
}
function discoverServiceHttp() {
  if (serviceHttpCache)
    return serviceHttpCache;
  if (serviceHttpCache === null && Date.now() - serviceHttpLastFail < 1e4)
    return null;
  const file2 = process.env.FORGE_SERVICE_FILE || (defaultServiceFileReachable() ? join5(process.env.XDG_STATE_HOME || join5(homedir(), ".local", "state"), "opencode", "service.json") : "");
  if (!file2)
    return null;
  try {
    const raw = JSON.parse(readFileSync5(file2, "utf8"));
    if (raw && typeof raw.url === "string" && typeof raw.password === "string" && raw.url && raw.password) {
      serviceHttpCache = { url: raw.url.replace(/\/+$/, ""), password: raw.password };
    } else {
      serviceHttpCache = null;
      serviceHttpLastFail = Date.now();
    }
  } catch {
    serviceHttpCache = null;
    serviceHttpLastFail = Date.now();
  }
  return serviceHttpCache;
}
function resetServiceHttpDiscoveryForTests() {
  serviceHttpCache = undefined;
  serviceHttpLastFail = 0;
}
function v2SessionIdOf(opts) {
  if (opts === null || typeof opts !== "object")
    return;
  const o = opts;
  if (typeof o.path?.id === "string" && o.path.id)
    return o.path.id;
  if (typeof o.sessionID === "string" && o.sessionID)
    return o.sessionID;
  return;
}
function v2SessionClientForTests(ctx) {
  return v2SessionClient(ctx);
}
async function serviceHttpGet(svc, path) {
  const res = await fetch(`${svc.url}${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` }
  });
  if (!res.ok)
    throw new Error(`service HTTP ${res.status} for ${path}`);
  return await res.json();
}
var NATIVE_CHILD_LIST_LIMIT = 500;
function v2NativeChildWalker() {
  return {
    session: {
      list: async (args) => {
        const svc = discoverServiceHttp();
        if (!svc)
          throw new Error("native-child walker: service.json discovery failed");
        const parent = args !== null && typeof args === "object" && typeof args.parentID === "string" ? args.parentID : "";
        const cursor = args?.cursor;
        return await serviceHttpGet(svc, parent ? `/api/session?parentID=${encodeURIComponent(parent)}&limit=${NATIVE_CHILD_LIST_LIMIT}${typeof cursor === "string" && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : "/api/session");
      },
      status: async () => {
        const svc = discoverServiceHttp();
        if (!svc)
          throw new Error("native-child walker: service.json discovery failed");
        const body = await serviceHttpGet(svc, "/api/session/active");
        const map2 = body !== null && typeof body === "object" && !Array.isArray(body) && "data" in body ? body.data : body;
        return { data: map2 };
      }
    }
  };
}
function v2SessionClient(ctx) {
  const s = ctx.session;
  if (s === null || typeof s !== "object")
    return null;
  const out = {};
  if (typeof s.prompt === "function") {
    const send = async (opts) => {
      const input = v2PromptInputOf(opts);
      if (!input)
        return;
      return s.prompt(input);
    };
    out.prompt = send;
    out.promptAsync = send;
  }
  if (typeof s.get === "function") {
    out.get = async (opts) => {
      const sid = v2SessionIdOf(opts);
      return sid !== undefined ? s.get({ sessionID: sid }) : s.get(opts);
    };
  }
  if (typeof s.context === "function")
    out.context = (opts) => s.context(opts);
  return Object.keys(out).length > 0 ? { session: out, nativeChildWalker: v2NativeChildWalker() } : null;
}
function v2EventFields(raw) {
  if (raw === null || typeof raw !== "object")
    return {};
  const o = raw;
  if (o.data !== null && typeof o.data === "object")
    return o.data;
  if (o.properties !== null && typeof o.properties === "object")
    return o.properties;
  return o;
}
function v2HandleIdle(sessionID, goalClient, backgroundWaiting = false) {
  try {
    goalProbe(`v2 idle session=${sessionID}`);
    if (goalClient)
      scheduleIdleContinuation(goalClient, sessionID, IDLE_DEBOUNCE_MS, backgroundWaiting);
  } catch {}
}
function v2SubscribeEvents(ctx, goalClient, idleFallback) {
  const subscribeFn = ctx.event?.subscribe?.bind(ctx.event);
  if (typeof subscribeFn !== "function")
    return null;
  const controller = new AbortController;
  const trySubscribe = () => {
    try {
      const sub = subscribeFn({ signal: controller.signal });
      if (sub !== null && typeof sub === "object" && typeof sub[Symbol.asyncIterator] === "function") {
        return sub[Symbol.asyncIterator]();
      }
    } catch {}
    return null;
  };
  try {
    let iterator = trySubscribe();
    if (!iterator)
      return null;
    const run = async () => {
      let backoffMs = 1000;
      while (!controller.signal.aborted) {
        const iter = iterator;
        if (!iter)
          return;
        try {
          for (;; ) {
            const next = await iter.next();
            if (controller.signal.aborted)
              return;
            if (next.done)
              break;
            const ev = next.value;
            const type = ev !== null && typeof ev === "object" && typeof ev.type === "string" ? ev.type : undefined;
            if (!type)
              continue;
            const fields = v2EventFields(ev);
            noteCrewNativeChildEvent(type, fields, goalClient);
            if (type === "session.deleted") {
              try {
                const info = fields.info;
                const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId");
                if (id)
                  harvestSessionEnd(id);
              } catch {}
            } else if (type === "session.moved") {
              try {
                const f = movedEventFields(fields);
                noteSessionMoved(f.sessionID, f.directory);
              } catch {}
            } else if (idleFallback && type === "session.execution.succeeded") {
              const sessionID = v2PickStr(fields, "sessionID", "sessionId");
              if (sessionID)
                v2HandleIdle(sessionID, goalClient);
            } else if (type === "session.created") {
              try {
                const info = fields.info ?? fields.session;
                const id = info !== null && typeof info === "object" && typeof info.id === "string" && info.id ? info.id : v2PickStr(fields, "sessionID", "sessionId");
                const worktree = effectiveWorktree(info !== null && typeof info === "object" && typeof info.worktree === "string" ? info.worktree : undefined, info !== null && typeof info === "object" && typeof info.directory === "string" ? info.directory : undefined);
                if (id && typeof worktree === "string" && worktree) {
                  ensureSession(id, worktree);
                }
              } catch {}
            } else if (idleFallback && type === "session.idle") {
              const sessionID = v2PickStr(fields, "sessionID", "sessionId");
              if (sessionID)
                v2HandleIdle(sessionID, goalClient);
            }
          }
        } catch {}
        if (controller.signal.aborted)
          return;
        await new Promise((resolve5) => setTimeout(resolve5, backoffMs));
        if (controller.signal.aborted)
          return;
        const fresh = trySubscribe();
        if (!fresh)
          return;
        iterator = fresh;
        backoffMs = 1000;
      }
    };
    run();
    let closing;
    return () => {
      if (!closing) {
        controller.abort();
        closing = (async () => {
          try {
            await iterator?.return?.();
          } catch {}
        })();
      }
      return closing;
    };
  } catch {
    return null;
  }
}
var v2WiringSeam = { modelsDevCatalog: () => modelsDevCatalog, resolveDepthChannel, sessions, sessionAgents, crews, sessionDepths, turnActivity, crewTurnActivity, sessionMovedAnchors, crewNativeChildren, crewNativeCeiling, crewChildDigest, crewNativeWatch, crewNativeRecheckArmed: (sessionID) => crewNativeRecheck.has(sessionID), crewNativeRecheckNow: (sessionID, client) => crewNativeRecheckTick(sessionID, client), resetHostAnchors: () => {
  hostAnchors.length = 0;
  v2HostAnchors.clear();
  observedRecipeFiles.clear();
  poolResolver = null;
  poolResolution = null;
} };
function v2PermissionArray(record4) {
  const arr = Object.entries(record4).map(([action, effect]) => ({ action, resource: "*", effect }));
  return arr;
}
function v2ReadHideNatives(deps) {
  try {
    const homeDir = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir();
    const globalPath = forgeConfigPaths({ homeDir }).global;
    const text = deps?.readFile ? deps.readFile(globalPath) : readFileSync5(globalPath, "utf8");
    const parsed = parseForgeJsonc(text);
    if (parsed.ok && parsed.config !== null && typeof parsed.config === "object") {
      const knob = parsed.config.hideNativeAgents;
      if (knob === false)
        return false;
    }
  } catch {}
  return true;
}
async function v2Setup(ctx, deps) {
  for (const finding of legacyDispatchEnvFindings(process.env))
    console.warn(`[forge:v2] ${finding.level}: ${finding.message}`);
  const noFetch = process.env.FORGE_TEST_NO_DISPATCH_FETCH;
  const nodeTest = !!process.env.NODE_TEST_CONTEXT || process.execArgv.some((a) => a === "--test" || a.startsWith("--test-"));
  await refreshModelsDevCatalog(noFetch === "1" || noFetch !== "0" && nodeTest, 2000);
  const explicitCandidates = [...deps?.anchors ?? [], ...v2AnchorCandidates(ctx, false)];
  const v2Candidates = [...explicitCandidates, process.cwd()];
  {
    for (const cand of v2Candidates) {
      const t = cand.trim();
      if (t)
        rememberHostAnchor(t);
    }
    const first = v2Candidates.find((c) => c && !isRootish(c));
    if (first) {
      hostWorktree = first;
      v2InitializedDirs.add(normalizeAnchorDir(first) || first);
    }
  }
  v2HostSeen = true;
  const homeDir = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir();
  const globalPoolFile = forgeConfigPaths({ homeDir }).global;
  const readRecipe = deps?.readFile ?? ((path) => readFileSync5(path, "utf8"));
  const recipeStat = deps?.stat ?? recipeFileStat;
  const snapshots = new Map;
  const unreadable2 = new Set;
  const snapshotRead = (path) => {
    const previous = snapshots.get(path);
    if (previous !== undefined)
      return previous;
    if (unreadable2.has(path))
      throw new Error(`Recipe unavailable in this sync snapshot: ${path}`);
    try {
      const text = readRecipe(path);
      snapshots.set(path, text);
      return text;
    } catch (err) {
      unreadable2.add(path);
      throw err;
    }
  };
  const globalKnobs = readGlobalKnobs(globalPoolFile, { readFile: snapshotRead });
  const stillAuthorized = (path) => {
    const text = snapshots.get(path);
    if (text === undefined)
      return false;
    const parsed = parseForgeJsonc(text);
    if (!parsed.ok || !parseTopLevelKnobs(parsed.config, path).syncAuto)
      return false;
    try {
      return recipeStat(path) !== null && readRecipe(path) === text;
    } catch {
      return false;
    }
  };
  v2MaterializeMode = deps?.materialize ?? globalKnobs.materialize ?? "native";
  if (v2MaterializeMode === "native") {
    try {
      const resolver = createPoolResolver({ homeDir, stat: recipeStat, readFile: snapshotRead });
      const explicitKeys = explicitCandidates.map(normalizeAnchorDir).filter(Boolean);
      const currentKeys = new Set(explicitKeys.length ? explicitKeys : [normalizeAnchorDir(process.cwd())]);
      const currentFiles = new Set([globalPoolFile]);
      for (const anchor of hostAnchors) {
        if (!currentKeys.has(anchorKey(anchor)))
          continue;
        const file2 = resolver.workspacePoolOf(anchor);
        if (file2 !== null)
          currentFiles.add(file2);
      }
      const resolution = resolver.resolve(hostAnchors);
      for (const family of resolution.families)
        observedRecipeFiles.add(family.file);
      const overrideDir = globalAgentDirFor({ homeDir, configDir: process.env.OPENCODE_CONFIG_DIR });
      const rosterDirs = { globalPoolFile, globalAgentDir: overrideDir };
      const allPlans = planRosterSync(resolution, rosterDirs);
      for (const family of resolution.families) {
        if (!currentFiles.has(family.file))
          continue;
        const verdict = staleCheckForPool(family.file, family.materializedIds, realRosterFs(), (matId) => compileResolvedRosterEntry(resolution, matId, { globalPoolFile }).content, rosterAgentDirFor(family.file, rosterDirs));
        if (!verdict.stale)
          continue;
        if (!stillAuthorized(family.file)) {
          console.warn(`[forge:sync] warn: ${verdict.reason}; call forge_sync to reconcile (no current auto opt-in).`);
          continue;
        }
        const plans = allPlans.filter((p) => p.family.file === family.file);
        const outcome = executeRosterSync(plans, realRosterFs());
        console.warn(`[forge:sync] warn: sync:"auto" — stale roster regenerated at session start (${verdict.reason}); created ${outcome.created.length}, updated ${outcome.updated.length}, gc'd ${outcome.gced.length}${outcome.errors.length ? `, errors: ${outcome.errors.join("; ")}` : ""}`);
      }
      const overridePlan = planOverrideSync(resolution.overrides ?? {}, { dir: overrideDir, recipeFile: globalPoolFile }) ?? { kind: "override", dir: overrideDir, files: [] };
      const overrideFindings = overrideSyncFindings(overridePlan, realRosterFs());
      if (overrideFindings.length) {
        if (stillAuthorized(globalPoolFile)) {
          const outcome = executeRosterSync([overridePlan], realRosterFs());
          console.warn(`[forge:sync] warn: sync:"auto" — ${overrideFindings.join("; ")}; created ${outcome.created.length}, updated ${outcome.updated.length}, gc'd ${outcome.gced.length}${outcome.errors.length ? `, errors: ${outcome.errors.join("; ")}` : ""}`);
        } else {
          console.warn(`[forge:sync] warn: ${overrideFindings.join("; ")}; call forge_sync to reconcile (no auto opt-in).`);
        }
      }
    } catch {}
  }
  let disposeConfigRpc = null;
  if (typeof ctx.rpc?.register === "function") {
    try {
      rotateConfigRpcEpoch();
      const rpcLocation = (() => {
        try {
          const reader = ctx.location?.directory;
          const v = typeof reader === "function" ? reader() : reader;
          if (typeof v === "string" && v.trim() !== "" && !isRootish(v))
            return v;
        } catch {}
        return null;
      })();
      const accessors = {
        sessionAnchorOf: (sessionID) => {
          const moved = sessionMovedAnchors.get(sessionID);
          if (moved && moved.trim() !== "" && !isRootish(moved))
            return moved;
          const resolved = rpcAnchorRequestContext.getStore()?.resolvedAnchor;
          if (typeof resolved === "string" && resolved.trim() !== "" && !isRootish(resolved))
            return resolved;
          const mapped = sessions.get(sessionID)?.worktree ?? "";
          if (mapped && mapped.trim() !== "" && !isRootish(mapped))
            return mapped;
          const ledger = resolveAnchorViaLedger(sessionID, "");
          return ledger && ledger.trim() !== "" && !isRootish(ledger) ? ledger : null;
        },
        workspacePoolOf: (anchor) => sessionPoolFileOf(anchor),
        globalPoolPath: () => globalPoolPathOf(),
        knownWorkspaceRoot: (anchor) => hostAnchors.some((a) => anchorKey(a) === anchorKey(anchor)),
        samePath: (a, b) => a.trim() !== "" && b.trim() !== "" && foldPath3(a) === foldPath3(b),
        pathExists: (p) => recipeFileStat(p) !== null
      };
      const syncResolvers = () => {
        if (hostAnchors.length === 0)
          return null;
        const readOf = new Map;
        const fresh = createPoolResolver({
          homeDir,
          readFile: (p) => {
            const text = strictUtf8Read(p);
            readOf.set(p, text);
            return text;
          }
        });
        const resolution = fresh.resolve(hostAnchors);
        for (const f of resolution.families)
          observedRecipeFiles.add(f.file);
        return { resolution, readOf: (p) => readOf.get(p) ?? null };
      };
      const hostDeps = createConfigRpcHostDeps(accessors, {
        observedLocation: rpcLocation,
        beforeCommit: (req) => captureSyncBaseline({ ownerFile: req.binding.path, anchor: req.binding.anchor, observedLocation: req.binding.observedLocation }, syncResolvers, () => Date.now())
      });
      const store = createConfigRpcStore(hostDeps);
      const listNativeAgents = async () => {
        if (typeof ctx.agent?.list !== "function")
          return null;
        try {
          const out = await ctx.agent.list();
          const rows2 = Array.isArray(out) ? out : out !== null && typeof out === "object" && Array.isArray(out.data) ? out.data : null;
          if (rows2 === null)
            return null;
          const mapped = [];
          for (const row of rows2) {
            if (row === null || typeof row !== "object")
              return null;
            const rec = row;
            if (typeof rec.id !== "string" || rec.id.trim() === "")
              return null;
            mapped.push({ id: rec.id, system: rec.system, model: rec.model, permissions: rec.permissions });
          }
          return mapped;
        } catch {
          return null;
        }
      };
      const syncDeps = {
        resolveScope: hostDeps.resolver,
        resolvePools: syncResolvers,
        getCommitContext: (commitId) => store.getCommitContext(commitId),
        globalPoolFile: globalPoolPathOf,
        rosterDirs: () => ({ globalPoolFile: globalPoolPathOf(), globalAgentDir: globalAgentDirFor({ homeDir, configDir: process.env.OPENCODE_CONFIG_DIR }) }),
        rosterFs: realRosterFs,
        epoch: currentConfigRpcEpoch,
        listNativeAgents,
        attachSyncOutcome: (commitId, sync) => store.attachSyncOutcome(commitId, sync)
      };
      const syncHandler = createConfigRpcSyncHandler(syncDeps);
      const appVersion = typeof ctx.app?.version === "string" ? ctx.app.version : "";
      const withPreload = (handler) => async (input) => {
        const sid = input !== null && typeof input === "object" ? input.sessionID : undefined;
        let resolvedAnchor = "";
        if (typeof sid === "string" && sid.trim() !== "") {
          try {
            const anchor = await resolveSessionAnchorForPools(sharedAnchorClient(), sid);
            if (typeof anchor === "string" && anchor.trim() !== "" && !isRootish(anchor))
              resolvedAnchor = anchor;
          } catch {}
        }
        return rpcAnchorRequestContext.run({ resolvedAnchor }, () => handler(input));
      };
      const registration = await ctx.rpc.register(forgeConfigRpcDefinition, Object.fromEntries(Object.entries({ ...store.handlers({ pluginID: "forge", appVersion }), sync: syncHandler }).map(([name, handler]) => [name, withPreload(handler)])));
      if (registration && typeof registration.dispose === "function") {
        const regDispose = registration.dispose.bind(registration);
        disposeConfigRpc = async () => {
          rotateConfigRpcEpoch();
          try {
            await regDispose();
          } catch {}
        };
      }
    } catch (err) {
      console.warn(`[forge:v2] warn: forge-config RPC registration unavailable — the config commit protocol is disabled for this process (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform((draft) => {
      if (typeof draft.get !== "function" || typeof draft.update !== "function")
        return;
      if (draft.get(FORGE_AGENT) === undefined) {
        draft.update(FORGE_AGENT, (agent) => {
          agent.description = "forge — the single general-purpose coding agent: takes implementation tasks directly; planning goes through /plan into the plan harness (plans land in .opencode/plan/, with an approve confirmation gate, a plugin-verified fail-closed close that re-runs the frozen checks, and tick discipline enforced by tools and the permission layer).";
          agent.system = FORGE_PROMPT;
          agent.mode = "primary";
        });
      }
      if (v2ReadHideNatives(deps)) {
        for (const nativeId of ["build", "plan"]) {
          try {
            const rec = draft.get(nativeId);
            if (rec === undefined || rec === null)
              continue;
            if (typeof rec === "object" && rec.hidden === true)
              continue;
            draft.update(nativeId, (r) => {
              r.hidden = true;
            });
          } catch (err) {
            console.warn(`[forge:v2] error: native agent ${nativeId} not hidden: ${String(err)}`);
          }
        }
      }
      if (v2MaterializeMode === "native") {} else
        try {
          const homeDir2 = deps?.homeDir ?? process.env.FORGE_TEST_FORGE_HOME ?? homedir();
          const candidates = [...deps?.anchors ?? [], ...v2AnchorCandidates(ctx)];
          for (const cand of candidates) {
            const key = normalizeAnchorDir(cand);
            if (key && !v2HostAnchors.has(key))
              v2HostAnchors.set(key, cand.trim());
          }
          const resolver = createPoolResolver({ homeDir: homeDir2, stat: deps?.stat ?? recipeFileStat, readFile: deps?.readFile });
          const resolution = resolver.resolve([...v2HostAnchors.values()]);
          for (const finding of resolution.findings) {
            console.warn(`[forge:v2] ${finding.level}: ${finding.message}`);
          }
          const v2GlobalPath = forgeConfigPaths({ homeDir: homeDir2 }).global;
          for (const [matId, agent] of Object.entries(resolution.agents)) {
            const id = `forge-${matId}`;
            if (draft.get(id) !== undefined)
              continue;
            const provenance = foldPath3(agent.file) === foldPath3(v2GlobalPath) ? { global: true } : { ns: agent.ns, file: agent.file };
            const v1def = forgeAgentDef(matId, agent.def, provenance, agent.shared ?? undefined);
            try {
              draft.update(id, (agentDraft) => {
                agentDraft.description = v1def.description;
                agentDraft.system = v1def.prompt;
                agentDraft.mode = v1def.mode;
                agentDraft.permissions = v2PermissionArray(v1def.permission);
              });
            } catch (err) {
              console.warn(`[forge:v2] error: agent ${id} not materialized: ${String(err)}`);
            }
          }
        } catch {}
      try {
        if (typeof draft.default === "function")
          draft.default(FORGE_AGENT);
      } catch {}
    });
  }
  if (typeof ctx.tool?.transform === "function") {
    const toolAnchor = v2AnchorClient(ctx);
    const toolAssert = typeof ctx.permission?.assert === "function" ? (input) => ctx.permission.assert(input) : null;
    try {
      await ctx.tool.transform((editor) => {
        if (typeof editor?.add !== "function")
          return;
        for (const [name, def] of Object.entries(forgeTools())) {
          const d = def;
          editor.add({
            name,
            description: typeof d.description === "string" ? d.description : name,
            input: v2ToolInputSchema(d.args),
            async execute(args, toolCtx) {
              const { context, defaultDirectory } = await v2ToolContext(toolCtx, toolAnchor, toolAssert);
              if (name === "crew_close" && typeof context.sessionID === "string") {
                const sid = context.sessionID;
                context.crewCloseEvidence = async () => {
                  const view = await walkNativeChildren(v2NativeChildWalker(), sid);
                  let transcript = null;
                  try {
                    transcript = await ctx.session?.context?.({ sessionID: sid });
                  } catch {}
                  return { ...view, rounds: crews.get(sid)?.rounds ?? [], context: transcript };
                };
              }
              const res = await d.execute?.(args, context);
              return nameDefaultDirectory(wrapV2ToolResult(res), defaultDirectory);
            }
          });
        }
      });
    } catch {}
  }
  const searchLocation = ctx.location;
  const searchDirectory = searchLocation?.directory;
  const searchProject = searchLocation?.project?.directory;
  const searchWarn = (message) => console.warn(`[forge:search] ${message}; native tools retained`);
  if (typeof searchDirectory === "string" && isAbsolute3(searchDirectory) && typeof searchProject === "string" && isAbsolute3(searchProject) && searchLocation?.workspaceID === undefined && typeof ctx.permission?.assert === "function" && typeof ctx.tool?.transform === "function") {
    const ask = ctx.permission.assert.bind(ctx.permission);
    try {
      await ctx.tool.transform((editor) => {
        for (const kind of ["grep", "glob"]) {
          const native = editor.get?.(kind);
          if (!native || !editor.update || typeof native.execute !== "function" || !native.output) {
            searchWarn(`${kind} definition unavailable`);
            continue;
          }
          const output = native.output;
          const outputFields = output.value?.fields ?? output.items?.properties;
          const requiredOutput = kind === "grep" ? ["entry", "line", "offset", "text", "submatches"] : ["path", "type"];
          if (!outputFields || !requiredOutput.every((key) => (key in outputFields))) {
            searchWarn(`${kind} unknown output schema`);
            continue;
          }
          const executeNative = native.execute;
          const schema = native.input;
          let enhancedInput;
          if (schema?.fields && typeof schema.mapFields === "function") {
            const bool = schema.fields[kind === "grep" ? "literal" : "hidden"];
            if (typeof bool?.annotate !== "function") {
              searchWarn(`${kind} optional boolean schema unavailable`);
              continue;
            }
            enhancedInput = schema.mapFields((fields) => ({ ...fields, ...kind === "glob" ? { hidden: bool.annotate({ description: "Include hidden files and directories (default: true).", default: true }) } : {}, follow: bool.annotate({ description: "Follow symbolic links and junctions (default: true).", default: true }) }));
          } else if (schema?.type === "object" && schema.properties) {
            enhancedInput = { ...schema, properties: { ...schema.properties, ...kind === "glob" ? { hidden: { ...schema.properties.hidden, default: true, description: "Include hidden files and directories (default: true)." } } : {}, follow: { type: "boolean", default: true, description: "Follow symbolic links and junctions (default: true)." } } };
          } else {
            searchWarn(`${kind} unknown input schema`);
            continue;
          }
          try {
            editor.update(kind, (draft) => {
              draft.input = enhancedInput;
              draft.description = `${native.description ?? kind} Follows symbolic links and junctions by default.${kind === "glob" ? " Hidden directories are included by default." : ""}`;
              draft.execute = async (raw, invocation) => {
                if (raw.path && ambiguousSearchPath(raw.path)) {
                  const { follow: _follow, ...nativeInput } = raw;
                  return executeNative(nativeInput, invocation);
                }
                let rgConfig;
                for (const file2 of [forgeConfigPaths({ projectDir: searchProject }).project, globalPoolPathOf()]) {
                  try {
                    const parsed = parseForgeJsonc(readFileSync5(file2, "utf8"));
                    const search = parsed.ok ? parsed.config?.search : undefined;
                    if (typeof search?.rgPath === "string") {
                      rgConfig = search;
                      break;
                    }
                  } catch {}
                }
                const rg = resolveRgBinary(rgConfig);
                let engine = rg.ok ? "ripgrep" : "builtin-js";
                const startupFailed = (result) => result.error && result.status === null && ["ENOENT", "EACCES", "EPERM", "ENOEXEC"].includes(result.error.code ?? "");
                const grep = rg.ok ? (bytes, input) => {
                  if (engine === "builtin-js")
                    return jsGrep(bytes, input);
                  const args = ["--no-config", "--no-ignore", "--json", ...input.literal ? ["--fixed-strings"] : [], ...input.caseSensitive === false ? ["--ignore-case"] : [], "--", input.pattern, "-"];
                  const result = spawnSync3(rg.binary, args, { input: bytes, encoding: "utf8", windowsHide: true, timeout: 1e4, maxBuffer: 32 * 1024 * 1024 });
                  if (startupFailed(result)) {
                    engine = "builtin-js";
                    return jsGrep(bytes, input);
                  }
                  if (result.error || result.status !== 0 && result.status !== 1)
                    throw new Error(result.error?.message ?? result.stderr ?? "ripgrep failed");
                  return result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
                    const event = JSON.parse(line);
                    if (event.type !== "match")
                      return [];
                    const d = event.data;
                    const text = d.lines.text ?? Buffer.from(d.lines.bytes, "base64").toString("utf8");
                    return [{ line: d.line_number, offset: d.absolute_offset, text: text.length > 2000 ? text.slice(0, 2000) + "..." : text, submatches: d.submatches.slice(0, 100).map((m) => ({ text: m.match.text ?? Buffer.from(m.match.bytes ?? "", "base64").toString("utf8"), start: m.start, end: m.end })) }];
                  });
                } : undefined;
                const glob = rg.ok ? (pattern, paths) => {
                  if (!paths.length)
                    return [];
                  const fallback = () => paths.map((path) => matchGlob(pattern, path));
                  if (engine === "builtin-js")
                    return fallback();
                  const result = spawnSync3(rg.binary, ["--no-config", "--no-ignore", "--null-data", "--line-number", "--no-filename", "--color", "never", "--", strictGlobToRegExp(pattern).source, "-"], { input: paths.join("\x00") + "\x00", encoding: "utf8", windowsHide: true, timeout: 1e4, maxBuffer: 32 * 1024 * 1024 });
                  if (startupFailed(result)) {
                    engine = "builtin-js";
                    return fallback();
                  }
                  if (result.error || result.status !== 0 && result.status !== 1)
                    throw new Error(result.error?.message ?? result.stderr ?? "ripgrep failed");
                  const matched = new Set(result.stdout.split("\x00").map((line) => Number(line.slice(0, line.indexOf(":")))));
                  return paths.map((_, i) => matched.has(i + 1));
                } : undefined;
                return authorizedSearch(kind, raw, invocation, searchDirectory, searchProject, {
                  realpath: realpathSync4,
                  stat: lstatSync3,
                  list: readdirSync,
                  read: (path) => {
                    const fd = openSync(path, "r");
                    try {
                      const before = fstatSync(fd);
                      if (!before.isFile() || before.size > MAX_FILE_BYTES || realpathSync4(path) !== path)
                        return Buffer.alloc(MAX_FILE_BYTES + 1);
                      const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
                      const n = readSync(fd, bytes, 0, bytes.length, 0);
                      const after = fstatSync(fd);
                      if (before.ino !== after.ino || before.dev !== after.dev || realpathSync4(path) !== path)
                        throw new Error("Search target changed");
                      return bytes.subarray(0, n);
                    } finally {
                      closeSync(fd);
                    }
                  },
                  assert: ask,
                  grep,
                  glob,
                  engine: () => engine,
                  globalIgnore: { home: (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ?? "", xdg: process.env.XDG_CONFIG_HOME },
                  delegateNative: () => {
                    searchWarn("global ignore authorization or environment unavailable");
                    const { follow: _follow, ...nativeInput } = raw;
                    return executeNative(nativeInput, invocation);
                  }
                });
              };
            });
          } catch (error45) {
            searchWarn(`${kind} update rejected: ${String(error45)}`);
          }
        }
      });
    } catch (error45) {
      searchWarn(`tool transform rejected: ${String(error45)}`);
    }
  } else
    searchWarn("host availability or permission context unknown or non-local");
  v2RegisterPermissionBelt(ctx);
  const v2Anchor = v2AnchorClient(ctx);
  anchorClientShared = v2Anchor;
  v2RegisterToolHooks(ctx, v2Anchor);
  const v2Client = v2SessionClient(ctx);
  const goalClient = v2Client && typeof v2Client.session.prompt === "function" && typeof v2Client.session.get === "function" ? v2Client : null;
  const sessionHooks = await v2RegisterSessionHooks(ctx, goalClient);
  await v2RegisterCommands(ctx);
  const v2AbortEvents = v2SubscribeEvents(ctx, goalClient, !sessionHooks.idleHook);
  const disposables = [...sessionHooks.disposables, ...v2AbortEvents ? [v2AbortEvents] : [], ...disposeConfigRpc ? [disposeConfigRpc] : []];
  return disposables.length > 0 ? async () => {
    if (goalClient)
      disposeGoalClient(goalClient);
    await Promise.allSettled(disposables.map(async (dispose) => dispose()));
  } : undefined;
}
var plugin_default = { id: "forge", setup: v2Setup };
export {
  v2WiringSeam,
  v2Setup,
  v2SessionClientForTests,
  setCrewNativeChildClockForTests,
  resolveGateAskWatchdogMs,
  resetServiceHttpDiscoveryForTests,
  noteCrewNativeChildEvent,
  isRootish,
  gate,
  forgeFamilyGuard,
  effectiveWorktree,
  plugin_default as default,
  crewOrchestrationTemplate,
  composeCommandPrompt,
  __sessionAnchorTestSurface,
  __runtimeNamespaceTestSurface,
  __permissionDoorsTestSurface,
  SYNC_LEVER_BODY,
  STOP_LEVER_BODY,
  PLAN_COMMAND_TEMPLATE,
  INIT_WORKSPACE_LEAD,
  INIT_GLOBAL_SCAFFOLD_NOTE,
  INIT_GLOBAL_BODY,
  INIT_FLOW_BODY,
  GOAL_COMMAND_TEMPLATE,
  GLOBAL_RECIPE_SCAFFOLD_JSONC,
  FORGE_HELP_ROUTE_LINE,
  FORGE_COMMAND_TEMPLATE,
  FORGE_BOUNDARIES_TEXT,
  CREW_INIT_TEMPLATE
};
