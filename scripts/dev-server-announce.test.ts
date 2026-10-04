import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function run(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'verity-announce-'));
  directories.push(root);
  const invoke = () =>
    execFileSync(process.execPath, [resolve('agent-seed/bin/verity-dev-server'), ...args], {
      env: { ...process.env, VERITY_DEV_SERVER_STATE_DIR: root, VERITY_SESSION_ID: 'session-1' },
      stdio: 'pipe',
    });
  return { root, invoke };
}
describe('development listener announcement', () => {
  it('writes a label and scan request without creating a share', () => {
    const { root, invoke } = run(['announce', '--port', '5173', '--name', 'Storybook']);
    invoke();
    expect(JSON.parse(readFileSync(join(root, 'announcements/5173.json'), 'utf8'))).toMatchObject({
      port: 5173,
      name: 'Storybook',
      sessionId: 'session-1',
    });
    expect(Number(readFileSync(join(root, 'scan-request'), 'utf8'))).toBeGreaterThan(0);
  });
  it.each([
    ['announce', '--port', '0', '--name', 'app'],
    ['announce', '--port', '../1', '--name', 'app'],
    ['announce', '--port', '5173'],
    ['announce', '--port', '5173', '--name', 'app', '--name', 'other'],
  ])('rejects malformed input %j', (...args) => {
    expect(run(args).invoke).toThrow();
  });
});
