import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

it('has no writer into `events` that sources `type` anywhere but the parsed payload', async () => {
  // The test above proves the invariant for rows THIS suite wrote through
  // `appendEvent`. It cannot see the writer added next week. So read the
  // writers out of the source instead of listing them: every insert into
  // `events` anywhere in the repo has to take its `type` from the discriminant
  // of the payload it is storing in the same statement, because the overview's
  // SQL filter believes the column and every projection downstream believes
  // `payload.t`. A writer that disagreed would not fail — those events would
  // just stop existing as far as the badge, the token total and the limit
  // banner are concerned.
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const sources = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts'],
    { encoding: 'utf8', cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  )
    .split('\n')
    .filter(
      (path) => path.length > 0 && !path.endsWith('.test.ts') && existsSync(join(repoRoot, path)),
    );

  // The two spellings the repo uses: Kysely's builder and a raw statement.
  const insertPattern = /insertInto\(\s*'events'\s*\)|insert\s+into\s+events\b/g;
  // `event.t` and `eventRow.type` are read off a `parseAgentEvent` result;
  // `${type}` is the destructured half of `prepareEventRow`, which is the only
  // producer of both (asserted below). Anything else has to justify itself here.
  const fromPayload = /type:\s*(?:eventRow\.type|event\.t)\b|,\s*\$\{type\},/;
  let writers = 0;
  for (const path of sources) {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    if (source.match(insertPattern)) {
      for (const binding of source.matchAll(
        /const (?:eventRow|\{ type, payload \}) =\s*([^;]+);/g,
      )) {
        const initializer = binding[1]!.replace(/\s+/g, '');
        expect(initializer).toMatch(
          /^(?:awaitthis.prepareEventRow\(event\)|frame.event!==undefined\?awaitthis.prepareEventRow\(frame.event\):undefined|event===undefined\?undefined:awaitthis.prepareEventRow\(event\))$/,
        );
      }
    }
    for (const match of source.matchAll(insertPattern)) {
      writers += 1;
      const statement = source.slice(match.index, match.index + 400);
      expect(statement, `${path} writes \`events.type\` from something else`).toMatch(fromPayload);
    }
  }
  // The scan finding nothing would pass vacuously, which is the one way a
  // pattern-based guard rots without saying so.
  expect(writers).toBeGreaterThanOrEqual(3);
});
