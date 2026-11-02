import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const maxBytes = 4 * 1024 * 1024;
/** @param {string} text */
function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}
// Fingerprint the classification implementation, including its parsing options.
const version = hash(
  `${ts.version}\n${ts.sys.readFile(import.meta.filename)}\n${ts.sys.readFile(resolve(import.meta.dirname, 'lint-files.mjs'))}`,
);

/** Optional metadata only: a hit never replaces type-aware lint. */
export class AmbientClassificationCache {
  /** @type {Map<string, {digest: string, ambient: boolean}>} */
  entries = new Map();
  dirty = false;
  /** @type {Set<string>} */
  visited = new Set();
  /** @param {string} project @param {string} cwd */
  constructor(project, cwd) {
    this.directory = resolve(cwd, '.cache/lint-ambient');
    this.path = join(this.directory, `${hash(resolve(project))}.json`);
    try {
      const fd = openSync(this.path, 'r');
      let text;
      try {
        const size = fstatSync(fd).size;
        if (size > maxBytes) return;
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const count = readSync(fd, buffer, offset, size - offset, offset);
          if (!count) break;
          offset += count;
        }
        text = buffer.subarray(0, offset).toString('utf8');
      } finally {
        closeSync(fd);
      }
      /** @type {unknown} */
      const state = JSON.parse(text);
      if (
        !state ||
        typeof state !== 'object' ||
        !('version' in state) ||
        state.version !== version ||
        !('files' in state) ||
        !state.files ||
        typeof state.files !== 'object' ||
        Array.isArray(state.files)
      )
        return;
      for (const [file, entry] of Object.entries(
        /** @type {Record<string, unknown>} */ (state.files),
      )) {
        if (
          file === resolve(file) &&
          entry &&
          typeof entry === 'object' &&
          'ambient' in entry &&
          'digest' in entry &&
          typeof entry.ambient === 'boolean' &&
          typeof entry.digest === 'string' &&
          /^[a-f0-9]{64}$/.test(entry.digest)
        )
          this.entries.set(file, { digest: entry.digest, ambient: entry.ambient });
      }
    } catch {
      /* Missing or invalid metadata requires fresh classification. */
    }
  }
  /** @param {string} file @param {string} text @param {() => boolean} classify */
  classify(file, text, classify) {
    const key = resolve(file);
    const digest = hash(text);
    const previous = this.entries.get(key);
    this.visited.add(key);
    if (previous?.digest === digest) return previous.ambient;
    const ambient = classify();
    this.entries.set(key, { digest, ambient });
    this.dirty = true;
    return ambient;
  }

  save() {
    let temporary;
    let locked = false;
    const lock = join(this.directory, '.write-lock');
    try {
      if (!this.dirty && this.visited.size === this.entries.size) return;
      // Only current configured roots survive; removed files cannot accumulate.
      const files = Object.fromEntries(
        [...this.visited].map((file) => [file, this.entries.get(file)]),
      );
      const text = JSON.stringify({ version, files });
      const bytes = Buffer.byteLength(text);
      if (bytes > maxBytes) return;
      mkdirSync(this.directory, { recursive: true });
      // Contending or interrupted writers fall back to fresh classification;
      // serializing maintenance keeps temporary and committed bytes within budget.
      mkdirSync(lock);
      locked = true;
      // An interrupted writer must not leave temporary bytes outside the budget.
      for (const file of readdirSync(this.directory)) {
        if (file.endsWith('.tmp')) rmSync(join(this.directory, file), { force: true });
      }
      const entries = readdirSync(this.directory)
        .filter((file) => file.endsWith('.json'))
        .map((file) => {
          const path = join(this.directory, file);
          return { path, ...statSync(path) };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (total + bytes <= maxBytes) break;
        rmSync(entry.path, { force: true });
        total -= entry.size;
      }
      temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, text);
      renameSync(temporary, this.path);
      this.dirty = false;
    } catch {
      /* Cache maintenance must not suppress lint or turn findings into passes. */
    } finally {
      if (locked) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          /* Optional metadata remains usable. */
        }
      }
      if (temporary) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          /* Optional cleanup. */
        }
      }
    }
  }
}
