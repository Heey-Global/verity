import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('publishes the configured local preview range for both deployment owners', () => {
  const compose = parse(readFileSync('deploy/docker-compose.yml', 'utf8')) as {
    services: Record<string, { ports: string[]; environment: Record<string, string> }>;
  };
  // Internal HTTP success hides a gateway range that Docker never publishes.
  for (const owner of ['verity', 'verity-managed-gateway']) {
    const service = compose.services[owner]!;
    const range = service.environment.VERITY_LOCAL_PREVIEW_PORT_RANGE!;
    expect(range).toBeDefined();
    expect(service.ports).toContain(
      `${service.environment.VERITY_LOCAL_PREVIEW_BIND_ADDRESS}:${range}:${range}`,
    );
  }
});
