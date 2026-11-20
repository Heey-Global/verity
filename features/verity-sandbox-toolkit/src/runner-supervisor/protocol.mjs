import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { constants as osConstants } from 'node:os';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { readTurnState, syncDirectory } from './turn-state.mjs';

/** Partial or stale toolkit installations must retain the legacy runtime prompt. */
export async function installedSkillsManifestHash(seedRoot = '/opt/agent-seed') {
  try {
    if (!(await lstat(join(seedRoot, 'bin/verity'))).isFile()) return undefined;
    const bytes = await readFile(join(seedRoot, 'skills-manifest.json'));
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (
      createHash('sha256')
        .update(await readFile(join(seedRoot, 'bin/verity')))
        .digest('hex') !== manifest.dispatcher
    )
      return undefined;
    if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object')
      return undefined;
    const files = Object.entries(manifest.files);
    if (!files.length) return undefined;
    for (const [path, digest] of files) {
      if (!/^[a-z]+(?:-[a-z]+)*\/SKILL\.md$/.test(path) || typeof digest !== 'string')
        return undefined;
      const target = join(seedRoot, 'skills', path);
      if (!(await lstat(dirname(target))).isDirectory() || !(await lstat(target)).isFile())
        return undefined;
      if (
        createHash('sha256')
          .update(await readFile(target))
          .digest('hex') !== digest
      )
        return undefined;
    }
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

export async function installedSkillsVersion(seedRoot = '/opt/agent-seed') {
  return (await installedSkillsManifestHash(seedRoot)) ? 1 : 0;
}

export const SUPERVISOR_PROTOCOL_VERSION = 1;
/**
 * The oldest Server dialect this supervisor still answers — ADR 0006 D9.
 *
 * The Server writes its requests at ITS floor, because every supervisor already
 * deployed compares the version for equality and a request in a newer dialect
 * would simply be refused. A supervisor must therefore read the range in return,
 * or the first genuine bump breaks the pair from whichever side moved first.
 *
 * Equal to {@link SUPERVISOR_PROTOCOL_VERSION} today, so nothing changes yet.
 */
export const MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION = 1;

/** Whether a request written by a Server this supervisor did not ship with is one
 *  it still understands. */
export function supportedRequestVersion(value) {
  return (
    Number.isInteger(value) &&
    value >= MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION &&
    value <= SUPERVISOR_PROTOCOL_VERSION
  );
}
export const DEFAULT_RUNTIME_DIR = '/run/verity-runner';
export const DEFAULT_SCRIPT_SANDBOX_PATH = '/usr/local/bin/verity-script-sandbox';
export const SCRIPT_ISOLATION_UNAVAILABLE_ERROR = 'worktree script isolation is unavailable';
const SCRIPT_SANDBOX_PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether the kernel under this container enforces the script sandbox's
 * filesystem policy. Kept in step with `probeScriptSandbox` in verity-agent-spawn-broker.mjs;
 * the two are separate installed executables and cannot share a module.
 *
 * The supervisor asks for itself rather than trusting a file the launcher left
 * behind, and only to refuse early and to report the capability in `status`: the
 * broker re-checks, and the helper refuses to launch anything it cannot confine.
 */
export async function probeScriptSandbox(
  helperPath = DEFAULT_SCRIPT_SANDBOX_PATH,
  timeoutMs = SCRIPT_SANDBOX_PROBE_TIMEOUT_MS,
) {
  return await new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn(helperPath, ['--probe'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: timeoutMs,
      });
    } catch {
      resolveProbe({ available: false, reason: 'script sandbox helper could not be started' });
      return;
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 512) stderr += chunk;
    });
    child.once('error', () =>
      resolveProbe({ available: false, reason: 'script sandbox helper could not be started' }),
    );
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveProbe({ available: true });
        return;
      }
      const line = stderr.split('\n', 1)[0].trim().slice(0, 256);
      resolveProbe({
        available: false,
        reason:
          line !== ''
            ? line
            : `script sandbox probe exited with ${signal === null ? `code ${String(code)}` : signal}`,
      });
    });
  });
}
// Bounds the ENTIRE start-turn request (inline image base64 included) and, via
// MAX_CONTROL_LINE_BYTES, the per-connection frame-reader buffer — so it is also the
// supervisor's memory/DoS bound, not only an attachment limit. KNOWN DIVERGENCE: the
// Server accepts larger single images than this (MAX_ATTACHMENT_BASE64_LEN ≈ 7 MB ×
// up to 8, packages/server/src/server.ts), and the in-process runner streams them
// uncapped. A large screenshot that works in-process is therefore rejected — cleanly,
// never truncated — on the supervisor path. Raising this is a deliberate follow-up
// (it widens the shared frame-reader/DoS bound), tracked for the Stage-5c cutover.
// Until then the Server refuses an over-cap frame BEFORE writing it, against its own
// 1:1 copy of this number (MAX_SUPERVISOR_REQUEST_BYTES in
// packages/session/src/runner-supervisor-client.ts) — keep the two in step.
export const MAX_START_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_CONTROL_LINE_BYTES = MAX_START_REQUEST_BYTES + 1;
// How long a refused peer may keep streaming the payload we already rejected before
// the connection is dropped anyway. Long enough for a multi-megabyte write to drain
// over a Unix socket, short enough that a stalled peer cannot hold the slot.
export const OVERSIZE_DRAIN_GRACE_MS = 2_000;
/** 32 random bytes as unpadded base64url, as minted by the Server's turn credentials. */
export const TURN_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The person a turn's commits are authored by (see packages/session/src/git-author.ts,
 * which this mirrors). It travels as its own request field: older peers enforce
 * the `sessionEnv` key list but ignore unknown fields. Angle brackets and control
 * characters could forge a second identity line in a commit header.
 */
