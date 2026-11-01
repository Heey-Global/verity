import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from '@verity/store';
import type { QAAnalysisRequest } from '@verity/events';
import type { GitHubProjectTokenMint } from './github-app-token.js';
import type { ForgeRepoRef } from './forge-provider.js';
import { ForgeObservationError, observationFailure } from './forge-observation-error.js';
import { computeQAStatistics, type AnalysisRun, type AnalysisJob } from './qa-statistics.js';
const runSchema = z.object({
  id: z.number(),
  run_attempt: z.number().int().positive(),
  workflow_id: z.number(),
  event: z.string().max(2048),
  head_branch: z.string().max(2048).nullable(),
  head_sha: z.string().max(2048),
  status: z.string().max(2048),
  conclusion: z.string().max(2048).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  run_started_at: z.iso.datetime({ offset: true }).nullable(),
  updated_at: z.iso.datetime({ offset: true }),
  html_url: z.string().max(2048),
  name: z.string().max(2048).nullable(),
});
const jobSchema = z.object({
  id: z.number(),
  name: z.string().max(2048),
  conclusion: z.string().max(2048).nullable(),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  html_url: z.string().max(2048),
});
const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string().max(2048),
  name: z.string().max(2048).nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().max(2048).nullable(),
  html_url: z.string().max(2048),
  target_commitish: z.string().max(2048),
});
export type QARepositoryRequest = Exclude<
  QAAnalysisRequest,
  {
    action:
      | 'assignments'
      | 'projects'
      | 'save_report'
      | 'resolve_repair'
      | 'request_repair'
      | 'repair_status'
      | 'propose_assignment'
      | 'request_assignment'
      | 'assignment_status'
      | 'review_assignment'
      | 'stop_assignment';
  }
