import { describe, expect, it } from 'vitest';
import { DEVCONTAINER_IMAGE_PREFIX } from './provisioner.js';
import {
  formatToolkitDriftReport,
  isDriftReportable,
  reportToolkitDrift,
  toolkitDriftEntryOf,
  toolkitDriftReport,
  type ToolkitDriftInput,
  type ToolkitDriftProject,
} from './toolkit-drift.js';

const CURRENT = 'sha256:aaaa';
const OLD = 'sha256:bbbb';

function project(name: string, overrides: Partial<ToolkitDriftInput> = {}): ToolkitDriftInput {
  return {
    owner: 'acme',
    repo: name,
    imageRef: `ghcr.io/acme/${DEVCONTAINER_IMAGE_PREFIX}${name}:latest`,
    toolkitIdentity: CURRENT,
    ...overrides,
  };
}

const baseImage = (name: string, toolkitIdentity: string | null = CURRENT): ToolkitDriftInput =>
  project(name, { imageRef: 'ghcr.io/heey-global/verity-sandbox:1.2.3', toolkitIdentity });

// The per-project API path reads this directly, so it has to agree with the
// startup report exactly — a project described one way in the log and another
// way in the app is the failure mode this split is most likely to introduce.
describe('toolkitDriftEntryOf', () => {
  it('judges one project the same way the fleet report does', () => {
    const projects = [
      project('fresh'),
      project('stale', { toolkitIdentity: OLD }),
      project('unrecorded', { toolkitIdentity: null }),
      baseImage('pinned'),
    ];
    const report = toolkitDriftReport({ current: CURRENT, projects });

    expect(projects.map((each) => toolkitDriftEntryOf(CURRENT, each))).toEqual([...report.entries]);
  });

  it('reports unknown — never matches — when this Server ships no bundle', () => {
    expect(toolkitDriftEntryOf(undefined, project('fresh'))).toMatchObject({
      verdict: 'unknown',
      carrier: 'devcontainer',
    });
  });

  it('carries the carrier that decides the remedy', () => {
    expect(toolkitDriftEntryOf(CURRENT, baseImage('pinned', OLD))).toMatchObject({
      verdict: 'drifted',
      carrier: 'base-image',
    });
  });
});

describe('toolkitDriftReport', () => {
  it('separates matching from drifted projects', () => {
    const report = toolkitDriftReport({
      current: CURRENT,
      projects: [project('fresh'), project('stale', { toolkitIdentity: OLD })],
    });
    expect(report.entries.map((entry) => entry.verdict)).toEqual(['matches', 'drifted']);
    expect(report.drifted.map((entry) => entry.name)).toEqual(['acme/stale']);
    expect(report.unknown).toEqual([]);
  });

  // The distinction the whole column exists for. A project provisioned before
  // the identity was recorded may or may not be current; calling that "matches"
  // would hide exactly the fleet this change was written to find.
  it('reports a missing recorded identity as unknown, never as matching', () => {
    const report = toolkitDriftReport({
      current: CURRENT,
      projects: [
        project('legacy', { toolkitIdentity: null }),
        // Field omitted entirely, not null: a caller that never sets it must
        // land in the same place, or a projection that drops the column would
        // silently promote every project to "matches".
        { owner: 'acme', repo: 'never-provisioned', imageRef: 'ghcr.io/acme/x:1' },
      ],
    });
    expect(report.unknown.map((entry) => entry.name)).toEqual([
      'acme/legacy',
      'acme/never-provisioned',
    ]);
    expect(report.drifted).toEqual([]);
  });

  // A Server without a bundle cannot compare, so it must not accuse. Reporting
  // these as drifted would send an operator rebuilding images that are fine.
  it('judges nothing when the Server ships no toolkit', () => {
    const report = toolkitDriftReport({
      current: undefined,
      projects: [project('a'), project('b', { toolkitIdentity: OLD })],
    });
    expect(report.drifted).toEqual([]);
    expect(report.unknown).toHaveLength(2);
  });

  it('classifies the carrier by whether Verity built the image', () => {
    const report = toolkitDriftReport({
      current: CURRENT,
      projects: [project('built'), baseImage('as-is'), project('none', { imageRef: null })],
    });
    expect(report.entries.map((entry) => entry.carrier)).toEqual([
      'devcontainer',
      'base-image',
      'base-image',
    ]);
  });

  // The prefix identifies the repository, not the registry path. A registry
  // whose namespace happened to contain the prefix must not turn a base image
  // into a devcontainer image, or the report would recommend the wrong remedy.
  it('reads the prefix from the repository, not from the registry namespace', () => {
    const report = toolkitDriftReport({
      current: CURRENT,
      projects: [baseImage('x'), project('y', { imageRef: `${DEVCONTAINER_IMAGE_PREFIX}local` })],
    });
    expect(report.entries.map((entry) => entry.carrier)).toEqual(['base-image', 'devcontainer']);
  });

  // The name is operator-supplied, so it cannot be the last word. An image the
  // operator pinned is one Verity pulls and never builds — filing it as
  // Verity-built would prescribe a re-provision that cannot touch its toolkit.
  it('trusts the pinned image over its name', () => {
    const pinned = `ghcr.io/acme/${DEVCONTAINER_IMAGE_PREFIX}looks-built:1`;
    const report = toolkitDriftReport({
      current: CURRENT,
      projects: [project('impostor', { imageRef: pinned, imageOverrideRef: pinned })],
    });
    expect(report.entries.map((entry) => entry.carrier)).toEqual(['base-image']);
  });

  // The converse: pinning a base image does not stop Verity building on top of
  // it. The derived tag differs from the pin, and that project IS rebuildable.
  it('keeps a devcontainer built on top of a pinned base image', () => {
    const report = toolkitDriftReport({
      current: CURRENT,
      projects: [project('built', { imageOverrideRef: 'ghcr.io/acme/custom-base:1' })],
    });
    expect(report.entries.map((entry) => entry.carrier)).toEqual(['devcontainer']);
  });
});

