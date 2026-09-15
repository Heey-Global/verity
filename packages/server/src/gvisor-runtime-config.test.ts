import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PINNED_RUNSC_ARGS,
  PINNED_RUNSC_PATH,
  PINNED_RUNSC_RELEASE,
} from './gvisor-runtime-config.js';

describe('pinned gVisor runtime config', () => {
  it('stays synchronized with the host GitOps pin and registration', () => {
    const versions = readFileSync('deploy/gvisor/versions.env', 'utf8');
    const assignments = Object.fromEntries(
      versions
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(assignments.RUNSC_RELEASE).toBe(PINNED_RUNSC_RELEASE);
    expect(PINNED_RUNSC_PATH).toBe(`/opt/verity/runsc/${PINNED_RUNSC_RELEASE}/runsc`);
    expect(PINNED_RUNSC_ARGS).toEqual(['--platform=systrap', '--network=none']);
    const installer = readFileSync('deploy/gvisor/install-runsc-host.sh', 'utf8');
    expect(installer).toContain('["--platform=systrap", "--network=none"]');
    const ciDaemon = readFileSync('deploy/gvisor-ci.Dockerfile', 'utf8');
    expect(ciDaemon).toContain('COPY deploy/gvisor/versions.env /tmp/versions.env');
    expect(ciDaemon).toContain('install -d -m 0755 /etc/docker');
    expect(ciDaemon).toContain('["--platform=systrap","--network=none"]');
    // The base has to stay a DIGEST-pinned dind. It is the one image in the live
    // cutover smoke that is built on the shared host daemon and then started
    // `--privileged` there, so a floating tag hands that privilege to whatever the
    // upstream tag points at on the day — and a non-dind base fails much later, as
    // a candidate that "never became healthy".
    expect(ciDaemon, 'the CI daemon base is no longer a digest-pinned dind image').toMatch(
      /^FROM docker:[0-9.]+-dind@sha256:[0-9a-f]{64}$/m,
    );
    // Renovate only bumps what it can see. Without the annotation the digest above
    // is pinned and unmaintained, which is the failure that looks like success.
    expect(ciDaemon).toMatch(/^# renovate: datasource=docker depName=docker\nFROM docker:/m);
    const dockerignore = readFileSync('.dockerignore', 'utf8');
    expect(dockerignore).not.toMatch(/^deploy\/\*$/m);
    expect(dockerignore).toContain('complete deploy tree is an intentional image input');
  });
});
