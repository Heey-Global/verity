import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PINNED_PROJECT_RUNSC_ARGS,
  PINNED_RUNSC_ARGS,
  PINNED_RUNSC_PATH,
  PINNED_RUNSC_RELEASE,
  PROJECT_RUNSC_RUNTIME,
} from './gvisor-runtime-config.js';
import { HOST_RUNTIME_ALLOWED_ARGS } from './self-update/host-runtimes.js';

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
    // versions.env is the one source every host path reads the registrations from: the host
    // component (`verity-install`, the Updater's requests, install-runsc-host.sh) and the label
    // below. The Server verifies against these constants, so the two have to agree exactly.
    const unquote = (value: string | undefined) => (value ?? '').replace(/^'|'$/gu, '');
    expect(JSON.parse(unquote(assignments.RUNSC_ARGS))).toEqual([...PINNED_RUNSC_ARGS]);
    expect(JSON.parse(unquote(assignments.RUNSC_PROJECT_ARGS))).toEqual([
      ...PINNED_PROJECT_RUNSC_ARGS,
    ]);
    const hostRuntime = readFileSync('deploy/host/verity-host-runtime', 'utf8');
    const allowed = JSON.parse(/^ALLOWED_ARGS='(.*)'$/mu.exec(hostRuntime)![1]!) as string[];
    expect(allowed).toEqual([...HOST_RUNTIME_ALLOWED_ARGS]);
    for (const arg of [...PINNED_RUNSC_ARGS, ...PINNED_PROJECT_RUNSC_ARGS]) {
      expect(allowed, `the host component would refuse ${arg}`).toContain(arg);
    }
    // What a release declares to the Updater is these same pins. A label that drifted from
    // versions.env would have the host register one release while the Server verifies another.
    const label = /^LABEL org\.verity\.host-runtimes="(.*)"$/mu.exec(
      readFileSync('deploy/Dockerfile', 'utf8'),
    );
    expect(label, 'deploy/Dockerfile no longer declares its host runtimes').not.toBeNull();
    expect(JSON.parse(label![1]!.replaceAll('\\"', '"'))).toEqual({
      release: assignments.RUNSC_RELEASE,
      sha512: {
        x86_64: assignments.RUNSC_SHA512_X86_64,
        aarch64: assignments.RUNSC_SHA512_AARCH64,
      },
      runtimes: { runsc: [...PINNED_RUNSC_ARGS], 'runsc-project': [...PINNED_PROJECT_RUNSC_ARGS] },
    });
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
    // The project registration is read back out of every place that writes or checks it.
    // The Server's verifier refuses a Sandbox whose daemon registration differs from
    // PINNED_PROJECT_RUNSC_ARGS, so an installer that drifted would fail every project; a
    // CI daemon that drifted would test a runtime no host has.
    const projectArgs = (text: string, marker: RegExp): unknown => {
      const match = marker.exec(text);
      expect(
        match,
        `no ${PROJECT_RUNSC_RUNTIME} registration found by ${String(marker)}`,
      ).not.toBeNull();
      return JSON.parse(match![1]!) as unknown;
    };
    expect(
      projectArgs(ciDaemon, /"runsc-project":\{"path":"%s","runtimeArgs":(\[[^\]]*\])\}/u),
    ).toEqual([...PINNED_PROJECT_RUNSC_ARGS]);
    const smoke = readFileSync('deploy/bin/verity-gvisor-smoke', 'utf8');
    expect(
      projectArgs(smoke, /Runtimes "runsc-project".*?\.runtimeArgs == (\[[^\]]*\])/su),
    ).toEqual([...PINNED_PROJECT_RUNSC_ARGS]);
    // Never the Secret-job arguments: that registration is what left v1.5.x projects with no
    // network and a supervisor socket the Server could not see.
    expect(PINNED_PROJECT_RUNSC_ARGS).not.toContain('--network=none');
    const dockerignore = readFileSync('.dockerignore', 'utf8');
    expect(dockerignore).not.toMatch(/^deploy\/\*$/m);
    expect(dockerignore).toContain('complete deploy tree is an intentional image input');
  });
});
