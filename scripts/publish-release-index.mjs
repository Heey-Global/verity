#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {(args: string[]) => string} Docker */

/** @param {unknown} error */
function manifestAbsent(error) {
  if (!(error instanceof Error) || !('stderr' in error)) return false;
  const stderr = String(error.stderr);
  // Authorization and transport failures must never authorize a tag overwrite.
  return (
    /(?:manifest unknown|manifest_unknown|not found)/iu.test(stderr) &&
    !/(?:unauthorized|forbidden|denied|timeout|connection|no such host)/iu.test(stderr)
  );
}

/** @param {string} value */
function digestValue(value) {
  const digest = value.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new Error('Registry returned an invalid manifest digest');
  return digest;
}

/** @param {string} reference */
function repository(reference) {
  const withoutDigest = reference.split('@')[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/** @param {string[]} args */
function runDocker(args) {
  return execFileSync('docker', ['buildx', 'imagetools', ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @param {{image: string, version: string, sourceSha: string, sources: string[]}} input
 * @param {Docker} docker
 */
export function publishReleaseIndex(input, docker = runDocker) {
  const { image, version, sourceSha, sources } = input;
  if (!image || image.startsWith('-') || /[\s@]/u.test(image))
    throw new Error('Invalid image repository');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error('Invalid release version');
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('Invalid release source SHA');
  const target = `${image}:v${version}`;
  const annotations = {
    'org.opencontainers.image.revision': sourceSha,
    'org.opencontainers.image.version': `v${version}`,
  };
  const readTarget = () => {
    let digest;
    try {
      digest = digestValue(docker(['inspect', '--format', '{{.Manifest.Digest}}', target]));
    } catch (error) {
      if (manifestAbsent(error)) return undefined;
      throw error;
    }
    /** @type {unknown} */
    const raw = JSON.parse(docker(['inspect', '--raw', `${image}@${digest}`]));
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('manifests' in raw) ||
      !Array.isArray(raw.manifests) ||
      raw.manifests.length === 0 ||
      !('annotations' in raw) ||
      typeof raw.annotations !== 'object' ||
      raw.annotations === null
    )
      throw new Error(`Existing ${target} is not an annotated release index`);
    for (const [key, expected] of Object.entries(annotations)) {
      if (!(key in raw.annotations) || Reflect.get(raw.annotations, key) !== expected)
        throw new Error(`Existing ${target} has conflicting ${key}`);
    }
    return digest;
  };
  const existing = readTarget();
  if (existing) return { digest: existing, reused: true };
  if (
    sources.length === 0 ||
    sources.some((source) => !source || source.startsWith('-') || /\s/u.test(source))
  )
    throw new Error('At least one valid source image reference is required');
  const immutableSources = sources.map(
    (source) =>
      `${repository(source)}@${digestValue(docker(['inspect', '--format', '{{.Manifest.Digest}}', source]))}`,
  );
  // Another serialized workflow may have completed while sources were resolving.
  const appeared = readTarget();
  if (appeared) return { digest: appeared, reused: true };
  docker([
    'create',
    ...Object.entries(annotations).flatMap(([key, value]) => [
      '--annotation',
      `index:${key}=${value}`,
    ]),
    '--tag',
    target,
    ...immutableSources,
  ]);
  const digest = readTarget();
  if (!digest) throw new Error(`Published release index ${target} is missing`);
  return { digest, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = publishReleaseIndex({
      image: process.env.IMAGE ?? '',
      version: process.env.VERSION ?? '',
      sourceSha: process.env.SOURCE_SHA ?? '',
      sources: process.argv.slice(2),
    });
    const output = `digest=${result.digest}\nreused=${String(result.reused)}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(`Could not publish immutable release index: ${String(error)}`);
    process.exitCode = 1;
  }
}
