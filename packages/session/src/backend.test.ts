import { describe, expect, it } from 'vitest';
import { brokeredGrantChannel, type Backend, type RunnerSupervisorBackend } from './backend.js';
import type { RunResult } from './backend-contract.js';

/** A backend that only exists to be classified — `run` is never called. */
function backendWith(protocol?: RunnerSupervisorBackend): Backend {
  return {
    ...(protocol !== undefined ? { runnerSupervisorBackend: protocol } : {}),
    run: (): Promise<RunResult> => Promise.reject(new Error('not runnable')),
  };
}

describe('brokeredGrantChannel (ADR 0014 D3)', () => {
  it('puts both ACP adapters on the restricted channel', () => {
    expect(brokeredGrantChannel(backendWith('claude-acp'))).toBe('acp');
    expect(brokeredGrantChannel(backendWith('codex-acp'))).toBe('acp');
  });

  it('fails closed for a backend that declares no supervisor protocol', () => {
    // `runnerSupervisorBackend` is optional, so "no attested transport" and "a
    // wrapper dropped the field" arrive as the same value. Absence is not evidence
    // of attestation, so it must not buy the native channel's unbounded grants.
    expect(brokeredGrantChannel(backendWith())).toBe('acp');
  });

  it('fails closed for a protocol value that bypassed the type system', () => {
    // A value that crossed a process boundary or a cast lands in the default arm —
    // including the retired `'claude'` a stale persisted record could still carry.
    const smuggled = { runnerSupervisorBackend: 'claude' };
    expect(brokeredGrantChannel(smuggled as unknown as Backend)).toBe('acp');
  });
});
