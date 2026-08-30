import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- plain .mjs helper, no types
import {
  DEFAULT_GRACE_MS,
  RELEASE_IMAGES,
  SERVER_IMAGE,
  fetchTagCatalogue,
  findGaps,
  formatReport,
  run,
  selectReleases,
} from './audit-release-images.mjs';

type Release = {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  created_at?: string | null;
};

const NOW = Date.parse('2026-08-17T07:00:00Z');
const HOUR = 60 * 60 * 1000;

/** A release published `hoursAgo` before NOW, i.e. old enough to judge by default. */
function release(tag: string, hoursAgo = 24, overrides: Partial<Release> = {}): Release {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    ...overrides,
  };
}

function catalogues(entries: Record<string, string[]>) {
  return new Map(Object.entries(entries).map(([image, tags]) => [image, new Set(tags)]));
}

describe('release audit scope', () => {
  it('judges the newest releases by version, not by the order the API listed them', () => {
    // GitHub returns releases newest-first by creation, and `mobile-v*` releases
    // are interleaved with the backend ones — so "the first ten entries" and "the
    // ten newest backend releases" are different sets, and only the second is the
    // question. Feed them out of order to prove the sort is doing the work.
    const releases = [release('v13.2.8'), release('v13.2.15'), release('v13.2.9')];
    const { audited } = selectReleases({ releases, now: NOW, window: 2 });
    expect(audited.map((r: Release) => r.tag_name)).toEqual(['v13.2.15', 'v13.2.9']);
  });

  it('ignores everything that is not a published backend release', () => {
    // A draft has no tag the world can see; a prerelease is not what anything
    // deploys; `mobile-v*` is the native app, which publishes no container image
    // at all and would be reported missing on every single run. Each of these
    // would be a permanent false positive, which is the failure mode that gets a
    // scheduled check muted.
    const releases = [
      release('v13.2.15'),
      release('mobile-v1.8.11'),
      release('v13.2.14', 24, { draft: true }),
      release('v13.2.13', 24, { prerelease: true }),
      release('nightly'),
    ];
    const { audited } = selectReleases({ releases, now: NOW });
    expect(audited.map((r: Release) => r.tag_name)).toEqual(['v13.2.15']);
  });

  it('leaves a release inside the grace period unjudged', () => {
    // A successful release run takes 32–44 minutes from the release commit to the
    // last image push, before queueing behind the four shared runners. Judging a
    // release that is still publishing would make this check red for the first
    // hour of every release — red most mornings, and indistinguishable from the
    // one time it means something.
    const releases = [release('v13.2.15', 1), release('v13.2.14', 24)];
    const { audited, inFlight } = selectReleases({ releases, now: NOW });
    expect(audited.map((r: Release) => r.tag_name)).toEqual(['v13.2.14']);
    expect(inFlight.map((r: Release) => r.tag_name)).toEqual(['v13.2.15']);
  });

  it('measures the grace period from the release date, and falls back when it is absent', () => {
    const releases = [
      release('v13.2.15', 0, { published_at: null, created_at: new Date(NOW).toISOString() }),
      release('v13.2.14', 0, {
        published_at: null,
        created_at: new Date(NOW - 24 * HOUR).toISOString(),
      }),
      // No date at all: accusing a release on the strength of a date this check
      // could not read is worse than staying quiet, so it stays unjudged.
      release('v13.2.13', 0, { published_at: null, created_at: null }),
    ];
    const { audited, inFlight } = selectReleases({ releases, now: NOW });
    expect(audited.map((r: Release) => r.tag_name)).toEqual(['v13.2.14']);
    expect(inFlight.map((r: Release) => r.tag_name)).toEqual(['v13.2.15', 'v13.2.13']);
  });

  it('defaults the grace period well clear of a slow release run', () => {
    expect(DEFAULT_GRACE_MS).toBeGreaterThanOrEqual(2 * HOUR);
  });
});

