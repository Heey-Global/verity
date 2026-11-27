import type { EventStore, QAIssue } from '@verity/store';
import type { PushSender } from './push-sender.js';

const REASONS: Record<string, string> = {
  'rounds-exhausted': 'Repair stopped after the allowed rounds.',
  'beyond-mandate': 'This needs more than a repair within the mandate.',
  'emergency-brake': 'QA stopped all repairs.',
};

/**
 * QA pushes only when it needs the user: a stopped issue, to everyone who may
 * act in the project. Routine progress stays in the QA view.
 */
export async function pushQAStopped(
  store: EventStore,
  sender: PushSender | undefined,
  projectId: string,
  issues: readonly QAIssue[],
): Promise<void> {
  if (!sender || !issues.length) return;
  const project = await store.getProject(projectId);
  if (!project) return;
  const users = await store.listProjectUserIds(projectId, 'execute');
  const targets = await store.listDevicePushTokensForUsers(users);
  if (!targets.length) return;
  const name = project.name ?? project.repo;
  for (const issue of issues)
    await sender.send(
      {
        title: `QA · ${name}`,
        body: `${issue.key.replace(/^pr:/, 'PR #').replace(/^workflow:/, 'Workflow ')}: ${REASONS[issue.reason ?? ''] ?? 'Needs your decision.'}`,
        categoryId: 'QA_NEEDS_YOU',
        data: { kind: 'qa', projectId, issueId: issue.id },
        priority: 'high',
        sound: 'default',
      },
      targets,
    );
}

/** The emergency brake concerns the whole installation: the QA administrator decides. */
export async function pushQABrake(
  store: EventStore,
  sender: PushSender | undefined,
): Promise<void> {
  if (!sender) return;
  // The administrator who switched QA on is the one who can release the brake.
  const sponsor = (await store.repairs.qa()).sponsor;
  if (!sponsor || !(await store.isActiveAdministrator(sponsor))) return;
  const targets = await store.listDevicePushTokensForUsers([sponsor]);
  if (!targets.length) return;
  await sender.send(
    {
      title: 'QA · emergency brake',
      body: 'Repairs started unusually fast, so QA stopped starting new ones. Review QA in Settings.',
      categoryId: 'QA_NEEDS_YOU',
      data: { kind: 'qa', projectId: null },
      priority: 'high',
      sound: 'default',
    },
    targets,
  );
}
