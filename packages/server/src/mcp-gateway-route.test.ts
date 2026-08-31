import { secretAuditEventInputSchema } from '@verity/secret-contracts';
import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VERITY_CONTROL_PROJECT_ID, buildServer } from './server.js';
import {
  markInternalConnections,
  PROJECT_UDS_ROUTES,
  requestArrivedInternally,
  startInternalListener,
  startProjectInternalUnixListener,
} from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import type { McpGatewayAuditRecord, McpGatewayDeps } from './mcp-gateway.js';
import {
  SESSION_HANDOFF_ENVELOPE,
  SESSION_HANDOFF_TRANSCRIPT_LABEL,
} from './session-handoff-tool.js';

const TEST_UID = process.getuid?.() ?? 1000;
const TEST_GID = process.getgid?.() ?? 1000;

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

interface Harness {
  app: FastifyInstance;
  store: EventStore;
  tokens: ReturnType<typeof createMcpGatewayTokens>;
  records: McpGatewayAuditRecord[];
  invocations: Array<{ sessionId: string; turnId: string; toolName: string; request: unknown }>;
  approvals: Array<{
    sessionId: string;
    callId: string;
    toolName: string;
    allowStandingGrant?: boolean;
  }>;
  /** Turns the handoff tool delivered through the conductor, in the argument shape it used. */
  dispatches: Array<{
    sessionId: string;
    prompt: string;
    turnOpts: unknown;
    dispatchOpts: { displayPrompt?: string; clientReplyId?: string };
  }>;
}

