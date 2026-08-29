#!/usr/bin/env node
// Report published GitHub releases that never got their container images.
//
// THE CONDITION. release-please tags and publishes the GitHub release the moment
// its release PR merges. Every image publish in release.yml — Server, sandbox,
// toolkit, project-relay, the two preview components — hangs off
// `self-update-gate`, the live-cutover verdict. So a release whose gate fails
// keeps its tag and its published, non-draft, non-prerelease GitHub release
// FOREVER, with nothing behind it. Nothing in the repository notices: the release
// run is red for a few hours on someone's dashboard and then it is history, while
// the release itself stays on the releases page looking exactly like a good one.
//
// v13.2.13 is that, tagged 2026-08-16T14:10:20Z. v13.2.14 is that, tagged six
// hours later — and the reason 13.2.14's run failed at all is that its gate
// walked onto v13.2.13 as its predecessor and tried to pull an image that was
// never pushed (fixed in #1561 by asking the registry instead of git). One silent
// imageless release is what broke the next release. That is the shape this script
// exists to interrupt: the condition is not just cosmetic, it is load-bearing for
// the NEXT release, and it compounds while nobody is looking.
//
// WHY A SCRIPT AND NOT INLINE BASH. Same reason as prune-actions-cache.mjs: the
// part that can go wrong is the policy — which releases are in scope, how long a
// release is allowed to have no images yet, what counts as an image that was
// never published versus an image that did not exist at that version. All of that
// is pure and unit-tested in scripts/audit-release-images.test.ts. The I/O around
// it is deliberately thin.
//
// Usage: node scripts/audit-release-images.mjs
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, optionally GITHUB_API_URL,
//      VERITY_AUDIT_WINDOW, VERITY_AUDIT_GRACE_MINUTES, VERITY_AUDIT_REGISTRY.

