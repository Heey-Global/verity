import type { WorkflowGateCandidate, WorkflowStore } from '@verity/store';
import { z } from 'zod';

export type GateResult =
  | { status: 'satisfied'; evidence: Record<string, unknown> }
  | { status: 'pending'; reason: string }
  | { status: 'blocked'; reason: string };

export interface WorkflowProviderAdapters {
  github?: { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> };
  oci?: { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> };
  argoCd?: { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> };
  applicationHealth?: { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> };
}

const gitHubEvidence = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullRequest: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  allowedPathPrefixes: z.array(z.string().min(1)).optional(),
});

interface GitHubPullRequestResponse {
  head?: { sha?: string };
  base?: { ref?: string };
  merged?: boolean;
  merge_commit_sha?: string | null;
  changed_files?: number;
}

type GitHubPullFilesResponse = Array<{ filename?: string }>;

interface GitHubCheckRunsResponse {
  check_runs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    app?: { id?: number };
  }>;
}

interface GitHubStatusResponse {
  statuses?: Array<{ context?: string; state?: string }>;
}

interface GitHubRequiredStatusChecksResponse {
  contexts?: string[];
  checks?: Array<{ context?: string; app_id?: number | null }>;
}

export function createGitHubWorkflowGate(options: {
  token: (owner: string, repo: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
}): { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> } {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async reconcile(candidate) {
      const expected = gitHubEvidence.safeParse(candidate.expectedEvidence);
      if (!expected.success)
        return { status: 'blocked', reason: 'verified PR coordinates are missing' };
      const { owner, repo, pullRequest, headSha } = expected.data;
      const token = await options.token(owner, repo);
      if (token === undefined)
        return { status: 'blocked', reason: 'GitHub provider is not configured' };
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      };
      const request = async <T>(path: string): Promise<T> => {
        const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, {
          headers,
        });
        if (!response.ok) throw new Error(`GitHub gate query failed with HTTP ${response.status}`);
        return (await response.json()) as T;
      };
      const requestPages = async <T>(path: string, items: (page: T) => unknown[]): Promise<T[]> => {
        const pages: T[] = [];
        for (let page = 1; page <= 100; page++) {
          const separator = path.includes('?') ? '&' : '?';
          const result = await request<T>(`${path}${separator}per_page=100&page=${page}`);
          pages.push(result);
          if (items(result).length < 100) return pages;
        }
        throw new Error('GitHub gate pagination exceeded 100 pages');
      };
      const pull = await request<GitHubPullRequestResponse>(`/pulls/${pullRequest}`);
      if (pull.head?.sha?.toLowerCase() !== headSha.toLowerCase()) {
        return {
          status: 'blocked',
          reason: 'pull request head changed; stale CI cannot satisfy the gate',
        };
      }
      if (pull.base?.ref === undefined) {
        return { status: 'blocked', reason: 'pull request base branch is missing' };
      }
      if (candidate.completionGate === 'pull_request.merged') {
        return pull.merged === true && /^[0-9a-f]{40}$/i.test(pull.merge_commit_sha ?? '')
          ? {
              status: 'satisfied',
              evidence: {
                provider: 'github',
                owner,
                repo,
                pullRequest,
                headSha,
                merged: true,
                mergeCommitSha: pull.merge_commit_sha,
              },
            }
          : { status: 'pending', reason: 'approved pull request has not produced a merge commit' };
      }
      const requiredChecks = async (): Promise<GitHubRequiredStatusChecksResponse | null> => {
        const response = await fetchImpl(
          `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(pull.base!.ref!)}/protection/required_status_checks`,
          { headers },
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`GitHub gate query failed with HTTP ${response.status}`);
        return (await response.json()) as GitHubRequiredStatusChecksResponse;
      };
      const [checkPages, statusPages, protection, filePages] = await Promise.all([
        requestPages<GitHubCheckRunsResponse>(
          `/commits/${headSha}/check-runs`,
          (page) => page.check_runs ?? [],
        ),
        requestPages<GitHubStatusResponse>(
          `/commits/${headSha}/status`,
          (page) => page.statuses ?? [],
        ),
        requiredChecks(),
        expected.data.allowedPathPrefixes === undefined
          ? Promise.resolve(undefined)
          : requestPages<GitHubPullFilesResponse>(`/pulls/${pullRequest}/files`, (page) => page),
      ]);
      const checks = { check_runs: checkPages.flatMap((page) => page.check_runs ?? []) };
      const statuses = { statuses: statusPages.flatMap((page) => page.statuses ?? []) };
      const files = filePages?.flat();
      if (files !== undefined) {
        const filenames = files.flatMap(({ filename }) =>
          filename === undefined ? [] : [filename],
        );
        if (
          pull.changed_files !== filenames.length ||
          filenames.length === 0 ||
          filenames.some(
            (filename) =>
              !expected.data.allowedPathPrefixes!.some((prefix) => filename.startsWith(prefix)),
          )
        ) {
          return {
            status: 'blocked',
            reason: 'pull request changes exceed the registered manifest scope',
          };
        }
      }
      const checkRuns = checks.check_runs ?? [];
      const legacy = statuses.statuses ?? [];
      const required = [
        ...(protection?.contexts ?? []).map((context) => ({ context, appId: null })),
        ...(protection?.checks ?? []).flatMap(({ context, app_id: appId }) =>
          context === undefined ? [] : [{ context, appId: appId ?? null }],
        ),
      ].filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) => candidate.context === entry.context && candidate.appId === entry.appId,
          ) === index,
      );
      if (required.length === 0) {
        return {
          status: 'blocked',
          reason: 'the base branch has no required CI checks configured',
        };
      }
      const incomplete = required.filter(({ context, appId }) => {
        const check = checkRuns.find(
          ({ name, app }) => name === context && (appId === null || app?.id === appId),
        );
        const status =
          appId === null ? legacy.find(({ context: name }) => name === context) : undefined;
        return !(
          (check?.status === 'completed' && check.conclusion === 'success') ||
          status?.state === 'success'
        );
      });
      if (incomplete.length > 0) {
        return {
          status: 'pending',
          reason: `required CI checks have not succeeded: ${incomplete
            .map(({ context, appId }) => `${context}${appId === null ? '' : ` (app ${appId})`}`)
            .join(', ')}`,
        };
      }
      return {
        status: 'satisfied',
        evidence: {
          provider: 'github',
          repository: `${owner}/${repo}`,
          pullRequest,
          headSha,
          baseRef: pull.base.ref,
          requiredChecks: required,
          checkRuns: checkRuns.map((check) => ({ name: check.name, conclusion: check.conclusion })),
          statuses: legacy.map((status) => ({ context: status.context, state: status.state })),
        },
      };
    },
  };
}