describe('formatToolkitDriftReport', () => {
  const lines = (projects: readonly ToolkitDriftInput[], current: string | null = CURRENT) =>
    formatToolkitDriftReport(toolkitDriftReport({ current: current ?? undefined, projects }));

  it('says nothing when every project matches', () => {
    expect(lines([project('a'), baseImage('b')])).toEqual([]);
  });

  // Both populations drift from the same cause, but re-provisioning can only
  // rebuild one of them. One combined line would read as a single actionable
  // number and send half a fleet through a rebuild that changes nothing.
  it('reports the two carriers on separate lines with different remedies', () => {
    const out = lines([
      project('built', { toolkitIdentity: OLD }),
      baseImage('as-is', OLD),
      baseImage('also-as-is', OLD),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('1 devcontainer project(s)');
    // Content hashes have no ordering, and a rolled-back Server sees images
    // built against a NEWER toolkit through this same path.
    expect(out[0]).toContain('a different toolkit or boundary policy');
    expect(out[0]).not.toMatch(/older/u);
    // Nor "will fail": the identity covers the boundary policy too, so a
    // policy-only bump can leave an image that still passes the new rules.
    expect(out[0]).not.toMatch(/will fail/u);
    expect(out[0]).toMatch(/no longer holds and needs re-checking/u);
    expect(out[0]).toContain('re-provisioning rebuilds and re-attests them');
    expect(out[1]).toContain('2 base-image project(s)');
    expect(out[1]).toContain('only a rebuilt base image fixes it');
  });

  it('names an unpinned project among the unverified rather than dropping it', () => {
    const out = lines([{ owner: 'acme', repo: 'unpinned', imageRef: null }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('acme/unpinned');
    expect(out[0]).toContain('no verified sandbox toolkit recorded for 1 project(s)');
  });

  it('keeps unrecorded projects out of the drift lines', () => {
    const out = lines([
      project('stale', { toolkitIdentity: OLD }),
      project('legacy', { toolkitIdentity: null }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('acme/stale');
    expect(out[0]).not.toContain('acme/legacy');
    expect(out[1]).toContain('no verified sandbox toolkit recorded for 1 project(s)');
  });

  // `null` is written both when nothing compared the image and when a
  // comparison rejected it. The line covers both, because claiming the first
  // would tell an operator an image was never checked that in fact failed its
  // check — and no remedy is promised, since a trusted default image or a
  // supervisor-off deployment is never attested at all.
  it('claims neither more nor less than a null identity supports', () => {
    const [line] = lines([project('legacy', { toolkitIdentity: null })]);
    expect(line).toMatch(/either never compared .* or failed that comparison/u);
    expect(line).not.toMatch(/re-provision/iu);
  });

  it('states its own blindness once when the Server ships no toolkit', () => {
    const out = lines([project('a'), project('b')], null);
    expect(out).toEqual([
      'verity: sandbox toolkit drift cannot be judged — this Server ships no bundled toolkit ' +
        '(2 project(s) unchecked).',
    ]);
  });

  it('stays silent on a Server with no toolkit and no projects', () => {
    expect(lines([], null)).toEqual([]);
  });

  // A fleet-wide drift is the expected state right after a deploy. The list is
  // capped so the line stays readable — but the count is never capped, and the
  // remainder is stated, so a truncated list can't be mistaken for the whole.
  it('caps the names it prints and counts the remainder out loud', () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      project(`p${String(index)}`, { toolkitIdentity: OLD }),
    );
    const [line] = lines(many);
    expect(line).toContain('11 devcontainer project(s)');
    expect(line).toContain('acme/p7 (+3 more)'); // 8 named, 3 counted
    expect(line).not.toContain('acme/p8');
  });
});

// Only projects whose recorded image is the one a Sandbox would run may be
// named. An `absent` or `failed` row keeps the `imageRef` of a generation that
// no longer exists; counting those inflates the fleet with images nothing is
// deployed on, and the remedies would have no subject.
describe('isDriftReportable', () => {
  const row = { kind: 'github', state: 'active', imageRef: 'ghcr.io/acme/x:1' };

  it('takes the active Sandboxes and nothing else', () => {
    expect(isDriftReportable(row)).toBe(true);
    for (const state of ['absent', 'failed', 'cloning', 'container_starting']) {
      expect(isDriftReportable({ ...row, state })).toBe(false);
    }
  });

  it('skips the control plane, which has no Sandbox', () => {
    expect(isDriftReportable({ ...row, kind: 'control_plane' })).toBe(false);
  });

  // Unpinning a project empties `image_ref` while its Sandbox keeps running the
  // image it was last given. Such a row can only be reported as unknown — but
  // dropping it would take a project that is demonstrably unverified and leave
  // it out of the one report meant to find exactly those.
  it('keeps an active project whose image was unpinned', () => {
    expect(isDriftReportable({ ...row, imageRef: null })).toBe(true);
  });

  it('keeps a local project, which runs a Sandbox like any other', () => {
    expect(isDriftReportable({ ...row, kind: 'local' })).toBe(true);
  });
});

describe('reportToolkitDrift', () => {
  const active = (
    name: string,
    overrides: Partial<ToolkitDriftProject> = {},
  ): ToolkitDriftProject => ({ ...project(name), kind: 'github', state: 'active', ...overrides });

  it('warns about the projects that count and stays quiet about the rest', async () => {
    const warnings: string[] = [];
    await reportToolkitDrift({
      listProjects: () =>
        Promise.resolve([
          active('stale', { toolkitIdentity: OLD }),
          active('current'),
          // Not running: its recorded image belongs to a Sandbox that is gone.
          active('gone', { toolkitIdentity: OLD, state: 'absent' }),
        ]),
      trustedIdentity: () => Promise.resolve(CURRENT),
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('acme/stale');
    expect(warnings[0]).not.toContain('acme/gone');
  });

  it('says nothing at all when the fleet is current', async () => {
    const warnings: string[] = [];
    await reportToolkitDrift({
      listProjects: () => Promise.resolve([active('a')]),
      trustedIdentity: () => Promise.resolve(CURRENT),
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([]);
  });

  // A boot must not hang on this, and it must not die on it either — but the
  // failure has to be audible, or a silent catch would read exactly like a
  // clean fleet to the one operator who most needs to know it wasn't checked.
  it('survives a failing read and says the check was skipped', async () => {
    const warnings: string[] = [];
    await expect(
      reportToolkitDrift({
        listProjects: () => Promise.reject(new Error('database is asleep')),
        trustedIdentity: () => Promise.resolve(CURRENT),
        warn: (line) => warnings.push(line),
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      'verity: sandbox toolkit drift check skipped — Error: database is asleep',
    ]);
  });

  it('survives a failing toolkit read the same way', async () => {
    const warnings: string[] = [];
    await reportToolkitDrift({
      listProjects: () => Promise.resolve([active('a')]),
      trustedIdentity: () => Promise.reject(new Error('bundle unreadable')),
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([
      'verity: sandbox toolkit drift check skipped — Error: bundle unreadable',
    ]);
  });

  // A read that never answers is the failure mode a `catch` cannot see: it does
  // not throw, it just never returns, and this runs before the Server listens.
  it('gives up on a read that never answers rather than holding the boot', async () => {
    const warnings: string[] = [];
    await expect(
      reportToolkitDrift({
        listProjects: () => new Promise(() => {}),
        trustedIdentity: () => Promise.resolve(CURRENT),
        warn: (line) => warnings.push(line),
        timeoutMs: 5,
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      'verity: sandbox toolkit drift check skipped — Error: reading the project list did not answer within 5ms',
    ]);
  });

  it('gives up on a toolkit identity read that never answers too', async () => {
    const warnings: string[] = [];
    await reportToolkitDrift({
      listProjects: () => Promise.resolve([active('a')]),
      trustedIdentity: () => new Promise(() => {}),
      warn: (line) => warnings.push(line),
      timeoutMs: 5,
    });
    expect(warnings).toEqual([
      'verity: sandbox toolkit drift check skipped — Error: reading this Server toolkit identity did not answer within 5ms',
    ]);
  });
});
