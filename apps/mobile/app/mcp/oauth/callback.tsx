import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { SettingsMessage } from '../../../components/settings/SettingsChrome';
import { completeMcpOAuthPopup, receiveMcpOAuthCallback } from '../../../lib/mcpOAuth';

export default function McpOAuthCallback() {
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();
  const [handled, setHandled] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      setHandled(completeMcpOAuthPopup());
      return;
    }
    const query = new URLSearchParams();
    for (const key of ['code', 'state', 'error'] as const) {
      const value = params[key];
      if (typeof value === 'string') query.set(key, value);
    }
    if (receiveMcpOAuthCallback(`https://verity.build/mcp/oauth/callback?${query}`)) {
      setHandled(true);
      router.replace('/settings/services/mcp');
    }
  }, [params.code, params.state, params.error]);
  return (
    <SettingsMessage
      screenTitle="MCP sign-in"
      title={handled ? 'Finishing MCP sign-in…' : 'Start MCP sign-in again'}
      subtitle={
        handled
          ? 'You can return to your original Verity window.'
          : 'There is no matching sign-in in this window. Return to MCP connections and choose Connect OAuth.'
      }
    />
  );
}
