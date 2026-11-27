// Targeted JSONC editing (change forge-tui-subagent-config, design D4).
//
// Pure string surgery over RAW recipe bytes: locate one entry's value range
// inside a container object (`agents.<id>` / `override.<id>`), then patch
// EXACTLY the differing fields inside it (design correction 2026-11-27: an
// update never replaces the whole entry — unknown keys and comments INSIDE
// the entry survive; Auto conversion removes only the model/thoughtLevel
// members). Insert/remove operate on whole members (creation/removal). The
// scanner tolerates comments and trailing commas (the same JSONC dialect
// parseForgeJsonc accepts) and tracks byte offsets directly on the raw
// text, so everything around the edited ranges — comments, unknown keys,
// unrelated invalid siblings, non-ASCII content, newline style — survives
// byte-for-byte. The whole parsed object is never re-serialized.
//
// Duplicate keys are legal JSON.parse input (last wins) but make an edit
// target ambiguous: any duplicate container, entry or field key refuses the
// edit (spec: "ambiguous edit target ... blocks writing").

export type JsoncRange = { start: number; end: number }

export type JsoncEditErrReason =
  | "unparseable"
  | "container-missing"
  | "container-not-object"
  | "not-found"
  | "ambiguous"

export type JsoncEditOk<T> = { ok: true } & T
export type JsoncEditErr = { ok: false; reason: JsoncEditErrReason; detail: string }

type Member = { key: string; keyStart: number; valueStart: number; valueEnd: number }

// Whitespace + comment skipper (line and block comments; a line comment's
// terminator stays so byte offsets keep mapping onto the raw text).
function skipWsAndComments(text: string, i: number): number {
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/")) i++
      i = Math.min(i + 2, n)
      continue
    }
    break
  }
  return i
}

// Scan a JSON string body; `i` sits on the opening quote. Returns the index
// AFTER the closing quote, or null when unterminated. Escapes never end the
// string; comment markers inside are ordinary data.
function scanStringEnd(text: string, i: number): number | null {
  i++
  const n = text.length
  while (i < n) {
    if (text[i] === "\\") {
      i += 2
      continue
    }
    if (text[i] === '"') return i + 1
    i++
  }
  return null
}

// Scan a literal (number / true / false / null): until a delimiter or
// whitespace. A `/` always terminates the literal — comments may follow a
// value directly (`1/*c*/,`), and the value range must never swallow them.
function scanLiteralEnd(text: string, i: number): number {
  const n = text.length
  while (i < n && !",{}[]/ \t\r\n".includes(text[i])) i++
  return i
}

function scanValue(text: string, i: number): { ok: true; start: number; end: number } | { ok: false; detail: string } {
  const start = skipWsAndComments(text, i)
  if (start >= text.length) return { ok: false, detail: "unexpected end of document where a value was expected" }
  const c = text[start]
  if (c === '"') {
    const end = scanStringEnd(text, start)
    return end === null ? { ok: false, detail: "unterminated string" } : { ok: true, start, end }
  }
  if (c === "{") return scanObject(text, start)
  if (c === "[") return scanArray(text, start)
  return { ok: true, start, end: scanLiteralEnd(text, start) }
}

// Parse an object's members. Trailing commas tolerated; duplicate keys are
// RECORDED (the caller decides ambiguity). `i` sits on the '{'.
function scanObject(text: string, i: number): { ok: true; start: number; end: number; members: Member[] } | { ok: false; detail: string } {
  const start = i
  const members: Member[] = []
  let j = skipWsAndComments(text, i + 1)
  const n = text.length
  for (;;) {
    if (j >= n) return { ok: false, detail: "unterminated object (missing '}')" }
    if (text[j] === "}") return { ok: true, start, end: j + 1, members }
    if (text[j] !== '"') return { ok: false, detail: `expected a quoted key in object, found ${JSON.stringify(text[j])}` }
    const keyStart = j
    const keyEnd = scanStringEnd(text, j)
    if (keyEnd === null) return { ok: false, detail: "unterminated string (object key)" }
    let key: string
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    } catch {
      return { ok: false, detail: "invalid object key encoding" }
    }
    j = skipWsAndComments(text, keyEnd)
    if (j >= n || text[j] !== ":") return { ok: false, detail: "expected ':' after object key" }
    const value = scanValue(text, j + 1)
    if (!value.ok) return value
    members.push({ key, keyStart, valueStart: value.start, valueEnd: value.end })
    j = skipWsAndComments(text, value.end)
    if (j >= n) return { ok: false, detail: "unterminated object (missing '}')" }
    if (text[j] === ",") {
      j = skipWsAndComments(text, j + 1)
      continue // trailing comma tolerated: the loop re-checks for '}'
    }
    if (text[j] === "}") return { ok: true, start, end: j + 1, members }
    return { ok: false, detail: `expected ',' or '}' in object, found ${JSON.stringify(text[j])}` }
  }
}

