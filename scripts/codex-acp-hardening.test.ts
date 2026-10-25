import { readFileSync } from 'node:fs';
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

it('requires the pinned adapter to match the audited security version', () => {
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
    installCli('codex-acp', '99.0.0');
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('requires audited adapter version');
});
