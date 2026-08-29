/**
 * Minimal Docker Engine HTTP client (concept §17, #174). Talks to the Docker
 * socket-proxy via plain fetch — the proxy scopes the surface to the endpoints
 * Verity needs (`containers/create`, `containers/start`, `containers/stop`,
 * `containers/remove`, `containers/exec`, `images/create`); raw
 * `/var/run/docker.sock` is out of scope (§16 hardening: a project container
 * must never reach the daemon's full API surface, only the slices Verity
 * proxies). Verity pulls its pinned base image itself via `images/create` when
 * a container create reports the image is missing (ADR 0003 R6 / #299), so a
 * fresh host doesn't need an out-of-band `docker pull` first.
 *
 * Same `HttpFetch` injection form as {@link githubService} so tests supply a
 * fake without constructing a real HTTP client. The base URL comes from
 * `VERITY_DOCKER_BASE_URL` and selects one of two transports:
 *  - **HTTP socket-proxy** (default, §17 fleet deployment) — an `http://`/
 *    `https://` URL like `http://127.0.0.1:9234/v1.41`. Routed through the
 *    injected `fetch` (global fetch in prod, a fake in tests).
 *  - **Mounted host unix socket** (ADR 0003 R2, standalone runner) — a
 *    `unix://` URL. A single-node Verity started with
 *    `docker run -v /var/run/docker.sock:/var/run/docker.sock …` talks to the
 *    Engine directly, no socket-proxy sidecar. Selected automatically when
 *    `baseUrl` starts with `unix:`; backed by {@link createUnixSocketFetch}
 *    (Node `node:http` over the socket), dependency-free (no dockerode).
 *
 *    Parse convention: `unix://<socket-path>[:<api-version-path>]`. The
 *    optional API-version suffix is everything after the LAST `:/` in the URL
 *    (it must start with `/`, e.g. `/v1.41`); the part before it is the
 *    absolute host path of the socket. Examples:
 *      - `unix:///var/run/docker.sock`          → sock `/var/run/docker.sock`, no version prefix
 *      - `unix:///var/run/docker.sock:/v1.41`   → sock `/var/run/docker.sock`, prefix `/v1.41`
 *    A colon that is NOT followed by `/` (rare in socket paths) is treated as
 *    part of the path, so ordinary socket paths without a version parse cleanly.
 *
 * Errors are mapped to a small typed set so the {@link Provisioner} (slice 3)
 * can route `404/409/500` differently than a network failure. The caller
 * decides retry policy — this module surfaces the truth and stays out of the
 * retry business.
 */
import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import type { HttpFetch, HttpResponse } from './github.js';

/** The subset of the Docker Engine REST API Verity calls. §17 socket-proxy
 *  scope: only those endpoints the proxy explicitly allows; unscoped endpoints
 *  return 403 and we don't reach them here. */
export interface DockerClient {
  /** Create a container without starting it (Engine `/containers/create`). The
   *  `{ Id }` of the new container is returned, NOT the running state. Rejects
   *  with `{ kind: 'image_not_found', image }` when the Engine doesn't have
   *  `imageRef` (create never pulls). The provisioner catches that, calls
   *  {@link pullImage}, and retries create once (ADR 0003 R6 / #299); Verity's
   *  provisioner pins the image via `default-project-image.json`. */
  createContainer(spec: ContainerSpec): Promise<CreateContainerResult>;
  /** Pull an image so a subsequent {@link createContainer} finds it locally
   *  (Engine `POST /images/create`). `imageRef` is a full ref — `name:tag`,
   *  bare `name` (defaults tag `latest`), or `name@sha256:<digest>`.
   *
   *  Docker gotcha: `/images/create` returns **HTTP 200** and STREAMS
   *  newline-delimited JSON progress objects; a pull failure (auth denied, not
   *  found, network) surfaces as a `{"error":"..."}` object INSIDE the 200 body,
   *  not as a non-2xx status. So this reads the whole stream and rejects with a
   *  typed {@link DockerClientError} when it finds an `error` line
   *  (`image_not_found` if the message indicates missing/denied, else `other`).
   *  A 2xx with no error line resolves.
   *
   *  Optional on the interface so test fakes and any transport that predates
   *  auto-pull stay valid; the real {@link createDockerClient} always provides
   *  it, and the provisioner falls back to surfacing `image_not_found` when it's
   *  absent. */
  pullImage?(imageRef: string, opts?: PullImageOptions): Promise<void>;
  /** Start an already-created container (Engine `/containers/{id}/start`). */
  startContainer(id: string): Promise<void>;
  /** Wait until a container exits and return its process exit code. */
  waitContainer?(id: string): Promise<number>;
  /** Read a bounded tail of stdout/stderr for diagnostics. */
  containerLogs?(id: string, tail: number): Promise<string>;
  /** Stop a running container (Engine `/containers/{id}/stop`) — gracefully SIGTERM
   *  with the timeout from the daemon default (10s). 404 → `ContainerNotFound`
   *  so deprovision is best-effort idempotent. */
  stopContainer(id: string): Promise<void>;
  /** Force-remove a container regardless of running state
   *  (Engine `/containers/{id}?force=true&v=true`). 404 → already gone.
   *
   *  `v=true` is load-bearing, not a nicety: an image with a `VOLUME` instruction
   *  (postgres, several devcontainer bases) makes the daemon mint an ANONYMOUS
   *  volume on every create. Removing the container without `v` orphans it — it
   *  survives as a dangling volume that no `docker system prune` reaches
   *  (`prune` skips volumes unless asked), so a fleet that provisions and tears
   *  down sandboxes leaks one volume per container until the disk fills. Verity
   *  never stores durable state in an anonymous volume — per-project data lives
   *  in the named `verity-data` volume ({@link ContainerSpec.volumeMounts}) and
   *  named volumes are unaffected by `v` — so taking them down with the
   *  container is both safe and the only correct lifetime. */
  removeContainer(id: string): Promise<void>;
  /** Replace one host-infrastructure container with the same Docker config and
   * mounts but a different immutable image. The real client rolls the original
   * config back if creation or startup of the successor fails. */
  replaceContainerImage?(
    id: string,
    image: string,
    labels?: Record<string, string>,
  ): Promise<string>;
  /** Inspect a container — `{ State: { Running } }` is all the provisioner reads.
   *  404 → `ContainerNotFound`. Used to detect an already-running sibling
   *  (idempotency: the `verity-<owner>--<repo>` name is unique-per-daemon so a
   *  revisit after Verity restart reuses the same container). */
  inspectContainer(id: string): Promise<ContainerInspect>;
  /** Test whether an image ref is present on the daemon (Engine `GET
   *  /images/{ref}/json`). Returns `true` on 200, `false` on 404, and rejects
   *  with a typed {@link DockerError} on any other failure. Used by the
   *  provisioner's per-project devcontainer `resolve-or-build` step (ADR 0003
   *  R3.1) to decide cache-hit (image already built) vs. build.
   *
   *  Optional on the interface so test fakes and transports that predate the
   *  devcontainer-build path stay valid; the real {@link createDockerClient}
   *  always provides it. */
  imageExists?(ref: string): Promise<boolean>;
  /** Inspect image labels for a locally-present image ref (Engine `GET
   *  /images/{ref}/json`). Returns `undefined` on 404. Used for best-effort UI
   *  metadata such as displaying the target sandbox version behind a digest. */
  inspectImageLabels?(ref: string): Promise<Record<string, string> | undefined>;
  /** Read an image's baked `Config.Env` (Engine `GET /images/{ref}/json`).
   *  A container's own `Config.Env` is the image's env with the create request's
   *  entries applied on top, so this is what a caller needs to decide whether a
   *  running container carries exactly the environment a spec asked for and
   *  nothing else. `undefined` when the daemon does not have the image. */
  inspectImageEnv?(ref: string): Promise<readonly string[] | undefined>;
  /** Create a user-defined bridge network if absent (Engine `POST /networks/create`),
   *  idempotent — an existing network (409) is a no-op. Used for per-project sandbox
   *  network isolation (security review H2). Optional so pre-existing test fakes stay
   *  valid; the real {@link createDockerClient} always provides it. */
  ensureNetwork?(name: string, opts?: { labels?: Record<string, string> }): Promise<void>;
  /** Read one daemon-registered OCI runtime from `GET /info`. The real client always implements
   *  this; optional only so older injected test doubles remain source-compatible. */
  inspectRuntime?(name: string): Promise<DockerRuntimeRegistration | undefined>;
  /** List images on the daemon (Engine `GET /images/json`). Read by the disk GC
   *  to find superseded devcontainer image generations. Optional so pre-existing
   *  test fakes stay valid; the real {@link createDockerClient} always provides it. */
  listImages?(): Promise<DockerImageSummary[]>;
  /** Remove an image by ref (Engine `DELETE /images/{ref}`). 404 → already gone
   *  (no-op, so a concurrent sweep is safe). A 409 — the daemon refuses because a
   *  container still references it — surfaces as a typed `conflict` DockerError
   *  so the caller can skip that image instead of failing the whole pass. */
  removeImage?(ref: string): Promise<void>;
  /** List container summaries INCLUDING stopped ones (Engine
   *  `GET /containers/json?all=true`). The GC reads `imageId` so it never removes
   *  an image any container — running or merely created — still references, and
   *  `labels`/`created` so it can pair project relays with the sandbox generation
   *  they serve. */
  listContainers?(): Promise<DockerContainerSummary[]>;
  /** List volumes (Engine `GET /volumes`). With `danglingOnly`, passes the
   *  `dangling=true` filter so the "attached to no container" decision is made by
   *  the daemon under its own lock rather than raced client-side. */
  listVolumes?(opts?: { danglingOnly?: boolean }): Promise<DockerVolumeSummary[]>;
  /** Remove a volume by name (Engine `DELETE /volumes/{name}`). 404 → no-op; a
   *  409 (the daemon says it is still in use) surfaces as a typed `conflict`. */
  removeVolume?(name: string): Promise<void>;
  /** Prune build cache older than `untilHours` (Engine `POST /build/prune`) and
   *  resolve the number of bytes reclaimed. */
  pruneBuildCache?(opts?: { untilHours?: number }): Promise<number>;
}

