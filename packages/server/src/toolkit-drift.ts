/**
 * Deploy-time drift between the sandbox toolkit a Server ships and the toolkit
 * each project's Sandbox image was last judged against.
 *
 * The runner-boundary attestation already catches this — but only per project,
 * only when that project is next provisioned, and only as a denial that removes
 * the native tool channel. From an operator's seat the fleet goes stale in
 * silence and each project rediscovers it separately, which is how a merged
 * security fix can sit in `main` while reaching no Sandbox at all.
 *
 * This module makes the same fact sayable at startup, from recorded state
 * alone: no Docker, no image pulls, no attestation runs.
 */

import { DEVCONTAINER_IMAGE_PREFIX } from './provisioner.js';

/** How a project's Sandbox image received its toolkit — which decides what
 *  repairs it, so the two populations are never reported as one number. */
export type ToolkitCarrier =
  /** Verity built this image from the repo's `.devcontainer/`, so its content
   *  hash is Verity's to compute and a re-provision can rebuild it. */
  | 'devcontainer'
  /** The project runs a base image as-is. Nothing Verity does at provision time
   *  changes its toolkit; only a new base image does. */
  | 'base-image';

/** Whether the project's recorded toolkit can be squared with the Server's. */
export type ToolkitDriftVerdict =
  | 'matches'
  /** Recorded, and different: this image predates the toolkit the Server ships. */
  | 'drifted'
  /** Nothing recorded, or the Server ships no bundle to compare against. NOT a
   *  synonym for `matches` — it is the absence of a verdict, and the whole
   *  reason {@link ToolkitDriftInput.toolkitIdentity} exists. */
  | 'unknown';

export interface ToolkitDriftInput {
  readonly owner: string;
  readonly repo: string;
  readonly imageRef: string | null;
  /** The operator's pinned image, when there is one. Needed because the image
   *  NAME alone cannot settle the carrier — see {@link carrierOf}. */
  readonly imageOverrideRef?: string | null;
  readonly toolkitIdentity?: string | null;
}

/**
 * Which rows the report is about: the projects whose recorded image is the one
 * a Sandbox would run.
 *
 * An `absent` or `failed` row can still hold the `imageRef` of a generation that
 * is gone. Naming those inflates the count with images no Sandbox is deployed
 * on, and the remedies would be work with no subject. The control plane has no
 * Sandbox at all.
 *
 * A row with no `imageRef` DOES count, and this is the one inclusion worth
 * arguing for. It has nothing to compare, so it can only ever be `unknown` — but
 * that is a statement, and dropping it would be silence. An active project
 * reaches that state by being unpinned: `upsertProject` writes the new pin
 * straight into `image_ref`, so clearing a pin empties it while the Sandbox goes
 * on running the image it was last given. Excluding those rows would take a
 * project that is demonstrably unverified and remove it from the report on the
 * grounds that there is nothing to say about it.
 *
 * `active` is a RECORDED state, not an observation: the container reconciler
 * runs on the project-list and detail paths, so at startup a row can still say
 * `active` about a container that disappeared while the Server was down. That is
 * why the report speaks about verdicts and images rather than about running
 * containers — the lines stay true for such a row, and its next start
 * re-provisions and re-attests it anyway. Reconciling here instead would mean
 * Docker calls on the boot path, which is exactly what this check avoids.
 *
 * Soft-deleted rows are excluded upstream, by `listProjects`' default: a repo
 * the operator removed is not the fleet either.
 */
export function isDriftReportable(project: {
  readonly kind?: string | undefined;
  readonly state: string;
  readonly imageRef: string | null;
}): boolean {
  return project.kind !== 'control_plane' && project.state === 'active';
}

export interface ToolkitDriftEntry {
  readonly name: string;
  readonly carrier: ToolkitCarrier;
  readonly verdict: ToolkitDriftVerdict;
}

export interface ToolkitDriftReport {
  /** The Server's own trust-root identity, or `undefined` when it ships no
   *  bundle — in which case every entry is `unknown` by construction. */
  readonly current: string | undefined;
  readonly entries: readonly ToolkitDriftEntry[];
  readonly drifted: readonly ToolkitDriftEntry[];
  readonly unknown: readonly ToolkitDriftEntry[];
}

