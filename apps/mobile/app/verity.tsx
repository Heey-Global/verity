import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

import { SettingsMessage } from '../components/settings/SettingsChrome';
import { VerityPage } from '../components/verity/VerityPage';
import { createVerityClient } from '../lib/client';
import { sessionLayout } from '../lib/sessionLayout';

/**
 * Verity's page, opened from her header on Home in the new design. On a wide
 * screen the page lives in the split layout's left column, so a link here hands
 * over to it, as a project link does.
 */
export default function VerityScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const { wide } = sessionLayout(useWindowDimensions().width);
  if (wide) return <SplitVerityRedirect />;
  if (!client)
    return (
      <SettingsMessage
        screenTitle="Verity"
        title="Not connected"
        subtitle="Configure your Verity server address in setup to open Verity's page."
      />
    );
  return (
    <>
      <Stack.Screen options={{ title: 'Verity' }} />
      <VerityPage client={client} />
    </>
  );
}

function SplitVerityRedirect() {
  useFocusEffect(
    useCallback(() => {
      router.dismissTo({ pathname: '/', params: { verity: '1' } });
    }, []),
  );
  return null;
}
