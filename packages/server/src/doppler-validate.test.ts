// Live Doppler token validation (#320, onboarding OPTIONAL step). Two layers:
//   1. `POST /doppler/validate` route: sealed → {ok:false,error:'locked'} (the
//      injected validator must NOT be called); not-configured → 'not configured';
//      injected-fake success → {ok:true, projectCount}; injected-fake failure →
//      {ok:false} with a redacted error; the token NEVER appears in the response.
//   2. `validateDopplerToken` (the real check used in production): a fake fetch
//      drives success + each failure status, asserting the token NEVER appears in
//      the returned result and no Doppler body is echoed.
import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { EventStore, createSealableSecretCipher, type SealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { validateDopplerToken, listDopplerProjects, listDopplerConfigs } from './doppler-token.js';
import type { HttpFetch, HttpResponse } from './github.js';

const conductor = {} as unknown as Conductor;

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

const PASSWORD = 'correct-horse-battery';
// Neutral fixture — NOT a real token and deliberately NOT `dp.`-shaped, so no
// secret-shaped literal lands in source (gitleaks). The route/validator treat the
// token as opaque bytes, so its shape doesn't affect what the leak assertions cover.
const TOKEN_FIXTURE = 'doppler-service-token-fixture-value';

function build(
  cipher: SealableSecretCipher,
  dopplerValidate?: (token: string) => Promise<{
    ok: boolean;
    projectCount?: number;
    error?: string;
  }>,
): FastifyInstance {
  const store = new EventStore(ctx.db, cipher);
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    dopplerCredentialReader: async () => {
      const token = (await store.getVeritySettings())?.dopplerServiceToken;
      return token ? Buffer.from(token, 'utf8') : undefined;
    },
    ...(dopplerValidate ? { dopplerValidate } : {}),
  });
}

/** Build a server wired with the two Doppler LIST seams (#320 binding picker). The
 *  seams are captured so tests can assert the decrypted account token is forwarded
 *  and never surfaced in the response. */
function buildWithList(
  cipher: SealableSecretCipher,
  seams: {
    dopplerListProjects?: (token: string) => Promise<Array<{ slug: string; name: string }>>;
    dopplerListConfigs?: (
      token: string,
      project: string,
    ) => Promise<Array<{ name: string; environment?: string; root?: boolean }>>;
  },
): FastifyInstance {
  const store = new EventStore(ctx.db, cipher);
  return buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    conductor,
    secretCipher: cipher,
    dopplerCredentialReader: async () => {
      const token = (await store.getVeritySettings())?.dopplerServiceToken;
      return token ? Buffer.from(token, 'utf8') : undefined;
    },
    ...(seams.dopplerListProjects ? { dopplerListProjects: seams.dopplerListProjects } : {}),
    ...(seams.dopplerListConfigs ? { dopplerListConfigs: seams.dopplerListConfigs } : {}),
  });
}

async function unlock(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/secret/init',
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
}

describe('POST /doppler/validate route', () => {
  it('returns {ok:false,error:"locked"} while the store is sealed (never throws, no validate call)', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const app = build(cipher, () => {
      called = true;
      return Promise.resolve({ ok: true });
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/doppler/validate' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: 'locked' });
      expect(called).toBe(false); // sealed → the validator must not run
    } finally {
      await app.close();
    }
  });

  it('returns {ok:false,error:"not configured"} when the token is missing', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher, () => Promise.resolve({ ok: true }));
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/doppler/validate' });
      expect(res.json()).toEqual({ ok: false, error: 'not configured' });
    } finally {
      await app.close();
    }
  });

  it('returns {ok:true, projectCount} when the injected validate succeeds', async () => {
    const cipher = createSealableSecretCipher();
    let seen: string | undefined;
    const app = build(cipher, (token) => {
      seen = token;
      return Promise.resolve({ ok: true, projectCount: 3 });
    });
    try {
      await unlock(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { dopplerServiceToken: TOKEN_FIXTURE },
      });
      const res = await app.inject({ method: 'POST', url: '/doppler/validate' });
      const body = res.json<{ ok: boolean; projectCount?: number; error?: string }>();
      expect(body).toEqual({ ok: true, projectCount: 3 });
      // The route decrypted + forwarded the stored token to the validator (the
      // store trims the stored value).
      expect(seen).toBe(TOKEN_FIXTURE);
      // The token must NEVER surface in the response.
      expect(JSON.stringify(body)).not.toContain(TOKEN_FIXTURE);
    } finally {
      await app.close();
    }
  });

  it('returns {ok:false} with a redacted error when the injected validate fails, without leaking the token', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher, () =>
      Promise.resolve({ ok: false, error: 'Doppler rejected the token' }),
    );
    try {
      await unlock(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { dopplerServiceToken: TOKEN_FIXTURE },
      });
      const res = await app.inject({ method: 'POST', url: '/doppler/validate' });
      const body = res.json<{ ok: boolean; error?: string }>();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Doppler rejected the token');
      expect(JSON.stringify(body)).not.toContain(TOKEN_FIXTURE);
    } finally {
      await app.close();
    }
  });

  it('reports "not configured" when no validator is wired', async () => {
    const cipher = createSealableSecretCipher();
    const app = build(cipher); // no dopplerValidate dep
    try {
      await unlock(app);
      const res = await app.inject({ method: 'POST', url: '/doppler/validate' });
      expect(res.json()).toEqual({ ok: false, error: 'not configured' });
    } finally {
      await app.close();
    }
  });
});

