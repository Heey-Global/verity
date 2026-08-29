import { describe, expect, it, vi } from 'vitest';
import type { WorkflowGateCandidate, WorkflowStore } from '@verity/store';
import {
  createArgoCdWorkflowGate,
  createApplicationHealthWorkflowGate,
  createGitHubWorkflowGate,
  createOciProvenanceWorkflowGate,
  createWorkflowGateReconciler,
} from './workflow-providers.js';

const candidate = (completionGate: string, expectedEvidence: unknown): WorkflowGateCandidate => ({
  workflowId: 'wf_1',
  workflowVersion: 1,
  stepId: 'step_1',
  stepKind: 'gate',
  completionGate,
  expectedEvidence,
  attempt: 1,
});

describe('workflow provider gates', () => {
  it('transitions permanent provider failures to a blocked workflow', async () => {
    const gateCandidate = candidate('pull_request.ci_passed', {});
    const blockGate = vi.fn();
    const deferGate = vi.fn();
    const store = {
      reconcileSessionSteps: vi.fn(),
      listDueGates: vi.fn(async () => [gateCandidate]),
      blockGate,
      deferGate,
      completeGate: vi.fn(),
      markProviderEventsReconciled: vi.fn(),
    } as unknown as WorkflowStore;
    const reconciler = createWorkflowGateReconciler({
      store,
      adapters: {
        github: {
          reconcile: vi.fn(async () => ({ status: 'blocked' as const, reason: 'stale head' })),
        },
      },
    });

    await expect(reconciler.reconcile()).resolves.toBe(0);
    expect(blockGate).toHaveBeenCalledWith(gateCandidate, 'stale head');
    expect(deferGate).not.toHaveBeenCalled();
  });

  it('bounds a hung provider call and schedules a retry', async () => {
    const gateCandidate = candidate('pull_request.ci_passed', {});
    const deferGate = vi.fn();
    const markProviderEventsReconciled = vi.fn();
    const store = {
      reconcileSessionSteps: vi.fn(),
      listDueGates: vi.fn(async () => [gateCandidate]),
      blockGate: vi.fn(),
      deferGate,
      completeGate: vi.fn(),
      markProviderEventsReconciled,
    } as unknown as WorkflowStore;
    const reconciler = createWorkflowGateReconciler({
      store,
      adapters: { github: { reconcile: vi.fn(() => new Promise<never>(() => undefined)) } },
      providerTimeoutMs: 5,
    });

    await expect(reconciler.reconcile()).resolves.toBe(0);
    expect(deferGate).toHaveBeenCalledWith(
      gateCandidate,
      'pull_request.ci_passed provider timed out',
      expect.any(Date),
    );
    expect(markProviderEventsReconciled).not.toHaveBeenCalled();
  });

  it('requires an actual merge commit after merge approval', async () => {
    const responses = [
      {
        head: { sha: 'a'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merge_commit_sha: 'b'.repeat(40),
      },
    ];
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.merged', {
          owner: 'example',
          repo: 'app',
          pullRequest: 1,
          headSha: 'a'.repeat(40),
          approved: true,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'satisfied',
      evidence: { merged: true, mergeCommitSha: 'b'.repeat(40) },
    });
  });

  it('rejects GitHub CI evidence after the PR head changed', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ head: { sha: 'b'.repeat(40) } }), { status: 200 }),
    );
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: fetchMock,
    });
    const result = await gate.reconcile(
      candidate('pull_request.ci_passed', {
        owner: 'example',
        repo: 'app',
        pullRequest: 1,
        headSha: 'a'.repeat(40),
      }),
    );
    expect(result).toEqual({
      status: 'blocked',
      reason: 'pull request head changed; stale CI cannot satisfy the gate',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('satisfies GitHub CI only for completed checks on the exact head', async () => {
    const responses = [
      { head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } },
      { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
      { statuses: [{ context: 'legacy', state: 'success' }] },
      { contexts: ['test', 'legacy'], checks: [] },
    ];
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.ci_passed', {
          owner: 'example',
          repo: 'app',
          pullRequest: 1,
          headSha: 'a'.repeat(40),
        }),
      ),
    ).resolves.toMatchObject({ status: 'satisfied' });
  });

  it('does not accept a green optional check when a required check is absent', async () => {
    const responses = [
      { head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } },
      { check_runs: [{ name: 'optional', status: 'completed', conclusion: 'success' }] },
      { statuses: [] },
      { contexts: ['required'], checks: [] },
    ];
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.ci_passed', {
          owner: 'example',
          repo: 'app',
          pullRequest: 1,
          headSha: 'a'.repeat(40),
        }),
      ),
    ).resolves.toEqual({
      status: 'pending',
      reason: 'required CI checks have not succeeded: required',
    });
  });

  it('fails closed when the base branch has no required-check protection', async () => {
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async (input) => {
        const url = String(input);
        if (url.includes('/pulls/'))
          return new Response(
            JSON.stringify({ head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } }),
            { status: 200 },
          );
        if (url.includes('/check-runs'))
          return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
        if (url.includes('/required_status_checks')) return new Response('', { status: 404 });
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.ci_passed', {
          owner: 'example',
          repo: 'app',
          pullRequest: 1,
          headSha: 'a'.repeat(40),
        }),
      ),
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'the base branch has no required CI checks configured',
    });
  });

  it('keeps the gate pending while a required check is pending or failed', async () => {
    const responses = [
      { head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } },
      { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] },
      { statuses: [] },
      { contexts: [], checks: [{ context: 'test', app_id: 1 }] },
    ];
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.ci_passed', {
          owner: 'example',
          repo: 'app',
          pullRequest: 1,
          headSha: 'a'.repeat(40),
        }),
      ),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('does not accept a same-named check from the wrong GitHub App', async () => {
    const responses = [
      { head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } },
      {
        check_runs: [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { id: 22 },
          },
        ],
      },
      { statuses: [{ context: 'test', state: 'success' }] },
      { contexts: [], checks: [{ context: 'test', app_id: 11 }] },
    ];
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.ci_passed', {
          owner: 'example',
          repo: 'app',
          pullRequest: 1,
          headSha: 'a'.repeat(40),
        }),
      ),
    ).resolves.toEqual({
      status: 'pending',
      reason: 'required CI checks have not succeeded: test (app 11)',
    });
  });

  it('verifies the complete GitOps PR diff against the registered path scope', async () => {
    const responses = [
      { head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, changed_files: 2 },
      { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
      { statuses: [] },
      { contexts: ['test'], checks: [] },
      [{ filename: 'apps/api/staging/deployment.yaml' }],
    ];
    const gate = createGitHubWorkflowGate({
      token: async () => 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(
      gate.reconcile(
        candidate('pull_request.ci_passed', {
          owner: 'example',
          repo: 'cluster',
          pullRequest: 2,
          headSha: 'a'.repeat(40),
          allowedPathPrefixes: ['apps/api/staging/'],
        }),
      ),
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'pull request changes exceed the registered manifest scope',
    });
  });

  it('requires a trusted OCI attestation for the exact digest and source commit', async () => {
    const verify = vi.fn(async () => ({
      issuer: 'https://token.actions.githubusercontent.com',
      subject: 'example/app',
    }));
    const gate = createOciProvenanceWorkflowGate({ verify });
    const result = await gate.reconcile(
      candidate('oci.provenance_verified', {
        imageRepository: 'ghcr.io/example/app',
        digest: `sha256:${'a'.repeat(64)}`,
        sourceRepository: 'example/app',
        sourceCommit: 'b'.repeat(40),
      }),
    );
    expect(result).toMatchObject({ status: 'satisfied' });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('does not accept Argo health on the wrong revision', async () => {
    const gate = createArgoCdWorkflowGate({
      baseUrl: 'https://argo.example',
      token: async () => 'token',
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: {
                sync: { status: 'Synced', revision: 'wrong' },
                health: { status: 'Healthy' },
              },
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(
      gate.reconcile(
        candidate('argocd.synced_healthy', {
          application: 'app-staging',
          desiredRevision: 'expected',
        }),
      ),
    ).resolves.toEqual({
      status: 'pending',
      reason: 'Argo CD has not observed the expected Git revision',
    });
  });

  it('requires the application-specific health contract for final verification', async () => {
    const verify = vi.fn(async () => ({ healthy: false, reason: 'smoke probe failed' }));
    const gate = createApplicationHealthWorkflowGate({ verify });
    await expect(
      gate.reconcile(
        candidate('application.health', {
          application: 'app-staging',
          desiredRevision: 'expected',
        }),
      ),
    ).resolves.toEqual({ status: 'pending', reason: 'smoke probe failed' });
    expect(verify).toHaveBeenCalledWith({
      application: 'app-staging',
      desiredRevision: 'expected',
    });
  });
});
