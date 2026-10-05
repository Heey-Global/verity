import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { registerIntegrationRoutes } from './routes.js';

let ctx: TestDb;
let root: string;

beforeAll(async () => {
  ctx = await createTestDb();
  root = await mkdtemp(join(tmpdir(), 'verity-matrix-integration-'));
});
afterAll(async () => {
  await ctx.close();
  await rm(root, { recursive: true, force: true });
});

it('accepts a connector token provisioned after the server starts', async () => {
  let token: string | undefined;
  const app = Fastify();
  registerIntegrationRoutes(app, {
    store: ctx.store.integrations,
    connectorToken: async () => token,
  });
  await app.ready();
  const url = '/internal/integrations/matrix/config';
  const headers = { authorization: 'Bearer a-secret-long-enough-for-the-worker-route' };
  expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(401);
  token = 'a-secret-long-enough-for-the-worker-route';
  expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
  token = undefined;
  expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(401);
  await app.close();
});

it('requires an explicit project binding before accepting chat, then updates edited and deleted text', async () => {
  const app = Fastify();
  const extractImageText = vi.fn();
  registerIntegrationRoutes(app, {
    store: ctx.store.integrations,
    dataRoot: root,
    connectorToken: 'a-secret-long-enough-for-the-worker-route',
    extractImageText,
  });
  await app.ready();
  const authorization = { authorization: 'Bearer a-secret-long-enough-for-the-worker-route' };
  const accountId = '@verity:example.test';
  const sourceId = '!room:example.test';
  const account = await app.inject({
    method: 'POST',
    url: '/internal/integrations/matrix/account',
    headers: authorization,
    payload: {
      id: accountId,
      endpoint: 'https://matrix.example.test',
      displayName: 'Matrix',
      status: 'online',
    },
  });
  expect(account.statusCode).toBe(200);
  const discovered = await app.inject({
    method: 'POST',
    url: '/internal/integrations/matrix/source',
    headers: authorization,
    payload: { accountId, sourceId, displayName: 'Project chat' },
  });
  expect(discovered.statusCode).toBe(200);
  const bindingsUrl = `/internal/integrations/matrix/bindings?accountId=${encodeURIComponent(accountId)}`;
  const workerRooms = async () =>
    z
      .object({
        sources: z.array(
          z.object({ sourceId: z.string(), status: z.string(), projectId: z.string().nullable() }),
        ),
      })
      .parse(
        (await app.inject({ method: 'GET', url: bindingsUrl, headers: authorization })).json(),
      );
  expect((await workerRooms()).sources).toEqual([
    expect.objectContaining({ sourceId, status: 'pending' }),
  ]);
  const projectId = randomUUID();
  await ctx.store.upsertProject({
    id: projectId,
    owner: 'example',
    repo: 'matrix',
    containerName: `matrix-${projectId}`,
    state: 'absent',
  });
  const base = {
    accountId,
    sourceId,
    sender: '@person:example.test',
    occurredAt: new Date(Date.now() + 10_000).toISOString(),
  };
  const message = {
    ...base,
    eventId: '$message',
    targetEventId: null,
    kind: 'message',
    body: 'Original plan',
  };
  const send = async (payload: object, headers: Record<string, string> = authorization) =>
    app.inject({ method: 'POST', url: '/internal/integrations/matrix/event', headers, payload });
  expect((await send(message)).statusCode).toBe(409);
  expect((await send(message, { authorization: 'Bearer wrong' })).statusCode).toBe(401);

  const bound = await app.inject({
    method: 'POST',
    url: '/integrations/sources/bind',
    payload: { accountId, sourceId, projectId },
  });
  expect(bound.statusCode).toBe(200);
  const attachment = {
    event: { ...base, eventId: '$file', targetEventId: null, kind: 'message', body: 'Attachment' },
    fileName: '../notes.txt',
    data: Buffer.from('Meeting notes from Matrix').toString('base64'),
  };
  const sendAttachment = (payload: object, headers: Record<string, string> = authorization) =>
    app.inject({
      method: 'POST',
      url: '/internal/integrations/matrix/attachment',
      headers,
      payload,
    });
  expect((await sendAttachment(attachment, { authorization: 'Bearer wrong' })).statusCode).toBe(
    401,
  );
  expect((await sendAttachment({ ...attachment, data: 'not base64' })).statusCode).toBe(400);
  expect((await sendAttachment({ ...attachment, data: '' })).statusCode).toBe(400);
  const tooLarge = await sendAttachment({
    ...attachment,
    data: Buffer.alloc(50 * 1024 * 1024 + 1).toString('base64'),
  });
  expect(tooLarge.statusCode, tooLarge.body).toBe(413);
  const imported = await sendAttachment(attachment);
  expect(imported.statusCode).toBe(200);
  const attachmentPath = z.object({ path: z.string() }).parse(imported.json()).path;
  expect(attachmentPath).toMatch(
    /^sources\/documents\/matrix\/[a-f0-9]+\/attachments\/[a-f0-9]+-notes\.txt$/u,
  );
  const attachmentRoot = join(root, 'knowledge', projectId);
  // Without this hand-off, images import fine and their text silently never appears.
  expect(extractImageText).toHaveBeenCalledWith({
    projectId,
    root: attachmentRoot,
    relativePath: attachmentPath,
    bytes: Buffer.from(attachment.data, 'base64'),
  });
  expect(await readFile(join(attachmentRoot, attachmentPath), 'utf8')).toBe(
    'Meeting notes from Matrix',
  );
  expect(await readFile(join(attachmentRoot, '.text', `${attachmentPath}.md`), 'utf8')).toContain(
    `Source: ${attachmentPath}`,
  );
  expect((await sendAttachment(attachment)).json()).toMatchObject({
    accepted: false,
    path: attachmentPath,
  });
  const document = await sendAttachment({
    ...attachment,
    event: { ...attachment.event, eventId: '$document' },
    fileName: 'meeting.docx',
    data: Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8(
          '<w:document xmlns:w="w"><w:p><w:r><w:t>Matrix project notes</w:t></w:r></w:p></w:document>',
        ),
      }),
    ).toString('base64'),
  });
  expect(document.statusCode).toBe(200);
  const documentPath = z.object({ path: z.string() }).parse(document.json()).path;
  expect(await readFile(join(attachmentRoot, '.text', `${documentPath}.md`), 'utf8')).toContain(
    'Matrix project notes',
  );
  const largerAttachment = await sendAttachment({
    ...attachment,
    event: { ...attachment.event, eventId: '$larger-attachment' },
    fileName: 'archive.bin',
    data: Buffer.alloc(11 * 1024 * 1024, 65).toString('base64'),
  });
  expect(largerAttachment.statusCode).toBe(200);
  const largerPath = z.object({ path: z.string() }).parse(largerAttachment.json()).path;
  expect((await readFile(join(attachmentRoot, largerPath))).length).toBe(11 * 1024 * 1024);
  expect(await readFile(join(attachmentRoot, '.text', `${largerPath}.md`), 'utf8')).toContain(
    'Extraction skipped',
  );
  expect((await send(message)).statusCode).toBe(200);
  expect((await send(message)).json()).toEqual({ accepted: false });
  const edit = {
    ...base,
    eventId: '$edit',
    targetEventId: '$message',
    kind: 'edit',
    body: 'Revised plan',
  };
  expect((await send(edit)).statusCode).toBe(200);
  const source = (
    await app.inject({ method: 'GET', url: `/projects/${projectId}/integrations` })
  ).json().sources[0];
  expect(source.status).toBe('active');
  const path = join(root, 'knowledge', projectId, 'sources', 'documents', 'matrix');
  const { readdir } = await import('node:fs/promises');
  const [roomDir] = await readdir(path);
  const [dayFile] = await readdir(join(path, roomDir!));
  const file = join(path, roomDir!, dayFile!);
  expect(await readFile(file, 'utf8')).toContain('Revised plan');
  expect(await readFile(file, 'utf8')).toContain('Attachment: sources/documents/matrix/');
  expect(await readFile(file, 'utf8')).not.toContain('Original plan');
  const redaction = {
    ...base,
    eventId: '$redaction',
    targetEventId: '$message',
    kind: 'redaction',
    body: null,
  };
  expect((await send(redaction)).statusCode).toBe(200);
  expect(await readFile(file, 'utf8')).toContain('[Message deleted]');
  expect(await readFile(file, 'utf8')).not.toContain('Revised plan');
  expect(
    (
      await send({
        ...redaction,
        eventId: '$file-redaction',
        targetEventId: '$file',
      })
    ).statusCode,
  ).toBe(200);
  await expect(readFile(join(attachmentRoot, attachmentPath))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(join(attachmentRoot, '.text', `${attachmentPath}.md`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await sendAttachment(attachment)).json()).toMatchObject({ accepted: false });
  await expect(readFile(join(attachmentRoot, attachmentPath))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const disconnected = await app.inject({
    method: 'POST',
    url: '/integrations/sources/disconnect',
    payload: { accountId, sourceId },
  });
  expect(disconnected.statusCode).toBe(200);
  expect(
    (
      await sendAttachment({
        ...attachment,
        event: { ...attachment.event, eventId: '$after-disconnect' },
      })
    ).statusCode,
  ).toBe(409);
  expect((await workerRooms()).sources).toEqual([
    expect.objectContaining({ sourceId, status: 'pending', projectId: null }),
  ]);
  expect(
    (await app.inject({ method: 'GET', url: `/projects/${projectId}/integrations` })).json()
      .sources,
  ).toEqual([]);
  expect(await readFile(file, 'utf8')).toContain('[Message deleted]');
  await app.close();
});

