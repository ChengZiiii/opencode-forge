// Local search traversal; all filesystem and permission operations are injected.
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path"
import { matchGlob, strictGlobToRegExp, MAX_WALK_ENTRIES, MAX_FILE_BYTES } from "./search-js.ts"

export type SearchKind = "grep" | "glob"
export interface SearchInput { pattern: string; path?: string; include?: string; literal?: boolean; caseSensitive?: boolean; hidden?: boolean; follow?: boolean; limit?: number }
export interface SearchInvocation { sessionID: string; agent: string; messageID: string; id: string }
export interface SearchMatch { line: number; offset: number; text: string; submatches: { text: string; start: number; end: number }[] }
export interface SearchSeams {
  realpath(path: string): string
  stat(path: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size?: number }
  list(path: string): string[]
  read(path: string): Buffer
  assert(input: unknown): Promise<void>
  grep?(bytes: Buffer, input: SearchInput): SearchMatch[]
  glob?(pattern: string, paths: string[]): boolean[]
  engine?(): string
  globalIgnore?: { home: string; xdg?: string; parseConfig?(bytes: Buffer): string | undefined }
  delegateNative?(): Promise<unknown>
}
const slash = (s: string) => s.split(sep).join("/")
const contains = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep)) }
const git = (p: string) => slash(p).split("/").some(part => part === ".git" || (process.platform === "win32" && part.toLowerCase() === ".git"))
export function ambiguousSearchPath(path: string): boolean {
  // Machine-qualified paths, shell home expansion and Windows device paths are
  // not interpreted locally. Never try to guess the host's machine registry.
  return path.startsWith("~") || /^\\\\[?.]\\/.test(path) || (process.platform === "win32" && /^\/(?:[a-z]:?|cygdrive\/[a-z]|mnt\/[a-z])(?:\/|$)/i.test(path)) || /^[^/\\:]+:/.test(path) && !(process.platform === "win32" && /^[a-z]:[/\\]/i.test(path))
}
// ripgrep looks for a single non-whitespace excludesFile token, independent
// of the INI section. Delegate ambiguous syntax rather than interpreting it
// using Git's different, more permissive config grammar.
export function parseGlobalExcludes(bytes: Buffer): string | undefined {
  for (const line of bytes.toString("utf8").split(String.fromCharCode(10))) {
    const value = line.trim()
    if (/^[#;]/.test(value) || !/excludesfile/i.test(value)) continue
    const match = /^excludesfile\s*=\s*(?:"([^"\s]+)"|([^"\s]+))$/i.exec(value)
    if (!match) throw new Error("Ambiguous global ignore config")
    const path = match[1] ?? match[2]
    if (path.includes("~") && !(path.startsWith("~/") && !path.slice(1).includes("~"))) throw new Error("Ambiguous global ignore tilde expansion")
    return path
  }
  return undefined
}
export function jsGrep(bytes: Buffer, input: SearchInput): SearchMatch[] {
  if (bytes.subarray(0, 8192).includes(0)) return []
  const pattern = input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern
  const regex = new RegExp(pattern, input.caseSensitive === false ? "giu" : "gu")
  const lines = bytes.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? []
  let offset = 0
  const result: SearchMatch[] = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!
    const body = text.replace(/\r?\n$/, "")
    const submatches: SearchMatch["submatches"] = []
    for (const m of body.matchAll(regex)) {
      const start = Buffer.byteLength(body.slice(0, m.index))
      submatches.push({ text: m[0], start, end: start + Buffer.byteLength(m[0]) })
      if (submatches.length === 100) break
    }
    if (submatches.length) result.push({ line: i + 1, offset, text: text.length > 2000 ? text.slice(0, 2000) + "..." : text, submatches })
    if (result.length >= (input.limit ?? 100)) break
    offset += Buffer.byteLength(text)
  }
  return result
}

