#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { constants as osConstants } from 'node:os';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { setImmediate } from 'node:timers';

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
function supportedRequestVersion(value) {
  return (
    Number.isInteger(value) &&
    value >= MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION &&
    value <= SUPERVISOR_PROTOCOL_VERSION
  );
}
export const DEFAULT_RUNTIME_DIR = '/run/verity-runner';
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
const MAX_CONTROL_LINE_BYTES = MAX_START_REQUEST_BYTES + 1;
// How long a refused peer may keep streaming the payload we already rejected before
// the connection is dropped anyway. Long enough for a multi-megabyte write to drain
// over a Unix socket, short enough that a stalled peer cannot hold the slot.
const OVERSIZE_DRAIN_GRACE_MS = 2_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
const WORKER_BACKENDS = new Set(['claude-acp', 'codex-acp', 'opencode-acp', 'pi']);
// The transports that reach the brokered Verity tools over the loopback MCP gateway
// (ADR 0014 D1). Only these may
// carry a gateway bearer on start-turn.
//
// `opencode-acp` is deliberately absent even though it is an ACP transport and
// OpenCode advertises `mcpCapabilities.http`: which agents may spend the operator's
// secrets is a decision, not a side effect of the protocol an agent happens to
// speak. Admitting it means changing every gate that names the pair by hand, and
// they are deliberately separate so none can drift into the others by accident:
// this set, `carriesBrokeredSecretTools` (packages/session/src/conductor.ts), the
// `acpBackend` flag that decides whether a bearer is minted at all
// (packages/session/src/runner-supervisor-client.ts), and the two independent
// re-checks in packages/session/src/runner-worker-entry.ts.
const ACP_WORKER_BACKENDS = new Set(['claude-acp', 'codex-acp']);
// The subset of WORKER_BACKENDS that the PRODUCTION supervisor actually launches.
// A start-turn for any backend outside this set is rejected at runtime (see the
// workerBackends gate below), so it is the real capability boundary — distinct
// from WORKER_BACKENDS, which only bounds what the request validator will parse.
// All three ACP transports cross the process boundary as a setpriv'd CLI child
// spawned through the root broker
// (packages/session/src/runner-worker-entry.ts).
// `pi` has NO worker adapter yet, so it stays on the loopback path and MUST NOT be
// listed here, or its turns would fail at start-turn. OpenCode used to be in that
// same position — a long-lived HTTP server client with no argv and no child to
// spawn — and left it by moving to `opencode acp` (ADR 0012 Amendment 4).
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
  return {
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
// launch (packages/session/src/file-attachments.ts), so only inline `image` blocks
// cross the start-turn protocol. Kept 1:1 with @verity/events imageMediaTypeSchema.
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// Matches the Server's per-turn upload cap (packages/server/src/server.ts). The total
// inline payload is additionally bounded by MAX_START_REQUEST_BYTES below.
const MAX_START_ATTACHMENTS = 8;
const MAX_WORKER_ERROR_BYTES = 16 * 1024;
const WORKER_ERROR_DRAIN_TIMEOUT_MS = 100;
// How long a rejected start waits for its SIGKILLed worker to actually go, before it
// releases the worker lock. SIGKILL is not refusable, so this is a scheduling margin
// rather than a grace period — but it is bounded, because a turn that cannot be ended
// still has to be reported rather than held.
const REJECTED_WORKER_EXIT_WAIT_MS = 2_000;
const MAX_TRUSTED_CLI_OUTPUT_BYTES = 24 * 1024;
// Mirrors MAX_TRUSTED_CLI_SECRETS in packages/secret-contracts/src/tool.ts. The
// contract already bounded the request; this is the in-container half of the
// same bound, because the supervisor validates what reaches it rather than
// trusting the sender.
const MAX_TRUSTED_CLI_SECRETS = 8;
const TRUSTED_CLI_TIMEOUT_MS = 30 * 60 * 1_000;
const TRUSTED_CLI_KILL_GRACE_MS = 5_000;
const SUPERVISOR_REQUEST_GRACE_MS = 10_000;

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
const MAX_CONCURRENT_STARTS = 4;
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
const MAX_QUEUED_STARTS = 64;
/** The `frameSeq` a synthesized terminal frame claims. Only ever written to an
 *  EMPTY stream, so 1 is both correct and the only contiguous choice (ADR 0006 D3). */
const SYNTHETIC_TERMINAL_FRAME_SEQ = 1;
/** Kept 1:1 with RUNNER_FRAME_PROTOCOL_VERSION in @verity/store. */
const RUNNER_FRAME_PROTOCOL_VERSION = 1;

function isObject(value) {
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
    (secret.injection === undefined || secret.injection === 'env' || secret.injection === 'file')
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
  const startRequest = JSON.parse(
    await readFile(join(runtimeDir, 'turns', request.turnId, 'request.json'), 'utf8'),
  );
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
    let killTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      socket.destroy();
      // Take the values off the request before anything can resolve, so the only
      // remaining reference is the local one the redactor needs.
      const secrets = request.secrets.map((entry) => entry.secret);
      for (const entry of request.secrets) entry.secret = '';
      if (error !== undefined) rejectResult(error);
      else if (truncated) {
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
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? TRUSTED_CLI_TIMEOUT_MS);
    socket.once('error', (error) => finish(error));
    socket.once('connect', async () => {
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
          if (timedOut || truncated) signal();
          continue;
        }
        if (frame.kind === 'stdout' || frame.kind === 'stderr') {
          const bytes = Buffer.from(frame.data ?? '', 'base64');
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
          finish(undefined, { exitCode });
        }
      }
    });
    socket.once('end', () => {
      if (!settled) finish(new Error('trusted CLI broker closed before exit'));
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
function logTelemetry(record) {
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
function sampleEventLoopDelay() {
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

const MISSING_WORKER_ERROR = 'worker missing during supervisor recovery';
/** The same settlement, for a turn the operator had already cancelled. Its worker is
 * equally gone; calling that a crash would blame the system for the operator's own
 * decision. */
const CANCELLED_MISSING_WORKER_ERROR =
  'runner turn was cancelled; its worker did not survive the supervisor restart';

function cancelPath(runtimeDir, turnId) {
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
async function readCancelTombstone(runtimeDir, turnId) {
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
async function cancelExplainsSettlement(runtimeDir, turnId) {
  return (await readCancelTombstone(runtimeDir, turnId)) === 'cancelled';
}

/**
 * Settle a turn whose worker is gone — and say WHY in the stream, not only in the
 * state.
 *
 * Recovery after a supervisor restart is the one remaining way to reach a settled
 * turn with an empty event stream, which the Server reads as `agent exited without
 * a terminal event`: the same symptom, arriving by the one door the start path no
 * longer leaves open. The frame is written first so no window exists in which the
 * state says `settled` and the stream still says nothing, and it is written
 * best-effort because a turn that cannot be explained must still be ended.
 *
 * The frame is stamped with the state's OWN `runnerInstanceId` — the instance that
 * ran the worker — not this one: `turnId` binds to exactly one instance for the
 * life of the turn (ADR 0006 D3), and this supervisor is only its undertaker. A
 * state old enough to lack that field is settled without a frame rather than with
 * an unattributable one.
 *
 * A turn with NO state at all is left alone. Writing one here would invent a settled
 * turn out of a state that says nothing — no `startCommandId`, no instance, no
 * diagnosis — and the Server reads exactly that shape as "nothing ever claimed this",
 * the one answer that lets it safely start the turn again. Better a turn it may retry
 * than a failure it cannot explain.
 *
 * That rule is the adopter's own, unchanged; sharing this function extends it to the
 * start path's liveness check, which used to write `settled` for a turn it could not
 * read. The difference is theoretical: `adopt()` only ever adopts a turn whose state
 * parsed as `claimed`/`running` with `workerLock`, and nothing here ever removes a
 * `state.json`, so the absent-state branch is not reachable from an adopted turn. It
 * is written for the one that is: a `state.json` that is present but CORRUPT throws
 * out of `readTurnState`, which the adopter retries as `uncertain` and the start path
 * refuses — neither of them settling a turn on a file they could not read.
 */
async function settleMissingWorkerTurn(runtimeDir, turnId) {
  const state = await readTurnState(runtimeDir, turnId);
  if (state === undefined || state.status === 'settled') return;
  // A turn cancelled just before the supervisor died is settled here rather than on
  // the exit path, and it must carry the same label it would have carried there: the
  // operator asked for it to stop, and it stopped. Only a PROVEN cancellation counts
  // — an unreadable tombstone reports the crash, exactly as on every other exit.
  const aborted = await cancelExplainsSettlement(runtimeDir, turnId);
  const workerError = aborted ? CANCELLED_MISSING_WORKER_ERROR : MISSING_WORKER_ERROR;
  if (typeof state.runnerInstanceId === 'string') {
    await writeSyntheticTerminalFrame(join(runtimeDir, 'turns', turnId), {
      turnId,
      runnerInstanceId: state.runnerInstanceId,
      // SIGTERM only for the cancelled half: it derives exit 143, which the Server
      // reads as "the operator interrupted this" — true here, and a false accusation
      // for a worker that simply vanished.
      ...(aborted ? { workerSignal: 'SIGTERM' } : {}),
      workerError,
      aborted,
    }).catch(() => undefined);
  }
  await updateTurnState(runtimeDir, turnId, {
    status: 'settled',
    ...(aborted ? { workerSignal: 'SIGTERM' } : {}),
    workerError,
  });
}

/**
 * How long one request may occupy a connection before the supervisor gives up on it.
 *
 * Note what expiry does: it DESTROYS the socket, it does not answer. So this is not a
 * refusal the Server can act on — it reaches the client as a lost answer, which is
 * what sends it to reconciliation and the cancel fence rather than down the decided
 * path. That is the safe direction, and it is why nothing here needs to be shorter
 * than the client's budgets.
 *
 * For `start-turn` that is `DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS` (15 min) plus the
 * grace — three orders of magnitude above the queue's own drain time, so a start
 * cannot lose its connection while it is merely waiting for a slot. The grace is
 * ADDED to the budget, never a cap on it: it exists so the supervisor outlives the
 * peer's deadline and the peer's error, not the supervisor's silence, is what the
 * operator reads.
 */
export function supervisorRequestTimeoutMs(request) {
  return (
    (isObject(request) && request.kind === 'run-trusted-cli'
      ? TRUSTED_CLI_TIMEOUT_MS + TRUSTED_CLI_KILL_GRACE_MS
      : DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS) + SUPERVISOR_REQUEST_GRACE_MS
  );
}

async function processStartTime(pid) {
  const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return undefined;
  // `/proc/<pid>/stat` field 2 is parenthesized and may contain spaces. Everything
  // after the final `)` starts at field 3; starttime is field 22 (index 19 here).
  const afterCommand = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u);
  return afterCommand[19];
}

async function writeJsonAtomic(path, value, mode = 0o660) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireFileLock(path) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o660,
  );
  let stats;
  try {
    stats = await handle.stat();
  } catch (error) {
    await handle.close();
    throw error;
  }
  if (!stats.isFile()) {
    await handle.close();
    throw new Error('runner lock is not a regular file');
  }
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', rejectResult);
    child.once('close', (code, signal) => resolveResult({ code, signal, stderr }));
  }).catch(async (error) => {
    await handle.close();
    throw error;
  });
  if (result.code !== 0) {
    await handle.close();
    const busy = result.code === 75 && result.signal === null;
    const error = new Error(
      busy
        ? 'runner supervisor is already claimed'
        : result.stderr.trim().length > 0
          ? `runner supervisor lock failed: ${result.stderr.trim()}`
          : `runner supervisor lock failed with ${result.signal ?? `code ${String(result.code)}`}`,
    );
    if (busy) error.code = 'ELOCKED';
    throw error;
  }
  return handle;
}

function isLockBusy(error) {
  return error?.code === 'ELOCKED';
}

function stdioWithWorkerLock(lockFd) {
  return ['pipe', 'pipe', 'pipe', lockFd];
}

function boundedWorkerError(value) {
  const redacted = redactWorkerError(String(value)).trim();
  if (redacted.length === 0) return '';
  const allowlistedDiagnostics = [
    { pattern: /\bnot logged in\b/i, message: 'worker stderr reported: not logged in' },
    {
      pattern: /\b(?:authentication failed|unauthorized|invalid credentials?)\b/i,
      message: 'worker stderr reported an authentication failure',
    },
    { pattern: /\bforbidden\b/i, message: 'worker stderr reported: forbidden' },
    {
      pattern: /\bpermission denied\b/i,
      message: 'worker stderr reported: permission denied',
    },
    {
      pattern: /\b(?:could not resolve host|name or service not known)\b/i,
      message: 'worker stderr reported a DNS resolution failure',
    },
    {
      pattern: /\bconnection (?:refused|reset)\b/i,
      message: 'worker stderr reported a connection failure',
    },
    {
      pattern: /\b(?:timed out|timeout)\b/i,
      message: 'worker stderr reported a timeout',
    },
    {
      pattern: /\b(?:no such file or directory|command not found|module not found)\b/i,
      message: 'worker stderr reported a missing executable or module',
    },
  ];
  const diagnostic = allowlistedDiagnostics.find(({ pattern }) => pattern.test(redacted));
  if (diagnostic !== undefined) return diagnostic.message;
  const errorCode = redacted.match(/\b(?:E[A-Z]{2,20}|HTTP [45]\d\d)\b/)?.[0];
  return errorCode === undefined
    ? 'worker stderr reported an unrecognized failure'
    : `worker stderr reported error code ${errorCode}`;
}

function boundedSpawnError(value) {
  const message = String(value);
  if (
    /^runner worker (?:is not installed|has no private (?:attestation|attestation acknowledgement|error) pipe)$/.test(
      message,
    )
  ) {
    return message;
  }
  const errorCode = message.match(/\bE[A-Z]{2,20}\b/)?.[0];
  return errorCode === undefined
    ? 'runner worker spawn failed'
    : `runner worker spawn failed with error code ${errorCode}`;
}

function redactWorkerError(value) {
  const credentialPatterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    /sk-ant-[a-z0-9-]{8,}/gi,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /dp\.(?:st|sa|ct|scim|audit)\.[A-Za-z0-9._-]{16,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  ];
  // eslint-disable-next-line no-control-regex -- stderr is untrusted bytes normalized to safe text.
  let redacted = value.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '\uFFFD');
  for (const pattern of credentialPatterns) redacted = redacted.replace(pattern, '[REDACTED]');
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
    '$1: [REDACTED]',
  );
  redacted = redacted.replace(
    /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|token|secret|api[_-]?key)["']?\s*:\s*["'])[^"']+(["'])/gi,
    '$1[REDACTED]$2',
  );
  redacted = redacted.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
  redacted = redacted.replace(
    /([?&](?:access_token|api_key|token|signature|x-amz-signature)=)[^&\s]+/gi,
    '$1[REDACTED]',
  );
  redacted = redacted.replace(
    /\b((?:database_url|redis_url|mongodb_uri)|[a-z0-9_]*(?:token|secret|password|api[_-]?key|cookie))\s*=\s*[^\s]+/gi,
    '$1=[REDACTED]',
  );
  redacted = redacted.replace(
    /(\s--(?:access-token|token|secret|password|api-key|cookie)(?:=|\s+))[^\s]+/gi,
    '$1[REDACTED]',
  );
  return redacted;
}

