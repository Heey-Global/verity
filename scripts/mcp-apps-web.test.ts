/// <reference lib="dom" />
// @vitest-environment jsdom
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpAppCard } from '../apps/mobile/components/McpAppCard.web.js';
import type { McpAppCardEvent } from '../apps/mobile/components/McpAppCard.shared.js';

const mocks = vi.hoisted(() => ({
  getMcpAppDocument: vi.fn(),
  callMcpAppTool: vi.fn(),
  theme: { theme: { colors: { surface: '#fff' } }, rt: { themeName: 'dark' } },
}));
vi.mock('../apps/mobile/lib/client', () => ({ createVerityClient: () => mocks }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => mocks.theme }));
vi.mock('../apps/mobile/components/ui/Card', async () => ({
  Card: ({ children }: { children: React.ReactNode }) =>
    awaitReact.createElement('div', {}, children),
}));
vi.mock('../apps/mobile/components/ui/Text', async () => ({
  Text: ({ children }: { children: React.ReactNode }) =>
    awaitReact.createElement('span', {}, children),
}));
// Factories run after module imports, but their render functions run during the test.
const awaitReact = React;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.getMcpAppDocument
    .mockReset()
    .mockResolvedValue('<!doctype html><html><body>Dashboard</body></html>');
  mocks.callMcpAppTool.mockReset().mockResolvedValue({
    content: [{ type: 'text', text: 'Count: 2' }],
    structuredContent: { count: 2 },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const event: McpAppCardEvent = {
  t: 'mcp_app',
  appId: '00000000-0000-4000-8000-000000000001',
  projectId: 'p',
  sessionId: 's',
  turnId: 'finished',
  connectionId: 'c',
  connectionFingerprint: 'fingerprint',
  toolName: 'dashboard',
  resourceUri: 'ui://dashboard',
  input: { city: 'Berlin' },
  result: { content: [{ type: 'text', text: 'Count: 1' }], structuredContent: { count: 1 } },
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function message(source: MessageEventSource | null, data: unknown) {
  await React.act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source, data }));
    await tick();
  });
}

it('uses the real SDK handshake, sends saved data, refreshes through the scoped client and rejects foreign windows', async () => {
  await React.act(async () => {
    root.render(React.createElement(McpAppCard, { event }));
    await tick();
  });
  const iframe = container.querySelector('iframe')!;
  expect(iframe).not.toBeNull();
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
  const target = iframe.contentWindow!;
  const posted = vi.spyOn(target, 'postMessage');
  await message(target, {
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Fixture', version: '1.0.0' },
      appCapabilities: {},
    },
  });
  expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 1,
      result: expect.objectContaining({
        hostInfo: { name: 'Verity', version: '1.0.0' },
        hostContext: expect.objectContaining({ theme: 'dark' }),
      }),
    }),
    '*',
  );
  await message(target, { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
  expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'ui/notifications/tool-input',
      params: { arguments: { city: 'Berlin' } },
    }),
    '*',
  );
  expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'ui/notifications/tool-result', params: event.result }),
    '*',
  );
  await message(window, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'refresh' },
  });
  expect(mocks.callMcpAppTool).not.toHaveBeenCalled();
  await message(target, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'refresh', arguments: {} },
  });
  expect(mocks.callMcpAppTool).toHaveBeenCalledWith(
    's',
    event.appId,
    { name: 'refresh', arguments: {} },
    expect.any(AbortSignal),
  );
  expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 2,
      result: expect.objectContaining({ structuredContent: { count: 2 } }),
    }),
    '*',
  );
  await message(target, {
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: 999999 },
  });
  expect(iframe.style.height).toBe('800px');
  await React.act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(McpAppCard, {
        event: { ...event, result: { content: [], structuredContent: { count: 2 } } },
      }),
    );
    await tick();
  });
  expect(mocks.getMcpAppDocument).toHaveBeenCalledTimes(2);
  expect(mocks.callMcpAppTool).toHaveBeenCalledTimes(1);
});

it('retains text fallback when the app resource is revoked or unavailable', async () => {
  mocks.getMcpAppDocument.mockRejectedValue(new Error('revoked'));
  await React.act(async () => {
    root.render(React.createElement(McpAppCard, { event }));
    await tick();
  });
  expect(container.textContent).toContain('Count: 1');
  expect(container.querySelector('iframe')).toBeNull();
});