describe('validateDopplerToken (production check, faked transport)', () => {
  it('succeeds and lifts only the safe project count — never the token', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ projects: [{ id: 'a' }, { id: 'b' }] }),
      } as HttpResponse);
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: true, projectCount: 2 });
    expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
  });

  it('sends the token as a Bearer credential to the projects endpoint', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetch: HttpFetch = (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ projects: [] }),
      } as HttpResponse);
    };
    const result = await validateDopplerToken(TOKEN_FIXTURE, {
      fetch,
      apiBaseUrl: 'https://api.doppler.test',
    });
    expect(result).toEqual({ ok: true, projectCount: 0 });
    expect(seenUrl).toBe('https://api.doppler.test/v3/projects?page=1&per_page=100');
    expect(seenAuth).toBe(`Bearer ${TOKEN_FIXTURE}`);
  });

  it('maps 401 to a fixed redacted message (no Doppler body echoed)', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ messages: ['echo LEAK context'] }),
      } as HttpResponse);
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: false, error: 'Doppler rejected the token' });
    expect(JSON.stringify(result)).not.toContain('LEAK');
    expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
  });

  it('maps 403 to the same token-rejected message', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) } as HttpResponse);
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: false, error: 'Doppler rejected the token' });
  });

  it('maps an unexpected status to a generic message (no body echoed)', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ messages: ['boom LEAK'] }),
      } as HttpResponse);
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: false, error: 'Doppler returned an unexpected status (500)' });
    expect(JSON.stringify(result)).not.toContain('LEAK');
  });

  it('reports an unreachable-Doppler error on a transport failure', async () => {
    const fetch: HttpFetch = () => Promise.reject(new Error('boom'));
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: false, error: 'could not reach Doppler' });
  });

  it('succeeds without a count when the body is not a project list', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ unexpected: true }),
      } as HttpResponse);
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: true });
  });

  it('sums the count across pages when the first page comes back full', async () => {
    const seenUrls: string[] = [];
    const fetch: HttpFetch = (url) => {
      seenUrls.push(url);
      const page = seenUrls.length;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(page === 1 ? projectPage(1, 100) : projectPage(101, 7)),
      } as HttpResponse);
    };
    const result = await validateDopplerToken(TOKEN_FIXTURE, {
      fetch,
      apiBaseUrl: 'https://api.doppler.test',
    });
    expect(result).toEqual({ ok: true, projectCount: 107 });
    expect(seenUrls).toEqual([
      'https://api.doppler.test/v3/projects?page=1&per_page=100',
      'https://api.doppler.test/v3/projects?page=2&per_page=100',
    ]);
  });

  it('does not fetch a second page when the first one is short', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(1, 99)),
      } as HttpResponse);
    };
    expect(await validateDopplerToken(TOKEN_FIXTURE, { fetch })).toEqual({
      ok: true,
      projectCount: 99,
    });
    expect(calls).toBe(1);
  });

  it('uses one timeout budget for validation and all count pages', async () => {
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(calls * 100, 100)),
      };
    };
    expect(await validateDopplerToken(TOKEN_FIXTURE, { fetch, timeoutMs: 1 })).toEqual({
      ok: true,
    });
    expect(calls).toBe(1);
  });

  it('stays ok without a count when a later page is rejected', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(projectPage(1, 100)),
          } as HttpResponse)
        : Promise.resolve({
            ok: false,
            status: 403,
            json: () => Promise.resolve({ messages: ['echo LEAK context'] }),
          } as HttpResponse);
    };
    const result = await validateDopplerToken(TOKEN_FIXTURE, { fetch });
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain('LEAK');
    expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
  });

  it('stays ok without a count when a later page fails in transport', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(projectPage(1, 100)),
          } as HttpResponse)
        : Promise.reject(new Error('boom'));
    };
    expect(await validateDopplerToken(TOKEN_FIXTURE, { fetch })).toEqual({ ok: true });
  });

  it('stays ok without a count when the pages never run short', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(calls * 100, 100)),
      } as HttpResponse);
    };
    expect(await validateDopplerToken(TOKEN_FIXTURE, { fetch })).toEqual({ ok: true });
    expect(calls).toBe(101);
  });

  it('counts exactly 100 full pages when the guard probe is empty', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(calls * 100, calls <= 100 ? 100 : 0)),
      } as HttpResponse);
    };
    expect(await validateDopplerToken(TOKEN_FIXTURE, { fetch })).toEqual({
      ok: true,
      projectCount: 10_000,
    });
    expect(calls).toBe(101);
  });
});

