import { describe, expect, it } from 'vitest';

import { httpMcpConnectionUsableBy } from './store.js';

describe('HTTP MCP connection usage per person', () => {
  const alice = { ownerUserId: 'alice' } as const;

  it('keeps a credentialed connection to its owner', () => {
    for (const connection of [
      { ...alice, authType: 'static' as const, authorization: 'Bearer alice' },
      { ...alice, authType: 'oauth' as const, authorization: null },
      // A legacy row without auth type but with a token is still personal.
      { ...alice, authorization: 'Bearer alice' },
    ]) {
      expect(httpMcpConnectionUsableBy(connection, 'alice')).toBe(true);
      expect(httpMcpConnectionUsableBy(connection, 'bob')).toBe(false);
      // No initiator never falls back to the owner (ADR 0023 §3).
      expect(httpMcpConnectionUsableBy(connection, undefined)).toBe(false);
    }
  });

  it('treats a credential-free server as project configuration', () => {
    const open = { ...alice, authType: 'none' as const, authorization: null };
    expect(httpMcpConnectionUsableBy(open, 'bob')).toBe(true);
    expect(httpMcpConnectionUsableBy(open, undefined)).toBe(true);
  });
});
