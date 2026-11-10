import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const installer = new URL(
  '../features/verity-sandbox-toolkit/bin/verity-cli-install.mjs',
  import.meta.url,
).href;
// The security-sensitive expression from the pinned adapter's createSessionConfig.
const fixture = `projects: Object.fromEntries(sessionRoots.map((root) => [root, {
        trust_level: "trusted"
      }]))`;

function patch(source: string) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { hardenCodexAcpSource } from ${JSON.stringify(installer)};
    const source = hardenCodexAcpSource(${JSON.stringify(source)});
    console.log(JSON.stringify(Function('sessionRoots', 'return ({' + source + '})')(['/work/project'])));
  `,
    ],
    { encoding: 'utf8' },
  );
}

it('keeps the thread configuration untrusted even when the adapter creates a new session', () => {
  const result = patch(fixture);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    projects: { '/work/project': { trust_level: 'untrusted' } },
  });
  const source = readFileSync(new URL(installer), 'utf8');
  expect(source).toMatch(
    /writeFileSync\(entry, hardenCodexAcpSource\(readFileSync\(entry, 'utf8'\)\)\)/,
  );
});

it.each(['', fixture + ',' + fixture, fixture.replace('trust_level', 'renamed_trust_level')])(
  'refuses an adapter whose trust expression no longer matches the audited patch',
  (source) => {
    const result = patch(source);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing an unhardened adapter');
  },
);

it.each(['2.5.0', '2.6.1', '99.0.0'])(
  'requires the pinned adapter to match the audited security version (rejects %s)',
  (version) => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../features/verity-sandbox-toolkit/npm/codex-acp/package.json', import.meta.url),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };
    const pin = manifest.dependencies['@agentclientprotocol/codex-acp'];
    expect(readFileSync(new URL(installer), 'utf8')).toContain(`version !== '${pin}'`);
    const refused = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { installCli } from ${JSON.stringify(installer)};
    installCli('codex-acp', ${JSON.stringify(version)});
  `,
      ],
      { encoding: 'utf8' },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('requires audited adapter version');
  },
);

it('hardens the installed pinned adapter rather than only a source fixture', () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@agentclientprotocol/codex-acp');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { readFileSync } from 'node:fs';
      import { hardenCodexAcpSource } from ${JSON.stringify(installer)};
      const source = readFileSync(${JSON.stringify(entry)}, 'utf8');
      const hardened = hardenCodexAcpSource(source);
      const start = hardened.indexOf('projects: Object.fromEntries(sessionRoots.map(');
      const end = hardened.indexOf(']))', start) + 3;
      if (start < 0 || end < 3) throw new Error('Missing project trust configuration');
      console.log(JSON.stringify(Function('sessionRoots', 'return ({' + hardened.slice(start, end) + '})')(['/work/project'])));
    `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    projects: { '/work/project': { trust_level: 'untrusted' } },
  });
});

// From 2.6.0 a configured Codex permission profile can become the starting mode.
// Verity relies on the spawn broker's INITIAL_AGENT_MODE winning over it; an
// adapter that consulted the profile first would start sessions in whatever
// mode a Codex config names, with every test above still green.
it('lets the pinned starting mode take precedence over a configured permission profile', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('@agentclientprotocol/codex-acp'), 'utf8');
  const start = source.indexOf('static getInitialAgentMode(');
  expect(start, 'getInitialAgentMode is gone; re-audit the starting mode').toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  const pinned = body.indexOf('process.env["INITIAL_AGENT_MODE"]');
  expect(pinned).toBeGreaterThan(-1);
  const profile = body.indexOf('activePermissionProfileId !== null');
  if (profile !== -1) expect(pinned).toBeLessThan(profile);
  expect(body.slice(pinned, profile === -1 ? undefined : profile)).toMatch(/return /);
});
