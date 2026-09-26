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