it('stores Matrix configuration globally, redacts its settings response, and limits worker access', async () => {
  const app = Fastify();
  const onMatrixConfigured = vi.fn(async () => undefined);
  registerIntegrationRoutes(app, {
    store: ctx.store.integrations,
    connectorToken: 'a-secret-long-enough-for-the-worker-route',
    onMatrixConfigured,
  });
  await app.ready();
  const path = '/integrations/matrix/config';
  const payload = {
    endpoint: 'https://matrix.example.test',
    username: '@verity:example.test',
    password: 'private-password',
  };
  expect((await app.inject({ method: 'PUT', url: path, payload })).statusCode).toBe(200);
  await vi.waitFor(() => expect(onMatrixConfigured).toHaveBeenCalledOnce());
  const summary = await app.inject({ method: 'GET', url: path });
  expect(summary.json()).toEqual({
    config: { endpoint: payload.endpoint, username: payload.username, passwordConfigured: true },
  });
  expect(summary.body).not.toContain(payload.password);
  expect(
    (await app.inject({ method: 'GET', url: '/projects/example/integrations/matrix/config' }))
      .statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ method: 'GET', url: '/internal/integrations/matrix/config' })).statusCode,
  ).toBe(401);
  const worker = await app.inject({
    method: 'GET',
    url: '/internal/integrations/matrix/config',
    headers: { authorization: 'Bearer a-secret-long-enough-for-the-worker-route' },
  });
  expect(worker.json()).toEqual({ config: payload });
  await app.close();
});

