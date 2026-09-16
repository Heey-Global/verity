import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * @typedef {{ seq: number, event: import('../packages/events/src/index.js').AgentEvent }} HistoryEvent
 * @typedef {{
 *   status?: string,
 *   sealed?: boolean,
 *   masterPasswordSet?: boolean,
 *   hasProject?: boolean,
 *   bootstrapToken?: string,
 *   token?: string,
 *   sessionId?: string,
 *   projectId?: string,
 *   settings?: { advancedModeEnabled?: boolean },
 *   events?: HistoryEvent[],
 *   hasMore?: boolean
 * }} ResponseBody
 * @typedef {{ method?: string, body?: unknown, token?: string, pairing?: string }} RequestOptions
 * @typedef {{ status: number, body: ResponseBody }} ApiResponse
 * @typedef {(path: string, options?: RequestOptions) => Promise<ApiResponse>} Api
 * @typedef {{ password: string, token: string, sessionId: string }} AcceptanceState
 * @typedef {(milliseconds: number) => Promise<unknown>} Pause
 */

const firstPrompt = 'managed-install-before-restart';
const secondPrompt = 'managed-install-after-restart';
const responsePrefix = 'Verity managed install: Grüße — größer 🚀\n';

// Responses can contain credentials. Diagnostics identify the route and status,
// never response bodies, pairing codes, passwords or device tokens.
/**
 * @param {{ baseUrl: string, ca: Buffer, servername?: string }} options
 * @returns {Api}
 */
export function createApi({ baseUrl, ca, servername = 'localhost' }) {
  assert.equal(new URL(baseUrl).protocol, 'https:', 'acceptance must use the TLS gateway');
  return (path, { method = 'GET', body, token, pairing } = {}) =>
    new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = https.request(
        new URL(path, baseUrl),
        {
          method,
          ca,
          servername,
          rejectUnauthorized: true,
          headers: {
            ...(bytes === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': bytes.length }),
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            ...(pairing === undefined ? {} : { 'x-verity-pairing': pairing }),
          },
        },
        (response) => {
          /** @type {Buffer[]} */
          const chunks = [];
          let size = 0;
          response.on('data', (/** @type {Buffer} */ chunk) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) request.destroy(new Error(`oversized response: ${path}`));
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error(`response interrupted: ${path}`)));
          response.on('end', () => {
            try {
              /** @type {unknown} */
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const body = /** @type {ResponseBody} */ (parsed);
              resolve({
                status: /** @type {number} */ (response.statusCode),
                body,
              });
            } catch {
              reject(new Error(`invalid JSON response: ${path}`));
            }
          });
        },
      );
      request.setTimeout(10_000, () => request.destroy(new Error(`request timeout: ${path}`)));
      request.on('error', () => reject(new Error(`gateway request failed: ${path}`)));
      request.end(bytes);
    });
}

