import { describe, expect, it } from 'vitest';
import { followGitHubOrigin } from './clone-origin.js';

function git(origin: string | undefined) {
  const calls: string[] = [];
  const run = (args: readonly string[]) => {
    calls.push(args.join(' '));
    if (args.includes('get-url')) {
      if (origin === undefined) return Promise.reject(new Error('No such remote'));
      return Promise.resolve({ stdout: `${origin}\n`, stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { run, calls };
}

const url = 'https://github.com/heey-global/ocr-engine';

describe('followGitHubOrigin', () => {
  it('moves an origin that still names the old GitHub repository', async () => {
    const fake = git('https://github.com/heey-global/deep-ocr.git');
    await followGitHubOrigin(fake.run, '/clone', url);
    expect(fake.calls).toContain(`-C /clone remote set-url origin ${url}`);
  });

  it.each([
    ['the same repository', 'https://github.com/Heey-Global/OCR-Engine.git/'],
    ['a local path', '/srv/fixtures/origin.git'],
    ['another host', 'https://forge.example/heey-global/deep-ocr'],
    ['no origin', undefined],
  ])('leaves %s alone', async (_, origin) => {
    const fake = git(origin);
    await followGitHubOrigin(fake.run, '/clone', url);
    expect(fake.calls.some((call) => call.includes('set-url'))).toBe(false);
  });

  it('does nothing for a target outside GitHub', async () => {
    const fake = git('https://github.com/heey-global/deep-ocr');
    await followGitHubOrigin(fake.run, '/clone', 'https://forge.example/a/b');
    expect(fake.calls).toEqual([]);
  });
});