export function isGitAuthor(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { name, email } = value;
  return (
    Object.keys(value).length === 2 &&
    typeof name === 'string' &&
    typeof email === 'string' &&
    name.trim().length > 0 &&
    Buffer.byteLength(name) <= 200 &&
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    /^[^\u0000-\u001f\u007f<>]+$/u.test(name) &&
    Buffer.byteLength(email) <= 320 &&
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    /^[^\s\u0000-\u001f\u007f<>@]+@[^\s\u0000-\u001f\u007f<>@]+$/u.test(email)
  );
}
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
// What the start-turn request validator will parse at all — the outermost gate, wider
// than what any given supervisor was launched for (`workerBackends`). It currently
// holds the same three names as ACP_WORKER_BACKENDS below. That is a
// coincidence of the current fleet, not an identity: the two answer different questions
// ("is this a backend name" vs. "may it spend the operator's secrets"), and they are
// kept as separate literals for the same reason the next set is — see below.
export const WORKER_BACKENDS = new Set(['claude-acp', 'codex-acp', 'opencode-acp']);
// The transports that reach the brokered Verity tools over the loopback MCP gateway
// (ADR 0014 D1). Only these may
// carry a gateway bearer on start-turn.
//
// `opencode-acp` joined them with ADR 0014 Amendment 4: which agents may spend the
// operator's secrets is a decision, and that decision has now been taken for
// OpenCode. It is still NOT the same question as "is this ACP" — a fourth adapter
// has to be admitted here deliberately, not by speaking the protocol. The gates
// stay separate literals so none can drift into the others by accident: this set,
// `carriesBrokeredSecretTools` (packages/session/src/turn-system-prompt.ts), the
// `acpBackend` flag that decides whether a bearer is minted at all
// (packages/session/src/runner-supervisor-client.ts), and the two independent
// re-checks in packages/session/src/runner-worker-entry.ts. They must agree; a
// member added to one alone refuses the turn it was meant to admit.
export const ACP_WORKER_BACKENDS = new Set(['claude-acp', 'codex-acp', 'opencode-acp']);
// The subset of WORKER_BACKENDS that the PRODUCTION supervisor actually launches.
// A start-turn for any backend outside this set is rejected at runtime (see the
// workerBackends gate below), so it is the real capability boundary — distinct
// from WORKER_BACKENDS, which only bounds what the request validator will parse.
// All three ACP transports cross the process boundary as a setpriv'd CLI child
// spawned through the root broker
// (packages/session/src/runner-worker-entry.ts).
// Every parseable backend is launchable today, so this set and WORKER_BACKENDS coincide
// as well. A backend with no worker adapter — no argv, no child to spawn, the position
// OpenCode held as a long-lived HTTP server client before `opencode acp` (ADR 0012
// Amendment 4) — stays on the loopback path and MUST NOT be listed here, or its turns
// would fail at start-turn. There is no such backend at the moment; this boundary
// remains explicit for future adapters.
export const SUPERVISED_WORKER_BACKENDS = Object.freeze([
  'claude-acp',
  'codex-acp',
  'opencode-acp',
]);
/**
 * What each supervised backend needs the IMAGE to carry — the same absolute paths
 * the spawn broker execs (`agentLaunchSpec` in verity-agent-spawn-broker.mjs), and
 * they have to stay in step with it: a path that is right here and wrong there
 * refuses a turn the image could have run.
 */
const WORKER_BACKEND_EXECUTABLES = Object.freeze({
  'claude-acp': '/usr/local/bin/claude-agent-acp',
  'codex-acp': '/usr/local/bin/codex-acp',
  'opencode-acp': '/usr/local/bin/opencode-acp',
});
/**
 * {@link SUPERVISED_WORKER_BACKENDS} narrowed to what this image actually installed.
 * The constant above is a property of the Feature's SOURCE, while the agent CLIs are
 * opt-in at build time (`INSTALL_OPENCODE` and friends in install.sh), so the two
 * disagree on any image built without one of them. Advertising a backend the image
 * cannot start turns a clear refusal into `setpriv: failed to execute …` after the
 * turn has already been claimed — the same symptom for "never installed" as for a
 * genuinely broken image, and neither readable from the chat.
 *
 * Identity is the broker's question, but the supervisor must at least prove the
 * path is an executable regular file before advertising it.
 */
