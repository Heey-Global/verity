import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireRuntimeAdmissionLease } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { cacheHelperCommand, cacheHelperFailureReason } from './runner-cache-helper.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cache-helper-'));
  await chmod(root, 0o770);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function launch(module: string, input = JSON.stringify({ sessionIds: [], maxBytes: 4096 })) {
  const command = cacheHelperCommand.replace('/usr/local/bin/verity-agent-spawn-broker', module);
  return new Promise<{ code: string | number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ['-e', command],
      {
        timeout: 5000,
        maxBuffer: 128 * 1024,
        env: {
          ...process.env,
          VERITY_CACHE_MAINTENANCE_REQUEST: input,
          VERITY_RUNNER_RUNTIME: root,
          VERITY_AGENT_UID: String(process.getuid!()),
          VERITY_AGENT_GID: String(process.getgid!()),
          VERITY_RUNNER_RUNTIME_UID: String(process.getuid!()),
          VERITY_RUNNER_RUNTIME_GID: String(process.getgid!()),
        },
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}
async function broker(source: string) {
  const path = join(root, 'broker.mjs');
  await writeFile(path, source);
  return pathToFileURL(path).href;
}
const realBroker = new URL(
  '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs',
  import.meta.url,
).href;

describe('cache helper process', () => {
  it('calls the export in the launched process with the runtime identity and request', async () => {
    const module = await broker(
      'export async function reclaimPackageCachesOffline(request, options) { return { request, options, parent: process.ppid }; }',
    );
    const result = await launch(module);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      report: {
        request: { sessionIds: [], maxBytes: 4096 },
        options: {
          runtimeDir: root,
          agentUid: process.getuid!(),
          agentGid: process.getgid!(),
          runnerUid: process.getuid!(),
          runnerGid: process.getgid!(),
        },
        parent: process.pid,
      },
    });
  });
  it('executes the actual offline broker and releases admission after completion', async () => {
    const result = await launch(realBroker);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, report: { removedBytes: 0 } });
    const lease = await acquireRuntimeAdmissionLease(
      { runtimeDir: root, agentUid: process.getuid!(), agentGid: process.getgid!() },
      true,
    );
    await lease.close();
  });
  it('keeps the actual broker admission refusal intact', async () => {
    const lease = await acquireRuntimeAdmissionLease({
      runtimeDir: root,
      agentUid: process.getuid!(),
      agentGid: process.getgid!(),
    });
    try {
      const result = await launch(realBroker);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, code: 'runtime-busy' });
    } finally {
      await lease.close();
    }
  });
  it.each([
    ['export const legacy = true;', 78, 'broker-unsupported'],
    ["throw new Error('/private/secret');", 78, 'broker-import-failed'],
    [
      "export function reclaimPackageCachesOffline() { throw Object.assign(new Error('/private/secret'), {code: 'ENOMEM'}); }",
      1,
      'resource-unavailable',
    ],
    [
      "export function reclaimPackageCachesOffline() { throw new Error('/private/secret'); }",
      1,
      'maintenance-failed',
    ],
    [
      "export function reclaimPackageCachesOffline() { return 'x'.repeat(65536); }",
      1,
      'invalid-response',
    ],
  ])('reports bounded failure for %s', async (source, code, reason) => {
    const result = await launch(await broker(source));
    expect(result).toEqual({
      code,
      stdout: JSON.stringify({ ok: false, code: reason }),
      stderr: '',
    });
  });
  it.each([
    'malformed',
    'null',
    '{}',
    '{"sessionIds":[],"maxBytes":0}',
    JSON.stringify({ sessionIds: Array(513).fill('session'), maxBytes: 1 }),
    ' '.repeat(96 * 1024 + 1),
  ])('rejects invalid input before invoking maintenance %#', async (input) => {
    const module = await broker(
      "export function reclaimPackageCachesOffline() { process.stderr.write('must not run'); }",
    );
    const result = await launch(module, input);
    expect(result).toEqual({
      code: 1,
      stdout: '{"ok":false,"code":"invalid-request"}',
      stderr: '',
    });
  });
});

describe('bounded helper diagnostics', () => {
  it('recognizes the pre-Node tini allocation failure', () => {
    expect(
      cacheHelperFailureReason('[FATAL tini (2)] exec timeout failed: Cannot allocate memory\n', 2),
    ).toBe('resource-unavailable');
  });
  it('recognizes timeout without interpreting SIGKILL as proof of OOM', () => {
    expect(cacheHelperFailureReason('', 124)).toBe('helper-timeout');
    expect(cacheHelperFailureReason('', 137)).toBe('unknown');
  });
  it.each(['private secret', '{"ok":false,"code":"/private/secret"}', 'x'.repeat(65537)])(
    'withholds unknown or oversized output %#',
    (output) => {
      expect(cacheHelperFailureReason(output, 2)).toBe('unknown');
    },
  );
});
