import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runSecretWorkerMain, SECRET_JOB_PILOT_PATH } from './secret-worker-main.js';

describe('secret worker OS entrypoint', () => {
  it('pins the pilot executable and fails closed when stdin ends before a challenge', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const createRunner = vi.fn(() => () => Promise.resolve({ chunks: [], exitCode: 0 }));
    let diagnostic = '';
    errorOutput.on('data', (chunk: Buffer) => (diagnostic += chunk.toString('utf8')));
    input.end();

    await expect(runSecretWorkerMain({ input, output, errorOutput, createRunner })).resolves.toBe(
      1,
    );
    expect(createRunner).toHaveBeenCalledWith(SECRET_JOB_PILOT_PATH);
    expect(SECRET_JOB_PILOT_PATH).toBe('/usr/local/bin/verity-secret-job-pilot');
    expect(diagnostic).toBe('verity secret-job worker failed closed\n');
  });
});