export interface DockerRuntimeRegistration {
  path: string;
  args: string[];
}

/** One entry of `GET /images/json`, narrowed to what the disk GC needs. */
export interface DockerImageSummary {
  /** Content id (`sha256:…`) — the identity a container's `imageId` matches. */
  id: string;
  /** Every `repo:tag` pointing at this image; `[]` for an untagged/dangling one. */
  repoTags: string[];
  /** Creation time in Unix SECONDS (the Engine's unit for this field). */
  created: number;
  /** Apparent size in bytes. Shared layers are counted once PER IMAGE, so summing
   *  across images overstates the reclaimable total — report it as an estimate. */
  size: number;
}

/** One entry of `GET /containers/json`, narrowed to what the GC needs. */
export interface DockerContainerSummary {
  id: string;
  /** Resolved image content id (`sha256:…`), NOT the human-readable `repo:tag`. */
  imageId: string;
  /** Container names as the daemon reports them, WITHOUT the leading `/`. Only
   *  used for logging which container a sweep retired. Optional so pre-existing
   *  test fakes stay valid. */
  names?: string[];
  /** Container labels. The relay sweep decides purely on Verity's own
   *  `verity.*` labels, so an unlabelled container is never a target. Optional
   *  for the same reason; an absent map reads as "no labels". */
  labels?: Record<string, string>;
  /** Creation time in Unix SECONDS (the Engine's unit for this field). Drives the
   *  relay sweep's grace period. */
  created?: number;
}

/** One entry of `GET /volumes`, narrowed to what the disk GC needs. */
export interface DockerVolumeSummary {
  name: string;
  /** Volume labels. The daemon sets `com.docker.volume.anonymous` on volumes it
   *  minted itself for an image's `VOLUME` instruction — the GC requires that
   *  label to be present before it will delete anything. */
  labels: Record<string, string>;
  /** RFC-3339 creation timestamp, when the daemon reports one. */
  createdAt?: string;
}

/** Spec for {@link DockerClient.createContainer}. Mirrors the Engine's create
 *  request body, only the fields Verity actually sets — image, name, bind-mounts,
 *  labels. §19.3 sets `verity.project-id=<uuid>` so a later reconcile pass can
 *  find "all containers Verity started"; §11 (port-registry) + §16 (egress
 *  firewall) consume their own labels later. */
export interface ContainerSpec {
  /** Image ref (digest or tag, no float). e.g. `ghcr.io/.../dev-base:2026.06@sha256:...`. */
  image: string;
  /** Container name — the canonical hyphen-slug `verity-<owner>--<repo>`. */
  name: string;
  /** Bind-mounts (host-absolute-path → in-container-path). Used for deploy-level,
   *  non-per-project mounts (e.g. the read-only agent-seed toolkit). Per-project
   *  data is a named-volume {@link ContainerSpec.volumeMounts} instead, so a
   *  sibling container needs no host-path knowledge. */
  binds?: string[];
  /** Named-volume mounts with an optional subpath (`HostConfig.Mounts`, Docker
   *  25.0+ `VolumeOptions.Subpath`). Verity mounts per-project subdirs of a single
   *  data volume this way — `workspaces/<owner>-<repo>` at `/work`, and the
   *  per-project secret dir — so the source resolves by VOLUME NAME on the host
   *  daemon (a sibling need not know the volume's on-disk host path, and there is
   *  no host dir to pre-create / chown). */
  volumeMounts?: Array<{
    /** The named volume's name (its `Source`). */
    volume: string;
    /** In-container mount target. */
    target: string;
    /** Subpath within the volume to mount (omit → the volume root). */
    subpath?: string;
    /** Mount read-only. */
    readOnly?: boolean;
  }>;
  /** Free-form labels attached to the container. */
  labels?: Record<string, string>;
  /** Environment `KEY=value` strings. */
  env?: string[];
  /** Optional user override (devcontainer `remoteUser` / Docker `User`). */
  user?: string;
  /** Supplementary Linux groups (`HostConfig.GroupAdd`). */
  groupAdd?: string[];
  /** Explicit target platform for digest-pinned multi-architecture images. */
  platform?: 'linux/amd64' | 'linux/arm64';
  /** Optional entrypoint override. */
  entrypoint?: string[];
  /** Optional command override. */
  command?: string[];
  /** Keep container stdin open even before a client attaches (`Config.OpenStdin`). Required by
   * one-shot workers that start before their authenticated attach channel is established. */
  openStdin?: boolean;
  /** Host-to-container TCP port bindings. */
  portBindings?: Array<{ hostPort: string; containerPort: string }>;
  /** Docker restart policy for host reboots / daemon restarts. */
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  /** Docker network to attach the container to (its `HostConfig.NetworkMode`).
   *  Omit → `'default'` (the daemon's default bridge, today's behavior). Set to a
   *  shared user-defined network so the sandbox can reach the control-plane server
   *  by its service DNS name (e.g. the commit-signing broker at
   *  `http://verity:8082`) container-to-container, without a host round-trip. */
  network?: string;
  /** OCI runtime registered with the Docker daemon (`HostConfig.Runtime`). Secret jobs set this
   *  explicitly to `runsc`; omitting it preserves the daemon default for ordinary sandboxes. */
  runtime?: string;
  /** Mount the image root filesystem read-only (`HostConfig.ReadonlyRootfs`). */
  readOnlyRootfs?: boolean;
  /** Ephemeral in-memory mounts keyed by their absolute container path (`HostConfig.Tmpfs`). */
  tmpfs?: Record<string, string>;
  /** Runtime hardening (security review C1). Sandboxes are otherwise launched with
   *  Docker's permissive defaults — full cap set, privilege escalation allowed, no
   *  resource ceilings — which does not contain a malicious dependency. These map
   *  to the matching `HostConfig` fields and are applied only when set, so a spec
   *  without them keeps the legacy behaviour. */
  /** Linux capabilities to drop (`HostConfig.CapDrop`). Sandbox default `['ALL']`. */
  capDrop?: string[];
  /** Capabilities to add back on top of {@link capDrop} (`HostConfig.CapAdd`). */
  capAdd?: string[];
  /** `HostConfig.SecurityOpt`, e.g. `['no-new-privileges:true']` to block setuid
   *  privilege escalation inside the container. */
  securityOpt?: string[];
  /** Max PIDs (`HostConfig.PidsLimit`) — the fork-bomb guard. */
  pidsLimit?: number;
  /** Hard memory ceiling in bytes (`HostConfig.Memory`). Omit/0 → unlimited. */
  memoryBytes?: number;
  /**
   * Combined memory+swap ceiling in bytes (`HostConfig.MemorySwap`). Setting it
   * equal to {@link memoryBytes} disables swap, which is what a Compose
   * `memswap_limit` matching its `mem_limit` expresses. Omitting it is not
   * neutral: Docker then defaults to twice the memory limit, so a container
   * Compose kept out of swap silently gains a swap allowance the moment its
   * ownership moves to a spec here.
   *
   * Only meaningful together with {@link memoryBytes}; on its own it is dropped,
   * because Docker refuses a create that limits swap without limiting memory.
   */
  memorySwapBytes?: number;
  /** CPU quota in nano-CPUs (`HostConfig.NanoCpus`; 1e9 = one core). Omit → unlimited. */
  nanoCpus?: number;
  /**
   * Per-process rlimits (`HostConfig.Ulimits`), e.g. `[{ name: 'core', soft: 0, hard: 0 }]`
   * to stop a crashing process from writing a core dump. Docker takes the names without
   * the `RLIMIT_` prefix, exactly as `docker run --ulimit` does, and `-1` means
   * unlimited. An entry the daemon would reject (unnamed, non-integer, or a soft above
   * its hard) is dropped rather than forwarded — see the filter in `createContainer`.
   */
  ulimits?: Array<{ name: string; soft: number; hard: number }>;
}

const DOCKER_ULIMIT_NAMES = new Set([
  'as',
  'core',
  'cpu',
  'data',
  'fsize',
  'locks',
  'memlock',
  'msgqueue',
  'nice',
  'nofile',
  'nproc',
  'rss',
  'rtprio',
  'rttime',
  'sigpending',
  'stack',
]);

export interface CreateContainerResult {
  /** Docker-minted container id (sha hex). */
  id: string;
  /** Engine-reported warnings (e.g. `no IPv4` — informational, surfaces in logs). */
  warnings: string[];
}

export interface ContainerInspect {
  /** The opaque container id. */
  id: string;
  /** True while the container's state reports `Running: true`. */
  running: boolean;
  /** Whether Docker keeps stdin open when no attach client is currently connected. */
  openStdin?: boolean;
  /** Container image reference recorded on the container config. */
  image?: string | undefined;
  /** OpenContainers/custom labels recorded on the container config. */
  labels?: Record<string, string> | undefined;
  /** Docker networks attached to the container, keyed by network name. */
  networks?: Record<string, { ipAddress?: string | undefined }> | undefined;
  /** Docker config user, when set. */
  user?: string | undefined;
  groupAdd?: string[] | undefined;
  /** OCI runtime recorded in `HostConfig.Runtime`, e.g. `runsc`. */
  runtime?: string | undefined;
  /** Docker lifecycle state (`created`, `running`, `exited`, `dead`, ...). */
  status?: string | undefined;
  healthStatus?: string | undefined;
  networkMode?: string | undefined;
  readOnlyRootfs?: boolean | undefined;
  tmpfs?: Record<string, string> | undefined;
  capDrop?: string[] | undefined;
  securityOpt?: string[] | undefined;
  pidsLimit?: number | undefined;
  memoryBytes?: number | undefined;
  /** `HostConfig.MemorySwap`. Reported so a caller can tell a container Docker
   *  gave the default swap allowance (twice {@link memoryBytes}) from one whose
   *  combined ceiling matches its memory ceiling and therefore cannot swap. */
  memorySwapBytes?: number | undefined;
  nanoCpus?: number | undefined;
  env?: string[] | undefined;
  /** Runtime mounts reported by inspect; secret jobs require this to be empty. */
  mountCount?: number | undefined;
  /** Sanitized runtime mount metadata used by public-preview eligibility checks. */
  mounts?:
    | Array<{
        type?: string | undefined;
        /** Volume name for `type: 'volume'`, absent for a bind. Distinct from
         *  {@link source}, which the daemon reports as the HOST PATH the volume
         *  currently resolves to (`/var/lib/docker/volumes/<name>/_data`) — so a
         *  caller comparing a mount against a volume NAME must use this. */
        name?: string | undefined;
        source?: string | undefined;
        destination?: string | undefined;
        readWrite?: boolean | undefined;
      }>
    | undefined;
  privileged?: boolean | undefined;
  capAdd?: string[] | undefined;
  deviceCount?: number | undefined;
  restartPolicy?: string | undefined;
  entrypoint?: string[] | undefined;
  command?: string[] | undefined;
  init?: boolean | undefined;
}

