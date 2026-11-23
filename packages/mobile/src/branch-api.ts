import { z } from 'zod';

export const mergeStateSchema = z
  .enum(['clean', 'dirty', 'blocked', 'behind', 'unstable', 'draft', 'unknown'])
  .optional()
  .catch(undefined);

export const pullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    phase: z.enum(['open', 'merged', 'closed']),
    updatedAt: z.string().optional(),
    headSha: z.string().optional(),
    pipeline: z.enum(['pending', 'running', 'success', 'failure', 'unknown']),
    checks: z.object({
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      successful: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
    // Tri-state; see sessionPrSchema.mergeable. null = unknown, not "blocked".
    viewerCanMerge: z.boolean().optional(),
    mergeable: z.boolean().nullable().catch(null),
    // See sessionPrSchema.mergeState — `'dirty'` drives the conflict UI.
    mergeState: mergeStateSchema,
    // The PR's base branch, so the conflict line can name it ("conflicts with main").
    baseRef: z.string().min(1).optional(),
  })
  .nullable();

/** Response of `GET /sessions/:id/branches`: the worktree's current branch, the
 * local branches it can switch to (#91), and the pushed `origin/*` branches it can
 * PREVIEW live (#122 — incl. ones a sibling worktree is developing). `previewable`
 * is OPTIONAL on the wire so an app newer than the server still parses (absent →
 * no preview rows). */
const branchCodeHostSchema = z.object({
  provider: z.literal('forgejo'),
  baseUrl: z.string().min(1),
});

/** A code host this client does not know: since an absent `codeHost` means
 *  GitHub, keeping its owner/repo would link the chips to an unrelated GitHub
 *  repository. Dropping all three leaves them unlinked and the list parseable. */
function withKnownCodeHost(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('codeHost' in raw)) return raw;
  const { codeHost, owner, repo, ...rest } = raw as Record<string, unknown>;
  if (codeHost === undefined || branchCodeHostSchema.safeParse(codeHost).success) return raw;
  void owner;
  void repo;
  return rest;
}

const sessionPullRequestStatusSchema = pullRequestSchema.unwrap().extend({
  observationFailed: z.boolean().optional(),
  repository: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    codeHost: z
      .union([
        branchCodeHostSchema,
        z.object({ provider: z.literal('github'), baseUrl: z.string().min(1) }),
      ])
      .optional()
      .catch(undefined),
    isDefault: z.boolean(),
  }),
});
export type SessionPullRequestStatus = z.infer<typeof sessionPullRequestStatusSchema>;

export const branchListSchema = z.preprocess(
  withKnownCodeHost,
  z.object({
    current: z.string(),
    switchable: z.array(z.string()),
    previewable: z.array(z.string()).optional(),
    // True when the session record/history still exists but its workspace was
    // intentionally cleaned up after merge/archive. Branch controls should go inert
    // without surfacing a transport error.
    workspaceMissing: z.boolean().optional(),
    // The open PR number for the CURRENT branch, looked up from GitHub (#125). `null`
    // = looked up, no open PR; ABSENT = the server is older OR GitHub isn't configured
    // (no token/remote) — both render as "no PR chip", independent of the issue chip.
    currentPr: z.number().int().positive().nullable().optional(),
    pullRequest: pullRequestSchema.optional(),
    pullRequests: z.array(sessionPullRequestStatusSchema).nullable().optional(),
    // The project repo's GitHub `owner`/`repo` (#161), from the server's `origin`-remote
    // parse — lets the header build tappable Issue/PR chip URLs. Both OPTIONAL: ABSENT =
    // older server OR no GitHub remote, in which case the chips stay non-tappable rather
    // than linking to a broken URL. They travel together (the server sets both or
    // neither), but each is independently optional for forward/back-compat.
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    // The web host for those chips when it is not GitHub (a Forgejo project).
    // ABSENT = GitHub, or a server predating Forgejo. See `withKnownCodeHost` for a
    // host this client does not know.
    codeHost: branchCodeHostSchema.optional(),
    // Present ONLY for a project without a GitHub repository, where there is no pull
    // request to merge: `base` names the branch this session's work can be merged into
    // locally. ABSENT = merging goes through the PR strip (or the server is older).
    localMerge: z
      .object({ base: z.string().min(1), hasChanges: z.boolean().optional() })
      .optional(),
  }),
);
export type BranchList = z.infer<typeof branchListSchema>;
