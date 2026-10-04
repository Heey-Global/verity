import { describe, expect, it } from 'vitest';
import { brokeredGrantTarget } from './brokered-grants.js';

describe('CLI invocation grants', () => {
  const input = {
    command: ['/usr/local/bin/kubectl', 'get', 'pods'],
    secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
  };
  it('binds reusable consent to command, secrets and execution context', () => {
    const target = brokeredGrantTarget('verity_secret_run', input);
    expect(target?.target).toMatch(/^v2:\/usr\/local\/bin\/kubectl#[a-f0-9]{64}$/u);
    for (const change of [
      { command: [...input.command, '--all-namespaces'] },
      { secrets: [{ secretAlias: 'OTHER', env: 'TOKEN' }] },
      { secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN_FILE', injection: 'file' }] },
      { cwd: '/work/other' },
    ]) {
      expect(brokeredGrantTarget('verity_secret_run', { ...input, ...change })?.target).not.toBe(
        target?.target,
      );
    }
  });
  it('supports inline code and dynamic entry scripts', () => {
    expect(
      brokeredGrantTarget('verity_secret_run', {
        ...input,
        command: ['/bin/sh', '-c', 'deploy'],
      }),
    ).toBeDefined();
    expect(
      brokeredGrantTarget('verity_secret_run', {
        ...input,
        entryScript: { loading: 'dynamic' },
      }),
    ).toBeDefined();
  });
  it('rejects malformed invocation scopes', () => {
    expect(brokeredGrantTarget('verity_secret_run', { ...input, command: [] })).toBeUndefined();
    expect(brokeredGrantTarget('verity_secret_run', { ...input, secrets: [] })).toBeUndefined();
  });
});
