import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
it('transports installer credentials only on stdin and leaves no credential bytes in arguments, files or logs after failure, retry and abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installer-secret-'));
  const key = 'synthetic-recovery-' + randomUUID(),
    password = 'synthetic-master-' + randomUUID();
  const jobId = randomUUID();
  try {
    const state = join(root, 'state');
    const bin = join(root, 'bin');
    await mkdir(bin);
    await mkdir(join(state, 'restore'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(state, 'restore/job'),
      JSON.stringify({ id: jobId, phase: 'trial', selection: { source: join(root, 'copy') } }),
    );
    // Real jq executes the installed shell pipeline; wrappers observe every external argument.
    await writeFile(
      join(bin, 'jq'),
      `#!/usr/bin/env python3\nimport os,sys,json\nwith open(os.environ['ARGUMENT_LOG'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\nos.execv('/usr/bin/jq',['jq',*sys.argv[1:]])\n`,
    );
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/bin/env python3\nimport os,sys,json,hashlib\nwith open(os.environ['ARGUMENT_LOG'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\nif sys.argv[1]=='volume':sys.exit(1)\ndata=json.load(sys.stdin)\nif data['configuration']['action']=='abort':assert data['recoveryKey']==data['masterPassword']==''\nelse:\n assert hashlib.sha256((data['recoveryKey']+'\\n'+data['masterPassword']).encode()).hexdigest()==os.environ['EXPECTED_DIGEST']\nif os.environ.get('WORKER_FAIL')=='1':sys.exit(1)\nprint('{"devices":[],"transport":"stdin-verified"}')\n`,
    );
    await chmod(join(bin, 'jq'), 0o700);
    await chmod(join(bin, 'docker'), 0o700);
    const script = join(root, 'invoke');
    await writeFile(
      script,
      `set -euo pipefail
source "$RESTORE_SCRIPT"
STATE_DIR="$TEST_STATE"
opt_restore="$TEST_COPY"
opt_restore_action="$TEST_ACTION"
opt_restore_repository='' opt_restore_snapshot='' opt_restore_kind='' opt_restore_new_identity=0 opt_restore_keep_none=0 opt_restore_secrets_stdin=1
opt_restore_keep_devices=()
opt_backup_dir="$TEST_BACKUP" opt_project=verity opt_image='ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}'
MANAGED_DEPLOYMENT_VOLUME=verity-deployment PROJECT_PATH=unused
die(){ printf '%s\\n' "$*" >&2; exit 1; }
read_state(){ :; }
valid_server_image(){ return 0; }
verity_pairing_ipv4_addresses(){ printf '127.0.0.1\\n'; }
stat(){ if [[ $1 = -c && $2 = %u ]]; then printf '0\\n'; else /usr/bin/stat "$@"; fi; }
verity_restore_install
`,
    );
    const logs: string[] = [];
    for (const [action, fail] of [
      ['devices', '1'],
      ['devices', '0'],
      ['abort', '0'],
    ] as const) {
      const child = spawn('/bin/bash', [script], {
        env: {
          PATH: bin + ':/usr/bin:/bin',
          RESTORE_SCRIPT: join(process.cwd(), 'deploy/bin/verity-restore-install'),
          TEST_STATE: state,
          TEST_COPY: join(root, 'copy'),
          TEST_BACKUP: join(root, 'backup'),
          TEST_ACTION: action,
          ARGUMENT_LOG: join(root, 'arguments'),
          EXPECTED_DIGEST: createHash('sha256')
            .update(key + '\n' + password)
            .digest('hex'),
          WORKER_FAIL: fail,
          VERITY_SYSTEMD_RUN_DIR: join(root, 'no-systemd'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (b) => (output += String(b)));
      child.stderr.on('data', (b) => (output += String(b)));
      const done = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      child.stdin.end(key + '\n' + password + '\n');
      expect(await done, output).toBe(fail === '1' ? 1 : 0);
      logs.push(output);
      if (fail === '0') expect(output).toContain('stdin-verified');
    }
    async function scan(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await scan(file);
        else {
          const bytes = await readFile(file);
          expect(bytes.includes(Buffer.from(key)), file).toBe(false);
          expect(bytes.includes(Buffer.from(password)), file).toBe(false);
        }
      }
    }
    await scan(root);
    expect(logs.join('')).not.toContain(key);
    expect(logs.join('')).not.toContain(password);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
