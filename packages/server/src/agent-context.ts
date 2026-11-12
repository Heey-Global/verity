import { AGENT_CORE_PROMPT, AGENT_SKILL_CATALOG, AGENT_SKILL_MANIFEST_HASH } from '@verity/events';
import { connectorToolAvailable } from './agent-tool-availability.js';
import type { GatewayToolName } from '@verity/secret-contracts';
import { createHash } from 'node:crypto';
import type { EventStore, SessionRecord } from '@verity/store';
import { readProjectInstructions } from './project-instructions.js';

/** Facts are labeled separately; context text never grants execution authority. */
export async function resolveAgentContext(
  store: EventStore,
  dataRoot: string,
  session: SessionRecord,
  projectMemory: (id: string) => Promise<string | undefined>,
  compact = false,
  initiatedBy?: { userId: string },
) {
  const running = (await store.listRunningTurns()).find(
    (turn) => turn.sessionId === session.sessionId,
  );
  const prompt = running
    ? (await store.getEventsAfter(session.sessionId, running.promptSeq - 1, 1)).find(
        (row) => row.seq === running.promptSeq,
      )?.event
    : undefined;
  const userId =
    initiatedBy?.userId ?? (prompt?.t === 'prompt' ? prompt.initiatedBy?.userId : undefined);
  const user = userId ? await store.userContext.read(userId) : undefined;
  const project = session.projectId
    ? await readProjectInstructions(dataRoot, session.projectId)
    : undefined;
  const memory = session.projectId ? await projectMemory(session.projectId) : undefined;
  const sections = [
    user?.instructions ? `## User Instructions\n${user.instructions}` : '',
    project?.instructions
      ? `## Project Instructions (apply to every agent in this project; a repository's own AGENTS.md adds rules for work in that repository)\n${project.instructions}`
      : '',
    user?.memory ? `## User Memory (facts; may be stale, verify)\n${user.memory}` : '',
    memory ? `## Project Memory (facts; may be stale, verify)\n${memory}` : '',
  ].filter(Boolean);
  const connectors: GatewayToolName[] = [
    'verity_gmail',
    'verity_google_calendar',
    'verity_google_contacts',
    'verity_google_drive',
    'verity_google_docs',
    'verity_google_sheets',
    'verity_google_slides',
    'verity_matrix',
    'verity_scheduling',
  ];
  const catalog: boolean[] = [];
  if (session.projectId)
    for (const toolName of connectors)
      catalog.push(
        await connectorToolAvailable(store, {
          projectId: session.projectId,
          sessionId: session.sessionId,
          toolName,
          userId,
        }),
      );
  const body = sections.length ? `\n\n${sections.join('\n\n')}` : '';
  return {
    prompt: body,
    compact,
    fingerprint:
      (compact ? 'v2:canonical:' : 'v2:legacy:') +
      createHash('sha256')
        .update(
          JSON.stringify([
            userId ?? null,
            user?.revision ?? 0,
            project?.revision ?? null,
            compact,
            compact ? [AGENT_CORE_PROMPT, AGENT_SKILL_CATALOG, AGENT_SKILL_MANIFEST_HASH] : null,
            catalog,
            body,
          ]),
        )
        .digest('hex'),
  };
}
