import { describe, expect, it } from 'vitest';
import { resolveTurnSandbox } from './turn-sandbox.js';

const store = (owner: string) =>
  ({
    projectSandboxes: {
      projectDefault: async (projectId: string) => ({
        projectId,
        userId: owner,
        projectDefault: true,
      }),
      ensureProjectDefault: async () => {
        throw new Error('not expected');
      },
    },
  }) as never;

describe('resolveTurnSandbox', () => {
  // A turn must land in its own person's sandbox; landing in the original one
  // would run it with the owner's credentials.
  it("puts a person's turn in their own sandbox and the owner's in the original", async () => {
    await expect(resolveTurnSandbox(store('admin'), 'p1', { userId: 'lena' })).resolves.toEqual({
      userId: 'lena',
      projectDefault: false,
    });
    await expect(resolveTurnSandbox(store('admin'), 'p1', { userId: 'admin' })).resolves.toEqual({
      userId: 'admin',
      projectDefault: true,
    });
    await expect(resolveTurnSandbox(store('admin'), 'p1', undefined)).resolves.toEqual({
      userId: 'admin',
      projectDefault: true,
    });
  });
});
