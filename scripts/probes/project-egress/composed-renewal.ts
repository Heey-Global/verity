/** Disposable Server lifecycle process; SIGKILL must leave only the bounded kernel lease. */
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { ProjectEgressLifecycle } from '../../../packages/server/src/project-egress-lifecycle.js';
import { createProjectEgressHostClient } from '../../../packages/server/src/project-egress-host-client.js';
assert.equal(process.env.PROJECT_EGRESS_DISPOSABLE, 'yes');
const directory = process.env.PROBE_CONTROL_DIRECTORY!;
const command = createProjectEgressHostClient({
  socketPath: `${directory}/control.sock`,
  token: process.env.PROBE_CONTROL_TOKEN!,
  timeoutMs: 30000,
});
const lifecycle = new ProjectEgressLifecycle(async (request) => {
  const started = performance.now();
  let failure: string | undefined;
  try {
    return await command(request);
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    await appendFile(
      `${directory}/renewal-trace.jsonl`,
      JSON.stringify({
        operation: request.operation,
        pid: process.pid,
        durationMs: performance.now() - started,
        ...(failure === undefined ? {} : { failure }),
      }) + '\n',
    );
  }
}, {});
await lifecycle.connect({ projectId: 'host-smoke', containerGeneration: 'gen1' });
await writeFile(`${directory}/renewal-ready`, 'ready');
// Production renewal timers are unreferenced; the Server normally owns event-loop liveness.
setInterval(() => {}, 1000);
