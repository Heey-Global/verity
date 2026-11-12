import type { EventStore, GoogleAccount } from '@verity/store';
import { createCachedGoogleAccessToken, type GoogleFetch } from './google-drive.js';

/** Resolve identity on every use, including cache hits and requests after removal. */
export function createGoogleAccountAccessToken(
  store: Pick<EventStore, 'googleAccounts'>,
  options: {
    fetch?: GoogleFetch;
    isSealed?: () => boolean;
    acceptAccount?: (account: GoogleAccount) => boolean;
  } = {},
) {
  const providers = new Map<
    string,
    { version: number; provider: ReturnType<typeof createCachedGoogleAccessToken> }
  >();
  const token = async (accountId?: string): Promise<string | undefined> => {
    if (options.isSealed?.()) return undefined;
    // Always a named account. Choosing "the only one" when none was named would,
    // with several people on the server, hand one person's account to another.
    if (accountId === undefined) return undefined;
    const account = await store.googleAccounts.get(accountId);
    if (!account || options.acceptAccount?.(account) === false) return undefined;
    let cached = providers.get(account.id);
    if (!cached || cached.version !== account.credentialVersion) {
      cached = {
        version: account.credentialVersion,
        provider: createCachedGoogleAccessToken(async () => {
          if (options.isSealed?.()) return undefined;
          return store.googleAccounts.credentials(account.id);
        }, options),
      };
      providers.set(account.id, cached);
    }
    return cached.provider();
  };
  return Object.assign(token, {
    invalidate() {
      for (const cached of providers.values()) cached.provider.invalidate();
      providers.clear();
    },
  });
}
