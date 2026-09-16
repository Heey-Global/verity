import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/fake-managed-install-acp.mjs', import.meta.url));

async function exercise(resume?: string) {
  const child = spawn(process.execPath, [fixture], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const read = async (): Promise<Record<string, unknown>> => {
    const line = await iterator.next();
    if (line.done) throw new Error('Fixture ended before its ACP response');
    return JSON.parse(line.value) as Record<string, unknown>;
  };
  const send = (id: number, method: string, params: unknown = {}) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  try {
    send(1, 'initialize', { protocolVersion: 1 });
    expect(await read()).toMatchObject({
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
    });
    send(2, resume === undefined ? 'session/new' : 'session/load', { sessionId: resume });
    const opened = await read();
    const result = opened['result'] as { sessionId?: string; modes: unknown };
    const sessionId = resume ?? result.sessionId;
    expect(sessionId).toEqual(expect.any(String));
    send(3, 'session/set_mode', { sessionId, modeId: 'auto' });
    expect(await read()).toMatchObject({ id: 3, result: {} });
    const prompt =
      resume === undefined ? 'managed-install-before-restart' : 'managed-install-after-restart';
    send(4, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `Project context: café 日本語\nUser prompt: ${prompt}\n` }],
    });
    expect(await read()).toMatchObject({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Verity managed install: Grüße — größer 🚀\n${prompt}` },
        },
      },
    });
    expect(await read()).toMatchObject({ id: 4, result: { stopReason: 'end_turn' } });
    send(5, 'session/prompt', { sessionId: 'wrong-session', prompt: [] });
    expect(await read()).toMatchObject({ id: 5, error: { code: -32602 } });
    for (const [index, invalid] of [
      'No acceptance prompt',
      'managed-install-before-restart and managed-install-after-restart',
    ].entries()) {
      send(6 + index, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: invalid }],
      });
      expect(await read()).toMatchObject({ id: 6 + index, error: { code: -32602 } });
    }
    return sessionId;
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

describe('managed installation deterministic provider', () => {
  // A restarted provider must answer the new prompt, not replay a fixed success
  // marker that could let a broken post-restart turn pass the acceptance gate.
  it('executes fresh and resumed ACP turns with distinct Unicode output and no credentials', async () => {
    const sessionId = await exercise();
    await exercise(sessionId);
  });
});
