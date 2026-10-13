import { parseStallReceipt } from './stall-receipt.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const readyFields = ['type', 'requestId', 'sessionId', 'ticket', 'expiresAt', 'capability'];
const origin = new URL(process.env.VERITY_REMOTE_UPLINK_ORIGIN ?? '');
const handle = process.env.VERITY_REMOTE_INSTALLATION_HANDLE ?? '';
const coreUrl = process.env.VERITY_REMOTE_CORE_URL ?? '';
const corePin = process.env.VERITY_REMOTE_CORE_PIN ?? '';
const binary = process.env.VERITY_REMOTE_PROBE_BINARY ?? '';
// The app-mode probe pauses this long between requests, as a reading user does.
const idleSeconds = Number(process.env.VERITY_REMOTE_PROBE_IDLE_SECONDS ?? '0');
// And keeps several streams busy this long, as the device does across a session.
// Digits only: the native side parses the same value, and a spelling it reads
// as zero would skip the soak and leave the run green.
const soakText = process.env.VERITY_REMOTE_PROBE_SOAK_SECONDS ?? '0';
const soakSeconds = /^\d{1,3}$/u.test(soakText) ? Number(soakText) : Number.NaN;
// A soak shorter than one request timeout could issue no request and pass.
const SOAK_MIN_SECONDS = 30;
const soakStreamsText = process.env.VERITY_REMOTE_PROBE_SOAK_STREAMS ?? '4';
const soakStreams = /^[1-8]$/u.test(soakStreamsText) ? Number(soakStreamsText) : Number.NaN;
if (
  origin.protocol !== 'https:' ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password ||
  !idPattern.test(handle) ||
  !binary ||
  !Number.isInteger(idleSeconds) ||
  idleSeconds < 0 ||
  idleSeconds > 600 ||
  !Number.isInteger(soakSeconds) ||
  (soakSeconds !== 0 && soakSeconds < SOAK_MIN_SECONDS) ||
  soakSeconds > 600 ||
  !Number.isInteger(soakStreams) ||
  !corePin.startsWith('sha256-') ||
  new URL(coreUrl).protocol !== 'https:'
) {
  throw new Error('Invalid Remote Control staging probe inputs.');
}

const requestId = randomBytes(16).toString('base64url');
const admissionUrl = new URL('/remote-control', origin);
admissionUrl.protocol = 'wss:';
const dataUrl = new URL('/data', origin);
dataUrl.protocol = 'wss:';
const socket = new WebSocket(admissionUrl, { handshakeTimeout: 10_000, maxPayload: 16 * 1024 });
let child;
let attached = false;
let finished = false;
let timeout;
/** @type {{startedAt: string, sessionHash: string | null, stage: string,
 * tlsPhase: string | undefined, nativeErrorCode: number | null, nativeExitCode: number | null,
 * soak: {worker: number, ownRequests: number, totalRequests: number, requestNumber?: number,
 * failureKind?: string | undefined} | null, stall?: import('./stall-receipt.mjs').StallDiagnostic}} */
const receipt = {
  startedAt: new Date().toISOString(),
  sessionHash: null,
  stage: 'admission',
  tlsPhase: 'unknown',
  nativeErrorCode: null,
  soak: null,
  nativeExitCode: null,
};
const stages = new Set([
  'attached',
  'listener_ready',
  'https_request',
  'http_response',
  'soak_failed',
]);
const phases = new Set([
  'NO_AUTH_CHALLENGE',
  'AUTH_CHALLENGE_RECEIVED',
  'PIN_AND_CHAIN_TRUST_ACCEPTED',
]);
let soakFailureReceived = false;
function consumeLine(line) {
  // Later worker cleanup must not overwrite the first complete failure record.
  if (soakFailureReceived) return;
  const stall = parseStallReceipt(line);
  if (stall) {
    receipt.soak = {
      worker: stall.worker,
      ownRequests: stall.ownRequests,
      totalRequests: stall.totalRequests,
      requestNumber: stall.ownRequests + 1,
      failureKind: stall.kind,
    };
    receipt.nativeErrorCode = stall.code;
    receipt.tlsPhase = stall.phase;
    receipt.stage = 'soak_failed';
    receipt.stall = stall.diagnostic;
    soakFailureReceived = true;
    return;
  }
  const failure =
    /^probe-soak-failure:([0-7]):(\d{1,9}):(\d{1,9}):(tunnel_stopped|configuration|http_response|transport):(unknown|-?\d{1,9}):(unknown|NO_AUTH_CHALLENGE|AUTH_CHALLENGE_RECEIVED|PIN_AND_CHAIN_TRUST_ACCEPTED)$/u.exec(
      line,
    );
  if (failure) {
    const ownRequests = Number(failure[2]);
    const totalRequests = Number(failure[3]);
    if (ownRequests > totalRequests) return;
    receipt.soak = {
      worker: Number(failure[1]),
      ownRequests,
      totalRequests,
      requestNumber: ownRequests + 1,
      failureKind: failure[4],
    };
    receipt.nativeErrorCode = failure[5] === 'unknown' ? null : Number(failure[5]);
    receipt.tlsPhase = failure[6];
    receipt.stage = 'soak_failed';
    soakFailureReceived = true;
    return;
  }
  const soak = /^probe-soak:(\d{1,2}):(\d{1,9}):(\d{1,9})$/u.exec(line);
  if (soak)
    receipt.soak = {
      worker: Number(soak[1]),
      ownRequests: Number(soak[2]),
      totalRequests: Number(soak[3]),
    };
  if (/^probe-error:-?\d{1,9}$/u.test(line)) receipt.nativeErrorCode = Number(line.slice(12));
  if (line === 'attached') {
    attached = true;
    receipt.stage = 'attached';
  }
  if (line.startsWith('probe-stage:') && stages.has(line.slice(12))) receipt.stage = line.slice(12);
  if (line.startsWith('probe-tls:') && phases.has(line.slice(10)))
    receipt.tlsPhase = line.slice(10);
}