function build(
  options: {
    wire?: boolean;
    allow?: boolean;
    trustedCli?: boolean;
    /** Compose the deployment's network-origin gate, so `/internal/*` behaves on the
     *  operator-facing listener the way a real deployment makes it behave. */
    internalGuard?: boolean;
    /** Enforce the operator bearer gate, as any onboarded deployment does. A gateway
     *  bearer is not an operator token, so a route that is not pre-auth allowlisted is
     *  refused before its handler runs. */
    enforceAuth?: boolean;
    /** Advertise the control-plane session tools, as `embedded.ts` does for that project. */
    sessionTools?: boolean;
  } = {},
): Harness {
  const cipher = createSealableSecretCipher();
  const store = new EventStore(ctx.db, cipher);
  const tokens = createMcpGatewayTokens();
  const records: McpGatewayAuditRecord[] = [];
  const invocations: Harness['invocations'] = [];
  const approvals: Harness['approvals'] = [];
  const dispatches: Harness['dispatches'] = [];
  const gateway: Omit<McpGatewayDeps, 'requestApproval'> = {
    servedTools:
      options.trustedCli === true
        ? ['verity_http_request', 'verity_secret_run']
        : ['verity_http_request'],
    ...(options.sessionTools === true
      ? { extraToolsForProject: () => ['verity_list_sessions', 'verity_session_handoff'] as const }
      : {}),
    resolveCaller: (input) => Promise.resolve(tokens.resolve(input)),
    invokeTool: ({ sessionId, turnId, toolName, request: toolRequest }) => {
      invocations.push({ sessionId, turnId, toolName, request: toolRequest });
      return Promise.resolve({ status: 200, body: 'ok' });
    },
    recordCall: ({ projectId, kind, ...gateway }) => {
      // Parsed, not just collected. The audit event schema carries invariants no assertion in
      // this file restates — a rejection that must or must not be keyed, must or must not name
      // a tool — and a record violating one would otherwise fail first on a production append,
      // long after the branch that wrote it. This is the same mapping `embedded.ts` performs,
      // so every record any test here provokes is held to the shape that will be persisted.
      secretAuditEventInputSchema.parse({
        projectId,
        kind,
        aliases: [],
        providerBindings: [],
        gateway,
        recordedAt: new Date().toISOString(),
      });
      records.push({ projectId, kind, ...gateway });
      return Promise.resolve();
    },
    // Shaped like a real one — the audit schema requires 64 hex characters, and the parse in
    // `recordCall` above is only worth anything if the fields around the branch under test
    // are the ones production supplies. Derived from the request rather than constant, because
    // the MAC is the only part of the gateway's `invocationId` that varies with what was
    // actually asked for; a constant would let a test claim two different calls key apart when
    // only their JSON-RPC id said so. Unkeyed and so not the real MAC, but a digest over the
    // WHOLE request, which is the property the idempotency test leans on — a stub that hashed
    // a prefix would agree on two calls that differ only in their briefing.
    requestMac: ({ request }) =>
      Promise.resolve({
        requestMac: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        macKeyId: 'key-1',
      }),
  };
  // Only `requestExternalPermission` is reachable from this route; the rest of the
  // conductor surface is deliberately absent so a wiring slip shows up as a crash.
  const conductor = {
    requestExternalPermission: (input: {
      sessionId: string;
      toolUseId: string;
      toolName: string;
      allowStandingGrant?: boolean;
    }) => {
      approvals.push({
        sessionId: input.sessionId,
        callId: input.toolUseId,
        toolName: input.toolName,
        ...(input.allowStandingGrant === undefined
          ? {}
          : { allowStandingGrant: input.allowStandingGrant }),
      });
      // `'card'`, not a free-form word: `decidedBy` is a `PermissionDecisionSource` and
      // reaches the audit record as its `decision`, where the schema admits `card` or `grant`
      // and nothing else. The stub is cast to `Conductor` below, so only the parse in
      // `recordCall` holds this honest.
      return Promise.resolve(
        options.allow === false
          ? { decision: { behavior: 'deny', message: 'no' }, decidedBy: 'card' }
          : { decision: { behavior: 'allow' }, decidedBy: 'card' },
      );
    },
    // `verity_list_sessions` answers through the route's own session summarizer, which reads
    // live permission state, and `verity_session_handoff` delivers through the conductor.
    // Wired only when those tools are advertised, so every other test keeps the
    // absent-surface property above.
    ...(options.sessionTools === true
      ? {
          pendingPermissions: () => [],
          isBusy: () => false,
          // Typed as the real method, so the four-argument call the route makes is checked
          // against `Conductor` at compile time rather than only at run time — the cast
          // below would otherwise let an arity change through silently.
          dispatchTurn: ((sessionId, prompt, turnOpts, dispatchOpts) => {
            dispatches.push({ sessionId, prompt, turnOpts, dispatchOpts: dispatchOpts ?? {} });
            return Promise.resolve({ queued: true });
          }) satisfies Conductor['dispatchTurn'],
        }
      : {}),
  } as unknown as Conductor;
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    ...(options.wire === false ? {} : { mcpGateway: gateway }),
    ...(options.internalGuard === true ? { internalPathGuard: requestArrivedInternally } : {}),
    ...(options.enforceAuth === true
      ? {
          authRegistry: {
            isEnabled: () => true,
            verify: () => false,
          } as unknown as Parameters<typeof buildServer>[0]['authRegistry'],
        }
      : {}),
  });
  return { app, store, tokens, records, invocations, approvals, dispatches };
}

function postUnix(
  socketPath: string,
  authorization: string | undefined,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        socketPath,
        method: 'POST',
        path: '/internal/mcp',
        headers: {
          ...(authorization !== undefined ? { authorization } : {}),
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}

function getUnix(
  socketPath: string,
): Promise<{ status: number; allow: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: 'GET',
        path: '/internal/mcp',
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            allow: res.headers.allow,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.once('error', reject);
    req.end();
  });
}

