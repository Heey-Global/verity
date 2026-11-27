import { afterEach, expect, it, vi } from 'vitest';

const { listRelay, inspectRelay, mkdir } = vi.hoisted(() => ({
  listRelay: vi.fn<() => string>(),
  inspectRelay: vi.fn<() => string>(),
  mkdir: vi.fn(),
}));
const relay = 'a'.repeat(64);
const database = 'b'.repeat(64);

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: object,
    callback: (error: Error | null, result?: { stdout: string }) => void,
  ) => {
    try {
      const stdout =
        args[1] === 'ps'
          ? database
          : args[1] === 'inspect'
            ? '[]'
            : args[2] === 'ls'
              ? listRelay()
              : inspectRelay();
      callback(null, { stdout });
    } catch (error) {
      callback(error as Error);
    }
  },
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  mkdir,
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn(),
}));
vi.mock('./project-egress-host-authority.js', () => ({ readEgressHostConfiguration: vi.fn() }));
vi.mock('./project-egress-build-retention.js', () => ({
  protectedBuildRetainedImages: vi.fn().mockResolvedValue([]),
}));
vi.mock('./project-egress-managed-config.js', () => ({ managedEgressConfiguration: vi.fn() }));
vi.mock('./project-egress-host-runtime.js', () => ({
  openProjectEgressHostStore: () => ({
    load: () => ({ records: [{ retired: false, containers: { relay } }] }),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { listings: [''], inspections: 0, proceeds: true },
  { listings: [relay, ''], inspections: 1, proceeds: true },
  { listings: [relay, relay], inspections: 1, proceeds: false },
])(
  'handles relay listings $listings after $inspections inspections',
  async ({ listings, inspections, proceeds }) => {
    vi.resetModules();
    listRelay.mockReset();
    inspectRelay.mockReset();
    mkdir.mockReset();
    for (const listing of listings) listRelay.mockReturnValueOnce(listing);
    inspectRelay.mockImplementation(() => {
      throw new Error('Docker inspection failed');
    });
    mkdir.mockRejectedValue(
      new Error('Stop before writing configuration or changing the database'),
    );
    vi.stubEnv('VERITY_EGRESS_DEPLOYMENT_NETWORK', 'verity-net');
    const argv = process.argv;
    const exitCode = process.exitCode;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.argv = ['node', 'generator', '/private/config'];
      await import('./project-egress-managed-config-main.js');
      expect(listRelay).toHaveBeenCalledTimes(listings.length);
      expect(inspectRelay).toHaveBeenCalledTimes(inspections);
      expect(mkdir).toHaveBeenCalledTimes(proceeds ? 1 : 0);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  },
);
