import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const PAIRS = [
  'features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker',
  'features/verity-sandbox-toolkit/bin/verity-egress-connector',
] as const;

const runtimeExports = (source: string): Set<string> =>
  new Set(
    [
      ...source.matchAll(
        /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gmu,
      ),
    ].map((match) => match[1] as string),
  );

describe('sandbox toolkit declarations', () => {
  it.each(PAIRS)('%s declares only runtime exports that exist', (stem) => {
    const declaration = readFileSync(`${stem}.d.mts`, 'utf8');
    const runtime = runtimeExports(readFileSync(`${stem}.mjs`, 'utf8'));
    const promised = [
      ...declaration.matchAll(
        /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gmu,
      ),
    ].map((match) => match[1] as string);

    expect(
      promised.filter((name) => !runtime.has(name)),
      'a handwritten declaration promises named exports that the JavaScript module does not provide',
    ).toEqual([]);
  });
});