// Imported rather than taken off the global object: eslint.config.js declares the
// Node globals `scripts/**/*.mjs` may use, and its list is deliberately the two
// that prune-actions-cache.mjs needs. Widening it for this file would loosen the
// rule for every script in the directory; an import costs nothing and is local.
import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Every image release.yml pushes at the BACKEND release version.
 *
 * ANY of them missing makes the release incomplete, not just the Server. The
 * Server is the one that gates a deployment, and if only the Server mattered this
 * list would be one line — but the two failure modes are different shapes:
 *
 *   - The gate fails. Nothing publishes, because every publish job `needs:
 *     self-update-gate`. Watching the Server alone would catch this, since the
 *     Server is missing too.
 *   - ONE publish job fails — an OOM in the sandbox build, a 500 from ghcr on the
 *     toolkit's `imagetools create`. The Server publishes, self-update works, the
 *     release looks entirely healthy, and a project provisioned against that
 *     release resolves `verity-sandbox:v13.2.x` to a tag that does not exist. A
 *     released Server resolves its sandbox image and toolkit Feature at its OWN
 *     version rather than `:latest` (see the note in release.yml's `publish-server`
 *     needs), so a sibling gap is not cosmetic either; it just fails later, on a
 *     user's first project instead of on the release run.
 *
 * The second is the one nothing else in the repository would ever surface, and it
 * costs one extra catalogue read per image to cover. So: all of them.
 *
 * `verity-sandbox` is audited at the namespaced path only. `publish-sandbox`
 * dual-publishes it to the legacy `heey-global/verity-sandbox` as well (#475), but
 * both tags come off the same step — if one is absent the job did not run, and
 * auditing the alias would only ever restate the same finding.
 *
 * `verity-website` is deliberately absent, and this is the one exclusion that is
 * not about avoiding a duplicate finding. It rides its own release train
 * (`website-vX.Y.Z`), gated on `website-release-created` rather than on
 * `self-update-gate`, so its versions are a different sequence that advances at a
 * different time. Auditing it against a backend `vX.Y.Z` would report it missing
 * for every backend release the website did not happen to release alongside —
 * which is most of them.
 *
 * What that leaves uncovered, stated rather than waved at: a `publish-website`
 * job that fails leaves `website-vX.Y.Z` tagged in git with no image behind it,
 * exactly the condition at the top of this file, and the symptom is quiet —
 * Renovate reads the registry, so it simply never proposes moving the k8s pin,
 * and the cluster keeps serving the previous version. What makes that survivable
 * rather than the compounding failure described above is that nothing resolves
 * the website image BY a Verity version: no next release walks onto the gap, and
 * re-running the job fixes it whenever it is noticed. Covering it properly means
 * an audit over `website-v*` tags, not a row in this list.
 *
 * Adding an image to release.yml without adding it here would leave that image
 * unaudited silently. scripts/ci-workflow.test.ts asserts this list against every
 * `:v${VERSION}` push target in release.yml — with those two exclusions named
 * there as well — so the drift fails a PR rather than going unnoticed.
 */
export const RELEASE_IMAGES = [
  'heey-global/verity/verity-server',
  'heey-global/verity/verity-sandbox',
  'heey-global/verity/verity-sandbox-toolkit',
  'heey-global/verity/verity-project-relay',
  'heey-global/verity/verity-preview-edge',
  'heey-global/verity/verity-preview-connector',
];

/** The Server is called out in the report: it is the one a deployment cannot skip. */
export const SERVER_IMAGE = 'heey-global/verity/verity-server';

/**
 * How many `vX.Y.Z` releases back to audit, newest first.
 *
 * A bound rather than the whole tag history, because the history is not the
 * question — it grows without limit, every run would re-read it, and a release
 * from six months ago that never got an image is archaeology: nobody is deploying
 * it, and republishing it would mean rebuilding a source tree that no longer
 * matches anything. Ten covers roughly the last two days at the release cadence
 * this repository actually runs at (nine releases on 2026-08-15 and -16 alone),
 * which is comfortably more than the ~10 h worst case between the condition
 * appearing and this check running.
 *
 * What the bound misses, said plainly: a release that falls out of the window
 * before anyone acts on the report goes quiet again, and the report goes green
 * with the gap still there. That is the deliberate trade — the alternative,
 * "everything newer than the last complete release", never goes green while an
 * old gap is unrepaired, and a check that is permanently red is a check nobody
 * reads. If a gap ages out of this window it has been red for at least ten
 * releases, which is not a notification problem any more.
 */
export const DEFAULT_WINDOW = 10;

/**
 * A release younger than this is still in flight, not broken.
 *
 * A successful release run takes 32–44 minutes from the release commit to the
 * last image push (measured across v13.2.4 … v13.2.12), and that is runtime only:
 * the release jobs contend for four self-hosted runners with every open PR, so
 * queueing sits on top of it. Four hours is well clear of both, and the cost of
 * being generous is only detection latency on a condition that otherwise persists
 * indefinitely.
 *
 * Getting this too SHORT is the expensive direction: a check that goes red on
 * every release for the first hour is a check that is red most mornings, and the
 * one time it means something it looks like the other times.
 */
export const DEFAULT_GRACE_MS = 4 * 60 * 60 * 1000;

const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} tag
 * @returns {[number, number, number] | null} null for anything that is not a
 *   plain `vX.Y.Z` — `mobile-v1.8.11` and the like are releases of the native app
 *   and publish no container images at all.
 */
export function parseVersionTag(tag) {
  const match = VERSION_TAG.exec(tag);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number} negative when a < b
 */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * @typedef {{ tag_name: string, draft?: boolean, prerelease?: boolean,
 *   published_at?: string | null, created_at?: string | null,
 *   html_url?: string }} Release
 */

/**
 * Split the release list into the ones this run judges and the ones it does not.
 *
 * @param {{ releases: Release[], now: number, window?: number, graceMs?: number }} options
 * @returns {{ audited: Release[], inFlight: Release[] }}
 */
