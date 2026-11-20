import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from './server-context.js';

export function installRemoteControl(app: FastifyInstance, ctx: ServerContext): void {
  const { deps, lifecycle } = ctx;
  const authorizeReturnPath = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (!request.localUserId) {
      reply.code(404).send({ error: 'not found' });
      return false;
    }
    if (!(await deps.eventStore.isActiveAdministrator(request.localUserId))) {
      reply.code(403).send({ error: 'administrator required' });
      return false;
    }
    if (!deps.returnPathActivation) {
      reply.code(503).send({ error: 'diagnostics unavailable' });
      return false;
    }
    return true;
  };
  app.get('/api/remote-control/diagnostics', async (request, reply) => {
    if (!(await authorizeReturnPath(request, reply))) return;
    return deps.returnPathActivation!.status(deps.returnPathConnectorCount?.() ?? 0);
  });
  app.post('/api/remote-control/diagnostics', async (request, reply) => {
    if (!(await authorizeReturnPath(request, reply))) return;
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).length !== 1 ||
      typeof body.expiresAt !== 'string'
    )
      return reply.code(400).send({ error: 'absolute expiry required' });
    try {
      deps.returnPathActivation!.start(body.expiresAt);
      return deps.returnPathActivation!.status(deps.returnPathConnectorCount?.() ?? 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = ['invalid_expiry', 'already_active', 'remote_unavailable'].includes(message)
        ? message
        : 'diagnostics_unavailable';
      return reply
        .code(reason === 'already_active' ? 409 : reason === 'remote_unavailable' ? 503 : 400)
        .send({ error: reason });
    }
  });
  app.delete('/api/remote-control/diagnostics', async (request, reply) => {
    if (!(await authorizeReturnPath(request, reply))) return;
    deps.returnPathActivation!.stop();
    return deps.returnPathActivation!.status();
  });
  lifecycle.onClose(() => {
    deps.returnPathActivation?.dispose();
  });
  const recordingRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (
      manager: import('./coordinated-recording.js').CoordinatedRecordingManager,
    ) => unknown,
  ): Promise<unknown> => {
    if (!(await authorizeReturnPath(request, reply))) return;
    if (!deps.coordinatedRecording)
      return reply.code(503).send({ error: 'recordings_unavailable' });
    try {
      return await operation(deps.coordinatedRecording);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reasons = [
        'invalid_recording',
        'recording_conflict',
        'recording_capacity',
        'recording_not_found',
        'remote_unavailable',
      ];
      const reason = reasons.includes(message) ? message : 'recording_failed';
      const code =
        reason === 'recording_not_found'
          ? 404
          : reason === 'invalid_recording'
            ? 400
            : reason === 'recording_conflict' || reason === 'recording_capacity'
              ? 409
              : 503;
      return reply.code(code).send({ error: reason });
    }
  };
  app.post('/api/remote-control/recordings', async (request, reply) =>
    recordingRequest(request, reply, (manager) => {
      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) => !['runId', 'durationMs', 'diagnosticsVersion', 'targetSessionId'].includes(key),
        ) ||
        (body.diagnosticsVersion !== undefined &&
          body.diagnosticsVersion !== 1 &&
          body.diagnosticsVersion !== 2 &&
          body.diagnosticsVersion !== 3) ||
        typeof body.runId !== 'string' ||
        typeof body.durationMs !== 'number' ||
        (body.targetSessionId !== undefined && typeof body.targetSessionId !== 'string')
      )
        throw new Error('invalid_recording');
      return manager.start(
        body.runId,
        body.durationMs,
        body.diagnosticsVersion,
        body.targetSessionId,
      );
    }),
  );
  app.get('/api/remote-control/recordings/:runId', async (request, reply) =>
    recordingRequest(request, reply, (manager) =>
      manager.refreshStatus((request.params as { runId: string }).runId),
    ),
  );
  app.get('/api/remote-control/recordings/:runId/selection', async (request, reply) =>
    recordingRequest(request, reply, (manager) =>
      manager.selectedStatus((request.params as { runId: string }).runId),
    ),
  );
  app.delete('/api/remote-control/recordings/:runId', async (request, reply) =>
    recordingRequest(request, reply, (manager) =>
      manager.stop((request.params as { runId: string }).runId),
    ),
  );
  app.get('/api/remote-control/recordings/:runId/export', async (request, reply) =>
    recordingRequest(request, reply, (manager) =>
      manager.export(
        (request.params as { runId: string }).runId,
        request.headers['x-verity-recording-failure-details'] === '1',
      ),
    ),
  );
  lifecycle.onClose(() => {
    deps.coordinatedRecording?.dispose();
  });
  app.get('/api/remote-control/descriptor', async (request, reply) => {
    // This route is only for an authenticated paired device. Headless deployments
    // can run without the global bearer gate, but have no paired device to serve.
    if (request.localUserId === undefined) return reply.code(404).send({ error: 'not found' });
    return deps.remoteControlDescriptor?.() ?? { version: 1, enabled: false, reason: 'disabled' };
  });
  app.post('/api/uplink/check', async (request, reply) => {
    if (request.localUserId === undefined || !deps.recheckUplink)
      return reply.code(404).send({ error: 'not found' });
    try {
      return await deps.recheckUplink();
    } catch {
      return reply.code(503).send({ error: 'Uplink rights check failed' });
    }
  });
  app.get('/api/uplink/diagnostics', async (request, reply) => {
    if (request.localUserId === undefined) return reply.code(404).send({ error: 'not found' });
    return (
      deps.uplinkDiagnostics?.() ?? {
        control: 'disabled',
        sharing: 'unavailable',
        remoteControl: 'unavailable',
      }
    );
  });
}