export function installedWorkerBackends(
  executable = (path) => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
) {
  return SUPERVISED_WORKER_BACKENDS.filter((backend) =>
    executable(WORKER_BACKEND_EXECUTABLES[backend]),
  );
}
// The env the PRODUCTION supervisor hands its workers. A worker is spawned with an
// explicit env — `process.env` is deliberately NOT spread across that boundary — so
// every variable the worker reads has to be named here or it simply is not there.
// `VERITY_MCP_GATEWAY_URL` was not, and the worker drops the MCP gateway when it has
// no URL to offer (packages/session/src/runner-worker-entry.ts): an ACP turn that had
// been issued a gateway bearer still started its agent with an EMPTY mcpServers list,
// so the brokered Verity tools were absent from the session altogether. The supervisor
// inherits the container env the provisioner sets, which is the only place this URL
// exists. Empty is treated as absent — a blank URL would be offered to the agent as a
// server it can never reach.
export function supervisorWorkerEnv(environment) {
  const brokerSocket = environment.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  const mcpGatewayUrl = environment.VERITY_MCP_GATEWAY_URL;
  const controlMemoryUrl = environment.VERITY_CONTROL_MEMORY_URL;
  return {
    ...(controlMemoryUrl === undefined || controlMemoryUrl === ''
      ? {}
      : { VERITY_CONTROL_MEMORY_URL: controlMemoryUrl }),
    ...(brokerSocket === undefined || brokerSocket === ''
      ? {}
      : { VERITY_AGENT_SPAWN_BROKER_SOCKET: brokerSocket }),
    ...(mcpGatewayUrl === undefined || mcpGatewayUrl === ''
      ? {}
      : { VERITY_MCP_GATEWAY_URL: mcpGatewayUrl }),
  };
}
// Image attachments are the only upload kind that survives to the runner: file
// uploads are materialized to disk + reduced to a prompt suffix server-side before
// launch (packages/session/src/file-attachments.ts), so only staged image references
// cross the start-turn protocol. Kept 1:1 with @verity/events imageMediaTypeSchema.
export const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// Matches the Server's per-turn upload cap (packages/server/src/server.ts). The total
// image bytes are bounded independently from the remaining request text.
export const MAX_START_ATTACHMENTS = 8;
export const MAX_WORKER_ERROR_BYTES = 16 * 1024;
export const WORKER_ERROR_DRAIN_TIMEOUT_MS = 100;
// How long a rejected start waits for its SIGKILLed worker to actually go, before it
// releases the worker lock. SIGKILL is not refusable, so this is a scheduling margin
// rather than a grace period — but it is bounded, because a turn that cannot be ended
// still has to be reported rather than held.
export const REJECTED_WORKER_EXIT_WAIT_MS = 2_000;
const MAX_TRUSTED_CLI_OUTPUT_BYTES = 24 * 1024;
// Mirrors MAX_TRUSTED_CLI_SECRETS in packages/secret-contracts/src/tool.ts. The
// contract already bounded the request; this is the in-container half of the
// same bound, because the supervisor validates what reaches it rather than
// trusting the sender.
const MAX_TRUSTED_CLI_SECRETS = 8;
export const TRUSTED_CLI_TIMEOUT_MS = 30 * 60 * 1_000;
export const TRUSTED_CLI_KILL_GRACE_MS = 5_000;
export const SUPERVISOR_REQUEST_GRACE_MS = 10_000;

/**
 * How many turn starts may be spawning at once.
 *
 * A start is not cheap: it fsyncs the claim, writes `request.json`, spawns a
 * `flock` child for the worker lock, then spawns the worker itself. Letting an
 * unbounded burst of them run concurrently is how a host under CPU pressure turns
 * every start slow at once — each one waiting on the others' fsyncs and forks.
 * Bounding concurrency makes the wait a QUEUE, which is measurable and bounded,
 * instead of contention, which is neither.
 */
export const MAX_CONCURRENT_STARTS = 4;
/**
 * How many starts may be waiting for one of those slots. Beyond this the
 * supervisor refuses explicitly rather than accepting work it cannot get to —
 * a refusal the Server can show, instead of a timeout it has to guess about.
 *
 * Deep against four slots on purpose, and still well inside the Server's start
 * budget: what occupies a slot is the SPAWN, not the turn. `startImpl` returns once
 * the worker is up — tens of milliseconds of fsync and fork, not the minutes the
 * agent then runs for — so a full queue drains in `64 / 4` spawns, not in 64 turns.
 * A cap tuned to the budget instead would have to assume a spawn latency, and would
 * refuse healthy bursts on a host that is merely briefly slow.
 */
export const MAX_QUEUED_STARTS = 64;
/** The `frameSeq` a synthesized terminal frame claims. Only ever written to an
 *  EMPTY stream, so 1 is both correct and the only contiguous choice (ADR 0006 D3). */
