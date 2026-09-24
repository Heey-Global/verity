import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const script = resolve('scripts/release-lifecycle.mjs');
function run(state: {
  train?: 'backend' | 'mobile' | 'website';
  draft?: boolean;
  unrelatedDraft?: boolean;
  newerDraft?: boolean;
  largeReleasePayload?: boolean;
  pending?: boolean;
  searchMissing?: boolean;
  missing?: boolean;
  stale?: boolean;
  mismatchedTag?: boolean;
  historicalManifest?: unknown;
  mainManifest?: unknown;
}) {
  const train = state.train ?? 'backend';
  const manifestPath =
    train === 'mobile' ? 'apps/mobile' : train === 'website' ? 'docs/website' : '.';
  const prefix = train === 'mobile' ? 'mobile-v' : train === 'website' ? 'website-v' : 'v';
  const version = train === 'mobile' ? '1.33.0' : '1.2.3';
  const tag = `${prefix}${version}`;
  const manifestName = `.release-please-manifest.${train}.json`;
  const cwd = mkdtempSync(join(tmpdir(), 'release-lifecycle-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'tag.gpgSign', 'false');
  git('config', 'commit.gpgSign', 'false');
  writeFileSync(
    join(cwd, manifestName),
    JSON.stringify(state.historicalManifest ?? { [manifestPath]: version }),
  );
  git('add', '.');
  git('commit', '-qm', 'chore: fixture');
  const boundarySha = git('rev-parse', 'HEAD');
  git('tag', tag);
  if (state.mismatchedTag) {
    writeFileSync(
      join(cwd, manifestName),
      JSON.stringify({ [manifestPath]: train === 'mobile' ? '1.33.1' : '1.2.4' }),
    );
    git('add', '.');
    git('commit', '-qm', 'chore: next version');
    git('tag', '--force', tag);
    git('reset', '--hard', boundarySha);
  }
  writeFileSync(
    join(cwd, manifestName),
    JSON.stringify(state.mainManifest ?? { [manifestPath]: version }),
  );
  git('add', '.');
  git('commit', '--allow-empty', '-qm', 'chore: migrate manifest');
  const sha = git('rev-parse', 'HEAD');
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(
    join(cwd, 'bin/gh'),
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
const fixture = ${JSON.stringify({ sha, boundarySha, state, tag, prefix, train })};
let result;
if (args.includes('git/ref/heads/main')) result = {object:{sha:fixture.state.stale ? 'f'.repeat(40) : fixture.sha}};
else if (args.includes('/releases?')) {
  const releases = (fixture.state.missing || (fixture.state.pending && !fixture.state.draft)) ? [] : [{tag_name:fixture.tag, draft:!!fixture.state.draft, prerelease:false}];
  if (fixture.state.unrelatedDraft) releases.push({tag_name:fixture.train === 'mobile' ? 'mobile-v1.12.0' : 'v0.9.0', draft:true, prerelease:false});
  if (fixture.state.newerDraft) releases.push({tag_name:fixture.train === 'mobile' ? 'mobile-v1.34.0' : 'v1.3.0', draft:true, prerelease:false});
  if (fixture.state.largeReleasePayload) releases.push(...Array.from({length:100}, (_, index) => ({tag_name:'v0.'+index+'.0', draft:true, prerelease:false, body:'x'.repeat(20000)})));
  const compact = args.includes('--jq');
  result = compact
    ? releases.map(({tag_name,draft,prerelease}) => ({tag_name,draft,prerelease})).map(JSON.stringify).join('\\n')+'\\n'
    : JSON.stringify([releases]);
}
else if (args.includes('/pulls?')) {
  if (!args.includes('--paginate')) throw new Error('PR enumeration must paginate');
  const component = fixture.train === 'backend' ? 'server' : fixture.train;
  const pr = {number:1, user:{login:'github-actions[bot]'}, merge_commit_sha:fixture.boundarySha,
    merged_at:'2026-09-24T18:42:54Z', head:{ref:'release-please--branches--main--components--'+component}, labels:['autorelease: pending']};
  result = [...(fixture.state.pending ? [pr] : []),
    {...pr, merged_at:null}, {...pr, labels:['autorelease: tagged']},
    {...pr, head:{ref:'unrelated'}}].map(JSON.stringify).join('\\n');
}
else if (args.startsWith('pr list')) result = fixture.state.pending && !fixture.state.searchMissing ? [{number:1,author:{login:'github-actions'},mergeCommit:{oid:fixture.boundarySha}}] : [];
else throw new Error(args);
process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
`,
    { mode: 0o755 },
  );
  const output = join(cwd, 'output');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [script, train, sha], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'fixture/repo',
    },
  });
  return { ...result, output: readFileSync(output, 'utf8') };
}

describe('release lifecycle reconciliation', () => {
  it('plans only against a published boundary', () => {
    expect(run({})).toMatchObject({ status: 0, output: 'mode=plan\n' });
  });
  it.each([false, true])(
    'retains legacy history across the root migration (pending=%s)',
    (pending) => {
      expect(run({ pending, historicalManifest: { '.release/backend': '1.2.3' } })).toMatchObject({
        status: 0,
        output: pending ? 'mode=release\n' : 'mode=plan\n',
      });
    },
  );
  it.each([false, true])('rejects mismatched historical versions (pending=%s)', (pending) => {
    const result = run({ pending, historicalManifest: { '.release/backend': '1.2.2' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      pending ? 'Pending release version differs' : 'Published tag does not contain',
    );
  });
  it.each([
    {},
    { '.release/backend': '1.2.3' },
    { '.': 'invalid' },
    { '.': 123 },
    { '.': '1.2.3', '.release/backend': '1.2.2' },
  ])('rejects invalid or unmigrated main manifests: %j', (mainManifest) => {
    expect(run({ mainManifest }).status).not.toBe(0);
  });
  it.each([false, true])('rejects invalid historical manifests (pending=%s)', (pending) => {
    for (const historicalManifest of [
      {},
      { '.release/backend': 'invalid' },
      { '.': '1.2.3', '.release/backend': '1.2.2' },
    ]) {
      expect(run({ pending, historicalManifest }).status).not.toBe(0);
    }
  });
  it('never bootstraps history when the expected release disappears', () => {
    const result = run({ missing: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing published release boundary');
  });
  it('rejects a published tag outside the candidate history', () => {
    expect(run({ mismatchedTag: true }).status).not.toBe(0);
  });
  it('does not create the next PR while publication is pending', () => {
    const result = run({ draft: true, pending: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('publication is pending');
  });
  it('ignores abandoned drafts from older release versions', () => {
    expect(run({ unrelatedDraft: true })).toMatchObject({ status: 0, output: 'mode=plan\n' });
  });
  it('ignores completed historical mobile lines while planning the current native release', () => {
    expect(run({ train: 'mobile', unrelatedDraft: true })).toMatchObject({
      status: 0,
      output: 'mode=plan\n',
    });
  });
  it('blocks a mobile draft on or above the current release line', () => {
    const result = run({ train: 'mobile', newerDraft: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('publication is pending');
  });
  it('blocks a mobile draft matching the current manifest version', () => {
    const result = run({ train: 'mobile', draft: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('publication is pending');
  });
  it('keeps lifecycle reconciliation bounded with large release metadata', () => {
    expect(run({ largeReleasePayload: true })).toMatchObject({ status: 0, output: 'mode=plan\n' });
  });
  it('rejects drafts newer than the manifest version', () => {
    const result = run({ newerDraft: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('publication is pending');
  });
  it('reconciles a merged release without planning another PR', () => {
    expect(run({ pending: true })).toMatchObject({ status: 0, output: 'mode=release\n' });
  });
  it('finds a pending merged release even when the search index omits it', () => {
    expect(run({ pending: true, searchMissing: true })).toMatchObject({
      status: 0,
      output: 'mode=release\n',
    });
  });
  it('lets the newest event reconcile moving main', () => {
    expect(run({ stale: true })).toMatchObject({ status: 0, output: 'mode=skip\n' });
  });
});

describe('website retry preserves the published image', () => {
  function resume(mode: 'same' | 'different' | 'absent' | 'denied') {
    const cwd = mkdtempSync(join(tmpdir(), 'release-website-retry-'));
    const source = 'a'.repeat(40);
    const digest = `sha256:${'b'.repeat(64)}`;
    const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const step = workflow.jobs['publish-website']?.steps.find(
      (candidate) => candidate.name === 'Resume an existing immutable website image',
    );
    expect(step?.run).toBeTruthy();
    writeFileSync(
      join(cwd, 'docker'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'buildx') {
  if (${JSON.stringify(mode)} === 'absent') { process.stderr.write('manifest unknown'); process.exit(1); }
  if (${JSON.stringify(mode)} === 'denied') { process.stderr.write('unauthorized'); process.exit(1); }
  process.stdout.write(${JSON.stringify(digest)});
} else if (args[0] === 'image') process.stdout.write(${JSON.stringify(mode === 'different' ? 'c'.repeat(40) : source)});
else if (args[0] !== 'pull') throw new Error(args.join(' '));
`,
      { mode: 0o755 },
    );
    const output = join(cwd, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', step?.run ?? 'exit 99'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${cwd}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        SOURCE_SHA: source,
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'fixture/site',
        VERSION: '1.2.3',
      },
    });
    return { ...result, output: readFileSync(output, 'utf8'), digest };
  }
  it('reuses only the digest belonging to the recorded source', () => {
    const result = resume('same');
    expect(result.status).toBe(0);
    expect(result.output).toBe(`digest=${result.digest}\n`);
  });
  it('does not replace an existing image from another source', () => {
    expect(resume('different').status).not.toBe(0);
  });
  it('allows a first build only for an explicit absence', () => {
    expect(resume('absent')).toMatchObject({ status: 0, output: '' });
    expect(resume('denied').status).not.toBe(0);
  });
});