const argoEvidence = z.object({
  application: z.string().min(1),
  desiredRevision: z.string().min(7),
});

export function createArgoCdWorkflowGate(options: {
  baseUrl: string;
  token: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}): { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> } {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  return {
    async reconcile(candidate) {
      const expected = argoEvidence.safeParse(candidate.expectedEvidence);
      if (!expected.success)
        return { status: 'blocked', reason: 'Argo CD application coordinates are missing' };
      const token = await options.token();
      if (token === undefined)
        return { status: 'blocked', reason: 'Argo CD provider is not configured' };
      const response = await fetchImpl(
        `${baseUrl}/api/v1/applications/${encodeURIComponent(expected.data.application)}`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      );
      if (response.status === 401 || response.status === 403) {
        return { status: 'blocked', reason: 'Argo CD rejected the configured credential' };
      }
      if (!response.ok) throw new Error(`Argo CD gate query failed with HTTP ${response.status}`);
      const application = (await response.json()) as {
        status?: {
          sync?: { status?: string; revision?: string; revisions?: string[] };
          health?: { status?: string };
        };
      };
      const revisions = application.status?.sync?.revisions;
      if (revisions !== undefined && revisions.length !== 1) {
        return {
          status: 'blocked',
          reason: 'multi-source Argo CD applications require a registry source selector',
        };
      }
      const observed = application.status?.sync?.revision ?? revisions?.[0];
      if (observed !== expected.data.desiredRevision) {
        return { status: 'pending', reason: 'Argo CD has not observed the expected Git revision' };
      }
      const sync = application.status?.sync?.status;
      const health = application.status?.health?.status;
      if (sync !== 'Synced' || health !== 'Healthy') {
        return {
          status: 'pending',
          reason: `Argo CD reports sync=${sync ?? 'Unknown'}, health=${health ?? 'Unknown'}`,
        };
      }
      return {
        status: 'satisfied',
        evidence: {
          provider: 'argocd',
          application: expected.data.application,
          desiredRevision: expected.data.desiredRevision,
          observedRevision: observed,
          sync,
          health,
        },
      };
    },
  };
}

