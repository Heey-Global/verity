import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync('deploy/bin/verity-self-update-live-smoke', 'utf8');
const restart = /^restart_isolated_daemon\(\) \{[\s\S]*?^\}/mu.exec(source)![0];

function run(nestedId = 'isolated-daemon', serverCount = 1) {
  const root = mkdtempSync(join(tmpdir(), 'daemon-restart-'));
  const log = join(root, 'commands');
  writeFileSync(
    join(root, 'docker'),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  'info --format {{.ID}}') echo isolated-daemon ;;
  *'exec '*' docker info --format {{.ID}}') echo "$NESTED_ID" ;;
  'inspect --format {{.HostConfig.RestartPolicy.Name}} '*) echo unless-stopped ;;
  'ps --format {{.Names}}') printf '%s\\n' verity-managed-server-g1 verity-managed-gateway ;;
  'ps -aq --filter label=verity.managed-role=server')
    for ((i=0; i<SERVER_COUNT; i++)); do echo "server-$i"; done ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'node'),
    '#!/usr/bin/env bash\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
server=verity-managed-server-g1
wait_for_healthy() { :; }
expect_gateway_serving() { :; }
${restart}
restart_isolated_daemon
`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        COMMAND_LOG: log,
        NESTED_ID: nestedId,
        SERVER_COUNT: String(serverCount),
        VERITY_SMOKE_DIND: 'verity-self-update-dind-123-1',
      },
    },
  );
  const commands = readFileSync(log, 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { result, commands };
}

describe('isolated self-update daemon restart', () => {
  it('restarts only the daemon whose identity was independently checked', () => {
    const { result, commands } = run();
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toContain(
      '--host unix:///var/run/docker.sock restart verity-self-update-dind-123-1',
    );
    expect(commands).toContain(
      'node packages/server/dist/self-update-live-smoke.js updater-restarts',
    );
    expect(commands).not.toContain('update --restart unless-stopped verity-managed-server-g1');
  });
  it('refuses to mutate a daemon whose identity differs', () => {
    const { result, commands } = run('another-daemon');
    expect(result.status).not.toBe(0);
    expect(commands).not.toContain(' restart ');
    expect(commands).not.toContain('update --restart');
  });
  it('fails the gate when more than one managed Server survives the restart', () => {
    expect(run('isolated-daemon', 2).result.status).not.toBe(0);
  });
  it('runs in both release and full profiles, nightly, with valid shell syntax', () => {
    execFileSync('bash', ['-n', 'deploy/bin/verity-self-update-live-smoke']);
    // Definitions are excluded so deleting either actual call fails this guard.
    expect(source.match(/^\s*restart_isolated_daemon$/gm)).toHaveLength(2);
    const workflow = parse(readFileSync('.github/workflows/self-update.yml', 'utf8'));
    expect(workflow.on.schedule).toEqual([{ cron: '17 3 * * *' }]);
  });
});