// Arrays: only their end position matters (their contents are opaque data).
function scanArray(text: string, i: number): { ok: true; start: number; end: number } | { ok: false; detail: string } {
  const start = i
  let j = skipWsAndComments(text, i + 1)
  const n = text.length
  for (;;) {
    if (j >= n) return { ok: false, detail: "unterminated array (missing ']')" }
    if (text[j] === "]") return { ok: true, start, end: j + 1 }
    const value = scanValue(text, j)
    if (!value.ok) return value
    j = skipWsAndComments(text, value.end)
    if (j >= n) return { ok: false, detail: "unterminated array (missing ']')" }
    if (text[j] === ",") {
      j = skipWsAndComments(text, j + 1)
      continue
    }
    if (text[j] === "]") return { ok: true, start, end: j + 1 }
    return { ok: false, detail: `expected ',' or ']' in array, found ${JSON.stringify(text[j])}` }
  }
}

// Top-level scan: forge.json must be an object; anything after the closing
// brace is a broken document.
export function scanTopLevelKeys(text: string): { ok: true; top: { key: string; value: JsoncRange }[] } | { ok: false; reason: "unparseable"; detail: string } {
  const i = skipWsAndComments(text, 0)
  if (i >= text.length) return { ok: false, reason: "unparseable", detail: "empty document" }
  if (text[i] !== "{") return { ok: false, reason: "unparseable", detail: "top level must be an object" }
  const obj = scanObject(text, i)
  if (!obj.ok) return { ok: false, reason: "unparseable", detail: obj.detail }
  const after = skipWsAndComments(text, obj.end)
  if (after < text.length) return { ok: false, reason: "unparseable", detail: "unexpected content after the top-level object" }
  return { ok: true, top: obj.members.map((m) => ({ key: m.key, value: { start: m.valueStart, end: m.valueEnd } })) }
}

// Locate `container.entryKey` in raw JSONC text. Member = the whole
// `"key": value` member (key quote to value's last char); entry = just the
// value; container = the container object's braces.
export function locateEntry(
  text: string,
  container: string,
  entryKey: string,
): { ok: true; entry: JsoncRange; container: JsoncRange; member: JsoncRange } | JsoncEditErr {
  const top = scanTopLevelKeys(text)
  if (!top.ok) return top
  const containers = top.top.filter((m) => m.key === container)
  if (containers.length === 0) return { ok: false, reason: "container-missing", detail: `no top-level "${container}" object in this document` }
  if (containers.length > 1) return { ok: false, reason: "ambiguous", detail: `top-level "${container}" is defined ${containers.length} times — the edit target is ambiguous` }
  const range = containers[0].value
  if (text[skipWsAndComments(text, range.start)] !== "{") return { ok: false, reason: "container-not-object", detail: `top-level "${container}" is not an object` }
  const obj = scanObject(text, range.start)
  if (!obj.ok) return { ok: false, reason: "unparseable", detail: obj.detail }
  const entries = obj.members.filter((m) => m.key === entryKey)
  if (entries.length === 0) return { ok: false, reason: "not-found", detail: `"${container}" has no entry "${entryKey}"` }
  if (entries.length > 1) return { ok: false, reason: "ambiguous", detail: `"${container}.${entryKey}" is defined ${entries.length} times — the edit target is ambiguous` }
  const m = entries[0]
  return { ok: true, entry: { start: m.valueStart, end: m.valueEnd }, container: { start: range.start, end: range.end }, member: { start: m.keyStart, end: m.valueEnd } }
}

