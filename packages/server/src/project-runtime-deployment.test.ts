import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function verityEnvironment(compose: string): Map<string, string> {
  const serviceStart = compose.indexOf('  verity:\n');
  if (serviceStart < 0) throw new Error('verity service not found');
  const afterService = compose.slice(serviceStart + '  verity:\n'.length);
  const serviceEnd = afterService.search(/^ {2}\S/m);
  const service = serviceEnd < 0 ? afterService : afterService.slice(0, serviceEnd);
  const environmentHeader = /^ {4}environment:[^\n]*\n/m.exec(service);
  if (environmentHeader === null) throw new Error('verity environment not found');
  const afterEnvironment = service.slice(environmentHeader.index + environmentHeader[0].length);
  const environmentEnd = afterEnvironment.search(/^ {4}\S/m);
  const environment =
    environmentEnd < 0 ? afterEnvironment : afterEnvironment.slice(0, environmentEnd);
  return new Map(
    [...environment.matchAll(/^ {6}([A-Z0-9_]+):\s*(.*)$/gm)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
}

describe('project runtime deployment', () => {
  it('has no deployment switch for the always-on Dev Server runtime', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');
    expect(verityEnvironment(compose).has('VERITY_ENABLE_PROJECT_RUNTIME')).toBe(false);
    expect(await readFile('packages/server/src/main.ts', 'utf8')).toContain(
      'enableProjectRuntime: true',
    );
  });
});