/** Mutually-exclusive typed errors so the {@link Provisioner}'s catch blocks can
 *  switch without re-parsing HTTP status codes. Wrapped in an {@link Error} so
 *  ESLint's `only-throw-error` is satisfied and stack traces work. */
export type DockerClientError =
  | { kind: 'image_not_found'; image: string; message: string }
  | { kind: 'container_not_found'; id: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'other'; status: number; message: string }
  | { kind: 'network'; cause: unknown };

export class DockerError extends Error {
  /** Discriminant tag — `kind` from the {@link DockerClientError} union. */
  readonly kind: DockerClientError['kind'];
  /** The full typed payload; switchable via `error.payload.kind`. */
  readonly payload: DockerClientError;
  /** Discriminant fields surfaced directly onto the Error so callers/tests can
   *  `toMatchObject({ kind, image })` without reaching into `.payload`. Provied-
   *  safe: only the variants carrying these fields set them; the others stay
   *  undefined (mirrors their absence in the variant). */
  readonly image?: string;
  readonly id?: string;
  readonly status?: number;
  override readonly cause?: unknown;
  constructor(err: DockerClientError) {
    super('message' in err ? err.message : err.kind);
    this.name = 'DockerError';
    this.kind = err.kind;
    this.payload = err;
    if (err.kind === 'image_not_found') this.image = err.image;
    else if (err.kind === 'container_not_found') this.id = err.id;
    else if (err.kind === 'other') this.status = err.status;
    else if (err.kind === 'network') this.cause = err.cause;
  }
}

export interface DockerClientOptions {
  /** Base URL of the Docker API surface. Either the HTTP socket proxy
   *  (`http://127.0.0.1:9234/v1.41`, default) or a mounted host unix socket
   *  (`unix:///var/run/docker.sock[:/v1.41]`, ADR 0003 R2 — see module header).
   *  A `unix:` prefix auto-selects the {@link createUnixSocketFetch} transport. */
  baseUrl: string;
  /** Injected `fetch` (tests); defaults to global. */
  fetch?: HttpFetch;
  /** Per-request timeout in ms (default 30s) for the quick daemon calls
   *  (create/start/stop/remove/inspect). Image pulls use {@link pullTimeoutMs}
   *  instead — they stream for a long time. */
  timeoutMs?: number;
  /** Timeout in ms for {@link DockerClient.pullImage} (default 300s). Pulls are
   *  slow (image download + extract), so they get a separate, much longer budget
   *  than the 30s request timeout above. */
  pullTimeoutMs?: number;
  /** Optional value for the `X-Registry-Auth` header on {@link
   *  DockerClient.pullImage} — a base64-encoded JSON `{username,password}` or an
   *  identity token, for private registries. Default unset: the product base
   *  image is public on ghcr, so no auth is sent. Sourced from
   *  `VERITY_REGISTRY_AUTH` at the composition root. */
  registryAuth?: string;
}

/** KNOWN GAP, recorded rather than quietly changed: `[truncated]` is added HERE, so it
 *  only ever reaches MULTIPLEXED output. Plain (unframed) logs leave through the early
 *  return below, before any marker — which means a read cut short by `containerLogs`'
 *  byte budget comes back indistinguishable from a complete one, at exactly the moment
 *  an operator is reading logs because something failed. The bound itself is right and
 *  should stay; what is missing is saying so. The likely fix is to append the sentinel
 *  where the budget is applied (`boundedResponseBytes`) rather than here, so it does not
 *  depend on which log format the Engine happened to serve. Both affected paths are
 *  pinned as they behave, under names carrying `unmarked`, in docker.test.ts — fixing
 *  this will fail those two tests, which is the point. */
function decodeDockerLogFrames(bytes: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const stream = bytes[offset];
    if (
      (stream !== 1 && stream !== 2) ||
      bytes[offset + 1] !== 0 ||
      bytes[offset + 2] !== 0 ||
      bytes[offset + 3] !== 0
    ) {
      return bytes.toString('utf8');
    }
    const length = bytes.readUInt32BE(offset + 4);
    if (offset + 8 + length > bytes.length) {
      parts.push(bytes.subarray(offset + 8), Buffer.from('\n[truncated]\n'));
      return Buffer.concat(parts).toString('utf8');
    }
    parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  if (offset < bytes.length && parts.length > 0) parts.push(Buffer.from('\n[truncated]\n'));
  return parts.length === 0 ? bytes.toString('utf8') : Buffer.concat(parts).toString('utf8');
}

async function boundedResponseBytes(res: HttpResponse, limit: number): Promise<Buffer> {
  if (res.body !== undefined && res.body !== null) {
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (total < limit) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        const remaining = limit - total;
        chunks.push(chunk.subarray(0, remaining));
        total += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, total);
  }
  if (res.arrayBuffer !== undefined) return Buffer.from(await res.arrayBuffer()).subarray(0, limit);
  const text = res.text === undefined ? JSON.stringify(await res.json()) : await res.text();
  return Buffer.from(text, 'utf8').subarray(0, limit);
}

/** Per-call options for {@link DockerClient.pullImage}. */
export interface PullImageOptions {
  /** Override the client-level `registryAuth` for this single pull. */
  registryAuth?: string;
}

/** Init-shape narration of `fetch` so the docker client can construct
 *  request init per-call without `exactOptionalPropertyTypes`-strictness pain. */
export interface HttpFetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  body?: string;
}

/** Translate a raw `fetch` failure into a typed {@link DockerClientError}. */
async function callDocker(
  doFetch: HttpFetch,
  url: string,
  method: string,
  timeoutMs: number,
  body?: unknown,
): Promise<HttpResponse> {
  const init: HttpFetchInit = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  try {
    return await doFetch(url, init);
  } catch (cause) {
    throw new DockerError({ kind: 'network', cause });
  }
}

/** A ref whose bytes are named by their own hash, and therefore immutable. */
const DIGEST_PINNED_IMAGE = /@sha256:[a-f0-9]{64}$/;

function parseDockerLabels(labels: unknown): Record<string, string> | undefined {
  return typeof labels === 'object' && labels !== null
    ? Object.fromEntries(
        Object.entries(labels).filter(
          (entry): entry is [string, string] =>
            typeof entry[0] === 'string' && typeof entry[1] === 'string',
        ),
      )
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function dockerListLength(value: unknown): number | undefined {
  if (value === null) return 0;
  return Array.isArray(value) ? value.length : undefined;
}

function dockerDeviceCount(devices: unknown, requests: unknown): number | undefined {
  const devicesLength = dockerListLength(devices);
  const requestsLength = dockerListLength(requests);
  return devicesLength === undefined || requestsLength === undefined
    ? undefined
    : devicesLength + requestsLength;
}

/** Read the Engine's `{"message": "..."}` body and map to the typed error.
 *  Returns a {@link DockerError} (already wrapped) so the throw sites stay
 *  `throw await toDockerError(...)` without an extra `new DockerError(...)`. */
async function toDockerError(response: HttpResponse, id?: string): Promise<DockerError> {
  const err = await buildDockerErrorPayload(response, id);
  return new DockerError(err);
}

async function buildDockerErrorPayload(
  response: HttpResponse,
  id?: string,
): Promise<DockerClientError> {
  // 404 with a container id → container_not_found; otherwise treat as other.
  if (response.status === 404 && id !== undefined) {
    return { kind: 'container_not_found', id };
  }
  let message = `docker HTTP ${String(response.status)}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Engine occasionally sends no JSON; keep the status-only message.
  }
  if (response.status === 409) return { kind: 'conflict', message };
  if (response.status === 404) return { kind: 'other', status: 404, message };
  return { kind: 'other', status: response.status, message };
}

/** Parsed form of a `unix://` base URL — the host socket path plus an optional
 *  API-version path prefix (see the module header for the convention). */
export interface ParsedUnixBaseUrl {
  socketPath: string;
  /** API-version path prefix (e.g. `/v1.41`) or '' when the URL had none. The
   *  per-request path is `${apiPrefix}${enginePath}`. */
  apiPrefix: string;
  /** The normalized base URL string the DockerClient prepends to each engine
   *  path (trailing slash stripped). The transport strips this literal prefix
   *  off each request URL to recover the engine path+query. */
  base: string;
}

/** Split an image ref into the `fromImage` name and `tag` query params the
 *  Engine's `/images/create` endpoint expects.
 *
 *  Forms:
 *   - `name@sha256:<digest>`     → `{ fromImage: 'name@sha256:<digest>' }`, NO
 *     tag (the digest is carried on `fromImage`; a `tag` param would conflict).
 *   - `name:tag@sha256:<digest>` → `{ fromImage: 'name@sha256:<digest>' }` — the
 *     tag is dropped in favour of the digest (the canonical pin-by-digest form).
 *   - `name:tag`                 → `{ fromImage: 'name', tag: 'tag' }`.
 *   - `name`                     → `{ fromImage: 'name', tag: 'latest' }`.
 *
 *  A registry port (`registry:5000/img`) contains a `:` that is NOT a tag
 *  separator; the tag colon, if any, is always in the LAST path segment (after
 *  the final `/`), so we only look there. */
export function parseImageRef(imageRef: string): { fromImage: string; tag?: string } {
  const at = imageRef.indexOf('@');
  if (at !== -1) {
    // Digest present. Docker's /images/create wants the digest on `fromImage`
    // and no `tag` param; a leading `name:tag@sha256:…` is normalized to
    // `name@sha256:…` (digest wins) so the pin-by-digest request is well-formed.
    const beforeDigest = imageRef.slice(0, at);
    const digest = imageRef.slice(at); // includes the leading '@'
    const lastSlash = beforeDigest.lastIndexOf('/');
    const lastSegment = lastSlash === -1 ? beforeDigest : beforeDigest.slice(lastSlash + 1);
    const colonInSegment = lastSegment.lastIndexOf(':');
    const nameNoTag =
      colonInSegment === -1
        ? beforeDigest
        : beforeDigest.slice(0, beforeDigest.length - (lastSegment.length - colonInSegment));
    return { fromImage: `${nameNoTag}${digest}` };
  }
  const lastSlash = imageRef.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? imageRef : imageRef.slice(lastSlash + 1);
  const colonInSegment = lastSegment.lastIndexOf(':');
  if (colonInSegment === -1) {
    // No tag → default to `latest`, matching `docker pull` semantics.
    return { fromImage: imageRef, tag: 'latest' };
  }
  const tag = lastSegment.slice(colonInSegment + 1);
  const namePrefix = lastSlash === -1 ? '' : imageRef.slice(0, lastSlash + 1);
  return { fromImage: `${namePrefix}${lastSegment.slice(0, colonInSegment)}`, tag };
}

/** Scan a buffered `/images/create` NDJSON stream body for an in-stream error.
 *  The Engine returns HTTP 200 and streams `{"status":...}` progress lines; a
 *  failure appears as a `{"error":"..."}` line inside that 200 body. Returns the
 *  first error message found, or `undefined` when the pull succeeded. */
export function findPullStreamError(body: string): string | undefined {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON line (shouldn't happen on this endpoint) — ignore, keep scanning.
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const err = (parsed as { error?: unknown; errorDetail?: { message?: unknown } }).error;
      if (typeof err === 'string' && err !== '') return err;
      const detail = (parsed as { errorDetail?: { message?: unknown } }).errorDetail?.message;
      if (typeof detail === 'string' && detail !== '') return detail;
      // `error` present but not a usable string — still a failure signal.
      return 'image pull failed';
    }
  }
  return undefined;
}

/** True when a pull-stream error message indicates the image is missing or
 *  access was denied (→ `image_not_found`), vs. a transient/other failure. */
function pullErrorIsNotFound(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('not found') ||
    m.includes('no such') ||
    m.includes('manifest unknown') ||
    m.includes('denied') ||
    m.includes('unauthorized') ||
    m.includes('access to the resource is denied')
  );
}