export function selectReleases({
  releases,
  now,
  window = DEFAULT_WINDOW,
  graceMs = DEFAULT_GRACE_MS,
}) {
  const candidates = releases
    // A draft has no tag the world can see and a prerelease is not what anything
    // deploys, so neither is a broken promise. Only a published, non-prerelease
    // release claims "this version exists" to a deployment.
    .filter((release) => release.draft !== true && release.prerelease !== true)
    .map((release) => ({ release, version: parseVersionTag(release.tag_name) }))
    .filter(
      /** @returns {entry is { release: Release, version: [number, number, number] }} */
      (entry) => entry.version !== null,
    )
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, window)
    .map((entry) => entry.release);

  /** @type {Release[]} */
  const audited = [];
  /** @type {Release[]} */
  const inFlight = [];
  for (const release of candidates) {
    // `published_at` is when the release went public, which is when release.yml
    // started; `created_at` is the underlying tag's commit date and only stands in
    // if the API omitted the former. An unparseable date is treated as in-flight:
    // this check accusing a release on the strength of a date it could not read is
    // worse than it staying quiet.
    const at = Date.parse(release.published_at ?? release.created_at ?? '');
    if (Number.isNaN(at) || now - at < graceMs) {
      inFlight.push(release);
      continue;
    }
    audited.push(release);
  }
  return { audited, inFlight };
}

/**
 * @typedef {{ release: Release, missing: string[] }} Gap
 */

/**
 * Which audited releases are missing which images.
 *
 * The rule is per image: a release is missing image I only if it is at or above
 * the OLDEST version I has ever been published at. Without that floor, an image
 * added to release.yml at v13.2.6 would be reported missing for every older
 * release in the window — permanently, since nothing can ever fix it — and this
 * check would be red forever for a reason that is not a defect.
 *
 * The floor cannot swallow a real gap: an image that stops publishing keeps its
 * old floor, so every release after the last good one is still reported. The one
 * case it WOULD swallow is an image with no published versions at all, where
 * there is no floor to compare against and every release would silently pass —
 * so that is not a gap, it is `emptyImages`, and the caller treats it as its own
 * failure. It means this list names a repository ghcr does not have.
 *
 * @param {{ releases: Release[], catalogues: Map<string, Set<string>> }} options
 * @returns {{ gaps: Gap[], emptyImages: string[] }}
 */
export function findGaps({ releases, catalogues }) {
  /** @type {string[]} */
  const emptyImages = [];
  /** @type {Map<string, [number, number, number]>} */
  const floors = new Map();
  for (const [image, tags] of catalogues) {
    const versions = [...tags]
      .map(parseVersionTag)
      .filter(/** @returns {v is [number, number, number]} */ (v) => v !== null)
      .sort(compareVersions);
    const floor = versions[0];
    if (floor === undefined) {
      emptyImages.push(image);
      continue;
    }
    floors.set(image, floor);
  }

  /** @type {Gap[]} */
  const gaps = [];
  for (const release of releases) {
    const version = parseVersionTag(release.tag_name);
    if (version === null) continue;
    const missing = [];
    for (const [image, floor] of floors) {
      if (compareVersions(version, floor) < 0) continue;
      if (catalogues.get(image)?.has(release.tag_name) !== true) missing.push(image);
    }
    if (missing.length > 0) gaps.push({ release, missing });
  }
  return { gaps, emptyImages };
}

/**
 * @param {{ gaps: Gap[], emptyImages: string[], audited: Release[], inFlight: Release[] }} result
 * @returns {string} Markdown for the step summary and the log. The run's exit
 *   code says THAT something is wrong; this says which release and which image,
 *   so the run page answers the question without a re-run.
 */
