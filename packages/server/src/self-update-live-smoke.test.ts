import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CandidateReadinessError } from './self-update/docker-in-place-cutover.js';

// Execute the shipped stage without starting its CLI or a real Docker daemon.
const source = readFileSync('packages/server/src/self-update-live-smoke.ts', 'utf8');
const parsed = ts.createSourceFile('smoke.ts', source, ts.ScriptTarget.Latest, true);
const stage = parsed.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'cutoverLosesTheDatabase',
);
if (!stage) throw new Error('database loss stage is missing');
const compiled = ts.transpileModule(stage.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture(authorityImage = 'candidate', maintenance = true) {
  const stopped = new Set<string>();
  const stopContainer = vi.fn(async (id: string) => {
    stopped.add(id);
  });
  const client = {
    stopContainer,
    inspectContainer: async (id: string) => ({ id, running: !stopped.has(id) }),
  };
  const activateCandidate = vi.fn(async () => undefined);
  const stop = vi.fn();
  const environment: Record<string, string> = {
    VERITY_SMOKE_TARGET_DIGEST: 'candidate',
    VERITY_SMOKE_PREVIOUS_DIGEST: 'previous',
  };
  const run = runInNewContext(`${compiled}\ncutoverLosesTheDatabase`, {
    required: (key: string) => environment[key],
    docker: () => client,
    managedServer: async () => ({ id: 'retained', running: true }),
    routedBackend: async () => ({ host: 'old-host' }),
    postgresContainer: async () => 'database',
    relayContainer: async () => 'relay',
    smokeStandbyExchange: () => ({ failures: [], exchange: {}, stop }),
    cutoverDeps: async () => ({ activateCandidate }),
    quiescedNotStopped: (deps: unknown) => deps,
    resumeUpdateCutover: async (deps: { activateCandidate: (state: object) => Promise<void> }) => {
      await deps.activateCandidate({});
      throw new AggregateError([
        new CandidateReadinessError('candidate unavailable', ''),
        new CandidateReadinessError('rollback schema unavailable', ''),
      ]);
    },
    readUpdateJournal: async () => ({ phase: 'rollback-activating-old' }),
    readManagedDeployment: async () => ({ managed: true, spec: { image: authorityImage } }),
    gatewayController: () => ({ status: async () => ({ maintenance }) }),
    UNSERVED_TIMEOUT_MS: 10,
    WITHHELD_STANDBY_TIMEOUT_MS: 10,
    AggregateError,
    CandidateReadinessError,
    expect: (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
    },
    fail: (message: string) => {
      throw new Error(message);
    },
    process: { stdout: { write: vi.fn() } },
  }) as (root: string) => Promise<void>;
  return { run, stop, stopContainer, activateCandidate };
}

describe('live smoke database-loss recovery contract', () => {
  it('requires candidate authority and maintenance before injecting retained-process loss', async () => {
    const { run, stop, stopContainer, activateCandidate } = fixture();
    await expect(run('/managed')).resolves.toBeUndefined();
    expect(stopContainer.mock.calls).toEqual([['database'], ['retained']]);
    expect(activateCandidate).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects premature restoration of old authority', async () => {
    const { run, stop, stopContainer } = fixture('previous');
    await expect(run('/managed')).rejects.toThrow('authority kept previous');
    expect(stopContainer.mock.calls).toEqual([['database']]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects a Gateway that left maintenance despite unavailable schema proof', async () => {
    const { run, stopContainer } = fixture('candidate', false);
    await expect(run('/managed')).rejects.toThrow('Gateway left maintenance');
    expect(stopContainer.mock.calls).toEqual([['database']]);
  });
});
