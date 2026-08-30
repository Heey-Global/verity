/** ADR 0006 D1 — trusted, host-side image boundary attestation. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
// A maximum-size payload is wrapped in a 512-byte header and padded to the next
// tar block. The transport ceiling must include that framing overhead.
const MAX_ARCHIVE_TRANSPORT_BYTES = MAX_ARCHIVE_BYTES + 1024;

class EvidenceError extends Error {
  constructor(readonly safeReason: string) {
    super(safeReason);
  }
}

/** The reserved identities the boundary is built on: the uid the Runner
 *  supervisor runs as, and the gid that owns its runtime. Defined here rather
 *  than with the provisioner because they are not merely how a container is
 *  started — {@link evaluateRunnerBoundaryEvidence} refuses an image that
 *  assigns them to anyone else, so they are part of what a verdict means. */
export const RUNNER_RUNTIME_UID = 1101;
export const RUNNER_RUNTIME_GID = 1101;

export const RUNNER_BOUNDARY_BINARIES = [
  '/usr/local/bin/verity-runner-supervisor',
  '/usr/local/bin/verity-runner-supervisor-start',
  '/usr/local/bin/verity-runner-worker',
  '/usr/local/bin/verity-runner-stack-start',
  '/usr/local/bin/verity-agent-spawn-broker',
] as const;

// Prebuilt in trusted release CI for both supported architectures. Content is
// verified here as well as by the Feature installer.
export const RUNNER_BOUNDARY_PROTECTED_FILES = ['/usr/local/bin/verity-script-sandbox'] as const;

export type RunnerBoundaryAttestation =
  /** Verified — and against WHICH trust root. The identity travels with the
   *  verdict so a caller recording it can never attribute the pass to a
   *  different toolkit than the one that produced it. */
  | { readonly ok: true; readonly toolkitIdentity: string }
  | { readonly ok: false; readonly reason: string };

export interface ImageFileEvidence {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly content?: Buffer | undefined;
  readonly linkTarget?: string | undefined;
}

export interface RunnerBoundaryEvidence {
  readonly configuredUser: string;
  readonly files: ReadonlyMap<string, ImageFileEvidence>;
}

export type ImageEvidenceCollector = (args: {
  imageRef: string;
  dockerHost: string;
  timeoutMs?: number | undefined;
}) => Promise<RunnerBoundaryEvidence>;

function octal(header: Buffer, start: number, length: number): number {
  const raw = header
    .subarray(start, start + length)
    .toString('ascii')
    .replaceAll('\0', '')
    .trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

/** Parse the single-entry POSIX tar produced by `docker cp CONTAINER:path -`.
 * Docker (trusted daemon code) supplies metadata and bytes without starting the image. */
export function parseDockerArchive(path: string, archive: Buffer): ImageFileEvidence {
  if (archive.length < 512) throw new Error('archive has no header');
  const header = archive.subarray(0, 512);
  const entryName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '');
  // Docker names a directory entry with the trailing slash tar uses for one, and
  // the container root as "/". Neither is a nested path, so strip that single
  // slash before the traversal check. Without this every directory in
  // EVIDENCE_PATHS — `/`, `/usr`, `/usr/local`, `/usr/local/bin` — is rejected as
  // unsafe, the attestation can never pass, and every project with its own
  // devcontainer silently loses the runner supervisor and all native tools.
  const name = entryName === '/' ? '' : entryName.replace(/\/$/u, '');
  if (entryName.length === 0 || name.includes('..') || name.includes('/')) {
    throw new Error('archive contains an unsafe path');
  }
  const mode = octal(header, 100, 8);
  const uid = octal(header, 108, 8);
  const gid = octal(header, 116, 8);
  const size = octal(header, 124, 12);
  if (![mode, uid, gid, size].every(Number.isSafeInteger) || size > MAX_ARCHIVE_BYTES) {
    throw new Error('archive metadata is invalid');
  }
  const typeFlag = String.fromCharCode(header[156] ?? 0);
  const type =
    typeFlag === '0' || typeFlag === '\0'
      ? 'file'
      : typeFlag === '5'
        ? 'directory'
        : typeFlag === '2'
          ? 'symlink'
          : 'other';
  if (archive.length < 512 + size) throw new Error('archive content is truncated');
  const linkTarget = header.subarray(157, 257).toString('utf8').replace(/\0.*$/su, '');
  return {
    path,
    type,
    uid,
    gid,
    mode,
    ...(type === 'file' ? { content: archive.subarray(512, 512 + size) } : {}),
    ...(type === 'symlink' ? { linkTarget } : {}),
  };
}

