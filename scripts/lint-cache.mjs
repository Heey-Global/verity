import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import ts from 'typescript';

const methods = new Set([
  'readFile',
  'fileExists',
  'directoryExists',
  'getDirectories',
  'readDirectory',
  'realpath',
]);
const maxBytes = 128 * 1024 * 1024;

/** @param {unknown} value */
function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify({ type: typeof value, value }))
    .digest('hex');
}

/** @param {string} path @param {string | Uint8Array} content */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** @typedef {{ method: string, args: unknown[], digest: string }} Observation */

/**
 * Cache only clean results, with the compiler's actual filesystem inputs.
 * Replaying negative lookups and directory listings also catches newly available
 * imports and ambient types; hashing only the linted file would miss these.
 */
export class LocalLintCache {
  /** @type {Map<string, Observation>} */
  observations = new Map();
  /** @type {unknown[]} */
  context = [];
  enabled = true;
  stable = true;

  /** @param {string[]} files @param {string} cwd @param {unknown[]} configs @param {string[]} configFiles */
  constructor(files, cwd, configs, configFiles) {
    this.directory = resolve(cwd, '.cache/lint');
    this.files = files.map((file) => resolve(cwd, file));
    this.path = join(this.directory, `${digest(this.files)}.json.gz`);
    this.context.push(process.version, process.platform, process.arch, ts.version, cwd, configs);
    // A change to discovery or validation must not reuse an older classification.
    const tools = ['lint-files.mjs', 'lint-cache.mjs', 'lint-runner.mjs', 'lint-ambient-cache.mjs'];
    this.toolVersion = digest([
      ts.version,
      ...tools.map((file) => ts.sys.readFile(resolve(import.meta.dirname, file))),
    ]);
    this.context.push(this.toolVersion);
    /** @type {Set<string>} */
    const visited = new Set();
    for (const configFile of configFiles) this.configuration(configFile, visited);
    for (const root of new Set(configFiles.map(dirname))) {
      for (const file of ['package.json', 'package-lock.json']) {
        this.readInput(join(root, file));
      }
    }
  }

  /** @param {string} path */
  readInput(path) {
    const text = ts.sys.readFile(path);
    this.record('readFile', [path], text);
    return text;
  }

  /** @param {string} file @param {Set<string>} visited */
  configuration(file, visited) {
    if (visited.has(file)) return;
    visited.add(file);
    const text = this.readInput(file);
    if (text === undefined) {
      this.enabled = false;
      return;
    }
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (imported.fileName.startsWith('node:')) continue;
      if (imported.fileName.startsWith('.')) {
        this.configuration(resolve(dirname(file), imported.fileName), visited);
      } else {
        try {
          const dependency = createRequire(file).resolve(imported.fileName);
          // Installed tools are pinned by the lockfile; workspace rule code is an input too.
          if (!dependency.replaceAll('\\', '/').includes('/node_modules/')) {
            this.configuration(dependency, visited);
          }
        } catch {
          this.enabled = false;
        }
      }
    }
  }

  /** @param {string} method @param {unknown[]} args @param {unknown} value */
  record(method, args, value) {
    const encoded = args.map((arg) => (arg === undefined ? { $undefined: true } : arg));
    const key = JSON.stringify([method, encoded]);
    const observation = { method, args: encoded, digest: digest(value) };
    const previous = this.observations.get(key);
    if (previous && previous.digest !== observation.digest) this.stable = false;
    this.observations.set(key, observation);
    return value;
  }

  /** @template {object} T @param {T} system @returns {T} */
  observe(system) {
    const observed = system;
    const dictionary = /** @type {Record<string, unknown>} */ ({ ...system });
    for (const method of methods) {
      const original = dictionary[method];
      if (typeof original !== 'function') continue;
      /** @param {...unknown} args */
      const call = (...args) => {
        const value = /** @type {unknown} */ (Reflect.apply(original, system, args));
        return this.record(method, args, value);
      };
      Object.defineProperty(observed, method, { value: call, writable: true, configurable: true });
    }
    return observed;
  }

  /** @param {string} file @param {() => boolean} classify */
  ambient(file, classify) {
    const hash = digest(ts.sys.readFile(file));
    const ambient = classify();
    if (ambient) this.context.push([file, hash]);
    return ambient;
  }

  /** @param {unknown} input */
  valid(input) {
    if (!input || typeof input !== 'object') return false;
    const item = /** @type {Partial<Observation>} */ (input);
    if (
      !methods.has(item.method ?? '') ||
      !Array.isArray(item.args) ||
      typeof item.digest !== 'string'
    ) {
      return false;
    }
    const args = item.args.map((arg) =>
      arg && typeof arg === 'object' && '$undefined' in arg ? undefined : arg,
    );
    const dictionary = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (ts.sys));
    const method = dictionary[item.method ?? ''];
    if (typeof method !== 'function') return false;
    try {
      return digest(Reflect.apply(method, ts.sys, args)) === item.digest;
    } catch {
      return false;
    }
  }

  hit() {
    if (!this.enabled || !this.stable) return false;
    try {
      if (statSync(this.path).size > 16 * 1024 * 1024) return false;
      /** @type {unknown} */
      const state = JSON.parse(
        gunzipSync(readFileSync(this.path), { maxOutputLength: 16 * 1024 * 1024 }).toString(),
      );
      return Boolean(
        state &&
        typeof state === 'object' &&
        'context' in state &&
        'inputs' in state &&
        state.context === digest(this.context) &&
        Array.isArray(state.inputs) &&
        state.inputs.length > 0 &&
        state.inputs.every((input) => this.valid(input)) &&
        [...this.observations.values()].every((input) => this.valid(input)),
      );
    } catch {
      return false;
    }
  }

  save() {
    if (!this.enabled || !this.stable) return;
    const inputs = [...this.observations.values()];
    if (!inputs.every((input) => this.valid(input))) return;
    try {
      atomicWrite(
        this.path,
        gzipSync(JSON.stringify({ context: digest(this.context), inputs }), { level: 1 }),
      );
      const entries = readdirSync(this.directory)
        .filter((file) => file.endsWith('.json.gz'))
        .map((file) => {
          const path = join(this.directory, file);
          return { path, ...statSync(path) };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      let size = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (size <= maxBytes) break;
        rmSync(entry.path, { force: true });
        size -= entry.size;
      }
    } catch {
      // Cache maintenance is optional; the completed lint result remains authoritative.
    }
  }
}