/** True when `baseUrl` selects the mounted-socket transport (ADR 0003 R2). */
export function isUnixBaseUrl(baseUrl: string): boolean {
  return baseUrl.startsWith('unix:');
}

/** Parse `unix://<socket-path>[:<api-version-path>]`. The optional API-version
 *  suffix is split off at the LAST `:/` occurrence (it must start with `/`);
 *  everything before it is the absolute socket path. Throws when the socket
 *  path is empty. */
export function parseUnixBaseUrl(baseUrl: string): ParsedUnixBaseUrl {
  // Accept both `unix://` (URL form) and `unix:` (bare) prefixes.
  const withoutScheme = baseUrl.replace(/^unix:(\/\/)?/, '');
  // Split at the last `:/` so a trailing `:/v1.41` becomes the api prefix while
  // ordinary paths (no `:/`) keep their colons.
  const sep = withoutScheme.lastIndexOf(':/');
  let socketPath: string;
  let apiPrefix: string;
  if (sep === -1) {
    socketPath = withoutScheme;
    apiPrefix = '';
  } else {
    socketPath = withoutScheme.slice(0, sep);
    apiPrefix = withoutScheme.slice(sep + 1); // keep the leading '/'
  }
  // Strip a trailing slash on the api prefix so path joins stay single-slash.
  if (apiPrefix.endsWith('/')) apiPrefix = apiPrefix.slice(0, -1);
  if (socketPath === '') {
    throw new DockerError({
      kind: 'other',
      status: 0,
      message: `invalid unix docker base URL (empty socket path): ${baseUrl}`,
    });
  }
  // Match the DockerClient's base normalization (trailing slash stripped) so
  // the transport can strip this literal prefix off each request URL.
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return { socketPath, apiPrefix, base };
}

/** An {@link HttpFetch}-shaped transport that speaks HTTP over a unix socket via
 *  `node:http` (the Docker Engine serves its REST API on the socket). The
 *  DockerClient calls this exactly like it calls the injected `fetch`; the
 *  returned {@link HttpResponse} exposes the same `{ ok, status, json() }` shape
 *  the client consumes. Connection failures (ENOENT missing socket, ECONNREFUSED)
 *  and the request `AbortSignal` reject the promise, so the client's existing
 *  `catch → { kind: 'network' }` mapping in {@link callDocker} applies unchanged.
 *
 *  The `url` argument is the FULL request URL the client builds (e.g.
 *  `unix:///var/run/docker.sock:/v1.41/containers/create?name=…`); the engine
 *  path + query is derived by stripping the parsed socket-path/api-prefix
 *  portion, so the client stays transport-agnostic. */
export function createUnixSocketFetch(parsed: ParsedUnixBaseUrl): HttpFetch {
  const { socketPath, apiPrefix, base } = parsed;
  return (url, init) =>
    new Promise<HttpResponse>((resolve, reject) => {
      // The client builds `${base}${enginePath}` where base is the normalized
      // unix URL. Recover the engine path+query by slicing off that literal
      // base prefix, then re-prepend the api prefix so the daemon sees
      // `/v1.41/containers/...`.
      const enginePath = url.startsWith(base) ? url.slice(base.length) : url;
      const requestPath = `${apiPrefix}${enginePath}`;

      const req = http.request(
        {
          socketPath,
          path: requestPath === '' ? '/' : requestPath,
          method: init?.method ?? 'GET',
          headers: init?.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          const responseLimit = requestPath.includes('/logs?')
            ? 64 * 1024
            : Number.POSITIVE_INFINITY;
          let retained = 0;
          res.on('data', (chunk: Buffer) => {
            if (retained >= responseLimit) return;
            const part = chunk.subarray(0, responseLimit - retained);
            chunks.push(part);
            retained += part.length;
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const rawBuffer = Buffer.concat(chunks);
            const raw = rawBuffer.toString('utf8');
            resolve({
              // Mirror fetch's `ok`: 2xx and 3xx (the Engine's 304 "already
              // stopped" convention must resolve `ok`, matching the HTTP path).
              ok: status >= 200 && status < 400,
              status,
              // Parse lazily like fetch's `.json()`; no await needed (body is
              // already fully buffered), so return a resolved promise.
              json: () => Promise.resolve(raw === '' ? {} : (JSON.parse(raw) as unknown)),
              // Raw body — the client scans the `/images/create` NDJSON stream
              // for an in-stream error via this (see pullImage). Fully buffered
              // above, so it's a resolved promise like json().
              text: () => Promise.resolve(raw),
              arrayBuffer: () =>
                Promise.resolve(
                  rawBuffer.buffer.slice(
                    rawBuffer.byteOffset,
                    rawBuffer.byteOffset + rawBuffer.byteLength,
                  ),
                ),
              headers: {
                get: (name: string) => {
                  const v = res.headers[name.toLowerCase()];
                  if (v === undefined) return null;
                  return Array.isArray(v) ? v.join(', ') : v;
                },
              },
            });
          });
          res.on('error', reject);
        },
      );
      // Connection-level failures (ENOENT, ECONNREFUSED) reject → mapped to
      // { kind: 'network' } by callDocker's catch, same as the HTTP path.
      req.on('error', reject);
      // Honour the per-request timeout the client passes as an AbortSignal.
      const signal = init?.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          req.destroy(new Error('aborted'));
        } else {
          signal.addEventListener(
            'abort',
            () => {
              req.destroy(new Error('aborted (timeout)'));
            },
            { once: true },
          );
        }
      }
      if (init?.body !== undefined) req.write(init.body);
      req.end();
    });
}

/** A hijacked Docker attach connection. Bytes written to the stream become container stdin;
 * bytes read from it are Docker's multiplexed stdout/stderr frames. Secret-job callers must apply
 * their framed protocol before interpreting payloads. */
export interface DockerAttachStream {
  stream: Duplex;
  close(): void;
}

/** Open Docker's binary attach protocol over the mounted Unix socket. This intentionally refuses
 * HTTP socket-proxy URLs: a secret worker remains networkless and its lifecycle channel must not
 * create a remotely reachable daemon surface. The container id is path-safe before any request is
 * made, and abort destroys both the request and an already-hijacked socket. */
export function openDockerUnixAttach(options: {
  baseUrl: string;
  containerId: string;
  signal?: AbortSignal;
}): Promise<DockerAttachStream> {
  if (!isUnixBaseUrl(options.baseUrl)) {
    return Promise.reject(
      new DockerError({
        kind: 'other',
        status: 0,
        message: 'secret-worker attach requires a Docker unix socket',
      }),
    );
  }
  if (!/^[a-f0-9]{12,64}$/.test(options.containerId)) {
    return Promise.reject(
      new DockerError({
        kind: 'other',
        status: 0,
        message: 'invalid Docker container id for attach',
      }),
    );
  }
  const parsed = parseUnixBaseUrl(options.baseUrl);
  const path = `${parsed.apiPrefix}/containers/${options.containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1`;
  return new Promise<DockerAttachStream>((resolve, reject) => {
    let settled = false;
    let attached: Duplex | undefined;
    const removeAbortListener = (): void => options.signal?.removeEventListener('abort', abort);
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(cause instanceof DockerError ? cause : new DockerError({ kind: 'network', cause }));
    };
    const request = http.request({
      socketPath: parsed.socketPath,
      path,
      method: 'POST',
      headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    request.once('upgrade', (_response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      attached = socket;
      socket.once('close', removeAbortListener);
      if (head.length > 0) socket.unshift(head);
      resolve({
        stream: socket,
        close: () => {
          removeAbortListener();
          socket.destroy();
        },
      });
    });
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const raw = Buffer.concat(chunks).toString('utf8');
        let message = `Docker attach refused HTTP ${String(status)}`;
        try {
          const body = JSON.parse(raw) as { message?: unknown };
          if (typeof body.message === 'string' && body.message !== '') message = body.message;
        } catch {
          // Preserve the status-only message for empty or non-JSON daemon responses.
        }
        fail(new DockerError({ kind: 'other', status, message }));
      });
      response.once('error', fail);
    });
    request.once('error', fail);
    const abort = (): void => {
      const error = new Error('Docker attach aborted');
      removeAbortListener();
      if (attached !== undefined) {
        // After upgrade the returned Duplex owns error reporting. Destroy without an Error so an
        // abort cannot become an unhandled `error` event when the caller has no listener yet.
        attached.destroy();
      } else {
        request.destroy(error);
        fail(error);
      }
    };
    if (options.signal?.aborted === true) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    request.end();
  });
}

