import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeUnixServer, exchangeControlFrame, listenUnix } from './control-socket.js';

import {
  ackCodexCredentialUpdate,
  CodexAccessTokenRejectedError,
  configureAgentGateway,
  readCodexAccessToken,
  readCodexCredentialUpdate,
  readAgentGatewayStatus,
  startAgentGatewayControlServer,
  type AgentGatewayConfiguration,
  type AgentGatewayControlServer,
} from './agent-gateway-control.js';
import {
  CodexCredentialUnavailableError,
  CodexSignInUnusableError,
} from './codex-sign-in-error.js';

const roots: string[] = [];
const servers: AgentGatewayControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent gateway Unix control channel', () => {
  it('reads and acknowledges a Codex rotation only through the explicit control requests', async () => {
    const socketPath = await temporarySocket();
    const update = {
      sourceRevision: '1'.repeat(64),
      updatedRevision: '2'.repeat(64),
      authJson: '{"tokens":{"access_token":"rotated"}}',
    };
    let pending: typeof update | undefined = update;
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      readCodexCredentialUpdate: () => pending,
      ackCodexCredentialUpdate: (sourceRevision, updatedRevision) => {
        if (
          sourceRevision === update.sourceRevision &&
          updatedRevision === update.updatedRevision
        ) {
          pending = undefined;
        }
      },
    });
    servers.push(server);

    await expect(readCodexCredentialUpdate(socketPath)).resolves.toEqual(update);
    await ackCodexCredentialUpdate(socketPath, update);
    await expect(readCodexCredentialUpdate(socketPath)).resolves.toBeUndefined();
  });

  it('hands the Server a Codex access token without exposing the rotating login', async () => {
    const socketPath = await temporarySocket();
    const login: { credential?: { accessToken: string; accountId: string } } = {};
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      readCodexAccessToken: () => Promise.resolve(login.credential),
    });
    servers.push(server);

    await expect(readCodexAccessToken(socketPath)).resolves.toBeUndefined();
    login.credential = { accessToken: 'access-1', accountId: 'acct-1' };
    await expect(readCodexAccessToken(socketPath)).resolves.toEqual(login.credential);
  });

  it('reports a failed Codex token read structurally, without the failure detail', async () => {
    const socketPath = await temporarySocket();
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      readCodexAccessToken: () =>
        Promise.reject(
          new CodexCredentialUnavailableError('refresh rejected: secret-bearing', {
            signInRejected: true,
          }),
        ),
    });
    servers.push(server);

    await expect(readCodexAccessToken(socketPath)).rejects.toThrow(
      /codex access token unavailable/,
    );
    await expect(readCodexAccessToken(socketPath)).rejects.not.toThrow(/secret-bearing/);
    // Typed, because the caller has to tell a REFUSAL apart from a control channel
    // it could not talk to: only the first is fixed by signing in again, and the
    // detail that would have said so is deliberately stripped above.
    await expect(readCodexAccessToken(socketPath)).rejects.toBeInstanceOf(
      CodexAccessTokenRejectedError,
    );
    // And the base class as well, because that is the one the usage probe keys on
    // to report `sign-in-rejected`. Re-parenting this error would leave every
    // assertion above green while the banner quietly stopped offering the login.
    await expect(readCodexAccessToken(socketPath)).rejects.toBeInstanceOf(CodexSignInUnusableError);
  });

  // Everything below is a failure a re-login does not fix, so none of it may
  // arrive as a refused sign-in. The flag is opt-in for exactly this reason: the
  // reader has to say so, and only for the failures a new sign-in answers.
  it.each([
    {
      what: 'a token endpoint it could not reach',
      // Exactly what the authority throws when the refresh fetch itself fails.
      // A new sign-in has to reach the same host, so it would fail the same way.
      error: new CodexCredentialUnavailableError('Codex OAuth refresh is unavailable', {
        cause: new Error('ECONNREFUSED'),
      }),
    },
    {
      what: 'a bug in the reader',
      error: new Error('cannot read properties of undefined'),
    },
  ])('does not call $what a refused sign-in', async ({ error }) => {
    const socketPath = await temporarySocket();
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      readCodexAccessToken: () => Promise.reject(error),
    });
    servers.push(server);

    // Still an error, and still detail-free — just not one that offers a remedy
    // it cannot deliver.
    await expect(readCodexAccessToken(socketPath)).rejects.toThrow(
      /codex access token unavailable/,
    );
    await expect(readCodexAccessToken(socketPath)).rejects.not.toBeInstanceOf(
      CodexAccessTokenRejectedError,
    );
  });

  it('does not call an unreachable control socket a refused sign-in', async () => {
    // Nothing is listening. That is the gateway being unreachable, not the gateway
    // declining the login.
    const socketPath = await temporarySocket();
    // Paired with a positive assertion: `not.toBeInstanceOf` alone is satisfied by
    // any error at all, including one thrown before the connection is attempted.
    await expect(readCodexAccessToken(socketPath)).rejects.toThrow(/ENOENT|ECONNREFUSED/);
    await expect(readCodexAccessToken(socketPath)).rejects.not.toBeInstanceOf(
      CodexAccessTokenRejectedError,
    );
  });

  it('does not call a malformed request a refused sign-in', async () => {
    const socketPath = await temporarySocket();
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      readCodexAccessToken: () => ({ accessToken: 'access-1', accountId: 'acct-1' }),
    });
    servers.push(server);

    // A frame this gateway rejects before it ever reaches the token handler. The
    // old mapping turned every `ok: false` into a refusal, which put a "sign in to
    // Codex" remedy on a protocol bug.
    const refusal = await rawExchange(socketPath, { type: 'nonsense' });
    expect(refusal).toMatchObject({ ok: false });
    expect(refusal).not.toHaveProperty('signInRejected');
  });

  it('will not take a garbled refusal flag as a refusal', async () => {
    // A gateway newer or stranger than this client. `signInRejected` is only ever
    // `true` or absent, and anything else has to read as "not known to be a
    // sign-in problem" rather than as a refusal with a button attached.
    const socketPath = await temporarySocket();
    const server = await startRawControlServer(socketPath, {
      ok: false,
      error: 'something else',
      signInRejected: 'yes',
    });
    servers.push(server);

    // The message proves the frame reached the parser and was turned away there;
    // the class proves the garbled flag did not become a refused sign-in on the way
    // past. Without the first, a stand-in that dropped the connection would pass
    // the second on a transport error alone.
    await expect(readCodexAccessToken(socketPath)).rejects.toThrow(/returned an invalid response/);
    await expect(readCodexAccessToken(socketPath)).rejects.not.toBeInstanceOf(
      CodexAccessTokenRejectedError,
    );
  });

  it('keeps the error of a peer that spells out a non-refusal', async () => {
    // This gateway leaves the flag off rather than writing `false`, but a peer that
    // spells it out is making the same claim — and discarding an otherwise valid
    // frame over it would replace a real diagnosis with "invalid response".
    const socketPath = await temporarySocket();
    const server = await startRawControlServer(socketPath, {
      ok: false,
      error: 'something else',
      signInRejected: false,
    });
    servers.push(server);

    await expect(readCodexAccessToken(socketPath)).rejects.toThrow(
      /access token read failed: something else/,
    );
    await expect(readCodexAccessToken(socketPath)).rejects.not.toBeInstanceOf(
      CodexAccessTokenRejectedError,
    );
  });

  it('starts unconfigured and applies an in-memory TLS/peer snapshot', async () => {
    const socketPath = await temporarySocket();
    let current: AgentGatewayConfiguration | undefined;
    const configure = vi.fn((configuration: AgentGatewayConfiguration) => {
      current = configuration;
    });
    const server = await startAgentGatewayControlServer({
      socketPath,
      configure,
      status: () => ({
        ready: true,
        configured: current !== undefined,
        ...(current === undefined ? {} : { revision: current.revision }),
        claudePeerCount: current?.claude.peerBindings.length ?? 0,
      }),
    });
    servers.push(server);

    await expect(readAgentGatewayStatus(socketPath)).resolves.toEqual({
      ready: true,
      configured: false,
      claudePeerCount: 0,
    });
    await expect(configureAgentGateway(socketPath, configuration())).resolves.toEqual({
      ready: true,
      configured: true,
      revision: 'revision-1',
      claudePeerCount: 1,
    });
    expect(configure).toHaveBeenCalledOnce();
    expect(current?.claude.tls.key).toBe('gateway-private-key');
    expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    await expect(
      configureAgentGateway(socketPath, {
        ...configuration(),
        claude: {
          ...configuration().claude,
          credential: { unsealKey: 'too-short', accessToken: 'token' },
        },
      }),
    ).rejects.toThrow('invalid gateway configuration');
  });

  it('refuses to replace a non-socket control path', async () => {
    const socketPath = await temporarySocket();
    await mkdir(dirname(socketPath), { recursive: true });
    await writeFile(socketPath, 'do not replace');

    await expect(
      startAgentGatewayControlServer({
        socketPath,
        configure: () => undefined,
        status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      }),
    ).rejects.toThrow('exists and is not a socket');
    await expect(stat(socketPath)).resolves.toBeDefined();
  });

  it('refuses to orphan an already active gateway socket', async () => {
    const socketPath = await temporarySocket();
    const first = await startAgentGatewayControlServer({
      socketPath,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
    });
    servers.push(first);

    await expect(
      startAgentGatewayControlServer({
        socketPath,
        configure: () => undefined,
        status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
      }),
    ).rejects.toThrow('already active');
    await expect(readAgentGatewayStatus(socketPath)).resolves.toMatchObject({ ready: true });
  });

  it('times out a stalled client before accepting later control requests', async () => {
    const socketPath = await temporarySocket();
    const server = await startAgentGatewayControlServer({
      socketPath,
      requestTimeoutMs: 250,
      configure: () => undefined,
      status: () => ({ ready: true, configured: false, claudePeerCount: 0 }),
    });
    servers.push(server);

    const stalled = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      stalled.once('connect', resolve);
      stalled.once('error', reject);
    });
    await new Promise<void>((resolve) => stalled.once('close', () => resolve()));
    const status = readAgentGatewayStatus(socketPath);
    await expect(status).resolves.toMatchObject({ ready: true });
  });

  it('applies concurrent configuration connections in acceptance order', async () => {
    const socketPath = await temporarySocket();
    const seen: string[] = [];
    let enterFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => (enterFirst = resolve));
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
    const server = await startAgentGatewayControlServer({
      socketPath,
      async configure(value): Promise<void> {
        seen.push(value.revision);
        if (value.revision === 'first') {
          enterFirst?.();
          await firstReleased;
        }
      },
      status: () => ({ ready: true, configured: seen.length > 0, claudePeerCount: 0 }),
    });
    servers.push(server);

    const first = configureAgentGateway(socketPath, { ...configuration(), revision: 'first' });
    await firstEntered;
    const abandoned = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      abandoned.once('connect', () => {
        abandoned.write(`${JSON.stringify({ type: 'status' })}\n`, (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      });
      abandoned.once('error', reject);
    });
    abandoned.destroy();
    const second = configureAgentGateway(socketPath, { ...configuration(), revision: 'second' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(['first']);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(seen).toEqual(['first', 'second']);
  });
});