async function withListener(
  harness: Harness,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'verity-mcp-route-'));
  await harness.app.ready();
  const listener = await startProjectInternalUnixListener(harness.app, {
    socketRoot: dir,
    identity: { projectId: 'p1', containerGeneration: 'generation-1' },
    ownerUid: TEST_UID,
    relayGid: TEST_GID,
  });
  try {
    await run(listener.socketPath);
  } finally {
    await listener.close();
    await harness.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('POST /internal/mcp (loopback MCP gateway)', () => {
  it('serves a tool call for the session and turn the bearer was minted for', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'verity_http_request',
          arguments: {
            method: 'GET',
            url: 'https://api.example.com/v1/things',
            secretAlias: 'EXAMPLE_TOKEN',
            auth: { header: 'authorization', scheme: 'Bearer' },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).result.isError).toBeUndefined();
      // The turn comes from the bearer, never from the request body — that is what lets
      // the brokered HTTP tool's at-most-once fence key on the right turn.
      expect(harness.invocations).toEqual([
        {
          sessionId: 's1',
          turnId: 't1',
          toolName: 'verity_http_request',
          request: expect.objectContaining({
            method: 'GET',
            url: 'https://api.example.com/v1/things',
            secretAlias: 'EXAMPLE_TOKEN',
          }),
        },
      ]);
      expect(harness.approvals).toEqual([
        {
          sessionId: 's1',
          callId: expect.any(String),
          toolName: 'verity_http_request',
          allowStandingGrant: true,
        },
      ]);
      expect(harness.records.map((record) => record.kind)).toEqual([
        'gateway_call_received',
        'gateway_call_served',
      ]);
    });
  });

  it('explicitly disables standing grants for a trusted CLI approval', async () => {
    const harness = build({ trustedCli: true });
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'verity_secret_run',
          arguments: {
            command: ['/usr/bin/kubectl', 'get', 'pods'],
            secrets: [{ secretAlias: 'KUBECONFIG_PROD', env: 'KUBECONFIG', injection: 'file' }],
          },
        },
      });
      expect(res.status).toBe(200);
      expect(harness.approvals).toEqual([
        {
          sessionId: 's1',
          callId: expect.any(String),
          toolName: 'verity_secret_run',
          allowStandingGrant: false,
        },
      ]);
    });
  });

  // The route binds its approval seam to the conductor it was built with; a denied card
  // must reach the caller as a tool error rather than a served call.
  it('does not invoke the tool when the card is denied', async () => {
    const harness = build({ allow: false });
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'verity_http_request',
          arguments: {
            method: 'GET',
            url: 'https://api.example.com/v1/things',
            secretAlias: 'EXAMPLE_TOKEN',
            auth: { header: 'authorization', scheme: 'Bearer' },
          },
        },
      });
      expect(JSON.parse(res.body).result.isError).toBe(true);
      expect(harness.invocations).toEqual([]);
      expect(harness.records.at(-1)).toMatchObject({
        kind: 'gateway_call_rejected',
        rejection: 'denied',
      });
    });
  });

  it('advertises only the tools this composition can serve', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      expect(
        (JSON.parse(res.body).result.tools as Array<{ name: string }>).map((tool) => tool.name),
      ).toEqual(['verity_http_request']);
    });
  });

  it('answers a notification with an empty 202', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      expect(res.status).toBe(202);
      expect(res.body).toBe('');
    });
  });

  it('refuses an unknown bearer and records the attempt', async () => {
    const harness = build();
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, 'Bearer not-a-token', {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'verity_http_request',
          arguments: {
            method: 'GET',
            url: 'https://api.example.com/v1/things',
            secretAlias: 'EXAMPLE_TOKEN',
            auth: { header: 'authorization', scheme: 'Bearer' },
          },
        },
      });
      expect(res.status).toBe(401);
      expect(harness.invocations).toEqual([]);
      expect(harness.records).toEqual([
        expect.objectContaining({
          projectId: 'p1',
          kind: 'gateway_call_rejected',
          rejection: 'unauthenticated',
          toolName: 'verity_http_request',
        }),
      ]);
    });
  });

  // The server-wide limit exists for image attachments on operator turns. A holder of a
  // valid bearer must not be able to spend it here: the body is refused before the handler
  // runs, so nothing is keyed, recorded, or parked on a card.
  it('refuses a body far larger than a call worth approving', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'verity_http_request',
          arguments: {
            method: 'POST',
            url: 'https://api.example.com/v1/things',
            secretAlias: 'EXAMPLE_TOKEN',
            auth: { header: 'authorization', scheme: 'Bearer' },
            body: { blob: 'x'.repeat(512 * 1024) },
          },
        },
      });
      expect(res.status).toBe(413);
      expect(harness.records).toEqual([]);
      expect(harness.approvals).toEqual([]);
      expect(harness.invocations).toEqual([]);
    });
  });

  // A bearer minted for another project is inert here: the project identity comes from
  // the socket the connection landed on, not from anything the caller can set.
  it('refuses a bearer minted for another project', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p2', sessionId: 's2', turnId: 't2' });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      expect(res.status).toBe(401);
    });
  });

  // `/internal/*` never answers on the operator-facing listener, and the gateway route
  // additionally has no project identity to bind a bearer to there.
  it('rejects a valid bearer on the retired TCP path', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/internal/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      });
      expect(res.statusCode).toBe(401);
      expect(harness.invocations).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  // A Streamable HTTP client opens a GET stream for server-initiated messages as soon as
  // the handshake completes. This gateway has none to send, and the only answer its
  // transport reads as "no stream here" is 405 — a 404, whether from an unregistered route
  // or from the relay's allowlist, it surfaces as a connection error once per ACP turn.
  it('refuses the server-message stream with 405 rather than 404', async () => {
    const harness = build();
    await withListener(harness, async (socketPath) => {
      const res = await getUnix(socketPath);
      expect(res.status).toBe(405);
      expect(res.allow).toBe('POST');
      expect(harness.invocations).toEqual([]);
    });
  });

  it('does not serve the route at all when no gateway is composed', async () => {
    const harness = build({ wire: false });
    await withListener(harness, async (socketPath) => {
      const res = await postUnix(socketPath, 'Bearer anything', {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/list',
      });
      expect(res.status).toBe(404);
    });
  });
});

