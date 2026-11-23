import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

export function HtmlMockupPreview({ attachment, name }: { attachment: string; name: string }) {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>();
  const { theme } = useUnistyles();
  return (
    <iframe
      title={`${name} mockup`}
      src={`/sessions/${encodeURIComponent(sessionId)}/mockup-attachments/${encodeURIComponent(attachment)}`}
      sandbox=""
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: '100%', border: 0, backgroundColor: theme.colors.surface }}
    />
  );
}