const SYNTHETIC_TERMINAL_FRAME_SEQ = 1;
/** Kept 1:1 with RUNNER_FRAME_PROTOCOL_VERSION in @verity/store. */
const RUNNER_FRAME_PROTOCOL_VERSION = 1;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Redact every secret the run carried, longest value first.
 *
 * Order is load-bearing once there is more than one: a short secret that also
 * occurs inside a longer one would replace the prefix and leave the remainder of
 * the longer secret in the output. Sorting across ALL variants of ALL secrets —
 * not per secret — is what keeps that property.
 */
export function redactTrustedCliText(bytes, secrets) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '[output withheld: undecodable]';
  }
  const variants = (Array.isArray(secrets) ? secrets : [secrets])
    .flatMap((secret) => [
      secret,
      Buffer.from(secret, 'utf8').toString('base64'),
      encodeURIComponent(secret),
    ])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const value of new Set(variants)) {
    text = text.split(value).join('[REDACTED]');
  }
  return text;
}

function isValidTrustedCliSecret(secret) {
  return (
    isObject(secret) &&
    typeof secret.secretAlias === 'string' &&
    /^[A-Z][A-Z0-9_]*$/u.test(secret.secretAlias) &&
    typeof secret.env === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(secret.env) &&
    typeof secret.secret === 'string' &&
    secret.secret.length > 0 &&
    !secret.secret.includes('\0') &&
    Buffer.byteLength(secret.secret) <= 1024 * 1024 &&
    (secret.injection === undefined || secret.injection === 'env' || secret.injection === 'file') &&
    (secret.encoding === undefined || (secret.injection === 'file' && secret.encoding === 'base64'))
  );
}

/**
 * Accept the flat single-secret shape a pre-`secrets` server still sends.
 *
 * The request crosses from the server into the sandbox, and the two deploy
 * separately, so every rollout has a window where the versions differ. Without
 * this the window is not merely awkward but unserviceable in both directions: a
 * new image rejects every call from an older server, and an older image rejects
 * every call from a new one. Tolerating the old shape here makes "ship the image
 * first" (ADR 0011) an ordering that actually works.
 *
 * Delete once no deployed server sends the flat shape.
 */
function normalizeTrustedCliRequest(request) {
  if (!isObject(request) || Array.isArray(request.secrets) || typeof request.secret !== 'string') {
    return request;
  }
  const { secret, secretAlias, env, injection, ...rest } = request;
  // The value now lives only in the entry below, which finish() zeroes.
  request.secret = '';
  return {
    ...rest,
    secrets: [{ secretAlias, env, ...(injection === undefined ? {} : { injection }), secret }],
  };
}

