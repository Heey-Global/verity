import { createEmbeddedDb } from '@verity/store/testing';

import { buildEmbeddedServer, type EmbeddedServer, type EmbeddedServerConfig } from './embedded.js';

/**
 * TEST-ONLY: {@link buildEmbeddedServer} wired to the hermetic in-process pglite
 * (in-memory, or file-backed when `dataDir` is set).
 *
 * The production wiring only knows how to open PostgreSQL and throws without a
 * `databaseUrl`, so the WASM Postgres the suite runs on is injected here instead
 * of being an implicit fallback inside `embedded.ts`. That is what lets pglite
 * be a devDependency: this module is the only place in `@verity/server` that
 * reaches for it, and nothing on the runtime import graph reaches for this
 * module.
 *
 * The startup transcript sweep is OFF unless a test asks for it. A test that sets
 * `dataVolumeRoot` is describing a runner layout, not asking for anything under it to be
 * deleted — and the sweep removes `.jsonl` files under `runners/`, so a test pointed at a
 * fixture or a shared volume could otherwise destroy data that has nothing to do with it.
 * The sweep's own tests call `sweepOrphanArtifacts` directly.
 */
export function buildTestEmbeddedServer(
  config: EmbeddedServerConfig = {},
): Promise<EmbeddedServer> {
  return buildEmbeddedServer({
    openDatabase: (resolved) => createEmbeddedDb(resolved.dataDir),
    ...config,
    // After the spread, not before it: a config object built with optional fields can
    // carry an explicit `transcriptSweep: undefined`, which would spread over a default
    // placed above and quietly turn a file-deleting sweep back on.
    transcriptSweep: config.transcriptSweep ?? 'off',
  });
}
