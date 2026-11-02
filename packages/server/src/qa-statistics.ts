export interface AnalysisRun {
  id: number;
  run_attempt: number;
  workflow_id: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
  html_url: string;
  name: string | null;
  pull_requests?: { number: number }[] | undefined;
}
export interface AnalysisJob {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    meanSeconds: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    medianSeconds: n
      ? ((sorted[Math.floor((n - 1) / 2)] ?? 0) + (sorted[Math.ceil((n - 1) / 2)] ?? 0)) / 2
      : null,
    p95Seconds: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
  };
}
/** Jobs may overlap: wall time is their envelope, never their summed duration. */
export function computeQAStatistics(
  runs: AnalysisRun[],
  firstAttempts: Map<number, AnalysisRun>,
  jobs: Map<number, AnalysisJob[]>,
  defaultBranch: string,
  releaseWorkflowIds: number[],
) {
  // Pagination and repeated observations must not inflate the denominator.
  runs = [
    ...new Map(
      [...runs].sort((a, b) => a.run_attempt - b.run_attempt).map((r) => [r.id, r]),
    ).values(),
  ];
  const groups = new Map<string, AnalysisRun[]>();
  for (const run of runs) {
    const category = ['pull_request', 'pull_request_target', 'merge_group'].includes(run.event)
      ? 'pr-ci'
      : releaseWorkflowIds.includes(run.workflow_id)
        ? 'release-workflow'
        : run.head_branch === defaultBranch
          ? 'main'
          : 'other';
    const key = `${category}:${run.workflow_id}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups].map(([group, rows]) => {
    const first = rows.flatMap((r) =>
      r.run_attempt === 1 ? [r] : firstAttempts.has(r.id) ? [firstAttempts.get(r.id)!] : [],
    );
    const completedFirst = first.filter(
      (r) =>
        r.status === 'completed' &&
        ['success', 'failure', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(
          r.conclusion ?? '',
        ),
    );
    const completed = rows.filter((r) => r.status === 'completed');
    const durations: number[] = [],
      waits: number[] = [];
    for (const r of completed) {
      const all = jobs.get(r.id)?.filter((j) => j.conclusion !== 'skipped');
      if (!all?.length || all.some((j) => !j.started_at || !j.completed_at)) continue;
      const starts = all.map((j) => Date.parse(j.started_at!)),
        ends = all.map((j) => Date.parse(j.completed_at!));
      const start = Math.min(...starts),
        end = Math.max(...ends);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
        durations.push((end - start) / 1000);
      // A rerun's creation timestamp is the original run's, not its queue entry.
      if (r.run_attempt === 1 && Number.isFinite(start) && start >= Date.parse(r.created_at))
        waits.push((start - Date.parse(r.created_at)) / 1000);
    }
    const failures = new Map<string, { run: AnalysisRun; job: AnalysisJob }[]>();
    for (const r of rows) {
      for (const j of jobs.get(r.id) ?? []) {
        if (!['failure', 'timed_out', 'action_required'].includes(j.conclusion ?? '')) continue;
        const key = `${j.name}:${j.conclusion}`;
        const existing = failures.get(key) ?? [];
        if (!existing.some((item) => item.run.id === r.id)) existing.push({ run: r, job: j });
        failures.set(key, existing);
      }
    }
    return {
      group,
      recurringFailures: [...failures.values()]
        .map((items) => ({
          job: items[0]!.job.name,
          conclusion: items[0]!.job.conclusion,
          runs: items.length,
          revisions: [...new Set(items.map(({ run }) => run.head_sha))],
          pullRequests: [
            ...new Set(items.flatMap(({ run }) => (run.pull_requests ?? []).map((p) => p.number))),
          ],
          branches: [...new Set(items.map(({ run }) => run.head_branch))],
          sources: items.map(({ run, job }) => ({
            runId: run.id,
            jobId: job.id,
            attempt: run.run_attempt,
            sha: run.head_sha,
            runUrl: run.html_url,
            jobUrl: job.html_url,
          })),
          interpretation:
            'Repeated job outcomes are observations, not proof of a shared root cause.',
        }))
        .sort((a, b) => b.runs - a.runs || a.job.localeCompare(b.job)),
      recoveryCandidates: rows
        .filter(
          (r) =>
            r.run_attempt > 1 &&
            r.conclusion === 'success' &&
            firstAttempts.get(r.id)?.conclusion === 'failure',
        )
        .map((r) => ({
          runId: r.id,
          sha: r.head_sha,
          url: r.html_url,
          interpretation:
            'Failure followed by success on the same run; inspect attempt evidence before classifying flakiness.',
        })),
      missingJobRuns: rows.filter((r) => !jobs.has(r.id)).map((r) => r.id),
      runs: rows.length,
      completed: completed.length,
      pending: rows.length - completed.length,
      outcomes: Object.fromEntries(
        [...new Set(completed.map((r) => r.conclusion ?? 'unknown'))].map((c) => [
          c,
          completed.filter((r) => (r.conclusion ?? 'unknown') === c).length,
        ]),
      ),
      firstAttempt: {
        known: first.length,
        eligible: completedFirst.length,
        success: completedFirst.filter((r) => r.conclusion === 'success').length,
        successRate: completedFirst.length
          ? completedFirst.filter((r) => r.conclusion === 'success').length / completedFirst.length
          : null,
      },
      repeatedRuns: rows.filter((r) => r.run_attempt > 1).length,
      additionalAttempts: rows.reduce((sum, r) => sum + r.run_attempt - 1, 0),
      wallTime: distribution(durations),
      initialQueueTime: distribution(waits),
      excludedDurations: completed.length - durations.length,
      sources: rows.map((r) => ({
        id: r.id,
        url: r.html_url,
        sha: r.head_sha,
        attempt: r.run_attempt,
      })),
      failingJobs: rows.flatMap((r) =>
        (jobs.get(r.id) ?? [])
          .filter((j) => ['failure', 'timed_out', 'action_required'].includes(j.conclusion ?? ''))
          .map((j) => ({ runId: r.id, name: j.name, conclusion: j.conclusion, url: j.html_url })),
      ),
    };
  });
}