export function createDockerClient(opts: DockerClientOptions): DockerClient {
  // ADR 0003 R2: a `unix://` base URL selects the mounted-host-socket transport
  // (node:http over the socket). Otherwise the injected/global fetch talks to
  // the HTTP socket-proxy exactly as before. An explicit `opts.fetch` always
  // wins (tests inject their own transport).
  const doFetch =
    opts.fetch ??
    (isUnixBaseUrl(opts.baseUrl)
      ? createUnixSocketFetch(parseUnixBaseUrl(opts.baseUrl))
      : (url, init) => fetch(url, init));
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl.slice(0, -1) : opts.baseUrl;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pullTimeoutMs = opts.pullTimeoutMs ?? 300_000;
  const defaultRegistryAuth = opts.registryAuth;

  /** POST /images/create?fromImage=…&tag=… — pull the pinned base image so a
   *  subsequent create finds it (ADR 0003 R6 / #299). See the interface doc for
   *  the HTTP-200-with-in-stream-error gotcha this handles. */
  const pullImage = async (imageRef: string, pullOpts?: PullImageOptions): Promise<void> => {
    const { fromImage, tag } = parseImageRef(imageRef);
    const query = new URLSearchParams({ fromImage });
    if (tag !== undefined) query.set('tag', tag);
    const url = `${base}/images/create?${query.toString()}`;
    const registryAuth = pullOpts?.registryAuth ?? defaultRegistryAuth;
    const init: HttpFetchInit = {
      method: 'POST',
      signal: AbortSignal.timeout(pullTimeoutMs),
    };
    if (registryAuth !== undefined) {
      // Private-registry auth: base64 JSON {username,password} or identity token.
      init.headers = { 'X-Registry-Auth': registryAuth };
    }
    let res: HttpResponse;
    try {
      res = await doFetch(url, init);
    } catch (cause) {
      throw new DockerError({ kind: 'network', cause });
    }
    if (!res.ok) {
      // Rare: a non-2xx BEFORE the stream starts (e.g. proxy rejects the path).
      const err = await toDockerError(res);
      const payload = err.payload;
      if (payload.kind === 'other' && payload.status === 404) {
        throw new DockerError({
          kind: 'image_not_found',
          image: imageRef,
          message: payload.message,
        });
      }
      throw err;
    }
    // CRITICAL: /images/create streams NDJSON at HTTP 200; a pull failure is a
    // `{"error":...}` line INSIDE that 200 body, not a status code. Read the
    // whole stream and scan it (see findPullStreamError).
    const body = res.text !== undefined ? await res.text() : JSON.stringify(await res.json());
    const streamError = findPullStreamError(body);
    if (streamError !== undefined) {
      if (pullErrorIsNotFound(streamError)) {
        throw new DockerError({ kind: 'image_not_found', image: imageRef, message: streamError });
      }
      throw new DockerError({
        kind: 'other',
        status: res.status,
        message: `image pull failed: ${streamError}`,
      });
    }
  };

  /** POST /containers/create?name=…; the proxy scopes this to that endpoint. */
  const createContainer = async (spec: ContainerSpec): Promise<CreateContainerResult> => {
    const query = new URLSearchParams({ name: spec.name });
    if (spec.platform !== undefined) query.set('platform', spec.platform);
    const url = `${base}/containers/create?${query.toString()}`;
    const exposedPorts = Object.fromEntries(
      (spec.portBindings ?? []).map((binding) => [`${binding.containerPort}/tcp`, {}]),
    );
    const portBindings = Object.fromEntries(
      (spec.portBindings ?? []).map((binding) => [
        `${binding.containerPort}/tcp`,
        [{ HostIp: '0.0.0.0', HostPort: binding.hostPort }],
      ]),
    );
    // Same posture as the `memoryBytes`/`nanoCpus` guards below: a value that cannot
    // mean anything to the daemon is dropped rather than forwarded. A `NaN` soft/hard
    // serializes to `null`, and a soft above its hard is rejected outright; either fails
    // the whole create, which reads as "the container could not start" rather than "this
    // one limit was nonsense". `-1` is kept — that is how Docker spells "unlimited",
    // which is why the comparison treats it as the largest value rather than the
    // smallest.
    const rlimitValue = (value: number): number => (value === -1 ? Infinity : value);
    const ulimits = (spec.ulimits ?? []).filter(
      (limit) =>
        DOCKER_ULIMIT_NAMES.has(limit.name) &&
        Number.isSafeInteger(limit.soft) &&
        Number.isSafeInteger(limit.hard) &&
        limit.soft >= -1 &&
        limit.hard >= -1 &&
        rlimitValue(limit.soft) <= rlimitValue(limit.hard),
    );
    const body = {
      Image: spec.image,
      // OpenContainers labels carry the host-side metadata; §19.3 sets
      // verity.project-id so a future reconcile pass finds Verity-owned containers.
      Labels: spec.labels ?? {},
      ...(spec.portBindings?.length ? { ExposedPorts: exposedPorts } : {}),
      HostConfig: {
        // Run Docker's tiny init as PID 1 so orphaned grandchildren from agent
        // tools are reaped instead of accumulating as zombies in long-lived
        // project containers.
        Init: true,
        Binds: spec.binds ?? [],
        // Named-volume mounts (per-project data). Emitted as HostConfig.Mounts with
        // VolumeOptions.Subpath (Docker 25.0+) so the source is the volume NAME, not
        // a host path — a sibling container resolves it without host-path knowledge.
        ...(spec.volumeMounts?.length
          ? {
              Mounts: spec.volumeMounts.map((m) => ({
                Type: 'volume' as const,
                Source: m.volume,
                Target: m.target,
                ReadOnly: m.readOnly ?? false,
                ...(m.subpath !== undefined ? { VolumeOptions: { Subpath: m.subpath } } : {}),
              })),
            }
          : {}),
        NetworkMode: spec.network ?? 'default',
        ...(spec.runtime !== undefined ? { Runtime: spec.runtime } : {}),
        ...(spec.groupAdd?.length ? { GroupAdd: spec.groupAdd } : {}),
        ...(spec.readOnlyRootfs !== undefined ? { ReadonlyRootfs: spec.readOnlyRootfs } : {}),
        ...(spec.tmpfs !== undefined ? { Tmpfs: spec.tmpfs } : {}),
        // Runtime hardening (C1) — emitted only when the spec sets it, so an
        // un-hardened caller is byte-for-byte unchanged.
        ...(spec.capDrop?.length ? { CapDrop: spec.capDrop } : {}),
        ...(spec.capAdd?.length ? { CapAdd: spec.capAdd } : {}),
        ...(spec.securityOpt?.length ? { SecurityOpt: spec.securityOpt } : {}),
        ...(spec.pidsLimit !== undefined ? { PidsLimit: spec.pidsLimit } : {}),
        ...(spec.memoryBytes !== undefined && spec.memoryBytes > 0
          ? { Memory: spec.memoryBytes }
          : {}),
        // Only alongside `Memory`: a swap ceiling on its own is not a weaker limit, it
        // is a create the daemon refuses ("You should always set the Memory limit when
        // using Memoryswap limit"). Dropping it keeps a half-specified spec from
        // presenting as a container that will not start.
        ...(spec.memorySwapBytes !== undefined &&
        spec.memorySwapBytes > 0 &&
        spec.memoryBytes !== undefined &&
        spec.memoryBytes > 0 &&
        spec.memorySwapBytes >= spec.memoryBytes
          ? { MemorySwap: spec.memorySwapBytes }
          : {}),
        ...(spec.nanoCpus !== undefined && spec.nanoCpus > 0 ? { NanoCpus: spec.nanoCpus } : {}),
        ...(ulimits.length
          ? {
              Ulimits: ulimits.map((limit) => ({
                Name: limit.name,
                Soft: limit.soft,
                Hard: limit.hard,
              })),
            }
          : {}),
        ...(spec.portBindings?.length ? { PortBindings: portBindings } : {}),
        ...(spec.restartPolicy !== undefined
          ? { RestartPolicy: { Name: spec.restartPolicy } }
          : {}),
      },
      Env: spec.env ?? [],
      ...(spec.user !== undefined ? { User: spec.user } : {}),
      ...(spec.entrypoint !== undefined ? { Entrypoint: spec.entrypoint } : {}),
      ...(spec.command !== undefined ? { Cmd: spec.command } : {}),
      ...(spec.openStdin !== undefined
        ? {
            OpenStdin: spec.openStdin,
            AttachStdin: spec.openStdin,
          }
        : {}),
    };
    const res = await callDocker(doFetch, url, 'POST', timeoutMs, body);
    if (!res.ok) {
      const err = await toDockerError(res);
      // 404 from /containers/create on a missing image — the image isn't present
      // locally yet; map it specifically so the provisioner catches it, calls
      // pullImage, and retries create once (ADR 0003 R6 / #299), rather than
      // treating it as a generic API 404.
      const payload = err.payload;
      if (payload.kind === 'other' && payload.status === 404) {
        throw new DockerError({
          kind: 'image_not_found',
          image: spec.image,
          message: payload.message,
        });
      }
      throw err;
    }
    const json = (await res.json()) as { Id?: unknown; Warnings?: unknown };
    if (typeof json.Id !== 'string' || json.Id === '') {
      throw new DockerError({
        kind: 'other',
        status: 200,
        message: 'missing Id in /containers/create response',
      });
    }
    const warnings = Array.isArray(json.Warnings)
      ? json.Warnings.filter((w): w is string => typeof w === 'string')
      : [];
    return { id: json.Id, warnings };
  };

  type RawContainer = {
    Name?: unknown;
    State?: unknown;
    Config?: Record<string, unknown>;
    HostConfig?: Record<string, unknown>;
    NetworkSettings?: { Networks?: Record<string, Record<string, unknown>> };
    Mounts?: Array<{
      Type?: unknown;
      Name?: unknown;
      Destination?: unknown;
      RW?: unknown;
    }>;
  };
  const rawContainer = async (id: string): Promise<RawContainer> => {
    const res = await callDocker(doFetch, `${base}/containers/${id}/json`, 'GET', timeoutMs);
    if (!res.ok) throw await toDockerError(res, id);
    return (await res.json()) as RawContainer;
  };
  const removeKeepingVolumes = async (id: string): Promise<void> => {
    const res = await callDocker(
      doFetch,
      `${base}/containers/${id}?force=true&v=false`,
      'DELETE',
      timeoutMs,
    );
    if (!res.ok) throw await toDockerError(res, id);
  };
  const createRawReplacement = async (
    name: string,
    image: string,
    original: RawContainer,
    sourceName: string,
    targetImageEnvironment?: readonly string[],
    labels?: Record<string, string>,
  ): Promise<string> => {
    const inherited = Array.isArray(original.Config?.Env)
      ? original.Config.Env.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const targetVersion = targetImageEnvironment?.find((entry) =>
      entry.startsWith('VERITY_SERVER_VERSION='),
    );
    const environment =
      targetVersion === undefined
        ? inherited
        : [
            ...inherited.filter((entry) => !entry.startsWith('VERITY_SERVER_VERSION=')),
            targetVersion,
          ];
    const config = {
      ...(original.Config ?? {}),
      Image: image,
      Hostname: '',
      ...(labels === undefined ? {} : { Labels: labels }),
      ...(environment.length > 0 ? { Env: environment } : {}),
    };
    for (const endpoint of Object.values(original.NetworkSettings?.Networks ?? {})) {
      const staticIpam = objectRecord(endpoint.IPAMConfig)
        ? Object.values(endpoint.IPAMConfig).some((value) => value !== '' && value !== null)
        : false;
      if (staticIpam || (Array.isArray(endpoint.LinkLocalIPs) && endpoint.LinkLocalIPs.length > 0))
        throw new Error('companion replacement does not support static network endpoint identity');
    }
    const endpoints = Object.fromEntries(
      Object.entries(original.NetworkSettings?.Networks ?? {}).map(([network, endpoint]) => [
        network,
        {
          ...(Array.isArray(endpoint.Aliases)
            ? {
                Aliases: endpoint.Aliases.filter(
                  (alias) =>
                    typeof alias === 'string' &&
                    alias !== sourceName &&
                    !/^[a-f0-9]{12,64}$/.test(alias),
                ),
              }
            : {}),
          ...(objectRecord(endpoint.DriverOpts) ? { DriverOpts: endpoint.DriverOpts } : {}),
        },
      ]),
    );
    const hostConfig = { ...(original.HostConfig ?? {}) };
    const configuredMounts = Array.isArray(hostConfig.Mounts)
      ? hostConfig.Mounts.filter(objectRecord)
      : [];
    // A container may declare the same volume through EITHER `Binds` or `Mounts`,
    // and the replacement inherits `Binds` verbatim above. Deduplicating against
    // `Mounts` alone therefore re-adds anything bound the other way, and the daemon
    // refuses the create with `Duplicate mount point: <target>`. That is how a
    // companion replacement died mid-update — the Gateways declare their volumes as
    // Binds (compose does), so every attempt to move them onto the new release left
    // the journal stuck at `reconciling-companions` with the Server already ahead of
    // the companions serving it.
    const configuredBindTargets = (Array.isArray(hostConfig.Binds) ? hostConfig.Binds : []).flatMap(
      (bind) => {
        // `source:target[:options]`, and a target is the only field that can collide.
        const target = typeof bind === 'string' ? (bind.split(':')[1] ?? '') : '';
        return target === '' ? [] : [target];
      },
    );
    const configuredTargets = new Set([
      ...configuredMounts
        .map((mount) => mount.Target)
        .filter((target): target is string => typeof target === 'string'),
      ...configuredBindTargets,
    ]);
    const preservedAnonymousVolumes = (original.Mounts ?? [])
      .filter(
        (mount) =>
          mount.Type === 'volume' &&
          typeof mount.Name === 'string' &&
          typeof mount.Destination === 'string' &&
          !configuredTargets.has(mount.Destination),
      )
      .map((mount) => ({
        Type: 'volume',
        Source: mount.Name,
        Target: mount.Destination,
        ReadOnly: mount.RW === false,
      }));
    if (configuredMounts.length > 0 || preservedAnonymousVolumes.length > 0)
      hostConfig.Mounts = [...configuredMounts, ...preservedAnonymousVolumes];
    const query = new URLSearchParams({ name });
    const res = await callDocker(
      doFetch,
      `${base}/containers/create?${query.toString()}`,
      'POST',
      timeoutMs,
      {
        ...config,
        HostConfig: hostConfig,
        ...(Object.keys(endpoints).length > 0
          ? { NetworkingConfig: { EndpointsConfig: endpoints } }
          : {}),
      },
    );
    if (!res.ok) throw await toDockerError(res);
    const created = (await res.json()) as { Id?: unknown };
    if (typeof created.Id !== 'string' || created.Id === '')
      throw new DockerError({
        kind: 'other',
        status: 200,
        message: 'missing Id in replacement create response',
      });
    return created.Id;
  };
  const objectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  return {
    createContainer,
    pullImage,
    startContainer: async (id) => {
      const res = await callDocker(doFetch, `${base}/containers/${id}/start`, 'POST', timeoutMs);
      if (!res.ok) throw await toDockerError(res, id);
    },
    waitContainer: async (id) => {
      const res = await callDocker(
        doFetch,
        `${base}/containers/${id}/wait?condition=not-running`,
        'POST',
        pullTimeoutMs,
      );
      if (!res.ok) throw await toDockerError(res, id);
      const json = (await res.json()) as { StatusCode?: unknown; Error?: { Message?: unknown } };
      if (typeof json.StatusCode !== 'number' || !Number.isSafeInteger(json.StatusCode)) {
        throw new DockerError({
          kind: 'other',
          status: 200,
          message: 'invalid container wait response',
        });
      }
      if (typeof json.Error?.Message === 'string' && json.Error.Message !== '') {
        throw new DockerError({
          kind: 'other',
          status: 200,
          message: 'container wait reported an error',
        });
      }
      return json.StatusCode;
    },
    containerLogs: async (id, tail) => {
      if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) {
        throw new TypeError('container log tail must be between 1 and 1000');
      }
      const query = new URLSearchParams({ stdout: '1', stderr: '1', tail: String(tail) });
      const res = await callDocker(
        doFetch,
        `${base}/containers/${id}/logs?${query.toString()}`,
        'GET',
        timeoutMs,
      );
      if (!res.ok) throw await toDockerError(res, id);
      // Reserve room for the decoder's explicit truncation marker.
      const body = await boundedResponseBytes(res, 64 * 1024 - 32);
      return decodeDockerLogFrames(body);
    },
    stopContainer: async (id) => {
      const res = await callDocker(doFetch, `${base}/containers/${id}/stop`, 'POST', timeoutMs);
      if (!res.ok) throw await toDockerError(res, id);
    },
    removeContainer: async (id) => {
      // `v=true` removes the anonymous volumes the daemon minted for this
      // container's image `VOLUME` instructions. Without it every teardown
      // orphans one (see the interface doc) and the host slowly fills with
      // dangling volumes that `docker system prune` does not touch. Named
      // volumes — including `verity-data`, where all durable per-project state
      // lives — are NOT affected by this flag.
      const res = await callDocker(
        doFetch,
        `${base}/containers/${id}?force=true&v=true`,
        'DELETE',
        timeoutMs,
      );
      if (!res.ok) throw await toDockerError(res, id);
    },
    replaceContainerImage: async (id, image, labels) => {
      const replacementForLabel = 'verity.replacement-for';
      const replacementNameLabel = 'verity.replacement-name';
      const findReplacement = async (): Promise<{ id: string; name: string } | undefined> => {
        const response = await callDocker(
          doFetch,
          `${base}/containers/json?all=true`,
          'GET',
          timeoutMs,
        );
        if (!response.ok) throw await toDockerError(response);
        const entries = (await response.json()) as Array<{
          Id?: unknown;
          Labels?: Record<string, unknown>;
        }>;
        const found = entries.find((entry) => entry.Labels?.[replacementForLabel] === id);
        const replacementId = found?.Id;
        const replacementName = found?.Labels?.[replacementNameLabel];
        return typeof replacementId === 'string' && typeof replacementName === 'string'
          ? { id: replacementId, name: replacementName }
          : undefined;
      };
      const startReplacement = async (replacementId: string): Promise<void> => {
        const start = await callDocker(
          doFetch,
          `${base}/containers/${replacementId}/start`,
          'POST',
          timeoutMs,
        );
        if (!start.ok && start.status !== 304) throw await toDockerError(start, replacementId);
      };
      const renameReplacement = async (replacementId: string, name: string): Promise<void> => {
        const rename = await callDocker(
          doFetch,
          `${base}/containers/${replacementId}/rename?name=${encodeURIComponent(name)}`,
          'POST',
          timeoutMs,
        );
        if (!rename.ok) throw await toDockerError(rename, replacementId);
      };
      let original: RawContainer;
      try {
        original = await rawContainer(id);
      } catch (error) {
        if (!(error instanceof DockerError) || error.kind !== 'container_not_found') throw error;
        const orphan = await findReplacement();
        if (orphan === undefined) throw error;
        await startReplacement(orphan.id);
        const orphanInspect = await rawContainer(orphan.id);
        const orphanName =
          typeof orphanInspect.Name === 'string'
            ? orphanInspect.Name.replace(/^\//, '')
            : undefined;
        if (orphanName !== orphan.name) await renameReplacement(orphan.id, orphan.name);
        return orphan.id;
      }
      const name =
        typeof original.Name === 'string' && original.Name.startsWith('/')
          ? original.Name.slice(1)
          : original.Name;
      if (typeof name !== 'string' || name === '')
        throw new Error('replacement source container has no valid name');
      let replacement = await findReplacement();
      if (replacement === undefined) {
        const inspectTarget = (): Promise<HttpResponse> =>
          callDocker(doFetch, `${base}/images/${encodeURIComponent(image)}/json`, 'GET', timeoutMs);
        let target = await inspectTarget();
        // A DIGEST-PINNED ref the daemon already holds is, by construction,
        // exactly these bytes: pulling it again can only re-confirm what content
        // addressing has already proven, at the cost of a registry round-trip.
        // That cost is not neutral. Every caller of this method replaces a live
        // piece of the deployment, and the control-plane PostgreSQL swap (ADR
        // 0008 D14) does it inside a maintenance window whose whole
        // justification is that nothing in it waits on the network — it
        // pre-pulls during preparation precisely so this call has nothing left
        // to fetch, and an implicit pull here made that guarantee false.
        // A TAG is a moving name and is still always pulled.
        if (!(target.ok && DIGEST_PINNED_IMAGE.test(image))) {
          await pullImage(image);
          target = await inspectTarget();
        }
        if (!target.ok) throw await toDockerError(target);
        const targetJson = (await target.json()) as {
          Config?: { Env?: unknown; Labels?: unknown };
        };
        const targetEnvironment = Array.isArray(targetJson.Config?.Env)
          ? targetJson.Config.Env.filter((entry): entry is string => typeof entry === 'string')
          : [];
        // The daemon seeds a container's labels from its image's at CREATE time
        // and never revisits them, so a replacement that inherits the
        // predecessor's set verbatim keeps describing the predecessor's IMAGE —
        // `org.opencontainers.image.version`, `.revision`, and every other label
        // the release build bakes in. That is not cosmetic: fleet inspection
        // reads exactly these, and a container demonstrably running v13.5.0 while
        // reporting v13.3.2 is a wrong-but-plausible signal, the most expensive
        // kind. So re-seed from the TARGET image and let it win over the
        // inherited copy, which is what the daemon would have done had this been
        // an ordinary create. Two things deliberately survive: labels the image
        // does not define — `com.docker.compose.*`, `verity.managed-role`,
        // `verity.managed-deployment-id` — because they describe the container's
        // place in the deployment rather than its bytes; and the caller's own
        // labels, applied last. It is also self-healing: a container already
        // carrying a stale value from an earlier replacement is corrected by the
        // next one, rather than inheriting the staleness forever.
        const inheritedLabels = objectRecord(original.Config?.Labels)
          ? Object.fromEntries(
              Object.entries(original.Config.Labels).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            )
          : {};
        const targetImageLabels = parseDockerLabels(targetJson.Config?.Labels) ?? {};
        const replacementId = await createRawReplacement(
          `${name}-replacement-${id.slice(0, 12)}`,
          image,
          original,
          name,
          targetEnvironment,
          {
            ...inheritedLabels,
            ...targetImageLabels,
            ...(labels ?? {}),
            [replacementForLabel]: id,
            [replacementNameLabel]: name,
          },
        );
        replacement = { id: replacementId, name };
      }
      const stop = await callDocker(doFetch, `${base}/containers/${id}/stop`, 'POST', timeoutMs);
      if (!stop.ok && stop.status !== 304) throw await toDockerError(stop, id);
      try {
        await startReplacement(replacement.id);
      } catch (error) {
        const restart = await callDocker(
          doFetch,
          `${base}/containers/${id}/start`,
          'POST',
          timeoutMs,
        );
        if (!restart.ok && restart.status !== 304)
          throw new AggregateError(
            [error, await toDockerError(restart, id)],
            'companion replacement failed and its predecessor could not be restarted',
            { cause: error },
          );
        await removeKeepingVolumes(replacement.id).catch(() => undefined);
        throw error;
      }
      // A stopped container releases its published ports (verified by the live
      // Docker regression), so the prepared successor can prove readiness while
      // the complete predecessor still exists for rollback.
      for (let sample = 0; sample < 60; sample += 1) {
        const candidate = await rawContainer(replacement.id);
        const state = candidate.State as
          { Running?: unknown; Health?: { Status?: unknown } } | undefined;
        if (state?.Running !== true || state.Health?.Status === 'unhealthy') {
          await removeKeepingVolumes(replacement.id).catch(() => undefined);
          const restart = await callDocker(
            doFetch,
            `${base}/containers/${id}/start`,
            'POST',
            timeoutMs,
          );
          if (!restart.ok && restart.status !== 304) throw await toDockerError(restart, id);
          throw new Error('replacement container failed its startup readiness window');
        }
        if (state.Health?.Status === 'healthy' || (state.Health === undefined && sample >= 3))
          break;
        if (sample === 59) {
          await removeKeepingVolumes(replacement.id).catch(() => undefined);
          const restart = await callDocker(
            doFetch,
            `${base}/containers/${id}/start`,
            'POST',
            timeoutMs,
          );
          if (!restart.ok && restart.status !== 304) throw await toDockerError(restart, id);
          throw new Error('replacement container did not become healthy');
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const desiredName = replacement.name;
      const predecessorName = `${desiredName}-predecessor-${id.slice(0, 12)}`;
      const currentPredecessor = await rawContainer(id);
      const currentPredecessorName =
        typeof currentPredecessor.Name === 'string'
          ? currentPredecessor.Name.replace(/^\//, '')
          : undefined;
      if (currentPredecessorName !== predecessorName) await renameReplacement(id, predecessorName);
      try {
        const currentReplacement = await rawContainer(replacement.id);
        const currentReplacementName =
          typeof currentReplacement.Name === 'string'
            ? currentReplacement.Name.replace(/^\//, '')
            : undefined;
        if (currentReplacementName !== desiredName)
          await renameReplacement(replacement.id, desiredName);
      } catch (error) {
        await renameReplacement(id, desiredName).catch(() => undefined);
        await callDocker(
          doFetch,
          `${base}/containers/${replacement.id}/stop`,
          'POST',
          timeoutMs,
        ).catch(() => undefined);
        await removeKeepingVolumes(replacement.id).catch(() => undefined);
        const restart = await callDocker(
          doFetch,
          `${base}/containers/${id}/start`,
          'POST',
          timeoutMs,
        );
        if (!restart.ok && restart.status !== 304)
          throw new AggregateError(
            [error, await toDockerError(restart, id)],
            'companion rename failed and its predecessor could not be restarted',
            { cause: error },
          );
        throw error;
      }
      // Cleanup happens last. If it fails, the successor is already healthy at
      // the canonical name and the marked predecessor remains recoverable; the
      // journal stays in progress and the next retry removes it.
      await removeKeepingVolumes(id);
      return replacement.id;
    },
    inspectContainer: async (id) => {
      const res = await callDocker(doFetch, `${base}/containers/${id}/json`, 'GET', timeoutMs);
      if (!res.ok) throw await toDockerError(res, id);
      const json = (await res.json()) as {
        Id?: unknown;
        State?: { Running?: unknown; Status?: unknown; Health?: { Status?: unknown } };
        Config?: {
          Image?: unknown;
          Labels?: unknown;
          User?: unknown;
          Env?: unknown;
          Entrypoint?: unknown;
          Cmd?: unknown;
          OpenStdin?: unknown;
        };
        NetworkSettings?: { Networks?: unknown };
        HostConfig?: {
          Runtime?: unknown;
          NetworkMode?: unknown;
          ReadonlyRootfs?: unknown;
          Tmpfs?: unknown;
          CapDrop?: unknown;
          SecurityOpt?: unknown;
          PidsLimit?: unknown;
          Memory?: unknown;
          MemorySwap?: unknown;
          NanoCpus?: unknown;
          Privileged?: unknown;
          CapAdd?: unknown;
          GroupAdd?: unknown;
          Devices?: unknown;
          DeviceRequests?: unknown;
          RestartPolicy?: { Name?: unknown };
          Init?: unknown;
        };
        Mounts?: unknown;
      };
      if (typeof json.Id !== 'string') {
        throw new DockerError({
          kind: 'other',
          status: 200,
          message: 'missing Id in /containers/{id}/json',
        });
      }
      const labels = parseDockerLabels(json.Config?.Labels);
      const deviceCount = dockerDeviceCount(
        json.HostConfig?.Devices,
        json.HostConfig?.DeviceRequests,
      );
      const networks =
        typeof json.NetworkSettings?.Networks === 'object' && json.NetworkSettings.Networks !== null
          ? Object.fromEntries(
              Object.entries(json.NetworkSettings.Networks)
                .map(([name, value]) => {
                  if (typeof value !== 'object' || value === null) return undefined;
                  const ipAddress = (value as { IPAddress?: unknown }).IPAddress;
                  return [
                    name,
                    {
                      ...(typeof ipAddress === 'string' && ipAddress !== '' ? { ipAddress } : {}),
                    },
                  ] as const;
                })
                .filter((entry): entry is readonly [string, { ipAddress?: string }] =>
                  Array.isArray(entry),
                ),
            )
          : undefined;
      return {
        id: json.Id,
        running: json.State?.Running === true,
        ...(typeof json.Config?.Image === 'string' ? { image: json.Config.Image } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(networks !== undefined ? { networks } : {}),
        ...(typeof json.Config?.User === 'string' ? { user: json.Config.User } : {}),
        ...(typeof json.HostConfig?.Runtime === 'string'
          ? { runtime: json.HostConfig.Runtime }
          : {}),
        ...(typeof json.State?.Status === 'string' ? { status: json.State.Status } : {}),
        ...(typeof json.State?.Health?.Status === 'string'
          ? { healthStatus: json.State.Health.Status }
          : {}),
        ...(typeof json.HostConfig?.NetworkMode === 'string'
          ? { networkMode: json.HostConfig.NetworkMode }
          : {}),
        ...(typeof json.HostConfig?.ReadonlyRootfs === 'boolean'
          ? { readOnlyRootfs: json.HostConfig.ReadonlyRootfs }
          : {}),
        ...(isStringRecord(json.HostConfig?.Tmpfs) ? { tmpfs: json.HostConfig.Tmpfs } : {}),
        ...(isStringArray(json.HostConfig?.CapDrop) ? { capDrop: json.HostConfig.CapDrop } : {}),
        ...(isStringArray(json.HostConfig?.SecurityOpt)
          ? { securityOpt: json.HostConfig.SecurityOpt }
          : {}),
        ...(typeof json.HostConfig?.PidsLimit === 'number'
          ? { pidsLimit: json.HostConfig.PidsLimit }
          : {}),
        ...(typeof json.HostConfig?.Memory === 'number'
          ? { memoryBytes: json.HostConfig.Memory }
          : {}),
        ...(typeof json.HostConfig?.MemorySwap === 'number'
          ? { memorySwapBytes: json.HostConfig.MemorySwap }
          : {}),
        ...(typeof json.HostConfig?.NanoCpus === 'number'
          ? { nanoCpus: json.HostConfig.NanoCpus }
          : {}),
        ...(isStringArray(json.Config?.Env) ? { env: json.Config.Env } : {}),
        ...(Array.isArray(json.Mounts)
          ? {
              mountCount: json.Mounts.length,
              mounts: json.Mounts.flatMap((mount) => {
                if (typeof mount !== 'object' || mount === null) return [];
                const value = mount as {
                  Type?: unknown;
                  Name?: unknown;
                  Source?: unknown;
                  Destination?: unknown;
                  RW?: unknown;
                };
                return [
                  {
                    ...(typeof value.Type === 'string' ? { type: value.Type } : {}),
                    ...(typeof value.Name === 'string' ? { name: value.Name } : {}),
                    ...(typeof value.Source === 'string' ? { source: value.Source } : {}),
                    ...(typeof value.Destination === 'string'
                      ? { destination: value.Destination }
                      : {}),
                    ...(typeof value.RW === 'boolean' ? { readWrite: value.RW } : {}),
                  },
                ];
              }),
            }
          : {}),
        ...(typeof json.HostConfig?.Privileged === 'boolean'
          ? { privileged: json.HostConfig.Privileged }
          : {}),
        ...(isStringArray(json.HostConfig?.CapAdd) ? { capAdd: json.HostConfig.CapAdd } : {}),
        ...(isStringArray(json.HostConfig?.GroupAdd) ? { groupAdd: json.HostConfig.GroupAdd } : {}),
        ...(deviceCount !== undefined ? { deviceCount } : {}),
        ...(typeof json.HostConfig?.RestartPolicy?.Name === 'string'
          ? { restartPolicy: json.HostConfig.RestartPolicy.Name }
          : {}),
        ...(isStringArray(json.Config?.Entrypoint) ? { entrypoint: json.Config.Entrypoint } : {}),
        ...(isStringArray(json.Config?.Cmd) ? { command: json.Config.Cmd } : {}),
        ...(typeof json.Config?.OpenStdin === 'boolean'
          ? { openStdin: json.Config.OpenStdin }
          : {}),
        ...(typeof json.HostConfig?.Init === 'boolean' ? { init: json.HostConfig.Init } : {}),
      };
    },
    inspectRuntime: async (name) => {
      const res = await callDocker(doFetch, `${base}/info`, 'GET', timeoutMs);
      if (!res.ok) throw await toDockerError(res);
      const json = (await res.json()) as { Runtimes?: unknown };
      if (typeof json.Runtimes !== 'object' || json.Runtimes === null) return undefined;
      const runtime = (json.Runtimes as Record<string, unknown>)[name];
      if (typeof runtime !== 'object' || runtime === null) return undefined;
      const candidate = runtime as { path?: unknown; runtimeArgs?: unknown };
      if (typeof candidate.path !== 'string' || !isStringArray(candidate.runtimeArgs)) {
        throw new DockerError({
          kind: 'other',
          status: 200,
          message: `invalid runtime registration for ${name}`,
        });
      }
      return { path: candidate.path, args: candidate.runtimeArgs };
    },
    imageExists: async (ref) => {
      // GET /images/{ref}/json — 200 = present, 404 = absent (the daemon reports
      // a missing image as 404, distinct from a real API/network fault). Any
      // other non-2xx surfaces as a typed DockerError so the caller can fail
      // loudly rather than mis-reading a 5xx as "image absent" and rebuilding.
      const res = await callDocker(
        doFetch,
        `${base}/images/${encodeURIComponent(ref)}/json`,
        'GET',
        timeoutMs,
      );
      if (res.ok) return true;
      if (res.status === 404) return false;
      throw await toDockerError(res);
    },
    inspectImageLabels: async (ref) => {
      const res = await callDocker(
        doFetch,
        `${base}/images/${encodeURIComponent(ref)}/json`,
        'GET',
        timeoutMs,
      );
      if (res.status === 404) return undefined;
      if (!res.ok) throw await toDockerError(res);
      const json = (await res.json()) as { Config?: { Labels?: unknown } };
      return parseDockerLabels(json.Config?.Labels);
    },
    inspectImageEnv: async (ref) => {
      const res = await callDocker(
        doFetch,
        `${base}/images/${encodeURIComponent(ref)}/json`,
        'GET',
        timeoutMs,
      );
      if (res.status === 404) return undefined;
      if (!res.ok) throw await toDockerError(res);
      const json = (await res.json()) as { Config?: { Env?: unknown } };
      return isStringArray(json.Config?.Env) ? json.Config.Env : [];
    },
    ensureNetwork: async (name, opts) => {
      // POST /networks/create. A user-defined bridge (egress stays open — H2 blocks
      // only lateral movement, not egress). Idempotent: a 409 means it already
      // exists, which is exactly the desired end state.
      const res = await callDocker(doFetch, `${base}/networks/create`, 'POST', timeoutMs, {
        Name: name,
        Driver: 'bridge',
        ...(opts?.labels !== undefined ? { Labels: opts.labels } : {}),
      });
      if (res.ok || res.status === 409) return;
      throw await toDockerError(res);
    },
    listImages: async () => {
      const res = await callDocker(doFetch, `${base}/images/json`, 'GET', timeoutMs);
      if (!res.ok) throw await toDockerError(res);
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      return json.flatMap((entry): DockerImageSummary[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { Id, RepoTags, Created, Size } = entry as Record<string, unknown>;
        if (typeof Id !== 'string') return [];
        return [
          {
            id: Id,
            // `RepoTags` is null for an untagged image and can carry the
            // `<none>:<none>` placeholder — neither is a usable ref, so drop both
            // and let such images fall out as untagged.
            repoTags: isStringArray(RepoTags)
              ? RepoTags.filter((tag) => tag !== '<none>:<none>')
              : [],
            created: typeof Created === 'number' ? Created : 0,
            size: typeof Size === 'number' ? Size : 0,
          },
        ];
      });
    },
    removeImage: async (ref) => {
      const res = await callDocker(
        doFetch,
        `${base}/images/${encodeURIComponent(ref)}`,
        'DELETE',
        timeoutMs,
      );
      // 404 → another sweep (or an operator) already removed it; that is the
      // desired end state, so treat it as success rather than failing the pass.
      if (res.ok || res.status === 404) return;
      throw await toDockerError(res);
    },
    listContainers: async () => {
      const res = await callDocker(doFetch, `${base}/containers/json?all=true`, 'GET', timeoutMs);
      if (!res.ok) throw await toDockerError(res);
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      return json.flatMap((entry): DockerContainerSummary[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { Id, ImageID, Names, Labels, Created } = entry as Record<string, unknown>;
        if (typeof Id !== 'string' || typeof ImageID !== 'string') return [];
        const names = Array.isArray(Names)
          ? Names.filter((name): name is string => typeof name === 'string').map((name) =>
              name.replace(/^\//, ''),
            )
          : [];
        return [
          {
            id: Id,
            imageId: ImageID,
            names,
            labels: parseDockerLabels(Labels) ?? {},
            ...(typeof Created === 'number' ? { created: Created } : {}),
          },
        ];
      });
    },
    listVolumes: async (opts) => {
      const filters =
        opts?.danglingOnly === true
          ? `?filters=${encodeURIComponent(JSON.stringify({ dangling: ['true'] }))}`
          : '';
      const res = await callDocker(doFetch, `${base}/volumes${filters}`, 'GET', timeoutMs);
      if (!res.ok) throw await toDockerError(res);
      const json = (await res.json()) as { Volumes?: unknown };
      if (!Array.isArray(json.Volumes)) return [];
      return json.Volumes.flatMap((entry): DockerVolumeSummary[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { Name, Labels, CreatedAt } = entry as Record<string, unknown>;
        if (typeof Name !== 'string') return [];
        return [
          {
            name: Name,
            labels: parseDockerLabels(Labels) ?? {},
            ...(typeof CreatedAt === 'string' ? { createdAt: CreatedAt } : {}),
          },
        ];
      });
    },
    removeVolume: async (name) => {
      const res = await callDocker(
        doFetch,
        `${base}/volumes/${encodeURIComponent(name)}`,
        'DELETE',
        timeoutMs,
      );
      // 404 → already gone (idempotent, same reasoning as removeImage).
      if (res.ok || res.status === 404) return;
      throw await toDockerError(res);
    },
    pruneBuildCache: async (opts) => {
      const filters =
        opts?.untilHours !== undefined
          ? `&filters=${encodeURIComponent(JSON.stringify({ until: [`${opts.untilHours}h`] }))}`
          : '';
      // `all=true` reaches cache the daemon considers "in use by an image" too;
      // the `until` filter is what keeps recent, still-useful cache alive.
      const res = await callDocker(
        doFetch,
        `${base}/build/prune?all=true${filters}`,
        'POST',
        timeoutMs,
      );
      if (!res.ok) throw await toDockerError(res);
      const json = (await res.json()) as { SpaceReclaimed?: unknown };
      return typeof json.SpaceReclaimed === 'number' ? json.SpaceReclaimed : 0;
    },
  };
}