export async function authorizedSearch(kind: SearchKind, input: SearchInput, invocation: SearchInvocation, directory: string, project: string, seams: SearchSeams) {
  const source = { type: "tool", messageID: invocation.messageID, id: invocation.id }
  const permission = { sessionID: invocation.sessionID, agent: invocation.agent, source }
  if (!invocation.sessionID || !invocation.agent || !invocation.messageID || !invocation.id) throw new Error("Search invocation context unavailable")
  const path = kind === "glob" && (input.path === "undefined" || input.path === "null") ? undefined : input.path
  if (path && ambiguousSearchPath(path)) throw new Error("Search path cannot be resolved in the local environment")
  if ((kind === "grep" && !input.pattern) || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))) throw new Error("Invalid search input")
  if (kind === "glob") strictGlobToRegExp(input.pattern)
  if (input.include) strictGlobToRegExp(input.include)
  const root = resolve(directory, path ?? ".")
  const checked = new Set<string>(), outside = new Set<string>(), skipped = new Set<string>()
  const internal = (p: string) => contains(directory, p) || (project !== parse(project).root && contains(project, p))
  async function authorize(p: string, dir: boolean, report = true) {
    if (internal(p)) return true
    const boundary = dir ? p : dirname(p)
    const resource = slash(join(boundary, "*"))
    if (checked.has(resource)) { if (report) outside.add(p); return true }
    // Persist only the precise requested boundary, never a broader guessed project.
    await seams.assert({ ...permission, action: "external_directory", resources: [resource], save: [resource] })
    checked.add(resource)
    if (report) outside.add(p)
    return true
  }
  // Glob declares directory kind; grep needs metadata to classify the boundary.
  const rootReal = seams.realpath(root)
  const rootDir = seams.stat(rootReal).isDirectory()
  await authorize(root, kind === "glob" || rootDir)
  await seams.assert({ ...permission, action: kind, resources: [input.pattern], save: ["*"], metadata: kind === "grep" ? { root: ".", path, include: input.include, literal: input.literal, caseSensitive: input.caseSensitive, limit: input.limit } : { root: path ?? ".", path, hidden: input.hidden, limit: input.limit } })
  const records: { path: string; real: string; match?: SearchMatch }[] = []
  const limit = input.limit ?? 100
  // Retain the best limit + 1 records, independently of the walk budget.
  // A full heap never stops traversal or alias discovery.
  const recordCap = Math.min(limit + 1, Number.MAX_SAFE_INTEGER)
  const recorded = new Map<string, typeof records[number]>()
  const keyOf = (r: typeof records[number]) => JSON.stringify([r.real, r.match?.line])
  const compare = (a: typeof records[number], b: typeof records[number]) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.match?.line ?? 0) - (b.match?.line ?? 0)
  const positions = new Map<typeof records[number], number>()
  function swap(a: number, b: number) {
    const x = records[a]!, y = records[b]!
    records[a] = y; records[b] = x; positions.set(x, b); positions.set(y, a)
  }
  function down(i: number) {
    while (2 * i + 1 < records.length) {
      let j = 2 * i + 1
      if (j + 1 < records.length && compare(records[j + 1]!, records[j]!) > 0) j++
      if (compare(records[i]!, records[j]!) >= 0) break
      swap(i, j); i = j
    }
  }
  let duplicates = 0, collectionCapped = false
  function record(path: string, real: string, match?: SearchMatch) {
    const value = { path, real, match }, key = keyOf(value)
    const previous = recorded.get(key)
    if (previous) { duplicates++; if (path < previous.path) { previous.path = path; down(positions.get(previous)!) }; return }
    if (records.length >= recordCap) {
      collectionCapped = true
      if (compare(value, records[0]!) >= 0) return
      const removed = records[0]!
      recorded.delete(keyOf(removed)); positions.delete(removed)
      records[0] = value; positions.set(value, 0); recorded.set(key, value); down(0)
      return
    }
    recorded.set(key, value)
    let i = records.length; records.push(value); positions.set(value, i)
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2)
      if (compare(records[parent]!, value) >= 0) break
      swap(i, parent); i = parent
    }
  }
  const ancestors = new Set<string>()
  let visited = 0, capped = false
  const hidden = kind === "grep" || input.hidden !== false
  const follow = input.follow !== false
  const equal = (a: string,b: string) => normalize(a) === normalize(b)
  type IgnoreRule = { global?: boolean; base: string; matcher: RegExp; negate: boolean; directory: boolean }
  function ignored(rules: IgnoreRule[], logical: string, directory: boolean, anyGit: boolean) {
    let excluded = false
    for (const rule of rules) {
      if (rule.global && !anyGit) continue
      const path = slash(relative(rule.base, logical))
      if (rule.directory && !directory) continue
      if (rule.matcher.test(path)) excluded = !rule.negate
    }
    return excluded
  }
  function parseIgnoreRules(bytes: Buffer, logical: string, rules: IgnoreRule[]) {
    for (let line of bytes.toString("utf8").split(/\r?\n/)) {
      line = line.trimEnd()
      if (!line || line.startsWith("#")) continue
      const negate = line.startsWith("!")
      if (negate) line = line.slice(1)
      const directory = line.endsWith("/")
      if (directory) line = line.slice(0, -1)
      const anchored = line.startsWith("/") || line.includes("/")
      if (line.startsWith("/")) line = line.slice(1)
      if (line) {
        try { rules.push({ base: logical, matcher: strictGlobToRegExp(line, anchored), negate, directory }) } catch { /* invalid rule, keep siblings */ }
      }
    }
  }
  function loadIgnoreRules(logical: string, real: string, entries: string[], rules: IgnoreRule[]) {
    if (kind === "grep" && !input.include) {
    for (const ignoreName of [".gitignore", ".ignore", ".rgignore"]) {
      if (!entries.includes(ignoreName)) continue
      const ignorePath = join(real, ignoreName)
      try {
        // Never follow ignore-file links; they are not authorization roots.
        const info = seams.stat(ignorePath)
        if (info.isSymbolicLink() || !info.isFile() || seams.realpath(ignorePath) !== ignorePath || (info.size ?? 0) > MAX_FILE_BYTES) continue
        const bytes = seams.read(ignorePath)
        if (bytes.length > MAX_FILE_BYTES) continue
        parseIgnoreRules(bytes, logical, rules)
      } catch { /* unavailable ignore file */ }
    }
  }
  }
  async function visit(logical: string, candidate: string, explicit = false, rules: IgnoreRule[] = [], globMatch?: boolean, anyGit = false) {
    if (++visited > MAX_WALK_ENTRIES) { capped = true; return }
    if (git(logical) || git(candidate)) return
    const name = relative(root, logical) || relative(dirname(root), logical)
    if (!explicit && !hidden && name.split(sep).some(s => s.startsWith("."))) return
    let real: string, st: ReturnType<SearchSeams["stat"]>
    try {
      const lexical = seams.stat(candidate)
      if (lexical.isSymbolicLink() && !follow && !explicit) return
      real = seams.realpath(candidate)
      if (git(real)) return
      // Determine a link's directory/file classification from metadata only.
      st = seams.stat(real)
    } catch { return }
    // Permission exceptions propagate: a plain user rejection must terminate
    // the step, not be converted into successful tool output.
    try { await authorize(real, st.isDirectory()) } catch (error) {
      // Explicit roots and plain declines retain the native error semantics.
      // A typed permission failure on an implicit link skips that branch.
      if (explicit || !(error instanceof Error) || !(["Tool.Error", "ToolError"].includes(error.name) || (error as { _tag?: string })._tag === "Tool.Error")) throw error
      skipped.add(real); return
    }
    try {
      if (!equal(seams.realpath(candidate), real) || !equal(seams.realpath(real), real)) { skipped.add(logical); return }
    } catch { skipped.add(logical); return }
    if (explicit && kind === "glob" && !st.isDirectory()) throw new Error("Search path is not a directory")
    if (!explicit && ignored(rules, logical, st.isDirectory(), anyGit) && (st.isDirectory() || (kind === "grep" && !input.include))) return
    if (st.isDirectory()) {
      if (ancestors.has(real)) return
      ancestors.add(real)
      try {
        let entries: string[]
        try { entries = seams.list(real).sort() } catch { return }
        anyGit ||= entries.includes(".git")
        const localRules = [...rules]
        loadIgnoreRules(logical, real, entries, localRules)
        const matches = kind === "glob" && seams.glob ? seams.glob(input.pattern, entries.map(entry => slash(relative(root, join(logical, entry))))) : undefined
        for (let i = 0; i < entries.length; i++) {
          if (capped) break
          const entry = entries[i]!
          await visit(join(logical, entry), join(real, entry), false, localRules, matches?.[i], anyGit)
        }
      } finally { ancestors.delete(real) }
    } else if (st.isFile()) {
      if (kind === "glob") {
        if (globMatch ?? matchGlob(input.pattern, slash(name))) record(logical, real)
      } else if (!input.include || matchGlob(input.include, slash(name))) {
        if (typeof st.size === "number" && st.size > MAX_FILE_BYTES) { skipped.add(logical); return }
        let bytes: Buffer
        try { bytes = seams.read(real) } catch { return }
        if (bytes.length > MAX_FILE_BYTES) { skipped.add(logical); return }
        for (const match of (seams.grep ?? jsGrep)(bytes, { ...input, limit: recordCap + 1 })) {
          record(logical, real, match)
        }
      }
    }
  }
  if (kind === "glob" && !rootDir) throw new Error("Search path is not a directory")
  const inherited: IgnoreRule[] = []
  let anyGit = false
  if (kind === "grep" && !input.include) {
    // Discover global ignore sources from the local environment; all bytes,
    // including config bytes, are read only after host authorization.
    if (seams.globalIgnore) {
      const source = seams.globalIgnore
      const cwd = rootDir ? root : dirname(root)
      // Metadata only: rg requires a .git marker in the current or ancestor
      // directory before applying global excludes. Nested repositories acquire
      // that flag as their authorized directories are listed.
      for (let p = cwd;; p = dirname(p)) {
        try { const marker = seams.stat(join(p, ".git")); if (marker.isFile() || marker.isDirectory() || marker.isSymbolicLink()) { anyGit = true; break } } catch { /* no marker */ }
        if (p === dirname(p)) break
      }
      async function readOptional(path: string): Promise<Buffer | undefined> {
        try { seams.stat(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
        await authorize(path, false, false)
        const real = seams.realpath(path)
        await authorize(real, false, false)
        const st = seams.stat(real)
        if (!st.isFile() || (st.size ?? 0) > MAX_FILE_BYTES || !equal(seams.realpath(path), real)) throw new Error("Global ignore source unavailable")
        const bytes = seams.read(real)
        if (bytes.length > MAX_FILE_BYTES || !equal(seams.realpath(path), real)) throw new Error("Global ignore source changed")
        return bytes
      }
      try {
        if (!isAbsolute(source.home) || (source.xdg && !isAbsolute(source.xdg))) throw new Error("Unknown global ignore environment")
        const configDir = source.xdg || join(source.home, ".config")
        let excludes: string | undefined
        for (const config of [join(source.home, ".gitconfig"), join(configDir, "git", "config")]) {
          const bytes = await readOptional(config)
          if (bytes !== undefined) excludes = (source.parseConfig ?? parseGlobalExcludes)(bytes)
          if (excludes !== undefined) break
        }
        const file = excludes === undefined ? join(configDir, "git", "ignore") : excludes.startsWith("~/") ? resolve(source.home, excludes.slice(2)) : resolve(cwd, excludes)
        if (excludes !== undefined && (!excludes || ambiguousSearchPath(excludes) && !excludes.startsWith("~/"))) throw new Error("Unknown global ignore path")
        const bytes = await readOptional(file)
        if (bytes !== undefined) { parseIgnoreRules(bytes, cwd, inherited); for (const rule of inherited) rule.global = true }
      } catch (error) {
        if (seams.delegateNative) return seams.delegateNative()
        throw error
      }
    }
    // Explicit subdirectory searches inherit authorized workspace ancestors.
    const parents: string[] = []
    for (let p = dirname(root); p !== dirname(p) && internal(p); p = dirname(p)) parents.unshift(p)
    for (const p of parents) {
      try {
        if (seams.realpath(p) !== p) continue
        loadIgnoreRules(p, p, seams.list(p), inherited)
      } catch { /* unavailable ancestor */ }
    }
  }
  await visit(root, root, true, inherited, undefined, anyGit)
  records.sort(compare)
  const shown = records.slice(0, limit), truncated = records.length > shown.length || capped || collectionCapped
  const outputRoot = path !== undefined && rootDir ? root : directory
  const displayPath = (p: string) => path !== undefined && rootDir ? relative(root, p) : p
  const output = shown.map(r => { const entry = { path: relative(outputRoot, r.path), type: "file" }; return r.match ? { entry, ...r.match } : entry })
  const lines = kind === "grep" ? [shown.length ? `Found ${shown.length} matches` : "No matches found"] : shown.length ? [] : ["No files found"]
  let current = ""
  for (const r of shown) {
    if (!r.match) lines.push(displayPath(r.path))
    else { if (current !== r.path) { if (current) lines.push(""); lines.push(displayPath(r.path) + ":"); current = r.path }; lines.push(`  Line ${r.match.line}: ${r.match.text}`) }
  }
  if (truncated) lines.push("", `(Results are truncated: showing first ${shown.length} results. Consider using a more specific path or pattern.)`)
  for (const p of outside) lines.push(`outside-workspace target searched: ${p}`)
  for (const p of skipped) lines.push(`skipped target: ${p}`)
  if (duplicates) lines.push(`+${duplicates} duplicate paths merged`)
  lines.push(`(forge search: ${seams.engine?.() ?? ((kind === "grep" ? seams.grep : seams.glob) ? "ripgrep" : "builtin-js")})`)
  return { output, content: lines.join("\n"), metadata: { [kind === "grep" ? "matches" : "count"]: shown.length, truncated } }
}