it('keeps safe failed import evidence on its room and clears it only with a new worker snapshot', async () => {
  const app = Fastify();
  const token = 'a-secret-long-enough-for-the-worker-route';
  registerIntegrationRoutes(app, {
    store: ctx.store.integrations,
    connectorToken: token,
    dataRoot: root,
  });
  const headers = { authorization: `Bearer ${token}` };
  const id = `@diagnostics-${randomUUID()}:example.test`;
  const sourceId = '!diagnostics:example.test';
  const payload = {
    id,
    endpoint: 'https://matrix.example.test',
    displayName: 'Matrix',
    status: 'online',
  };
  const url = '/internal/integrations/matrix/account';
  await app.inject({ method: 'POST', url, headers, payload });
  await ctx.store.integrations.discoverSource({ accountId: id, sourceId, displayName: 'Room' });
  const projectId = randomUUID();
  await ctx.store.upsertProject({
    id: projectId,
    owner: 'example',
    repo: 'diagnostics-test',
    containerName: `diagnostics-${projectId}`,
    state: 'absent',
  });
  await ctx.store.integrations.setSourceBinding(id, sourceId, projectId);
  const rejected = await app.inject({
    method: 'POST',
    url: '/internal/integrations/matrix/event',
    headers,
    payload: {
      accountId: id,
      sourceId,
      eventId: '$edit',
      targetEventId: '$missing',
      kind: 'edit',
      sender: '@sender:example.test',
      occurredAt: new Date().toISOString(),
      body: 'private message',
    },
  });
  expect(rejected.statusCode).toBe(422);
  expect(rejected.json()).toEqual({
    error: 'Target message not found',
    code: 'target_message_not_found',
  });
  const diagnostic = {
    sourceId,
    eventId: '$failed',
    occurredAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    attempts: 2,
    httpStatus: 422,
    code: 'target_message_not_found',
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...payload, importDiagnostics: [{ ...diagnostic, error: 'private message' }] },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...payload, importDiagnostics: [diagnostic], importFailureCount: 21 },
      })
    ).statusCode,
  ).toBe(200);
  const read = async () =>
    (await ctx.store.integrations.listSources()).find((item) => item.accountId === id)
      ?.importDiagnostics;
  expect(await read()).toEqual([diagnostic]);
  expect(
    (await ctx.store.integrations.listSources()).find((item) => item.accountId === id)
      ?.importDiagnosticsTruncated,
  ).toBe(true);
  expect(
    (await ctx.store.integrations.listSources()).find((item) => item.accountId === id)
      ?.importDiagnosticsReportedAt,
  ).toBeInstanceOf(Date);
  await app.inject({ method: 'POST', url, headers, payload });
  expect(await read()).toEqual([diagnostic]);
  expect(
    (await app.inject({ method: 'POST', url, payload: { ...payload, importDiagnostics: [] } }))
      .statusCode,
  ).toBe(401);
  expect(await read()).toEqual([diagnostic]);
  await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { ...payload, importDiagnostics: [] },
  });
  expect(await read()).toEqual([]);
  expect(
    (await ctx.store.integrations.listSources()).find((item) => item.accountId === id)
      ?.importDiagnosticsTruncated,
  ).toBe(false);
  await app.close();
});