/**
 * Which population a project belongs to — decided by provenance first, name second.
 *
 * The pinned image is the load-bearing signal: when a project runs exactly the
 * image the operator configured, Verity did not build it, whatever it is called.
 * That has to be checked BEFORE the name, because the name is operator-supplied
 * and a pinned `…/verity-devc-anything:tag` would otherwise be filed as
 * Verity-built and told to fix itself by re-provisioning — a rebuild that never
 * happens for an image Verity only pulls.
 *
 * Only once the image is known not to be a pinned one does the prefix decide,
 * and there it is trustworthy: the remaining names are Verity's own — the
 * derived `verity-devc-…` tag from a devcontainer build, or the default base
 * image. A pinned image plus a `.devcontainer/` produces a derived tag that
 * differs from the pin, so that project keeps its `devcontainer` carrier.
 */
function carrierOf(project: ToolkitDriftInput): ToolkitCarrier {
  const pinned = project.imageOverrideRef ?? null;
  if (pinned !== null && pinned === project.imageRef) return 'base-image';
  const imageRef = project.imageRef;
  const repository = imageRef === null ? '' : imageRef.slice(imageRef.lastIndexOf('/') + 1);
  return repository.startsWith(DEVCONTAINER_IMAGE_PREFIX) ? 'devcontainer' : 'base-image';
}

/**
 * One project's verdict against the Server's trust root.
 *
 * Split out of {@link toolkitDriftReport} so the per-project API path can reach
 * the same judgement without assembling a fleet-wide report. Both callers must
 * stay on this one function: a second implementation of the comparison is how a
 * project ends up described one way in the startup log and another way in the
 * app.
 *
 * A Server with no bundle judges nothing — the project comes back `unknown`
 * rather than drifted, because "I cannot compare" and "these do not match" call
 * for opposite responses and only one of them is true.
 */
export function toolkitDriftEntryOf(
  current: string | undefined,
  project: ToolkitDriftInput,
): ToolkitDriftEntry {
  const recorded = project.toolkitIdentity ?? null;
  const verdict: ToolkitDriftVerdict =
    current === undefined || recorded === null
      ? 'unknown'
      : recorded === current
        ? 'matches'
        : 'drifted';
  return {
    name: `${project.owner}/${project.repo}`,
    carrier: carrierOf(project),
    verdict,
  };
}

/** Pure comparison of the Server's trust root against what each project recorded. */
export function toolkitDriftReport(args: {
  readonly current: string | undefined;
  readonly projects: readonly ToolkitDriftInput[];
}): ToolkitDriftReport {
  const entries = args.projects.map((project) => toolkitDriftEntryOf(args.current, project));
  return {
    current: args.current,
    entries,
    drifted: entries.filter((entry) => entry.verdict === 'drifted'),
    unknown: entries.filter((entry) => entry.verdict === 'unknown'),
  };
}

/** How many projects a line names before it stops naming them. A fleet-wide
 *  drift is the normal case right after a deploy, and a log line listing every
 *  project would be unreadable exactly when it matters most. The remainder is
 *  always counted out loud — a truncated list that looked complete would be
 *  worse than no list. */
const MAX_NAMED = 8;

function nameList(entries: readonly ToolkitDriftEntry[]): string {
  const named = entries.slice(0, MAX_NAMED).map((entry) => entry.name);
  const rest = entries.length - named.length;
  return rest > 0 ? `${named.join(', ')} (+${String(rest)} more)` : named.join(', ');
}

/**
 * The report as log lines — one per affected population, none when there is
 * nothing to say.
 *
 * The two populations are kept apart because their remedies are: a devcontainer
 * project is repaired by re-provisioning it, while a base-image project is not
 * repaired by anything the Server does — it needs a new base image. A single
 * combined count would read as one actionable number and send half the fleet
 * through a rebuild that cannot fix it.
 */
