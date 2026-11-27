import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { Text } from '../ui';

type PreviewDocument = { attachment: string; sessionId: string; html: string | null };

export function useMockupPreviewDocument(sessionId: string, attachment: string) {
  const [document, setDocument] = useState<PreviewDocument | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    const client = createVerityClient();
    void (
      client?.getMockupPreviewDocument(sessionId, attachment, controller.signal) ??
      Promise.resolve(null)
    ).then(
      (html) => {
        if (!controller.signal.aborted) setDocument({ sessionId, attachment, html });
      },
      () => {
        if (!controller.signal.aborted) setDocument({ sessionId, attachment, html: null });
      },
    );
    return () => controller.abort();
  }, [attachment, sessionId]);

  return {
    html:
      document?.sessionId === sessionId && document.attachment === attachment
        ? document.html
        : undefined,
    onError: () => setDocument({ sessionId, attachment, html: null }),
  };
}

export function MockupPreviewStatus({ loading }: { loading: boolean }) {
  return (
    <View style={styles.message}>
      <Text tone="muted">{loading ? 'Loading mockup…' : 'The mockup could not be loaded.'}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: theme.spacing.md },
}));
