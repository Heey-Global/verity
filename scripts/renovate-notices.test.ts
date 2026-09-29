import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { render, type PackageLock } from './third-party-notices.js';

const script = resolve('scripts/renovate-notices.mjs');
const generator = resolve('scripts/third-party-notices.ts');
const branch = 'renovate/vitest';
const headSha = 'b'.repeat(40);

type Fixture = {
  stale?: boolean;
  lock?: PackageLock;
  verified?: boolean;
  runs?: { id: number; status: string }[];
  cancelFailure?: boolean;
  args?: string[];
};

const lockWith = (...names: string[]): PackageLock => ({
  packages: Object.fromEntries(
    names.map((name) => [`node_modules/${name}`, { version: '1.0.0', license: 'MIT' }]),
  ),
});

function regenerate(fixture: Fixture) {
  const cwd = mkdtempSync(join(tmpdir(), 'renovate-notices-'));
  mkdirSync(join(cwd, 'scripts'));
  // The real generator, so the test proves the script drives it rather than a
  // stand-in that happens to agree with it.
  copyFileSync(generator, join(cwd, 'scripts/third-party-notices.ts'));
  const lock = fixture.lock ?? lockWith('example', 'other');
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
  writeFileSync(
    join(cwd, 'THIRD_PARTY_NOTICES.md'),
    fixture.stale === false ? render(lock) : render(lockWith('example')),
  );
  mkdirSync(join(cwd, 'bin'));
  const log = join(cwd, 'gh.log');
  writeFileSync(
    join(cwd, 'bin/gh'),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(process.env.NOTICES_FIXTURE);
const joined = args.join(' ');
// Log the body a request carried on stdin beside its arguments.
const body = joined.includes('--input -') ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.NOTICES_LOG, JSON.stringify(body === '' ? args : [...args, body]) + '\\n');
if (joined === 'api graphql --input -') {
  process.stdout.write(JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: 'c'.repeat(40), signature: { isValid: fixture.verified !== false } } } } }));
} else if (joined.startsWith('workflow run')) {
  process.exit(0);
} else if (joined.includes('/actions/workflows/ci.yml/runs?')) {
  process.stdout.write(JSON.stringify({ workflow_runs: fixture.runs ?? [] }));
} else if (/^api -X POST repos\\/[^ ]+\\/actions\\/runs\\/\\d+\\/cancel$/.test(joined)) {
  process.exit(fixture.cancelFailure ? 1 : 0);
} else throw new Error('unexpected gh invocation: ' + joined);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [script, ...(fixture.args ?? [branch, headSha])], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'acme/verity',
      // Only what the fake gh answers with; the lock itself would push the
      // environment over the same argv limit the large-file test is about.
      NOTICES_FIXTURE: JSON.stringify({
        verified: fixture.verified,
        runs: fixture.runs,
        cancelFailure: fixture.cancelFailure,
      }),
      NOTICES_LOG: log,
    },
  });
  const calls = readFileSync(log, { encoding: 'utf8', flag: 'a+' })
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls, notices: readFileSync(join(cwd, 'THIRD_PARTY_NOTICES.md'), 'utf8') };
}

/** The GraphQL request a logged `gh api graphql --input -` call carried on stdin. */
function graphqlBody(call: string[] | undefined) {
  expect(call?.slice(0, 4)).toEqual(['api', 'graphql', '--input', '-']);
  return JSON.parse(call?.[4] ?? '{}') as { query: string; variables: Record<string, string> };
}

