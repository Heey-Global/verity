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
 * @param {{image: string, version: string, sourceSha: string}} input
 * @param {Docker} docker
 */
function releaseIndex(input, docker) {
  const { image, version, sourceSha } = input;
  if (!image || image.startsWith('-') || /[\s@]/u.test(image))
    throw new Error('Invalid image repository');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error('Invalid release version');
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('Invalid release source SHA');
  const annotations = {
    'org.opencontainers.image.revision': sourceSha,
    'org.opencontainers.image.version': `v${version}`,
  };
  /** @param {string} tag */
  const read = (tag) => {
    const reference = `${image}:${tag}`;
    let digest;
    try {
      digest = digestValue(docker(['inspect', '--format', '{{.Manifest.Digest}}', reference]));
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
      throw new Error(`Existing ${reference} is not an annotated release index`);
    for (const [key, expected] of Object.entries(annotations)) {
      if (!(key in raw.annotations) || Reflect.get(raw.annotations, key) !== expected)
        throw new Error(`Existing ${reference} has conflicting ${key}`);
    }
    return digest;
  };
  return { image, annotations, releaseTag: `v${version}`, read };
}

/**
 * Creates the annotated index for a release, or reuses the one already there.
 * With `stageTag` the index is written under that tag instead of `vX.Y.Z`, so
 * a consumer can pin its digest before the release gate allows the version tag
 * to exist; `promoteReleaseIndex` later points `vX.Y.Z` at the same digest.
 *
 * @param {{image: string, version: string, sourceSha: string, sources: string[],
 *   stageTag?: string}} input
 * @param {Docker} docker
 */
export function publishReleaseIndex(input, docker = runDocker) {
  const { image, annotations, releaseTag, read } = releaseIndex(input, docker);
  const { sources, stageTag } = input;
  if (
    stageTag !== undefined &&
    (stageTag === releaseTag || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(stageTag))
  )
    throw new Error('Invalid stage tag');
  // A version tag that already exists wins even when staging: a re-run after
  // the gate must bundle what was published, not a freshly staged twin.
  const released = read(releaseTag);
  if (released) return { digest: released, reused: true };
  const tag = stageTag ?? releaseTag;
  const readTarget = () => (tag === releaseTag ? undefined : read(tag));
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
  const appeared = read(releaseTag) ?? readTarget();
  if (appeared) return { digest: appeared, reused: true };
  docker([
    'create',
    ...Object.entries(annotations).flatMap(([key, value]) => [
      '--annotation',
      `index:${key}=${value}`,
    ]),
    '--tag',
    `${image}:${tag}`,
    ...immutableSources,
  ]);
  const digest = read(tag);
  if (!digest) throw new Error(`Published release index ${image}:${tag} is missing`);
  return { digest, reused: false };
}

/**
 * Points `vX.Y.Z` at an index staged by `publishReleaseIndex`. A single-source
 * `imagetools create` copies the index bytes unchanged, so the digest a Server
 * bundled before the gate is the digest its release tag names; the read-back
 * turns any exception to that into a failed publication rather than a Server
 * pinned to an index no release tag points at.
 *
 * @param {{image: string, version: string, sourceSha: string, digest: string}} input
 * @param {Docker} docker
 */
export function promoteReleaseIndex(input, docker = runDocker) {
  const { image, releaseTag, read } = releaseIndex(input, docker);
  const digest = digestValue(input.digest);
  const existing = read(releaseTag);
  if (existing === digest) return { digest, reused: true };
  if (existing) throw new Error(`Existing ${image}:${releaseTag} is not the staged ${digest}`);
  docker(['create', '--tag', `${image}:${releaseTag}`, `${image}@${digest}`]);
  const promoted = read(releaseTag);
  if (promoted !== digest)
    throw new Error(`Promoted ${image}:${releaseTag} is ${promoted ?? 'missing'}, not ${digest}`);
  return { digest, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = {
      image: process.env.IMAGE ?? '',
      version: process.env.VERSION ?? '',
      sourceSha: process.env.SOURCE_SHA ?? '',
    };
    const result = process.env.PROMOTE_DIGEST
      ? promoteReleaseIndex({ ...release, digest: process.env.PROMOTE_DIGEST })
      : publishReleaseIndex({
          ...release,
          sources: process.argv.slice(2),
          ...(process.env.STAGE_TAG ? { stageTag: process.env.STAGE_TAG } : {}),
        });
    const output = `digest=${result.digest}\nreused=${String(result.reused)}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(`Could not publish immutable release index: ${String(error)}`);
    process.exitCode = 1;
  }
}
