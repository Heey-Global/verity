import { describe, expect, it, vi } from 'vitest';

import { createTrustedCliTool } from './trusted-cli-tool.js';

describe('trusted CLI tool', () => {
  it('consumes approval before resolving and zeroizes resolved bytes', async () => {
    const secret = Buffer.from('private-key-marker');
    const order: string[] = [];
    const tool = createTrustedCliTool({
      getProjectBinding: async () => ({
        dopplerProject: 'acme',
        dopplerConfig: 'prod',
      }),
      consumeApproval: async () => {
        order.push('consume');
        return true;
      },
      resolveSecret: async () => {
        order.push('resolve');
        return secret;
      },
    });
    const execute = vi.fn(
      async (input: { secrets: readonly { env: string; secret: string }[] }) => {
        order.push('execute');
        expect(input.secrets.map((entry) => [entry.env, entry.secret])).toEqual([
          ['ASC_PRIVATE_KEY', 'private-key-marker'],
        ]);
        return { exitCode: 0, stdout: 'uploaded', stderr: '' };
      },
    );

    await expect(
      tool(
        'project-1',
        'session-1',
        'turn-1',
        {
          id: 'call-1',
          name: 'verity_secret_run',
          input: {
            secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' }],
            command: ['/usr/local/bin/fastlane', 'deliver'],
          },
        },
        execute,
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: 'uploaded', stderr: '' });
    expect(order).toEqual(['consume', 'resolve', 'execute']);
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('resolves every alias before executing and zeroizes all of them', async () => {
    const resolved = new Map([
      // Stands in for the .p8 private key. Deliberately not PEM-shaped: a
      // secret-shaped literal in source is what the commit scanner exists to
      // stop, and nothing here depends on the bytes looking like a key.
      ['ASC_API_KEY_P8', Buffer.from('p8-key-marker')],
      ['ASC_API_KEY_ID', Buffer.from('ABCD1234')],
      ['ASC_API_ISSUER_ID', Buffer.from('69a6de70-issuer')],
    ]);
    const tool = createTrustedCliTool({
      getProjectBinding: async () => ({
        dopplerProject: 'acme',
        dopplerConfig: 'prod',
      }),
      consumeApproval: async () => true,
      resolveSecret: async ({ secretName }) => {
        const secret = resolved.get(secretName);
        if (secret === undefined) throw new Error(`unexpected alias ${secretName}`);
        return secret;
      },
    });
    const execute = vi.fn(
      async (input: {
        secrets: readonly { env: string; injection?: 'env' | 'file'; secret: string }[];
      }) => {
        expect(input.secrets.map((entry) => [entry.env, entry.injection, entry.secret])).toEqual([
          ['ASC_KEY_FILE', 'file', 'p8-key-marker'],
          ['ASC_KEY_ID', undefined, 'ABCD1234'],
          ['ASC_ISSUER_ID', undefined, '69a6de70-issuer'],
        ]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    await tool(
      'project-1',
      'session-1',
      'turn-1',
      {
        id: 'call-1',
        name: 'verity_secret_run',
        input: {
          secrets: [
            { secretAlias: 'ASC_API_KEY_P8', env: 'ASC_KEY_FILE', injection: 'file' },
            { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID' },
            { secretAlias: 'ASC_API_ISSUER_ID', env: 'ASC_ISSUER_ID' },
          ],
          command: ['/usr/local/bin/fastlane', 'deliver'],
        },
      },
      execute,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    for (const secret of resolved.values()) {
      expect(secret.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('never starts the command when a later alias fails to resolve', async () => {
    const first = Buffer.from('first-secret');
    const execute = vi.fn();
    const tool = createTrustedCliTool({
      getProjectBinding: async () => ({
        dopplerProject: 'acme',
        dopplerConfig: 'prod',
      }),
      consumeApproval: async () => true,
      resolveSecret: async ({ secretName }) => {
        if (secretName === 'FIRST') return first;
        // A binary secret cannot be injected into an environment.
        return Uint8Array.from([0xff, 0xfe]);
      },
    });

    await expect(
      tool(
        'project-1',
        'session-1',
        'turn-1',
        {
          id: 'call-1',
          name: 'verity_secret_run',
          input: {
            secrets: [
              { secretAlias: 'FIRST', env: 'FIRST' },
              { secretAlias: 'SECOND', env: 'SECOND' },
            ],
            command: ['/usr/bin/env'],
          },
        },
        execute,
      ),
    ).rejects.toThrow(/SECOND is not valid UTF-8/u);
    expect(execute).not.toHaveBeenCalled();
    expect(first.every((byte) => byte === 0)).toBe(true);
  });

  it('does not resolve or execute after a replayed approval fence', async () => {
    const resolveSecret = vi.fn();
    const execute = vi.fn();
    const tool = createTrustedCliTool({
      getProjectBinding: vi.fn(),
      consumeApproval: async () => false,
      resolveSecret,
    });
    await expect(
      tool(
        'project-1',
        'session-1',
        'turn-1',
        {
          id: 'call-1',
          name: 'verity_secret_run',
          input: {
            secrets: [{ secretAlias: 'API_KEY', env: 'API_KEY' }],
            command: ['/usr/bin/env'],
          },
        },
        execute,
      ),
    ).rejects.toThrow(/already consumed/u);
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
