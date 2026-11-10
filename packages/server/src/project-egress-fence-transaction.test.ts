import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProjectFenceRules,
  ProjectEgressFence,
  projectFenceRules,
  ProjectFenceTransactionError,
  type ProjectFenceBinding,
} from './project-egress-fence.js';
import {
  createProtectedBuildAdmission,
  protectedBuildRules,
} from './project-egress-build-admission.js';
import { projectDeadlineLease } from './project-egress-deadline.js';

const clock = {
  bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
  realNs: '1000000000',
  bootBeforeNs: '1000000000',
  bootAfterNs: '1000000000',
};
const build: ProjectFenceBinding = {
  projectId: 'f740228d-8371-4f0c-b002-d76664a79e8e',
  generation: '05d84045-4dec-4163-9284-d7e53b332caa',
  containerId: 'a'.repeat(64),
  networkId: 'b'.repeat(64),
  endpointId: 'c'.repeat(64),
  bridge: 'veb123456789abc',
  ipv4: '172.30.1.2',
  ipv6: 'fd42::2',
};
const runtime: ProjectFenceBinding = { ...build, generation: 'g1', bridge: 'vep123456789abc' };

/** The nft semantics that matter for replacement, checked against nft 1.0.9 in
 * a private network namespace: a transaction is atomic, `add table`, `add chain`
 * and `add set` are no-ops for present objects, while `delete` and `flush` of an
 * absent object fail the whole transaction. */
