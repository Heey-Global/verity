import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
        !idPattern.test(frame.sessionId) ||
        !idPattern.test(frame.ticket) ||
        !Number.isSafeInteger(frame.expiresAt) ||
        frame.expiresAt <= Date.now()
      ) {
        fail(new Error('Invalid admission response.'));
        return;
      }
      child = spawn(binary, [], {
        env: {
          ...process.env,
          VERITY_REMOTE_DATA_URL: dataUrl.href,
          VERITY_REMOTE_TICKET: frame.ticket,
          VERITY_REMOTE_SESSION_ID: frame.sessionId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('attached\n') && !attached) {
          attached = true;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.on('error', fail);
      child.on('exit', (code) => {
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
    socket.on('close', () => {
      if (!attached) fail(new Error('Admission closed before data attachment.'));
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
} finally {
  clearTimeout(timeout);
  finished = true;
  child?.kill();
  socket.terminate();
}