function createWorkerErrorCapture() {
  const privateKeyMarkers = ['', 'OPENSSH ', 'RSA ', 'EC '].flatMap((kind) => [
    { bytes: Buffer.from(['-----BEGIN ', `${kind}PRIVATE KEY-----`].join('')), begins: true },
    { bytes: Buffer.from(['-----END ', `${kind}PRIVATE KEY-----`].join('')), begins: false },
  ]);
  const markerOverlapBytes = Math.max(...privateKeyMarkers.map(({ bytes }) => bytes.length)) - 1;
  let output = Buffer.alloc(0);
  let line = Buffer.alloc(0);
  let oversizedLine = false;
  let privateKeyBlock = false;
  let markerTail = Buffer.alloc(0);

  const appendOutput = (value) => {
    output = Buffer.concat([output, Buffer.from(value)]).subarray(-MAX_WORKER_ERROR_BYTES);
  };
  const observePrivateKeyMarkers = (bytes) => {
    const boundaryLength = Math.min(bytes.length, markerOverlapBytes);
    const boundary = Buffer.concat([markerTail, bytes.subarray(0, boundaryLength)]);
    const matches = [];
    for (const marker of privateKeyMarkers) {
      const boundaryIndex = boundary.indexOf(marker.bytes);
      if (boundaryIndex !== -1) matches.push({ index: boundaryIndex, begins: marker.begins });
      let index = bytes.indexOf(marker.bytes);
      while (index !== -1) {
        matches.push({ index: markerTail.length + index, begins: marker.begins });
        index = bytes.indexOf(marker.bytes, index + 1);
      }
    }
    matches.sort((left, right) => left.index - right.index);
    for (const match of matches) privateKeyBlock = match.begins;
    markerTail = Buffer.from(bytes.subarray(-markerOverlapBytes));
  };
  const appendLineBytes = (bytes) => {
    observePrivateKeyMarkers(bytes);
    if (oversizedLine || bytes.length === 0) return;
    if (line.length + bytes.length > MAX_WORKER_ERROR_BYTES) {
      line = Buffer.alloc(0);
      oversizedLine = true;
      return;
    }
    line = Buffer.concat([line, bytes]);
    const outputBudget = MAX_WORKER_ERROR_BYTES - line.length;
    output = outputBudget === 0 ? Buffer.alloc(0) : output.subarray(-outputBudget);
  };
  const finishLine = (terminated) => {
    const text = line.toString('utf8');
    const beginsPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);
    const endsPrivateKey = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);
    if (oversizedLine || privateKeyBlock || beginsPrivateKey) {
      appendOutput(`[REDACTED]${terminated ? '\n' : ''}`);
    } else {
      appendOutput(`${redactWorkerError(text)}${terminated ? '\n' : ''}`);
    }
    if (beginsPrivateKey) privateKeyBlock = true;
    if (endsPrivateKey) privateKeyBlock = false;
    line = Buffer.alloc(0);
    oversizedLine = false;
    markerTail = Buffer.alloc(0);
  };

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) {
          appendLineBytes(bytes.subarray(offset));
          return;
        }
        appendLineBytes(bytes.subarray(offset, newline));
        finishLine(true);
        offset = newline + 1;
      }
    },
    finish() {
      if (line.length > 0 || oversizedLine) finishLine(false);
      return boundedWorkerError(output);
    },
  };
}