export function formatToolkitDriftReport(report: ToolkitDriftReport): readonly string[] {
  const lines: string[] = [];
  if (report.current === undefined) {
    // Not a drift finding: the Server cannot make one. Said once, without
    // per-project noise, because the remedy is about this Server, not them.
    if (report.entries.length > 0) {
      lines.push(
        'verity: sandbox toolkit drift cannot be judged — this Server ships no bundled toolkit ' +
          `(${String(report.entries.length)} project(s) unchecked).`,
      );
    }
    return lines;
  }
  for (const carrier of ['devcontainer', 'base-image'] as const) {
    const drifted = report.drifted.filter((entry) => entry.carrier === carrier);
    if (drifted.length === 0) continue;
    const remedy =
      carrier === 'devcontainer'
        ? 're-provisioning rebuilds and re-attests them'
        : 're-provisioning re-attests them, but cannot change what the image contains — ' +
          'if its toolkit is genuinely stale, only a rebuilt base image fixes it';
    // Two things this line must NOT claim.
    //
    // Not "older": identities are content hashes with no ordering, and a Server
    // rolled back to an earlier release sees images built against a NEWER
    // toolkit through this same code path.
    //
    // Not "will fail": the identity also covers the boundary policy, so after a
    // policy-only bump an image whose bytes never moved may well pass the new
    // rules. What a mismatch establishes is that the recorded verdict was made
    // under conditions that no longer hold — it is stale, not refuted. Saying
    // otherwise would prescribe a base-image rebuild for images that need none.
    lines.push(
      `verity: sandbox toolkit drift — ${String(drifted.length)} ${carrier} project(s) were ` +
        `last verified against a different toolkit or boundary policy than this Server ships, ` +
        `so their attestation verdict no longer holds and needs re-checking: ` +
        `${nameList(drifted)}. ${remedy}.`,
    );
  }
  if (report.unknown.length > 0) {
    // Says only what the recorded state supports, and promises no remedy.
    // Only a passing boundary attestation records an identity, so `null` covers
    // both "never compared" (provisioned before this existed, running the
    // trusted default image, or with the Runner supervisor off) and "compared
    // and rejected" — a case that already announces itself per project, as a
    // provision warning and a disabled Runner. The line must not claim the
    // first, and cannot distinguish them; and since some of those projects are
    // never attested by design, telling them to re-provision would be advice
    // that cannot terminate.
    lines.push(
      `verity: no verified sandbox toolkit recorded for ${String(report.unknown.length)} ` +
        `project(s) — their image was either never compared against this Server's toolkit or ` +
        `failed that comparison, so drift cannot be ruled out: ${nameList(report.unknown)}.`,
    );
  }
  return lines;
}

/** A project row as the report needs to see it: enough to judge whether it
 *  counts ({@link isDriftReportable}) and, if so, what to say about it. */
export type ToolkitDriftProject = ToolkitDriftInput & {
  readonly kind?: string | undefined;
  readonly state: string;
};

/**
 * Await `work()`, giving up after `timeoutMs` with an error naming `what`.
 *
 * The abandoned promise is left to settle on its own — there is nothing to
 * cancel a pending database query with, and holding the boot to find out defeats
 * the purpose. The timer is always cleared, so a fast read leaves no handle
 * behind to delay process exit.
 */
async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The startup report: read recorded state, say what drifted, never fail.
 *
 * Read-only over the database and the Server's own bundle — no Docker, no image
 * pulls, no attestation runs. What it costs a boot is one project query and one
 * directory hash, on a startup path that has already read the same database
 * several times: it adds no dependency the boot did not already have.
 *
 * Both reads are nonetheless bounded. Those other boot reads are load-bearing —
 * if the database never answers there is nothing to start — but this one is a
 * diagnostic, and a diagnostic that can hang a boot has become the failure it
 * was meant to describe. A read that never settles is reported exactly like a
 * read that threw.
 *
 * A report that cannot be produced is a missing warning, not a reason to refuse
 * to start: any failure is caught and said out loud as a skipped check, so the
 * silence that follows is never mistaken for a clean fleet.
 */
export async function reportToolkitDrift(args: {
  readonly listProjects: () => Promise<readonly ToolkitDriftProject[]>;
  readonly trustedIdentity: () => Promise<string | undefined>;
  readonly warn: (line: string) => void;
  /** Per-read budget. Generous on purpose: this must fire only for a read that
   *  is never coming back, not for one that is merely slow on a cold boot. */
  readonly timeoutMs?: number | undefined;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 10_000;
  try {
    const projects = await withTimeout(
      () => args.listProjects(),
      timeoutMs,
      'reading the project list',
    );
    const report = toolkitDriftReport({
      current: await withTimeout(
        () => args.trustedIdentity(),
        timeoutMs,
        'reading this Server toolkit identity',
      ),
      projects: projects.filter(isDriftReportable),
    });
    for (const line of formatToolkitDriftReport(report)) args.warn(line);
  } catch (error) {
    args.warn(`verity: sandbox toolkit drift check skipped — ${String(error)}`);
  }
}
