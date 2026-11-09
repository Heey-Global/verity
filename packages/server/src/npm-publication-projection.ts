import type { IncomingMessage } from 'node:http';

// Full packuments of long-lived packages can exceed 32 MiB. Keep a finite transfer
// budget while the streaming parser bounds retained strings and nesting separately.
export const MAX_NPM_PUBLICATION_BYTES = 128 * 1024 ** 2;

interface Frame {
  kind: 'object' | 'array';
  role: 'root' | 'versions' | 'entry' | 'dist' | 'time' | 'other';
  state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd';
  key: string | undefined;
  version: string | undefined;
  dist: { tarball?: string; integrity?: string };
  keys: Set<string>;
}
export interface ProjectedNpmArtifact {
  version: string;
  dist: { tarball?: string; integrity?: string };
}

/** Validate the complete JSON stream while retaining only requested publication facts.
 * Registry descriptions and manifests can be many MiB; even a single ignored string
 * must not become a buffered JSON token or a full in-memory packument.
 */
export async function projectNpmPublications(
  response: IncomingMessage,
  name: string,
  requested: ReadonlySet<string>,
  signal: AbortSignal,
  selectArtifact?: (artifact: ProjectedNpmArtifact) => boolean,
): Promise<{
  versions: ReadonlySet<string>;
  times: ReadonlyMap<string, unknown>;
  artifact?: ProjectedNpmArtifact;
}> {
  const limit = MAX_NPM_PUBLICATION_BYTES;
  const encoding = response.headers['content-encoding'];
  const length = response.headers['content-length'];
  function fail(): never {
    throw new Error('Invalid or oversized npm publication metadata.');
  }
  if (
    (encoding !== undefined && encoding !== 'identity') ||
    (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > limit))
  ) {
    response.destroy();
    fail();
  }
  const versions = new Set<string>();
  const times = new Map<string, unknown>();
  const rootKeys = new Set<string>();
  const versionKeys = new Set<string>();
  const timeKeys = new Set<string>();
  const frames: Frame[] = [];
  let rootStarted = false;
  let rootDone = false;
  let actualName: string | undefined;
  let artifact: ProjectedNpmArtifact | undefined;
  const wantedTime = (version: string): boolean =>
    requested.has(version) || artifact?.version === version;
  let mode: 'normal' | 'string' | 'primitive' = 'normal';
  let text = '';
  let retain = false;
  let isKey = false;
  let escaped = false;
  let unicode = 0;
  const current = (): Frame | undefined => frames[frames.length - 1];
  const value = (
    kind: 'object' | 'array' | 'string' | 'primitive',
    scalar?: string,
  ): Frame['role'] => {
    const parent = current();
    if (!parent) {
      if (rootStarted || kind !== 'object') fail();
      rootStarted = true;
      return 'root';
    }
    if (parent.state !== 'value' && !(parent.kind === 'array' && parent.state === 'valueOrEnd'))
      fail();
    parent.state = 'commaOrEnd';
    if (parent.role === 'root' && parent.key === 'name')
      actualName = kind === 'string' ? scalar : undefined;
    if (parent.role === 'versions' && parent.key && requested.has(parent.key) && kind === 'object')
      versions.add(parent.key);
    if (parent.role === 'time' && parent.key && wantedTime(parent.key))
      times.set(parent.key, kind === 'string' ? scalar : undefined);
    if (
      parent.role === 'dist' &&
      (parent.key === 'tarball' || parent.key === 'integrity') &&
      kind === 'string' &&
      scalar !== undefined
    )
      parent.dist[parent.key] = scalar;
    if (selectArtifact && parent.role === 'versions' && kind === 'object') return 'entry';
    if (selectArtifact && parent.role === 'entry' && parent.key === 'dist' && kind === 'object')
      return 'dist';
    return parent.role === 'root' &&
      kind === 'object' &&
      (parent.key === 'versions' || parent.key === 'time')
      ? parent.key
      : 'other';
  };
  const finishString = (): void => {
    const scalar = retain ? (JSON.parse(text) as string) : undefined;
    if (!isKey) {
      value('string', scalar);
      return;
    }
    const parent = current();
    if (!parent || parent.kind !== 'object' || !['key', 'keyOrEnd'].includes(parent.state)) fail();
    parent.key = scalar;
    parent.state = 'colon';
    if (scalar === undefined) return;
    const keys =
      parent.role === 'root' && ['name', 'versions', 'time'].includes(scalar)
        ? rootKeys
        : parent.role === 'versions' && requested.has(scalar)
          ? versionKeys
          : parent.role === 'time' && wantedTime(scalar)
            ? timeKeys
            : (parent.role === 'entry' && scalar === 'dist') ||
                (parent.role === 'dist' && ['integrity', 'tarball'].includes(scalar))
              ? parent.keys
              : undefined;
    if (keys?.has(scalar)) fail();
    keys?.add(scalar);
    // JSON's last duplicate version wins; never retain an earlier matching artifact.
    if (parent.role === 'versions' && artifact?.version === scalar) artifact = undefined;
  };
  const finishPrimitive = (): void => {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(text)) fail();
    value('primitive');
    mode = 'normal';
  };
  const feed = (input: string): void => {
    for (const char of input) {
      if (signal.aborted) fail();
      if (mode === 'string') {
        if (retain) {
          text += char;
          if (text.length > 512) {
            text = '';
            retain = false;
          }
        }
        if (unicode > 0) {
          if (!/[\da-f]/iu.test(char)) fail();
          unicode--;
        } else if (escaped) {
          if (char === 'u') unicode = 4;
          else if (!'"\\/bfnrt'.includes(char)) fail();
          escaped = false;
        } else if (char === '\\') escaped = true;
        else if (char === '"') {
          finishString();
          mode = 'normal';
        } else if (char.charCodeAt(0) < 32) fail();
        continue;
      }
      if (mode === 'primitive') {
        if (!/[\s,}\]]/u.test(char)) {
          text += char;
          if (text.length > 512) fail();
          continue;
        }
        finishPrimitive();
      }
      if (/^[ \t\r\n]$/u.test(char)) continue;
      if (rootDone) fail();
      const parent = current();
      if (char === '"') {
        isKey = parent?.kind === 'object' && ['key', 'keyOrEnd'].includes(parent.state);
        retain = isKey
          ? parent !== undefined && parent.role !== 'other'
          : (parent?.role === 'root' && parent.key === 'name') ||
            (parent?.role === 'time' && parent.key !== undefined && requested.has(parent.key));
        if (!isKey && parent?.role === 'time' && parent.key && wantedTime(parent.key))
          retain = true;
        if (
          !isKey &&
          parent?.role === 'dist' &&
          (parent.key === 'tarball' || parent.key === 'integrity')
        )
          retain = true;
        text = retain ? '"' : '';
        escaped = false;
        unicode = 0;
        mode = 'string';
      } else if (char === '{' || char === '[') {
        const version = parent?.role === 'versions' ? parent.key : parent?.version;
        const role = value(char === '{' ? 'object' : 'array');
        if (frames.length >= 64) fail();
        frames.push({
          kind: char === '{' ? 'object' : 'array',
          role,
          state: char === '{' ? 'keyOrEnd' : 'valueOrEnd',
          key: undefined,
          version,
          dist: {},
          keys: new Set(),
        });
      } else if (char === '}' || char === ']') {
        if (
          !parent ||
          parent.kind !== (char === '}' ? 'object' : 'array') ||
          !(
            parent.state === 'commaOrEnd' ||
            parent.state === (parent.kind === 'object' ? 'keyOrEnd' : 'valueOrEnd')
          )
        )
          fail();
        if (parent.role === 'dist' && parent.version && selectArtifact) {
          const candidate = { version: parent.version, dist: parent.dist };
          if (selectArtifact(candidate)) artifact = candidate;
        }
        frames.pop();
        if (frames.length === 0) rootDone = true;
      } else if (char === ':') {
        if (!parent || parent.state !== 'colon') fail();
        parent.state = 'value';
      } else if (char === ',') {
        if (!parent || parent.state !== 'commaOrEnd') fail();
        parent.state = parent.kind === 'object' ? 'key' : 'value';
      } else {
        if (!/[-\dtfn]/u.test(char)) fail();
        text = char;
        mode = 'primitive';
      }
    }
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  try {
    for await (const raw of response) {
      const chunk = Buffer.from(raw as Uint8Array);
      bytes += chunk.length;
      if (bytes > limit || signal.aborted) fail();
      for (let offset = 0; offset < chunk.length; offset += 65_536)
        feed(decoder.decode(chunk.subarray(offset, offset + 65_536), { stream: true }));
    }
    feed(decoder.decode());
    if (mode !== 'normal' || !rootDone || actualName !== name || signal.aborted) fail();
    return { versions, times, ...(artifact ? { artifact } : {}) };
  } finally {
    response.destroy();
  }
}
