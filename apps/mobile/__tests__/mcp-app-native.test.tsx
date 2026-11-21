import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { McpAppCard } from '../components/McpAppCard';
import type { McpAppCardEvent } from '../components/McpAppCard.shared';

const mockGetDocument = jest.fn(
  async (_session: string, _app: string, _signal: AbortSignal) => '<p>SDK app</p>',
);
const mockCall = jest.fn(async () => ({ content: [] }));
const mockBridges: Array<{
  close: jest.Mock;
  oninitialized?: () => void;
  onsizechange?: (size: { height: number }) => void;
  oncalltool?: (call: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  sendToolInput: jest.Mock;
  sendToolResult: jest.Mock;
}> = [];
jest.mock('../lib/client', () => ({
  createVerityClient: () => ({ getMcpAppDocument: mockGetDocument, callMcpAppTool: mockCall }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '50cccf75-0b30-45fc-9e53-c8d5a5c03f80' }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef((props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: jest.fn() }));
      return <View {...props} />;
    }),
  };
});
jest.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    close = jest.fn(async () => undefined);
    sendToolInput = jest.fn(async () => undefined);
    sendToolResult = jest.fn(async () => undefined);
    setHostContext = jest.fn();
    constructor() {
      mockBridges.push(this);
    }
    async connect(transport: { start(): Promise<void> }) {
      await transport.start();
    }
  },
  McpUiToolResultNotificationSchema: { parse: (value: unknown) => value },
}));

const event: McpAppCardEvent = {
  t: 'mcp_app',
  appId: '00000000-0000-4000-8000-000000000001',
  projectId: 'p',
  sessionId: 's',
  turnId: 't',
  connectionId: 'c',
  connectionFingerprint: 'fingerprint',
  toolName: 'list_documents',
  resourceUri: 'ui://documents',
  input: { query: 'latest' },
  result: { content: [{ type: 'text', text: 'Saved document result' }] },
};

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockBridges.length = 0;
  mockGetDocument.mockClear();
  mockCall.mockClear();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

afterEach(() => jest.restoreAllMocks());

it('loads authenticated HTML, preserves inputs/results and revokes the bridge before blocked navigation', async () => {
  render(<McpAppCard event={event} />);
  const view = await screen.findByTestId('mcp-app-webview');
  expect(view.props.source.html).toContain('sandbox="allow-scripts"');
  expect(view.props.sharedCookiesEnabled).toBe(false);
  expect(view.props.allowFileAccess).toBe(false);
  expect(view.props.mediaCapturePermissionGrantType).toBe('deny');
  const bridge = mockBridges[0]!;
  await act(async () => bridge.oninitialized?.());
  expect(bridge.sendToolInput).toHaveBeenCalledWith({ arguments: event.input });
  expect(bridge.sendToolResult).toHaveBeenCalledWith(event.result);
  await act(async () => {
    await bridge.oncalltool?.({ name: 'refresh', arguments: {} });
  });
  expect(mockCall).toHaveBeenCalledWith(
    's',
    event.appId,
    { name: 'refresh', arguments: {} },
    expect.any(AbortSignal),
  );
  let allowed: boolean | undefined;
  act(() => {
    allowed = view.props.onShouldStartLoadWithRequest({ url: 'https://untrusted.example' });
  });
  expect(allowed).toBe(false);
  expect(bridge.close).toHaveBeenCalled();
  expect(mockGetDocument.mock.calls[0]![2].aborted).toBe(true);
  await expect(bridge.oncalltool?.({ name: 'refresh', arguments: {} })).rejects.toThrow('closed');
  expect(screen.getByText('Saved document result')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Try again'));
  await screen.findByTestId('mcp-app-webview');
  expect(mockBridges).toHaveLength(2);
});

it('disposes old instances on app changes, backgrounding and unmount, and starts fresh on resume', async () => {
  let stateChange: ((state: AppStateStatus) => void) | undefined;
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_kind, listener) => {
      stateChange = listener;
      return { remove: jest.fn() };
    });
  const { rerender, unmount } = render(<McpAppCard event={event} />);
  await screen.findByTestId('mcp-app-webview');
  await act(async () => mockBridges[0]!.oninitialized?.());
  act(() => mockBridges[0]!.onsizechange?.({ height: 5000 }));
  expect(screen.getByTestId('mcp-app-webview')).toHaveStyle({ height: 800 });
  act(() => mockBridges[0]!.onsizechange?.({ height: 1 }));
  expect(screen.getByTestId('mcp-app-webview')).toHaveStyle({ height: 120 });
  const changedResult = { content: [{ type: 'text', text: 'Updated document result' }] };
  rerender(<McpAppCard event={{ ...event, result: changedResult }} />);
  await waitFor(() =>
    expect(mockBridges[0]!.sendToolResult).toHaveBeenLastCalledWith(changedResult),
  );
  rerender(<McpAppCard event={{ ...event, appId: '00000000-0000-4000-8000-000000000002' }} />);
  await waitFor(() => expect(mockBridges).toHaveLength(2));
  expect(mockBridges[0]!.close).toHaveBeenCalled();
  act(() => stateChange?.('background'));
  expect(screen.queryByTestId('mcp-app-webview')).toBeNull();
  expect(mockBridges[1]!.close).toHaveBeenCalled();
  act(() => stateChange?.('active'));
  await screen.findByTestId('mcp-app-webview');
  expect(mockBridges).toHaveLength(3);
  unmount();
  expect(mockBridges[2]!.close).toHaveBeenCalled();
  subscription.mockRestore();
});

it('shows the last result after initialization times out and permits a controlled retry', async () => {
  jest.useFakeTimers();
  try {
    render(<McpAppCard event={event} />);
    await act(async () => undefined);
    act(() => jest.advanceTimersByTime(15_000));
    expect(screen.getByText('The interactive app could not be loaded.')).toBeOnTheScreen();
    expect(screen.getByText('Saved document result')).toBeOnTheScreen();
    expect(mockBridges[0]!.close).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