>;
export function createGitHubQAAnalysis(
  mint: (
    ref: ForgeRepoRef,
    action: QARepositoryRequest['action'] | 'checks' | 'statuses',
  ) => ReturnType<GitHubProjectTokenMint>,
  fetcher: typeof fetch = fetch,
) {
  const cooldowns = new Map<string, number>();
  const inspectedWorkflows = new Map<
    string,
    {
      expires: number;
      definition: {
        workflowId: number;
        path: string;
        blobSha: string;
        url: string;
        observedAt: string;
      };
    }
  >();
  type Snapshot = {
    key: string;
    expires: number;
    since: string;
    until: string;
    branch: string;
    releaseIds: number[];
    releaseDefinitions: unknown[];
    runs: AnalysisRun[];
    next: number | null;
    cursor: number;
    first: Map<number, AnalysisRun>;
    jobs: Map<number, AnalysisJob[]>;
    gaps: unknown[];
    limited: boolean;
    jobBytes: number;
    pendingJobs?: { page: number; items: AnalysisJob[] };
    busy: boolean;
  };
  const snapshots = new Map<string, Snapshot>();
  return async (
    ref: ForgeRepoRef,
    request: QARepositoryRequest,
    authorize: () => Promise<void>,
  ): Promise<Record<string, unknown>> => {
    await authorize();
    const base = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/`;
    const checkedAt = new Date().toISOString();
    if (request.action === 'runs' && request.page > 1 && (!request.since || !request.until))
      return {
        available: false,
        checkedAt,
        error: observationFailure(
          new ForgeObservationError(
            'invalid-response',
            'pagination-requires-original-since-and-until',
          ),
        ),
      };

    let until =
      request.action === 'runs' || request.action === 'statistics'
        ? (request.until ?? checkedAt)
        : checkedAt;
    let since =
      request.action === 'runs' || request.action === 'statistics'
        ? (request.since ?? new Date(Date.parse(until) - 30 * 86400000).toISOString())
        : checkedAt;
    if (
      Date.parse(since) > Date.parse(until) ||
      Date.parse(until) - Date.parse(since) > 366 * 86400000
    )
      throw new Error('Choose an ordered window of at most 366 days');
    let calls = 0;
    const deadline = Date.now() + 45000;
    let token: string | undefined;
    try {
      token = await mint(ref, request.action);
    } catch (error) {
      return { available: false, error: observationFailure(error, 'token') };
    }
    if (!token)
      return {
        available: false,
        error: observationFailure(new ForgeObservationError('credentials', 'token')),
      };
    const usedTokens = new Set([token]);
    const scrub = (text: string) =>
      redactSecrets(
        [...usedTokens].reduce((value, secret) => value.split(secret).join('[REDACTED]'), text),
      );
    const read = async (path: string, text = false): Promise<unknown> => {
      await authorize();
      if (++calls > 40 || Date.now() >= deadline)
        throw new ForgeObservationError('timeout', 'analysis-budget');
      if ((cooldowns.get(base) ?? 0) > Date.now())
        throw new ForgeObservationError(
          'rate-limit',
          'cooldown',
          new Date(cooldowns.get(base)!).toISOString(),
        );
      let credential: string | undefined = token;
      if (request.action === 'pull_status' && path.startsWith('commits/')) {
        try {
          credential = await mint(ref, path.includes('/check-runs?') ? 'checks' : 'statuses');
        } catch {
          throw new ForgeObservationError('credentials', 'commit-checks');
        }
        if (!credential) throw new ForgeObservationError('credentials', 'commit-checks');
        usedTokens.add(credential);
      }
      let response = await fetcher(base + path, {
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))),
      });
      if (text && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        const target = location ? new URL(location) : undefined;
        if (
          !target ||
          target.protocol !== 'https:' ||
          target.username ||
          target.password ||
          target.hash ||
          (target.port && target.port !== '443') ||
          !(
            target.hostname.endsWith('.actions.githubusercontent.com') ||
            target.hostname.endsWith('.blob.core.windows.net')
          )
        )
          throw new ForgeObservationError('unavailable', 'log-redirect');
        await response.body?.cancel();
        await authorize();
        response = await fetcher(target, {
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))),
        });
      }
      if (!response.ok) {
        const limited =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get('x-ratelimit-remaining') === '0' ||
              response.headers.has('retry-after')));
        const retry = Math.min(
          3600000,
          Math.max(
            60000,
            Number(response.headers.get('retry-after')) * 1000 || 0,
            (Number(response.headers.get('x-ratelimit-reset')) * 1000 || 0) - Date.now(),
          ),
        );
        if (limited) {
          if (cooldowns.size >= 200) cooldowns.delete(cooldowns.keys().next().value!);
          cooldowns.set(base, Date.now() + retry);
        }
        // Signed log redirects are not followed with repository credentials.
        throw new ForgeObservationError(
          limited
            ? 'rate-limit'
            : response.status === 401
              ? 'credentials'
              : response.status === 403
                ? 'forbidden'
                : 'unavailable',
          path.split('?')[0]!,
          limited ? new Date(Date.now() + retry).toISOString() : undefined,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ForgeObservationError('invalid-response', 'body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const chunk: unknown = part.value;
          if (!(chunk instanceof Uint8Array))
            throw new ForgeObservationError('invalid-response', 'response-body');
          size += chunk.length;
          if (size > 2_000_000)
            throw new ForgeObservationError('invalid-response', 'response-limit');
          chunks.push(chunk);
          if (text && size >= 32000) break;
        }
      } finally {
        await reader.cancel();
      }
      await authorize();
      const value = Buffer.concat(chunks).toString('utf8');
      return text ? scrub(value).slice(0, 24000) : JSON.parse(value);
    };
    const runPage = async (page: number) =>
      z
        .object({ total_count: z.number(), workflow_runs: z.array(runSchema) })
        .parse(
          await read(
            `actions/runs?per_page=30&page=${page}&created=${encodeURIComponent(since + '..' + until)}`,
          ),
        );
    try {
      let data: unknown;
      let nextPage: number | null = null;
      const page = 'page' in request ? request.page : 1;
      switch (request.action) {
        case 'runs': {
          const result = await runPage(page);
          data = result.workflow_runs;
          nextPage =
            data &&
            result.workflow_runs.length === 30 &&
            page * 30 < Math.min(result.total_count, 1000)
              ? page + 1
              : null;
          await authorize();
          return {
            data: JSON.parse(scrub(JSON.stringify(data))),
            untrusted: true,
            nextPage,
            total: result.total_count,
            complete: !nextPage && result.total_count <= 1000,
            checkedAt,
            since,
            until,
            limit: 1000,
          };
        }
        case 'run':
          data = runSchema.parse(
            await read(
              `actions/runs/${request.runId}${request.attempt ? `/attempts/${request.attempt}` : ''}`,
            ),
          );
          break;
        case 'jobs': {
          const body = z
            .object({ total_count: z.number(), jobs: z.array(jobSchema) })
            .parse(
              await read(
                `actions/runs/${request.runId}/attempts/${request.attempt}/jobs?per_page=30&page=${page}`,
              ),
            );
          data = body.jobs;
          nextPage = page * 30 < body.total_count ? page + 1 : null;
          break;
        }
        case 'job_log':
          data = {
            text: await read(`actions/jobs/${request.jobId}/logs`, true),
            maximumCharacters: 24000,
            coverage: 'bounded redacted excerpt; not the complete log',
          };
          break;
        case 'workflow': {
          const workflow = z
            .object({ id: z.number(), name: z.string(), path: z.string(), html_url: z.string() })
            .parse(await read(`actions/workflows/${request.workflowId}`));
          if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflow.path))
            throw new ForgeObservationError('invalid-response', 'workflow-path');
          const content = z
            .object({ encoding: z.literal('base64'), content: z.string(), sha: z.string() })
            .parse(await read(`contents/${workflow.path}`));
          if (inspectedWorkflows.size >= 200)
            inspectedWorkflows.delete(inspectedWorkflows.keys().next().value!);
          inspectedWorkflows.set(base + workflow.id, {
            expires: Date.now() + 3600000,
            definition: {
              workflowId: workflow.id,
              path: workflow.path,
              blobSha: content.sha,
              url: workflow.html_url,
              observedAt: checkedAt,
            },
          });
          data = {
            ...workflow,
            definition: Buffer.from(content.content, 'base64').toString('utf8').slice(0, 24000),
            blobSha: content.sha,
            coverage: 'current default-branch definition, not historical proof',
          };
          break;
        }
        case 'releases':
          data = z.array(releaseSchema).parse(await read(`releases?per_page=30&page=${page}`));
          break;
        case 'pull_status': {
          const pull = z
            .object({
              number: z.number(),
              html_url: z.string(),
              state: z.string(),
              merged: z.boolean().optional(),
              head: z.object({ sha: z.string() }),
            })
            .parse(await read(`pulls/${request.number}`));
          const sha = encodeURIComponent(pull.head.sha);
          const checks: unknown[] = [],
            statuses: unknown[] = [];
          const gaps: unknown[] = [];
          for (const kind of ['check-runs', 'status'] as const) {
            try {
              const path =
                kind === 'status'
                  ? `commits/${sha}/status?per_page=100`
                  : `commits/${sha}/check-runs?per_page=100`;
              const result = await read(path);
              if (kind === 'status')
                statuses.push(
                  z
                    .object({
                      state: z.string(),
                      total_count: z.number(),
                      statuses: z.array(
                        z.object({
                          context: z.string(),
                          state: z.string(),
                          target_url: z.string().nullable(),
                        }),
                      ),
                    })
                    .parse(result),
                );
              else
                checks.push(
                  z
                    .object({
                      total_count: z.number(),
                      check_runs: z.array(
                        z.object({
                          name: z.string(),
                          status: z.string(),
                          conclusion: z.string().nullable(),
                          html_url: z.string().nullable(),
                        }),
                      ),
                    })
                    .parse(result),
                );
            } catch (error) {
              gaps.push(observationFailure(error, kind));
            }
          }
          data = {
            pull,
            checks,
            statuses,
            gaps,
            coverage:
              'At most 100 checks and statuses; compare total_count before claiming completeness',
          };
          break;
        }
        case 'pulls':
          data = z
            .array(
              z.object({
                number: z.number(),
                title: z.string(),
                html_url: z.string(),
                state: z.string(),
                head: z.object({ sha: z.string(), ref: z.string() }),
              }),
            )
            .parse(await read(`pulls?state=open&per_page=30&page=${page}`));
          break;
        case 'deployments':
          data = z
            .array(
              z.object({
                id: z.number(),
                sha: z.string(),
                ref: z.string(),
                environment: z.string(),
                created_at: z.iso.datetime({ offset: true }),
                statuses_url: z.string(),
              }),
            )
            .parse(await read(`deployments?per_page=30&page=${page}`));
          break;
        case 'deployment_statuses':
          data = z
            .array(
              z.object({
                id: z.number(),
                state: z.string(),
                environment: z.string(),
                created_at: z.iso.datetime({ offset: true }),
                log_url: z.string().nullable(),
                environment_url: z.string().nullable(),
              }),
            )
            .parse(
              await read(`deployments/${request.deploymentId}/statuses?per_page=30&page=${page}`),
            );
          break;
        case 'statistics': {
          if (
            !request.continuation &&
            request.releaseWorkflowIds.some(
              (id) => (inspectedWorkflows.get(base + id)?.expires ?? 0) < Date.now(),
            )
          )
            throw new ForgeObservationError(
              'unavailable',
              'inspect-release-workflow-definitions-first',
            );
          const key = base + createHash('sha256').update(token).digest('hex');
          for (const [id, state] of snapshots) if (state.expires < Date.now()) snapshots.delete(id);
          let id = request.continuation;
          let state = id ? snapshots.get(id) : undefined;
          if (id && (!state || state.key !== key))
            throw new ForgeObservationError(
              'unavailable',
              'analysis-expired-or-credentials-changed',
            );
          if (!state) {
            const repository = z.object({ default_branch: z.string() }).parse(await read(''));
            id = randomUUID();
            state = {
              key,
              expires: Date.now() + 3600000,
              since,
              until,
              branch: repository.default_branch,
              releaseIds: request.releaseWorkflowIds,
              releaseDefinitions: request.releaseWorkflowIds.map(
                (id) => inspectedWorkflows.get(base + id)!.definition,
              ),
              runs: [],
              next: 1,
              cursor: 0,
              first: new Map(),
              jobs: new Map(),
              gaps: [],
              limited: false,
              jobBytes: 0,
              busy: false,
            };
            if (snapshots.size >= 10) snapshots.delete(snapshots.keys().next().value!);
            snapshots.set(id, state);
          }
          if (state.busy)
            throw new ForgeObservationError('unavailable', 'analysis-already-running');
          since = state.since;
          until = state.until;
          state.busy = true;
          try {
            while (state.next !== null && calls < 20 && Date.now() < deadline - 10000) {
              const pageNumber: number = state.next;
              const result = await runPage(pageNumber);
              const incoming = result.workflow_runs.filter(
                (r) =>
                  Date.parse(r.created_at) >= Date.parse(since) &&
                  Date.parse(r.created_at) <= Date.parse(until),
              );
              state.runs = [
                ...new Map([...state.runs, ...incoming].map((r) => [r.id, r])).values(),
              ].slice(0, 1000);
              if (result.total_count > 1000) state.limited = true;
              if (!result.workflow_runs.length && pageNumber * 30 < result.total_count)
                state.limited = true;
              state.next =
                result.workflow_runs.length === 30 &&
                pageNumber * 30 < Math.min(result.total_count, 1000)
                  ? pageNumber + 1
                  : null;
            }
            while (
              state.next === null &&
              state.cursor < state.runs.length &&
              calls < 25 &&
              Date.now() < deadline - 10000
            ) {
              const r = state.runs[state.cursor]!;
              try {
                if (r.run_attempt > 1 && !state.first.has(r.id))
                  state.first.set(
                    r.id,
                    runSchema.parse(await read(`actions/runs/${r.id}/attempts/1`)),
                  );
                const progress = (state.pendingJobs ??= { page: 1, items: [] });
                const all = progress.items;
                for (let pageNumber = progress.page; ; pageNumber++) {
                  const body = z
                    .object({ total_count: z.number(), jobs: z.array(jobSchema) })
                    .parse(
                      await read(
                        `actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100&page=${pageNumber}`,
                      ),
                    );
                  if (
                    state.jobBytes + Buffer.byteLength(JSON.stringify([...all, ...body.jobs])) >
                    4000000
                  ) {
                    state.limited = true;
                    state.cursor = state.runs.length;
                    throw new ForgeObservationError('unavailable', 'job-byte-limit');
                  }
                  all.push(...body.jobs);
                  progress.page = pageNumber + 1;
                  if (all.length >= body.total_count) break;
                  if (!body.jobs.length || pageNumber >= 10)
                    throw new ForgeObservationError('invalid-response', 'job-pagination');
                }
                if (
                  state.jobBytes + Buffer.byteLength(JSON.stringify(all)) > 4000000 ||
                  [...state.jobs.values()].reduce((sum, items) => sum + items.length, 0) +
                    all.length >
                    10000
                ) {
                  state.limited = true;
                  state.cursor = state.runs.length;
                  break;
                }
                state.jobBytes += Buffer.byteLength(JSON.stringify(all));
                state.jobs.set(r.id, all);
              } catch (error) {
                if (['rate-limit', 'timeout'].includes(observationFailure(error).category))
                  throw error;
                state.gaps.push({ runId: r.id, ...observationFailure(error) });
              }
              delete state.pendingJobs;
              state.cursor++;
            }
          } catch (error) {
            await authorize();
            return {
              checkedAt,
              since,
              until,
              complete: false,
              continuation: id,
              error: observationFailure(error),
              runCount: state.runs.length,
              jobCoverage: state.jobs.size,
            };
          } finally {
            state.busy = false;
          }
          const pending = state.next !== null || state.cursor < state.runs.length;
          await authorize();
          const result = {
            checkedAt,
            since,
            until,
            untrusted: true,
            complete: !pending && !state.limited && state.gaps.length === 0,
            continuation: pending ? id : null,
            gaps: state.gaps,
            limitReached: state.limited,
            guidance: state.limited
              ? 'Split the date window: a run, job-count or snapshot byte limit was reached. Do not treat this sample as the full period.'
              : null,
            runCount: state.runs.length,
            jobCoverage: state.jobs.size,
            releaseWorkflowEvidence: state.releaseDefinitions,
            groups: computeQAStatistics(
              state.runs,
              state.first,
              state.jobs,
              state.branch,
              state.releaseIds,
            ),
            definitions: {
              cohort: 'runs created in the interval; latest attempt observed during collection',
              duration: 'completed attempt job envelope; excludes missing jobs',
              queue: 'first attempt creation to first job start; reruns excluded',
              success: 'completed first attempts excluding cancelled, skipped and neutral',
              releaseClassification:
                'caller-selected verified workflow IDs; workflow success is not publication or deployment',
            },
            limits: {
              runs: 1000,
              jobs: 10000,
              jobBytes: 4000000,
              requestsPerCall: 40,
              secondsPerCall: 45,
              snapshotExpiresAt: new Date(state.expires).toISOString(),
            },
          };
          return JSON.parse(scrub(JSON.stringify(result))) as Record<string, unknown>;
        }
      }
      if (Array.isArray(data) && data.length === 30 && request.action !== 'jobs')
        nextPage = page + 1;
      await authorize();
      return {
        data: JSON.parse(scrub(JSON.stringify(data))),
        nextPage,
        checkedAt,
        untrusted: true,
      };
    } catch (error) {
      return { available: false, error: observationFailure(error, request.action), checkedAt };
    }
  };
}
