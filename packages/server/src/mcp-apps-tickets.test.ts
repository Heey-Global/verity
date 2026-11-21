import { expect, it } from 'vitest';
import { createMcpAppDocumentTickets } from './mcp-apps-tickets.js';

it('bounds tickets, consumes them once, expires them and clears on shutdown', () => {
  let now = 100;
  const tickets = createMcpAppDocumentTickets(() => now);
  const access = { sessionId: 's', appId: 'a', userId: 'viewer', authorized: async () => true };
  const first = tickets.mint(access);
  let last = '';
  for (let i = 0; i < 128; i++) last = tickets.mint(access);
  expect(tickets.consume(first)).toBeUndefined();
  expect(tickets.consume(last)).toBe(access);
  expect(tickets.consume(last)).toBeUndefined();
  const expired = tickets.mint(access);
  now += 30_000;
  expect(tickets.consume(expired)).toBeUndefined();
  const fresh = tickets.mint(access);
  tickets.clear();
  expect(tickets.consume(fresh)).toBeUndefined();
});
