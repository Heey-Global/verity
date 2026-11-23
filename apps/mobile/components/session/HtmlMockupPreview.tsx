import { Platform } from 'react-native';
import WebView from 'react-native-webview';

import { MockupPreviewStatus, useMockupPreviewDocument } from './mockupPreviewDocument';

export function HtmlMockupPreview({ attachment, name }: { attachment: string; name: string }) {
  const { html, onError } = useMockupPreviewDocument(attachment);
  if (typeof html !== 'string') return <MockupPreviewStatus loading={html === undefined} />;

  return (
    <WebView
      accessibilityLabel={`${name} mockup`}
      source={{ html, baseUrl: 'about:blank' }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
      onError={onError}
      onContentProcessDidTerminate={onError}
      onRenderProcessGone={onError}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      // Android's incognito mode clears the process-wide WebView cookie jar.
      incognito={Platform.OS === 'ios'}
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
