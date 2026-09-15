import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('meeting transcription deployment', () => {
  it('keeps transcription policy out of deployment configuration', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');
    expect(compose).not.toMatch(/^ {6}VERITY_(?:TRANSCRIBE|MEETING)_/m);
    expect(compose).not.toMatch(/verity-transcribe:\n\s+condition:/);
  });

  it('ships no bundled transcription service', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');

    // The regression guard for removing the local sidecar: no service, no
    // dependency, no local-backend environment, and no image to reserve 6 GiB
    // and two CPUs for a backend that sat idle.
    expect(compose).not.toMatch(/^ {2}verity-transcribe:$/m);
    expect(compose).not.toContain('verity-transcribe:5092');
    expect(compose).not.toContain('transcription-service:latest');
    expect(compose).not.toContain('VERITY_TRANSCRIBE_MEMORY');
    expect(compose).not.toContain('VERITY_TRANSCRIBE_CPUS');

    // Scoped to the Server's own environment rather than the whole file. What this
    // guards is that no Server is configured for a local backend — and the Server
    // is given exactly this block. The same names DO survive as empty values under
    // `verity-updater`, which is not configuration: a deployment sealed before the
    // sidecar was removed still names them as env sources, and the Updater has to
    // resolve every source on every reconcile or it crash-loops. See
    // `self-update/managed-topology-deployment.test.ts`, which pins that half.
    const server = compose.slice(
      compose.indexOf('environment: &verity-server-environment'),
      compose.indexOf('\n    volumes:'),
    );
    expect(server).not.toMatch(/^ {6}VERITY_TRANSCRIBE_/m);
    expect(server).not.toContain('VERITY_LOCAL_TRANSCRIBE_AVAILABLE');
    expect(server).not.toContain('VERITY_LOCAL_TRANSCRIBE_BASE_URL');
    expect(server).not.toContain('VERITY_LOCAL_TRANSCRIBE_MODEL');
  });

  it('takes provider configuration only from encrypted Settings', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');
    expect(compose).not.toContain('VERITY_TRANSCRIBE_BASE_URL');
    const server = await readFile('packages/server/src/server.ts', 'utf8');
    expect(server).not.toContain('process.env.VERITY_TRANSCRIBE_BASE_URL');
    expect(server).not.toContain('process.env.VERITY_MEETING_TRANSCRIBE_COMMAND');
  });
});