// The member list of an object range (for field-level patching inside an
// entry). Non-object ranges refuse.
export function objectFields(
  text: string,
  range: JsoncRange,
): { ok: true; fields: { key: string; member: JsoncRange; value: JsoncRange }[] } | { ok: false; reason: JsoncEditErrReason; detail: string } {
  if (text[skipWsAndComments(text, range.start)] !== "{") return { ok: false, reason: "container-not-object", detail: "the target is not an object" }
  const obj = scanObject(text, range.start)
  if (!obj.ok) return { ok: false, reason: "unparseable", detail: obj.detail }
  return {
    ok: true,
    fields: obj.members.map((m) => ({ key: m.key, member: { start: m.keyStart, end: m.valueEnd }, value: { start: m.valueStart, end: m.valueEnd } })),
  }
}

// Newline style of the document — the edits keep whatever the file uses.
function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

// Leading whitespace of the line containing `pos`, when that line has only
// whitespace before `pos`; otherwise `fallback`.
function indentFor(text: string, pos: number, fallback = "  "): string {
  let i = pos
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--
  if (i === 0) return fallback
  const prev = text[i - 1]
  if (prev === "\n" || prev === "\r") return text.slice(i, pos) || fallback
  return fallback
}

// The member's line-owned start: when the member begins its line, the
// leading indentation is part of the removal.
function memberLineStart(text: string, member: JsoncRange): { start: number; ownsLine: boolean } {
  let i = member.start
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--
  const ownsLine = i > 0 && (text[i - 1] === "\n" || text[i - 1] === "\r")
  return { start: ownsLine ? i : member.start, ownsLine }
}

// Whole-member removal: the member plus its own indentation/newline when it
// owns a line, plus the adjacent comma (after the member, else the dangling
// one before it). Comments NEVER get carried away: when a comment sits
// between the value and the following comma (`"a": 1 /* note */,`) the
// member and the comma are removed as two spans and the comment survives;
// likewise a comment between a dangling comma and the member blocks the
// comma removal instead of being deleted with it.
function removeMemberSlice(text: string, member: JsoncRange): string {
  const line = memberLineStart(text, member)
  const start = line.start
  // Following comma: skip whitespace AND comments to find it, but keep the
  // skipped bytes (that is where the comments live).
  const j = skipWsAndComments(text, member.end)
  if (j < text.length && text[j] === ",") {
    return `${text.slice(0, start)}${text.slice(member.end, j)}${text.slice(j + 1)}`
  }
  // No following comma: take the member's own trailing newline when it owns
  // the line, plus a dangling comma before it — but only across plain
  // whitespace (a comment in between stays and the comma stays with it).
  let end = member.end
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++
  if (line.ownsLine && text[end] === "\r" && text[end + 1] === "\n") end += 2
  else if (line.ownsLine && text[end] === "\n") end += 1
  let k = start - 1
  while (k >= 0 && (text[k] === " " || text[k] === "\t" || text[k] === "\r" || text[k] === "\n")) k--
  if (k >= 0 && text[k] === ",") return `${text.slice(0, k)}${text.slice(end)}`
  return `${text.slice(0, start)}${text.slice(end)}`
}

// Insert `key: valueJson` as a NEW member of the object at `range`,
// appending after its last existing member; an empty container (possible
// inner content: whitespace/comments only) receives the member directly
// before its closing brace — comments inside survive untouched.
export function insertField(
  text: string,
  range: JsoncRange,
  key: string,
  valueJson: string,
): { ok: true; text: string } | JsoncEditErr {
  if (text[skipWsAndComments(text, range.start)] !== "{") return { ok: false, reason: "container-not-object", detail: "the target is not an object" }
  const obj = scanObject(text, range.start)
  if (!obj.ok) return { ok: false, reason: "unparseable", detail: obj.detail }
  if (obj.members.some((m) => m.key === key)) return { ok: false, reason: "ambiguous", detail: `"${key}" already exists — insert refused` }
  const eol = detectEol(text)
  const keyJson = JSON.stringify(key)
  if (obj.members.length > 0) {
    const indent = indentFor(text, obj.members[0].keyStart)
    const at = obj.members[obj.members.length - 1].valueEnd
    return { ok: true, text: `${text.slice(0, at)},${eol}${indent}${keyJson}: ${valueJson}${text.slice(at)}` }
  }
  // Empty container: insert immediately before the closing brace (a valid
  // document's line comments always end with a newline, so the insertion
  // point can never land inside a comment).
  const close = range.end - 1
  const inner = text.slice(range.start + 1, close)
  if (inner.includes("\n")) {
    const memberIndent = `${indentFor(text, close, "")}  `
    return { ok: true, text: `${text.slice(0, close)}${memberIndent}${keyJson}: ${valueJson}${text.slice(close)}` }
  }
  return { ok: true, text: `${text.slice(0, close)}${keyJson}: ${valueJson}${text.slice(close)}` }
}

