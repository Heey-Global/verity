import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmbeddedMatrix, installEmbeddedMatrix } from './embedded-matrix.js';
import { notifyManagedMatrixConfigured } from './self-update/server-update-controller.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('./self-update/server-update-controller.js', () => ({
  notifyManagedMatrixConfigured: vi.fn(),
}));

type Context = Parameters<typeof createEmbeddedMatrix>[0];
const apps: FastifyInstance[] = [];
const configured = {
  endpoint: 'https://matrix.example',
  username: 'verity',
  passwordConfigured: true,
};
function fixture() {
  const summary = vi
    .fn<Context['integrations']['matrixConfigSummary']>()
    .mockResolvedValue(configured);
  return {
    summary,
    matrix: createEmbeddedMatrix({ integrations: { matrixConfigSummary: summary } }),
  };
}
function app() {
  const server = Fastify();
  apps.push(server);
  return server;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(notifyManagedMatrixConfigured).mockResolvedValue(false);
});
afterEach(async () => {
  for (const server of apps.splice(0)) await server.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('does not activate or schedule retries outside a managed deployment', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  const { matrix, summary } = fixture();
  expect(matrix.bindings).not.toHaveProperty('onMatrixConfigured');
  installEmbeddedMatrix(app(), matrix);
  await matrix.activateMatrixIfConfigured();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(summary).not.toHaveBeenCalled();
  expect(notifyManagedMatrixConfigured).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits for configuration, retries unavailable activation, and latches successful activation', async () => {
  const { matrix, summary } = fixture();
  summary.mockResolvedValueOnce(null);
  const server = app();
  installEmbeddedMatrix(server, matrix);
  await vi.advanceTimersByTimeAsync(0);
  expect(notifyManagedMatrixConfigured).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(notifyManagedMatrixConfigured).toHaveBeenCalledTimes(1);
  vi.mocked(notifyManagedMatrixConfigured).mockResolvedValue(true);
  await matrix.bindings.onMatrixConfigured!();
  const readsAtSuccess = summary.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(notifyManagedMatrixConfigured).toHaveBeenCalledTimes(2);
  expect(summary).toHaveBeenCalledTimes(readsAtSuccess);
  await server.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('logs failed background activation and retries without rejecting startup', async () => {
  const { matrix } = fixture();
  const failure = new Error('updater unavailable');
  vi.mocked(notifyManagedMatrixConfigured).mockRejectedValueOnce(failure);
  const server = app();
  const warn = vi.spyOn(server.log, 'warn');
  installEmbeddedMatrix(server, matrix);
  await vi.advanceTimersByTimeAsync(0);
  expect(warn).toHaveBeenCalledWith({ err: failure }, 'Matrix connector activation will retry');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(notifyManagedMatrixConfigured).toHaveBeenCalledTimes(2);
});

it('reads and trims the current connector token on every call', async () => {
  const { matrix } = fixture();
  const token = matrix.bindings.matrixConnectorToken;
  if (typeof token !== 'function') throw new Error('Expected token reader');
  vi.mocked(readFile).mockResolvedValueOnce(' first\n').mockResolvedValueOnce('second\n');
  expect(await token()).toBe('first');
  expect(await token()).toBe('second');
});

it('uses the environment only for a missing token file and propagates other errors', async () => {
  const { matrix } = fixture();
  const token = matrix.bindings.matrixConnectorToken;
  if (typeof token !== 'function') throw new Error('Expected token reader');
  vi.stubEnv('VERITY_MATRIX_CONNECTOR_TOKEN', 'fallback');
  vi.mocked(readFile).mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  expect(await token()).toBe('fallback');
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  vi.mocked(readFile).mockRejectedValueOnce(denied);
  await expect(token()).rejects.toBe(denied);
});