try {
  const result = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (finished) return;
      finished = true;
      child?.kill();
      socket.terminate();
      reject(error);
    };
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'connect',
          requestId,
          installationHandle: handle,
          capabilities: ['remote-control-v1'],
        }),
      );
    });
    socket.on('message', (raw, isBinary) => {
      if (child || isBinary || raw.length > 16 * 1024) {
        fail(new Error('Invalid admission response.'));
        return;
      }
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        fail(new Error('Invalid admission response.'));
        return;
      }
      if (frame?.type === 'connect.error' && frame.requestId === requestId) {
        fail(new Error(`Admission refused: ${String(frame.code).slice(0, 64)}`));
        return;
      }
      if (
        frame?.type !== 'connect.ready' ||
        typeof frame !== 'object' ||
        Array.isArray(frame) ||
        Object.keys(frame).length !== readyFields.length ||
        !readyFields.every((key) => Object.hasOwn(frame, key)) ||
        frame.requestId !== requestId ||
        frame.capability !== 'remote-control-v1' ||
        typeof frame.sessionId !== 'string' ||
        !idPattern.test(frame.sessionId) ||
        typeof frame.ticket !== 'string' ||
        !idPattern.test(frame.ticket) ||
        !Number.isSafeInteger(frame.expiresAt) ||
        frame.expiresAt <= Date.now()
      ) {
        fail(new Error('Invalid admission response.'));
        return;
      }
      receipt.sessionHash = createHash('sha256').update(frame.sessionId).digest('hex').slice(0, 16);
      receipt.stage = 'native_start';
      child = spawn(binary, [], {
        env: {
          ...process.env,
          VERITY_REMOTE_DATA_URL: dataUrl.href,
          // No device token is available: probe the public liveness route.
          // URL resolution preserves the paired TLS host and port.
          VERITY_REMOTE_CORE_URL: new URL('/healthz', coreUrl).href,
          VERITY_REMOTE_TICKET: frame.ticket,
          VERITY_REMOTE_SESSION_ID: frame.sessionId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let pending = '';
      let discardLine = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        // Bound both retained success output and partial diagnostic lines.
        stdout = (stdout + chunk).slice(-65536);
        for (const character of chunk) {
          if (character === '\n') {
            if (!discardLine) consumeLine(pending.replace(/\r$/u, ''));
            pending = '';
            discardLine = false;
          } else if (!discardLine) {
            pending += character;
            if (pending.length > 4096) {
              pending = '';
              discardLine = true;
            }
          }
        }
      });
      // Native NSError text may contain URLs or peer-controlled data.
      child.stderr.resume();
      child.on('error', fail);
      child.on('close', (code) => {
        receipt.nativeExitCode = code;
        if (finished) return;
        finished = true;
        socket.close();
        if (code !== 0 || !attached || !/Core HTTPS status: 200(?:\r?\n|$)/u.test(stdout)) {
          reject(new Error('Native staging probe did not complete an attached Core HTTPS GET.'));
          return;
        }
        process.stdout.write(stdout.replace('attached\n', ''));
        resolve();
      });
    });
    socket.on('error', fail);
    socket.on('close', (code) => {
      // A validated ready response completes admission before native DATA attaches.
      if (!child || code !== 1000)
        fail(new Error('Admission closed before successful completion.'));
    });
  });
  const watchdog = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Remote Control staging probe timed out.')),
      // Workers finish the request in flight and one pause after the deadline.
      45_000 + (idleSeconds + soakSeconds) * 1_000 + (soakSeconds > 0 ? 15_000 : 0),
    );
  });
  await Promise.race([result, watchdog]);
} catch (error) {
  process.stderr.write(
    `Probe failure receipt: ${JSON.stringify({ ...receipt, endedAt: new Date().toISOString() })}\n`,
  );
  const reasons = new Set([
    'Invalid admission response.',
    'Admission closed before successful completion.',
    'Remote Control staging probe timed out.',
    'Native staging probe did not complete an attached Core HTTPS GET.',
  ]);
  process.stderr.write(
    `${reasons.has(error?.message) ? error.message : 'Probe transport failed.'}\n`,
  );
  process.exitCode = receipt.nativeExitCode > 0 ? receipt.nativeExitCode : 1;
} finally {
  clearTimeout(timeout);
  finished = true;
  child?.kill();
  socket.terminate();
}