function postTcp(
  port: number,
  path: string,
  authorization: string | undefined,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          ...(authorization !== undefined ? { authorization } : {}),
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}

function getTcp(
  port: number,
  path: string,
): Promise<{ status: number; allow: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'GET', path, headers: { accept: 'text/event-stream' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, allow: res.headers.allow }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

/** The shared, non-published TCP listener the control-plane Runner actually reaches: it
 *  stamps "internal" and carries no project identity, which is the whole reason the
 *  project-socket route cannot serve it. */
async function withInternalTcpListener(
  harness: Harness,
  run: (port: number) => Promise<void>,
): Promise<void> {
  await harness.app.ready();
  const listener = await startInternalListener(harness.app, 0, '127.0.0.1');
  try {
    await run(listener.port);
  } finally {
    await listener.close();
    await harness.app.close();
  }
}

// The control-plane Runner is a fixed peer on the private control network with no project
// container and therefore no per-project broker socket. It reached `/internal/mcp` over the
// shared internal listener, which stamps no project identity, so the route answered 401 to
// the MCP client's `initialize` — every control-plane turn ran with no brokered tool at all
// and nothing said so. There was no test for a control-plane `tools/list`, which is what hid
// it; these are that test.
describe('POST /internal/control-plane/mcp (control-plane gateway)', () => {
  it('completes the handshake and lists tools for a control-plane turn bearer', async () => {
    const harness = build({ trustedCli: true });
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await withInternalTcpListener(harness, async (port) => {
      const initialized = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      expect(initialized.status).toBe(200);

      const listed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      expect(listed.status).toBe(200);
      const tools = (
        JSON.parse(listed.body) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((tool) => tool.name);
      expect(tools).toEqual(['verity_http_request', 'verity_secret_run']);
    });
  });

  // The two session tools are the only gateway tools NOT served by the shared executor:
  // `buildServer` intercepts them because they need its conductor and its session
  // projection. That interception is a seam, and a seam with no test through it is how the
  // 401 above survived. This is that test.
  it('answers the session tools from the server seam rather than the shared executor', async () => {
    const harness = build({ sessionTools: true });
    // The caller's Control identity is proved against the store, so the session the bearer
    // names has to exist there.
    await harness.store.createSession({
      sessionId: 'control-s1',
      worktree: process.cwd(),
      model: 'claude-opus-5',
    });
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await withInternalTcpListener(harness, async (port) => {
      const listed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'verity_list_sessions', arguments: {} },
      });
      expect(listed.status).toBe(200);
      const listedResult = JSON.parse(listed.body) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(listedResult.result.isError).toBeUndefined();
      // The tool's own answer, not a body that merely mentions the word: an empty fleet is a
      // valid listing, so the assertion is on the shape rather than on any entry.
      expect(JSON.parse(listedResult.result.content[0]!.text)).toEqual({
        sessions: expect.any(Array),
        // `omitted` travels with every listing, including an empty one: a caller that only
        // sometimes received it would have to guess whether zero means "nothing left out" or
        // "this server does not say", which is exactly the ambiguity the field exists to end.
        omitted: 0,
      });

      const handed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'verity_session_handoff',
          arguments: { target: { sessionId: 'no-such-session' }, title: 't', briefing: 'b' },
        },
      });
      // The tool's own refusal, which only the intercepted implementation can produce.
      expect(handed.body).toContain('does not exist or is not a Verity project session');

      // Neither call reached the executor that serves every other gateway tool.
      expect(harness.invocations).toEqual([]);
      // Both raised a card, and no standing grant may ever answer either one (ADR 0014 D2).
      expect(harness.approvals).toEqual([
        expect.objectContaining({ toolName: 'verity_list_sessions', allowStandingGrant: false }),
        expect.objectContaining({ toolName: 'verity_session_handoff', allowStandingGrant: false }),
      ]);
    });
  });

  // The path the feature exists for, through the real seam: the refusal above proves the
  // interception, not the delivery. This asserts the argument shape `buildServer` calls the
  // conductor with — which is the one thing a mocked `dispatchTurn` in the tool's own unit
  // test cannot check.
  it('delivers a handed-off briefing to a real project session through the conductor', async () => {
    const harness = build({ sessionTools: true });
    await harness.store.createProject({
      id: VERITY_CONTROL_PROJECT_ID,
      kind: 'control_plane',
      owner: 'verity',
      repo: 'control',
      containerName: 'verity-control',
      state: 'active',
    });
    await harness.store.createSession({
      sessionId: 'control-s1',
      // The caller's store record names the project its bearer claims, which is the branch a
      // live Control session takes. (The seam test above covers the legacy unbound one.)
      projectId: VERITY_CONTROL_PROJECT_ID,
      // Worktrees are unique per session, so the two here are distinct real directories.
      worktree: join(process.cwd(), 'packages'),
      model: 'claude-opus-5',
    });
    await harness.store.createProject({
      id: 'website',
      kind: 'local',
      owner: '__local__',
      repo: 'website',
      cloneDir: '__local__-website',
      containerName: 'verity-__local__--website',
      state: 'active',
    });
    await harness.store.createSession({
      sessionId: 'sess-web',
      projectId: 'website',
      // A real path, so the summary reports the session as resumable — an unresumable target
      // is refused, and would make this test pass for the wrong reason.
      worktree: process.cwd(),
      model: 'claude-opus-5',
    });
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await withInternalTcpListener(harness, async (port) => {
      const listed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'verity_list_sessions', arguments: {} },
      });
      const entries = JSON.parse(
        (JSON.parse(listed.body) as { result: { content: Array<{ text: string }> } }).result
          .content[0]!.text,
      ) as { sessions: Array<Record<string, unknown>> };
      // The control session itself is never listed, and the listing carries no `name`.
      expect(entries.sessions).toEqual([
        {
          sessionId: 'sess-web',
          projectId: 'website',
          project: '__local__/website',
          model: 'claude-opus-5',
          status: expect.any(String),
          resumable: true,
          eventCount: expect.any(Number),
          handoffEligible: true,
        },
      ]);

      const handed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'verity_session_handoff',
          arguments: {
            target: { sessionId: 'sess-web' },
            title: 'Overlay for the new site',
            briefing: 'Digest sha256:abc, port 8080.',
          },
        },
      });
      const result = JSON.parse(handed.body) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(result.result.isError).toBeUndefined();
      expect(JSON.parse(result.result.content[0]!.text)).toEqual({
        sessionId: 'sess-web',
        project: '__local__/website',
        // Whatever the conductor reported, relayed rather than assumed.
        queued: true,
        briefingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });

      expect(harness.dispatches).toHaveLength(1);
      const dispatched = harness.dispatches[0]!;
      expect(dispatched.sessionId).toBe('sess-web');
      // No turn options: a handoff carries no model override, no capability and no protected
      // environment. And no `requireStandalone`, so a busy target queues instead of refusing.
      expect(dispatched.turnOpts).toEqual({});
      expect(dispatched.prompt.startsWith(SESSION_HANDOFF_ENVELOPE)).toBe(true);
      expect(dispatched.prompt).toContain('Digest sha256:abc, port 8080.');
      expect(dispatched.dispatchOpts.displayPrompt).toBeDefined();
      expect(dispatched.dispatchOpts.displayPrompt).not.toBe(dispatched.prompt);
      expect(
        dispatched.dispatchOpts.displayPrompt!.startsWith(SESSION_HANDOFF_TRANSCRIPT_LABEL),
      ).toBe(true);

      // A handoff is not idempotent and this tool is served beside the gateway's executor
      // rather than inside it, so the at-most-once fence is the conductor's `clientReplyId`
      // memo (ADR 0008, exercised in conductor.test.ts). What has to hold HERE is that the
      // key identifies the call: a retry of the same JSON-RPC call keys the same, and a
      // second, deliberate handoff does not. The stub conductor does not memoize, which is
      // why both dispatches are visible to be compared.
      const repost = (id: number, briefing = 'Digest sha256:abc, port 8080.') =>
        postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'verity_session_handoff',
            arguments: {
              target: { sessionId: 'sess-web' },
              title: 'Overlay for the new site',
              briefing,
            },
          },
        });
      await repost(7);
      await repost(8);
      // Same id as the retry, different briefing. This is the half the JSON-RPC id cannot
      // carry: a client that reuses ids across a turn — or a caller that just sent the same
      // number twice — must not have its second, genuinely different handoff swallowed as a
      // duplicate of the first. The key varies because the request MAC is part of it.
      await repost(8, 'Digest sha256:def, port 9090.');
      const keys = harness.dispatches.map((entry) => entry.dispatchOpts.clientReplyId);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
      expect(keys[3]).not.toBe(keys[2]);
      expect(new Set(keys)).toHaveProperty('size', 3);
      // Namespaced and scoped to the calling turn, so a repeat from a later turn is delivered
      // rather than swallowed, and so it cannot collide with a mobile quick reply's id in the
      // target session's memo.
      expect(keys[0]).toMatch(/^handoff:control-t1:/u);
    });
  });

  // The audit split `ControlPlaneSessionAuthorityError` exists for, asserted where it is
  // actually written: a caller reaching for a tool it may not use must not be recorded the
  // way an outage is.
  it('records a caller whose session left the Control project as unauthenticated', async () => {
    const harness = build({ sessionTools: true });
    await harness.store.createProject({
      id: 'website',
      kind: 'local',
      owner: '__local__',
      repo: 'website',
      cloneDir: '__local__-website',
      containerName: 'verity-__local__--website',
      state: 'active',
    });
    // The bearer claims the Control project — the gateway proved that much — but the store
    // says this session belongs to a project of its own.
    await harness.store.createSession({
      sessionId: 'control-s1',
      projectId: 'website',
      worktree: process.cwd(),
      model: 'claude-opus-5',
    });
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await withInternalTcpListener(harness, async (port) => {
      const listed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'verity_list_sessions', arguments: {} },
      });
      expect(listed.body).toContain('is not a Verity Control session');
      const handed = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'verity_session_handoff',
          arguments: { target: { sessionId: 'x' }, title: 't', briefing: 'b' },
        },
      });
      expect(handed.body).toContain('is not a Verity Control session');
      expect(
        harness.records
          .filter((record) => record.kind === 'gateway_call_rejected')
          .map((record) => record.rejection),
      ).toEqual(['unauthenticated', 'unauthenticated']);
      // Refused before the card, not after it. Both calls default to `allow` here, so if the
      // authority check ran only inside the tool the operator would have been shown "Send
      // briefing to session x?", read the whole briefing, allowed it, and had the call refused
      // anyway for a reason their answer could not change. A card whose answer cannot matter
      // is the kind that teaches people to stop reading the ones that can.
      expect(harness.approvals).toEqual([]);
      // And the attempt is still in the trail: the refusal follows a recorded `received`, so a
      // crossing of the control-plane boundary is not silent just because it was early.
      expect(harness.records.map((record) => record.kind)).toEqual([
        'gateway_call_received',
        'gateway_call_rejected',
        'gateway_call_received',
        'gateway_call_rejected',
      ]);
    });
  });

  it('serves a tool call attributed to the control-plane session and turn', async () => {
    const harness = build();
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await withInternalTcpListener(harness, async (port) => {
      const res = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'verity_http_request',
          arguments: {
            method: 'GET',
            url: 'https://api.example.com/v1/things',
            secretAlias: 'EXAMPLE_TOKEN',
            auth: { header: 'authorization', scheme: 'Bearer' },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(harness.invocations).toEqual([
        {
          sessionId: 'control-s1',
          turnId: 'control-t1',
          toolName: 'verity_http_request',
          request: expect.objectContaining({ url: 'https://api.example.com/v1/things' }),
        },
      ]);
      // The card reaches the control-plane session, not some other one.
      expect(harness.approvals.map((approval) => approval.sessionId)).toEqual(['control-s1']);
    });
  });

  // Stating the project is only safe because the bearer still has to have been minted FOR it.
  // A project's own gateway bearer must not become a control-plane one by being replayed at
  // this path.
  it('refuses a bearer minted for a real project', async () => {
    const harness = build();
    const token = harness.tokens.issue({ projectId: 'p1', sessionId: 's1', turnId: 't1' });
    await withInternalTcpListener(harness, async (port) => {
      const res = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
      });
      expect(res.status).toBe(401);
      expect(harness.invocations).toEqual([]);
    });
  });

  it('refuses a request that presents no bearer', async () => {
    const harness = build();
    await withInternalTcpListener(harness, async (port) => {
      const res = await postTcp(port, '/internal/control-plane/mcp', undefined, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
      });
      expect(res.status).toBe(401);
    });
  });

  // The inverse of the project route's guard, tested where the route set cannot mask it: a
  // listener that stamps a project identity and imposes no allowlist, so the ONLY thing that
  // can answer 401 is the handler's own refusal. A Sandbox proves a project by the socket it
  // arrives on; if that same connection could also claim the control plane, the proof would
  // be worth nothing.
  it('refuses a connection that carries a project identity', async () => {
    const harness = build();
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await harness.app.ready();
    const server = createServer((req, res) => harness.app.routing(req, res));
    markInternalConnections(server, {
      projectId: 'p1',
      containerGeneration: 'generation-1',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
      });
      expect(res.status).toBe(401);
      expect(harness.invocations).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.app.close();
    }
  });

  // And the second, independent stop: the path is not in the project socket's route set at
  // all, so a relay-fronted Sandbox never even reaches the handler.
  it('refuses a connection that arrives on a project socket', async () => {
    const harness = build();
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    const dir = mkdtempSync(join(tmpdir(), 'verity-mcp-cp-'));
    await harness.app.ready();
    const listener = await startProjectInternalUnixListener(harness.app, {
      socketRoot: dir,
      identity: { projectId: 'p1', containerGeneration: 'generation-1' },
      ownerUid: TEST_UID,
      relayGid: TEST_GID,
    });
    try {
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
        const req = request(
          {
            socketPath: listener.socketPath,
            method: 'POST',
            path: '/internal/control-plane/mcp',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (res2) => {
            res2.resume();
            res2.on('end', () => resolve({ status: res2.statusCode ?? 0 }));
          },
        );
        req.once('error', reject);
        req.end(body);
      });
      // 404 from the socket's own route set — it never reaches the handler.
      expect(res.status).toBe(404);
      expect(harness.invocations).toEqual([]);
    } finally {
      await listener.close();
      await harness.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The per-turn gateway bearer is not an operator device token, so on any onboarded
  // deployment the operator bearer gate answers first unless the path is pre-auth
  // allowlisted. `/internal/mcp` is; the control-plane twin has to be too, or the fix works
  // only on a server nobody has onboarded.
  it('bypasses the operator bearer gate the way the project route does', async () => {
    const harness = build({ enforceAuth: true });
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    await withInternalTcpListener(harness, async (port) => {
      const res = await postTcp(port, '/internal/control-plane/mcp', `Bearer ${token}`, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/list',
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).result.tools).toHaveLength(1);
    });
  });

  it('keeps the control-plane path out of the project socket and relay route sets', () => {
    expect([...PROJECT_UDS_ROUTES]).not.toContain('POST /internal/control-plane/mcp');
    expect([...PROJECT_UDS_ROUTES]).not.toContain('GET /internal/control-plane/mcp');
  });

  // Same network-origin gate as every other `/internal/*` route: on the operator-facing,
  // LAN-publishable listener it must not exist, bearer or no bearer.
  it('does not exist on the operator-facing listener', async () => {
    const harness = build({ internalGuard: true });
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/internal/control-plane/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      });
      expect(res.statusCode).toBe(404);
      expect(harness.invocations).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  // The route GRANTS an identity rather than merely failing to find one, so it must refuse a
  // non-internal connection on its own rather than leaning on a guard a composition may leave
  // unwired. Same request as above without the gate: it now reaches the handler, and the
  // handler is what says no.
  it('fails closed off the internal listener even without the network-origin gate', async () => {
    const harness = build();
    const token = harness.tokens.issue({
      projectId: VERITY_CONTROL_PROJECT_ID,
      sessionId: 'control-s1',
      turnId: 'control-t1',
    });
    try {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/internal/control-plane/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      });
      expect(res.statusCode).toBe(401);
      expect(harness.invocations).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it('refuses the server-message stream with 405 rather than 404', async () => {
    const harness = build();
    await withInternalTcpListener(harness, async (port) => {
      const res = await getTcp(port, '/internal/control-plane/mcp');
      expect(res.status).toBe(405);
      expect(res.allow).toBe('POST');
    });
  });

  it('does not serve the route at all when no gateway is composed', async () => {
    const harness = build({ wire: false });
    await withInternalTcpListener(harness, async (port) => {
      const res = await postTcp(port, '/internal/control-plane/mcp', 'Bearer anything', {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/list',
      });
      expect(res.status).toBe(404);
    });
  });
});
