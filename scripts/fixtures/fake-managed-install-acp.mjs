#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Installed only in the acceptance test's disposable runner. Everything around
// this external provider boundary still uses the shipped session and broker path.
const input = createInterface({ input: process.stdin });
/** @param {unknown} message */
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
/** @type {string | undefined} */
let sessionId;
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object';
const modes = {
  currentModeId: 'default',
  availableModes: ['default', 'auto', 'acceptEdits', 'plan', 'dontAsk'].map((id) => ({
    id,
    name: id,
  })),
};

for await (const line of input) {
  if (!line.trim()) continue;
  const message = /** @type {unknown} */ (JSON.parse(line));
  if (!isRecord(message)) continue;
  const { id, method } = message;
  const params = isRecord(message.params) ? message.params : {};
  if (id === undefined) continue;
  /** @param {unknown} result */
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  /** @param {number} code @param {string} message */
  const refuse = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
      authMethods: [],
      agentInfo: { name: 'managed-install-fixture', version: '1.0.0' },
    });
  } else if (method === 'session/new') {
    sessionId = randomUUID();
    reply({ sessionId, modes });
  } else if (method === 'session/load' && typeof params.sessionId === 'string') {
    sessionId = params.sessionId;
    reply({ modes });
  } else if (params.sessionId !== sessionId || sessionId === undefined) {
    refuse(-32602, 'Unknown session');
  } else if (method === 'session/set_mode' || method === 'session/set_model') {
    reply({});
  } else if (method === 'session/prompt' && Array.isArray(params.prompt)) {
    const prompt = /** @type {unknown[]} */ (params.prompt)
      .filter(isRecord)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    const sentinels = [
      'managed-install-before-restart',
      'managed-install-after-restart',
      'managed-install-after-repair',
    ].filter((sentinel) => prompt.includes(sentinel));
    if (sentinels.length !== 1) {
      refuse(-32602, 'Expected exactly one managed installation prompt sentinel');
      continue;
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Verity managed install: Grüße — größer 🚀\n${sentinels[0]}`,
          },
        },
      },
    });
    reply({ stopReason: 'end_turn' });
  } else {
    refuse(-32601, 'Unsupported fixture method');
  }
}