/** @param {Api} api @param {string} path @param {RequestOptions} [options] */
async function json(api, path, options = {}) {
  const response = await api(path, options);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${options.method ?? 'GET'} ${path}: HTTP ${response.status}`,
  );
  return response.body;
}

/** @param {Api} api @param {string} token @param {string} sessionId */
export async function readHistory(api, token, sessionId) {
  /** @type {HistoryEvent[]} */
  const events = [];
  /** @type {number | undefined} */
  let beforeSeq;
  for (let page = 0; page < 20; page += 1) {
    const path = `/sessions/${sessionId}/events?limit=200${beforeSeq === undefined ? '' : `&beforeSeq=${beforeSeq}`}`;
    const history = await json(api, path, { token });
    assert.ok(Array.isArray(history.events), 'session history is absent');
    events.unshift(...history.events);
    if (history.hasMore === false) return events;
    const cursor = history.events[0]?.seq;
    assert.ok(
      typeof cursor === 'number' &&
        Number.isSafeInteger(cursor) &&
        (beforeSeq === undefined || cursor < beforeSeq),
      'history pagination did not advance',
    );
    beforeSeq = cursor;
  }
  throw new Error('acceptance transcript exceeded its bounded history window');
}

/** @param {HistoryEvent[]} events @param {string} prompt */
export function assertCompletedTurn(events, prompt) {
  const start = events.findLastIndex(
    ({ event }) => event.t === 'prompt' && event.text.includes(prompt),
  );
  assert.ok(start >= 0, 'submitted prompt was not persisted');
  const turn = events.slice(start + 1).map(({ event }) => event);
  assert.equal(
    turn.some((event) => event.t === 'error'),
    false,
    'agent turn reported an error',
  );
  const result = turn.find((event) => event.t === 'result');
  assert.ok(result, 'agent turn has not completed');
  assert.equal(result.stopReason, 'end_turn', 'agent turn did not finish normally');
  const text = turn
    .filter((event) => event.t === 'text')
    .map((event) => event.delta)
    .join('');
  assert.equal(text, `${responsePrefix}${prompt}`, 'agent response or Unicode was corrupted');
}

/** @param {Api} api @param {AcceptanceState} state @param {string} prompt @param {Pause} pause */
async function runTurn(api, state, prompt, pause) {
  await json(api, `/sessions/${state.sessionId}/turns`, {
    method: 'POST',
    token: state.token,
    body: { prompt },
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const events = await readHistory(api, state.token, state.sessionId);
    const start = events.findLastIndex(
      ({ event }) => event.t === 'prompt' && event.text.includes(prompt),
    );
    const turn = events.slice(start + 1).map(({ event }) => event);
    if (start >= 0 && turn.some((event) => event.t === 'result' || event.t === 'error')) {
      assertCompletedTurn(events, prompt);
      return;
    }
    await pause(1000);
  }
  throw new Error('first-use agent turn did not complete within 120 seconds');
}

/**
 * @param {string} phase
 * @param {{ api: Api, state?: AcceptanceState, pairingCode?: string, pause?: Pause }} options
 * @returns {Promise<AcceptanceState>}
 */
export async function runAcceptance(phase, { api, state, pairingCode, pause = delay }) {
  if (phase === 'initialize') {
    const onboarding = await json(api, '/onboarding/status');
    assert.equal(onboarding.sealed, true, 'fresh installation must be sealed');
    assert.equal(onboarding.masterPasswordSet, false, 'fresh installation already has a password');
    assert.equal(onboarding.hasProject, false, 'fresh installation already has a user project');
    assert.equal((await json(api, '/secret/status')).status, 'uninitialized');
    const pairing = await json(api, '/pair/redeem', {
      method: 'POST',
      body: { code: pairingCode },
    });
    assert.ok(
      typeof pairing.bootstrapToken === 'string' && pairing.bootstrapToken.length > 0,
      'pairing bootstrap missing',
    );
    const password = `Managed-install-${randomBytes(24).toString('hex')}!`;
    const auth = await json(api, '/secret/init', {
      method: 'POST',
      pairing: pairing.bootstrapToken,
      body: { password, deviceLabel: 'Managed install acceptance' },
    });
    assert.equal(auth.status, 'unlocked');
    assert.ok(typeof auth.token === 'string' && auth.token.length > 0, 'device token missing');
    // Initializing the secret store must activate device authorization.
    assert.equal(
      (await api('/settings')).status,
      401,
      'settings must require device authorization',
    );
    await json(api, '/settings', {
      method: 'PATCH',
      token: auth.token,
      body: {
        advancedModeEnabled: true,
        claudeCodeOauthCredentialsJson: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'managed-install-synthetic-token',
            expiresAt: 4102444800000,
          },
        }),
      },
    });
    return { password, token: auth.token, sessionId: randomUUID() };
  }
  assert.ok(state?.token && state?.password && state?.sessionId, 'acceptance state is missing');
  if (phase === 'exercise') {
    const created = await json(api, '/sessions', {
      method: 'POST',
      token: state.token,
      body: {
        sessionId: state.sessionId,
        project: 'verity/control',
        model: 'claude-opus-5',
        name: 'Managed install acceptance',
      },
    });
    assert.equal(created.sessionId, state.sessionId, 'first session was not created');
    const session = await json(api, `/sessions/${state.sessionId}`, { token: state.token });
    assert.equal(
      session.projectId,
      'verity-control',
      'session is not bound to the installed control project',
    );
    await runTurn(api, state, firstPrompt, pause);
    return state;
  }
  assert.equal(phase, 'verify-restart', 'unknown acceptance phase');
  assert.equal((await json(api, '/secret/status')).status, 'sealed', 'restart must seal the store');
  const auth = await json(api, '/secret/unlock', {
    method: 'POST',
    token: state.token,
    body: { password: state.password, deviceLabel: 'Managed install acceptance' },
  });
  assert.equal(auth.status, 'unlocked');
  assert.ok(
    typeof auth.token === 'string' && auth.token.length > 0,
    'unlock did not return a device token',
  );
  const resumed = { ...state, token: auth.token };
  const settings = await json(api, '/settings', { token: resumed.token });
  assert.equal(settings.settings?.advancedModeEnabled, true, 'settings were not persisted');
  const session = await json(api, `/sessions/${state.sessionId}`, { token: resumed.token });
  assert.equal(session.sessionId, state.sessionId, 'session identity changed after restart');
  assert.equal(session.projectId, 'verity-control');
  assertCompletedTurn(await readHistory(api, resumed.token, state.sessionId), firstPrompt);
  await runTurn(api, resumed, secondPrompt, pause);
  return resumed;
}

async function main() {
  const phase = process.argv[2];
  assert.ok(typeof phase === 'string', 'expected an acceptance phase');
  assert.ok(
    ['initialize', 'exercise', 'verify-restart'].includes(phase),
    'expected an acceptance phase',
  );
  const statePath = process.env.VERITY_SMOKE_STATE_PATH ?? '/state/state.json';
  const api = createApi({
    baseUrl: process.env.VERITY_SMOKE_BASE_URL ?? 'https://verity-managed-gateway:8082',
    ca: await readFile('/tls-ca-cert.pem'),
    servername: process.env.VERITY_SMOKE_TLS_SERVERNAME ?? 'localhost',
  });
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const health = await api('/healthz').catch(() => undefined);
    if (health?.status === 200 && health.body.status === 'ok') {
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(ready, 'installed TLS gateway did not become healthy');
  const state =
    phase === 'initialize'
      ? undefined
      : /** @type {AcceptanceState} */ (JSON.parse(await readFile(statePath, 'utf8')));
  const pairingCode =
    phase === 'initialize' ? (await readFile('/pairing-code', 'utf8')).trim() : undefined;
  const next = await runAcceptance(phase, { api, state, pairingCode });
  await writeFile(statePath, JSON.stringify(next), { mode: 0o600 });
  process.stdout.write(`Managed installation ${phase} passed\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((/** @type {unknown} */ error) => {
    // Assertion diagnostics can contain actual values. Only their authored
    // message is safe; never serialize the error object or stack here.
    const message =
      error instanceof Error ? error.message : 'Managed installation acceptance failed';
    process.stderr.write(`${message.split('\n')[0]}\n`);
    process.exitCode = 1;
  });
}
