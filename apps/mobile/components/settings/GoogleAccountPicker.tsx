import type { GoogleAccount } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from '../ui';
import { SettingsChoiceRow, SettingsListPanel } from './SettingsChrome';

type Options = {
  accounts: GoogleAccount[];
  title?: string;
  /** The account currently in use; drawn with a check mark. */
  selectedId?: string | null;
};

/**
 * Asks only which account to use. Disabling lives on the connection chip and
 * adding accounts in Settings → Google, so neither competes with the choice.
 * Resolves to the chosen account id, or null when dismissed.
 */
export function useGoogleAccountPicker() {
  const [options, setOptions] = useState<Options | null>(null);
  const pending = useRef<((accountId: string | null) => void) | null>(null);
  const finish = useCallback((accountId: string | null) => {
    pending.current?.(accountId);
    pending.current = null;
    setOptions(null);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(null);
    },
    [],
  );
  const choose = useCallback((next: Options): Promise<string | null> => {
    pending.current?.(null);
    pending.current = null;
    if (next.accounts.length <= 1) {
      setOptions(null);
      return Promise.resolve(next.accounts[0]?.id ?? null);
    }
    setOptions(next);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }, []);
  const sheet = (
    <Sheet
      visible={options !== null}
      title={options?.title ?? 'Choose Google account'}
      onClose={() => finish(null)}
    >
      {options ? (
        // A framed list with a leading glyph per row, so the accounts read as
        // tappable choices rather than plain text under the title.
        <SettingsListPanel>
          {options.accounts.map((account) => (
            <SettingsChoiceRow
              key={account.id}
              icon="user"
              title={account.displayName ?? account.email}
              subtitle={account.displayName ? account.email : undefined}
              selected={account.id === options.selectedId}
              onPress={() => finish(account.id)}
            />
          ))}
        </SettingsListPanel>
      ) : null}
    </Sheet>
  );
  return [choose, sheet] as const;
}

export function googleAccountSupports(
  account: Pick<GoogleAccount, 'scopes'>,
  service: 'gmail' | 'calendar' | 'contacts' | 'drive',
) {
  const required = {
    gmail: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'],
    calendar: ['calendar.calendarlist.readonly', 'calendar.events'],
    contacts: ['contacts.readonly'],
    drive: ['drive'],
  }[service];
  return required.every((scope) =>
    account.scopes.includes(`https://www.googleapis.com/auth/${scope}`),
  );
}