export function validateRuntimeStats(stats, expected = {}) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('runner runtime is not a real directory');
  }
  const uid = expected.uid ?? process.getuid?.();
  const gid = expected.gid ?? process.getgid?.();
  if (gid !== undefined && stats.gid !== gid) {
    throw new Error(`runner runtime gid mismatch: expected ${gid}, got ${stats.gid}`);
  }
  const mode = stats.mode & 0o777;
  if (uid !== undefined) {
    const runnerOwned = stats.uid === uid;
    // Server-owned runtimes must keep owner read AND write clear so a same-uid
    // sandbox agent cannot read or write the Runner's control files here, but a
    // bare owner traverse bit (0170, --x) is allowed: the provisioner grants it so
    // the agent — which shares uid 1000 with the Server — can descend to its
    // Server-created transcript directory under claude/ (stage-5b capture).
    const serverOwned = !runnerOwned && (mode & 0o600) === 0;
    if (!runnerOwned && !serverOwned) {
      throw new Error(
        `runner runtime uid mismatch: expected ${uid} or server-owned group-only, got ${stats.uid}`,
      );
    }
    if (runnerOwned && (mode & 0o700) !== 0o700) {
      throw new Error(
        `runner-owned runtime must be owner/group-only and writable (0770): ${mode.toString(8)}`,
      );
    }
  }
  if ((mode & 0o007) !== 0 || (mode & 0o070) !== 0o070) {
    throw new Error(
      `runner runtime must be group-only and writable by the runtime group: ${mode.toString(8)}`,
    );
  }
}

export async function validateRuntimeDirectory(runtimeDir, expected = {}) {
  const stats = await lstat(runtimeDir);
  try {
    validateRuntimeStats(stats, expected);
  } catch (error) {
    if (error instanceof Error && error.message === 'runner runtime is not a real directory') {
      throw new Error(`runner runtime is not a real directory: ${runtimeDir}`, { cause: error });
    }
    throw error;
  }
}

export async function acquireSingleton(runtimeDir, instanceId = randomUUID()) {
  const lockPath = join(runtimeDir, 'supervisor.lock');
  const ownerPath = join(runtimeDir, 'supervisor.lock.json');
  // The helper applies flock(2) to fd 3, which is a duplicate of this process's
  // open file description. Keeping the FileHandle open retains a kernel lock on
  // the SHARED volume across container/network namespaces; process death drops it.
  const lockHandle = await acquireFileLock(lockPath);
  const owner = {
    pid: process.pid,
    processStartTime: await processStartTime(process.pid),
    instanceId,
  };
  try {
    await writeJsonAtomic(ownerPath, owner);
    await chmod(lockPath, 0o660);
  } catch (error) {
    await lockHandle.close();
    throw error;
  }
  let released = false;
  return {
    instanceId,
    async release() {
      if (released) return;
      released = true;
      const currentOwner = await readFile(ownerPath, 'utf8').catch(() => undefined);
      let currentInstanceId;
      try {
        currentInstanceId =
          currentOwner === undefined ? undefined : JSON.parse(currentOwner).instanceId;
      } catch {
        currentInstanceId = undefined;
      }
      try {
        if (currentInstanceId === instanceId) {
          await rm(ownerPath, { force: true });
        }
      } finally {
        await lockHandle.close();
      }
    },
  };
}

export async function readTurnState(runtimeDir, turnId) {
  if (!SAFE_ID.test(turnId)) throw new Error('invalid turnId');
  const path = join(runtimeDir, 'turns', turnId, 'state.json');
  const stats = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stats === undefined) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error(`invalid state file for ${turnId}`);
  const raw = await readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  if (
    !isObject(parsed) ||
    parsed.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION ||
    parsed.turnId !== turnId ||
    typeof parsed.startCommandId !== 'string' ||
    !SAFE_ID.test(parsed.startCommandId) ||
    typeof parsed.runnerInstanceId !== 'string' ||
    !SAFE_ID.test(parsed.runnerInstanceId) ||
    !['claimed', 'running', 'settled'].includes(parsed.status) ||
    typeof parsed.createdAt !== 'number' ||
    !Number.isFinite(parsed.createdAt) ||
    typeof parsed.updatedAt !== 'number' ||
    !Number.isFinite(parsed.updatedAt) ||
    (parsed.workerLock !== undefined && parsed.workerLock !== true) ||
    (parsed.workerExitCode !== undefined &&
      parsed.workerExitCode !== null &&
      !Number.isInteger(parsed.workerExitCode)) ||
    (parsed.workerError !== undefined &&
      (typeof parsed.workerError !== 'string' ||
        Buffer.byteLength(parsed.workerError) > MAX_WORKER_ERROR_BYTES))
  ) {
    throw new Error(`invalid state for ${turnId}`);
  }
  return parsed;
}

