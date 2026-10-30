// Exact-bundle map manifest and local CPU capture conversion. No uploads.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @typedef {{name: string, parent?: string | number}} StackFrame */
/** @typedef {{stackFrames: Record<string, StackFrame>, samples: Array<{pid: number, tid: string | number, ts: string | number, sf: number}>}} HermesProfile */
/** @typedef {{schema: number, identity: {commit: string, mapSha256: string}, hermesProfile: HermesProfile, recording?: unknown, diagnostics?: unknown}} Capture */
/** @param {import('node:crypto').BinaryLike} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** @param {string} mapPath @param {string} commit */
export function stampProfileMap(mapPath, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Full profile commit required');
  const map = readFileSync(mapPath);
  /** @type {unknown} */
  const mapJSON = JSON.parse(map.toString());
  const parsed = /** @type {{version: unknown}} */ (mapJSON);
  if (parsed.version !== 3) throw new Error('Invalid source map');
  writeFileSync(
    join(dirname(mapPath), 'manifest.json'),
    JSON.stringify({ schema: 1, commit, mapSha256: sha256(map) }, null, 2),
  );
}

/** @param {HermesProfile} profile */
export function toSpeedscope(profile) {
  if (!profile.stackFrames || !Array.isArray(profile.samples) || profile.samples.length === 0)
    throw new Error('No usable Hermes CPU samples');
  const entries = Object.entries(profile.stackFrames);
  const indices = new Map(entries.map(([id], index) => [id, index]));
  const frames = entries.map(([, frame]) => ({ name: frame.name }));
  /** @type {Map<string, Array<{ts: number, stack: number[]}>>} */
  const threads = new Map();
  for (const sample of profile.samples) {
    const ts = Number(sample.ts);
    if (!Number.isFinite(ts)) throw new Error('Invalid sample timestamp');
    const stack = [];
    const seen = new Set();
    let id = String(sample.sf);
    while (id !== 'undefined') {
      const index = indices.get(id);
      if (seen.has(id) || index === undefined) throw new Error('Broken or cyclic sample stack');
      seen.add(id);
      stack.push(index);
      id = String(profile.stackFrames[id].parent);
    }
    const key = `${sample.pid}:${sample.tid}`;
    const samples = threads.get(key) ?? [];
    samples.push({ ts, stack: stack.reverse() });
    threads.set(key, samples);
  }
  return {
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    shared: { frames },
    profiles: [...threads].map(([thread, samples]) => {
      samples.sort((a, b) => a.ts - b.ts);
      const weights = samples.map((sample, i) =>
        i + 1 < samples.length ? samples[i + 1].ts - sample.ts : 0,
      );
      return {
        type: 'sampled',
        name: `Hermes ${thread}`,
        unit: 'microseconds',
        startValue: samples[0].ts,
        endValue: samples.at(-1).ts,
        samples: samples.map((sample) => sample.stack),
        weights,
      };
    }),
    activeProfileIndex: 0,
  };
}

/** @param {string} capturePath @param {string} artifacts @param {string} output */
export function extractProfile(capturePath, artifacts, output) {
  if (statSync(capturePath).size > 12 * 1024 * 1024) throw new Error('Capture exceeds 12 MiB');
  /** @type {unknown} */
  const captureJSON = JSON.parse(readFileSync(capturePath, 'utf8'));
  const capture = /** @type {Capture} */ (captureJSON);
  /** @type {unknown} */
  const manifestJSON = JSON.parse(readFileSync(join(artifacts, 'manifest.json'), 'utf8'));
  const manifest = /** @type {{commit: string, mapSha256: string}} */ (manifestJSON);
  const map = readFileSync(join(artifacts, 'main.jsbundle.map'));
  if (
    capture.schema !== 1 ||
    !/^[0-9a-f]{40}$/.test(capture.identity?.commit) ||
    manifest.commit !== capture.identity.commit ||
    manifest.mapSha256 !== capture.identity.mapSha256 ||
    manifest.mapSha256 !== sha256(map)
  )
    throw new Error('Capture and exact-bundle source map do not match');
  // Validate before creating any output, including dangling stack references.
  toSpeedscope(capture.hermesProfile);
  mkdirSync(output, { recursive: true });
  const rawPath = join(output, 'profile.hermesprofile');
  writeFileSync(rawPath, JSON.stringify(capture.hermesProfile));
  // Resolve through Expo's pinned Metro tooling, including its source-map version.
  const metroRequire = createRequire(require.resolve('metro-symbolicate/package.json'));
  /** @type {unknown} */
  const symbolicator = metroRequire('metro-symbolicate/private/Symbolication');
  const { createContext } =
    /** @type {{createContext: (...args: unknown[]) => {symbolicateChromeTrace: (...args: unknown[]) => void}}} */ (
      symbolicator
    );
  /** @type {unknown} */
  const sourceMap = metroRequire('source-map');
  const { SourceMapConsumer } = /** @type {{SourceMapConsumer: unknown}} */ (sourceMap);
  const context = createContext(SourceMapConsumer, map.toString(), { inputColumnStart: 0 });
  context.symbolicateChromeTrace(rawPath, { stdout: process.stdout, stderr: process.stderr });
  /** @type {unknown} */
  const symbolicatedJSON = JSON.parse(readFileSync(rawPath, 'utf8'));
  const symbolicated = /** @type {HermesProfile} */ (symbolicatedJSON);
  writeFileSync(
    join(output, 'profile.speedscope.json'),
    JSON.stringify(toSpeedscope(symbolicated)),
  );
  const { hermesProfile, ...metadata } = capture;
  void hermesProfile;
  writeFileSync(join(output, 'diagnostics.json'), JSON.stringify(metadata, null, 2));
  return symbolicated.samples.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'manifest' && args.length === 2) stampProfileMap(args[0], args[1]);
  else if (mode === 'extract' && args.length === 3) {
    console.log(`Converted ${extractProfile(args[0], args[1], args[2])} samples`);
  } else
    throw new Error(
      'Usage: mobile-cpu-profile.mjs manifest <map> <commit> | extract <capture.json> <artifacts-dir> <output-dir>',
    );
}
