import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect } from 'react';
import { SettingsMessage } from '../../components/settings/SettingsChrome';

/** Preserve old links while all log categories share the same screen. */
export default function SystemLogsScreen() {
  const { operationId } = useLocalSearchParams<{ operationId?: string }>();
  useEffect(() => {
    router.replace(
      (operationId
        ? `/settings/audit-logs/${encodeURIComponent(operationId)}`
        : '/settings/audit-logs?category=system') as Href,
    );
  }, [operationId]);
  return <SettingsMessage title="Opening logs" />;
}