export async function claimTurn(runtimeDir, request, runnerInstanceId) {
  const { turnId, startCommandId } = request;
  if (typeof turnId !== 'string' || !SAFE_ID.test(turnId)) throw new Error('invalid turnId');
  if (typeof startCommandId !== 'string' || !SAFE_ID.test(startCommandId)) {
    throw new Error('invalid startCommandId');
  }
  const turnsDir = join(runtimeDir, 'turns');
  const turnDir = join(turnsDir, turnId);
  const createdTurnsPath = await mkdir(turnsDir, { recursive: true, mode: 0o770 });
  await chmod(turnsDir, 0o770);
  if (createdTurnsPath !== undefined) await syncDirectory(runtimeDir);
  let created = false;
  try {
    await mkdir(turnDir, { mode: 0o770 });
    await chmod(turnDir, 0o770);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) {
    const now = Date.now();
    const state = {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      turnId,
      startCommandId,
      runnerInstanceId,
      status: 'claimed',
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(join(turnDir, 'state.json'), state);
    // Persist the new turn directory entry before acknowledging the claim. The
    // state file itself and turnDir were synced by writeJsonAtomic above.
    await syncDirectory(turnsDir);
    return { outcome: 'created', state };
  }
  const turnStats = await lstat(turnDir);
  if (!turnStats.isDirectory() || turnStats.isSymbolicLink()) {
    return { outcome: 'ambiguous', reason: 'invalid-turn-directory' };
  }
  const state = await readTurnState(runtimeDir, turnId);
  if (state === undefined) {
    return { outcome: 'ambiguous', reason: 'turn-directory-without-state' };
  }
  if (state.startCommandId !== startCommandId) {
    return { outcome: 'conflict', reason: 'start-command-mismatch', state };
  }
  if (state.status !== 'settled' && state.runnerInstanceId !== runnerInstanceId) {
    return { outcome: 'ambiguous', reason: 'runner-instance-mismatch', state };
  }
  return {
    outcome: state.status === 'settled' ? 'terminal' : 'already-running',
    state,
  };
}

export function validateStartTurnRequest(request) {
  if (!isObject(request) || request.kind !== 'start-turn') throw new Error('invalid start request');
  // The whole serialized request — inline image base64 included — is bounded here, so
  // an oversize image is rejected outright rather than silently truncated. This runs
  // before per-field checks so a huge payload never reaches the shape validation.
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_START_REQUEST_BYTES) {
    throw new Error('start request exceeds supervisor limit');
  }
  if (!SAFE_ID.test(request.turnId ?? '')) throw new Error('invalid turnId');
  if (!SAFE_ID.test(request.startCommandId ?? '')) throw new Error('invalid startCommandId');
  if (!SAFE_ID.test(request.sessionId ?? '')) throw new Error('invalid sessionId');
  if (!WORKER_BACKENDS.has(request.backend)) throw new Error('invalid worker backend');
  if (typeof request.worktree !== 'string' || !request.worktree.startsWith('/')) {
    throw new Error('invalid worktree');
  }
  if (typeof request.cwd !== 'string' || !request.cwd.startsWith('/'))
    throw new Error('invalid cwd');
  const worktree = resolve(request.worktree);
  const cwd = resolve(request.cwd);
  if (cwd !== worktree && !cwd.startsWith(`${worktree}/`)) throw new Error('cwd outside worktree');
  if (typeof request.prompt !== 'string' || Buffer.byteLength(request.prompt) > 1024 * 1024) {
    throw new Error('invalid prompt');
  }
  if (
    request.model !== undefined &&
    (typeof request.model !== 'string' || request.model.length > 256)
  ) {
    throw new Error('invalid model');
  }
  const optionalString = (value, name, maxBytes) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
      throw new Error(`invalid ${name}`);
    }
    return value;
  };
  const stringList = (value, name) => {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > 256 ||
      value.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 4_096)
    ) {
      throw new Error(`invalid ${name}`);
    }
    return value;
  };
  const attachmentList = (value) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_START_ATTACHMENTS) {
      throw new Error('invalid attachments');
    }
    return value.map((item) => {
      if (
        !isObject(item) ||
        item.kind !== 'image' ||
        !IMAGE_MEDIA_TYPES.has(item.mediaType) ||
        typeof item.data !== 'string' ||
        item.data.length === 0
      ) {
        throw new Error('invalid attachment');
      }
      return { kind: 'image', mediaType: item.mediaType, data: item.data };
    });
  };
  const attachments = attachmentList(request.attachments);
  const appendSystemPrompt = optionalString(
    request.appendSystemPrompt,
    'appendSystemPrompt',
    1_048_576,
  );
  const resumeSessionId = optionalString(request.resumeSessionId, 'resumeSessionId', 256);
  // Per-turn bearer for the loopback MCP gateway (ADR 0014 D1). The supervisor only
  // bounds its shape; the Server minted it and is the only party that can resolve it.
  const mcpGatewayToken = optionalString(request.mcpGatewayToken, 'mcpGatewayToken', 512);
  if (
    mcpGatewayToken !== undefined &&
    (mcpGatewayToken === '' || !ACP_WORKER_BACKENDS.has(request.backend))
  ) {
    throw new Error('invalid mcpGatewayToken');
  }
  if (request.trustedCliExecution === true && !ACP_WORKER_BACKENDS.has(request.backend)) {
    throw new Error('invalid trustedCliExecution');
  }
  // Deliberately not narrowed to a fixed vocabulary here: ACP permission modes are
  // per-agent, and this one field carries every backend's. `Conductor.query` also
  // pins `dontAsk` for its unattended meta turns, which reach the supervisor by this
  // same path. The posture is bounded where it is actually agent-specific — the
  // profile's `permissionModes` in `acp-backend.ts`, checked at the spawn seam.
  const permissionMode = optionalString(request.permissionMode, 'permissionMode', 128);
  const allowedTools = stringList(request.allowedTools, 'allowedTools');
  const disallowedTools = stringList(request.disallowedTools, 'disallowedTools');
  let sessionEnv;
  if (request.sessionEnv !== undefined) {
    if (!isObject(request.sessionEnv)) throw new Error('invalid sessionEnv');
    const entries = Object.entries(request.sessionEnv);
    if (
      entries.length > 8 ||
      entries.some(
        ([key, value]) =>
          !['VERITY_SESSION_BACKEND', 'VERITY_SESSION_MODEL'].includes(key) ||
          typeof value !== 'string' ||
          value.length > 256,
      )
    ) {
      throw new Error('invalid sessionEnv');
    }
    sessionEnv = Object.fromEntries(entries);
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 86_400_000)
  ) {
    throw new Error('invalid timeoutMs');
  }
  return {
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    kind: 'start-turn',
    turnId: request.turnId,
    startCommandId: request.startCommandId,
    sessionId: request.sessionId,
    backend: request.backend,
    worktree,
    cwd,
    prompt: request.prompt,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    steerable: request.steerable === true,
    permissionControl: request.permissionControl === true,
    trustedCliExecution: request.trustedCliExecution === true,
    ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(mcpGatewayToken !== undefined ? { mcpGatewayToken } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(sessionEnv !== undefined ? { sessionEnv } : {}),
  };
}

async function updateTurnState(runtimeDir, turnId, patch) {
  const current = await readTurnState(runtimeDir, turnId);
  if (current === undefined) throw new Error(`missing state for ${turnId}`);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await writeJsonAtomic(join(runtimeDir, 'turns', turnId, 'state.json'), next);
  return next;
}