export function formatReport({ gaps, emptyImages, audited, inFlight, graceMs = DEFAULT_GRACE_MS }) {
  const short = (/** @type {string} */ image) => image.replace(/^.*\//, '');
  const lines = [];
  if (emptyImages.length > 0) {
    lines.push(
      `**ghcr.io publishes no \`vX.Y.Z\` tag at all for: ${emptyImages.map(short).join(', ')}.**`,
      '',
      'That is a bug in this audit, not in a release: the image list in',
      '`scripts/audit-release-images.mjs` names a repository the registry does not have.',
      '',
    );
  }
  if (gaps.length > 0) {
    lines.push(
      `**${gaps.length} published release${gaps.length === 1 ? '' : 's'} with no image behind ${gaps.length === 1 ? 'it' : 'them'}.**`,
      '',
      'Each of these is a `draft=false, prerelease=false` GitHub release that a human',
      'can see and a deployment can name, whose images were never pushed — almost',
      'always because `self-update-gate` failed and every publish job in release.yml',
      'is downstream of it. Re-run the failed release run, or delete the release and',
      'its tag. Leaving it is what broke the release after it last time.',
      '',
    );
    for (const { release, missing } of gaps) {
      const server = missing.includes(SERVER_IMAGE) ? ' — including the **Server**' : '';
      lines.push(
        `- \`${release.tag_name}\` (published ${release.published_at ?? release.created_at ?? 'unknown'})${server}: ${missing.map(short).join(', ')}`,
      );
    }
    lines.push('');
  }
  if (gaps.length === 0 && emptyImages.length === 0) {
    lines.push(
      `All ${audited.length} audited release${audited.length === 1 ? '' : 's'} have every image published.`,
      '',
    );
  }
  lines.push(
    `Audited ${audited.length} release${audited.length === 1 ? '' : 's'} against ${RELEASE_IMAGES.length} images.`,
  );
  if (inFlight.length > 0) {
    lines.push(
      `Too recent to judge (inside the ${graceMs / 3600000} h grace period): ${inFlight
        .map((release) => release.tag_name)
        .join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/**
 * One HTTP read that treats a non-2xx as an error rather than as data.
 *
 * `docker pull`'s error text is not an API and must never be parsed — the whole
 * of #1561 is about that. Status codes are: a 401 from a broken token, a 404 from
 * a renamed package and a 200 with an empty tag list are three different
 * outcomes, and only the last one means "this release has no image".
 *
 * @param {string} url
 * @param {{ headers?: Record<string, string>, fetchImpl?: typeof fetch, attempts?: number }} options
 * @returns {Promise<Response>}
 */
async function httpGet(url, { headers = {}, fetchImpl = fetch, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers });
      // 5xx and 429 are the registry having a moment. Retrying them matters more
      // than it looks: a scheduled check that goes red on a transient 502 teaches
      // everyone to ignore it, and then it is not a check any more.
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`${url} answered ${response.status}`);
      } else if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
      } else {
        return response;
      }
    } catch (error) {
      if (attempt === attempts) throw error;
      lastError = error;
    }
    await sleep(500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Every `vX.Y.Z` tag ghcr.io publishes for one image.
 *
 * The registry is the authority on whether an image exists — this is the same
 * catalogue read the release gate itself uses (see self-update.yml's "Resolve the
 * previously released Server image"), for the same reason: git knows about tags,
 * and a tag is not an image. The body is parsed by JSON.parse and never by a
 * pattern; whitespace and field order are not a wire format.
 *
 * @param {{ repository: string, token: string, registry?: string,
 *   fetchImpl?: typeof fetch, actor?: string, maxPages?: number }} options
 * @returns {Promise<Set<string>>}
 */
export async function fetchTagCatalogue({
  repository,
  token,
  registry = 'https://ghcr.io',
  fetchImpl = fetch,
  actor = 'github-actions',
  maxPages = 50,
}) {
  const auth = Buffer.from(`${actor}:${token}`).toString('base64');
  const tokenResponse = await httpGet(
    `${registry}/token?service=ghcr.io&scope=repository:${repository}:pull`,
    { headers: { authorization: `Basic ${auth}` }, fetchImpl },
  );
  const issued = /** @type {{ token?: unknown }} */ (await tokenResponse.json());
  const pullToken = issued.token;
  if (typeof pullToken !== 'string' || pullToken === '') {
    throw new Error(`ghcr.io issued no usable pull token for ${repository}`);
  }

  /** @type {Set<string>} */
  const tags = new Set();
  // Paginated because the catalogue is ordered oldest-first: a truncated read
  // loses the NEWEST releases, which is exactly the half this check is about, and
  // it would lose them silently.
  let next = `/v2/${repository}/tags/list?n=1000`;
  for (let page = 0; next !== ''; page += 1) {
    if (page >= maxPages) {
      throw new Error(
        `ghcr.io kept paginating ${repository}'s tag catalogue past ${maxPages} pages`,
      );
    }
    const response = await httpGet(`${registry}${next}`, {
      headers: { authorization: `Bearer ${pullToken}` },
      fetchImpl,
    });
    const body = /** @type {{ tags?: unknown }} */ (await response.json());
    // The OCI spec allows a null `tags` for a repository that has none.
    const listed = body.tags;
    if (listed !== null && listed !== undefined && !Array.isArray(listed)) {
      throw new Error(`ghcr.io answered ${repository}'s tag catalogue with something else`);
    }
    for (const tag of listed ?? []) {
      if (typeof tag === 'string' && VERSION_TAG.test(tag)) tags.add(tag);
    }
    // `Link` is a header, not JSON, so it is read as text — but only for the
    // `<…>` in a line that also says `rel="next"`, where getting it wrong costs a
    // page rather than a wrong answer.
    const link = response.headers.get('link') ?? '';
    const relNext = link.includes('rel="next"') ? /<([^>]+)>/.exec(link)?.[1] : undefined;
    next = relNext ?? '';
  }
  return tags;
}

