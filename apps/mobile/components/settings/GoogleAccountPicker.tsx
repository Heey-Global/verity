import type { GoogleAccount } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from '../ui';
import { SettingsNavRow } from './SettingsChrome';

type Choice = { kind: 'account'; accountId: string } | { kind: 'add' | 'inherit' | 'disabled' };
type Options = {
  accounts: GoogleAccount[];
  title?: string;
  sessionOptions?: boolean;
  alwaysShow?: boolean;
};

export function useGoogleAccountPicker() {
  const [options, setOptions] = useState<Options | null>(null);
  const pending = useRef<((choice: Choice | null) => void) | null>(null);
  const finish = useCallback((choice: Choice | null) => {
    pending.current?.(choice);
    pending.current = null;
    setOptions(null);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(null);
    },
    [],
  );
  const choose = useCallback((next: Options): Promise<Choice | null> => {
    if (!next.sessionOptions && !next.alwaysShow && next.accounts.length === 1)
      return Promise.resolve({ kind: 'account', accountId: next.accounts[0]!.id });
    pending.current?.(null);
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
      {options?.sessionOptions ? (
        <>
          <SettingsNavRow
            title="Use project default"
            subtitle="Follow future project changes"
            icon="folder"
            onPress={() => finish({ kind: 'inherit' })}
          />
          <SettingsNavRow
            title="Disable for this chat"
            subtitle="Other chats keep their access"
            icon="x"
            onPress={() => finish({ kind: 'disabled' })}
          />
        </>
      ) : null}
      {options?.accounts.map((account) => (
        <SettingsNavRow
          key={account.id}
          title={account.displayName ?? account.email}
          subtitle={account.displayName ? account.email : undefined}
          icon="user"
          onPress={() => finish({ kind: 'account', accountId: account.id })}
        />
      ))}
      <SettingsNavRow
        title="Connect another account"
        icon="plus"
        onPress={() => finish({ kind: 'add' })}
      />
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