export function createTurnStarter(runtimeDir, runnerInstanceId, options = {}) {
  const children = new Map();
  const settlements = new Set();
  const settlementsByTurn = new Map();
  const starts = new Set();
  const startsByTurn = new Map();
  const cancelledBeforeStart = new Set();
  const maxConcurrentStarts = options.maxConcurrentStarts ?? MAX_CONCURRENT_STARTS;
  const maxQueuedStarts = options.maxQueuedStarts ?? MAX_QUEUED_STARTS;
  /** Slot waiters, FIFO. */
  const queue = [];
  let running = 0;
  let closing = false;
  const spawnWorker =
    options.spawnWorker ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const workerCommand = options.workerCommand;
  const workerBackends = new Set(options.workerBackends ?? WORKER_BACKENDS);
  const adoptedTurnIsLive = async (turnId) => {
    if (options.adoptedTurns?.has(turnId) !== true) return false;
    let lock;
    try {
      lock = await acquireFileLock(join(runtimeDir, 'turns', turnId, 'worker.lock'));
      options.adoptedTurns.delete(turnId);
      await settleMissingWorkerTurn(runtimeDir, turnId);
      return false;
    } catch (error) {
      if (isLockBusy(error)) return true;
      throw error;
    } finally {
      await lock?.close();
    }
  };

  const terminate = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill('SIGTERM');
    const escalation = setTimeout(() => child.kill('SIGKILL'), options.shutdownGraceMs ?? 5_000);
    await exited;
    clearTimeout(escalation);
  };

  const startImpl = async (request) => {
    // Re-checked AFTER admission, not only at `start()`. Queueing put time between
    // the two: a start accepted while the supervisor was healthy can reach its slot
    // after `close()` has begun, and spawning a worker into a shutdown leaves one
    // behind that no supervisor owns.
    if (closing) throw new Error('runner supervisor is shutting down');
    if (typeof workerCommand !== 'string' || workerCommand.length === 0) {
      throw new Error('runner worker is not installed');
    }
    if (!workerBackends.has(request.backend)) {
      // Name the likely cause, not just the fact. The Server and this toolkit ship
      // and roll out separately, so the realistic way to reach this line is the
      // ordering constraint in ADR 0012 Amendment 4: a Server that already offers a
      // backend talking to a Sandbox whose image predates it, or was built without
      // that agent. The backend is real; this container does not have the adapter.
      // Listing what it does have turns an opaque refusal into "rebuild the image",
      // which is the actual fix and is not something the chat can otherwise deduce.
      // The list is `installedWorkerBackends()` in production, so it is what the
      // image carries rather than what this file was written knowing about.
      throw new Error(
        `worker does not support backend: ${request.backend} ` +
          `(this sandbox image provides ${[...workerBackends].sort().join(', ') || 'no agent adapter at all'}; ` +
          `a backend the server offers but this image lacks means the container predates it or was built without that agent, and needs rebuilding)`,
      );
    }
    const claim = await claimTurn(runtimeDir, request, runnerInstanceId);
    if (claim.outcome !== 'created') return claim;
    const turnDir = join(runtimeDir, 'turns', request.turnId);
    const cancelledInMemory = cancelledBeforeStart.delete(request.turnId);
    const tombstone = cancelledInMemory
      ? 'cancelled'
      : await readCancelTombstone(runtimeDir, request.turnId);
    if (tombstone !== 'absent') {
      // Settled without a worker ever existing — and still owed a terminal frame, or
      // the Server reads an empty stream behind a settled turn as a crash and badges
      // the operator's own cancel as a failure.
      //
      // Two different turns end here and they must not be given the same label. A
      // proven cancellation is the operator's own doing and is reported as `aborted`.
      // A tombstone that could not be READ stops the start for safety — running a turn
      // that was cancelled cannot be taken back — but it is a filesystem fault, and
      // telling the operator they cancelled a turn they did not is the same class of
      // lie `cancelExplainsSettlement` refuses to tell on the way out.
      const cancelled = tombstone === 'cancelled';
      await writeSyntheticTerminalFrame(turnDir, {
        turnId: request.turnId,
        runnerInstanceId,
        // The text is named explicitly because the signal alone would be a lie in the
        // frame's own words: with only `workerSignal` set the stderr line reads
        // "terminated by signal SIGTERM", and no process was terminated here — none
        // was started.
        //
        // And the signal itself is only carried for the cancelled half. SIGTERM
        // derives exit 143, which the Server reads as "the operator interrupted this"
        // (see `signalExitCode`) — true for a cancel, and the same false accusation as
        // `aborted` for a turn an unreadable tombstone stopped. That half reports an
        // ordinary failed start instead.
        ...(cancelled ? { workerSignal: 'SIGTERM' } : { workerExitCode: 1, workerSignal: null }),
        workerError: cancelled
          ? 'runner turn was cancelled before its worker started'
          : 'runner turn could not start: its cancellation record was unreadable',
        aborted: cancelled,
      }).catch(() => undefined);
      const state = await updateTurnState(runtimeDir, request.turnId, {
        status: 'settled',
        ...(cancelled
          ? { workerSignal: 'SIGTERM' }
          : {
              workerExitCode: 1,
              workerError: 'runner turn could not start: its cancellation record was unreadable',
            }),
      });
      return { outcome: 'terminal', state };
    }
    const requestPath = join(turnDir, 'request.json');
    const workerLockPath = join(turnDir, 'worker.lock');
    let child;
    let workerLock;
    let attestationTail = Promise.resolve();
    let workerErrorDone = Promise.resolve('');
    let exited = false;
    let resolveExit;
    const exitInfo = new Promise((resolve) => {
      resolveExit = resolve;
    });
    try {
      // The request is a one-worker capability channel. It must not be writable by
      // the shared runtime group after validation: the worker opens this inode once,
      // verifies its ownership/mode, and unlinks it before parsing.
      await writeJsonAtomic(requestPath, request, 0o600);
      await updateTurnState(runtimeDir, request.turnId, { workerLock: true });
      workerLock = await acquireFileLock(workerLockPath);
      child = spawnWorker(workerCommand, [...(options.workerArgs ?? []), requestPath], {
        cwd: request.cwd,
        stdio: stdioWithWorkerLock(workerLock.fd),
        env: {
          PATH: process.env.PATH,
          ...(options.workerEnv ?? {}),
          VERITY_RUNNER_TURN_DIR: turnDir,
          VERITY_RUNNER_EVENT_FILE: join(turnDir, 'events.jsonl'),
          VERITY_RUNNER_CONTROL_SOCKET: join(turnDir, 'control.sock'),
        },
      });
      if (child.stdout === null || child.stdout === undefined) {
        throw new Error('runner worker has no private attestation pipe');
      }
      if (child.stdin === null || child.stdin === undefined) {
        throw new Error('runner worker has no private attestation acknowledgement pipe');
      }
      if (child.stderr === null || child.stderr === undefined) {
        throw new Error('runner worker has no private error pipe');
      }
      const workerErrorCapture = createWorkerErrorCapture();
      let resolveWorkerError;
      let workerErrorSettled = false;
      const settleWorkerError = () => {
        if (workerErrorSettled) return;
        workerErrorSettled = true;
        resolveWorkerError(workerErrorCapture.finish());
      };
      child.stderr.on('data', (chunk) => workerErrorCapture.push(chunk));
      workerErrorDone = new Promise((resolveError) => {
        resolveWorkerError = resolveError;
        child.stderr.once('end', settleWorkerError);
      });
      child.once('exit', (code, signal) => {
        exited = true;
        children.delete(request.turnId);
        setTimeout(settleWorkerError, WORKER_ERROR_DRAIN_TIMEOUT_MS);
        resolveExit({ code, signal });
      });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.once('error', rejectSpawn);
      });
    } catch (error) {
      const workerError = boundedSpawnError(error instanceof Error ? error.message : String(error));
      // The frame below declares this turn dead, so nothing may still be alive under
      // it. Reaching here with a live child is not the ordinary `spawn`-failed case
      // — that child has no pid at all — but the guards above can also reject a
      // process that DID start, and a synthetic terminal frame over a running agent
      // is worse than the failure it reports. The signal goes to the pid alone, which
      // is all `terminate()` does too — the worker is spawned attached, in this
      // supervisor's own process group, so there is no group to signal and no
      // detached descendant this could miss that `terminate()` would catch.
      // `terminate()` itself is deliberately not used: it awaits an `exit` that never
      // arrives for a child which failed to spawn.
      //
      // Before the lock is dropped, not after, and not merely signalled before it: the
      // worker lock IS the liveness signal recovery reads (`adoptedTurnIsLive`), so a
      // lock released while a rejected child is still dying lets a concurrent probe
      // find it free, call the worker missing and settle a turn that is very much
      // alive. SIGKILL cannot be refused, so the wait is short and bounded — and
      // bounded rather than open-ended because a turn that cannot be ended must still
      // be reported.
      // A child that never got a pid cannot write anything, so there is nothing to
      // outlive the frame below. Any other case has to be PROVED dead.
      let reaped = child?.pid === undefined;
      if (!reaped) {
        child.kill('SIGKILL');
        if (!exited) {
          await Promise.race([
            exitInfo,
            new Promise((resolve) => setTimeout(resolve, REJECTED_WORKER_EXIT_WAIT_MS).unref?.()),
          ]);
        }
        // Set synchronously by the `exit` handler, so it distinguishes which side of
        // the race won: `exitInfo` means reaped, the timer means still there.
        reaped = exited;
      }
      await workerLock?.close().catch(() => undefined);
      // Same reasoning as the exit path: a turn that settles must leave the Server a
      // terminal frame to settle FROM, or the session badges `running` forever. And
      // the same reasoning for `aborted`: a cancel that lands while the spawn is
      // failing is still a cancel, so read the durable tombstone rather than let the
      // race decide whether the operator sees a crash. That read cannot throw here —
      // see {@link readCancelTombstone} — because everything below it is what settles
      // the turn.
      //
      // Only over a child PROVED dead, though. SIGKILL cannot be refused but it can
      // be outwaited — a process wedged in uninterruptible sleep is exactly the case
      // the bound above accepts — and a worker that comes back after this frame owns
      // `frameSeq` 1 too. Its first frame would then collide with a fabricated
      // terminal one carrying a different payload hash, and a stream the Store
      // refuses to ingest is worse than the missing frame this writes: the state
      // below still carries the exit reason, so the Server reports
      // `worker-exited-early` with the captured stderr rather than the bare "exited
      // with code 1" this path exists to replace.
      if (reaped) {
        await writeSyntheticTerminalFrame(turnDir, {
          turnId: request.turnId,
          runnerInstanceId,
          workerExitCode: 1,
          workerSignal: null,
          workerError,
          aborted: await cancelExplainsSettlement(runtimeDir, request.turnId),
        }).catch(() => undefined);
      }
      await updateTurnState(runtimeDir, request.turnId, {
        status: 'settled',
        ...(workerError.length > 0 ? { workerError } : {}),
      });
      // eslint-disable-next-line preserve-caught-error -- raw spawn exceptions may contain credentials.
      throw new Error(workerError);
    }
    // INVARIANT from here down: no throw may escape this function while the child is
    // alive. The Server treats a refusal it HEARS as decided — no reconciliation, no
    // cancel fence — so a spoken failure over a running worker is precisely the orphan
    // this file exists to prevent. Everything between here and the guarded block below
    // is therefore synchronous and non-throwing; the one thing that can fail, the
    // `running` state write, is awaited inside it and answered by `terminate(child)`.
    if (!exited) children.set(request.turnId, child);
    const runningState = updateTurnState(runtimeDir, request.turnId, {
      status: 'running',
      workerPid: child.pid,
    });
    const settlement = exitInfo
      .then(async ({ code, signal }) => {
        await runningState.catch(() => undefined);
        await attestationTail;
        const workerError = await workerErrorDone;
        // Before the state says "settled", make sure the STREAM says why. A worker
        // that exited without writing a single frame leaves the Server a turn that
        // ended and nothing to end it with; this is the only place that still holds
        // the exit code, the signal and the captured stderr.
        // The same predicate the other two callers use — one question, one spelling,
        // so a tombstone that stops counting as one cannot start counting here.
        const aborted = await cancelExplainsSettlement(runtimeDir, request.turnId);
        const wrote = await writeSyntheticTerminalFrame(turnDir, {
          turnId: request.turnId,
          runnerInstanceId,
          workerExitCode: code,
          workerSignal: signal,
          workerError,
          aborted,
        }).catch(() => false);
        if (wrote) {
          logTelemetry({
            event: 'worker-exited-without-events',
            turnId: request.turnId,
            exitCode: code,
            signal,
          });
        }
        return await updateTurnState(runtimeDir, request.turnId, {
          status: 'settled',
          workerExitCode: code,
          workerSignal: signal,
          ...(code !== 0 || signal !== null ? (workerError.length > 0 ? { workerError } : {}) : {}),
        });
      })
      .catch(() => undefined);
    settlements.add(settlement);
    settlementsByTurn.set(request.turnId, settlement);
    void settlement.finally(() => {
      settlements.delete(settlement);
      if (settlementsByTurn.get(request.turnId) === settlement) {
        settlementsByTurn.delete(request.turnId);
      }
    });
    let state;
    try {
      state = await runningState;
      await workerLock.close();
    } catch (error) {
      await terminate(child);
      await workerLock.close().catch(() => undefined);
      await settlement;
      throw error;
    }
    return { outcome: 'created', state };
  };

  /**
   * Admit one start into the bounded worker-spawn pool.
   *
   * Everything a start does is expensive and contended — fsyncs, a `flock` fork,
   * the worker fork — so an unbounded burst does not go faster, it goes slower for
   * everyone and makes each individual start look wedged. Queueing makes the wait a
   * number (`queueMs`) rather than a mystery, and the cap makes overload a refusal
   * the Server can show rather than a timeout it has to interpret.
   */
  const admit = (run) => {
    let slot;
    if (running >= maxConcurrentStarts) {
      if (queue.length >= maxQueuedStarts) {
        throw new Error('runner supervisor start queue is full');
      }
      slot = new Promise((resolveSlot) => queue.push(resolveSlot));
    } else {
      // Reserve synchronously. `start()` acknowledges immediately after `admit`
      // returns, so deferring this increment to a promise microtask would let a
      // same-tick burst observe stale capacity and over-admit every request.
      running += 1;
      slot = Promise.resolve();
    }
    return slot.then(async () => {
      try {
        return await run();
      } finally {
        const next = queue.shift();
        if (next === undefined) running -= 1;
        else next(); // Transfer this reserved slot directly to the oldest waiter.
      }
    });
  };

  /**
   * Accept a start-turn.
   *
   * Returns `{ accepted, pending }`: `accepted` is settled the moment the request is
   * VALID and queued, which is what the Server acknowledges on, while `pending`
   * carries the real outcome. Splitting the two is what lets a start take as long as
   * it honestly takes without the Server having to choose between a short budget
   * that abandons live turns and a long one that hides a wedged supervisor.
   *
   * A start for a turn that already has one in flight returns THAT promise rather
   * than chaining a second `startImpl`. The chained version was idempotent only by
   * grace of `claimTurn` refusing the duplicate afterwards; collapsing here means a
   * retried start does no work at all, and — with `cancel` still awaiting the single
   * per-turn promise — a retry storm can neither queue behind itself nor outrun the
   * cancel that is waiting for it.
   */
  const start = (rawRequest) => {
    if (closing) throw new Error('runner supervisor is shutting down');
    const request = validateStartTurnRequest(rawRequest);
    const previous = startsByTurn.get(request.turnId);
    // Only a retry of the SAME start command is the same work. A different command
    // for an in-flight turn is rejected synchronously: queueing conflicts would let
    // an unbounded flood bypass the global queue cap by chaining on one turn.
    if (previous !== undefined && previous.startCommandId === request.startCommandId) {
      // Once per turn, not once per retry: a Server that re-sends in a loop would
      // otherwise write the supervisor's own stderr full of the fact that it is
      // being retried, which is the least useful line to lose the real ones behind.
      if (!previous.loggedDeduplication) {
        previous.loggedDeduplication = true;
        logTelemetry({ event: 'start-deduplicated', turnId: request.turnId });
      }
      return { accepted: true, pending: previous.promise };
    }
    if (previous !== undefined) {
      throw new Error(`turn ${request.turnId} is already starting under another command`);
    }
    const queuedAt = Date.now();
    // `admit` reserves capacity or throws BEFORE this function returns. Therefore a
    // start acknowledgement means exactly what it says: the request owns a running
    // slot or a bounded queue slot, never a promise that may later reject as full.
    // Note the order with the dedup above: a retry of a start that is still queued
    // is answered from `startsByTurn` and never reaches `admit`, so a Server that
    // re-sends a lost start can never be told the queue is full while its original
    // is sitting in that very queue.
    const entry = { promise: undefined, startCommandId: request.startCommandId };
    const promise = admit(async () => {
      const startedAt = Date.now();
      entry.admitted = true;
      try {
        return await startImpl(request);
      } finally {
        // A `finally` around a value the caller is about to receive: anything thrown
        // here would REPLACE a successful start with a spoken failure, over a worker
        // that is already running — the same orphan `startImpl`'s post-spawn invariant
        // rules out. Both calls below swallow their own errors for that reason, and
        // any line added here must too.
        logTelemetry({
          event: 'start',
          turnId: request.turnId,
          queueMs: startedAt - queuedAt,
          startMs: Date.now() - startedAt,
          // Read in `run()`'s `finally`, BEFORE the slot is handed on, so this start
          // is still counted in `activeStarts` and its own record includes itself.
          // The Server-side `SupervisorStartTelemetry.activeStarts` excludes the
          // start it describes: same name, one more here, and this is the stream
          // where "how many were running while this one waited" is the question.
          queuedStarts: queue.length,
          activeStarts: running,
          activeWorkers: children.size,
          eventLoopDelayMs: sampleEventLoopDelay(),
        });
      }
    });
    entry.promise = promise;
    starts.add(promise);
    startsByTurn.set(request.turnId, entry);
    void promise
      .finally(() => {
        starts.delete(promise);
        if (startsByTurn.get(request.turnId) === entry) startsByTurn.delete(request.turnId);
      })
      .catch(() => undefined);
    return { accepted: true, pending: promise };
  };

  const cancel = async (turnId) => {
    if (typeof turnId !== 'string' || !SAFE_ID.test(turnId)) throw new Error('invalid turnId');
    // Register before the first await. A concurrent start either observes this
    // after its claim or is included in `startsByTurn` and awaited below.
    cancelledBeforeStart.add(turnId);
    await mkdir(join(runtimeDir, 'cancellations'), { recursive: true, mode: 0o770 });
    await writeJsonAtomic(cancelPath(runtimeDir, turnId), {
      protocolVersion: 1,
      turnId,
      cancelledAt: Date.now(),
    });
    // A cancel can arrive after the durable claim but before the worker is entered
    // in `children`. Wait only for this turn's in-flight start to cross that seam —
    // and only if it is ADMITTED. A start still waiting for a slot has written
    // nothing and settles itself against the tombstone above the moment it is
    // admitted, so waiting for it would put the operator's cancel behind the whole
    // queue of unrelated spawns and blow the Server's control-request budget.
    const inFlight = startsByTurn.get(turnId);
    if (inFlight?.admitted === true) await inFlight.promise.catch(() => undefined);
    const currentState = await readTurnState(runtimeDir, turnId);
    if (currentState === undefined) {
      // A start request on another socket may not have reached `claimTurn` yet.
      // Persist the intent in memory so that this supervisor settles the turn
      // immediately if that start arrives after the cancel request.
      return { outcome: 'cancelled' };
    }
    if (currentState.status === 'settled') {
      cancelledBeforeStart.delete(turnId);
      return { outcome: 'terminal', state: currentState };
    }
    const child = children.get(turnId);
    if (child === undefined) {
      // A worker owned by a previous supervisor instance cannot be addressed by
      // this process without risking PID reuse. Recovery will settle it once its
      // durable worker lock disappears.
      throw new Error('runner worker is not owned by this supervisor');
    }
    try {
      await terminate(child);
      await settlementsByTurn.get(turnId);
      return { outcome: 'cancelled', state: await readTurnState(runtimeDir, turnId) };
    } finally {
      // Keep the capability revoked throughout the SIGTERM/SIGKILL grace window.
      cancelledBeforeStart.delete(turnId);
    }
  };

  return {
    start,
    cancel,
    runTrustedCli(request, onSpawned) {
      return runTrustedCliViaBroker(request, {
        runtimeDir,
        ...(options.brokerSocket === undefined ? {} : { brokerSocket: options.brokerSocket }),
        ...(onSpawned === undefined ? {} : { onSpawned }),
        authorize: async ({ turnId }) =>
          !cancelledBeforeStart.has(turnId) &&
          (children.has(turnId) || (await adoptedTurnIsLive(turnId))),
      });
    },
    async close() {
      closing = true;
      await Promise.allSettled([...starts]);
      await Promise.all([...children.values()].map(terminate));
      await Promise.all([...settlements]);
    },
  };
}

