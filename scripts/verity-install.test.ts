import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const installerPath = 'docs/website/site/install.sh';

describe('public Verity installer', () => {
  it('is valid Bash with pipeline failure propagation', async () => {
    await expect(execFileAsync('bash', ['-n', installerPath])).resolves.toMatchObject({
      stderr: '',
    });
    expect(await readFile(installerPath, 'utf8')).toContain('set -euo pipefail');
  });

  it('anchors the deployment bundle to the resolved Server digest', async () => {
    const installer = await readFile(installerPath, 'utf8');
    const dockerfile = await readFile('deploy/Dockerfile', 'utf8');
    const dockerignore = await readFile('.dockerignore', 'utf8');
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(installer).toContain('ghcr.io/heey-global/verity/verity-server');
    expect(installer).toContain("grep -Eq '^[a-f0-9]{64}$'");
    expect(installer).toContain('run_docker create "$image_digest"');
    expect(installer).toContain("run_docker ps -a --filter 'name=^/verity-managed-server'");
    expect(installer).toContain("source_image=$(run_docker inspect --format '{{.Config.Image}}'");
    expect(installer).toContain('[ "$generation" -le 2147483647 ]');
    expect(installer).toContain('payload_root=/opt/verity-install');
    expect(installer).toContain('payload_root=/opt/varity-install');
    expect(installer).toContain('run_docker cp "$container_id:$payload_root/." -');
    expect(installer).toContain('IMAGE_TAG=${VERITY_IMAGE_TAG:-${VARITY_IMAGE_TAG:-latest}}');
    expect(installer).toContain('as_root tar -x -C "$privileged_root"');
    expect(installer).toContain('mktemp -d /opt/verity-install.XXXXXX');
    expect(installer).toContain('[ "$(stat -c \'%u\' /opt)" = 0 ]');
    expect(installer).toContain('verity-install" --image "$image_digest"');
    expect(installer).not.toContain('VERITY_IMAGE_REPOSITORY');
    expect(installer).not.toContain('VERITY_INSTALL_ROOT');
    expect(installer).toContain('as_root docker version');
    expect(installer).toContain('run_docker() {\n  as_root docker "$@"');
    expect(installer).not.toContain('cp -R "$tmp_root/."');
    expect(installer).toContain('test ! -L "$privileged_root/deploy/bin/verity-install"');
    expect(installer).toContain("trap 'on_signal 130' INT");
    expect(installer).not.toContain('github.com/Heey-Global/Verity/archive');
    expect(dockerfile).toContain('COPY deploy /opt/verity-install/deploy');
    expect(dockerignore).not.toMatch(/^deploy\/\*$/m);
    expect(workflow).toContain('Verify the bundled installer payload');
    expect(workflow).toContain('test -f /opt/verity-install/deploy/docker-compose.yml');
  });

  it('documents the exact public endpoint', async () => {
    const [rootReadme, deployReadme] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('deploy/README.md', 'utf8'),
    ]);
    const command = 'curl -fsSL https://verity.build/install.sh | bash';
    expect(rootReadme).toContain(command);
    expect(deployReadme).toContain(command);
  });

  it.each([
    { label: 'current payload', payloadRoot: '/opt/verity-install' },
    { label: 'legacy payload', payloadRoot: '/opt/varity-install' },
  ])('uses only the root Docker context with $label', async ({ payloadRoot }) => {
    const root = await mkdtemp(join(tmpdir(), 'verity-bootstrap-'));
    const bin = join(root, 'bin');
    const privileged = join(root, 'privileged');
    const payload = join(root, 'payload');
    const marker = join(root, 'installed');
    const dockerLog = join(root, 'docker.log');
    const digest = 'a'.repeat(64);
    await mkdir(bin);
    await mkdir(join(payload, 'deploy', 'bin'), { recursive: true });
    try {
      await writeFile(
        join(payload, 'deploy', 'bin', 'verity-install'),
        '#!/bin/sh\nprintf "%s\\n" "$*" > "$MOCK_MARKER"\n',
        { mode: 0o755 },
      );
      await writeFile(join(payload, 'deploy', 'bin', 'verity-compose'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o755 });
      await writeFile(
        join(bin, 'readlink'),
        '#!/bin/sh\nif [ "$1 $2" = "-f /opt" ]; then printf "/opt\\n"; else exec /usr/bin/readlink "$@"; fi\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(bin, 'stat'),
        `#!/bin/sh
if [ "$1 $2 $3" = "-c %u /opt" ]; then printf '0\\n'; exit 0; fi
if [ "$1 $2 $3" = "-c %a /opt" ]; then printf '755\\n'; exit 0; fi
exec /usr/bin/stat "$@"
`,
        { mode: 0o755 },
      );
      await writeFile(
        join(bin, 'sudo'),
        `#!/bin/sh
if [ "$1 $2" = "mktemp -d" ]; then mkdir -p "$MOCK_PRIVILEGED"; printf '%s\\n' "$MOCK_PRIVILEGED"; exit 0; fi
if [ "$1 $2" = "docker version" ]; then exit 0; fi
if [ "$1" = docker ]; then shift; exec env SUDO_MOCK=1 "$MOCK_DOCKER" "$@"; fi
exec env SUDO_MOCK=1 "$@"
`,
        { mode: 0o755 },
      );
      await writeFile(
        join(bin, 'docker'),
        `#!/bin/sh
[ "\${SUDO_MOCK:-}" = 1 ] || exit 1
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1" in
  version|pull|rm) exit 0 ;;
  ps)
    [ "\${MOCK_PS_FAIL:-0}" = 0 ] || exit 42
    [ -z "\${MOCK_MANAGED_IMAGE:-}" ] || printf '%s\\n' "\${MOCK_MANAGED_NAME:-verity-managed-server}" ;;
  compose) [ "$2" = version ] ;;
  image) [ "$2" = inspect ] || exit 1; printf '%s@sha256:%s\\n' 'ghcr.io/heey-global/verity/verity-server' '${digest}' ;;
  inspect) [ -n "\${MOCK_MANAGED_IMAGE:-}" ] || exit 1; printf '%s\\n' "$MOCK_MANAGED_IMAGE" ;;
  create) [ "$2" = 'ghcr.io/heey-global/verity/verity-server@sha256:${digest}' ] || exit 1; printf 'container-id\\n' ;;
  cp)
    [ "$2" = "container-id:\${MOCK_PAYLOAD_ROOT:-/opt/verity-install}/." ] || exit 1
    [ "$3" = - ] || exit 1
    tar -cf - -C "$MOCK_PAYLOAD" . ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      );

      await execFileAsync('bash', [installerPath, '--check'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MOCK_MARKER: marker,
          MOCK_PRIVILEGED: privileged,
          MOCK_DOCKER: join(bin, 'docker'),
          MOCK_DOCKER_LOG: dockerLog,
          MOCK_PAYLOAD: payload,
          MOCK_PAYLOAD_ROOT: payloadRoot,
        },
      });
      expect(await readFile(marker, 'utf8')).toContain(
        `--image ghcr.io/heey-global/verity/verity-server@sha256:${digest} --check`,
      );

      await writeFile(dockerLog, '');
      const managedImage = `ghcr.io/heey-global/verity/verity-server@sha256:${digest}`;
      await execFileAsync('bash', [installerPath, '--check'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MOCK_DOCKER: join(bin, 'docker'),
          MOCK_DOCKER_LOG: dockerLog,
          MOCK_MANAGED_IMAGE: managedImage,
          MOCK_MARKER: marker,
          MOCK_PAYLOAD: payload,
          MOCK_PRIVILEGED: privileged,
        },
      });
      expect(await readFile(dockerLog, 'utf8')).toContain(`pull ${managedImage}`);

      await writeFile(dockerLog, '');
      await execFileAsync('bash', [installerPath, '--check'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MOCK_DOCKER: join(bin, 'docker'),
          MOCK_DOCKER_LOG: dockerLog,
          MOCK_MANAGED_IMAGE: managedImage,
          MOCK_MANAGED_NAME: 'verity-managed-server-g2147483648',
          MOCK_MARKER: marker,
          MOCK_PAYLOAD: payload,
          MOCK_PRIVILEGED: privileged,
        },
      });
      expect(await readFile(dockerLog, 'utf8')).toContain(
        'pull ghcr.io/heey-global/verity/verity-server:latest',
      );

      await writeFile(dockerLog, '');
      await expect(
        execFileAsync('bash', [installerPath, '--check'], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_MARKER: marker,
            MOCK_PAYLOAD: payload,
            MOCK_PRIVILEGED: privileged,
            MOCK_PS_FAIL: '1',
          },
        }),
      ).rejects.toThrow('could not inspect existing managed Server containers');
      expect(await readFile(dockerLog, 'utf8')).not.toContain('pull ');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
