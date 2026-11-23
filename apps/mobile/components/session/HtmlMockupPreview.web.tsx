import { useUnistyles } from 'react-native-unistyles';

export function HtmlMockupPreview({ attachment, name }: { attachment: string; name: string }) {
  const { theme } = useUnistyles();
  return (
    <iframe
      title={`${name} mockup`}
      src={`/attachments/${encodeURIComponent(attachment)}?mockup=1`}
      sandbox=""
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: '100%', border: 0, backgroundColor: theme.colors.surface }}
    />
  );
}
