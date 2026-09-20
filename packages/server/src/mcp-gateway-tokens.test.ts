import { describe, expect, it } from 'vitest';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';

const caller = { projectId: 'p1', sessionId: 's1', turnId: 't1' };

describe('createMcpGatewayTokens', () => {
  it('resolves a freshly minted token to the session and turn it was minted for', () => {
    const tokens = createMcpGatewayTokens();
    const token = tokens.issue(caller);
    expect(tokens.resolve({ projectId: 'p1', token })).toEqual({
      sessionId: 's1',
      turnId: 't1',
    });
  });

  it('mints a distinct token per turn', () => {
    const tokens = createMcpGatewayTokens();
    const first = tokens.issue(caller);
    const second = tokens.issue({ ...caller, turnId: 't2' });
    expect(first).not.toBe(second);
    expect(tokens.resolve({ projectId: 'p1', token: first })?.turnId).toBe('t1');
    expect(tokens.resolve({ projectId: 'p1', token: second })?.turnId).toBe('t2');
  });

  // The project comes from the connection the Server accepted, so a token that leaked
  // into another project's container is still inert there.
  it('refuses a token presented on another project connection', () => {
    const tokens = createMcpGatewayTokens();
    const token = tokens.issue(caller);
    expect(tokens.resolve({ projectId: 'p2', token })).toBeUndefined();
  });

  it('refuses an unknown or empty bearer', () => {
    const tokens = createMcpGatewayTokens();
    tokens.issue(caller);
    expect(tokens.resolve({ projectId: 'p1', token: '' })).toBeUndefined();
    expect(tokens.resolve({ projectId: 'p1', token: 'not-a-token' })).toBeUndefined();
    expect(tokens.resolve({ projectId: 'p1', token: 'x'.repeat(4096) })).toBeUndefined();
  });

  it('stops resolving a released token', () => {
    const tokens = createMcpGatewayTokens();
    const token = tokens.issue(caller);
    tokens.release({ projectId: 'p1', token });
    expect(tokens.resolve({ projectId: 'p1', token })).toBeUndefined();
  });

  it('releases idempotently, including for a token it never minted', () => {
    const tokens = createMcpGatewayTokens();
    const token = tokens.issue(caller);
    tokens.release({ projectId: 'p1', token });
    expect(() => {
      tokens.release({ projectId: 'p1', token });
      tokens.release({ projectId: 'p1', token: 'never-minted' });
      tokens.release({ projectId: 'p1', token: '' });
    }).not.toThrow();
  });

  // Ownership is per mint, not per turn. Two start attempts for one turn each hold their
  // own bearer, and whichever settles first must not cut off the other's live worker.
  it('keeps a second mint for the same turn independent of the first', () => {
    const tokens = createMcpGatewayTokens();
    const first = tokens.issue(caller);
    const second = tokens.issue(caller);
    expect(first).not.toBe(second);
    tokens.release({ projectId: 'p1', token: first });
    expect(tokens.resolve({ projectId: 'p1', token: first })).toBeUndefined();
    expect(tokens.resolve({ projectId: 'p1', token: second })?.turnId).toBe('t1');
  });

  it('refuses to release a token on another project connection', () => {
    const tokens = createMcpGatewayTokens();
    const token = tokens.issue(caller);
    tokens.release({ projectId: 'p2', token });
    expect(tokens.resolve({ projectId: 'p1', token })?.turnId).toBe('t1');
  });

  it('expires a token once its TTL has passed', () => {
    let clock = 1_000;
    const tokens = createMcpGatewayTokens({ now: () => clock, ttlMs: 60_000 });
    const token = tokens.issue(caller);
    clock += 59_999;
    expect(tokens.resolve({ projectId: 'p1', token })).not.toBeUndefined();
    clock += 1;
    expect(tokens.resolve({ projectId: 'p1', token })).toBeUndefined();
  });

  // Capacity is a backstop against a Server that never sees a release; expired entries
  // must be reclaimed by minting rather than counted against the ceiling forever.
  it('reclaims expired entries before enforcing capacity', () => {
    let clock = 0;
    const tokens = createMcpGatewayTokens({ now: () => clock, ttlMs: 1_000, capacity: 2 });
    tokens.issue({ ...caller, turnId: 't1' });
    tokens.issue({ ...caller, turnId: 't2' });
    expect(() => tokens.issue({ ...caller, turnId: 't3' })).toThrow(/capacity/);
    clock += 1_001;
    expect(() => tokens.issue({ ...caller, turnId: 't3' })).not.toThrow();
  });

  it('rejects an invalid TTL or capacity', () => {
    expect(() => createMcpGatewayTokens({ ttlMs: 0 })).toThrow(/TTL/);
    expect(() => createMcpGatewayTokens({ capacity: -1 })).toThrow(/capacity/);
  });
});
