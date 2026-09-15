// MCP connections — the list and the screen that adds one.
//
// They are two routes rather than a list with a form stapled underneath it,
// which puts one thing at risk: a connection created on the add screen is
// created against a list that is no longer mounted in front of the operator.
// The list reloads on focus for exactly that reason, and the first test below
// is what keeps it honest.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

const mockRunMcpOAuth = jest.fn();
jest.mock('../lib/mcpOAuth', () => ({
  // The URL predicate stays real: it is what decides whether the Google
  // endpoints are filled in, and a stub of it would test nothing.
  ...jest.requireActual('../lib/mcpOAuth'),
  runMcpOAuth: (connection: unknown) => mockRunMcpOAuth(connection),
}));

import McpConnectionsScreen from '../app/settings/services/mcp/index';
import NewMcpConnectionScreen from '../app/settings/services/mcp/new';
import {
  makeClient,
  mockBack,
  mockCreateVerityClient,
  mockPush,
  refocus,
  resetSettingsHarness,
} from './support/settingsHarness';

type Connection = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authorizationConfigured: boolean;
  authType: 'none' | 'static' | 'oauth';
  oauthConnected: boolean;
  oauthClientId: string | null;
  oauthAuthorizationEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  oauthScopes: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'gmail',
    url: 'https://mcp.example.test/gmail',
    enabled: true,
    authorizationConfigured: false,
    authType: 'none',
    oauthConnected: false,
    oauthClientId: null,
    oauthAuthorizationEndpoint: null,
    oauthTokenEndpoint: null,
    oauthScopes: null,
    ...overrides,
  };
}

const OAUTH_CONNECTION = makeConnection({
  authType: 'oauth',
  oauthClientId: 'client-id',
  oauthAuthorizationEndpoint: 'https://accounts.example.test/authorize',
  oauthTokenEndpoint: 'https://accounts.example.test/token',
  oauthScopes: 'openid',
});

afterEach(() => {
  resetSettingsHarness();
  mockRunMcpOAuth.mockReset();
  jest.restoreAllMocks();
});

