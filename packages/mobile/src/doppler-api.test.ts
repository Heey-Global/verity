import { describe, expect, it, vi } from 'vitest';
import { dopplerClient } from './doppler-api.js';

const connection = {
  id: 'conn/1',
  label: 'Example',
  hasToken: true,
  workplaceSlug: 'example',
  workplaceName: 'Example',
  createdAt: '2026-01-01',
  projectCount: 1,
};
const binding = {
  id: 'binding/1',
  connectionId: connection.id,
  connectionLabel: connection.label,
  dopplerProject: 'service',
  dopplerConfig: 'dev',
  isDefault: true,
  reference: 'service/dev',
  createdAt: connection.createdAt,
};

function setup() {
  const request = vi.fn<SessionRequest>();
  return { request, client: dopplerClient(request) };
}

type SessionRequest = Parameters<typeof dopplerClient>[0];

const body = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

describe('Doppler client', () => {
  it('lists, adds and updates instance connections', async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(Response.json({ connections: [connection] }))
      .mockResolvedValueOnce(Response.json(connection))
      .mockResolvedValueOnce(Response.json(connection));
    const input = { label: 'Example', token: 'synthetic-token' };
    const patch = { token: 'replacement-token', confirmTokenReplacement: true };

    await expect(client.listConnections()).resolves.toEqual([connection]);
    await expect(client.addConnection(input)).resolves.toEqual(connection);
    await expect(client.updateConnection(connection.id, patch)).resolves.toEqual(connection);
    expect(request.mock.calls).toEqual([
      ['/doppler/connections', { method: 'GET' }],
      ['/doppler/connections', body('POST', input)],
      ['/doppler/connections/conn%2F1', body('PATCH', patch)],
    ]);
  });

  it('deletes a connection using the binding IDs shown in its usage', async () => {
    const { client, request } = setup();
    const usage = {
      projects: [
        {
          projectId: 'project/1',
          projectName: 'Service',
          bindings: [
            { id: binding.id, dopplerProject: 'service', dopplerConfig: 'dev', isDefault: true },
          ],
        },
      ],
    };
    request
      .mockResolvedValueOnce(Response.json(usage))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const shown = await client.connectionUsage(connection.id);
    expect(shown).toEqual(usage);
    await client.removeConnection(
      connection.id,
      shown.projects.flatMap(({ bindings }) => bindings.map(({ id }) => id)),
    );
    expect(request.mock.calls).toEqual([
      ['/doppler/connections/conn%2F1/usage', { method: 'GET' }],
      ['/doppler/connections/conn%2F1', body('DELETE', { bindingIds: [binding.id] })],
    ]);
  });

  it('preserves connection revision and expected default when editing project bindings', async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(Response.json({ bindings: [binding] }))
      .mockResolvedValueOnce(Response.json(binding))
      .mockResolvedValueOnce(Response.json({ bindings: [binding] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const input = {
      connectionId: connection.id,
      dopplerProject: 'service',
      dopplerConfig: 'dev',
      connectionRevision: 'revision-1',
    };

    await expect(client.listBindings('project/1')).resolves.toEqual([binding]);
    await expect(client.addBinding('project/1', input)).resolves.toEqual(binding);
    await expect(client.setDefaultBinding('project/1', binding.id)).resolves.toEqual([binding]);
    await client.removeBinding('project/1', binding.id, true);
    const path = '/projects/project%2F1/doppler/bindings';
    expect(request.mock.calls).toEqual([
      [path, { method: 'GET' }],
      [path, body('POST', input)],
      [`${path}/binding%2F1`, body('PATCH', { isDefault: true })],
      [`${path}/binding%2F1`, body('DELETE', { isDefault: true })],
    ]);
  });

  it('targets one connection when updating a personal token', async () => {
    const { client, request } = setup();
    const status = { connections: [] };
    request
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(status))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(client.personalTokens('project/1')).resolves.toEqual(status);
    await expect(
      client.connectPersonalToken('project/1', connection.id, 'synthetic-token'),
    ).resolves.toEqual(status);
    await client.disconnectPersonalToken('project/1', connection.id);
    const path = '/projects/project%2F1/doppler/connection';
    expect(request.mock.calls).toEqual([
      [path, { method: 'GET' }],
      [path, body('PUT', { token: 'synthetic-token', connectionId: connection.id })],
      [`${path}?connectionId=conn%2F1`, { method: 'DELETE' }],
    ]);
  });
});
