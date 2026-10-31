#!/usr/bin/env node
// Keeps every gVisor pin in step with the release deploy/gvisor/versions.env names.
//
//   node scripts/gvisor-pins.mjs check   fail unless every pin matches what gVisor published
//   node scripts/gvisor-pins.mjs write   rewrite the pins from what gVisor published
//
// RUNSC_RELEASE is the one value a bump changes (Renovate tracks it, see renovate.json); the
// checksums the hosts verify, the label the Updater reads and the path the Server verifies all
// follow from it. A bump that changed the release alone would ship a release no host can
// install, so every pin is derived here and nowhere by hand. Each checksum is taken from two
// independent places: the release bucket the hosts download from, and the checksum file on the
// GitHub release. The download is hashed as well, and has to agree with both.
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PIN_FILE = 'deploy/gvisor/versions.env';
export const LABEL_FILE = 'deploy/Dockerfile';
export const CONFIG_FILE = 'packages/server/src/gvisor-runtime-config.ts';

const BUCKET = 'https://storage.googleapis.com/gvisor/releases/release';
const GITHUB = 'https://github.com/google/gvisor/releases/download';
const ARCHITECTURES = /** @type {const} */ (['x86_64', 'aarch64']);
const SUM = /^[a-f0-9]{128}$/u;
const RELEASE = /^release-[0-9]{8}\.[0-9]+$/u;

/**
 * @typedef {{ x86_64: string, aarch64: string }} Sums
 * @typedef {{ release: string, sha512: Sums, archiveSha512?: Sums }} Published
 */

/** @param {string} text */
export function readPins(text) {
  /** @type {Record<string, string>} */
  const pins = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (match && !(match[1] in pins)) pins[match[1]] = match[2].replace(/^'(.*)'$/u, '$1');
  }
  return pins;
}

/**
 * The pin file with its checksums replaced; RUNSC_ARCHIVE_* only for an archive release.
 * @param {string} text @param {Published} published
 */
export function renderPins(text, published) {
  const values = {
    RUNSC_RELEASE: published.release,
    RUNSC_SHA512_X86_64: published.sha512.x86_64,
    RUNSC_SHA512_AARCH64: published.sha512.aarch64,
  };
  const lines = text
    .split('\n')
    .filter((line) => !/^RUNSC_ARCHIVE_SHA512_(X86_64|AARCH64)=/u.test(line))
    .map((line) => {
      const key = /^([A-Z0-9_]+)=/u.exec(line)?.[1];
      return key !== undefined && key in values
        ? `${key}=${values[/** @type {keyof typeof values} */ (key)]}`
        : line;
    });
  if (published.archiveSha512 !== undefined) {
    const after = lines.findIndex((line) => line.startsWith('RUNSC_SHA512_AARCH64='));
    if (after === -1) throw new Error(`${PIN_FILE} has no RUNSC_SHA512_AARCH64`);
    lines.splice(
      after + 1,
      0,
      `RUNSC_ARCHIVE_SHA512_X86_64=${published.archiveSha512.x86_64}`,
      `RUNSC_ARCHIVE_SHA512_AARCH64=${published.archiveSha512.aarch64}`,
    );
  }
  return lines.join('\n');
}

/**
 * The host-runtimes label deploy/Dockerfile declares, from the pins and registrations.
 * @param {string} text @param {Published} published @param {Record<string, string>} pins
 */
export function renderLabel(text, published, pins) {
  const label = {
    release: published.release,
    sha512: published.sha512,
    ...(published.archiveSha512 === undefined ? {} : { archiveSha512: published.archiveSha512 }),
    runtimes: {
      runsc: /** @type {unknown} */ (JSON.parse(pins.RUNSC_ARGS ?? 'null')),
      'runsc-project': /** @type {unknown} */ (JSON.parse(pins.RUNSC_PROJECT_ARGS ?? 'null')),
    },
  };
  const line = `LABEL org.verity.host-runtimes="${JSON.stringify(label).replaceAll('"', '\\"')}"`;
  const pattern = /^LABEL org\.verity\.host-runtimes=".*"$/mu;
  if (!pattern.test(text)) throw new Error(`${LABEL_FILE} declares no org.verity.host-runtimes`);
  return text.replace(pattern, () => line);
}

/** @param {string} text @param {string} release */
export function renderConfig(text, release) {
  const pattern = /^export const PINNED_RUNSC_RELEASE = '[^']*';$/mu;
  if (!pattern.test(text)) throw new Error(`${CONFIG_FILE} declares no PINNED_RUNSC_RELEASE`);
  return text.replace(pattern, `export const PINNED_RUNSC_RELEASE = '${release}';`);
}

/** @param {Uint8Array} data */
const sha512 = (data) => createHash('sha512').update(data).digest('hex');

/**
 * The first checksum in a `sha512sum` style file that names `file`, or the only one.
 * @param {string} text @param {string} file
 */
