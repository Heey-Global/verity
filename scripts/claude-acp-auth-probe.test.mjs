import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const patch = 'features/verity-sandbox-toolkit/bin/verity-claude-acp-auth-probe.mjs';

await test('auth probes place settings before the subcommand and preserve their value', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'verity-auth-order-'));
  try {
    await mkdir(path.join(root, 'dist'));
    const file = path.join(root, 'dist', 'acp-agent.js');
    await writeFile(
      file,
      `
const context = { override: { apiKeyHelper: '' } };
const args = ["auth", "status", "--json"];
if (context?.override)
    args.push("--settings", JSON.stringify(context.override));
process.stdout.write(JSON.stringify(args));
`,
    );
    execFileSync(process.execPath, [patch, root]);
    const once = await readFile(file, 'utf8');
    execFileSync(process.execPath, [patch, root]);
    assert.equal(await readFile(file, 'utf8'), once);
    const args = ['--settings', '{"apiKeyHelper":""}', 'auth', 'status', '--json'];
    assert.deepEqual(
      JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8' })),
      args,
    );
    for (const fixture of ['fake-claude-live-smoke.mjs', 'fake-claude-recreate-smoke.mjs']) {
      for (const probeArgs of [args, ['auth', 'status', '--json']]) {
        const output = execFileSync(
          process.execPath,
          [`scripts/fixtures/${fixture}`, ...probeArgs],
          {
            env: { PATH: process.env.PATH, VERITY_LIVE_SMOKE_WORKTREE: root },
            encoding: 'utf8',
            timeout: 5_000,
          },
        );
        assert.deepEqual(JSON.parse(output), { loggedIn: false });
      }
    }
    await writeFile(file, 'const changedUpstream = true;');
    assert.throws(() => execFileSync(process.execPath, [patch, root], { stdio: 'pipe' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('both image installation paths patch the auth probe', async () => {
  for (const file of ['deploy/Dockerfile', 'features/verity-sandbox-toolkit/install.sh']) {
    assert.match(await readFile(file, 'utf8'), /node .*verity-claude-acp-auth-probe\.mjs/);
  }
});
