import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { render, type PackageLock } from './third-party-notices.js';

const execFileAsync = promisify(execFile);

describe('third-party notices', () => {
  it('does not become stale for a version-only dependency update', () => {
    const lock = (version: string): PackageLock => ({
      packages: {
        'node_modules/example': {
          version,
          license: 'MIT',
          resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
        },
      },
    });

    expect(render(lock('1.0.0'))).toBe(render(lock('1.0.1')));
  });

  it('uses the installed package identity for npm aliases', () => {
    const notice = render({
      packages: {
        'node_modules/@jest/react-is-18': {
          name: 'react-is',
          version: '18.3.1',
          license: 'MIT',
        },
      },
    });

    expect(notice).toContain('| react-is | MIT |');
    expect(notice).toContain('https://www.npmjs.com/package/react-is');
    expect(notice).not.toContain('https://www.npmjs.com/package/%40jest%2Freact-is-18');
  });

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
