import { useUnistyles } from 'react-native-unistyles';

import { MockupPreviewStatus, useMockupPreviewDocument } from './mockupPreviewDocument';

export function HtmlMockupPreview({ attachment, name }: { attachment: string; name: string }) {
  const { html } = useMockupPreviewDocument(attachment);
  const { theme } = useUnistyles();
  if (typeof html !== 'string') return <MockupPreviewStatus loading={html === undefined} />;

  return (
    <iframe
      title={`${name} mockup`}
      srcDoc={html}
      sandbox=""
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: '100%', border: 0, backgroundColor: theme.colors.surface }}
    />
  );
}
