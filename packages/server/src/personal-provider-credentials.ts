import { createHash } from 'node:crypto';

import type { EventStore, ProviderConnectionKind } from '@verity/store';

import type { AgentGatewayPerson, CodexCredentialUpdate } from './agent-gateway-control.js';
import {
  ClaudeOAuthResolutionError,
  createClaudeOAuthTokenProvider,
  type ClaudeOAuthTokenProvider,
} from './claudeUsage.js';

type Store = Pick<EventStore, 'userProviderConnections' | 'isActiveLocalUser'>;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Each person's own provider logins on the Server side (ADR 0023 §3).
 *
 * Every write to one person's logins — their own sign-in, sign-out, a refreshed
 * Claude login or a rotated Codex login coming back from the gateway — runs in
 * that person's queue, so two of them never interleave. A refresh or rotation is
 * written back only while the stored login is still the one it started from: a
 * sign-out or a new sign-in in the meantime wins, and the old account never
 * comes back.
 */
export function createPersonalProviderCredentials(options: {
  store: Store;
  /** Builds one person's Claude refresher; replaced in tests. */
  createClaudeTokenProvider?: typeof createClaudeOAuthTokenProvider;
  onError?: (error: unknown) => void;
}) {
  const createProvider = options.createClaudeTokenProvider ?? createClaudeOAuthTokenProvider;
  const tails = new Map<string, Promise<void>>();
  const claude = new Map<string, ClaudeOAuthTokenProvider>();
  const listeners = new Set<() => void>();

  const exclusive = <T>(userId: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(userId) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(userId, tail);
    void tail.then(() => {
      if (tails.get(userId) === tail) tails.delete(userId);
    });
    return run;
  };
  const changed = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const claudeProvider = (userId: string): ClaudeOAuthTokenProvider => {
    const existing = claude.get(userId);
    if (existing !== undefined) return existing;
    // The login this refresher last read. Its refresh is written back only while
    // it is still the stored one.
    let source: string | undefined;
    const provider = createProvider({
      // Never a file on this host: the person's login lives only in the store.
      credentialsPath: '/dev/null',
      expirySkewMs: 10 * 60_000,
      credentialsJsonProvider: async () => {
        source = (await options.store.userProviderConnections.get(userId, 'claude'))?.credential;
        return source !== undefined && source.trim().length > 0 ? source : undefined;
      },
      credentialsJsonUpdater: async (credentialsJson) => {
        const current = (await options.store.userProviderConnections.get(userId, 'claude'))
          ?.credential;
        if (current === undefined || current !== source) return;
        await options.store.userProviderConnections.set(userId, 'claude', {
          credential: credentialsJson,
        });
        source = credentialsJson;
        changed();
      },
    });
    claude.set(userId, provider);
    return provider;
  };

  const claudeAccessToken = (userId: string): Promise<string | undefined> =>
    exclusive(userId, () => claudeProvider(userId)());

  return {
    /** A fresh Claude access token for this person's own login, if they have one. */
    claudeAccessToken,

    /** Run a sign-in or sign-out of this person's login in their queue. */
    persist(
      userId: string,
      provider: ProviderConnectionKind,
      write: () => Promise<void>,
    ): Promise<void> {
      return exclusive(userId, async () => {
        await write();
        if (provider === 'claude') {
          // The old refresher holds the old account's pending rotation; it must
          // never be retried over the new login.
          claude.get(userId)?.discardPendingCredentials?.();
          claude.delete(userId);
        }
      }).finally(changed);
    },

    /** Store a Codex rotation the gateway made for this person, if it still applies. */
    persistCodexUpdate(update: CodexCredentialUpdate & { userId: string }): Promise<boolean> {
      return exclusive(update.userId, async () => {
        const current = await options.store.userProviderConnections.get(update.userId, 'codex');
        if (current === undefined || digest(current.credential) !== update.sourceRevision)
          return false;
        if (digest(update.authJson) !== update.updatedRevision)
          throw new Error('Codex gateway credential update revision mismatch');
        await options.store.userProviderConnections.set(update.userId, 'codex', {
          credential: update.authJson,
        });
        changed();
        return true;
      });
    },

    /**
     * Every active person's own logins, as the gateway's personal section. A
     * person whose Claude login cannot be refreshed keeps their other logins; a
     * transient failure keeps the token projected last time.
     */
    async people(previous: ReadonlyMap<string, string> = new Map()): Promise<{
      people: AgentGatewayPerson[];
      claudeTokens: Map<string, string>;
    }> {
      const byUser = new Map<string, AgentGatewayPerson>();
      const person = (userId: string): AgentGatewayPerson => {
        const entry = byUser.get(userId) ?? { userId };
        byUser.set(userId, entry);
        return entry;
      };
      const claudeTokens = new Map<string, string>();
      for (const connection of await options.store.userProviderConnections.listByProvider(
        'claude',
      )) {
        let token: string | undefined;
        try {
          token = await claudeAccessToken(connection.userId);
        } catch (error) {
          if (!(error instanceof ClaudeOAuthResolutionError && error.state === 'relogin_required'))
            token = previous.get(connection.userId);
          options.onError?.(error);
        }
        if (token !== undefined) {
          claudeTokens.set(connection.userId, token);
          person(connection.userId).claude = { accessToken: token };
        }
      }
      for (const connection of await options.store.userProviderConnections.listByProvider(
        'codex',
      )) {
        if (connection.credential.trim().length === 0) continue;
        person(connection.userId).codex = {
          sourceRevision: digest(connection.credential),
          authJson: connection.credential,
        };
      }
      for (const connection of await options.store.userProviderConnections.listByProvider(
        'opencode',
      )) {
        const baseUrl = connection.baseUrl?.trim();
        const apiKey = connection.credential.trim();
        if (!baseUrl || apiKey.length === 0) continue;
        person(connection.userId).opencode = { baseUrl, apiKey };
      }
      const people: AgentGatewayPerson[] = [];
      for (const entry of byUser.values()) {
        // A removed or disabled person's logins serve nothing.
        if (await options.store.isActiveLocalUser(entry.userId)) people.push(entry);
      }
      return { people, claudeTokens };
    },

    onChanged(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type PersonalProviderCredentials = ReturnType<typeof createPersonalProviderCredentials>;
