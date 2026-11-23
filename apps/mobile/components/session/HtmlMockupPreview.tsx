import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import WebView from 'react-native-webview';

import { createVerityClient } from '../../lib/client';
import { Text } from '../ui';

type PreviewDocument = { attachment: string; html: string | null };

export function HtmlMockupPreview({ attachment, name }: { attachment: string; name: string }) {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>();
  const [document, setDocument] = useState<PreviewDocument | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    const client = createVerityClient();
    void (
      client?.getMockupPreviewDocument(sessionId, attachment, controller.signal) ??
      Promise.resolve(null)
    ).then(
      (html) => {
        if (!controller.signal.aborted) setDocument({ attachment, html });
      },
      () => {
        if (!controller.signal.aborted) setDocument({ attachment, html: null });
      },
    );
    return () => controller.abort();
  }, [attachment, sessionId]);

  const html = document?.attachment === attachment ? document.html : undefined;
  if (typeof html !== 'string') {
    return (
      <View style={styles.message}>
        <Text tone="muted">
          {html === undefined ? 'Loading mockup…' : 'The mockup could not be loaded.'}
        </Text>
      </View>
    );
  }

  return (
    <WebView
      accessibilityLabel={`${name} mockup`}
      source={{ html, baseUrl: 'about:blank' }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
      onError={() => setDocument({ attachment, html: null })}
      onContentProcessDidTerminate={() => setDocument({ attachment, html: null })}
      onRenderProcessGone={() => setDocument({ attachment, html: null })}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      incognito
      cacheEnabled={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      mediaPlaybackRequiresUserAction
      allowsAirPlayForMediaPlayback={false}
      allowsLinkPreview={false}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  message: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: theme.spacing.md },
}));