/**
 * The most recent releases GitHub knows about.
 *
 * One page of 100, not `--paginate`: the window is ten `vX.Y.Z` releases and the
 * list is newest-first, so a hundred entries covers it many times over even with
 * the interleaved `mobile-v*` releases. A second page could only contain releases
 * older than every one already read.
 *
 * @param {{ repository: string, token: string, apiUrl?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Release[]>}
 */
export async function fetchReleases({
  repository,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  const response = await httpGet(`${apiUrl}/repos/${repository}/releases?per_page=100`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    fetchImpl,
  });
  const body = /** @type {Release[]} */ (/** @type {unknown} */ (await response.json()));
  if (!Array.isArray(body)) throw new Error(`${repository} returned no release list`);
  return body;
}

/**
 * @param {{ repository: string, token: string, now?: number, window?: number,
 *   graceMs?: number, apiUrl?: string, registry?: string, actor?: string,
 *   fetchImpl?: typeof fetch, images?: string[] }} options
 * @returns {Promise<{ ok: boolean, gaps: Gap[], emptyImages: string[], report: string }>}
 */
export async function run({
  repository,
  token,
  now = Date.now(),
  window = DEFAULT_WINDOW,
  graceMs = DEFAULT_GRACE_MS,
  apiUrl,
  registry,
  actor,
  fetchImpl,
  images = RELEASE_IMAGES,
}) {
  const releases = await fetchReleases({ repository, token, apiUrl, fetchImpl });
  const { audited, inFlight } = selectReleases({ releases, now, window, graceMs });
  /** @type {Map<string, Set<string>>} */
  const catalogues = new Map();
  for (const image of images) {
    catalogues.set(
      image,
      await fetchTagCatalogue({ repository: image, token, registry, fetchImpl, actor }),
    );
  }
  const { gaps, emptyImages } = findGaps({ releases: audited, catalogues });
  return {
    ok: gaps.length === 0 && emptyImages.length === 0,
    gaps,
    emptyImages,
    report: formatReport({ gaps, emptyImages, audited, inFlight, graceMs }),
  };
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`);
  }
  return value;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (token === undefined || token === '' || repository === undefined || repository === '') {
    console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    process.exit(1);
  }

  const result = await run({
    repository,
    token,
    apiUrl: process.env.GITHUB_API_URL,
    registry: process.env.VERITY_AUDIT_REGISTRY,
    actor: process.env.GITHUB_ACTOR,
    window: numericEnv('VERITY_AUDIT_WINDOW', DEFAULT_WINDOW),
    graceMs: numericEnv('VERITY_AUDIT_GRACE_MINUTES', DEFAULT_GRACE_MS / 60000) * 60000,
  });

  console.log(result.report);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== '') {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(stepSummary, `### Release image audit\n\n${result.report}\n`);
  }
  if (!result.ok) {
    // The exit code IS the notification. See the workflow header for why this is
    // a red scheduled run rather than an opened issue.
    for (const { release, missing } of result.gaps) {
      console.error(`::error::${release.tag_name} has no published image: ${missing.join(', ')}`);
    }
    for (const image of result.emptyImages) {
      console.error(`::error::ghcr.io publishes no released tag for ${image}`);
    }
    process.exit(1);
  }
}

// `import.meta.main` is not available on the pinned Node version, so compare paths.
if (process.argv[1]?.endsWith('audit-release-images.mjs') === true) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
