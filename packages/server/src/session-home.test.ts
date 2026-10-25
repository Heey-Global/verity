import { expect, it } from 'vitest';
import { sessionHomePath } from './session-home.js';
import { sessionHomePath as brokerPath } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

it('uses the same stable volume-relative layout on server and broker', () => {
  for (const sessionId of ['first', 'second', '../opaque-id']) {
    const host = sessionHomePath('/host/runtime', sessionId);
    expect(host.replace('/host/runtime', '/run/verity-runner')).toBe(
      brokerPath('/run/verity-runner', sessionId),
    );
    expect(host).not.toContain(sessionId);
  }
  expect(sessionHomePath('/runtime', 'first')).not.toBe(sessionHomePath('/runtime', 'second'));
});

it.each(['', '\n', 'a\0b', 'x'.repeat(257)])('rejects an invalid session identity', (sessionId) => {
  expect(() => sessionHomePath('/runtime', sessionId)).toThrow('invalid session id');
  expect(() => brokerPath('/runtime', sessionId)).toThrow('invalid session id');
});