it('persists early redactions across retries and applies them to late text and attachments', async () => {
  const accountId = `@deferred-${randomUUID()}:example.test`;
  const sourceId = '!deferred:example.test';
  const projectId = randomUUID();
  const store = ctx.store.integrations;
  await store.upsertAccount({
    id: accountId,
    provider: 'matrix',
    endpoint: 'https://example.test',
    displayName: 'Matrix',
    status: 'online',
  });
  await ctx.store.upsertProject({
    id: projectId,
    owner: 'example',
    repo: 'deferred',
    containerName: `deferred-${projectId}`,
    state: 'absent',
  });
  await store.discoverSource({ accountId, sourceId, displayName: 'Deferred room' });
  await store.setSourceBinding(accountId, sourceId, projectId);
  const token = 'a-secret-long-enough-for-the-worker-route';
  const createApp = () => {
    const app = Fastify();
    registerIntegrationRoutes(app, { store, dataRoot: root, connectorToken: token });
    return app;
  };
  let app = createApp();
  const headers = { authorization: `Bearer ${token}` };
  const occurredAt = new Date(Date.now() + 10_000).toISOString();
  const base = { accountId, sourceId, sender: '@sender:example.test', occurredAt };
  const send = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/internal/integrations/matrix/event',
      headers,
      payload,
    });
  const redaction = {
    ...base,
    eventId: '$early-delete',
    targetEventId: '$late-text',
    kind: 'redaction',
    body: null,
    occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  try {
    expect((await send(redaction)).json()).toEqual({ accepted: true });
    expect(await store.getEvent(accountId, sourceId, redaction.eventId)).toMatchObject({
      kind: 'redaction',
      targetEventId: '$late-text',
      body: null,
    });
    await app.close();
    app = createApp();
    expect((await send(redaction)).json()).toEqual({ accepted: false });
    expect(await store.listChangesForTargets(accountId, sourceId, ['$late-text'])).toHaveLength(1);
    const message = {
      ...base,
      eventId: '$late-text',
      targetEventId: null,
      kind: 'message',
      body: 'Deleted private text',
    };
    expect((await send(message)).json()).toEqual({ accepted: true });
    expect((await send(message)).json()).toEqual({ accepted: false });
    expect(await store.getEvent(accountId, sourceId, message.eventId)).not.toBeNull();
    const { projectChatDay } = await import('./knowledge-projection.js');
    const binding = (await store.listSources(projectId))[0]!;
    const relative = await projectChatDay(store, root, {
      accountId,
      sourceId,
      projectId,
      displayName: binding.displayName,
      activatedAt: binding.activatedAt!,
      day: occurredAt.slice(0, 10),
    });
    const knowledgeRoot = join(root, 'knowledge', projectId);
    const text = await readFile(join(knowledgeRoot, relative), 'utf8');
    expect(text).toContain('[Message deleted]');
    expect(text).not.toContain(message.body);
    expect(text.match(/## /gu)).toHaveLength(1);
    expect(
      (
        await send({ ...redaction, eventId: '$early-file-delete', targetEventId: '$late-file' })
      ).json(),
    ).toEqual({ accepted: true });
    const attachment = {
      event: {
        ...base,
        eventId: '$late-file',
        targetEventId: null,
        kind: 'message',
        body: 'Attachment',
      },
      fileName: 'secret.txt',
      data: Buffer.from('Deleted attachment contents').toString('base64'),
    };
    for (const accepted of [true, false]) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/integrations/matrix/attachment',
        headers,
        payload: attachment,
      });
      expect(response.statusCode).toBe(200);
      const result = response.json<{ accepted: boolean; path: string }>();
      expect(result.accepted).toBe(accepted);
      await expect(readFile(join(knowledgeRoot, result.path))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(join(knowledgeRoot, '.text', `${result.path}.md`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await store.getEvent(accountId, sourceId, '$late-file')).not.toBeNull();
    const projected = await readFile(join(knowledgeRoot, relative), 'utf8');
    expect(projected.match(/\[Message deleted\]/gu)).toHaveLength(2);
    expect(projected).not.toContain('Attachment:');
  } finally {
    await app.close();
  }
});

it('hides explicitly left rooms while preserving bindings, history and worker outbox retention', async () => {
  const store = ctx.store.integrations;
  const accountId = `@left-${randomUUID()}:example.test`;
  const sourceId = '!left:example.test';
  const projectId = randomUUID();
  await store.upsertAccount({
    id: accountId,
    provider: 'matrix',
    endpoint: 'https://example.test',
    displayName: 'Matrix',
    status: 'online',
  });
  await ctx.store.upsertProject({
    id: projectId,
    owner: 'example',
    repo: 'left',
    containerName: `left-${projectId}`,
    state: 'absent',
  });
  await store.discoverSource({ accountId, sourceId, displayName: 'Room' });
  const binding = await store.setSourceBinding(accountId, sourceId, projectId);
  const event = {
    accountId,
    sourceId,
    eventId: '$retained',
    targetEventId: null,
    kind: 'message' as const,
    sender: '@sender:example.test',
    occurredAt: new Date(Date.now() + 10_000),
    body: 'Retained history',
  };
  await store.ingestEvent(event);
  const token = 'a-secret-long-enough-for-the-worker-route';
  const app = Fastify();
  registerIntegrationRoutes(app, { store, dataRoot: root, connectorToken: token });
  const headers = { authorization: `Bearer ${token}` };
  const url = '/internal/integrations/matrix/source/left';
  const payload = { accountId, sourceId };
  const workerRooms = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/internal/integrations/matrix/bindings?accountId=${encodeURIComponent(accountId)}`,
        headers,
      })
    ).json<{
      sources: { sourceId: string; status: string; projectId: string; activatedAt: string }[];
    }>().sources;
  try {
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await store.listSources(projectId)).map((item) => item.sourceId)).toContain(sourceId);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
    }
    expect(await store.listSources(projectId)).toEqual([]);
    expect((await store.listSources()).some((item) => item.sourceId === sourceId)).toBe(false);
    // An absent worker binding deletes its outbox entries; left bindings must stay present.
    expect(await workerRooms()).toEqual([
      expect.objectContaining({
        sourceId,
        status: 'left',
        projectId,
        activatedAt: binding!.activatedAt!.toISOString(),
      }),
    ]);
    expect(await store.getEvent(accountId, sourceId, event.eventId)).toMatchObject({
      eventId: event.eventId,
      body: event.body,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/integrations/matrix/event',
          headers,
          payload: { ...event, occurredAt: event.occurredAt.toISOString(), eventId: '$pending' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/integrations/matrix/source',
          headers,
          payload: { ...payload, displayName: 'Invited again' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await store.listSources(projectId))[0]).toMatchObject({
      status: 'paused',
      projectId,
      activatedAt: binding!.activatedAt,
    });
    expect(await store.getEvent(accountId, sourceId, event.eventId)).not.toBeNull();
  } finally {
    await app.close();
  }
});
