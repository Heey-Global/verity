import type { FastifyInstance } from 'fastify';
import { SealedError } from '@verity/store';
import type { ServerDeps } from './server.js';
import type {
  DopplerValidateResult,
  DopplerProjectSummary,
  DopplerConfigSummary,
} from './doppler-token.js';

export type DopplerRouteDeps = Pick<
  ServerDeps,
  | 'secretCipher'
  | 'dopplerCredentialReader'
  | 'dopplerValidate'
  | 'dopplerListProjects'
  | 'dopplerListConfigs'
>;

export function registerDopplerRoutes(app: FastifyInstance, deps: DopplerRouteDeps): void {
  // `POST /doppler/validate` — a "does this Doppler Service Account token actually
  // work" check the onboarding wizard's OPTIONAL Doppler step uses. Requires the
  // cipher UNSEALED (the token must decrypt). It NEVER returns/logs the token: on
  // success it optionally echoes a SAFE project count; on failure a fixed, redacted
  // message. Always resolves — sealed/not-configured are `{ ok: false, error }`,
  // not thrown errors. Mirrors `/github/app/validate`.
  app.post('/doppler/validate', async (): Promise<DopplerValidateResult> => {
    if (deps.dopplerValidate === undefined) return { ok: false, error: 'not configured' };
    const resolved = await withDopplerAccountToken(deps.dopplerValidate);
    return 'error' in resolved ? { ok: false, error: resolved.error } : resolved.value;
  });

  // Shared account-token resolver for the two Doppler LIST routes (#320, binding
  // picker). Returns either the decrypted account token or a redacted failure
  // envelope — NEVER throws for the sealed/not-configured cases (mirrors
  // `/doppler/validate`). The token itself never leaves this helper except as the
  // returned `{ token }`; callers pass it straight to the injected seam and
  // return only NON-secret list data.
  const withDopplerAccountToken = async <T>(
    use: (token: string) => Promise<T>,
  ): Promise<{ value: T } | { error: string }> => {
    if (deps.secretCipher?.isSealed() === true) return { error: 'locked' };
    if (deps.dopplerCredentialReader === undefined) return { error: 'not configured' };
    let credential: Uint8Array | undefined;
    try {
      credential = await deps.dopplerCredentialReader();
    } catch (err) {
      if (err instanceof SealedError) return { error: 'locked' };
      throw err;
    }
    if (credential === undefined) return { error: 'not configured' };
    try {
      let token: string;
      try {
        token = new TextDecoder('utf-8', { fatal: true }).decode(credential).trim();
      } catch {
        return { error: 'not configured' };
      }
      if (token.length === 0 || token.includes('\0')) return { error: 'not configured' };
      return { value: await use(token) };
    } finally {
      credential.fill(0);
    }
  };

  // `GET /doppler/projects` — list the account's Doppler projects for the binding
  // picker (#320). The list is derived from the TRUSTED account token (decrypted
  // here, unsealed-only), NOT from repo content — this is what closes the
  // confused-deputy (a repo cannot enumerate another project's Doppler projects).
  // Never returns/logs the token; only NON-secret `{ slug, name }` summaries.
  // Sealed → `{ error: 'locked' }`; token missing / no seam → `{ error: 'not
  // configured' }`; a redacted-throw from the seam → `{ error: <redacted> }`.
  app.get(
    '/doppler/projects',
    async (): Promise<{ projects: DopplerProjectSummary[] } | { error: string }> => {
      if (deps.dopplerListProjects === undefined) return { error: 'not configured' };
      try {
        const resolved = await withDopplerAccountToken(deps.dopplerListProjects);
        return 'error' in resolved ? resolved : { projects: resolved.value };
      } catch (err) {
        // The seam's throw is contractually redacted (fixed status-keyed message,
        // never the token/body). Surface that message; a non-Error degrades to a
        // generic string so nothing unexpected leaks.
        return { error: err instanceof Error ? err.message : 'could not list Doppler projects' };
      }
    },
  );

  // `GET /doppler/configs?project=<project>` — list a Doppler project's configs
  // for the binding picker (#320). Same trust model + redaction contract as
  // `/doppler/projects`. `project` is REQUIRED (the slug from `/doppler/projects`).
  app.get(
    '/doppler/configs',
    async (request): Promise<{ configs: DopplerConfigSummary[] } | { error: string }> => {
      const query = request.query as { project?: unknown };
      const project = typeof query.project === 'string' ? query.project : '';
      if (project.length === 0) return { error: 'project is required' };
      if (deps.dopplerListConfigs === undefined) return { error: 'not configured' };
      try {
        const resolved = await withDopplerAccountToken((token) =>
          deps.dopplerListConfigs!(token, project),
        );
        return 'error' in resolved ? resolved : { configs: resolved.value };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'could not list Doppler configs' };
      }
    },
  );
}