// Binding picker (#320): list the account's Doppler projects + a project's configs
// from the TRUSTED account token. Two layers, same as the validator above:
//   1. `GET /doppler/projects` + `/doppler/configs` routes: sealed → 'locked' (the
//      injected seam must NOT run); not-configured; ok → the list; the account
//      token NEVER appears in the response.
//   2. `listDopplerProjects` / `listDopplerConfigs`: a fake fetch drives the shape
//      mapping + each failure status, asserting the token is never leaked and no
//      Doppler body is echoed on error.
describe('GET /doppler/projects route', () => {
  it('returns {error:"locked"} while sealed (never throws, no seam call)', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const app = buildWithList(cipher, {
      dopplerListProjects: () => {
        called = true;
        return Promise.resolve([]);
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/doppler/projects' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ error: 'locked' });
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns {error:"not configured"} when the account token is missing', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithList(cipher, { dopplerListProjects: () => Promise.resolve([]) });
    try {
      await unlock(app);
      const res = await app.inject({ method: 'GET', url: '/doppler/projects' });
      expect(res.json()).toEqual({ error: 'not configured' });
    } finally {
      await app.close();
    }
  });

  it('reports "not configured" when no seam is wired', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithList(cipher, {});
    try {
      await unlock(app);
      const res = await app.inject({ method: 'GET', url: '/doppler/projects' });
      expect(res.json()).toEqual({ error: 'not configured' });
    } finally {
      await app.close();
    }
  });

  it('forwards the decrypted account token and returns the list — never the token', async () => {
    const cipher = createSealableSecretCipher();
    let seen: string | undefined;
    const app = buildWithList(cipher, {
      dopplerListProjects: (token) => {
        seen = token;
        return Promise.resolve([{ slug: 'acme-app', name: 'Acme App' }]);
      },
    });
    try {
      await unlock(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { dopplerServiceToken: TOKEN_FIXTURE },
      });
      const res = await app.inject({ method: 'GET', url: '/doppler/projects' });
      const body = res.json<{ projects?: unknown; error?: string }>();
      expect(body).toEqual({ projects: [{ slug: 'acme-app', name: 'Acme App' }] });
      expect(seen).toBe(TOKEN_FIXTURE); // the route decrypted + forwarded it
      expect(JSON.stringify(body)).not.toContain(TOKEN_FIXTURE); // never in the response
    } finally {
      await app.close();
    }
  });

  it('surfaces a redacted seam error without leaking the token', async () => {
    const cipher = createSealableSecretCipher();
    const app = buildWithList(cipher, {
      dopplerListProjects: () => Promise.reject(new Error('Doppler rejected the token')),
    });
    try {
      await unlock(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { dopplerServiceToken: TOKEN_FIXTURE },
      });
      const res = await app.inject({ method: 'GET', url: '/doppler/projects' });
      const body = res.json<{ error?: string }>();
      expect(body).toEqual({ error: 'Doppler rejected the token' });
      expect(JSON.stringify(body)).not.toContain(TOKEN_FIXTURE);
    } finally {
      await app.close();
    }
  });
});

