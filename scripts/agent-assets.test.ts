import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SKILL_MANIFEST_HASH } from '../packages/events/src/agent-assets.generated.js';

describe('built-in agent assets', () => {
  it('keeps the review Skill from recommending a detached review', () => {
    const skill = readFileSync('agent/skills/push-review/SKILL.md', 'utf8');
    expect(skill).toContain('synchronous');
    expect(skill).toContain('nohup');
    expect(skill).toContain('wait or poll');
    expect(skill).toContain('exit status');
    expect(skill).toContain('report the concrete failure');
    expect(skill).toContain('Do not mark a failed or interrupted review');
  });

  it('installs every helper dispatched by the canonical CLI', () => {
    const cli = readFileSync('agent/cli/verity', 'utf8');
    const installer = readFileSync('features/verity-sandbox-toolkit/install.sh', 'utf8');
    const commands = cli.slice(cli.indexOf('const commands ='), cli.indexOf('const [domain'));
    const helpers = [...commands.matchAll(/: '(verity-[a-z-]+)'/g)].map((match) => match[1]!);
    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      expect(installer).toContain(
        `install -m 0755 "$FEATURE_DIR/agent-seed/bin/${helper}" /opt/agent-seed/bin/${helper}`,
      );
      expect(
        readFileSync(`features/verity-sandbox-toolkit/agent-seed/bin/${helper}`).length,
      ).toBeGreaterThan(0);
    }
  });
  it('keeps generated prompts, CLI and distribution copies synchronized', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/sync-agent-assets.mjs', '--check']),
    ).not.toThrow();
  });
  it('requires every declared Skill to match the installed manifest', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'verity-skills-'));
    try {
      mkdirSync(resolve(root, 'bin'));
      writeFileSync(resolve(root, 'bin/verity'), readFileSync('agent/cli/verity'));
      cpSync('agent-seed/skills', resolve(root, 'skills'), { recursive: true });
      cpSync('agent-seed/skills-manifest.json', resolve(root, 'skills-manifest.json'));
      const probe = () =>
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            'const m = await import(process.argv[2]); process.stdout.write(JSON.stringify({version: await m.installedSkillsVersion(process.argv[1]), hash: await m.installedSkillsManifestHash(process.argv[1])}));',
            root,
            resolve('features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs'),
          ],
          { encoding: 'utf8' },
        );
      expect(JSON.parse(probe())).toEqual({ version: 1, hash: AGENT_SKILL_MANIFEST_HASH });
      writeFileSync(resolve(root, 'skills/planning/SKILL.md'), 'Stale planning instructions');
      expect(JSON.parse(probe())).toEqual({ version: 0 });
      rmSync(resolve(root, 'skills/dev-server'), { recursive: true });
      expect(JSON.parse(probe())).toEqual({ version: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('forwards CLI arguments literally to the fixed compatibility executable', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'verity-cli-'));
    try {
      mkdirSync(resolve(root, 'bin'));
      writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
      const cli = resolve(root, 'bin/verity');
      writeFileSync(cli, readFileSync('agent/cli/verity'));
      writeFileSync(
        resolve(root, 'bin/verity-repo'),
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));',
        { mode: 0o755 },
      );
      const args = ['status', 'space in argument', '$(touch unintended)', '; echo unexpected'];
      expect(
        JSON.parse(execFileSync(process.execPath, [cli, 'repo', ...args], { encoding: 'utf8' })),
      ).toEqual(args);
      expect(spawnSync(process.execPath, [cli, '../repo']).status).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['agent-seed', 'features/verity-sandbox-toolkit/agent-seed'])(
    'loads only trusted installed Skills from %s',
    (root) => {
      const cli = resolve(root, 'bin/verity');
      for (const name of readdirSync('agent/skills')) {
        expect(
          execFileSync(process.execPath, [cli, 'skill', 'read', name], {
            cwd: '/tmp',
            encoding: 'utf8',
          }),
        ).toBe(readFileSync(`agent/skills/${name}/SKILL.md`, 'utf8'));
      }
      const attempt = spawnSync(process.execPath, [cli, 'skill', 'read', '../../etc/passwd'], {
        encoding: 'utf8',
      });
      expect(attempt.status).not.toBe(0);
      expect(attempt.stdout).toBe('');
    },
  );
});
