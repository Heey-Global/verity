import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('meeting transcription deployment', () => {
  it('retries a briefly unreachable backend without blocking Verity startup', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');

    expect(compose).toContain('VERITY_PARAKEET_RETRIES: ${VERITY_PARAKEET_RETRIES:-12}');
    expect(compose).toContain('VERITY_PARAKEET_HTTP_RETRIES: ${VERITY_PARAKEET_HTTP_RETRIES:-0}');
    expect(compose).toContain(
      'VERITY_PARAKEET_RETRY_DELAY_MS: ${VERITY_PARAKEET_RETRY_DELAY_MS:-5000}',
    );
    expect(compose).toContain('VERITY_MEETING_CHUNK_SECONDS: ${VERITY_MEETING_CHUNK_SECONDS:-300}');
    expect(compose).toContain(
      'VERITY_MEETING_CHUNK_OVERLAP_SECONDS: ${VERITY_MEETING_CHUNK_OVERLAP_SECONDS:-5}',
    );
    // Startup must not wait on transcription at all now that nothing local
    // provides it.
    expect(compose).not.toMatch(/verity-transcribe:\n\s+condition:/);
  });

  it('ships no bundled transcription service', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');

    // The regression guard for removing the local sidecar: no service, no
    // dependency, no local-backend environment, and no image to reserve 6 GiB
    // and two CPUs for a backend that sat idle.
    expect(compose).not.toMatch(/^ {2}verity-transcribe:$/m);
    expect(compose).not.toContain('verity-transcribe:5092');
    expect(compose).not.toContain('parakeet:latest');
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
    expect(server).toMatch(/^ {6}VERITY_PARAKEET_BASE_URL:/m);
    expect(server).not.toContain('VERITY_LOCAL_TRANSCRIBE_AVAILABLE');
    expect(server).not.toContain('VERITY_LOCAL_TRANSCRIBE_BASE_URL');
    expect(server).not.toContain('VERITY_LOCAL_TRANSCRIBE_MODEL');
  });

  it('leaves the transcription backend unconfigured unless the deployment sets one', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');

    // Unset must mean "not configured" — never a fallback to a service this
    // deployment no longer runs.
    expect(compose).toContain('VERITY_PARAKEET_BASE_URL: ${VERITY_TRANSCRIBE_BASE_URL:-}');
    expect(compose).toContain('VERITY_PARAKEET_API_KEY: ${VERITY_TRANSCRIBE_API_KEY:-}');
    expect(compose).toContain(
      'VERITY_PARAKEET_MODEL: ${VERITY_TRANSCRIBE_MODEL:-parakeet-tdt-0.6b}',
    );
    // Reachable from .env: without it, disabling windowing silently re-encodes
    // oversized recordings to 24 kbps instead of uploading them intact.
    expect(compose).toContain(
      'VERITY_PARAKEET_MAX_UPLOAD_BYTES: ${VERITY_TRANSCRIBE_MAX_UPLOAD_BYTES:-25000000}',
    );
  });
});