describe('GET /doppler/configs route', () => {
  it('returns {error:"project is required"} when the project query is missing', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const app = buildWithList(cipher, {
      dopplerListConfigs: () => {
        called = true;
        return Promise.resolve([]);
      },
    });
    try {
      await unlock(app);
      const res = await app.inject({ method: 'GET', url: '/doppler/configs' });
      expect(res.json()).toEqual({ error: 'project is required' });
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns {error:"locked"} while sealed (no seam call)', async () => {
    const cipher = createSealableSecretCipher();
    let called = false;
    const app = buildWithList(cipher, {
      dopplerListConfigs: () => {
        called = true;
        return Promise.resolve([]);
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/doppler/configs?project=acme-app' });
      expect(res.json()).toEqual({ error: 'locked' });
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('forwards token + project and returns configs — never the token', async () => {
    const cipher = createSealableSecretCipher();
    let seenToken: string | undefined;
    let seenProject: string | undefined;
    const app = buildWithList(cipher, {
      dopplerListConfigs: (token, project) => {
        seenToken = token;
        seenProject = project;
        return Promise.resolve([{ name: 'dev', environment: 'dev', root: true }]);
      },
    });
    try {
      await unlock(app);
      await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { dopplerServiceToken: TOKEN_FIXTURE },
      });
      const res = await app.inject({ method: 'GET', url: '/doppler/configs?project=acme-app' });
      const body = res.json<{ configs?: unknown }>();
      expect(body).toEqual({ configs: [{ name: 'dev', environment: 'dev', root: true }] });
      expect(seenToken).toBe(TOKEN_FIXTURE);
      expect(seenProject).toBe('acme-app');
      expect(JSON.stringify(body)).not.toContain(TOKEN_FIXTURE);
    } finally {
      await app.close();
    }
  });
});

interface ProjectPageEntry {
  slug: string;
  name: string;
}

/** A Doppler `GET /v3/projects` page of `count` well-formed entries, numbered from
 *  `start` so pages don't collide. `per_page=100` is what the helper asks for, so a
 *  page of exactly 100 is what makes it fetch another one. */
function projectPage(start: number, count: number): { projects: ProjectPageEntry[] } {
  return {
    projects: Array.from({ length: count }, (_, i) => ({
      slug: `p${String(start + i)}`,
      name: `Project ${String(start + i)}`,
    })),
  };
}

describe('listDopplerProjects (production check, faked transport)', () => {
  it('maps the Doppler project shape to slug/name summaries — never the token', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetch: HttpFetch = (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            projects: [
              { slug: 'acme-app', name: 'Acme App' },
              { slug: 'billing', name: 'Billing' },
            ],
          }),
      } as HttpResponse);
    };
    const result = await listDopplerProjects(TOKEN_FIXTURE, {
      fetch,
      apiBaseUrl: 'https://api.doppler.test',
    });
    expect(result).toEqual([
      { slug: 'acme-app', name: 'Acme App' },
      { slug: 'billing', name: 'Billing' },
    ]);
    expect(seenUrl).toBe('https://api.doppler.test/v3/projects?page=1&per_page=100');
    expect(seenAuth).toBe(`Bearer ${TOKEN_FIXTURE}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
  });

  it('walks pages until one comes back short and concatenates them', async () => {
    const seenUrls: string[] = [];
    const fetch: HttpFetch = (url) => {
      seenUrls.push(url);
      const page = seenUrls.length;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(page === 1 ? projectPage(1, 100) : projectPage(101, 3)),
      } as HttpResponse);
    };
    const result = await listDopplerProjects(TOKEN_FIXTURE, {
      fetch,
      apiBaseUrl: 'https://api.doppler.test',
    });
    expect(result).toHaveLength(103);
    expect(result[0]).toEqual({ slug: 'p1', name: 'Project 1' });
    expect(result[102]).toEqual({ slug: 'p103', name: 'Project 103' });
    expect(seenUrls).toEqual([
      'https://api.doppler.test/v3/projects?page=1&per_page=100',
      'https://api.doppler.test/v3/projects?page=2&per_page=100',
    ]);
  });

  it('stops after a single request when the first page is short', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(1, 2)),
      } as HttpResponse);
    };
    expect(await listDopplerProjects(TOKEN_FIXTURE, { fetch })).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it('applies one overall timeout budget across the page walk', async () => {
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(calls * 100, 100)),
      };
    };
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch, timeoutMs: 1 })).rejects.toThrow(
      'could not reach Doppler',
    );
    expect(calls).toBe(1);
  });

  it('keeps paging when a full page contains a malformed entry', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      const body =
        calls === 1 ? { projects: [null, ...projectPage(1, 99).projects] } : projectPage(100, 1);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as HttpResponse);
    };
    const result = await listDopplerProjects(TOKEN_FIXTURE, { fetch });
    expect(calls).toBe(2);
    expect(result).toHaveLength(100);
  });

  it('maps a failure on a later page to a redacted throw (no partial-list leak)', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(projectPage(1, 100)),
          } as HttpResponse)
        : Promise.resolve({
            ok: false,
            status: 403,
            json: () => Promise.resolve({ messages: ['echo LEAK context'] }),
          } as HttpResponse);
    };
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'Doppler rejected the token',
    );
  });

  it('rejects a missing project list on a later page instead of returning a partial list', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(calls === 1 ? projectPage(1, 100) : { unexpected: true }),
      } as HttpResponse);
    };
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'Doppler returned an invalid response',
    );
  });

  it('maps malformed JSON on a later page to a fixed redacted error', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          calls === 1
            ? Promise.resolve(projectPage(1, 100))
            : Promise.reject(new Error('LEAK response body')),
      } as HttpResponse);
    };
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'Doppler returned an invalid response',
    );
  });

  it('gives up at the page guard instead of looping forever', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(calls * 100, 100)),
      } as HttpResponse);
    };
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'Doppler returned too many pages',
    );
    expect(calls).toBe(101);
  });

  it('returns exactly 100 full pages when the guard probe is empty', async () => {
    let calls = 0;
    const fetch: HttpFetch = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(projectPage(calls * 100, calls <= 100 ? 100 : 0)),
      } as HttpResponse);
    };
    const result = await listDopplerProjects(TOKEN_FIXTURE, { fetch });
    expect(result).toHaveLength(10_000);
    expect(calls).toBe(101);
  });

  it('skips malformed project entries', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            projects: [{ slug: 'ok', name: 'OK' }, { name: 'no-slug' }, null, 42],
          }),
      } as HttpResponse);
    const result = await listDopplerProjects(TOKEN_FIXTURE, { fetch });
    // `{ name: 'no-slug' }` falls back to name-as-slug; null/number are skipped.
    expect(result).toEqual([
      { slug: 'ok', name: 'OK' },
      { slug: 'no-slug', name: 'no-slug' },
    ]);
  });

  it('maps 401/403 to a redacted throw (no token/body leak)', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ messages: ['echo LEAK context'] }),
      } as HttpResponse);
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'Doppler rejected the token',
    );
  });

  it('maps an unexpected status to a generic redacted throw', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as HttpResponse);
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'Doppler returned an unexpected status (500)',
    );
  });

  it('throws an unreachable-Doppler error on a transport failure', async () => {
    const fetch: HttpFetch = () => Promise.reject(new Error('boom'));
    await expect(listDopplerProjects(TOKEN_FIXTURE, { fetch })).rejects.toThrow(
      'could not reach Doppler',
    );
  });
});

describe('listDopplerConfigs (production check, faked transport)', () => {
  it('maps the Doppler config shape and URL-encodes the project into the query', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetch: HttpFetch = (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            configs: [
              { name: 'dev', environment: 'dev', root: true },
              { name: 'dev_feature', environment: 'dev', root: false },
            ],
          }),
      } as HttpResponse);
    };
    const result = await listDopplerConfigs(TOKEN_FIXTURE, 'acme app', {
      fetch,
      apiBaseUrl: 'https://api.doppler.test',
    });
    expect(result).toEqual([
      { name: 'dev', environment: 'dev', root: true },
      { name: 'dev_feature', environment: 'dev', root: false },
    ]);
    expect(seenUrl).toBe(
      'https://api.doppler.test/v3/configs?project=acme%20app&page=1&per_page=100',
    );
    expect(seenAuth).toBe(`Bearer ${TOKEN_FIXTURE}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
  });

  it('walks pages for a project with more configs than one page holds', async () => {
    const seenUrls: string[] = [];
    const fetch: HttpFetch = (url) => {
      seenUrls.push(url);
      const page = seenUrls.length;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            configs: Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => ({
              name: `cfg-${String(page)}-${String(i)}`,
            })),
          }),
      } as HttpResponse);
    };
    const result = await listDopplerConfigs(TOKEN_FIXTURE, 'acme-app', {
      fetch,
      apiBaseUrl: 'https://api.doppler.test',
    });
    expect(result).toHaveLength(102);
    expect(seenUrls).toEqual([
      'https://api.doppler.test/v3/configs?project=acme-app&page=1&per_page=100',
      'https://api.doppler.test/v3/configs?project=acme-app&page=2&per_page=100',
    ]);
  });

  it('maps 401 to a redacted throw (no body echoed)', async () => {
    const fetch: HttpFetch = () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ messages: ['boom LEAK'] }),
      } as HttpResponse);
    await expect(listDopplerConfigs(TOKEN_FIXTURE, 'acme-app', { fetch })).rejects.toThrow(
      'Doppler rejected the token',
    );
  });
});
