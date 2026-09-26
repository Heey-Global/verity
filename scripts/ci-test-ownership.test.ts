import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

it.each(['true', 'false'])('preserves script ownership when contract tests are %s', (selected) => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<
      string,
      {
        strategy?: { matrix?: { shard?: (number | string)[] } };
        steps: { run?: string; env?: Record<string, string> }[];
      }
    >;
  };
  const step = workflow.jobs.test!.steps.find((s) => s.run?.includes('vitest run --shard='))!;
  expect(step.env?.CONTRACT_TEST_SELECTED).toBe('${{ needs.changes.outputs.contract_test }}');
  expect(step.env?.SHARD).toBe('${{ matrix.shard }}');
  const shards = workflow.jobs.test!.strategy?.matrix?.shard ?? [];
  const dir = mkdtempSync(join(tmpdir(), 'ci-test-ownership-'));
  try {
    const binary = join(dir, 'npx');
    writeFileSync(
      binary,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    chmodSync(binary, 0o755);
    // Each matrix job runs the step once with its own SHARD; together they must
    // still cover every hash shard and embedded.test.ts exactly once.
    const calls = shards.map((shard) => {
      const trace = join(dir, `trace-${shard}`);
      const result = spawnSync('bash', ['-c', step.run!], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TRACE: trace,
          SHARD: String(shard),
          CONTRACT_TEST_SELECTED: selected,
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const lines = readFileSync(trace, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0]!) as string[];
    });
    const hashShards = calls.filter((args) => args.some((a) => a.startsWith('--shard=')));
    expect(hashShards.map((args) => args.find((a) => a.startsWith('--shard=')))).toEqual([
      '--shard=1/4',
      '--shard=2/4',
      '--shard=3/4',
      '--shard=4/4',
    ]);
    for (const args of hashShards) {
      expect(args.includes('scripts/**/*.test.ts')).toBe(selected === 'true');
      if (selected === 'true')
        expect(args[args.indexOf('scripts/**/*.test.ts') - 1]).toBe('--exclude');
    }
    for (const args of hashShards)
      expect(args[args.indexOf('packages/server/src/embedded.test.ts') - 1]).toBe('--exclude');
    const rest = calls.filter((args) => !hashShards.includes(args));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.[2]).toBe('packages/server/src/embedded.test.ts');
    expect(calls).toHaveLength(5);
    const contracts = workflow.jobs['contract-test']!.steps.map((s) => s.run ?? '').join('\n');
    expect(contracts).toContain('vitest run scripts');
    expect(contracts).toContain(
      'node --test deploy/bin/verity-agent-gateway-cutover-check.test.mjs',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps manual diagnostics separate from the required full CI verdict', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    concurrency: { group: string };
    jobs: Record<string, { name?: string }>;
  };
  expect(workflow.concurrency.group).toContain(
    "${{ github.event_name == 'workflow_dispatch' && inputs['check-suite'] == 'server-image' && '-server-image' || '' }}",
  );
  expect(workflow.jobs['ci-checks']?.name).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs['check-suite'] == 'server-image' && 'server-image-diagnostics' || 'ci-checks' }}",
  );
});
