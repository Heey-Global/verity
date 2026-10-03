import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; uses?: string; if?: string; run?: string };
type Job = { permissions: Record<string, string>; env: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
  jobs: Record<string, Job>;
};
const digest = `sha256:${'a'.repeat(64)}`;

for (const jobName of ['publish-sandbox', 'publish-toolkit', 'publish-project-relay']) {
  describe(`${jobName} signatures`, () => {
    const job = workflow.jobs[jobName]!;
    const signing = job.steps.find((step) => step.name === 'Sign and verify published artifacts')!;
    const installer = job.steps.find((step) => step.name === 'Install release signature verifier')!;
    const publication = job.steps.find((step) => step.name?.startsWith('Publish ') && step.run)!;
    const repositories = job.env.IMAGE_NAME
      ? [job.env.IMAGE_NAME, job.env.IMAGE_NAME_NEW]
          .filter((name): name is string => Boolean(name))
          .map((name) => `${job.env.REGISTRY}/${name}`)
      : [publication.run!.match(/image=(ghcr\.io\/\S+)/)![1]!];

    function run(overrides: Record<string, string> = {}) {
      const root = mkdtempSync(join(tmpdir(), 'verity-release-signatures-'));
      const log = join(root, 'calls');
      try {
        writeFileSync(join(root, 'docker'), '#!/bin/sh\nprintf "%s\\n" "${MOCK_DIGEST}"\n');
        writeFileSync(
          join(root, 'cosign'),
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\ncase "$1" in sign) exit "${MOCK_SIGN_STATUS:-0}";; verify) exit "${MOCK_VERIFY_STATUS:-0}";; *) exit 99;; esac\n',
        );
        chmodSync(join(root, 'docker'), 0o755);
        chmodSync(join(root, 'cosign'), 0o755);
        writeFileSync(log, '');
        const result = spawnSync('bash', ['-c', signing.run!], {
          encoding: 'utf8',
          env: {
            ...process.env,
            ...job.env,
            VERSION: '1.2.3',
            PATH: `${root}:${process.env.PATH ?? ''}`,
            MOCK_LOG: log,
            MOCK_DIGEST: digest,
            ...overrides,
          },
        });
        return { status: result.status, stderr: result.stderr, calls: readFileSync(log, 'utf8') };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('requires keyless credentials and signs each published repository by digest', () => {
      expect(job.permissions['id-token']).toBe('write');
      expect(installer.uses).toMatch(/^sigstore\/cosign-installer@[a-f0-9]{40}$/);
      expect(job.steps.indexOf(installer)).toBeLessThan(job.steps.indexOf(signing));
      expect(job.steps.indexOf(signing)).toBeGreaterThan(job.steps.indexOf(publication));
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      const calls = result.calls.trim().split('\n');
      expect(calls).toHaveLength(repositories.length * 2);
      const security = readFileSync('SECURITY.md', 'utf8');
      const issuer = security.match(/--certificate-oidc-issuer (\S+)/)![1]!;
      const identity = security.match(/--certificate-identity (\S+)/)![1]!;
      for (const [index, repository] of repositories.entries()) {
        expect(calls[index * 2]).toBe(`sign --yes ${repository}@${digest}`);
        expect(calls[index * 2 + 1]).toBe(
          `verify --certificate-oidc-issuer ${issuer} --certificate-identity ${identity} ${repository}@${digest}`,
        );
      }
    });

    it('preserves toolkit artifact-only publication exclusions', () => {
      if (jobName === 'publish-toolkit') {
        expect(signing.if).toBe(publication.if);
        expect(installer.if).toBe(signing.if);
        expect(signing.if).toContain('backend-artifact-only');
      }
    });

    // Publishing must remain failed when signatures are absent or untrusted.
    it.each([{ MOCK_SIGN_STATUS: '1' }, { MOCK_VERIFY_STATUS: '1' }])(
      'propagates signing and verification failures: %j',
      (failure) => {
        expect(run(failure).status).not.toBe(0);
      },
    );

    it('rejects malformed registry digests before signing', () => {
      const result = run({ MOCK_DIGEST: 'latest' });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe('');
    });
  });
}
