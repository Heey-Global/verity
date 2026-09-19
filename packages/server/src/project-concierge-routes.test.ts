import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('project concierge routes', () => {
  // A runbook is read during the outage it describes, by an operator whose every
  // OpenCode turn is already failing, and this one offers exactly one remedy: the
  // recreate-container endpoint. A route that has since moved leaves that operator
  // with no working recovery and no way to tell a wrong path from a broken Server —
  // and nothing else in the repository would notice, because the runbook is prose.
  // So hold the prose to the router: the path in the document must be a path the
  // document's own Server actually registers.
  it('registers the recreation route its runbook sends operators to', async () => {
    const runbook = await readFile(
      new URL(
        '../../../docs/runbooks/opencode-brokered-tools-container-refresh.md',
        import.meta.url,
      ),
      'utf8',
    );
    const documented =
      /POST (\/[A-Za-z0-9/<>_-]*recreate-container)/u.exec(runbook)?.[1] ??
      'no POST route found in the runbook';
    // The runbook writes the project id as a placeholder; the router writes it as a
    // Fastify parameter. Compare the shape they agree on.
    const routed = documented.replace('<projectId>', ':id');

    const routes = await readFile(
      new URL('./project-concierge-routes.ts', import.meta.url),
      'utf8',
    );
    expect(routes).toContain(`'${routed}'`);
  });
});
