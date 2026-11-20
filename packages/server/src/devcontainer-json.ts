// Reading top-level settings out of a devcontainer.json without evaluating it: the
// file is JSONC (comments, trailing commas), and only top-level keys are trusted.

/** Read and decode one JSON string token inside JSONC. Comments are handled by
 * callers; string escape semantics must remain exactly JSON semantics so an
 * unsupported key cannot hide behind `\u` or another escape. */
function readJsonString(raw: string, start: number): { value: string; end: number } {
  let pos = start + 1;
  while (pos < raw.length) {
    if (raw[pos] === '\\') {
      pos += 2;
      continue;
    }
    if (raw[pos] === '"') {
      const end = pos + 1;
      return { value: JSON.parse(raw.slice(start, end)) as string, end };
    }
    pos += 1;
  }
  throw new SyntaxError('unterminated JSON string');
}

/** Advance past JSONC whitespace and comments. Shared by every scanner below so
 * they cannot drift into disagreeing about what a comment is. */
function skipJsonTrivia(raw: string, start: number): number {
  let pos = start;
  while (pos < raw.length) {
    const ch = raw[pos];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      pos += 1;
      continue;
    }
    if (raw.startsWith('//', pos)) {
      const end = raw.indexOf('\n', pos + 2);
      pos = end === -1 ? raw.length : end + 1;
      continue;
    }
    if (raw.startsWith('/*', pos)) {
      const end = raw.indexOf('*/', pos + 2);
      pos = end === -1 ? raw.length : end + 2;
      continue;
    }
    break;
  }
  return pos;
}

export function topLevelStringArray(raw: string, targetKey: string): string[] | undefined {
  let i = 0;
  let objectDepth = 0;
  const skipTrivia = (start: number): number => skipJsonTrivia(raw, start);
  const readString = (start: number): { value: string; end: number } => readJsonString(raw, start);
  const readStringArray = (start: number): string[] | undefined => {
    const values: string[] = [];
    let pos = start + 1;
    while (pos < raw.length) {
      pos = skipTrivia(pos);
      if (raw[pos] === ']') return values;
      if (raw[pos] !== '"') return undefined;
      const item = readString(pos);
      values.push(item.value);
      pos = skipTrivia(item.end);
      if (raw[pos] === ',') {
        pos += 1;
        continue;
      }
      if (raw[pos] === ']') return values;
      return undefined;
    }
    return undefined;
  };
  while (i < raw.length) {
    i = skipTrivia(i);
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const key = readString(i);
    const afterKey = skipTrivia(key.end);
    if (raw[afterKey] !== ':' || objectDepth !== 1 || key.value !== targetKey) {
      i = key.end;
      continue;
    }
    const valueStart = skipTrivia(afterKey + 1);
    if (raw[valueStart] !== '[') return undefined;
    return readStringArray(valueStart);
  }
  return undefined;
}

export function topLevelJsonValue(
  raw: string,
  targetKey: string,
):
  | { kind: 'string'; value: string }
  | { kind: 'array' | 'object' | 'boolean' | 'number' | 'null' }
  | undefined {
  let i = 0;
  let objectDepth = 0;
  const skipTrivia = (start: number): number => skipJsonTrivia(raw, start);
  const readString = (start: number): { value: string; end: number } => readJsonString(raw, start);
  while (i < raw.length) {
    i = skipTrivia(i);
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const key = readString(i);
    const afterKey = skipTrivia(key.end);
    if (raw[afterKey] !== ':' || objectDepth !== 1 || key.value !== targetKey) {
      i = key.end;
      continue;
    }
    const valueStart = skipTrivia(afterKey + 1);
    if (raw[valueStart] === '"') return { kind: 'string', value: readString(valueStart).value };
    if (raw[valueStart] === '[') return { kind: 'array' };
    if (raw[valueStart] === '{') return { kind: 'object' };
    if (raw.startsWith('true', valueStart) || raw.startsWith('false', valueStart)) {
      return { kind: 'boolean' };
    }
    if (raw.startsWith('null', valueStart)) return { kind: 'null' };
    return { kind: 'number' };
  }
  return undefined;
}

/** Source text of the top-level object at `targetKey`, braces included — or
 * undefined when the key is absent or its value is something other than an
 * object. Feeding the slice back into {@link topLevelJsonValue} reads that
 * object's own members: inside it they are at depth 1 again. The brace scan is
 * string- and comment-aware, so a `{` inside either cannot unbalance the span. */
export function topLevelObjectSource(raw: string, targetKey: string): string | undefined {
  const found = topLevelJsonValue(raw, targetKey);
  if (found === undefined || found.kind !== 'object') return undefined;
  let i = 0;
  let objectDepth = 0;
  while (i < raw.length) {
    i = skipJsonTrivia(raw, i);
    if (i >= raw.length) break;
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const key = readJsonString(raw, i);
    const afterKey = skipJsonTrivia(raw, key.end);
    if (raw[afterKey] !== ':' || objectDepth !== 1 || key.value !== targetKey) {
      i = key.end;
      continue;
    }
    const start = skipJsonTrivia(raw, afterKey + 1);
    let depth = 0;
    let pos = start;
    while (pos < raw.length) {
      pos = skipJsonTrivia(raw, pos);
      if (pos >= raw.length) break;
      const ch = raw[pos];
      if (ch === '"') {
        pos = readJsonString(raw, pos).end;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return raw.slice(start, pos + 1);
      }
      pos += 1;
    }
    return undefined;
  }
  return undefined;
}

export function devcontainerPropertyKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  let i = 0;
  let objectDepth = 0;
  const skipTrivia = (start: number): number => skipJsonTrivia(raw, start);
  const readString = (start: number): { value: string; end: number } => readJsonString(raw, start);
  while (i < raw.length) {
    i = skipTrivia(i);
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const token = readString(i);
    const after = skipTrivia(token.end);
    if (raw[after] === ':' && objectDepth === 1) keys.add(token.value);
    i = token.end;
  }
  return keys;
}