describe('settings/services/mcp — the list', () => {
  it('shows the connections the server holds', async () => {
    const connection = makeConnection();
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listHttpMcpConnections: jest.fn().mockResolvedValue([connection]),
      }),
    );
    render(<McpConnectionsScreen />);

    expect(await screen.findByText(connection.name)).toBeOnTheScreen();
    expect(screen.getByText(connection.url)).toBeOnTheScreen();
  });

  // The add screen pops back to this one. Without a reload on focus the
  // connection the operator just created would be missing from the only list
  // that shows it, which reads as a save that did not happen.
  it('picks up a connection added on the other screen when focus returns', async () => {
    const listHttpMcpConnections = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([makeConnection({ name: 'drive' })]);
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { listHttpMcpConnections }));
    render(<McpConnectionsScreen />);

    expect(await screen.findByText('No MCP connections yet.')).toBeOnTheScreen();
    await act(async () => refocus());
    expect(await screen.findByText('drive')).toBeOnTheScreen();
  });

  it('does not let an older focus response replace the newest list', async () => {
    const first = deferred<Connection[]>();
    const listHttpMcpConnections = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([makeConnection({ name: 'newest' })]);
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { listHttpMcpConnections }));
    render(<McpConnectionsScreen />);

    await act(async () => refocus());
    expect(await screen.findByText('newest')).toBeOnTheScreen();
    await act(async () => first.resolve([makeConnection({ name: 'stale' })]));

    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.getByText('newest')).toBeOnTheScreen();
  });

  it('leads to the add screen rather than expanding a form in place', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<McpConnectionsScreen />);

    fireEvent.press(await screen.findByLabelText('Add connection'));
    expect(mockPush).toHaveBeenCalledWith('/settings/services/mcp/new');
    expect(screen.queryByLabelText('Remote HTTPS MCP URL')).toBeNull();
  });

  it('reports an OAuth connection that has not been authorized yet', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listHttpMcpConnections: jest.fn().mockResolvedValue([OAUTH_CONNECTION]),
      }),
    );
    render(<McpConnectionsScreen />);

    expect(await screen.findByText('Not authorized')).toBeOnTheScreen();
    expect(screen.getByLabelText(`Connect OAuth for ${OAUTH_CONNECTION.name}`)).toBeOnTheScreen();
  });

  it('completes an OAuth authorization and re-reads the connection', async () => {
    const completeHttpMcpOAuth = jest.fn().mockResolvedValue(undefined);
    const listHttpMcpConnections = jest
      .fn()
      .mockResolvedValueOnce([OAUTH_CONNECTION])
      .mockResolvedValue([{ ...OAUTH_CONNECTION, oauthConnected: true }]);
    mockRunMcpOAuth.mockResolvedValue({
      kind: 'success',
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://verity.build/mcp/oauth/callback',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { listHttpMcpConnections, completeHttpMcpOAuth }),
    );
    render(<McpConnectionsScreen />);

    fireEvent.press(await screen.findByLabelText(`Connect OAuth for ${OAUTH_CONNECTION.name}`));

    await waitFor(() => expect(completeHttpMcpOAuth).toHaveBeenCalledTimes(1));
    expect(completeHttpMcpOAuth.mock.calls[0]?.[0]).toBe(OAUTH_CONNECTION.id);
    expect(await screen.findByText('Authorized')).toBeOnTheScreen();
  });

  // A cancelled browser sheet is not a failure: nothing was authorized, and
  // nothing should be sent to the server or reported as broken.
  it('sends nothing when the operator cancels the OAuth sheet', async () => {
    const completeHttpMcpOAuth = jest.fn();
    mockRunMcpOAuth.mockResolvedValue({ kind: 'cancelled' });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listHttpMcpConnections: jest.fn().mockResolvedValue([OAUTH_CONNECTION]),
        completeHttpMcpOAuth,
      }),
    );
    render(<McpConnectionsScreen />);

    fireEvent.press(await screen.findByLabelText(`Connect OAuth for ${OAUTH_CONNECTION.name}`));

    await waitFor(() =>
      expect(screen.getByLabelText(`Connect OAuth for ${OAUTH_CONNECTION.name}`)).toBeEnabled(),
    );
    expect(completeHttpMcpOAuth).not.toHaveBeenCalled();
    expect(screen.queryByText('Could not authorize the MCP connection.')).toBeNull();
  });

  it('removes a connection only after the destructive confirmation', async () => {
    const connection = makeConnection();
    const deleteHttpMcpConnection = jest.fn().mockResolvedValue(undefined);
    const listHttpMcpConnections = jest
      .fn()
      .mockResolvedValueOnce([connection])
      .mockResolvedValue([]);
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { listHttpMcpConnections, deleteHttpMcpConnection }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<McpConnectionsScreen />);

    fireEvent.press(await screen.findByLabelText(`Remove ${connection.name} MCP connection`));
    expect(deleteHttpMcpConnection).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0]?.[2] ?? [];
    const confirm = buttons.find((button) => button.style === 'destructive');
    // The confirmation says what else it takes with it — removing a connection
    // also removes it from every project.
    expect(String(alert.mock.calls[0]?.[1])).toContain(connection.name);
    // The alert button is outside the tree, so its state updates need wrapping.
    act(() => confirm?.onPress?.());

    await waitFor(() => expect(deleteHttpMcpConnection).toHaveBeenCalledWith(connection.id));
    expect(await screen.findByText('No MCP connections yet.')).toBeOnTheScreen();
  });

  // A server predating MCP connections has no endpoint to call. That is an empty
  // list, not a broken one — an error banner here would be a lie.
  it('shows an empty list, not an error, on a server without the endpoint', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { listHttpMcpConnections: null }),
    );
    render(<McpConnectionsScreen />);

    expect(await screen.findByText('No MCP connections yet.')).toBeOnTheScreen();
    expect(screen.queryByText('Could not load MCP connections.')).toBeNull();
    expect(screen.queryByLabelText('Add connection')).toBeNull();
  });

  it('says so when the list could not be loaded', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listHttpMcpConnections: jest.fn().mockRejectedValue(new Error('offline')),
      }),
    );
    render(<McpConnectionsScreen />);

    expect(await screen.findByText('Could not load MCP connections.')).toBeOnTheScreen();
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<McpConnectionsScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });
});