// Replace ONLY the value of an existing member (key, position and any
// surrounding comment stay; the new value is the caller's JSON text).
export function replaceFieldValue(
  text: string,
  value: JsoncRange,
  replacementJson: string,
): { ok: true; text: string } {
  return { ok: true, text: `${text.slice(0, value.start)}${replacementJson}${text.slice(value.end)}` }
}

// Remove an existing member (key + value + adjacent comma).
export function removeField(text: string, member: JsoncRange): { ok: true; text: string } {
  return { ok: true, text: removeMemberSlice(text, member) }
}

// Insert `entryKey: entryJson` as a NEW member of the container object,
// appending after the container's last existing member (or inside the empty
// container). `createContainer` adds the whole top-level container when
// absent (creation into a file that has no `agents`/`override` yet).
export function insertEntry(
  text: string,
  containerKey: string,
  entryKey: string,
  entryJson: string,
  opts?: { createContainer?: boolean },
): { ok: true; text: string } | JsoncEditErr {
  const top = scanTopLevelKeys(text)
  if (!top.ok) return top
  const containers = top.top.filter((m) => m.key === containerKey)
  if (containers.length > 1) return { ok: false, reason: "ambiguous", detail: `top-level "${containerKey}" is defined ${containers.length} times — the edit target is ambiguous` }
  if (containers.length === 1) {
    const range = containers[0].value
    if (text[skipWsAndComments(text, range.start)] !== "{") return { ok: false, reason: "container-not-object", detail: `top-level "${containerKey}" is not an object` }
    const obj = scanObject(text, range.start)
    if (!obj.ok) return { ok: false, reason: "unparseable", detail: obj.detail }
    if (obj.members.some((m) => m.key === entryKey)) return { ok: false, reason: "ambiguous", detail: `"${containerKey}.${entryKey}" already exists — create refused` }
    return insertField(text, range, entryKey, entryJson)
  }
  if (opts?.createContainer === false) return { ok: false, reason: "container-missing", detail: `no top-level "${containerKey}" object in this document` }
  // Create the whole container as a new top-level member holding one entry.
  const eol = detectEol(text)
  const containerJson = `{${JSON.stringify(entryKey)}: ${entryJson}}`
  const containerKeyJson = JSON.stringify(containerKey)
  if (top.top.length > 0) {
    const indent = indentFor(text, firstMemberKeyStart(text))
    const at = top.top[top.top.length - 1].value.end
    return { ok: true, text: `${text.slice(0, at)},${eol}${indent}${containerKeyJson}: ${containerJson}${text.slice(at)}` }
  }
  // Empty top-level object (`{}`, whitespace or comments between the
  // braces): insert directly before the closing brace — inner comments
  // survive; a valid document's line comments always end with a newline,
  // so the insertion point can never land inside a comment.
  const obj = scanObject(text, skipWsAndComments(text, 0))
  if (!obj.ok) return { ok: false, reason: "unparseable", detail: obj.detail }
  const close = obj.end - 1
  return { ok: true, text: `${text.slice(0, close)}${containerKeyJson}: ${containerJson}${text.slice(close)}` }
}

// Byte position of the first top-level key's opening quote (for indent
// inheritance when appending a new top-level member).
function firstMemberKeyStart(text: string): number {
  const obj = scanObject(text, skipWsAndComments(text, 0))
  return obj.ok && obj.members.length > 0 ? obj.members[0].keyStart : 0
}

// Remove the whole `container.entryKey` member (key + value + the adjacent
// comma), leaving every other byte untouched.
export function removeEntry(text: string, container: string, entryKey: string): { ok: true; text: string } | JsoncEditErr {
  const loc = locateEntry(text, container, entryKey)
  if (!loc.ok) return loc
  return { ok: true, text: removeMemberSlice(text, loc.member) }
}
