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
    const documented = /POST (\/[A-Za-z0-9/<>_-]*recreate-container)/u.exec(runbook)?.[1];
    // Asserted separately from the route comparison: a runbook that stopped naming a
    // route at all is its own failure, and folding it into the comparison below would
    // report it as a missing route instead.
    expect(documented).toBeDefined();
    // The runbook writes the project id as a placeholder; the router writes it as a
    // Fastify parameter, whose NAME is the router's business. Everything else — every
    // literal segment, in order, from the root — is the path an operator types, so it
    // is compared as written. A registration that moves behind a plugin prefix fails
    // here, and should: the composed path is what the runbook has to print.
    // The literal segments are escaped before they become a pattern: they are prose,
    // and a path that acquired a regex metacharacter would otherwise be compared as a
    // pattern rather than as the characters an operator types.
    const escape = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
    const routed = new RegExp(
      `'${documented!.split('<projectId>').map(escape).join(':[A-Za-z][A-Za-z0-9_]*')}'`,
      'u',
    );

    const routes = await readFile(
      new URL('./project-concierge-routes.ts', import.meta.url),
      'utf8',
    );
    expect(routes).toMatch(routed);
  });
});