describe('settings/services/mcp/new — adding one', () => {
  it('will not submit until it has a name and a URL', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<NewMcpConnectionScreen />);

    const add = await screen.findByLabelText('Add MCP connection');
    expect(add).toBeDisabled();

    fireEvent.changeText(screen.getByLabelText('Connection name'), 'gmail');
    expect(add).toBeDisabled();
    fireEvent.changeText(
      screen.getByLabelText('Remote HTTPS MCP URL'),
      'https://mcp.example.test/gmail',
    );
    await waitFor(() => expect(add).toBeEnabled());
  });

  it('creates an unauthenticated connection and returns to the list', async () => {
    const createHttpMcpConnection = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { createHttpMcpConnection }));
    render(<NewMcpConnectionScreen />);

    fireEvent.changeText(await screen.findByLabelText('Connection name'), 'gmail');
    fireEvent.changeText(
      screen.getByLabelText('Remote HTTPS MCP URL'),
      'https://mcp.example.test/gmail',
    );
    fireEvent.press(screen.getByLabelText('Add MCP connection'));

    await waitFor(() => expect(createHttpMcpConnection).toHaveBeenCalledTimes(1));
    expect(createHttpMcpConnection.mock.calls[0]?.[0]).toEqual({
      name: 'gmail',
      url: 'https://mcp.example.test/gmail',
      authType: 'none',
    });
    // Back to the list, which reloads on focus and shows what was just created.
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('creates only one connection when the add button is pressed twice quickly', async () => {
    const created = deferred<void>();
    const createHttpMcpConnection = jest.fn().mockReturnValue(created.promise);
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { createHttpMcpConnection }));
    render(<NewMcpConnectionScreen />);

    fireEvent.changeText(await screen.findByLabelText('Connection name'), 'gmail');
    fireEvent.changeText(
      screen.getByLabelText('Remote HTTPS MCP URL'),
      'https://mcp.example.test/gmail',
    );
    const add = screen.getByLabelText('Add MCP connection');
    fireEvent.press(add);
    fireEvent.press(add);

    expect(createHttpMcpConnection).toHaveBeenCalledTimes(1);
    await act(async () => created.resolve());
  });

  it('sends a pasted Authorization header as a static credential', async () => {
    const createHttpMcpConnection = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { createHttpMcpConnection }));
    render(<NewMcpConnectionScreen />);

    fireEvent.changeText(await screen.findByLabelText('Connection name'), 'internal');
    fireEvent.changeText(
      screen.getByLabelText('Remote HTTPS MCP URL'),
      'https://mcp.example.test/internal',
    );
    fireEvent.changeText(screen.getByLabelText('Authorization header'), 'Bearer token-fixture');
    fireEvent.press(screen.getByLabelText('Add MCP connection'));

    await waitFor(() => expect(createHttpMcpConnection).toHaveBeenCalledTimes(1));
    expect(createHttpMcpConnection.mock.calls[0]?.[0]).toEqual({
      name: 'internal',
      url: 'https://mcp.example.test/internal',
      authType: 'static',
      authorization: 'Bearer token-fixture',
    });
  });

  // Google's endpoints are not discoverable from the MCP URL, and typing them by
  // hand is where this flow usually fails.
  it('fills in the Google endpoints when OAuth is enabled for the official Gmail URL', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<NewMcpConnectionScreen />);

    fireEvent.changeText(await screen.findByLabelText('Connection name'), 'gmail');
    fireEvent.changeText(
      screen.getByLabelText('Remote HTTPS MCP URL'),
      'https://gmailmcp.googleapis.com/mcp/v1',
    );
    fireEvent.press(screen.getByText('Use OAuth 2.0'));

    const authorize = await screen.findByLabelText('Authorization endpoint');
    expect(authorize.props.value).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(screen.getByLabelText('Token endpoint').props.value).toBe(
      'https://oauth2.googleapis.com/token',
    );
    expect(String(screen.getByLabelText('OAuth scopes (space-separated)').props.value)).toContain(
      'gmail.readonly',
    );
    // Scopes and endpoints are filled, but the client id is the operator's own.
    expect(screen.getByLabelText('Add MCP connection')).toBeDisabled();
  });

  it('will not submit an OAuth connection missing its client id', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<NewMcpConnectionScreen />);

    fireEvent.changeText(await screen.findByLabelText('Connection name'), 'gmail');
    fireEvent.changeText(
      screen.getByLabelText('Remote HTTPS MCP URL'),
      'https://mcp.example.test/gmail',
    );
    fireEvent.press(screen.getByText('Use OAuth 2.0'));
    fireEvent.changeText(
      await screen.findByLabelText('Authorization endpoint'),
      'https://accounts.example.test/authorize',
    );
    fireEvent.changeText(
      screen.getByLabelText('Token endpoint'),
      'https://accounts.example.test/token',
    );
    fireEvent.changeText(screen.getByLabelText('OAuth scopes (space-separated)'), 'openid');

    // An OAuth connection with no client id cannot authorize; it would be saved
    // and then fail on the list screen with nothing to explain it.
    expect(screen.getByLabelText('Add MCP connection')).toBeDisabled();
  });

  it('explains a rejected connection instead of leaving the button silent', async () => {
    const createHttpMcpConnection = jest.fn().mockRejectedValue(new Error('bad url'));
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { createHttpMcpConnection }));
    render(<NewMcpConnectionScreen />);

    fireEvent.changeText(await screen.findByLabelText('Connection name'), 'gmail');
    fireEvent.changeText(screen.getByLabelText('Remote HTTPS MCP URL'), 'http://10.0.0.1/mcp');
    fireEvent.press(screen.getByLabelText('Add MCP connection'));

    expect(
      await screen.findByText('Could not save the MCP connection. Use a public HTTPS URL.'),
    ).toBeOnTheScreen();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<NewMcpConnectionScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });
});
