import { lstatSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { agentLaunchSpec } from '../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});

const original = await vi.importActual<typeof import('node:fs')>('node:fs');
const policyPath = '/etc/claude-code';

function policyDirectory(overrides = {}) {
  const metadata = original.lstatSync('/etc');
  vi.mocked(lstatSync).mockImplementation(((path: string, options: unknown) =>
    path === policyPath
      ? Object.assign(metadata, { uid: 0, mode: 0o40755 }, overrides)
      : original.lstatSync(path, options as never)) as typeof lstatSync);
}

function launch(mode: string, command = 'claude-agent-acp') {
  return agentLaunchSpec(
    {
      command,
      args: [],
      cwd: '/work',
      ...(mode === 'normal'
        ? { managedHome: '/home/probe' }
        : {
            knowledgeHome: '/home/probe',
            planning: mode === 'planning',
            knowledgeIsolation: mode === 'knowledge',
          }),
    },
    { agentUid: 1000, agentGid: 1000, env: {} },
  );
}

afterEach(() => vi.mocked(lstatSync).mockImplementation(original.lstatSync));

it.each(['normal', 'planning', 'knowledge'])(
  'admits only the read-only system Claude policy in %s mode',
  (mode) => {
    policyDirectory();
    const { args } = launch(mode);
    const index = args.indexOf(policyPath);
    expect(index).toBeGreaterThan(0);
    expect(args[index - 1]).toBe('--read-root');
    expect(args).not.toContain('/etc');
    expect(args).not.toContain('/etc/shadow');
    expect(launch(mode, 'codex-acp').args).not.toContain(policyPath);
    expect(launch(mode, 'opencode-acp').args).not.toContain(policyPath);
  },
);

it.each([
  { uid: 1000 },
  { mode: 0o40777 },
  { isSymbolicLink: () => true },
  { isDirectory: () => false },
])('rejects an untrusted system policy directory: %j', (metadata) => {
  policyDirectory(metadata);
  expect(() => launch('normal')).toThrow('Invalid Claude managed policy directory');
});

it('does not require a system policy directory on hosts without one', () => {
  vi.mocked(lstatSync).mockImplementation(((path: string, options: unknown) =>
    path === policyPath
      ? undefined
      : original.lstatSync(path, options as never)) as typeof lstatSync);
  expect(launch('normal').args).not.toContain(policyPath);
});