export function createApplicationHealthWorkflowGate(options: {
  verify(input: {
    application: string;
    desiredRevision: string;
  }): Promise<{ healthy: boolean; evidence?: Record<string, unknown>; reason?: string }>;
}): { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> } {
  return {
    async reconcile(candidate) {
      const expected = argoEvidence.safeParse(candidate.expectedEvidence);
      if (!expected.success)
        return { status: 'blocked', reason: 'application health coordinates are missing' };
      const result = await options.verify(expected.data);
      if (!result.healthy) {
        return {
          status: 'pending',
          reason: result.reason ?? 'the application-specific health contract is not satisfied',
        };
      }
      return {
        status: 'satisfied',
        evidence: {
          ...(result.evidence ?? {}),
          ...expected.data,
          provider: 'application-health-contract',
        },
      };
    },
  };
}

const ociEvidence = z.object({
  imageRepository: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceRepository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/i),
});

export function createOciProvenanceWorkflowGate(options: {
  verify(input: z.infer<typeof ociEvidence>): Promise<{
    issuer: string;
    subject: string;
    provenanceUrl?: string;
  } | null>;
}): { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> } {
  return {
    async reconcile(candidate) {
      const expected = ociEvidence.safeParse(candidate.expectedEvidence);
      if (!expected.success) {
        return { status: 'blocked', reason: 'immutable image provenance coordinates are missing' };
      }
      const attestation = await options.verify(expected.data);
      if (attestation === null) {
        return {
          status: 'pending',
          reason: 'no trusted attestation binds the image digest to the source commit',
        };
      }
      return {
        status: 'satisfied',
        evidence: {
          provider: 'oci-attestation',
          ...expected.data,
          issuer: attestation.issuer,
          subject: attestation.subject,
          ...(attestation.provenanceUrl !== undefined
            ? { provenanceUrl: attestation.provenanceUrl }
            : {}),
        },
      };
    },
  };
}

export function createWorkflowGateReconciler(options: {
  store: WorkflowStore;
  adapters: WorkflowProviderAdapters;
  retryMs?: number;
  providerTimeoutMs?: number;
}): { reconcile(): Promise<number> } {
  const retryMs = options.retryMs ?? 30_000;
  const providerTimeoutMs = options.providerTimeoutMs ?? 20_000;
  const reconcileWithTimeout = async (
    adapter: { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> },
    candidate: WorkflowGateCandidate,
  ): Promise<GateResult> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        adapter.reconcile(candidate),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${candidate.completionGate} provider timed out`)),
            providerTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
  return {
    async reconcile() {
      const startedAt = new Date();
      await options.store.reconcileSessionSteps();
      const due = await options.store.listDueGates(new Date(), 20);
      let advanced = 0;
      let providerFailed = false;
      for (const candidate of due) {
        let adapter:
          { reconcile(candidate: WorkflowGateCandidate): Promise<GateResult> } | undefined;
        if (candidate.completionGate === 'session.result') {
          await options.store.completeGate(candidate, candidate.expectedEvidence);
          advanced++;
          continue;
        }
        if (
          candidate.completionGate === 'pull_request.ci_passed' ||
          candidate.completionGate === 'pull_request.merged'
        )
          adapter = options.adapters.github;
        else if (candidate.completionGate === 'oci.provenance_verified')
          adapter = options.adapters.oci;
        else if (candidate.completionGate === 'argocd.synced_healthy')
          adapter = options.adapters.argoCd;
        else if (candidate.completionGate === 'application.health')
          adapter = options.adapters.applicationHealth;
        if (adapter === undefined) {
          await options.store.deferGate(
            candidate,
            `${candidate.completionGate} provider is not configured`,
            new Date(Date.now() + retryMs),
          );
          continue;
        }
        try {
          const result = await reconcileWithTimeout(adapter, candidate);
          if (result.status === 'satisfied') {
            await options.store.completeGate(candidate, result.evidence);
            advanced++;
          } else if (result.status === 'blocked') {
            await options.store.blockGate(candidate, result.reason);
          } else {
            await options.store.deferGate(candidate, result.reason, new Date(Date.now() + retryMs));
          }
        } catch (error) {
          providerFailed = true;
          await options.store.deferGate(
            candidate,
            error instanceof Error ? error.message : 'provider reconciliation failed',
            new Date(Date.now() + retryMs),
          );
        }
      }
      if (!providerFailed && due.length < 20)
        await options.store.markProviderEventsReconciled(startedAt);
      return advanced;
    },
  };
}
