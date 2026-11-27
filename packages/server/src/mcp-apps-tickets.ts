import { randomBytes } from 'node:crypto';

const TTL_MS = 30_000;
const MAX_TICKETS = 128;

export interface McpAppDocumentAccess {
  sessionId: string;
  appId: string;
  userId: string | undefined;
  authorized(): Promise<boolean>;
}

/** A document ticket conveys no authority to call tools or any other API. */
export function createMcpAppDocumentTickets(now: () => number = () => Date.now()) {
  const tickets = new Map<string, { access: McpAppDocumentAccess; expiresAt: number }>();
  return {
    mint(access: McpAppDocumentAccess) {
      const time = now();
      for (const [ticket, entry] of tickets) {
        if (entry.expiresAt <= time) tickets.delete(ticket);
      }
      while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { access, expiresAt: time + TTL_MS });
      return ticket;
    },
    consume(ticket: string): McpAppDocumentAccess | undefined {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      return entry && entry.expiresAt > now() ? entry.access : undefined;
    },
    clear() {
      tickets.clear();
    },
  };
}
