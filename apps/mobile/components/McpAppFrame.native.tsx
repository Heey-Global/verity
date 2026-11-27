import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import { getLocales } from 'expo-localization';
import WebView from 'react-native-webview';
import {
  AppBridge,
  McpUiToolResultNotificationSchema,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { VerityClient } from '@verity/mobile';
import { NativeMcpTransport } from '../lib/mcpNativeTransport';
import { nativeMcpHost, nativeMcpNavigation } from '../lib/mcpNativeHost';
import type { McpAppCardEvent } from './McpAppCard.shared';
import { Text } from './ui/Text';

const toolResult = (result: Record<string, unknown>) =>
  McpUiToolResultNotificationSchema.parse({
    method: 'ui/notifications/tool-result',
    params: result,
  }).params;

export function McpAppFrame({
  event,
  client,
  failed,
}: {
  event: McpAppCardEvent;
  client: VerityClient;
  failed: () => void;
}) {
  const webview = useRef<WebView>(null);
  const transport = useRef<NativeMcpTransport | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const revoke = useRef<() => void>(() => undefined);
  const latest = useRef(event);
  latest.current = event;
  const [html, setHtml] = useState<string>();
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(320);
  const { theme, rt } = useUnistyles();
  const context = useRef<McpUiHostContext>({
    platform: 'mobile',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    locale: getLocales()[0]?.languageTag ?? 'en',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const dark = rt.themeName === 'dark';

  useEffect(() => {
    const controller = new AbortController();
    const channel = randomUUID();
    let disposed = false;
    const fail = () => {
      if (disposed) return;
      controller.abort();
      disposed = true;
      clearTimeout(timer);
      void bridge.close();
      failed();
    };
    const bridge = new AppBridge(
      null,
      { name: 'Verity', version: '1.0.0' },
      { serverTools: {} },
      { hostContext: context.current },
    );
    const wire = new NativeMcpTransport(
      channel,
      (script) => webview.current?.injectJavaScript(script),
      fail,
    );
    const timer = setTimeout(fail, 15_000);
    revoke.current = fail;
    bridge.onerror = fail;
    transport.current = wire;
    bridgeRef.current = bridge;
    bridge.oninitialized = () => {
      if (disposed) return;
      clearTimeout(timer);
      setReady(true);
      void bridge
        .sendToolInput({ arguments: latest.current.input })
        .then(() => bridge.sendToolResult(toolResult(latest.current.result)))
        .catch(fail);
    };
    bridge.onsizechange = ({ height: requested }) => {
      if (!disposed && typeof requested === 'number' && Number.isFinite(requested))
        setHeight(Math.max(120, Math.min(800, requested)));
    };
    bridge.oncalltool = async (params) => {
      if (disposed) throw new Error('MCP app closed');
      const result = await client.callMcpAppTool(
        latest.current.sessionId,
        latest.current.appId,
        { name: params.name, arguments: params.arguments },
        controller.signal,
      );
      if (disposed) throw new Error('MCP app closed');
      return toolResult(result);
    };
    void bridge
      .connect(wire)
      .then(() => client.getMcpAppDocument(event.sessionId, event.appId, controller.signal))
      .then((document) => {
        if (!disposed) setHtml(nativeMcpHost(document, channel));
      })
      .catch(fail);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      transport.current = null;
      bridgeRef.current = null;
      revoke.current = () => undefined;
      void bridge.close();
    };
  }, [client, event.sessionId, event.appId, failed]);

  useEffect(() => {
    context.current = { ...context.current, theme: dark ? 'dark' : 'light' };
    bridgeRef.current?.setHostContext(context.current);
  }, [dark]);
  useEffect(() => {
    if (ready)
      void Promise.resolve()
        .then(() => bridgeRef.current?.sendToolResult(toolResult(event.result)))
        .catch(() => revoke.current());
  }, [event.result, ready]);

  return (
    <View
      onLayout={({ nativeEvent }) => {
        context.current = {
          ...context.current,
          containerDimensions: { width: nativeEvent.layout.width, maxHeight: 800 },
        };
        bridgeRef.current?.setHostContext(context.current);
      }}
    >
      {!ready ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.action} />
          <Text tone="muted">Loading interactive app…</Text>
        </View>
      ) : null}
      {html ? (
        <WebView
          ref={webview}
          testID="mcp-app-webview"
          source={{ html, baseUrl: 'about:blank' }}
          style={[
            styles.frame,
            {
              height: ready ? height : 1,
              opacity: ready ? 1 : 0,
              backgroundColor: theme.colors.surface,
            },
          ]}
          originWhitelist={['*']}
          onMessage={({ nativeEvent }) => transport.current?.receive(nativeEvent.data)}
          onShouldStartLoadWithRequest={(request) => {
            const allowed = nativeMcpNavigation(request.url);
            if (!allowed) revoke.current();
            return allowed;
          }}
          onError={() => revoke.current()}
          onHttpError={() => revoke.current()}
          onContentProcessDidTerminate={() => revoke.current()}
          onRenderProcessGone={() => revoke.current()}
          onOpenWindow={() => revoke.current()}
          onFileDownload={() => revoke.current()}
          javaScriptEnabled
          domStorageEnabled={false}
          incognito
          cacheEnabled={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows
          geolocationEnabled={false}
          mediaCapturePermissionGrantType="deny"
          mediaPlaybackRequiresUserAction
          allowsAirPlayForMediaPlayback={false}
          allowsLinkPreview={false}
          scrollEnabled={false}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: { flex: 0, width: '100%' },
  loading: {
    gap: theme.spacing.md,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
}));
