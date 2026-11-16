import type { ProviderConnectionKind, VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { AiAccountsView } from '../../app/settings/ai-accounts';
import { ConnectProviderView } from '../../app/settings/ai-accounts/connect';
import { SettingsMessage } from './SettingsChrome';

/** Old links must never take a member into the administrator's account controls. */
export function PersonalAiProviderBoundary({
  client,
  provider,
  agentLogin,
  personal,
  children,
}: {
  client: VerityClient;
  provider: ProviderConnectionKind;
  agentLogin?: string | string[] | undefined;
  personal?: ReactNode;
  children: ReactNode;
}) {
  const [administrator, setAdministrator] = useState<boolean>();
  const [error, setError] = useState<string>();
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setError(undefined);
      client.listProviderConnections().then(
        (accounts) => {
          if (active) setAdministrator(accounts.usesInstanceLogins);
        },
        () => {
          if (active) setError('Could not load your AI accounts.');
        },
      );
      return () => {
        active = false;
      };
    }, [client]),
  );
  if (error) return <SettingsMessage title="Could not load accounts" subtitle={error} />;
  if (administrator === undefined) return <SettingsMessage title="Loading accounts" />;
  if (administrator) return children;
  if (provider !== 'opencode' && agentLogin === provider)
    return <ConnectProviderView client={client} provider={provider} />;
  return personal ?? <AiAccountsView client={client} />;
}