describe('renovate notices regeneration', () => {
  it('leaves a branch whose notices already match its lock alone', () => {
    const result = regenerate({ stale: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('commits regenerated notices onto the head it was given, then dispatches the checks', () => {
    const lock = lockWith('example', 'other');
    const result = regenerate({ lock, runs: [{ id: 7, status: 'in_progress' }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.notices).toBe(render(lock));

    const [commit, ci, gitleaks, list, cancel, ...rest] = result.calls;
    expect(rest).toEqual([]);
    const { query, variables } = graphqlBody(commit);
    // The commit is rejected, not misplaced, if Renovate pushed meanwhile.
    expect(query).toContain('expectedHeadOid: $expected');
    expect(variables['expected']).toBe(headSha);
    expect(variables['branch']).toBe(branch);
    expect(variables['repository']).toBe('acme/verity');
    expect(variables['path']).toBe('THIRD_PARTY_NOTICES.md');
    expect(Buffer.from(variables['contents'] ?? '', 'base64').toString()).toBe(render(lock));
    expect(variables['message']).toMatch(/^chore\(deps\): /);
    expect(query).toContain('signature { isValid }');

    // A GITHUB_TOKEN commit emits no pull_request event; the required verdict
    // and the org Gitleaks gate have to be asked for by name.
    expect(ci).toEqual(['workflow', 'run', 'ci.yml', '--ref', branch]);
    expect(gitleaks).toEqual(['workflow', 'run', 'gitleaks-dispatch.yml', '--ref', branch]);
    expect(list?.[1]).toContain(`head_sha=${headSha}`);
    expect(list?.[1]).toContain('event=pull_request');
    expect(cancel).toEqual(['api', '-X', 'POST', 'repos/acme/verity/actions/runs/7/cancel']);
  });

  it('carries a notices file larger than one argv element allows', () => {
    // The real file encodes to about 150 KB; Linux caps a single argument at
    // 128 KiB, so `-f contents=...` fails with E2BIG on precisely the branches
    // this script exists to repair. The body has to travel on stdin.
    const lock = lockWith(...Array.from({ length: 4000 }, (_, index) => `package-${index}`));
    const result = regenerate({ lock });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    const { variables } = graphqlBody(result.calls[0]);
    expect((variables['contents'] ?? '').length).toBeGreaterThan(128 * 1024);
    expect(Buffer.from(variables['contents'] ?? '', 'base64').toString()).toBe(render(lock));
  });

  it('does not cancel a run that already finished', () => {
    const result = regenerate({ runs: [{ id: 8, status: 'completed' }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((call) => call.includes('-X'))).toBe(false);
  });

  it('keeps the repaired branch successful when a superseded run finishes before cancellation', () => {
    const result = regenerate({
      runs: [{ id: 8, status: 'in_progress' }],
      cancelFailure: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Could not cancel superseded CI run 8');
    expect(result.calls).toHaveLength(5);
    expect(result.calls[1]).toEqual(['workflow', 'run', 'ci.yml', '--ref', branch]);
    expect(result.calls[2]).toEqual(['workflow', 'run', 'gitleaks-dispatch.yml', '--ref', branch]);
    expect(result.calls[4]).toEqual([
      'api',
      '-X',
      'POST',
      'repos/acme/verity/actions/runs/8/cancel',
    ]);
  });

  it('stops before dispatching anything when GitHub did not sign the commit', () => {
    const result = regenerate({ verified: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not verified');
    expect(result.calls.map((call) => call.slice(0, 2))).toEqual([['api', 'graphql']]);
  });

  it('refuses to paper over a lock entry the generator rejects', () => {
    // No license metadata is a finding for the PR, not a file to regenerate.
    const result = regenerate({
      lock: { packages: { 'node_modules/unlicensed': { version: '1.0.0' } } },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no license metadata');
    expect(result.calls).toEqual([]);
  });

  it.each([[[]], [[branch]], [[branch, 'not-a-sha']], [['bad branch', headSha]]])(
    'rejects malformed arguments %j',
    (args) => {
      const result = regenerate({ args });
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
    },
  );
});

describe('renovate notices workflow', () => {
  type Step = {
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  const workflow = parse(readFileSync('.github/workflows/renovate-notices.yml', 'utf8')) as {
    on: { pull_request?: { types?: string[]; paths?: string[] } };
    jobs: Record<string, { if?: string; permissions?: Record<string, string>; steps: Step[] }>;
  };
  const job = workflow.jobs['notices'];
  const run = job?.steps.find((step) => step.run?.includes('renovate-notices.mjs'));

  it('runs only for lock changes Renovate itself pushed to its own branches', () => {
    // The job carries a write token and executes the generator from the PR
    // head. `user.login` is who opened the PR; `sender.login` is who pushed
    // this head, so a collaborator's commit onto a renovate/* branch, or a
    // fork, must never reach it.
    expect(workflow.on.pull_request?.types).toEqual(['opened', 'synchronize']);
    expect(workflow.on.pull_request?.paths).toEqual(['package-lock.json']);
    expect(job?.if).toContain("github.event.pull_request.user.login == 'renovate[bot]'");
    expect(job?.if).toContain("github.event.sender.login == 'renovate[bot]'");
    expect(job?.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(job?.if?.match(/&&/g)).toHaveLength(2);
    expect(job?.if).not.toContain('||');
    expect(job?.permissions).toEqual({ actions: 'write', contents: 'write' });
  });

  it('regenerates from the exact head it will name as the expected parent', () => {
    const checkout = job?.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['ref']).toBe('${{ github.event.pull_request.head.sha }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(run?.env?.['HEAD_SHA']).toBe('${{ github.event.pull_request.head.sha }}');
    expect(run?.env?.['HEAD_REF']).toBe('${{ github.event.pull_request.head.ref }}');
    expect(run?.run).toBe('node scripts/renovate-notices.mjs "$HEAD_REF" "$HEAD_SHA"');
  });

  it('commits as the author Renovate is told to ignore', () => {
    // Renovate treats a branch another author touched as modified and stops
    // updating it. The exemption names the GITHUB_TOKEN author; an app token
    // here would change the author and quietly freeze every fixed-up branch.
    const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
      gitIgnoredAuthors?: string[];
      postUpgradeTasks?: unknown;
    };
    expect(run?.env?.['GH_TOKEN']).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(renovate.gitIgnoredAuthors).toEqual([
      '41898282+github-actions[bot]@users.noreply.github.com',
    ]);
    // Blocked on the hosted Mend app: it would be ignored, not run.
    expect(renovate.postUpgradeTasks).toBeUndefined();
  });

  it('dispatches workflows that exist and accept a dispatch', () => {
    const source = readFileSync('scripts/renovate-notices.mjs', 'utf8');
    const dispatched = [...source.matchAll(/'([\w-]+\.yml)'/g)].map((match) => match[1]);
    expect(dispatched).toEqual(['ci.yml', 'gitleaks-dispatch.yml']);
    for (const file of dispatched) {
      const parsed = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        on: Record<string, unknown>;
        jobs: Record<string, unknown>;
      };
      expect(Object.keys(parsed.on), file).toContain('workflow_dispatch');
    }
    // A plain dispatch of ci.yml must publish the verdict the ruleset requires,
    // so the job's name has to fall back to `ci-checks` for every dispatch that
    // passes no inputs, which is what the script sends.
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { name?: string }>;
    };
    const verdict = ci.jobs['ci-checks'];
    expect(verdict).toBeDefined();
    if (verdict?.name !== undefined) expect(verdict.name).toMatch(/\|\| 'ci-checks' \}\}$/);
  });

  it('is the check the notices guard runs', () => {
    // The script matches the generator's own stale message; if the generator
    // rewords it, the script would treat every stale branch as a hard failure.
    const source = readFileSync('scripts/renovate-notices.mjs', 'utf8');
    const generatorSource = readFileSync('scripts/third-party-notices.ts', 'utf8');
    expect(generatorSource).toContain('THIRD_PARTY_NOTICES.md is stale');
    expect(source).toContain('`${noticesPath} is stale`');
    expect(execFileSync('git', ['ls-files', 'THIRD_PARTY_NOTICES.md'], { encoding: 'utf8' })).toBe(
      'THIRD_PARTY_NOTICES.md\n',
    );
  });
});