export function createTurnAdopter(runtimeDir, options = {}) {
  const pollMs = options.adoptionPollMs ?? 250;
  const adopted = options.adoptedTurns ?? new Set();
  let timer;
  let closed = false;
  let polling = false;

  const probe = async (turnId, initial) => {
    const lockPath = join(runtimeDir, 'turns', turnId, 'worker.lock');
    let lock;
    try {
      lock = await acquireFileLock(lockPath);
    } catch (error) {
      if (!isLockBusy(error)) return 'uncertain';
      if (initial) {
        const state = await readTurnState(runtimeDir, turnId);
        if (state?.status === 'claimed') {
          await updateTurnState(runtimeDir, turnId, {
            status: 'running',
            adoptedAt: Date.now(),
          }).catch(() => undefined);
        }
      }
      return 'live';
    }
    try {
      try {
        await settleMissingWorkerTurn(runtimeDir, turnId);
      } catch {
        return 'uncertain';
      }
      return 'dead';
    } finally {
      await lock.close();
    }
  };

  const schedule = () => {
    if (closed || adopted.size === 0 || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, pollMs);
    timer.unref?.();
  };

  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      for (const turnId of [...adopted]) {
        const disposition = await probe(turnId, false).catch(() => 'uncertain');
        if (disposition === 'dead') adopted.delete(turnId);
      }
    } finally {
      polling = false;
      schedule();
    }
  };

  return {
    async adopt() {
      for (const state of await listTurns(runtimeDir)) {
        if (state.status !== 'claimed' && state.status !== 'running') continue;
        // Turns created before worker-lock adoption shipped have no authoritative
        // liveness lock. Never infer death from its absence during a rolling deploy.
        if (state.workerLock !== true) continue;
        const disposition = await probe(state.turnId, true).catch(() => 'uncertain');
        if (disposition === 'live') adopted.add(state.turnId);
      }
      schedule();
    },
    async close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      while (polling) await new Promise((resolvePoll) => setTimeout(resolvePoll, 1));
      adopted.clear();
    },
  };
}

