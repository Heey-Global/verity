import { z } from 'zod';

/**
 * Release notes for a pending Server update, read from the public GitHub
 * releases release-please writes.
 *
 * They are display-only and deliberately not part of the signed release
 * channel: installed Servers parse that document with an exact key set, so a
 * `notes` member would make every one of them reject the channel — and stop
 * seeing updates at all. What gets installed is still decided by the signed
 * channel alone; these notes can only be missing or wrong, never steer it.
 */

export const SERVER_RELEASES_URL =
  'https://api.github.com/repos/Heey-Global/verity/releases?per_page=100';

const RELEASE_PAGE_PREFIX = 'https://github.com/Heey-Global/verity/releases/tag/';
const releasePageUrl = (version: string): string =>
  `${RELEASE_PAGE_PREFIX}v${version.replace(/^v/, '')}`;

export interface ReleaseNoteSection {
  readonly title: string;
  readonly items: readonly string[];
}

export interface ServerReleaseNotes {
  readonly sections: readonly ReleaseNoteSection[];
  /** The target release on GitHub, for the full text. */
  readonly url: string;
}

// Only what is read here; GitHub sends far more, and none of it is required to
// keep its shape for these notes to stay useful.
const releaseListSchema = z.array(
  z.object({
    tag_name: z.string(),
    body: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    html_url: z.string().optional(),
  }),
);

// release-please headings, mapped to what an operator is looking for. Anything
// else keeps its own heading and sorts after these.
const SECTION_TITLES: Record<string, string> = {
  '⚠ BREAKING CHANGES': 'Breaking changes',
  'BREAKING CHANGES': 'Breaking changes',
  Features: 'New',
  'Bug Fixes': 'Fixes',
  'Performance Improvements': 'Performance',
};
const SECTION_ORDER = ['Breaking changes', 'New', 'Fixes', 'Performance'];

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * One release-please bullet as an operator reads it: no scope, issue or commit
 * links, no markdown. Null for entries that say nothing to an operator.
 */
function noteText(line: string): string | null {
  let text = line.replace(/^\s*[*-]\s+/, '');
  const scope = /^\*\*([^*]+):\*\*\s*/.exec(text);
  // Dependency bumps are most of every release and none of what changed.
  if (scope?.[1] === 'deps') return null;
  if (scope !== null) text = text.slice(scope[0].length);
  text = text
    // Trailing ` ([#956](…))` and ` ([55bfcd6](…))` references.
    .replace(/(?:\s*\(\[[^\]]*\]\([^)]*\)\))+\s*$/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  if (text === '') return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parseBody(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const title = SECTION_TITLES[heading[1]!] ?? heading[1]!;
      current = sections.get(title) ?? [];
      sections.set(title, current);
      continue;
    }
    // Lines before the first `###` — the `## [4.2.0](compare…)` header — and
    // anything that is not a bullet carry no note of their own.
    if (current === undefined || !/^\s*[*-]\s+/.test(line)) continue;
    const text = noteText(line);
    if (text !== null) current.push(text);
  }
  return sections;
}

/**
 * The notes between the running Server and `target`, newest release first.
 *
 * A skipped release's changes ship with the update too, so every published
 * version above `running` up to `target` contributes. Without a usable
 * `running` (an older Server's health check, a `-dev` build) only the target
 * release is shown — guessing a range could list changes already installed.
 * Null when nothing readable is left, so the caller shows no section at all.
 */
export function serverReleaseNotes(
  releases: unknown,
  running: string | undefined,
  target: string,
): ServerReleaseNotes | null {
  const parsed = releaseListSchema.safeParse(releases);
  const targetVersion = parseVersion(target);
  if (!parsed.success || targetVersion === null) return null;
  const runningVersion = running === undefined ? null : parseVersion(running);

  const included = parsed.data
    .flatMap((release) => {
      // Staging releases use the same version tags as production. The signed
      // update target bounds this range, including changes not yet promoted.
      if (release.draft === true) return [];
      if (!release.tag_name.startsWith('v')) return [];
      const version = parseVersion(release.tag_name);
      return version === null ? [] : [{ release, version }];
    })
    .filter(({ version }) =>
      runningVersion === null
        ? compare(version, targetVersion) === 0
        : compare(version, runningVersion) > 0 && compare(version, targetVersion) <= 0,
    )
    .sort((a, b) => compare(b.version, a.version));

  const merged = new Map<string, string[]>();
  for (const { release } of included) {
    for (const [title, items] of parseBody(release.body ?? '')) {
      const into = merged.get(title) ?? [];
      // A fix backported into several releases is one change to the operator.
      for (const item of items) if (!into.includes(item)) into.push(item);
      merged.set(title, into);
    }
  }
  const rank = (title: string): number => {
    const index = SECTION_ORDER.indexOf(title);
    return index === -1 ? SECTION_ORDER.length : index;
  };
  const sections = [...merged]
    .filter(([, items]) => items.length > 0)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([title, items]) => ({ title, items }));
  if (sections.length === 0) return null;

  const targetRelease = included.find(({ version }) => compare(version, targetVersion) === 0);
  // The link is opened as given, so an unsigned answer may not pick where to.
  const reported = targetRelease?.release.html_url;
  const url = reported?.startsWith(RELEASE_PAGE_PREFIX) ? reported : releasePageUrl(target);
  return { sections, url };
}
