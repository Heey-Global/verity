import type { FastifyInstance } from 'fastify';
import {
  SealedError,
  type EventStore,
  type SealableSecretCipher,
  type VeritySettingsPatch,
  type VeritySettingsRecord,
} from '@verity/store';
import type { AuthTokenRegistry } from './auth.js';
import {
  buildManifest,
  createManifestStateStore,
  escapeHtml,
  type ManifestConvert,
  type ManifestStateStore,
} from './github-manifest.js';

interface GitHubManifestRouteStore extends EventStore {
  getVeritySettingsRaw(): Promise<VeritySettingsRecord | undefined>;
  updateVeritySettings(patch: VeritySettingsPatch): Promise<VeritySettingsRecord>;
}

function hasManifestRouteStore(store: EventStore): store is GitHubManifestRouteStore {
  return (
    'getVeritySettingsRaw' in store &&
    typeof store.getVeritySettingsRaw === 'function' &&
    'updateVeritySettings' in store &&
    typeof store.updateVeritySettings === 'function'
  );
}

function manifestRouteStore(store: EventStore): GitHubManifestRouteStore {
  if (!hasManifestRouteStore(store)) {
    throw new Error('verity settings store methods are not available');
  }
  return store;
}

function configured(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function githubAppConfiguredFromSettings(settings: VeritySettingsRecord | undefined): boolean {
  return (
    configured(settings?.githubAppId) &&
    configured(settings?.githubAppInstallationId) &&
    configured(settings?.githubAppPrivateKey)
  );
}

export interface GitHubManifestRouteDeps {
  eventStore: EventStore;
  authRegistry?: AuthTokenRegistry | undefined;
  secretCipher?: SealableSecretCipher | undefined;
  manifestConvert?: ManifestConvert | undefined;
  manifestStateNow?: (() => number) | undefined;
}

/** Registers the browser-based GitHub App manifest onboarding state machine. */
export function registerGitHubManifestRoutes(
  app: FastifyInstance,
  deps: GitHubManifestRouteDeps,
): void {
  // ── GitHub-App manifest one-click onboarding (#320) ───────────────────────
  // Three browser-facing endpoints implement GitHub's "create App from manifest"
  // flow, which needs TWO round-trips: create (→ app id + PEM) then install
  // (→ installation id). The mobile app opens `start` in a browser and later
  // polls `GET /settings` for `githubAppConfigured`; those app-side pieces are a
  // separate PR. Security invariants held across all three routes:
  //   • the PEM / app id NEVER appear in any HTML body or log — the success path
  //     after conversion is a 302 redirect, carrying nothing secret;
  //   • the `state` token is single-use + TTL-bounded (CSRF defence on callback);
  //   • every interpolated value is HTML-escaped (no injection into the pages).
  const manifestState: ManifestStateStore = createManifestStateStore(
    deps.manifestStateNow ? { now: deps.manifestStateNow } : {},
  );
  // Separate single-use tokens that authenticate `GET /github/app/manifest/start`
  // (audit C1 follow-up). `start` is opened in a browser (no Authorization
  // header), so the authenticated app first calls `POST /github/app/manifest/prepare`
  // (bearer-gated) to mint one and hangs it on the start URL. This closes the
  // first-run credential-injection window: without a valid token an attacker can't
  // even START the manifest flow to inject their own App. Shorter TTL than the CSRF
  // state — the app opens the browser immediately after preparing.
  const manifestStartTokens: ManifestStateStore = createManifestStateStore({
    ...(deps.manifestStateNow ? { now: deps.manifestStateNow } : {}),
    ttlMs: 10 * 60 * 1000,
  });
  const manifestStartBases = new Map<string, string>();

  // Browser-facing GitHub onboarding pages. Text is caller-supplied but always a
  // fixed, non-secret string chosen at the call site (never GitHub body / PEM).
  const manifestPage = ({
    title,
    eyebrow = 'Verity GitHub setup',
    message,
    detail,
    body = '',
  }: {
    title: string;
    eyebrow?: string;
    message: string;
    detail?: string | undefined;
    body?: string | undefined;
  }): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>` +
    `:root{color-scheme:dark;--bg:#050509;--panel:#111121;--panel2:#17162b;--border:#342a68;--text:#f4f2ff;--muted:#b9b3d9;--faint:#817aa7;--accent:#ff35ce;--blue:#31aef4;}` +
    `*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0%,#20143e 0,#050509 36rem);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;padding:32px 18px;}` +
    `.shell{width:min(640px,100%);}.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px;color:var(--muted);font-weight:800;letter-spacing:.02em}.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--blue));box-shadow:0 0 28px rgba(255,53,206,.24)}` +
    `.card{border:1px solid var(--border);background:linear-gradient(180deg,var(--panel2),var(--panel));border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.42)}.eyebrow{margin:0 0 10px;color:var(--faint);font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.08em}h1{margin:0 0 14px;font-size:clamp(32px,7vw,52px);line-height:1.04;letter-spacing:0}p{margin:0;color:var(--muted);font-size:18px;line-height:1.5}.detail{margin-top:14px;color:var(--faint);font-size:15px}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.button{appearance:none;border:0;border-radius:999px;background:var(--accent);color:#08060d;display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;font-size:16px;font-weight:900;text-decoration:none;cursor:pointer}.button.secondary{border:1px solid var(--border);background:transparent;color:var(--text)}form{margin:0}.spinner{width:18px;height:18px;border:2px solid rgba(8,6,13,.25);border-top-color:#08060d;border-radius:50%;animation:spin 1s linear infinite;margin-right:10px}@keyframes spin{to{transform:rotate(360deg)}}` +
    `</style></head><body><main class="shell"><div class="brand"><div class="logo"></div><span>Verity</span></div><section class="card">` +
    `<p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(message)}</p>` +
    (detail !== undefined ? `<p class="detail">${escapeHtml(detail)}</p>` : '') +
    body +
    `</section></main></body></html>`;

  const isHttpUrl = (value: string): boolean => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  };

  // `POST /github/app/manifest/prepare` — authenticated (NOT in the pre-auth
  // allowlist): mint a single-use token the app hangs on the `start` URL it opens
  // in the browser. This is how `start` gets authenticated despite being a
  // browser navigation that carries no Authorization header.
  app.post('/github/app/manifest/prepare', (request, reply): { startToken: string } | void => {
    const body = request.body as { baseUrl?: unknown } | undefined;
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl : '';
    if (!isHttpUrl(baseUrl)) {
      reply.code(400).send({ error: 'a valid http(s) baseUrl is required' });
      return;
    }
    const startToken = manifestStartTokens.issueState();
    manifestStartBases.set(startToken, baseUrl);
    return { startToken };
  });

  // `GET /github/app/manifest/start` — issue a CSRF state and render an auto-
  // submitting form that POSTs the manifest to GitHub's App-creation page.
  // `base` is REQUIRED (must be a http(s) URL — it's the public origin GitHub
  // redirects back to); `owner` (optional org login) targets an org App instead
  // of a personal one. Every interpolated value is escaped.
  app.get('/github/app/manifest/start', async (request, reply): Promise<string> => {
    const query = request.query as { base?: unknown; owner?: unknown; ott?: unknown };
    // Auth for the browser-opened start (audit C1 follow-up): once the API gate is
    // armed, require a valid single-use token minted by the authenticated
    // `/prepare` — so only the operator's app can begin the manifest flow. When
    // the gate is off (env-key/headless), preserve the previous open behaviour.
    let base: string;
    if (deps.authRegistry?.isEnabled() === true) {
      const ott = typeof query.ott === 'string' ? query.ott : '';
      const validStartToken = ott.length > 0 && manifestStartTokens.consumeState(ott);
      const preparedBase = ott.length > 0 ? manifestStartBases.get(ott) : undefined;
      if (ott.length > 0) manifestStartBases.delete(ott);
      if (!validStartToken) {
        reply.code(403).type('text/html; charset=utf-8');
        return manifestPage({
          title: 'Onboarding link expired',
          message:
            'This GitHub App onboarding link is invalid or has expired. Return to Verity and start again.',
          detail:
            'Open the Verity app, choose Create GitHub App again, and a fresh link will be generated.',
        });
      }
      if (preparedBase === undefined) {
        reply.code(403).type('text/html; charset=utf-8');
        return manifestPage({
          title: 'Onboarding link expired',
          message:
            'This GitHub App onboarding link is invalid or has expired. Return to Verity and start again.',
        });
      }
      base = preparedBase;
    } else {
      // In headless/gate-off deployments no authenticated prepare step exists.
      // Derive the callback authority from the request rather than accepting a
      // caller-selected redirect target.
      const requestedBase = typeof query.base === 'string' ? query.base : '';
      if (!isHttpUrl(requestedBase)) {
        reply.code(400).type('text/html; charset=utf-8');
        return manifestPage({
          title: 'Invalid request',
          message: 'A valid http(s) "base" URL is required to start GitHub App onboarding.',
          detail: 'Return to Verity and check the server address before trying again.',
        });
      }
      base = `${request.protocol}://${request.hostname}`;
    }
    const owner = typeof query.owner === 'string' && query.owner.length > 0 ? query.owner : null;

    const state = manifestState.issueState();
    const action =
      owner !== null
        ? `https://github.com/organizations/${encodeURIComponent(
            owner,
          )}/settings/apps/new?state=${encodeURIComponent(state)}`
        : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    // The manifest is embedded as a single-quoted attribute value; escapeHtml
    // escapes the quote/angle brackets so the JSON can't break out.
    const manifestJson = JSON.stringify(buildManifest(base));

    reply.type('text/html; charset=utf-8');
    return manifestPage({
      title: 'Opening GitHub',
      message:
        'Verity is sending GitHub the App manifest with the permissions it needs for your repositories.',
      detail: 'If the redirect does not continue automatically, use the button below.',
      body:
        `<div class="actions">` +
        `<form action="${escapeHtml(action)}" method="post">` +
        `<input type="hidden" name="manifest" value='${escapeHtml(manifestJson)}'>` +
        `<button class="button" type="submit"><span class="spinner" aria-hidden="true"></span>Continue to GitHub</button>` +
        `</form></div>` +
        `<script>document.forms[0].submit()</script>`,
    });
  });

  // `GET /github/app/manifest/callback` — GitHub redirects here with `?code=&state=`
  // after the user confirms the App. Validate+consume the state (CSRF), require
  // the cipher UNSEALED (the PEM must encrypt to store), exchange the code via the
  // injected `manifestConvert`, persist app id + PEM, then 302 the browser to the
  // App's install page (the SECOND round-trip). The PEM / app id never appear in
  // the response or logs — success is a redirect to the public install URL.
  app.get('/github/app/manifest/callback', async (request, reply): Promise<string | undefined> => {
    const query = request.query as { code?: unknown; state?: unknown };
    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';

    const consumed = state.length > 0 && manifestState.consumeState(state);
    if (!consumed || code.length === 0) {
      // Invalid / expired / reused state (or no code) → no side effect at all.
      reply.code(400).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'Onboarding link expired',
        message:
          'This GitHub App onboarding link is invalid or has expired. Return to Verity and start again.',
        detail: 'No GitHub credentials were stored.',
      });
    }

    // Refuse-overwrite lock (audit C1 follow-up): if a GitHub App is already fully
    // connected, a fresh manifest flow must NOT silently replace it with someone
    // else's App (onboarding credential-injection). Re-connecting requires an
    // explicit, authenticated disconnect first. Raw (non-decrypting) read → works
    // while sealed too. Legacy env-configured Apps also count as connected.
    if (
      githubAppConfiguredFromSettings(
        await manifestRouteStore(deps.eventStore).getVeritySettingsRaw(),
      )
    ) {
      reply.code(409).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'GitHub connected',
        message:
          'A GitHub App is connected to this Verity. Return to Verity to continue, or disconnect it in Settings before connecting a different one.',
      });
    }

    if (deps.secretCipher?.isSealed() === true) {
      reply.code(503).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'Verity is locked',
        message:
          'Unlock Verity with your master password first, then start GitHub App onboarding again.',
      });
    }
    if (deps.manifestConvert === undefined) {
      reply.code(500).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'Not configured',
        message: 'GitHub App manifest onboarding is not configured on this Verity deployment.',
      });
    }

    let converted;
    try {
      converted = await deps.manifestConvert(code);
    } catch {
      // The convert seam throws only fixed, redaction-safe messages; we do not
      // surface even those to the browser — a generic page avoids leaking which
      // failure mode occurred.
      reply.code(502).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'GitHub App creation failed',
        message:
          'GitHub could not create the App from the manifest. Return to Verity and try again.',
      });
    }

    try {
      await manifestRouteStore(deps.eventStore).updateVeritySettings({
        githubAppId: converted.appId,
        githubAppPrivateKey: converted.privateKey,
      });
    } catch (err) {
      // A racing seal between the sealed-check and the write surfaces as
      // SealedError — degrade to the locked page rather than a 5xx.
      if (err instanceof SealedError) {
        reply.code(503).type('text/html; charset=utf-8');
        return manifestPage({
          title: 'Verity is locked',
          message:
            'Unlock Verity with your master password first, then start GitHub App onboarding again.',
        });
      }
      throw err;
    }

    // Second round-trip: send the browser to install the freshly-created App.
    // Issue a FRESH single-use state and pass it to the install URL — GitHub
    // echoes `state` on the post-install redirect to our `setup_url`, so the
    // `installed` callback is CSRF-gated too and a forged `installed` can't set an
    // arbitrary installation id. Only the public slug travels — no secret.
    const installState = manifestState.issueState();
    reply.redirect(
      `https://github.com/apps/${encodeURIComponent(converted.slug)}/installations/new` +
        `?state=${encodeURIComponent(installState)}`,
      302,
    );
    return undefined;
  });

  // `GET /github/app/manifest/installed` — GitHub's post-install redirect
  // (`setup_url`) lands here with `?installation_id=&setup_action=`. Persist the
  // installation id (the THIRD and final cred) → `githubAppConfigured` flips true.
  // Renders a minimal "return to Verity" page (with a deep-link nicety).
  app.get('/github/app/manifest/installed', async (request, reply): Promise<string> => {
    const query = request.query as { installation_id?: unknown; state?: unknown };
    const state = typeof query.state === 'string' ? query.state : '';
    const installationId =
      typeof query.installation_id === 'string' && query.installation_id.length > 0
        ? query.installation_id
        : null;

    // Sealed → can't encrypt the installation id to store it. Checked first (it's
    // side-effect-free and sealed-state isn't secret — /secret/status exposes it);
    // the write below is still gated by BOTH this and the CSRF state.
    if (deps.secretCipher?.isSealed() === true) {
      reply.code(503).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'Verity is locked',
        message:
          'Unlock Verity with your master password first, then finish GitHub App onboarding.',
      });
    }

    // CSRF gate: the `state` was minted at the end of `callback` and echoed by
    // GitHub on the post-install redirect. An unauthenticated caller can't set an
    // arbitrary installation id without a valid, single-use state.
    if (state.length === 0 || !manifestState.consumeState(state)) {
      reply.code(400).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'Onboarding link expired',
        message:
          'This GitHub App install link is invalid or has expired. Return to Verity and start again.',
        detail: 'No installation id was stored.',
      });
    }

    if (installationId === null) {
      reply.code(400).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'Installation incomplete',
        message: 'GitHub did not report an installation id. Return to Verity and start again.',
      });
    }

    // Refuse-overwrite lock (audit C1 follow-up), matching `callback`: never
    // replace an already-fully-connected App's installation id. A legitimate
    // first install reaches here with app id + PEM set but no installation id yet
    // (so not-yet-configured), and proceeds; a re-onboarding attempt is refused.
    if (
      githubAppConfiguredFromSettings(
        await manifestRouteStore(deps.eventStore).getVeritySettingsRaw(),
      )
    ) {
      reply.code(409).type('text/html; charset=utf-8');
      return manifestPage({
        title: 'GitHub connected',
        message:
          'A GitHub App is connected to this Verity. Return to Verity to continue, or disconnect it in Settings before connecting a different one.',
      });
    }

    try {
      await manifestRouteStore(deps.eventStore).updateVeritySettings({
        githubAppInstallationId: installationId,
      });
    } catch (err) {
      if (err instanceof SealedError) {
        reply.code(503).type('text/html; charset=utf-8');
        return manifestPage({
          title: 'Verity is locked',
          message:
            'Unlock Verity with your master password first, then finish GitHub App onboarding.',
        });
      }
      throw err;
    }

    reply.type('text/html; charset=utf-8');
    return manifestPage({
      title: 'GitHub App installed',
      eyebrow: 'GitHub connected',
      message: 'GitHub is now connected to Verity. Return to the app to continue setup.',
      detail: 'The Verity app will detect this automatically when you tap Check now.',
      body:
        `<div class="actions">` +
        `<a class="button" href="verity://onboarding/github">Return to Verity</a>` +
        `<a class="button secondary" href="https://github.com/settings/installations">View GitHub installation</a>` +
        `</div>`,
    });
  });
}
