import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repository = 'Heey-Global/verity';
const source = 'a'.repeat(40);
const identity = `https://github.com/${repository}/.github/workflows/mobile-native-build.yml@refs/heads/main`;
const script = resolve('scripts/lib/mobile-release-evidence.sh');

describe('mobile release evidence publication', () => {
  for (const scenario of ['absent', 'matching', 'mismatched', 'mutable']) {
    it(`validates the release source with a ${scenario} tag or target`, () => {
      const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
      const steps = workflow.jobs['finalize-mobile-staging'].steps as Array<{
        name?: string;
        run?: string;
      }>;
      const step = steps.find((entry) => entry.name === 'Record verified staging build')!;
      // Draft tags may not exist until publication; trusting a branch target would drift silently.
      const preamble = step.run!.split('bash scripts/lib/mobile-release-evidence.sh verify')[0];
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
          gh() { printf '%s' "$RELEASE_JSON"; }
          git() {
            if [[ "$1" == show-ref ]]; then [[ "$SCENARIO" != absent ]];
            else printf '%s' "$TAG_SOURCE"; fi
          }
          ${preamble}
          [[ "$SOURCE_REVISION" == "$EXPECTED_SOURCE" ]]
        `,
        ],
        {
          env: {
            ...process.env,
            MOBILE_TAG: 'mobile-v1.60.0',
            SCENARIO: scenario,
            EXPECTED_SOURCE: source,
            RELEASE_JSON: JSON.stringify({
              targetCommitish: scenario === 'mutable' ? 'main' : source,
            }),
            TAG_SOURCE: scenario === 'mismatched' ? 'b'.repeat(40) : source,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status, result.stderr).toBe(
        scenario === 'absent' || scenario === 'matching' ? 0 : 1,
      );
    });
  }

  for (const scenario of ['valid', 'missing', 'tampered', 'identity', 'source', 'envelope']) {
    it(`checks ${scenario} evidence before upload`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'mobile-evidence-'));
      try {
        const payload = JSON.stringify({
          schema: 1,
          product: 'mobile-native',
          source,
          version: '1.60.0',
        });
        const digest = createHash('sha256').update(payload).digest('hex');
        const statement = {
          predicateType: 'https://slsa.dev/provenance/v1',
          subject: [{ digest: { sha256: digest } }],
          predicate: {
            buildDefinition: {
              buildType: 'https://github.com/Heey-Global/verity/mobile-staging-record/v1',
              externalParameters: { tag: 'mobile-v1.60.0' },
              resolvedDependencies: [
                {
                  uri: `git+https://github.com/${repository}`,
                  digest: { gitCommit: scenario === 'source' ? 'b'.repeat(40) : source },
                },
              ],
            },
            runDetails: { builder: { id: identity } },
          },
        };
        const envelope = { payload: Buffer.from(JSON.stringify(statement)).toString('base64') };
        const bundle = {
          identity: scenario === 'identity' ? 'untrusted' : identity,
          digest,
          dsseEnvelope: envelope,
        };
        writeFileSync(
          join(directory, 'native-staging.json'),
          scenario === 'tampered' ? `${payload}\n` : payload,
        );
        writeFileSync(join(directory, 'native-staging.sigstore.json'), JSON.stringify(bundle));
        if (scenario !== 'missing')
          writeFileSync(
            join(directory, 'native-staging.provenance.sigstore.json'),
            JSON.stringify(bundle),
          );
        writeFileSync(
          join(directory, 'native-staging.intoto.jsonl'),
          JSON.stringify(scenario === 'envelope' ? { payload: 'wrong' } : envelope),
        );
        // Model cosign's identity and digest rejection; live OIDC signing stays an integration check.
        writeFileSync(
          join(directory, 'cosign'),
          `#!/usr/bin/env node
const fs = require('node:fs'); const crypto = require('node:crypto');
const args = process.argv.slice(2);
const bundle = JSON.parse(fs.readFileSync(args[args.indexOf('--bundle') + 1]));
const expected = args[args.indexOf('--certificate-identity') + 1];
const digest = crypto.createHash('sha256').update(fs.readFileSync(args.at(-1))).digest('hex');
process.exit(bundle.identity === expected && bundle.digest === digest ? 0 : 1);
`,
          { mode: 0o755 },
        );
        const result = spawnSync('bash', [script, 'verify', directory], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_REPOSITORY: repository,
            MOBILE_TAG: 'mobile-v1.60.0',
            SOURCE_REVISION: source,
          },
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(scenario === 'valid' ? 0 : 1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it('publishes verified evidence before making the release public', () => {
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
    const steps = workflow.jobs['finalize-mobile-staging'].steps as Array<{
      name?: string;
      run?: string;
    }>;
    const record = steps.findIndex((step) => step.name === 'Record verified staging build');
    const publish = steps.findIndex(
      (step) => step.name === 'Publish verified native GitHub release',
    );
    expect(record).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(record);
    const run = steps[record].run!;
    expect(run.indexOf('mobile-release-evidence.sh verify')).toBeLessThan(
      run.indexOf('gh release upload'),
    );
    for (const name of [
      'native-staging.json',
      'native-staging.sigstore.json',
      'native-staging.provenance.sigstore.json',
      'native-staging.intoto.jsonl',
    ])
      expect(run).toContain(`native-candidates/${name}`);
    expect(steps[publish].run).toContain('.isDraft or .isPrerelease');
  });

  it('keeps signing in the build and transfers the complete evidence set', () => {
    const workflow = parse(readFileSync('.github/workflows/mobile-native-build.yml', 'utf8'));
    const job = workflow.jobs.build;
    expect(job.permissions['id-token']).toBe('write');
    const steps = job.steps as Array<{ name?: string; run?: string; with?: { path?: string } }>;
    const helper = steps.findIndex(
      (step) => step.name === 'Load release evidence helper from workflow revision',
    );
    const checkout = job.steps[helper];
    expect(checkout.with.ref).toBe('${{ github.workflow_sha }}');
    expect(checkout.with.path).toBe('.mobile-release-tools');
    expect(checkout.with['sparse-checkout']).toBe('scripts/lib/mobile-release-evidence.sh');
    const sign = steps.findIndex((step) => step.name === 'Sign staging build evidence');
    expect(sign).toBeGreaterThan(helper);
    const upload = steps.findIndex((step) => step.name === 'Record exact native candidate');
    expect(sign).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(sign);
    expect(steps[sign].run).toContain(
      '.mobile-release-tools/scripts/lib/mobile-release-evidence.sh sign',
    );
    for (const suffix of ['.json', '.sigstore.json', '.provenance.sigstore.json', '.intoto.jsonl'])
      expect(steps[upload].with?.path).toContain(`native-\${{ inputs.variant }}${suffix}`);
  });
});