function sumFor(text, file) {
  const entries = text
    .split('\n')
    .map((line) => /^([a-f0-9]{128})\s+\*?(\S+)$/u.exec(line.trim()))
    .filter((match) => match !== null);
  const named = entries.find((match) => match[2] === file || match[2].endsWith(`/${file}`));
  const sum = named?.[1] ?? (entries.length === 1 ? entries[0]?.[1] : undefined);
  if (sum === undefined || !SUM.test(sum)) throw new Error(`no SHA-512 for ${file}`);
  return sum;
}

/**
 * What gVisor published for `release`, verified as described at the top of this file.
 * @param {string} release
 * @param {{ fetch?: typeof fetch, bucket?: string, github?: string }} [options]
 * @returns {Promise<Published>}
 */
export async function resolvePublished(release, options = {}) {
  if (!RELEASE.test(release)) throw new Error(`not a gVisor release name: ${release}`);
  const get = options.fetch ?? fetch;
  const bucket = `${options.bucket ?? BUCKET}/${release.slice('release-'.length)}`;
  const github = `${options.github ?? GITHUB}/${release}`;
  /** @param {string} url */
  const download = async (url) => {
    const response = await get(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const text = async (/** @type {string} */ url) => {
    const body = await download(url);
    return body === undefined ? undefined : Buffer.from(body).toString('utf8');
  };

  /** @type {Partial<Sums>} */ const binary = {};
  /** @type {Partial<Sums>} */ const archive = {};
  let githubSums;
  for (const arch of ARCHITECTURES) {
    const archiveSum = await text(`${bucket}/${arch}/gvisor.tar.bz2.sha512`);
    if (archiveSum !== undefined) {
      const expected = sumFor(archiveSum, 'gvisor.tar.bz2');
      githubSums ??= await text(`${github}/SHA512SUMS`);
      if (githubSums === undefined) throw new Error(`${release} has no SHA512SUMS on GitHub`);
      if (sumFor(githubSums, `gvisor-${arch}.tar.bz2`) !== expected)
        throw new Error(`${release} ${arch}: the bucket and GitHub disagree on the archive`);
      const body = await download(`${bucket}/${arch}/gvisor.tar.bz2`);
      if (body === undefined || sha512(body) !== expected)
        throw new Error(`${release} ${arch}: the archive does not match its published checksum`);
      archive[arch] = expected;
      binary[arch] = runscInArchive(body);
      continue;
    }
    const binarySum = await text(`${bucket}/${arch}/runsc.sha512`);
    if (binarySum === undefined)
      throw new Error(`${release} publishes neither gvisor.tar.bz2 nor runsc for ${arch}`);
    const expected = sumFor(binarySum, 'runsc');
    const body = await download(`${bucket}/${arch}/runsc`);
    if (body === undefined || sha512(body) !== expected)
      throw new Error(`${release} ${arch}: runsc does not match its published checksum`);
    binary[arch] = expected;
  }
  const archived = Object.keys(archive).length;
  if (archived !== 0 && archived !== ARCHITECTURES.length)
    throw new Error(`${release} ships an archive for only some architectures`);
  return {
    release,
    sha512: /** @type {Sums} */ (binary),
    ...(archived === 0 ? {} : { archiveSha512: /** @type {Sums} */ (archive) }),
  };
}

/**
 * SHA-512 of the runsc member, read with the system tar; nothing is executed.
 * @param {Uint8Array} archive
 */
function runscInArchive(archive) {
  const dir = mkdtempSync(join(tmpdir(), 'gvisor-pins-'));
  try {
    const file = join(dir, 'gvisor.tar.bz2');
    writeFileSync(file, archive);
    const result = spawnSync('tar', ['-xjOf', file, 'runsc'], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.status !== 0 || result.stdout.length === 0)
      throw new Error(`the archive has no runsc: ${result.stderr.toString().trim()}`);
    return sha512(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every pinned file as it has to read for `published`.
 * @param {Published} published @param {(path: string) => string} read
 */
export function expectedFiles(published, read) {
  const pinText = read(PIN_FILE);
  const pins = readPins(pinText);
  return {
    [PIN_FILE]: renderPins(pinText, published),
    [LABEL_FILE]: renderLabel(read(LABEL_FILE), published, pins),
    [CONFIG_FILE]: renderConfig(read(CONFIG_FILE), published.release),
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'check' && mode !== 'write') throw new Error('usage: gvisor-pins.mjs check|write');
  const read = (/** @type {string} */ path) => readFileSync(path, 'utf8');
  const release = readPins(read(PIN_FILE)).RUNSC_RELEASE ?? '';
  const files = expectedFiles(await resolvePublished(release), read);
  const stale = Object.entries(files).filter(([path, text]) => read(path) !== text);
  if (mode === 'write') {
    for (const [path, text] of stale) writeFileSync(path, text);
    console.log(
      stale.length === 0
        ? `Every gVisor pin already matches ${release}.`
        : `Updated ${stale.map(([path]) => path).join(', ')} for ${release}.`,
    );
    return;
  }
  if (stale.length !== 0) {
    console.error(
      `These files do not match what gVisor published for ${release}: ` +
        `${stale.map(([path]) => path).join(', ')}. Run \`node scripts/gvisor-pins.mjs write\`.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Every gVisor pin matches what gVisor published for ${release}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
