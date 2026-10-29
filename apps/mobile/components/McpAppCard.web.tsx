import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  AppBridge,
  PostMessageTransport,
  McpUiToolResultNotificationSchema,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { createVerityClient } from '../lib/client';
import { Card } from './ui/Card';
import { Text } from './ui/Text';
import { appFallback, type McpAppCardEvent } from './McpAppCard.shared';

export function McpAppCard({ event }: { event: McpAppCardEvent }) {
  const client = useMemo(() => createVerityClient(), []);
  const [document, setDocument] = useState<string>();
  const [error, setError] = useState<string>();
  const failed = useCallback(
    () => setError('Interactive app unavailable. The last result is shown below.'),
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    setDocument(undefined);
    setError(undefined);
    if (!client) {
      failed();
      return;
    }
    void client
      .getMcpAppDocument(event.sessionId, event.appId, controller.signal)
      .then((html) => {
        if (!controller.signal.aborted) setDocument(html);
      })
      .catch(() => {
        if (!controller.signal.aborted) failed();
      });
    return () => controller.abort();
  }, [client, event.sessionId, event.appId, failed]);
  return (
    <Card stacked>
      <Text variant="row">{event.toolName}</Text>
      {!document && !error ? <Text tone="muted">Loading interactive app…</Text> : null}
      {document && client && !error ? (
        <McpAppFrame document={document} event={event} client={client} failed={failed} />
      ) : null}
      {error ? <Text tone="muted">{error}</Text> : null}
      {error && appFallback(event) ? <Text>{appFallback(event)}</Text> : null}
    </Card>
  );
}

function McpAppFrame({
  document,
  event,
  client,
  failed,
}: {
  document: string;
  event: McpAppCardEvent;
  client: NonNullable<ReturnType<typeof createVerityClient>>;
  failed: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const latest = useRef(event);
  latest.current = event;
  const [height, setHeight] = useState(320);
  const { theme, rt } = useUnistyles();
  const dark = rt.themeName === 'dark';
  const ready = useRef(false);
  const hostContext = useRef<McpUiHostContext>({
    platform: 'web',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  useEffect(() => {
    const iframe = frame.current;
    const target = iframe?.contentWindow;
    if (!iframe || !target) return;
    const controller = new AbortController();
    const bridge = new AppBridge(
      null,
      { name: 'Verity', version: '1.0.0' },
      { serverTools: {} },
      {
        hostContext: hostContext.current,
      },
    );
    bridgeRef.current = bridge;
    const timer = setTimeout(failed, 15_000);
    bridge.oninitialized = () => {
      clearTimeout(timer);
      ready.current = true;
      void bridge
        .sendToolInput({ arguments: latest.current.input })
        .then(() =>
          bridge.sendToolResult(
            McpUiToolResultNotificationSchema.parse({
              method: 'ui/notifications/tool-result',
              params: latest.current.result,
            }).params,
          ),
        )
        .catch(failed);
    };
    bridge.onsizechange = ({ height: requested }) => {
      if (typeof requested === 'number' && Number.isFinite(requested))
        setHeight(Math.max(120, Math.min(800, requested)));
    };
    bridge.oncalltool = async (params) => {
      const result = await client.callMcpAppTool(
        latest.current.sessionId,
        latest.current.appId,
        { name: params.name, arguments: params.arguments },
        controller.signal,
      );
      return McpUiToolResultNotificationSchema.parse({
        method: 'ui/notifications/tool-result',
        params: result,
      }).params;
    };
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        hostContext.current = {
          ...hostContext.current,
          containerDimensions: { width: entry.contentRect.width, maxHeight: 800 },
        };
        bridge.setHostContext(hostContext.current);
      }
    });
    observer.observe(iframe);
    void bridge
      .connect(new PostMessageTransport(target, target))
      .then(() => {
        if (!controller.signal.aborted) iframe.srcdoc = document;
      })
      .catch(failed);
    return () => {
      ready.current = false;
      bridgeRef.current = null;
      clearTimeout(timer);
      controller.abort();
      observer.disconnect();
      void bridge
        .teardownResource({}, { timeout: 500 })
        .catch(() => undefined)
        .finally(() => bridge.close());
    };
  }, [document, client, failed]);
  useEffect(() => {
    hostContext.current = { ...hostContext.current, theme: dark ? 'dark' : 'light' };
    bridgeRef.current?.setHostContext(hostContext.current);
  }, [dark, theme]);
  useEffect(() => {
    if (ready.current && bridgeRef.current) {
      void bridgeRef.current
        .sendToolResult(
          McpUiToolResultNotificationSchema.parse({
            method: 'ui/notifications/tool-result',
            params: event.result,
          }).params,
        )
        .catch(failed);
    }
  }, [event.result, failed]);
  return (
    <iframe
      ref={frame}
      title={event.toolName}
      sandbox="allow-scripts"
      allow=""
      referrerPolicy="no-referrer"
      style={{ width: '100%', height, border: 0, backgroundColor: theme.colors.surface }}
    />
  );
}