const EVIDENCE_PATHS = [
  '/etc/passwd',
  '/etc/group',
  '/',
  '/usr',
  '/usr/local',
  '/usr/local/bin',
  ...RUNNER_BOUNDARY_BINARIES,
  ...RUNNER_BOUNDARY_PROTECTED_FILES,
] as const;

/** Read only the first archive entry (plus file bytes) directly from Docker.
 * For directories the response is destroyed after its 512-byte metadata header,
 * avoiding a recursive copy of `/` or `/usr`. */
async function readDockerPath(
  dockerHost: string,
  containerId: string,
  path: string,
  timeoutMs: number,
): Promise<ImageFileEvidence> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: ImageFileEvidence): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolve(value);
    };
    const endpoint = `/containers/${containerId}/archive?path=${encodeURIComponent(path)}`;
    let requestOptions: http.RequestOptions;
    if (dockerHost.startsWith('unix://')) {
      requestOptions = {
        socketPath: dockerHost.slice('unix://'.length),
        path: endpoint,
        method: 'GET',
      };
    } else {
      // Docker uses tcp:// in DOCKER_HOST, while node:http accepts only http(s)
      // URL schemes. The daemon endpoint itself is plain HTTP on that socket.
      const httpDockerHost = dockerHost.startsWith('tcp://')
        ? `http://${dockerHost.slice('tcp://'.length)}`
        : dockerHost;
      const url = new URL(endpoint, httpDockerHost);
      requestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
      };
    }
    const request = http.request(requestOptions, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`Docker archive returned ${String(response.statusCode)}`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        chunks.push(chunk);
        length += chunk.length;
        if (length > MAX_ARCHIVE_TRANSPORT_BYTES) {
          response.destroy();
          finish(new Error('Docker archive exceeded the evidence limit'));
          return;
        }
        if (length < 512) return;
        const archive = Buffer.concat(chunks, length);
        try {
          const partial = parseDockerArchive(path, archive);
          if (partial.type !== 'file' || partial.content?.length === octal(archive, 124, 12)) {
            response.destroy();
            finish(undefined, partial);
          }
        } catch (error) {
          // A regular file may have its header before all content has arrived.
          if (!(error instanceof Error) || !error.message.includes('truncated')) {
            response.destroy();
            finish(error instanceof Error ? error : new Error('invalid Docker archive'));
          }
        }
      });
      response.on('end', () => {
        if (settled) return;
        try {
          finish(undefined, parseDockerArchive(path, Buffer.concat(chunks, length)));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('invalid Docker archive'));
        }
      });
      response.on('error', (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Docker archive timed out')));
    request.on('error', (error) => finish(error));
    request.end();
  });
}

