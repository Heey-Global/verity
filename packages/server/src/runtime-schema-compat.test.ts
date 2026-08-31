import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeSchemaForwardMax } from './runtime-schema-compat.js';

describe('runtime schema forward compatibility', () => {
  it('defaults to the build current generation when no immutable promise exists', () => {
    const missing = (): string => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(runtimeSchemaForwardMax('0079_control_plane_generation_fence', missing)).toBe(
      '0079_control_plane_generation_fence',
    );
  });

  it('accepts a later stamped migration generation', () => {
    expect(runtimeSchemaForwardMax('0079_current', () => '0082_future\n')).toBe('0082_future');
  });

  it.each(['0078_older', 'not-a-generation', '0082_UPPERCASE'])(
    'rejects invalid immutable promise %s',
    (value) => {
      expect(() => runtimeSchemaForwardMax('0079_current', () => value)).toThrow(/invalid schema/);
    },
  );

  /**
   * Read off the source because `main.ts` is a composition root with no seam and
   * no coverage (see `vitest.config.ts`), and a promise the startup migrator is
   * never handed is not a weaker promise — it is none at all. Dropping the
   * argument leaves every unit test below green while the only thing the stamp
   * exists for, starting a bridge build on the database the generation it rolled
   * back FROM already migrated, silently stops working.
   *
   * Both call sites, because one Server start runs both: `main.ts` migrates for
   * the control-plane claim and `buildEmbeddedServer` migrates again for the
   * wiring. A promise honoured at only one of them is the identical crash, one
   * stack frame later.
   */
  it.each(['main.ts', 'embedded.ts'])('hands the promise to the migrator in %s', async (file) => {
    const source = await readFile(resolve(import.meta.dirname, file), 'utf8');
    expect(source).toMatch(
      /migrateToLatest\(\s*db,\s*migrationProvider,\s*\{\s*forwardMax:\s*SERVER_COMPAT\.schema\.max\s*,?\s*\}\s*\)/,
    );
  });
});