export async function runTrustedCliViaBroker(rawRequest, options = {}) {
  const request = normalizeTrustedCliRequest(rawRequest);
  if (
    !isObject(request) ||
    !SAFE_ID.test(request.turnId ?? '') ||
    (request.correlationId !== undefined && !SAFE_ID.test(request.correlationId)) ||
    !Array.isArray(request.secrets) ||
    request.secrets.length === 0 ||
    request.secrets.length > MAX_TRUSTED_CLI_SECRETS ||
    !request.secrets.every(isValidTrustedCliSecret) ||
    // Duplicates would collide on one environment variable, and under file
    // injection on one path in the secret directory.
    new Set(request.secrets.map((secret) => secret.env)).size !== request.secrets.length ||
    !Array.isArray(request.command) ||
    request.command.length === 0 ||
    request.command.length > 256 ||
    request.command.some((part) => typeof part !== 'string' || Buffer.byteLength(part) > 16_384) ||
    !request.command[0].startsWith('/') ||
    (request.entryScript !== undefined &&
      (!isObject(request.entryScript) ||
        typeof request.entryScript.path !== 'string' ||
        !request.entryScript.path.startsWith('/') ||
        typeof request.entryScript.projectPath !== 'string' ||
        request.entryScript.projectPath.startsWith('/') ||
        request.entryScript.projectPath
          .split('/')
          .some((component) => component === '' || component === '.' || component === '..') ||
        typeof request.entryScript.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(request.entryScript.sha256) ||
        (request.entryScript.loading !== 'isolated' && request.entryScript.loading !== 'dynamic')))
  ) {
    throw new Error('invalid trusted CLI request');
  }
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const persistedState = await readTurnState(runtimeDir, request.turnId);
  // Standalone smoke tests and the exported broker helper predate durable turn
  // state and still supply a request file directly. Real supervisor turns always
  // have state; prefer it because the production worker consumes request.json.
  const startRequest =
    persistedState ??
    JSON.parse(await readFile(join(runtimeDir, 'turns', request.turnId, 'request.json'), 'utf8'));
  if (
    !isObject(startRequest) ||
    startRequest.turnId !== request.turnId ||
    startRequest.trustedCliExecution !== true ||
    typeof startRequest.cwd !== 'string'
  ) {
    throw new Error('trusted CLI is unavailable for this turn');
  }
  const socketPath =
    options.brokerSocket ??
    process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET ??
    '/run/verity-runner-broker/agent-spawn-broker.sock';
  // Refuse obviously retired turns without touching the privileged broker. This is
  // only a fast preflight; the same predicate runs again after the async connect.
  if (options.authorize !== undefined && (await options.authorize(request)) !== true) {
    throw new Error('trusted CLI turn capability is no longer active');
  }
  return await new Promise((resolveResult, rejectResult) => {
    const socket = createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let spawned = false;
    let settled = false;
    let truncated = false;
    let timedOut = false;
    // Raw blocks cross only the existing privileged Server socket, whose caller already
    // owns the injected secrets. That caller redacts into bounded buffers before ACK;
    // raw blocks must never become an agent-facing tool result or an on-disk artifact.
    const streaming = request.streamOutput === true && typeof options.onOutput === 'function';
    const counts = { stdout: 0, stderr: 0 };
    let terminationReason = 'process_exit';
    let terminationRequested = false;
    let processing = false;
    let ended = false;
    let killTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      socket.destroy();
      // Take the values off the request before anything can resolve, so the only
      // remaining reference is the local one the redactor needs.
      // File injection materializes decoded bytes, so a CLI can echo either the
      // wire value or the original credential. Both must be masked.
      const secrets = request.secrets.flatMap((entry) =>
        entry.encoding === 'base64'
          ? [entry.secret, Buffer.from(entry.secret, 'base64').toString('utf8')]
          : [entry.secret],
      );
      for (const entry of request.secrets) entry.secret = '';
      if (error !== undefined) rejectResult(error);
      else if (streaming) {
        resolveResult({
          exitCode: result.exitCode,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          ...(result.exitCodeKnown === false ? { exitCodeKnown: false } : {}),
          terminationReason,
          stdoutBytes: counts.stdout,
          stderrBytes: counts.stderr,
          ...(terminationRequested ? { terminationRequested: true } : {}),
          ...(timedOut ? { timedOut: true } : {}),
          ...(truncated ? { truncated: true } : {}),
        });
      } else if (truncated) {
        resolveResult({
          exitCode: result.exitCode,
          stdout: '[output withheld: truncated]',
          stderr: '[output withheld: truncated]',
          truncated: true,
          ...(timedOut ? { timedOut: true } : {}),
        });
      } else {
        const redacted = {
          exitCode: result.exitCode,
          stdout: redactTrustedCliText(Buffer.concat(stdout), secrets),
          stderr: redactTrustedCliText(Buffer.concat(stderr), secrets),
          ...(timedOut ? { timedOut: true } : {}),
        };
        if (Buffer.byteLength(JSON.stringify(redacted), 'utf8') > MAX_TRUSTED_CLI_OUTPUT_BYTES) {
          resolveResult({
            exitCode: result.exitCode,
            stdout: '[output withheld: truncated]',
            stderr: '[output withheld: truncated]',
            truncated: true,
            ...(timedOut ? { timedOut: true } : {}),
          });
        } else {
          resolveResult(redacted);
        }
      }
    };
    const signal = () => {
      if (spawned && !socket.destroyed) {
        terminationRequested = true;
        socket.write(
          `${JSON.stringify({ protocolVersion: 1, kind: 'signal', signal: 'SIGKILL' })}\n`,
        );
      }
    };
    const terminate = () => {
      signal();
      if (killTimer !== undefined) return;
      killTimer = setTimeout(
        () => finish(new Error('trusted CLI broker did not settle after SIGKILL')),
        options.killGraceMs ?? TRUSTED_CLI_KILL_GRACE_MS,
      );
    };
    const abort = () => {
      terminationReason = 'transport_failure';
      terminate();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      terminationReason = 'timeout';
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? TRUSTED_CLI_TIMEOUT_MS);
    socket.once('error', (error) => finish(error));
    socket.once('connect', async () => {
      if (options.signal?.aborted) {
        finish(new Error('trusted CLI output connection closed'));
        return;
      }
      // Authorize only after the asynchronous connect, immediately before secrets cross
      // the socket. A worker may settle or cancellation may begin while connect is pending.
      try {
        if (options.authorize !== undefined && (await options.authorize(request)) !== true) {
          finish(new Error('trusted CLI turn capability is no longer active'));
          return;
        }
      } catch (error) {
        finish(error);
        return;
      }
      socket.write(
        `${JSON.stringify({
          protocolVersion: 1,
          kind: 'spawn-trusted-cli',
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
          command: request.command[0],
          args: request.command.slice(1),
          ...(request.entryScript === undefined ? {} : { entryScript: request.entryScript }),
          cwd: startRequest.cwd,
          secrets: request.secrets.map((entry) => ({
            name: entry.env,
            value: entry.secret,
            ...(entry.injection === undefined ? {} : { injection: entry.injection }),
            ...(entry.encoding === undefined ? {} : { encoding: entry.encoding }),
          })),
        })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      socket.pause();
      processing = true;
      void (async () => {
        if (buffered.length + chunk.length > 256 * 1024) {
          terminationReason = 'transport_failure';
          terminate();
          finish(new Error('trusted CLI broker frame too large'));
          return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          const newline = buffered.indexOf(0x0a);
          if (newline < 0) break;
          const line = buffered.subarray(0, newline).toString('utf8');
          buffered = buffered.subarray(newline + 1);
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            finish(new Error('trusted CLI broker returned malformed JSON'));
            return;
          }
          if (frame.ok !== true) {
            // The broker answers a refusal with `{ ok: false, error }` (see
            // verity-agent-spawn-broker.mjs). Dropping that message here is what
            // turns a precise refusal into an unexplained failed run by the time
            // it reaches the operator — the reason exists at every hop and was
            // discarded at this one.
            const reason =
              typeof frame.error === 'string' && frame.error !== '' ? frame.error : undefined;
            const failure = new Error(
              reason === undefined
                ? 'trusted CLI broker rejected execution'
                : `trusted CLI broker rejected execution: ${reason}`,
            );
            if (
              isObject(frame.trustedCliFailure) &&
              ['validation', 'materialization', 'launch-spec', 'spawn'].includes(
                frame.trustedCliFailure.phase,
              ) &&
              typeof frame.trustedCliFailure.cause === 'string'
            ) {
              failure.trustedCliFailure = frame.trustedCliFailure;
            }
            finish(failure);
            return;
          }
          if (frame.kind === 'spawned') {
            if (!spawned) {
              spawned = true;
              try {
                options.onSpawned?.();
              } catch (error) {
                finish(error);
                return;
              }
            }
            if (timedOut || truncated || terminationReason !== 'process_exit') signal();
            continue;
          }
          if (frame.kind === 'stdout' || frame.kind === 'stderr') {
            const bytes = Buffer.from(frame.data ?? '', 'base64');
            if (streaming) {
              counts[frame.kind] += bytes.length;
              if (terminationReason !== 'process_exit') {
                bytes.fill(0);
                continue;
              }
              if (counts.stdout + counts.stderr > 10 * 1024 * 1024) {
                terminationReason = 'output_limit';
                truncated = true;
                bytes.fill(0);
                terminate();
                continue;
              }
              try {
                for (let offset = 0; offset < bytes.length; offset += 16384) {
                  await options.onOutput(frame.kind, bytes.subarray(offset, offset + 16384));
                  if (settled || terminationReason !== 'process_exit') break;
                }
              } catch (error) {
                if (terminationReason === 'process_exit') {
                  terminationReason = ['redaction_failure', 'output_limit'].includes(
                    error?.outputFailure,
                  )
                    ? error.outputFailure
                    : 'storage_failure';
                }
                truncated = true;
                terminate();
              } finally {
                bytes.fill(0);
              }
              continue;
            }
            if (outputBytes + bytes.length > MAX_TRUSTED_CLI_OUTPUT_BYTES) {
              truncated = true;
              terminate();
              continue;
            }
            outputBytes += bytes.length;
            (frame.kind === 'stdout' ? stdout : stderr).push(bytes);
            continue;
          }
          if (frame.kind === 'exit') {
            const exitCode =
              Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255 ? frame.code : 1;
            finish(undefined, {
              exitCode,
              exitCodeKnown: Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255,
            });
          }
        }
      })()
        .catch(() => {
          terminate();
          finish(new Error('trusted CLI output processing failed'));
        })
        .finally(() => {
          processing = false;
          if (ended && !settled) finish(new Error('trusted CLI broker closed before exit'));
          if (!settled) socket.resume();
        });
    });
    socket.once('end', () => {
      ended = true;
      if (!processing && !settled) finish(new Error('trusted CLI broker closed before exit'));
    });
  });
}

/**
 * Structured supervisor telemetry, one JSON object per line on stderr.
 *
 * The Sandbox has no metrics sink, and the supervisor's stderr is the one stream
 * that is already collected. A line per notable start is cheap and is what turns
 * "turns were slow that evening" into a queue depth and a latency.
 */
export function logTelemetry(record) {
  try {
    process.stderr.write(`${JSON.stringify({ verity: 'runner-supervisor', ...record })}\n`);
  } catch {
    // Never let observability break a turn.
  }
}

let eventLoopHistogram;
/** Mean/max libuv delay since the previous read, so each record describes its own
 *  interval. This is the number that distinguishes a slow supervisor from a
 *  starved one — the distinction the incident could not make. */
export function sampleEventLoopDelay() {
  try {
    if (eventLoopHistogram === undefined) {
      eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
      eventLoopHistogram.enable();
      return undefined;
    }
    const mean = eventLoopHistogram.mean / 1e6;
    const max = eventLoopHistogram.max / 1e6;
    eventLoopHistogram.reset();
    if (!Number.isFinite(mean) || !Number.isFinite(max)) return undefined;
    return { mean: Math.round(mean * 100) / 100, max: Math.round(max * 100) / 100 };
  } catch {
    return undefined;
  }
}

/** POSIX's `128 + signum`, which is what the Server's exit-code checks already
 *  read (`isExternalInterruptionExitCode`). The numbers come from `os.constants`
 *  rather than a hand-kept table, so a signal nobody anticipated still encodes as
 *  itself. An unmapped name falls back to 1 — a plain failure — and deliberately
 *  NOT to SIGTERM's 143, which the Server reads as "the operator interrupted this"
 *  and would turn an unrecognized crash into a cancellation the session never made. */
function signalExitCode(signal) {
  const number = osConstants.signals[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

/**
 * Give a worker that died before saying anything a terminal frame of its own.
 *
 * Without this, an early crash leaves an EMPTY event stream and a settled state:
 * the Server has a turn that ended and no terminal event to end it with, which is
 * exactly the `agent exited with code 1 without a terminal event` the operator saw.
 * The supervisor is the only party that holds the worker's exit code, signal and
 * captured stderr, so it is the only one that can write a frame that says why.
 *
 * Written ONLY to an empty or absent stream. A worker that produced frames bound
 * `turnId` to ITS `runnerInstanceId` and owns the sequence (D3); appending under a
 * second instance id would corrupt exactly the invariant that makes replay
 * idempotent. In that case the Server's own tail already has frames to settle from.
 */
export async function writeSyntheticTerminalFrame(turnDir, detail) {
  const eventPath = join(turnDir, 'events.jsonl');
  // `lstat`, not `stat`: the turn directory is WORKER-writable, so a worker that
  // replaced its own event file with a symlink would otherwise have the supervisor
  // — which runs outside the worker's confinement — follow it and write this frame
  // wherever the link points. A link is not the empty stream this may write to, so
  // it is refused outright rather than resolved. `O_NOFOLLOW` below closes the
  // remaining gap between the check and the open.
  //
  // `nlink` closes the same hole in its hardlink form, which neither `isFile()` nor
  // `O_NOFOLLOW` sees: a hardlink to some other empty file the worker may link to
  // IS a regular file, of size zero, opened without complaint — and appending to it
  // writes this frame into that file. The supervisor writes this path itself and
  // nothing else links it, so more than one link means someone else made one.
  const existing = await lstat(eventPath).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isFile() || existing.size > 0 || existing.nlink > 1)) {
    return false;
  }
  const stderr = typeof detail.workerError === 'string' ? detail.workerError : '';
  const body = {
    kind: 'result',
    result: {
      // No `sessionId`. That field is the AGENT's conversation id, which only the
      // worker learns and only once the backend has opened the thread — a worker
      // that died before its first frame never had one. The Server persists a
      // failed turn's `result.sessionId` as the session's resume pointer
      // (`conductor.ts`), so putting the store's session id here would pin every
      // later turn to a thread the agent never issued. Absent means unknown, which
      // is the truth.
      // A clean exit with an EMPTY stream is still a failed turn: the worker did
      // none of the work and said nothing, so reporting the process's own `0` would
      // hand the Server a success it must then badge as running forever. The real
      // exit code stays in the turn state; this is the turn's verdict, not the
      // process's.
      exitCode:
        typeof detail.workerExitCode === 'number' && detail.workerExitCode !== 0
          ? detail.workerExitCode
          : detail.workerSignal != null
            ? signalExitCode(detail.workerSignal)
            : 1,
      stderr:
        stderr.length > 0
          ? stderr
          : detail.workerSignal != null
            ? `runner worker terminated by signal ${detail.workerSignal} before producing any event`
            : detail.workerExitCode === 0
              ? 'runner worker exited successfully before producing any event'
              : 'runner worker exited before producing any event',
      // A turn the operator cancelled is not a crash. Without this the SIGKILL that
      // ends the grace window reads as exit 137 and the session shows a failure for
      // something it was asked to do.
      aborted: detail.aborted === true,
    },
  };
  const frame = {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    runnerInstanceId: detail.runnerInstanceId,
    turnId: detail.turnId,
    frameSeq: SYNTHETIC_TERMINAL_FRAME_SEQ,
    payloadHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    ...body,
  };
  // Every caller reaches here only after the worker's `exit` event (or a failed
  // spawn), so the worker can no longer race this decision. O_APPEND is still
  // defense in depth: even if an inherited descriptor unexpectedly writes late,
  // the supervisor can never overwrite bytes already owned by the worker.
  const flags =
    constants.O_RDWR |
    constants.O_APPEND |
    constants.O_NOFOLLOW |
    (existing === undefined ? constants.O_CREAT | constants.O_EXCL : 0);
  // 0o640, matching the mode the worker opens its own event stream with: the Server
  // reads both as the same uid, and a supervisor-written frame should not be the one
  // file in the turn that a group member could modify.
  const handle = await open(eventPath, flags, 0o640).catch((error) => {
    // EEXIST: the worker created the stream between the check and the open, and owns
    // it. ELOOP: it put a symlink there instead — `O_NOFOLLOW` refused to follow it,
    // and the answer is the same, namely that this is not ours to write. ENOENT can
    // only reach here on the branch that passes no `O_CREAT`, i.e. the file was seen
    // by `lstat` and unlinked before the open: again someone else's doing, and again
    // not a reason for the exported contract to change from `false` to a throw.
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP' || error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (handle === undefined) return false;
  // Set once the frame is on disk. Until then a failure must take the file with it:
  // `O_CREAT|O_EXCL` has already created an EMPTY stream, and every caller swallows
  // this function's errors, so leaving that file behind converts "the stream is
  // missing" — which recovery reads as a dead Runner it can settle — into "the stream
  // exists and has no terminal frame", which is the `no-terminal-event` symptom this
  // whole path exists to remove. Absent is the better diagnosis, so restore it.
  let wrote = false;
  // Set once the checks below have proved the file is OURS and empty. The rollback in
  // the `finally` is gated on it and must be: the early return above leaves a file
  // somebody else owns and may have written, and truncating that would destroy the
  // worker's own events to tidy up a frame that was never written.
  let owned = false;
  try {
    // On the descriptor now open, so it closes the window the pre-open `lstat` cannot:
    // a link made between the two checks is a different file from the one that was
    // inspected, and `nlink` is what says so. `O_NOFOLLOW` covers the symlink form of
    // that race; this covers the hardlink form, at the cost of a stat already paid for.
    const fresh = await handle.stat();
    if (fresh.size > 0 || fresh.nlink > 1) return false;
    owned = true;
    // Byte-counted rather than fire-and-forget, because `write(2)` is permitted to
    // stop short and Node does not loop for us. This frame carries up to
    // `MAX_WORKER_ERROR_BYTES` of captured stderr, so it is nowhere near the small
    // write a filesystem completes atomically, and the case that truncates it —
    // ENOSPC — is exactly the one a host under pressure produces. Half a JSON line at
    // the head of the stream is worse than no stream at all: the tail cannot parse it,
    // so recovery sees a CORRUPT turn where it would otherwise see the missing one it
    // knows how to settle. A short write therefore fails the same way a rejected one
    // does, and the `finally` puts the file back the way it was found.
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) return false;
    wrote = true;
    await handle.sync().catch(() => undefined);
    // The bytes are durable, but when this open CREATED the file its directory entry
    // need not be — and `updateTurnState`, which fsyncs its own directory, is about to
    // record the turn as settled. A crash in between would leave a settled turn whose
    // stream does not exist: precisely the empty-stream symptom this frame is here to
    // prevent, reintroduced by the ordering that was meant to prevent it.
    if (existing === undefined) await syncDirectory(turnDir).catch(() => undefined);
    return true;
  } finally {
    // Before the close, and before the size check below reads it: a partial or
    // rejected write leaves bytes on a file the cleanup would then decline to remove
    // for being non-empty — stranding the truncated line it was meant to erase.
    if (owned && !wrote) await handle.truncate(0).catch(() => undefined);
    await handle.close().catch(() => undefined);
    // Only a file this call created, and only while it is still the empty one it
    // created: `O_EXCL` proves nobody else owned that name at open time, and a size of
    // zero proves nobody has written to it since.
    if (!wrote && existing === undefined) {
      await lstat(eventPath)
        .then(async (leftover) => {
          if (leftover.isFile() && leftover.size === 0) await rm(eventPath, { force: true });
        })
        .catch(() => undefined);
    }
  }
}

export const MISSING_WORKER_ERROR = 'worker missing during supervisor recovery';
/** The same settlement, for a turn the operator had already cancelled. Its worker is
 * equally gone; calling that a crash would blame the system for the operator's own
 * decision. */
export const CANCELLED_MISSING_WORKER_ERROR =
  'runner turn was cancelled; its worker did not survive the supervisor restart';

export function cancelPath(runtimeDir, turnId) {
  return join(runtimeDir, 'cancellations', `${turnId}.json`);
}
/**
 * Total by construction, and deliberately TRI-state.
 *
 * The tombstone's presence proves a cancellation and ENOENT proves its absence,
 * but every other failure (EISDIR over a path something else created, EACCES,
 * EIO) proves neither. Letting such a read throw was worse than either answer: it
 * aborted the caller mid-way and left the turn `claimed` with no worker and no
 * terminal frame — a session that never finishes, the exact failure this file is
 * being changed to remove. So `unknown` is an answer, and each caller resolves it
 * in the direction where being wrong is survivable. `cancelledBeforeStart` covers
 * cancels this supervisor instance handled itself; the tombstone is what survives
 * a restart, so it cannot simply be ignored.
 *
 * Before spawning, anything but a proven absence stops the worker: refusing to start
 * is recoverable — the turn settles with a terminal frame and the operator can ask
 * again — whereas running a turn that was cancelled puts an agent to work on the
 * worktree nobody asked for, after the operator has already been told it stopped.
 */
export async function readCancelTombstone(runtimeDir, turnId) {
  try {
    await readFile(cancelPath(runtimeDir, turnId));
    return 'cancelled';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'unknown';
  }
}
/**
 * While settling: only a proven cancellation is reported as one.
 *
 * Here the turn is ending either way and the only question is which label it
 * carries. Guessing `aborted` for a turn that really crashed would hide a genuine
 * failure behind "you cancelled it", so an unreadable tombstone reports the crash.
 */
export async function cancelExplainsSettlement(runtimeDir, turnId) {
  return (await readCancelTombstone(runtimeDir, turnId)) === 'cancelled';
}