async function temporarySocket(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verity-agent-gateway-control-'));
  roots.push(root);
  return join(root, 'run', 'control.sock');
}

/** Send a frame the typed client would never send, and read the raw reply. */
function rawExchange(socketPath: string, request: unknown): Promise<unknown> {
  return exchangeControlFrame({ socketPath, request, label: 'Test control' });
}

/** A gateway that answers every frame with one fixed, hand-written response. */
async function startRawControlServer(
  socketPath: string,
  response: unknown,
): Promise<AgentGatewayControlServer> {
  await mkdir(dirname(socketPath), { recursive: true });
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.once('error', () => undefined);
    // Read the request before answering. Ending the socket on connect half-closes
    // it under the client's own write, and the EPIPE that follows looks exactly
    // like the rejection these tests are trying to observe — a stand-in that
    // passes them without the parser ever seeing the frame.
    socket.once('data', () => socket.end(`${JSON.stringify(response)}\n`));
  });
  await listenUnix(server, socketPath);
  return {
    async close(): Promise<void> {
      // The real gateway drains its own connections; this stand-in answers and
      // forgets, so anything the client left half-open has to be torn down here
      // or `server.close()` waits for it.
      for (const socket of open) socket.destroy();
      await closeUnixServer(server);
    },
  };
}

function configuration(): AgentGatewayConfiguration {
  return {
    revision: 'revision-1',
    claude: {
      tls: {
        ca: 'gateway-ca',
        cert: 'gateway-certificate',
        key: 'gateway-private-key',
      },
      peerBindings: [{ projectId: 'project-1', fingerprint256: 'a'.repeat(64) }],
    },
  };
}
