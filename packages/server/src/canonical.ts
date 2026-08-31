/**
 * Canonical owner/repo parser (concept §19.0, #174). Single source of truth
 * for the input-validation at every external `POST /sessions { project }`-shape
 * boundary — the rules listed here are the non-negotiable pre-filter before the
 * `<owner>/<repo>` string reaches ANY of the three dangerous sinks (FS path,
 * Docker container name, GitHub clone URL).
 *
 * The functions return the canonical (lowercased) form; the ON CONFLICT
 * `(owner, repo)` lookup path in {@link EventStore.upsertProject} + the
 * `lower(owner)=owner` CHECK are the DB-side backstops.
 *
 * NO silent normalisation: an `Owner/Repo` arriving via the POST body is
 * rejected (400) rather than silently coerced — the design's §19.0 wording
 * ("kein Silent-Normalisierung — der Client hat einen falschen Bezeichner
 * geschickt"). A caller reaching this module is expected to have already
 * canonicalised; the validator is the LAST gate before persistence.
 */

export interface CanonicalProject {
  owner: string;
  repo: string;
}

/** Validate that `input` is exactly one `/`-separated `<owner>/<repo>` pair
 *  where both halves honour the GitHub charset + length rules. The check
 *  is lowercased for lookups (GitHub identities are case-insensitive) but
 *  the CANONICAL form returned is also lowercased since the projects table
 *  stores lowercase (slice 1 §19.2 lowercase-persist contract + CHECK
 *  constraint). A caller passing mixed-case here is *accepted* (GitHub
 *  accepts the same) and the resulting `{owner, repo}` is canonicalised.
 *
 *  Mentally: this function is BOTH a validator AND the canonicalisation site.
 *  An invalid input → `undefined`; a valid input → canonical lowercase form.
 *
 *  @returns `undefined` when the input fails the §19.0 rules; caller surfaces
 *           a 400. A `CanonicalProject` (lowercased) otherwise. */
export function parseOwnerRepo(input: string): CanonicalProject | undefined {
  let s = input.trim();
  // Strip a leading `https://github.com/` or `git@github.com:` prefix — a
  // pasted-URL form; we accept it for the UX of "tap a GitHub repo URL".
  s = s.replace(/^https?:\/\/github\.com\//, '').replace(/^git@github\.com:/, '');
  // Strip a trailing `.git` (a GitHub URL form that some clients may paste).
  if (s.endsWith('.git')) s = s.slice(0, -4);
  // Reject trailing slash or empty.
  if (s === '' || s === '/') return undefined;
  // Exactly one `/` separator — multiple → invalid (multi-segment paths are
  // never legal GitHub owner/repo IDs).
  const segments = s.split('/');
  if (segments.length !== 2) return undefined;
  const [ownerRaw, repoRaw] = segments;
  if (ownerRaw === undefined || repoRaw === undefined) return undefined;
  if (ownerRaw !== ownerRaw.toLowerCase() || repoRaw !== repoRaw.toLowerCase()) return undefined;
  const owner = ownerRaw.toLowerCase();
  const repo = repoRaw.toLowerCase();
  if (!validOwner(owner) || !validRepo(repo)) return undefined;
  return { owner, repo };
}

/** GitHub owner rules: `[a-z0-9-]`, 1–39 chars, no leading/trailing `-`.
 *  (GitHub's "Username may only contain alphanumeric characters or single
 *  hyphens, and cannot begin or end with a hyphen.") */
function validOwner(owner: string): boolean {
  if (owner.length < 1 || owner.length > 39) return false;
  if (/^[a-z0-9-]+$/.test(owner) === false) return false;
  if (owner.startsWith('-') || owner.endsWith('-')) return false;
  if (owner.includes('--')) return false;
  return true;
}

/** GitHub repo rules: `[A-Za-z0-9._-]`, 1–100 chars, no leading/trailing
 *  `.`/`-`/`_`, no consecutive `.`. We lowercase before validating so the
 *  kept charset is `[a-z0-9._-]` post-canonicalisation. */
function validRepo(repo: string): boolean {
  if (repo.length < 1 || repo.length > 100) return false;
  if (/^[a-z0-9._-]+$/.test(repo) === false) return false;
  if (repo.startsWith('.') || repo.startsWith('-') || repo.startsWith('_')) return false;
  if (repo.endsWith('.') || repo.endsWith('-') || repo.endsWith('_')) return false;
  if (repo.includes('..')) return false;
  return true;
}

/** Turn an operator-typed project name into a `repo` slug for a project created
 *  WITHOUT a GitHub repository (`kind: 'local'`). A local project has no upstream
 *  name to canonicalise, so this is the one place where normalisation is allowed —
 *  unlike {@link parseOwnerRepo}, which rejects rather than coerces because there
 *  the caller is naming an existing remote identity and a silent rewrite would
 *  point at the wrong repo.
 *
 *  The output is deliberately validated against the SAME {@link validRepo} rules,
 *  so a local project can later be linked to a GitHub repo without its identity
 *  becoming illegal, and so the shared FS-path / container-name sinks see one
 *  charset regardless of project kind.
 *
 *  @returns `undefined` when nothing legal survives normalisation (e.g. a name of
 *           only punctuation); caller surfaces a 400. */
export function slugifyProjectName(input: string): string | undefined {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Collapse the runs the substitution above can create, then trim the
    // leading/trailing punctuation `validRepo` forbids.
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 100)
    // Slicing can re-expose a trailing separator.
    .replace(/[._-]+$/, '');
  return validRepo(slug) ? slug : undefined;
}

/** Derive the canonical hyphen-slug container_name for an `(owner, repo)`.
 *  `verity-<owner>--<repo>` — single segment, lowercased, mirrors slice-1's
 *  `upsertProject` implementation. Exported as a small util for the conductor /
 *  route layer to share. */
export function containerNameFor(c: CanonicalProject): string {
  // Docker names allow `[a-zA-Z0-9_.-]`. Preserve repo `.`/`_` so GitHub repos
  // that differ only by punctuation do not collide; `--` is unambiguous because
  // owners reject consecutive hyphens and repos cannot start with `-`.
  return `verity-${c.owner}--${c.repo}`;
}
