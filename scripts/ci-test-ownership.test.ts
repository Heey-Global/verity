import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

it.each(['true', 'false'])('preserves script ownership when contract tests are %s', (selected) => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>;
  };
  const step = workflow.jobs.test!.steps.find((s) => s.run?.includes('vitest run --shard='))!;
  expect(step.env?.CONTRACT_TEST_SELECTED).toBe('${{ needs.changes.outputs.contract_test }}');
  const dir = mkdtempSync(join(tmpdir(), 'ci-test-ownership-'));
  try {
    const trace = join(dir, 'trace');
    const binary = join(dir, 'npx');
    writeFileSync(
      binary,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    chmodSync(binary, 0o755);
    const result = spawnSync('bash', ['-c', step.run!], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TRACE: trace,
        CONTRACT_TEST_SELECTED: selected,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(5);
    for (const args of calls.slice(0, 4)) {
      expect(args.includes('scripts/**/*.test.ts')).toBe(selected === 'true');
      if (selected === 'true')
        expect(args[args.indexOf('scripts/**/*.test.ts') - 1]).toBe('--exclude');
    }
    expect(calls[4]).toContain('packages/server/src/embedded.test.ts');
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
    jobs: Record<string, { name?: string }>;
  };
  expect(workflow.jobs['ci-checks']?.name).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs['check-suite'] == 'server-image' && 'server-image-diagnostics' || 'ci-checks' }}",
  );
});