export async function listTurns(runtimeDir) {
  const turnsDir = join(runtimeDir, 'turns');
  const entries = await readdir(turnsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    try {
      const state = await readTurnState(runtimeDir, entry.name);
      states.push(state ?? { turnId: entry.name, status: 'ambiguous', reason: 'missing-state' });
    } catch {
      // Discovery fails closed per D3: a corrupt directory remains visible and
      // can never be mistaken for an absent turn that is safe to launch again.
      states.push({ turnId: entry.name, status: 'ambiguous', reason: 'invalid-state' });
    }
  }
  return states.sort((a, b) => String(a.turnId).localeCompare(String(b.turnId)));
}

function responseForError(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(isObject(error?.trustedCliFailure) ? { trustedCliFailure: error.trustedCliFailure } : {}),
  };
}

export async function handleSupervisorRequest(
  runtimeDir,
  runnerInstanceId,
  request,
  turnStarter,
  onTrustedCliStarted,
  onStartAccepted,
) {
  if (!isObject(request) || !supportedRequestVersion(request.protocolVersion)) {
    throw new Error('unsupported supervisor protocol');
  }
  switch (request.kind) {
    case 'status':
      return { ok: true, protocolVersion: SUPERVISOR_PROTOCOL_VERSION, runnerInstanceId };
    case 'list-turns':
      return { ok: true, turns: await listTurns(runtimeDir) };
    case 'get-turn': {
      if (typeof request.turnId !== 'string') throw new Error('invalid turnId');
      return { ok: true, state: await readTurnState(runtimeDir, request.turnId) };
    }
    case 'claim-turn':
      return { ok: true, ...(await claimTurn(runtimeDir, request, runnerInstanceId)) };
    case 'start-turn': {
      if (turnStarter === undefined) throw new Error('runner worker is not installed');
      // `start` throws on an invalid or refused request, so the acknowledgement can
      // only ever follow an acceptance the supervisor actually made. Everything the
      // Server needs to stop guessing — that the frame was understood and the turn
      // is claimed or about to be — is true by the time this line runs.
      const { pending } = turnStarter.start(request);
      onStartAccepted?.();
      return { ok: true, ...(await pending) };
    }
    case 'cancel-turn':
      if (turnStarter === undefined) throw new Error('runner worker is not installed');
      return { ok: true, ...(await turnStarter.cancel(request.turnId)) };
    case 'run-trusted-cli':
      if (typeof turnStarter?.runTrustedCli !== 'function') {
        throw new Error('runner worker is not installed');
      }
      return {
        ok: true,
        ...(await turnStarter.runTrustedCli(request, onTrustedCliStarted)),
      };
    default:
      throw new Error('unknown supervisor request');
  }
}

