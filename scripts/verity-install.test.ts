import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { COSIGN_SHA256, COSIGN_VERSION } from '../packages/server/src/self-update/cosign-binary.js';

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
    expect(installer).toContain('download_image "$source_image"');
    expect(installer).toContain("local frames=('⠋' '⠙' '⠹'");
    expect(installer).toContain('sub(/:$/, "", id)');
    expect(installer).toContain('length(id) == 12 && id !~ /[^a-f0-9]/');
    expect(installer).toContain('if ($0 ~ /Pull complete|Already exists/) complete[id] = 1');
    expect(installer).toContain("printf ' · %d/%d layers'");
    expect(installer).toContain('download complete  %ds');
    expect(installer).toContain("run_docker ps -a --filter 'name=^/verity-managed-server'");
    expect(installer).toContain("previous_image=$(run_docker inspect --format '{{.Config.Image}}'");
    expect(installer).toContain('source_image=$(sealed_managed_image "$previous_image")');
    expect(installer).toContain('bootstrap_recovery_only=1');
    expect(installer).toContain('VERITY_BOOTSTRAP_RECOVERY_ONLY="$bootstrap_recovery_only"');
    expect(installer).toContain("grep -q 'VERITY_BOOTSTRAP_RECOVERY_ONLY'");
    expect(installer).toContain('source_image="$source_image_override"');
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

  it('keeps verifier pins consistent across bootstrap, recovery, and server image', async () => {
    const bootstrap = await readFile(installerPath, 'utf8');
    const dockerfile = await readFile('deploy/Dockerfile', 'utf8');
    const bootstrapVersion = bootstrap.match(/^COSIGN_VERSION=v(\S+)$/m)![1]!;
    expect(dockerfile.match(/^ARG COSIGN_VERSION=(\S+)$/m)![1]).toBe(bootstrapVersion);
    expect(COSIGN_VERSION.replace(/^v/, '')).toBe(bootstrapVersion);
    for (const [architecture, suffix, dockerSuffix] of [
      ['x64', 'AMD64', ''],
      ['arm64', 'ARM64', '_ARM64'],
    ] as const) {
      const checksum = bootstrap.match(
        new RegExp(`^COSIGN_SHA256_${suffix}=([a-f0-9]{64})$`, 'm'),
      )![1]!;
      expect(
        dockerfile.match(new RegExp(`^ARG COSIGN_SHA256${dockerSuffix}=([a-f0-9]{64})$`, 'm'))![1],
      ).toBe(checksum);
      expect(COSIGN_SHA256[architecture]).toBe(checksum);
    }
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
    const cosignLog = join(root, 'cosign.log');
    const downloadLog = join(root, 'download.log');
    const cosignFixture = join(root, 'cosign');
    const testInstallerPath = join(root, 'install.sh');
    const cosignScript = `#!/bin/sh
printf 'verify %s\\n' "$*" >> '${cosignLog}'
[ "$1" = verify ] || exit 2
[ "$2" = --certificate-oidc-issuer ] || exit 2
[ "$3" = https://token.actions.githubusercontent.com ] || exit 2
[ "$4" = --certificate-identity ] || exit 2
[ "$5" = https://github.com/Heey-Global/verity/.github/workflows/release.yml@refs/heads/main ] || exit 2
[ "\${MOCK_SIGNATURE_FAIL:-0}" = 0 ] || exit 3
printf 'signature %s\\n' "$6" >> "$MOCK_DOCKER_LOG"
`;
    await writeFile(cosignFixture, cosignScript);
    const fixtureChecksum = createHash('sha256').update(cosignScript).digest('hex');
    const bootstrap = await readFile(installerPath, 'utf8');
    // Only the fixture binary pins change; the guarded bootstrap logic is executed.
    await writeFile(
      testInstallerPath,
      bootstrap.replace(
        /^(COSIGN_SHA256_(?:AMD64|ARM64))=[a-f0-9]{64}$/gm,
        `$1=${fixtureChecksum}`,
      ),
    );
    await mkdir(bin);
    await mkdir(join(payload, 'deploy', 'bin'), { recursive: true });
    try {
      await writeFile(
        join(payload, 'deploy', 'bin', 'verity-install'),
        '#!/bin/sh\nprintf "%s\\n" "$*" > "$MOCK_MARKER"\nprintf "%s\\n" "${VERITY_BOOTSTRAP_RECOVERY_ONLY-}" > "$MOCK_MARKER.recovery"\n',
        { mode: 0o755 },
      );
      await writeFile(join(payload, 'deploy', 'bin', 'verity-compose'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      await writeFile(
        join(bin, 'curl'),
        `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; output=$1; fi
  shift
done
printf '%s\\n' "$output" >> '${downloadLog}'
[ "\${MOCK_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
if [ "\${MOCK_CHECKSUM_FAIL:-0}" = 1 ]; then printf 'corrupt' > "$output"; else cp '${cosignFixture}' "$output"; fi
`,
        { mode: 0o755 },
      );
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
if [ "$1 $2" = "docker version" ]; then printf '25.0.0\n'; exit 0; fi
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
  version|rm) exit 0 ;;
  pull)
    if [ -n "\${MOCK_PULL_DELAY:-}" ]; then
      printf '0342b017ba94 Pulling fs layer\n92a02cc06feb Already exists\n'
      sleep "$MOCK_PULL_DELAY"
      printf '0342b017ba94 Pull complete 0B\n'
    fi
    [ "\${MOCK_PULL_FAIL:-0}" = 0 ] || { printf 'registry unavailable\n' >&2; exit 44; } ;;
  ps)
    [ "\${MOCK_PS_FAIL:-0}" = 0 ] || exit 42
    [ -z "\${MOCK_MANAGED_IMAGE:-}" ] || printf '%s\\n' "\${MOCK_MANAGED_NAME:-verity-managed-server}" ;;
  compose) [ "$2" = version ] ;;
  image) [ "$2" = inspect ] || exit 1; printf '%s@sha256:%s\\n' 'ghcr.io/heey-global/verity/verity-server' '${digest}' ;;
  inspect) [ -n "\${MOCK_MANAGED_IMAGE:-}" ] || exit 1; printf '%s\\n' "$MOCK_MANAGED_IMAGE" ;;
  exec)
    [ -n "\${MOCK_MANAGED_IMAGE:-}" ] || exit 1
    printf '%s' "\${MOCK_PAIRING_STATUS:-401}" ;;
  run)
    [ -n "\${MOCK_MANAGED_IMAGE:-}" ] || exit 1
    printf '%s' "\${MOCK_SEALED_IMAGE:-$MOCK_MANAGED_IMAGE}" ;;
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

      await execFileAsync('bash', [testInstallerPath, '--preflight'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MOCK_DOCKER: join(bin, 'docker'),
          MOCK_DOCKER_LOG: dockerLog,
          MOCK_DOWNLOAD_FAIL: '1',
        },
      });
      await expect(access(downloadLog)).rejects.toMatchObject({ code: 'ENOENT' });

      const result = await execFileAsync('bash', [testInstallerPath, '--check'], {
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
      expect(result.stdout).toContain('[1/4] checking host prerequisites');
      expect(result.stdout).toContain('[3/4] downloading');
      expect(result.stdout).toContain('[4/4] running the release installer');
      const initialLog = await readFile(dockerLog, 'utf8');
      expect(
        initialLog.indexOf(`signature ghcr.io/heey-global/verity/verity-server@sha256:${digest}`),
      ).toBeGreaterThan(-1);
      expect(initialLog.indexOf('signature ')).toBeLessThan(initialLog.indexOf('create '));
      expect(await readFile(marker, 'utf8')).toContain(
        `--image ghcr.io/heey-global/verity/verity-server@sha256:${digest} --check`,
      );

      // A terminal-bound sudo cache cannot authenticate after setsid detaches it.
      const sudoPath = join(bin, 'sudo');
      await writeFile(
        sudoPath,
        (await readFile(sudoPath, 'utf8')).replace(
          '#!/bin/sh\n',
          '#!/bin/sh\nif [ "${MOCK_REQUIRE_TTY:-}" = 1 ] && [ "$1 $2" = "docker pull" ]; then (: </dev/tty) 2>/dev/null || { printf "sudo: A terminal is required to authenticate\\n" >&2; exit 1; }; fi\n',
        ),
      );

      const terminal = await execFileAsync(
        'script',
        ['-qec', `bash ${testInstallerPath} --check`, '/dev/null'],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            TERM: 'xterm-256color',
            MOCK_REQUIRE_TTY: '1',
            NO_COLOR: '',
            MOCK_MARKER: marker,
            MOCK_PRIVILEGED: privileged,
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_PAYLOAD: payload,
            MOCK_PAYLOAD_ROOT: payloadRoot,
            MOCK_PULL_DELAY: '1',
          },
        },
      );
      expect(terminal.stdout).toContain('0342b017ba94 Pull complete');
      expect(terminal.stdout).toContain('running the release installer');

      const spinnerBootstrap = await readFile(installerPath, 'utf8');
      const rootDownload = join(root, 'root-download.sh');
      const downloadFunctions = ['progress', 'download_image'].map((name) => {
        const definition = spinnerBootstrap.match(
          new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'),
        );
        expect(definition).not.toBeNull();
        return definition![0];
      });
      await writeFile(
        rootDownload,
        `set -euo pipefail\n${downloadFunctions.join('\n')}\ndownload_image test-image\n`,
      );
      await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "0\\n"\n');
      const rootTerminal = await execFileAsync(
        'script',
        ['-qec', `bash ${rootDownload}`, '/dev/null'],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            TERM: 'xterm-256color',
            NO_COLOR: '',
            SUDO_MOCK: '1',
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_PULL_DELAY: '1',
          },
        },
      );
      expect(rootTerminal.stdout).toContain('1/2 layers');
      expect(rootTerminal.stdout).toContain('download complete');
      await writeFile(join(bin, 'id'), '#!/bin/sh\nprintf "1000\\n"\n');

      await expect(
        execFileAsync('script', ['-qec', `bash ${testInstallerPath} --check`, '/dev/null'], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            TERM: 'xterm-256color',
            MOCK_REQUIRE_TTY: '1',
            NO_COLOR: '',
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_PULL_FAIL: '1',
          },
        }),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('registry unavailable'),
      });

      await writeFile(dockerLog, '');
      const managedImage = `ghcr.io/heey-global/verity/verity-server@sha256:${digest}`;
      await execFileAsync('bash', [testInstallerPath, '--check'], {
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
      expect(await readFile(dockerLog, 'utf8')).toContain(`pull --quiet ${managedImage}`);

      await writeFile(dockerLog, '');
      const staleManagedImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
      await execFileAsync('bash', [testInstallerPath, '--check'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MOCK_DOCKER: join(bin, 'docker'),
          MOCK_DOCKER_LOG: dockerLog,
          MOCK_MANAGED_IMAGE: staleManagedImage,
          MOCK_SEALED_IMAGE: managedImage,
          MOCK_MARKER: marker,
          MOCK_PAYLOAD: payload,
          MOCK_PRIVILEGED: privileged,
        },
      });
      const recoveryLog = await readFile(dockerLog, 'utf8');
      expect(recoveryLog).toContain(
        'run --rm --network none --read-only --cap-drop ALL --user 0:0',
      );
      expect(recoveryLog).toContain(`pull --quiet ${managedImage}`);
      expect(recoveryLog).not.toContain(`pull --quiet ${staleManagedImage}`);
      expect(await readFile(`${marker}.recovery`, 'utf8')).toBe('1\n');

      const payloadInstaller = join(payload, 'deploy', 'bin', 'verity-install');
      await writeFile(payloadInstaller, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      await expect(
        execFileAsync('script', ['-qec', `bash ${testInstallerPath}`, '/dev/null'], {
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
        }),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('cannot safely offer interactive repair'),
      });
      await writeFile(
        payloadInstaller,
        '#!/bin/sh\nprintf "%s\\n" "$*" > "$MOCK_MARKER"\nprintf "%s\\n" "${VERITY_BOOTSTRAP_RECOVERY_ONLY-}" > "$MOCK_MARKER.recovery"\n',
        { mode: 0o755 },
      );

      await writeFile(dockerLog, '');
      await execFileAsync('bash', [testInstallerPath, '--check'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          MOCK_DOCKER: join(bin, 'docker'),
          MOCK_DOCKER_LOG: dockerLog,
          MOCK_MANAGED_IMAGE: managedImage,
          MOCK_PAIRING_STATUS: '200',
          MOCK_MARKER: marker,
          MOCK_PAYLOAD: payload,
          MOCK_PRIVILEGED: privileged,
        },
      });
      const unpairedLog = await readFile(dockerLog, 'utf8');
      expect(unpairedLog).toContain('exec verity-managed-server node -e');
      expect(unpairedLog).toContain('pull --quiet ghcr.io/heey-global/verity/verity-server:latest');
      expect(unpairedLog).not.toContain(`pull ${managedImage}`);
      expect(await readFile(marker, 'utf8')).toContain('--advance-unpaired-from current');

      await writeFile(dockerLog, '');
      await execFileAsync('bash', [testInstallerPath, '--reinstall', '--yes'], {
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
      expect(await readFile(dockerLog, 'utf8')).toContain(
        'pull --quiet ghcr.io/heey-global/verity/verity-server:latest',
      );
      expect(await readFile(marker, 'utf8')).toContain('--reinstall --yes');
      expect(await readFile(`${marker}.recovery`, 'utf8')).toBe('0\n');

      await writeFile(dockerLog, '');
      const oldManagedImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
      await execFileAsync(
        'bash',
        [
          testInstallerPath,
          '--image',
          `ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
          '--check',
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_MANAGED_IMAGE: oldManagedImage,
            MOCK_PAIRING_STATUS: '200',
            MOCK_MARKER: marker,
            MOCK_PAYLOAD: payload,
            MOCK_PRIVILEGED: privileged,
          },
        },
      );
      const overrideLog = await readFile(dockerLog, 'utf8');
      expect(overrideLog).toContain(
        `pull --quiet ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
      );
      expect(overrideLog).not.toContain(`pull ${oldManagedImage}`);
      const forwarded = await readFile(marker, 'utf8');
      expect(forwarded).toBe(
        `--image ghcr.io/heey-global/verity/verity-server@sha256:${digest} --check --advance-unpaired-from ${oldManagedImage}\n`,
      );

      await writeFile(dockerLog, '');
      await execFileAsync(
        'bash',
        [
          testInstallerPath,
          '--image',
          `ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
          '--check',
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_MANAGED_IMAGE: oldManagedImage,
            MOCK_SEALED_IMAGE: managedImage,
            MOCK_MARKER: marker,
            MOCK_PAYLOAD: payload,
            MOCK_PRIVILEGED: privileged,
          },
        },
      );
      expect(await readFile(dockerLog, 'utf8')).toContain(`pull --quiet ${managedImage}`);

      await writeFile(dockerLog, '');
      await execFileAsync(
        'bash',
        [
          testInstallerPath,
          `--image=ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
          '--check',
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_MANAGED_IMAGE: oldManagedImage,
            MOCK_PAIRING_STATUS: '200',
            MOCK_MARKER: marker,
            MOCK_PAYLOAD: payload,
            MOCK_PRIVILEGED: privileged,
          },
        },
      );
      expect(await readFile(dockerLog, 'utf8')).toContain(
        `pull --quiet ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
      );

      await expect(
        execFileAsync(
          'bash',
          [
            testInstallerPath,
            '--image',
            `ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              MOCK_DOCKER: join(bin, 'docker'),
              MOCK_DOCKER_LOG: dockerLog,
              MOCK_MANAGED_IMAGE: oldManagedImage,
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'a paired installation can only recover its current release',
        ),
      });

      await expect(
        execFileAsync('bash', [testInstallerPath, '--image=', '--check'], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
          },
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('option --image needs a value') });

      for (const invalid of [
        'ghcr.io/heey-global/verity/verity-server:latest',
        `ghcr.io/other/verity-server@sha256:${digest}`,
        'ghcr.io/heey-global/verity/verity-server@sha256:abcd',
      ]) {
        await expect(
          execFileAsync('bash', [testInstallerPath, '--image', invalid, '--check'], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              MOCK_DOCKER: join(bin, 'docker'),
            },
          }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining('--image must be') });
      }
      await expect(
        execFileAsync('bash', [testInstallerPath, '--image', '--check'], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
          },
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('option --image needs a value') });

      await writeFile(dockerLog, '');
      await execFileAsync('bash', [testInstallerPath, '--check'], {
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
        'pull --quiet ghcr.io/heey-global/verity/verity-server:latest',
      );

      for (const [failure, message] of [
        ['MOCK_DOWNLOAD_FAIL', 'could not download cosign'],
        ['MOCK_CHECKSUM_FAIL', 'cosign checksum mismatch'],
        ['MOCK_SIGNATURE_FAIL', 'signature verification failed'],
      ]) {
        await writeFile(dockerLog, '');
        await expect(
          execFileAsync('bash', [testInstallerPath, '--check'], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              MOCK_DOCKER: join(bin, 'docker'),
              MOCK_DOCKER_LOG: dockerLog,
              MOCK_PAYLOAD: payload,
              MOCK_PRIVILEGED: privileged,
              MOCK_MARKER: marker,
              [failure!]: '1',
            },
          }),
        ).rejects.toThrow(message);
        const failedLog = await readFile(dockerLog, 'utf8');
        expect(failedLog).not.toContain('create ');
        expect(failedLog).not.toContain('cp ');
      }

      await writeFile(dockerLog, '');
      await expect(
        execFileAsync('bash', [testInstallerPath, '--check'], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            MOCK_DOCKER: join(bin, 'docker'),
            MOCK_DOCKER_LOG: dockerLog,
            MOCK_MANAGED_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${digest}`,
            MOCK_SIGNATURE_FAIL: '1',
          },
        }),
      ).rejects.toThrow('signature verification failed');
      const failedRecovery = await readFile(dockerLog, 'utf8');
      expect(failedRecovery).not.toContain('exec ');
      expect(failedRecovery).not.toContain('run ');

      await writeFile(dockerLog, '');
      await expect(
        execFileAsync('bash', [testInstallerPath, '--check'], {
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
      for (const downloaded of (await readFile(downloadLog, 'utf8')).trim().split('\n')) {
        await expect(access(dirname(downloaded))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