function kernel() {
  const objects = new Set<string>();
  const apply = vi.fn(async (script: string) => {
    const next = new Set(objects);
    let depth = 0;
    let table: string | undefined;
    for (const raw of script.split('\n')) {
      const line = raw.trim();
      if (depth === 0) {
        const words = line.replace(/\s*\{.*$/u, '').split(/\s+/u);
        if (words[0] === 'table') {
          table = `table ${words[1]} ${words[2]}`;
          next.add(table);
        } else if (words[0] === 'add' && words[1] === 'table')
          next.add(`table ${words[2]} ${words[3]}`);
        else if (words[0] === 'add') {
          if (!next.has(`table ${words[2]} ${words[3]}`)) throw new Error('No such table');
          next.add(`${words[1]} ${words[2]} ${words[3]} ${words[4]}`);
        } else if (words[0] === 'delete' && words[1] === 'table') {
          const name = `table ${words[2]} ${words[3]}`;
          if (!next.has(name)) throw new Error(`delete of absent ${name}`);
          for (const object of [...next])
            if (object.split(' ').slice(1, 3).join(' ') === `${words[2]} ${words[3]}`)
              next.delete(object);
        } else if (words[0] === 'flush') {
          const name = `${words[1]} ${words[2]} ${words[3]} ${words[4]}`;
          if (!next.has(name)) throw new Error(`flush of absent ${name}`);
        }
      } else if (depth === 1 && table) {
        const declared = /^(chain|set) (\w+)/u.exec(line);
        if (declared) next.add(`${declared[1]} ${table.slice(6)} ${declared[2]}`);
      }
      depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
    }
    objects.clear();
    for (const object of next) objects.add(object);
  });
  /** Something outside this process removed every table, as an interrupted
   * cleanup or a firewall reload can. */
  const vanish = () => objects.clear();
  return { apply, vanish, objects };
}

describe('fence replacement survives tables that are already gone', () => {
  // Observed failure: a protected build's cleanup retried forever because its
  // denial deleted a build table that no longer existed. The admission chose
  // `delete table` from in-memory state, so each retry failed the same way.
  it('denies and retires a build admission after its tables vanished', async () => {
    const nft = kernel();
    const admission = createProtectedBuildAdmission({
      binding: build,
      networkInventory: async () => ({ blocked: [], uplinks: ['eth0'] }),
      dependencies: {
        inspect: async () => ({ ...build }),
        apply: nft.apply,
        resolve: async () => ({ addresses: [], expiresAt: 0 }),
        directTargetAllowed: async () => false,
        destinationAllowed: async () => false,
        deadline: {
          prepare: async () => undefined,
          revoke: async () => undefined,
          clock: async () => clock,
          arm: async () => undefined,
        },
      },
    });
    await admission.prepare();
    await admission.refresh();
    nft.vanish();
    await admission.revoke();
    nft.vanish();
    await admission.retire();
    expect([...nft.objects].filter((object) => object.startsWith('table '))).toHaveLength(2);
  });
  it('emits a build table replacement that applies whether or not the tables exist', async () => {
    const nft = kernel();
    const lease = projectDeadlineLease(build, 0, null, clock);
    for (const script of [
      protectedBuildRules(build, []),
      protectedBuildRules(build, [], lease, lease.nonce, ['eth0']),
      protectedBuildRules(build, []),
    ])
      await nft.apply(script);
    nft.vanish();
    await nft.apply(protectedBuildRules(build, []));
  });
  it('denies a runtime generation after its tables vanished', async () => {
    const nft = kernel();
    const fence = new ProjectEgressFence({
      inspect: async () => ({ ...runtime }),
      apply: nft.apply,
      existing: async () => false,
      resolve: async () => ({ addresses: [], expiresAt: 0 }),
      directTargetAllowed: async () => false,
      destinationAllowed: async () => false,
      policyCurrent: async () => true,
      deadline: {
        prepare: async () => undefined,
        revoke: async () => undefined,
        clock: async () => clock,
        arm: async () => undefined,
      },
    });
    await fence.prepare(runtime);
    nft.vanish();
    await fence.revoke(runtime);
    nft.vanish();
    await fence.retire(runtime);
    nft.vanish();
    await nft.apply(projectFenceRules(runtime, [], 0, true));
  });
});

describe('nft transaction failure evidence', () => {
  let directory: string;
  const executable = async (name: string, body: string) => {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o700);
    return path;
  };
  const failure = async (promise: Promise<void>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProjectFenceTransactionError);
    return error as ProjectFenceTransactionError;
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'verity-nft-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  // The rule echo carries project addresses and admission labels; only nft's
  // message and a bare table statement may reach the journal.
  it('keeps exit status and located nft messages, never the echoed rule text', async () => {
    const script = protectedBuildRules(build, []);
    const nft = await executable(
      'nft-missing',
      `cat >/dev/null
printf '%s\\n' '/dev/stdin:2:14-50: Error: No such file or directory' 'delete table inet verity_egress_x' '             ^^^^' >&2
printf '%s\\n' '/dev/stdin:12:2-40: Error: Could not process rule: Cannot allocate memory' ' ip saddr != 172.30.1.2 drop' >&2
exit 1`,
    );
    const error = await failure(applyProjectFenceRules(script, { executable: nft }));
    expect(error.evidence).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      diagnostics: [
        'line 2: No such file or directory',
        'line 12: Could not process rule: Cannot allocate memory',
      ],
      statements: [script.split('\n')[1]],
    });
    expect(error.evidence.statements[0]).toMatch(/^delete table inet verity_egress_[a-f0-9]+$/u);
    expect(JSON.stringify(error.evidence) + error.message).not.toContain('172.30.1.2');
    expect(error.message).toContain('exit 1; line 2: No such file or directory');
  });
  it('reports the exit status when nft stops reading a large script early', async () => {
    const nft = await executable(
      'nft-early',
      `exec 0<&-
echo '/dev/stdin:1:1-3: Error: syntax error' >&2
exit 1`,
    );
    const error = await failure(
      applyProjectFenceRules('x'.repeat(4 * 1024 * 1024), { executable: nft }),
    );
    expect(error.evidence).toMatchObject({ exitCode: 1, diagnostics: ['line 1: syntax error'] });
  });
  it('kills nft at the budget and marks the outcome as unknown', async () => {
    const nft = await executable('nft-slow', 'exec sleep 10');
    const error = await failure(applyProjectFenceRules('', { executable: nft, budgetMs: 100 }));
    expect(error.evidence).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(error.evidence.durationMs).toBeLessThan(5000);
    expect(error.message).toContain('timed out');
  });
  it('bounds captured stderr and reports a missing executable', async () => {
    const nft = await executable(
      'nft-noisy',
      `cat >/dev/null
i=0; while [ $i -lt 2000 ]; do echo "/dev/stdin:$i:1-2: Error: repeated failure $i" >&2; i=$((i+1)); done
exit 2`,
    );
    const noisy = await failure(applyProjectFenceRules('', { executable: nft }));
    expect(noisy.evidence.diagnostics).toHaveLength(4);
    expect(noisy.evidence.stderrBytes).toBeGreaterThan(8192);
    const missing = await failure(
      applyProjectFenceRules('', { executable: join(directory, 'absent') }),
    );
    expect(missing.evidence.spawnError).toBe('ENOENT');
  });
  it('resolves when nft commits', async () => {
    const nft = await executable('nft-ok', 'cat >/dev/null; exit 0');
    await expect(applyProjectFenceRules('flush ruleset\n', { executable: nft })).resolves.toBe(
      undefined,
    );
  });
});