describe('release image gaps', () => {
  const SANDBOX = 'heey-global/verity/verity-sandbox';

  it('reports the release that got a tag and no images', () => {
    // The live condition: v13.2.13 and v13.2.14 are `draft=false,
    // prerelease=false` GitHub releases, and ghcr.io answers MANIFEST_UNKNOWN for
    // every image at both versions, because `self-update-gate` failed and every
    // publish job in release.yml is downstream of it.
    const { gaps } = findGaps({
      releases: [release('v13.2.14'), release('v13.2.13'), release('v13.2.12')],
      catalogues: catalogues({
        [SERVER_IMAGE]: ['v13.2.11', 'v13.2.12'],
        [SANDBOX]: ['v13.2.11', 'v13.2.12'],
      }),
    });
    expect(gaps.map((gap: { release: Release }) => gap.release.tag_name)).toEqual([
      'v13.2.14',
      'v13.2.13',
    ]);
    expect(gaps[0].missing).toEqual([SERVER_IMAGE, SANDBOX]);
  });

  it('reports a missing sibling even when the Server published', () => {
    // The failure mode nothing else in the repository would surface. The gate
    // passed, the Server shipped, self-update works, the release looks healthy —
    // and a released Server resolves its sandbox image at its OWN version rather
    // than `:latest`, so the first project provisioned on v13.2.14 resolves a tag
    // that does not exist. Auditing only the Server would call this green.
    const { gaps } = findGaps({
      releases: [release('v13.2.14')],
      catalogues: catalogues({
        [SERVER_IMAGE]: ['v13.2.13', 'v13.2.14'],
        [SANDBOX]: ['v13.2.13'],
      }),
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missing).toEqual([SANDBOX]);
  });

  it('does not report a release older than the image itself', () => {
    // Preview images were added to release.yml partway through. Without a
    // per-image floor, every release in the window older than that would be
    // reported missing — forever, since nothing can ever publish them — and the
    // check would be permanently red for a reason that is not a defect.
    const { gaps } = findGaps({
      releases: [release('v13.2.14'), release('v13.2.10'), release('v13.2.6')],
      catalogues: catalogues({
        [SERVER_IMAGE]: ['v13.2.6', 'v13.2.10', 'v13.2.14'],
        'heey-global/verity/verity-preview-edge': ['v13.2.10', 'v13.2.14'],
      }),
    });
    expect(gaps).toEqual([]);
  });

  it('still reports every release after an image stops publishing', () => {
    // An image that published for a while and then broke keeps its floor, so
    // every release after the last good one is a gap rather than being read as
    // "this image does not exist yet".
    const { gaps } = findGaps({
      releases: [release('v13.2.14'), release('v13.2.13'), release('v13.2.12')],
      catalogues: catalogues({
        [SERVER_IMAGE]: ['v13.2.12', 'v13.2.13', 'v13.2.14'],
        'heey-global/verity/verity-preview-edge': ['v13.2.12'],
      }),
    });
    expect(gaps.map((gap: { release: Release }) => gap.release.tag_name)).toEqual([
      'v13.2.14',
      'v13.2.13',
    ]);
  });

  it('reports a hole in the middle of an image history', () => {
    // The floor has to be the OLDEST published version and never the newest. Two
    // releases in the middle failed to publish and the ones on either side did —
    // a single publish job that OOMed and was fixed by the next release, which is
    // the ordinary shape of the sibling failure. A floor taken from the newest
    // tag would put both holes below it and report the whole window green, and
    // nothing else in this file would notice: with a floor of the newest tag the
    // gaps are exactly the releases the check is looking for.
    const { gaps } = findGaps({
      releases: [
        release('v13.2.14'),
        release('v13.2.13'),
        release('v13.2.12'),
        release('v13.2.11'),
      ],
      catalogues: catalogues({
        [SERVER_IMAGE]: ['v13.2.11', 'v13.2.12', 'v13.2.13', 'v13.2.14'],
        'heey-global/verity/verity-preview-edge': ['v13.2.11', 'v13.2.14'],
      }),
    });
    expect(gaps.map((gap: { release: Release }) => gap.release.tag_name)).toEqual([
      'v13.2.13',
      'v13.2.12',
    ]);
  });

  it('calls an image with no released tags a configuration error, not a pass', () => {
    // The one case the per-image floor could swallow: no floor, so every release
    // compares as "older than the image" and the audit silently checks nothing.
    // A repository ghcr.io has never heard of means this script's image list is
    // wrong — a renamed package, a typo — and that has to be as loud as a real
    // gap, because it disables part of the check.
    const { gaps, emptyImages } = findGaps({
      releases: [release('v13.2.14')],
      catalogues: catalogues({
        [SERVER_IMAGE]: ['v13.2.14'],
        'heey-global/verity/verity-typo': [],
      }),
    });
    expect(gaps).toEqual([]);
    expect(emptyImages).toEqual(['heey-global/verity/verity-typo']);
  });
});

describe('release audit report', () => {
  it('names the release, the date, and every missing image', () => {
    // The exit code says THAT something is wrong. Everything a reader needs to
    // decide what to do — which release, how old, whether a deployment is
    // affected — has to be in the run page, or the check costs a re-run to read.
    const report = formatReport({
      gaps: [
        {
          release: release('v13.2.13', 24, { published_at: '2026-08-16T14:10:20Z' }),
          missing: [SERVER_IMAGE, 'heey-global/verity/verity-sandbox'],
        },
      ],
      emptyImages: [],
      audited: [release('v13.2.13')],
      inFlight: [release('v13.2.15', 1)],
    });
    expect(report).toContain('1 published release with no image behind it');
    expect(report).toContain('`v13.2.13` (published 2026-08-16T14:10:20Z)');
    expect(report).toContain('including the **Server**');
    expect(report).toContain('verity-server, verity-sandbox');
    expect(report).toContain('v13.2.15');
  });

  it('says so when a gap does not touch the Server', () => {
    // Not decoration: a missing Server means no deployment can update to this
    // release, and a missing sibling means the release is fine until someone
    // creates a project on it. Same fix, different urgency.
    const report = formatReport({
      gaps: [{ release: release('v13.2.13'), missing: ['heey-global/verity/verity-sandbox'] }],
      emptyImages: [],
      audited: [release('v13.2.13')],
      inFlight: [],
    });
    expect(report).not.toContain('Server');
    expect(report).toContain('verity-sandbox');
  });
});

describe('release audit against the registry', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.close();
    await (server === undefined ? Promise.resolve() : once(server, 'close'));
    server = undefined;
  });

  /**
   * A stand-in for ghcr.io and the GitHub API on one socket, so the wire format —
   * the token exchange, `Link` pagination, the status codes — is exercised rather
   * than mocked away.
   */
  async function serve(
    handler: (url: URL, auth: string) => { status: number; body?: unknown; link?: string },
  ) {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const { status, body, link } = handler(url, request.headers.authorization ?? '');
      response.writeHead(status, {
        'content-type': 'application/json',
        ...(link === undefined ? {} : { link }),
      });
      response.end(JSON.stringify(body ?? {}));
    });
    server.listen(0);
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('reads the whole catalogue across Link pages', async () => {
    // The catalogue is ordered oldest-first, so a truncated read loses the NEWEST
    // releases — exactly the half this check is about — and loses them silently,
    // reporting every recent release as imageless. Page two carries the tags that
    // matter.
    const seen: string[] = [];
    const base = await serve((url, auth) => {
      seen.push(`${url.pathname}${url.search} ${auth.split(' ')[0]}`);
      if (url.pathname === '/token') return { status: 200, body: { token: 'pull-token' } };
      if (url.searchParams.get('page') === '2') {
        return { status: 200, body: { tags: ['v13.2.13', 'latest'] } };
      }
      return {
        status: 200,
        body: { tags: ['v13.2.12', 'sha-abc'] },
        link: `</v2/x/tags/list?n=1000&page=2>; rel="next"`,
      };
    });

    const tags = await fetchTagCatalogue({ repository: 'x', token: 't', registry: base });

    // Non-version tags are dropped: `latest` and `sha-…` are published by the same
    // step but say nothing about which RELEASE has an image.
    expect([...tags].sort()).toEqual(['v13.2.12', 'v13.2.13']);
    expect(seen[0]).toBe('/token?service=ghcr.io&scope=repository:x:pull Basic');
    expect(seen[1]).toBe('/v2/x/tags/list?n=1000 Bearer');
    expect(seen[2]).toBe('/v2/x/tags/list?n=1000&page=2 Bearer');
  });

  it('selects rel=next from multiple RFC Link values and accepts an absolute target', async () => {
    const base = await serve((url) => {
      if (url.pathname === '/token') return { status: 200, body: { token: 'pull-token' } };
      if (url.searchParams.get('page') === '2') {
        return { status: 200, body: { tags: ['v13.2.13'] } };
      }
      return {
        status: 200,
        body: { tags: ['v13.2.12'] },
        link:
          `</v2/x/tags/list?n=1000&page=0>; rel="prev"; title="old, page", ` +
          `<${base}/v2/x/tags/list?n=1000&page=2>; type="application/json"; rel="last next"`,
      };
    });
    await expect(
      fetchTagCatalogue({ repository: 'x', token: 't', registry: base }),
    ).resolves.toEqual(new Set(['v13.2.12', 'v13.2.13']));
  });

  it('fails on a refusal rather than reading it as an absent image', async () => {
    // The trap #1561 was written to close, in its other form. A 401 from an
    // expired token and a 200 with no tags are the same sentence to `docker pull`
    // and completely different facts here. Swallowing the 401 would report every
    // release in the window as imageless — the loud direction, but still a lie —
    // and swallowing it per-image would report a healthy release as broken.
    const base = await serve((url) =>
      url.pathname === '/token'
        ? { status: 401, body: { message: 'unauthorized' } }
        : { status: 200 },
    );
    await expect(
      fetchTagCatalogue({ repository: 'x', token: 't', registry: base }),
    ).rejects.toThrow(/401/);
  });

  it('fails when the token exchange answers 200 with no token', async () => {
    const base = await serve(() => ({ status: 200, body: { message: 'ok' } }));
    await expect(
      fetchTagCatalogue({ repository: 'x', token: 't', registry: base }),
    ).rejects.toThrow(/no usable pull token/);
  });

  it('fails when the catalogue itself is refused, not just the token exchange', async () => {
    // The more dangerous half, and the one a fallback guard cannot cover: a token
    // that is issued and then rejected on the catalogue read (a package renamed
    // out from under the audit, a scope the token no longer carries) answers with
    // a JSON body that simply has no `tags` field. Read as data, that is
    // indistinguishable from an image with nothing published — so the audit would
    // report EVERY release in the window as imageless and be believed.
    const base = await serve((url) =>
      url.pathname === '/token'
        ? { status: 200, body: { token: 'pull-token' } }
        : { status: 403, body: { errors: [{ code: 'DENIED' }] } },
    );
    await expect(
      fetchTagCatalogue({ repository: 'x', token: 't', registry: base }),
    ).rejects.toThrow(/403/);
  });

  it('refuses a tag list that is not a list, and accepts the OCI null', async () => {
    // `{"tags": "v13.2.14"}` iterates as characters, none of which match the
    // version pattern, so an unguarded read turns a malformed body into "this
    // image has nothing published" — the same silent false positive as a
    // swallowed 403, arriving through the parser instead of the status code.
    let body: unknown = { tags: 'v13.2.14' };
    const base = await serve((url) =>
      url.pathname === '/token' ? { status: 200, body: { token: 'p' } } : { status: 200, body },
    );
    await expect(
      fetchTagCatalogue({ repository: 'x', token: 't', registry: base }),
    ).rejects.toThrow(/not a tag list|something else/);

    // A null `tags` is different: the OCI spec allows it for a repository with
    // none, so it is a legitimate empty answer and must NOT throw — `findGaps`
    // is what turns an empty catalogue into a reported configuration error.
    body = { tags: null };
    await expect(
      fetchTagCatalogue({ repository: 'x', token: 't', registry: base }),
    ).resolves.toEqual(new Set());
  });

  it('reports the live shape of the condition end to end', async () => {
    // The whole path: list releases, read every catalogue, apply the policy. The
    // fixture is the real state of this repository on 2026-08-17 — v13.2.13 and
    // v13.2.14 published with nothing behind them, v13.2.15 too recent to judge.
    const published = ['v13.2.11', 'v13.2.12'];
    const base = await serve((url) => {
      if (url.pathname === '/repos/heey-global/verity/releases') {
        return {
          status: 200,
          body: [
            release('v13.2.15', 1),
            release('v13.2.14', 11),
            release('v13.2.13', 17),
            release('v13.2.12', 20),
            release('v13.2.11', 24),
            release('mobile-v1.8.11', 2),
          ],
        };
      }
      if (url.pathname === '/token') return { status: 200, body: { token: 'pull-token' } };
      return { status: 200, body: { tags: published } };
    });

    const result = await run({
      repository: 'heey-global/verity',
      token: 't',
      now: NOW,
      apiUrl: base,
      registry: base,
    });

    expect(result.ok).toBe(false);
    expect(result.gaps.map((gap: { release: Release }) => gap.release.tag_name)).toEqual([
      'v13.2.14',
      'v13.2.13',
    ]);
    expect(result.gaps[0].missing).toEqual(RELEASE_IMAGES);
    expect(result.report).toContain('Too recent to judge');
    expect(result.report).toContain('v13.2.15');
  });

  it('reports ok when every audited release has every image', async () => {
    // The other half of the previous test, and the one that proves it is not
    // simply always red: same code path, same window, a complete registry.
    const base = await serve((url) => {
      if (url.pathname === '/repos/heey-global/verity/releases') {
        return { status: 200, body: [release('v13.2.15', 11), release('v13.2.14', 17)] };
      }
      if (url.pathname === '/token') return { status: 200, body: { token: 'pull-token' } };
      return { status: 200, body: { tags: ['v13.2.14', 'v13.2.15'] } };
    });

    const result = await run({
      repository: 'heey-global/verity',
      token: 't',
      now: NOW,
      apiUrl: base,
      registry: base,
    });

    expect(result.ok).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.report).toContain('All 2 audited releases have every image published.');
  });

  it.each([
    ['fails the run', ['v13.2.11'], 1, 'has no published image'],
    ['passes the run', ['v13.2.13', 'v13.2.14'], 0, 'have every image published'],
  ])(
    'exits so the scheduled run %s',
    async (_name, tags: string[], code: number, expected: string) => {
      // The exit code is the entire notification: there is no issue to open and
      // no message to send, so a script that computes the right answer and then
      // returns 0 is a check that reports green forever. `run()` returning
      // `ok: false` is asserted above and is NOT the same fact — nothing else in
      // this file executes the CLI entrypoint, the `::error::` lines, or the step
      // summary append. So execute it, against the same stub registry.
      const base = await serve((url) => {
        if (url.pathname === '/repos/heey-global/verity/releases') {
          return { status: 200, body: [release('v13.2.14', 11), release('v13.2.13', 17)] };
        }
        if (url.pathname === '/token') return { status: 200, body: { token: 'pull-token' } };
        return { status: 200, body: { tags } };
      });
      const summary = join(await mkdtemp(join(tmpdir(), 'audit-')), 'summary.md');
      await writeFile(summary, '');

      // `spawn` and not `spawnSync`: the stub registry above is served from THIS
      // process's event loop, and spawnSync blocks it until the child exits — so
      // the child's first request would never be answered and the test would hang
      // rather than fail. Verified the hard way.
      const child = spawn(process.execPath, ['scripts/audit-release-images.mjs'], {
        env: {
          ...process.env,
          GITHUB_TOKEN: 't',
          GITHUB_REPOSITORY: 'heey-global/verity',
          GITHUB_API_URL: base,
          VERITY_AUDIT_REGISTRY: base,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const [status] = (await once(child, 'close')) as [number | null];

      expect(status).toBe(code);
      // The run page has to answer "which release, which image" without a re-run,
      // and the annotation is what puts it on the summary line rather than 40
      // lines into a log.
      expect(`${stdout}${stderr}`).toContain(expected);
      expect(readFileSync(summary, 'utf8')).toContain('### Release image audit');
      if (code === 1) expect(stderr).toContain('::error::v13.2.14 has no published image');
    },
  );
});
