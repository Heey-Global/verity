import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('third-party notices', () => {
  it('match the committed dependency lock', async () => {
    await expect(
      execFileAsync('node', ['scripts/third-party-notices.ts', '--check']),
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('rejects unsupported modes', async () => {
    await expect(execFileAsync('node', ['scripts/third-party-notices.ts'])).rejects.toMatchObject({
      stderr: expect.stringContaining('usage: third-party-notices.ts --check | --write'),
    });
  });
});