export async function runSupervisor(options = {}) {
  const runtimeDir = options.runtimeDir ?? process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const expectedUid = Number(
    options.uid ?? process.env.VERITY_RUNNER_RUNTIME_UID ?? process.getuid?.(),
  );
  const expectedGid = Number(
    options.gid ?? process.env.VERITY_RUNNER_RUNTIME_GID ?? process.getgid?.(),
  );
  await validateRuntimeDirectory(runtimeDir, { uid: expectedUid, gid: expectedGid });
  // Arm the histogram here rather than on the first start, which would otherwise be
  // the one record with no delay figure attached — and the first start after boot is
  // exactly when the supervisor is busiest and the figure most worth having.
  //
  // Unconditional here, unlike the Server-side sampler, which arms only for a client
  // that was given an `onTelemetry` sink. The asymmetry is deliberate: this process
  // exists to run turns and always writes the record, whereas `@verity/session` is
  // imported by CLIs that never read one — there, arming is a cost with no reader.
  sampleEventLoopDelay();
  const singleton = await acquireSingleton(runtimeDir);
  const adoptedTurns = new Set();
  const turnOptions = { ...options, adoptedTurns };
  const turnStarter = createTurnStarter(runtimeDir, singleton.instanceId, turnOptions);
  const turnAdopter = createTurnAdopter(runtimeDir, turnOptions);
  try {
    await turnAdopter.adopt();
  } catch (error) {
    await turnAdopter.close();
    await turnStarter.close();
    await singleton.release();
    throw error;
  }
  const socketPath = join(runtimeDir, 'supervisor.sock');
  try {
    await rm(socketPath, { force: true });
  } catch (error) {
    await turnAdopter.close();
    await turnStarter.close();
    await singleton.release();
    throw error;
  }
  const readyPath = join(runtimeDir, 'supervisor.json');
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    // Peer resets are protocol failures, not supervisor process failures.
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let handled = false;
    let processingStarted = false;
    let pipelinedAfterNewline = false;
    let timeout = setTimeout(() => socket.destroy(), 5_000);
    const setRequestTimeout = (milliseconds) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => socket.destroy(), milliseconds);
    };
    const respond = (response) => {
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
    };
    // Refusing a peer that is STILL WRITING is the one case where destroying the
    // socket destroys the answer with it: the RST can drop the refusal out of the
    // peer's receive buffer, and its own pending write then fails with EPIPE —
    // which is how an oversize attachment reaches the operator as a bare `write
    // EPIPE` naming neither size nor attachments. So send the refusal and keep
    // reading and DISCARDING until the peer finishes and closes. Nothing is
    // buffered, so the memory bound this cap exists to enforce still holds, and
    // the grace timer keeps a stalled peer from pinning the connection open.
    const respondDraining = (response) => {
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(response)}\n`);
      const grace = setTimeout(() => socket.destroy(), OVERSIZE_DRAIN_GRACE_MS);
      socket.once('close', () => clearTimeout(grace));
    };
    socket.on('data', (chunk) => {
      if (handled) {
        // A second request may arrive in a later Unix-socket chunk. Give framing
        // one event-loop turn before applying the first request so TCP/Unix chunk
        // boundaries cannot turn the same pipelined bytes into different behavior.
        if (!processingStarted && chunk.length > 0) pipelinedAfterNewline = true;
        return;
      }
      if (buffered.length + chunk.length > MAX_CONTROL_LINE_BYTES) {
        handled = true;
        buffered = Buffer.alloc(0);
        respondDraining(responseForError(new Error('supervisor frame too large')));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      const line = buffered.subarray(0, newline).toString('utf8');
      const remainder = buffered.subarray(newline + 1);
      buffered = Buffer.alloc(0);
      if (remainder.length > 0) {
        respond(responseForError(new Error('supervisor accepts exactly one request')));
        return;
      }
      void new Promise((resolve) => setImmediate(resolve))
        .then(() => {
          processingStarted = true;
          if (pipelinedAfterNewline) {
            throw new Error('supervisor accepts exactly one request');
          }
        })
        .then(() => JSON.parse(line))
        .then((request) => {
          setRequestTimeout(supervisorRequestTimeoutMs(request));
          return handleSupervisorRequest(
            runtimeDir,
            singleton.instanceId,
            request,
            turnStarter,
            request?.kind === 'run-trusted-cli'
              ? () => socket.write(`${JSON.stringify({ ok: true, kind: 'trusted-cli-started' })}\n`)
              : undefined,
            // Only when the Server asked for it. A Server that predates the two-phase
            // reply reads exactly one frame per request and would refuse a second as
            // an invalid frame count — the D9 half of this change that keeps a new
            // Sandbox image usable by an older Server.
            request?.kind === 'start-turn' && request.startAck === true
              ? () =>
                  socket.write(
                    `${JSON.stringify({
                      ok: true,
                      kind: 'start-accepted',
                      // The raw request's ids, which the client compares strictly
                      // against the ones it sent. Sound because `validateStartTurnRequest`
                      // only TESTS these two against `SAFE_ID` and never rewrites them;
                      // a validator that ever normalized an id would have to echo the
                      // normalized value here instead.
                      turnId: request.turnId,
                      startCommandId: request.startCommandId,
                    })}\n`,
                  )
              : undefined,
          );
        })
        .catch(responseForError)
        .then(respond);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o660);
    await writeJsonAtomic(readyPath, {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      runnerInstanceId: singleton.instanceId,
      pid: process.pid,
      socketPath,
      readyAt: Date.now(),
    });
  } catch (error) {
    server.close();
    await turnAdopter.close();
    await turnStarter.close();
    await rm(socketPath, { force: true });
    await singleton.release();
    throw error;
  }
  const close = async () => {
    await turnAdopter.close();
    await turnStarter.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
    await rm(readyPath, { force: true });
    await singleton.release();
  };
  return { runtimeDir, socketPath, instanceId: singleton.instanceId, close };
}

export async function probeSupervisor(runtimeDir = DEFAULT_RUNTIME_DIR, timeoutMs = 1_000) {
  const socketPath = join(runtimeDir, 'supervisor.sock');
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    const finish = (live) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(live);
    };
    socket.once('error', () => finish(false));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true && parsed.protocolVersion === SUPERVISOR_PROTOCOL_VERSION);
      } catch {
        finish(false);
      }
    });
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ protocolVersion: SUPERVISOR_PROTOCOL_VERSION, kind: 'status' })}\n`,
      );
    });
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const command = process.argv[2];
  const brokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  const launch =
    command === '--probe'
      ? probeSupervisor(runtimeDir)
      : runSupervisor(
          brokerSocket === undefined
            ? undefined
            : {
                runtimeDir,
                workerCommand:
                  process.env.VERITY_RUNNER_WORKER ?? '/usr/local/bin/verity-runner-worker',
                workerBackends: installedWorkerBackends(),
                workerEnv: supervisorWorkerEnv(process.env),
              },
        );
  launch
    .then((supervisor) => {
      if (typeof supervisor === 'boolean') {
        process.exitCode = supervisor ? 0 : 1;
        return;
      }
      const shutdown = () => {
        void supervisor.close().finally(() => process.exit(0));
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error) => {
      process.stderr.write(`verity-runner-supervisor: ${responseForError(error).error}\n`);
      process.exitCode = 1;
    });
}