export const defaultImageEvidenceCollector: ImageEvidenceCollector = async ({
  imageRef,
  dockerHost,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const env = { ...process.env, DOCKER_HOST: dockerHost };
  const options = { env, timeout: timeoutMs, maxBuffer: MAX_ARCHIVE_BYTES };
  const created = await execFileAsync(
    'docker',
    ['create', '--entrypoint', '/bin/false', imageRef],
    options,
  ).catch(() => {
    throw new EvidenceError(
      'a stopped filesystem snapshot could not be created from the sandbox image',
    );
  });
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error('docker returned no container id');
  try {
    // Inspect the stopped container, not the mutable image tag, so identity and
    // filesystem evidence necessarily refer to the same resolved image object.
    const inspect = await execFileAsync(
      'docker',
      ['container', 'inspect', '--format', '{{json .Config.User}}', containerId],
      options,
    ).catch(() => {
      throw new EvidenceError('the sandbox image configuration could not be inspected');
    });
    const configuredUser = JSON.parse(inspect.stdout.trim()) as unknown;
    if (typeof configuredUser !== 'string') throw new Error('image user is not a string');
    const files = new Map<string, ImageFileEvidence>();
    for (const path of EVIDENCE_PATHS) {
      try {
        files.set(path, await readDockerPath(dockerHost, containerId, path, timeoutMs));
      } catch {
        throw new EvidenceError(`${path} could not be read safely from the sandbox image`);
      }
    }
    return { configuredUser, files };
  } finally {
    await execFileAsync('docker', ['rm', '-f', containerId], options).catch(() => undefined);
  }
};

interface Account {
  name: string;
  uid: number;
  gid: number;
}

function parsePasswd(content: string): Account[] | undefined {
  const result: Account[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    const fields = line.split(':');
    const rawUid = fields[2] ?? '';
    const rawGid = fields[3] ?? '';
    const uid = Number(rawUid);
    const gid = Number(rawGid);
    if (
      fields.length !== 7 ||
      fields[0] === undefined ||
      fields[0].length === 0 ||
      !/^\d+$/u.test(rawUid) ||
      !/^\d+$/u.test(rawGid) ||
      !Number.isSafeInteger(uid) ||
      !Number.isSafeInteger(gid)
    )
      return undefined;
    result.push({ name: fields[0], uid, gid });
  }
  return result;
}

interface Group {
  name: string;
  gid: number;
  members: string[];
}

function parseGroup(content: string): Group[] | undefined {
  const result: Group[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    const fields = line.split(':');
    const rawGid = fields[2] ?? '';
    const gid = Number(rawGid);
    if (
      fields.length !== 4 ||
      fields[0] === undefined ||
      fields[0].length === 0 ||
      !/^\d+$/u.test(rawGid) ||
      !Number.isSafeInteger(gid)
    )
      return undefined;
    result.push({ name: fields[0], gid, members: fields[3]?.split(',').filter(Boolean) ?? [] });
  }
  return result;
}

function unique<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function evaluateRunnerBoundaryEvidence(
  evidence: RunnerBoundaryEvidence,
  args: {
    runnerUid: number;
    runtimeGid: number;
    user?: string | undefined;
    /**
     * Every toolkit build this Server accepts — ADR 0006 D9.
     *
     * Several builds rather than one because D9 takes it as the normal case that
     * a Server of version N meets a Runner from N−1, and requires each release to
     * support the previous Runner. Equality against this Server's own bundle is a
     * lockstep check the system cannot hold: a container outlives Server deploys
     * by design, so the two agree only by coincidence. What the boundary must
     * establish is that the binaries are authentic Verity builds, and a build
     * from a previous release is no less authentic.
     *
     * A build is accepted whole, never binary by binary. Accepting each hash
     * independently would admit a toolkit assembled from several releases — a
     * combination nobody published, nobody tested, and whose halves may not agree
     * about the boundary they jointly enforce.
     */
    trustedToolkits: readonly AcceptedToolkit[];
  },
): RunnerBoundaryAttestation {
  const deny = (reason: string): RunnerBoundaryAttestation => ({ ok: false, reason });
  const passwdFile = evidence.files.get('/etc/passwd');
  const groupFile = evidence.files.get('/etc/group');
  if (passwdFile?.type !== 'file' || passwdFile.content === undefined)
    return deny('/etc/passwd is missing or is not a regular file');
  if (groupFile?.type !== 'file' || groupFile.content === undefined)
    return deny('/etc/group is missing or is not a regular file');
  const passwd = parsePasswd(passwdFile.content.toString('utf8'));
  const groups = parseGroup(groupFile.content.toString('utf8'));
  if (passwd === undefined) return deny('/etc/passwd could not be parsed unambiguously');
  if (groups === undefined) return deny('/etc/group could not be parsed unambiguously');
  const runner = unique(passwd.filter((entry) => entry.uid === args.runnerUid));
  if (
    runner?.name !== 'verity-runner' ||
    passwd.filter((entry) => entry.name === 'verity-runner').length !== 1
  )
    return deny(
      `UID ${String(args.runnerUid)} is missing or not uniquely assigned to verity-runner`,
    );
  const runtime = unique(groups.filter((entry) => entry.gid === args.runtimeGid));
  if (
    runtime?.name !== 'verity-runtime' ||
    groups.filter((entry) => entry.name === 'verity-runtime').length !== 1
  )
    return deny(
      `GID ${String(args.runtimeGid)} is missing or not uniquely assigned to verity-runtime`,
    );
  if (runner.gid !== args.runtimeGid)
    return deny(`verity-runner does not use the reserved runtime GID ${String(args.runtimeGid)}`);

  const requestedUser = args.user?.trim() || evidence.configuredUser.trim() || '0';
  const [userPart, groupPart, extraPart] = requestedUser.split(':');
  if (userPart === undefined || userPart.length === 0 || extraPart !== undefined)
    return deny(`the sandbox agent identity ${requestedUser} is invalid`);
  const numeric = /^\d+$/u.test(userPart) ? Number(userPart) : undefined;
  const agent =
    numeric === undefined
      ? unique(passwd.filter((entry) => entry.name === userPart))
      : unique(passwd.filter((entry) => entry.uid === numeric));
  if (agent === undefined)
    return deny(`the sandbox agent identity ${requestedUser} is missing or ambiguous`);
  if (agent.uid === 0) return deny('the sandbox agent runs as root');
  if (agent.uid === args.runnerUid)
    return deny(`the sandbox agent shares the reserved Runner UID ${String(args.runnerUid)}`);
  const explicitGroup =
    groupPart === undefined || groupPart.length === 0
      ? undefined
      : /^\d+$/u.test(groupPart)
        ? Number(groupPart)
        : unique(groups.filter((entry) => entry.name === groupPart))?.gid;
  if (groupPart !== undefined && explicitGroup === undefined)
    return deny(`the sandbox agent group ${groupPart} is missing or ambiguous`);
  if (
    agent.gid === args.runtimeGid ||
    explicitGroup === args.runtimeGid ||
    runtime.members.includes(agent.name)
  )
    return deny(
      `the sandbox agent is a member of the reserved Runner runtime GID ${String(args.runtimeGid)}`,
    );

  for (const path of ['/', '/usr', '/usr/local', '/usr/local/bin']) {
    const directory = evidence.files.get(path);
    if (directory?.type !== 'directory')
      return deny(`${path} is missing, not a directory, or traverses a symlink`);
    if (directory.uid !== 0) return deny(`${path} is not root-owned`);
    if ((directory.mode & 0o022) !== 0) return deny(`${path} is group- or world-writable`);
  }
  // The hashes this image actually presented, not the ones it was allowed to.
  // `toolkitIdentity` must describe the toolkit that produced the verdict — with a
  // set of accepted hashes, deriving it from the set would name the Server's
  // policy instead of the image, and a recorded identity would no longer identify
  // anything.
  const presented = new Map<string, string>();
  for (const path of RUNNER_BOUNDARY_BINARIES) {
    const file = evidence.files.get(path);
    if (file?.type !== 'file' || file.content === undefined)
      return deny(`${path} is missing, not a regular file, or traverses a symlink`);
    if (file.uid !== 0) return deny(`${path} is not root-owned`);
    if ((file.mode & 0o022) !== 0) return deny(`${path} is group- or world-writable`);
    presented.set(path, sha256(file.content));
  }
  for (const path of RUNNER_BOUNDARY_PROTECTED_FILES) {
    const file = evidence.files.get(path);
    if (file?.type !== 'file' || file.content === undefined)
      return deny(`${path} is missing, not a regular file, or traverses a symlink`);
    if (file.uid !== 0) return deny(`${path} is not root-owned`);
    if ((file.mode & 0o022) !== 0) return deny(`${path} is group- or world-writable`);
    presented.set(path, sha256(file.content));
  }
  const unknown = RUNNER_BOUNDARY_BINARIES.find(
    (path) => !args.trustedToolkits.some((toolkit) => toolkit.hashes.has(path)),
  );
  if (unknown !== undefined) {
    // Not the image's fault: this Server offered no hash to compare against,
    // which is a packaging fault in its own bundle. Saying so keeps an operator
    // from rebuilding the Sandbox to fix the Server.
    return deny(`this Server knows no accepted hash for ${unknown}`);
  }
  const matched = args.trustedToolkits.find((toolkit) =>
    [...RUNNER_BOUNDARY_BINARIES, ...RUNNER_BOUNDARY_PROTECTED_FILES].every(
      (path) => toolkit.hashes.get(path) === presented.get(path),
    ),
  );
  if (matched === undefined) {
    const foreign = RUNNER_BOUNDARY_BINARIES.find(
      (path) =>
        !args.trustedToolkits.some((toolkit) => toolkit.hashes.get(path) === presented.get(path)),
    );
    return deny(
      foreign !== undefined
        ? `${foreign} is not a toolkit build this Server accepts — ` +
            `it matches neither the bundled toolkit nor any supported release`
        : // Every binary is authentic on its own and no single release published
          // this combination. That is not a stale image; it is one assembled from
          // parts, which is worth saying in the words an operator would search for.
          `the boundary binaries come from different toolkit builds — ` +
            `no release this Server accepts published this combination`,
    );
  }
  return {
    ok: true,
    toolkitIdentity: toolkitIdentityOf(presented, {
      runnerUid: args.runnerUid,
      runtimeGid: args.runtimeGid,
    }),
  };
}

/** The bundled toolkit directory whose binaries are the attestation trust root.
 *  Baked into the Server image by `deploy/Dockerfile`; `VERITY_FEATURE_DIR`
 *  overrides it for tests and alternate layouts. */
export function defaultRunnerBoundaryFeatureDir(): string {
  return process.env.VERITY_FEATURE_DIR ?? '/opt/verity-features/verity-sandbox-toolkit';
}

/** One content identity for the whole trust root: sha256 over each boundary
 *  binary's path and its own hash, in {@link RUNNER_BOUNDARY_BINARIES} order.
 *
 *  Deliberately derived from the SAME bytes {@link evaluateRunnerBoundaryEvidence}
 *  compares, and from nothing else — not the Feature's version, not its manifest,
 *  not the rest of the directory. A change that cannot alter an attestation
 *  verdict must not read as drift, and a change that can must never read as
 *  current. That is the whole point of recording it.
 *
 *  Returns `undefined` only when the bundle DIRECTORY is genuinely absent
 *  (dev/test hosts, and any non-Server layout) — "unknown", which callers must
 *  not treat as a match. Anything else throws, and the distinction is the point:
 *  a bundle that exists but is missing a boundary binary, or cannot be read
 *  because of a permission or I/O fault, is a broken deployment. Reporting
 *  either as "ships no toolkit" would describe a packaging or mount failure as
 *  a design choice, and would hide it behind a fleet the Server then declines
 *  to judge. Callers surface it as a check that could not run. */
export async function trustedToolkitIdentity(
  featureDir: string = defaultRunnerBoundaryFeatureDir(),
  ids: { runnerUid: number; runtimeGid: number } = {
    runnerUid: RUNNER_RUNTIME_UID,
    runtimeGid: RUNNER_RUNTIME_GID,
  },
): Promise<string | undefined> {
  try {
    return toolkitIdentityOf(await trustedToolkitHashes(featureDir), ids);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // A missing file only means "no bundle" when there is no bundle. Inside a
    // directory that IS there, the same ENOENT means one binary is missing from
    // a Feature that ships four — which is drift in the packaging itself, and
    // exactly what an operator needs told rather than swallowed.
    if ((code === 'ENOENT' || code === 'ENOTDIR') && (await toolkitBundleIsAbsent(featureDir))) {
      return undefined;
    }
    throw error;
  }
}

/** Resolved identities per bundle directory. The bundle is baked into the Server
 *  image and cannot change under a running process, so one read per directory is
 *  all the truth there is to get. Keyed rather than a single slot because
 *  `VERITY_FEATURE_DIR` is a test override — a suite that points at a second
 *  fixture must not be answered from the first one's read. */
const trustedToolkitIdentityCache = new Map<string, Promise<string | undefined>>();

/**
 * {@link trustedToolkitIdentity}, read once per bundle directory.
 *
 * The drift verdict is now computed on the project list and detail paths, which
 * are request-rate; hashing four binaries off disk on each of them would put a
 * filesystem read behind every project the app renders, to answer a question
 * whose answer cannot change while this process lives.
 *
 * A rejection is deliberately NOT cached. `undefined` is a finding — this Server
 * ships no bundle — and caching it is the point. A throw is a broken deployment
 * (a bundle missing a binary, an unreadable mount), and freezing that into the
 * cache would turn a transient I/O fault into a permanently poisoned answer that
 * only a restart clears, while a genuinely broken bundle re-throws on the next
 * call anyway.
 */
export async function cachedTrustedToolkitIdentity(
  featureDir: string = defaultRunnerBoundaryFeatureDir(),
): Promise<string | undefined> {
  const cached = trustedToolkitIdentityCache.get(featureDir);
  if (cached !== undefined) return cached;
  // Store the promise, not the resolved value, so a burst of concurrent requests
  // on a cold cache shares one read instead of racing several.
  const pending = trustedToolkitIdentity(featureDir);
  trustedToolkitIdentityCache.set(featureDir, pending);
  try {
    return await pending;
  } catch (error) {
    trustedToolkitIdentityCache.delete(featureDir);
    throw error;
  }
}

/** Drop every cached identity. For tests that swap bundle fixtures in place —
 *  the cache key is the directory, so a fixture mutated behind the same path
 *  would otherwise keep answering with the previous contents. */
export function resetTrustedToolkitIdentityCache(): void {
  trustedToolkitIdentityCache.clear();
}

/**
 * Whether there is genuinely nothing at the bundle path.
 *
 * Only a path that does not exist counts. A path that exists as something other
 * than a directory is a misconfigured `VERITY_FEATURE_DIR` or a bad image
 * layout, and a malformed parent component is the same kind of fault — neither
 * is a Server that ships no toolkit, and answering "absent" for them would let
 * a deployment mistake mute the drift report for every project at once.
 */
async function toolkitBundleIsAbsent(featureDir: string): Promise<boolean> {
  let stats;
  try {
    stats = await stat(featureDir);
  } catch (error) {
    // ENOENT alone: the path is not there. ENOTDIR means a component of the path
    // is a file, which is a broken layout rather than an empty host, so it falls
    // through to the caller's throw like any other error.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true;
    throw error;
  }
  if (stats.isDirectory()) return false;
  throw new Error(`runner boundary toolkit bundle path is not a directory: ${featureDir}`);
}

/**
 * Generation of the rules in {@link evaluateRunnerBoundaryEvidence} — the
 * reserved identities, the ownership and permission requirements, the symlink
 * and file-type checks, and which paths are evidence at all.
 *
 * The identity answers "would this image still pass?", and the bytes are only
 * half of that: a stricter evaluator can reject an image whose toolkit never
 * changed. Nothing here derives from the rules automatically, because most of
 * them are code rather than data — so this is a manual obligation.
 *
 * BUMP THIS whenever a change to the evaluator could reject an image it
 * previously accepted. Forgetting to leaves those images reporting as verified
 * until each one fails its next attestation, which is the silence this whole
 * mechanism was written to end.
 */
const BOUNDARY_POLICY_VERSION = 2;

/** The identity of a trust root already in hand. A passing attestation reports
 *  the identity of the exact map it compared against, so the recorded value
 *  cannot describe different bytes from the ones that were verified — not even
 *  if the bundle on disk changed between the check and the write.
 *
 *  Three inputs, and they are the three the verdict turns on FLEET-WIDE: the
 *  boundary binaries, the generation of the rules applied to them, and the
 *  reserved uid/gid those rules require. Move any of them and an image that
 *  passed may not pass again, which is precisely what a recorded identity has
 *  to be able to say. The per-project configured `user` is left out on purpose:
 *  it varies by project, while the identity is compared against ONE current
 *  value for the whole fleet, so folding it in would make every project read as
 *  drifted from a Server that changed nothing. */
function toolkitIdentityOf(
  hashes: ReadonlyMap<string, string>,
  ids: { runnerUid: number; runtimeGid: number },
): string {
  const hash = createHash('sha256');
  hash.update(`policy:${String(BOUNDARY_POLICY_VERSION)}\n`);
  hash.update(`ids:${String(ids.runnerUid)}:${String(ids.runtimeGid)}\n`);
  for (const path of [...RUNNER_BOUNDARY_BINARIES, ...RUNNER_BOUNDARY_PROTECTED_FILES]) {
    hash.update(`${path}:${hashes.get(path) ?? ''}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The ledger file name, beside the bundle it extends. */
const TOOLKIT_LEDGER_FILE = 'published-hashes.json';

/** One toolkit build this Server accepts: all boundary binaries of a single
 *  published artifact, plus a name to say which build matched. */
export interface AcceptedToolkit {
  /** How a refusal or a log line should name this build. */
  readonly label: string;
  readonly hashes: ReadonlyMap<string, string>;
}

/** A version as the ledger may carry it. `prerelease` is kept because `9.0.0-rc.1`
 *  must sort BELOW `9.0.0`: a floor of `9.0.0` that admitted its own pre-releases
 *  would accept exactly the builds it was raised to exclude. */
interface ParsedVersion {
  readonly parts: readonly [number, number, number];
  readonly prerelease: boolean;
}

/** Strict on purpose: a version this function cannot read is a ledger entry whose
 *  position relative to the floor is unknown, and guessing it is how a floor gets
 *  bypassed. `Number.parseInt` would read `9evil.0.0` as 9. */
function parseVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: /-/u.test(value.split('+')[0] ?? ''),
  };
}

/** `a` >= `b`. Pre-release identifiers are not compared against each other — the
 *  ledger carries the versions this repo publishes, which are plain triples — but
 *  a pre-release never reaches the release it precedes. */
function versionAtLeast(a: ParsedVersion, b: ParsedVersion): boolean {
  for (let index = 0; index < 3; index += 1) {
    const l = a.parts[index] ?? 0;
    const r = b.parts[index] ?? 0;
    if (l !== r) return l > r;
  }
  return !a.prerelease || b.prerelease;
}

/**
 * Every toolkit build this Server accepts: its own bundle, plus the published
 * releases the ledger vouches for at or above the floor.
 *
 * A missing, unreadable or malformed ledger is treated as absent, and the result
 * is then this Server's bundle alone — today's behaviour exactly. That is
 * deliberate and the opposite of this module's usual stance on broken packaging:
 * the ledger can only ever WIDEN what is accepted, so ignoring it cannot admit
 * anything it should not. Failing closed on a bad ledger would disable every
 * project in the fleet, which is the outcome this change exists to stop happening
 * for no reason.
 *
 * A ledger without a floor is ignored for the same reason it is refused when
 * present-but-unreadable: the floor is what keeps a set of accepted builds from
 * being a downgrade path, so a ledger that omits it is not a weaker ledger, it is
 * not a ledger.
 */
export async function acceptedToolkits(featureDir: string): Promise<AcceptedToolkit[]> {
  const accepted: AcceptedToolkit[] = [
    { label: 'this Server bundled toolkit', hashes: await trustedToolkitHashes(featureDir) },
  ];
  let ledger: unknown;
  try {
    ledger = JSON.parse(await readFile(`${featureDir}/${TOOLKIT_LEDGER_FILE}`, 'utf8'));
  } catch {
    return accepted;
  }
  if (typeof ledger !== 'object' || ledger === null) return accepted;
  const { minimumVersion, releases } = ledger as {
    minimumVersion?: unknown;
    releases?: unknown;
  };
  const floor = parseVersion(minimumVersion);
  if (floor === undefined || !Array.isArray(releases)) return accepted;
  for (const release of releases as readonly unknown[]) {
    if (typeof release !== 'object' || release === null) continue;
    const { version, architecture, hashes } = release as {
      version?: unknown;
      architecture?: unknown;
      hashes?: unknown;
    };
    const parsed = parseVersion(version);
    if (parsed === undefined || !versionAtLeast(parsed, floor)) continue;
    const currentArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
    // Architecture was absent in the original script-only ledger. Retain parser
    // compatibility, but all newly generated native-helper entries bind it.
    if (architecture !== undefined && architecture !== currentArchitecture) continue;
    if (typeof hashes !== 'object' || hashes === null) continue;
    const build = new Map<string, string>();
    for (const path of [...RUNNER_BOUNDARY_BINARIES, ...RUNNER_BOUNDARY_PROTECTED_FILES]) {
      const hash = (hashes as Record<string, unknown>)[path];
      // A 64-hex check, not a format nicety: an entry that is not a sha256 could
      // never match a computed digest anyway, and admitting it would only make the
      // accepted build describe something the comparison cannot use.
      if (typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash)) build.set(path, hash);
    }
    // A release that does not name every boundary binary does not describe a
    // build, and half a build must not become a hash others can be mixed with.
    if (build.size !== RUNNER_BOUNDARY_BINARIES.length + RUNNER_BOUNDARY_PROTECTED_FILES.length)
      continue;
    accepted.push({
      label:
        architecture === undefined
          ? `release ${String(version)}`
          : `release ${String(version)} (${currentArchitecture})`,
      hashes: build,
    });
  }
  return accepted;
}

async function trustedToolkitHashes(featureDir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const path of RUNNER_BOUNDARY_BINARIES) {
    const sourceName = path.endsWith('supervisor')
      ? 'verity-runner-supervisor.mjs'
      : path.endsWith('worker')
        ? 'verity-runner-worker.mjs'
        : path.endsWith('spawn-broker')
          ? 'verity-agent-spawn-broker.mjs'
          : path.slice(path.lastIndexOf('/') + 1);
    hashes.set(path, sha256(await readFile(`${featureDir}/bin/${sourceName}`)));
  }
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
  if (architecture !== 'amd64' && architecture !== 'arm64') {
    throw new Error(`unsupported runner boundary architecture: ${process.arch}`);
  }
  const sums = await readFile(`${featureDir}/prebuilt/sha256sums.txt`, 'utf8');
  const artifact = `linux-${architecture}/verity-script-sandbox`;
  const matches = sums
    .split('\n')
    .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && match[2] === artifact);
  if (matches.length !== 1) throw new Error(`missing or ambiguous trusted hash for ${artifact}`);
  hashes.set(RUNNER_BOUNDARY_PROTECTED_FILES[0], matches[0]?.[1] ?? '');
  return hashes;
}

export async function attestRunnerSupervisorBoundary(args: {
  imageRef: string;
  dockerHost: string;
  runnerUid: number;
  runtimeGid: number;
  user?: string | undefined;
  timeoutMs?: number | undefined;
  evidenceCollector?: ImageEvidenceCollector | undefined;
  featureDir?: string | undefined;
}): Promise<RunnerBoundaryAttestation> {
  try {
    const [evidence, trustedToolkits] = await Promise.all([
      (args.evidenceCollector ?? defaultImageEvidenceCollector)({
        imageRef: args.imageRef,
        dockerHost: args.dockerHost,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      }),
      acceptedToolkits(args.featureDir ?? defaultRunnerBoundaryFeatureDir()),
    ]);
    return evaluateRunnerBoundaryEvidence(evidence, {
      runnerUid: args.runnerUid,
      runtimeGid: args.runtimeGid,
      trustedToolkits,
      ...(args.user !== undefined ? { user: args.user } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof EvidenceError
          ? error.safeReason
          : 'trusted image evidence could not be collected or verified',
    };
  }
}
