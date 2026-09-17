import { describe, expect, it } from 'vitest';

import {
  planCandidate,
  releaseNotes,
  singleGroup,
  stageArtifact,
  validateCandidate,
  verifyChannel,
  verifyUpdates,
} from './mobile-ota-release.ts';

const sha = 'a'.repeat(40);
const group = '11111111-2222-3333-4444-555555555555';
const other = '66666666-2222-3333-4444-555555555555';
const planned = () => planCandidate('1.33.0', '1.33.2', sha);
const artifact = () => ({ ...planned(), group, notes: ['Models appear in project sessions.'] });
const update = () => ({
  group,
  branch: planned().branch,
  gitCommitHash: sha,
  runtimeVersion: '1.33.0',
  platform: 'ios',
});

describe('OTA release state', () => {
  it('keeps one planned version across distinct immutable candidates', () => {
    const first = planned();
    const second = planCandidate('1.33.0', '1.33.2', 'b'.repeat(40));
    expect(second.version).toBe(first.version);
    expect(second.branch).not.toBe(first.branch);
    expect(planCandidate('1.33.0', first.version, sha).version).not.toBe(first.version);
    expect(() => planCandidate('1.34.0', '1.33.2', sha)).toThrow('runtime changed');
  });

  it('does not steal legacy staged tags during migration', () => {
    const migrated = planCandidate('1.33.0', '1.33.2', sha, ['1.33.4', '1.32.99']);
    expect(migrated.version).toBe('1.33.5');
    expect(migrated.baseline).toBe('mobile-v1.33.2');
    expect(validateCandidate({ ...migrated, group, notes: [] })).toEqual({
      ...migrated,
      group,
      notes: [],
    });
  });

  it('requires reservation before any EAS operation and resumes after an accepted upload lost its response', () => {
    const events: string[] = [];
    let accepted: string | undefined;
    const io = {
      claim: () => true,
      reserve: () => {
        events.push('reserve');
      },
      ensureBranch: () => {
        events.push('branch');
      },
      read: () => accepted,
      publish: () => {
        events.push('publish');
        accepted = group;
        throw new Error('response lost');
      },
    };
    expect(() => stageArtifact(planned(), io)).toThrow('response lost');
    expect(stageArtifact(planned(), io)).toBe(group);
    expect(events).toEqual(['reserve', 'branch', 'publish', 'reserve', 'branch']);
  });

  it('does not interpret a failed EAS read as an empty branch', () => {
    let writes = 0;
    expect(() =>
      stageArtifact(planned(), {
        claim: () => true,
        reserve() {},
        ensureBranch() {},
        read() {
          throw new Error('network down');
        },
        publish() {
          writes++;
        },
      }),
    ).toThrow('network down');
    expect(writes).toBe(0);
  });

  it('never publishes if reservation failed', () => {
    let touched = false;
    expect(() =>
      stageArtifact(planned(), {
        claim: () => true,
        reserve() {
          throw new Error('conflicting reservation');
        },
        ensureBranch() {
          touched = true;
        },
        read: () => undefined,
        publish() {
          touched = true;
        },
      }),
    ).toThrow('conflicting reservation');
    expect(touched).toBe(false);
  });

  it('refuses an unrecorded or multiply published candidate', () => {
    expect(() =>
      stageArtifact(planned(), {
        claim: () => true,
        reserve() {},
        ensureBranch() {},
        read: () => undefined,
        publish() {},
      }),
    ).toThrow('did not record');
    expect(() => singleGroup({ currentPage: [{ group }, { group: other }] })).toThrow('multiple');
    expect(singleGroup({ currentPage: [{ group }] })).toBe(group);
  });

  it.each([
    { group: other },
    { gitCommitHash: 'b'.repeat(40) },
    { runtimeVersion: '1.34.0' },
    { branch: 'mutable-branch' },
    { platform: 'android' },
    { isRollBackToEmbedded: true },
  ])('rejects changed external evidence %j', (changed) => {
    expect(verifyUpdates(artifact(), [update()])).toBe(group);
    expect(() => verifyUpdates(artifact(), [{ ...update(), ...changed }])).toThrow(
      'does not match',
    );
  });

  it('rejects legacy and forged manifests', () => {
    expect(() =>
      validateCandidate({ version: '1.33.3', branch: 'staging-mobile-v1.33.3', commit: sha }),
    ).toThrow();
    expect(() => validateCandidate({ ...artifact(), tag: 'mobile-v9.0.0' })).toThrow('tag');
    expect(() => validateCandidate({ ...artifact(), group: undefined })).toThrow('evidence');
  });

  it('verifies the actual channel mapping, not a matching branch somewhere in the response', () => {
    const channel = {
      currentPage: {
        name: 'testflight',
        branchMapping: JSON.stringify({
          version: 0,
          data: [{ branchId: 'branch-id', branchMappingLogic: 'true' }],
        }),
        updateBranches: [{ id: 'branch-id', name: planned().branch }],
      },
    };
    expect(() => verifyChannel(channel, planned().branch)).not.toThrow();
    channel.currentPage.branchMapping = JSON.stringify({
      version: 0,
      data: [{ branchId: 'another', branchMappingLogic: 'true' }],
    });
    expect(() => verifyChannel(channel, planned().branch)).toThrow('exclusively');
  });

  it('keeps user-visible fixes and breaking changes but omits release mechanics', () => {
    expect(
      releaseNotes(
        'fix(mobile): Show models (#451)\nchore(mobile): promote OTA 1.33.2\nfeat(mobile)!: Remove <legacy>\nfix(mobile): Show models (#451)',
      ),
    ).toEqual(['Show models (#451)', 'Breaking: Remove \\<legacy\\>']);
  });
});

// Execute the real orchestration against persistent fake external services. The
// state survives failed child processes, just as accepted EAS/GitHub writes do.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface ServiceState {
  calls: string[];
  tags: Record<string, { commit: string; message: string }>;
  group?: string;
  loseUpload?: boolean;
  loseRelease?: boolean;
  released: string;
  releaseReads: number;
  changeBaseline?: boolean;
  racedHead?: boolean;
  draft?: boolean;
  reviews?: { id: number; state: string; commit_id: string }[];
  loseDismiss?: boolean;
  rollingHead?: string;
  sourceManifestMissing?: boolean;
  loseMetadata?: boolean;
}

function serviceFixture(changes: Partial<ServiceState> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'verity-ota-'));
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  mkdirSync(join(cwd, 'apps/mobile'), { recursive: true });
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'scripts/stamp-mobile-build-info.mjs'), '');
  writeFileSync(join(cwd, 'apps/mobile/ota-promotion.json'), JSON.stringify(artifact()));
  const statePath = join(cwd, 'state.json');
  const initial: ServiceState = {
    calls: [],
    tags: {},
    released: 'mobile-v1.33.2',
    releaseReads: 0,
    ...changes,
  };
  writeFileSync(statePath, JSON.stringify(initial));
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const s = JSON.parse(fs.readFileSync(process.env.OTA_FAKE_STATE, 'utf8'));
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
s.calls.push(tool + ' ' + args.join(' '));
const candidate = JSON.parse(fs.readFileSync(''+process.env.OTA_FAKE_CWD+'/apps/mobile/ota-promotion.json','utf8'));
const save = () => fs.writeFileSync(process.env.OTA_FAKE_STATE, JSON.stringify(s));
const out = value => {save(); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0);};
const fail = () => {save(); process.exit(1);};
const sha = candidate.commit;
if(tool === 'git') {
  if(args[0] === 'rev-parse') out(sha);
  if(args[0] === 'merge-base' || args[0] === 'fetch') out('');
  if(args[0] === 'log') out(args.includes('--format=%s') ? 'fix(mobile): Show models (#451)' : sha);
  if(args[0] === 'ls-remote') {
    const ref=args.at(-1);
    if(ref.startsWith('refs/tags/')) { const tag=s.tags[ref.slice(10)]; out(tag ? tag.commit+'\\t'+ref : ''); }
    out(s.racedHead ? 'b'.repeat(40)+'\\t'+ref : s.rollingHead ? s.rollingHead+'\\t'+ref : '');
  }
  if(args[0] === 'tag' && args[1] === '--list') out(Object.keys(s.tags).filter(t=>t.startsWith(args[2].replace('*',''))).join('\\n'));
  if(args.includes('tag') && args.includes('-a')) {
    const i=args.indexOf('-a'); s.tags[args[i+1]]={commit:args[i+2],message:args[args.indexOf('-m')+1]}; out('');
  }
  if(args[0] === 'tag') {s.tags[args[1]]={commit:args[2],message:''};out('');}
  if(args[0] === 'push') { if(args.at(-1).includes(':refs/heads/')) s.rollingHead=args.at(-1).split(':')[0]; out(''); }
  if(args[0] === 'rev-list') out(s.tags[args.at(-1)]?.commit ?? '');
  if(args[0] === 'for-each-ref') out(s.tags[args.at(-1).replace('refs/tags/','')]?.message ?? '');
  if(args[0] === 'show') { if(s.sourceManifestMissing && s.rollingHead===sha) fail(); out(candidate); }
}
if(tool === 'gh') {
  if(args[0] === 'api' && args.includes('graphql')) {if(s.loseMetadata){s.loseMetadata=false;fail();}out({data:{createCommitOnBranch:{commit:{oid:sha,signature:{isValid:true}}}}});}
  if(args[0] === 'api') {
    const endpoint=args.find(a=>a.startsWith('repos/'));
    if(endpoint?.includes('/releases?')) {
      s.releaseReads++;
      const tag=s.changeBaseline && s.releaseReads>1 ? 'mobile-v1.33.9' : s.released;
      out([[{tag_name:tag,draft:false,prerelease:false},...(s.draft?[{tag_name:candidate.tag,draft:true,prerelease:false}]:[])]]);
    }
    if(endpoint?.endsWith('/pulls')) out([{number:51,merged_at:'2026-01-01',head:{ref:'automation/promote-mobile-ota-1.33.0',sha}}]);
    if(endpoint?.includes('/reviews?')) out([s.reviews ?? []]);
    if(endpoint?.endsWith('/dismissals')) {
      if(s.loseDismiss) fail();
      const id=Number(endpoint.split('/').at(-2));
      const review=s.reviews.find(r=>r.id===id);review.state='DISMISSED';out({});
    }
    if(endpoint?.includes('/contents/')) out({content:Buffer.from(JSON.stringify(candidate)).toString('base64')});
    if(endpoint?.includes('/check-runs?')) out([{check_runs:[{id:123,name:'ci-checks',conclusion:'success',app:{slug:'github-actions'}}]}]);
  }
  if(args[0] === 'pr' && args[1] === 'list') out(args.includes('--head') && (s.racedHead || s.rollingHead)?[{number:51,headRefOid:s.racedHead?'c'.repeat(40):s.rollingHead,author:{login:'app/github-actions'}}]:[]);
  if(args[0] === 'pr' && args[1] === 'create') out('https://github.com/example/repo/pull/51');
  if(args[0] === 'pr' || args[0] === 'workflow') out('');
  if(args[0] === 'release' && args[1] === 'create') {s.draft=true;out('');}
  if(args[0] === 'release' && args[1] === 'edit') {
    if(s.loseRelease){s.loseRelease=false;fail();}
    s.released=candidate.tag;s.draft=false;out('');
  }
}
if(tool === 'npx') {
  const command=args[2];
  if(command==='branch:create') out('');
  if(command==='update:list') out({currentPage:s.group?[{group:s.group}]:[]});
  if(command==='update:view') out([{group:s.group,branch:candidate.branch,runtimeVersion:candidate.runtime,gitCommitHash:sha,platform:'ios'}]);
  if(command==='update') {s.group=candidate.group;if(s.loseUpload){s.loseUpload=false;fail();}out([]);}
  if(command==='channel:edit') out('');
  if(command==='channel:view') out({currentPage:{name:'testflight',branchMapping:JSON.stringify({version:0,data:[{branchId:'branch',branchMappingLogic:'true'}]}),updateBranches:[{id:'branch',name:candidate.branch}]}});
}
save();console.error('Unhandled fake command',tool,args);process.exit(2);
`;
  for (const name of ['git', 'gh', 'npx']) {
    writeFileSync(join(bin, name), mock);
    chmodSync(join(bin, name), 0o755);
  }
  return {
    run: (command: 'stage' | 'promote') =>
      spawnSync(process.execPath, [resolve('scripts/mobile-ota-release.ts'), command, '1.33.0'], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OTA_FAKE_STATE: statePath,
          OTA_FAKE_CWD: cwd,
          GITHUB_SHA: sha,
          GITHUB_REPOSITORY: 'example/repo',
          RUNNER_TEMP: cwd,
          GITHUB_STEP_SUMMARY: join(cwd, 'summary'),
        },
      }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')) as ServiceState,
  };
}

describe('OTA CLI interrupted external operations', () => {
  it('reconciles an accepted upload after a lost response without another publish', () => {
    const service = serviceFixture({ loseUpload: true });
    expect(service.run('stage').status).not.toBe(0);
    const retry = service.run('stage');
    expect(retry.stderr).toBe('');
    expect(retry.status).toBe(0);
    expect(
      service.state().calls.filter((call) => call.startsWith('npx --yes eas-cli@21.0.1 update ')),
    ).toHaveLength(1);
    expect(service.state().calls.some((call) => call.startsWith('gh pr create'))).toBe(true);
  });

  it('stops before changing the rolling PR when the delivered baseline changed', () => {
    const service = serviceFixture({ changeBaseline: true });
    const result = service.run('stage');
    expect(result.stderr).toContain('baseline changed');
    expect(service.state().calls.some((call) => call.startsWith('gh pr create'))).toBe(false);
  });

  it('refuses to replace a rolling PR changed by another writer', () => {
    const service = serviceFixture({ racedHead: true });
    const result = service.run('stage');
    expect(result.stderr).toContain('changed during staging');
    expect(service.state().calls.some((call) => call.includes('--force-with-lease'))).toBe(false);
  });

  it('finishes the GitHub release after a successful channel edit without rebuilding', () => {
    const candidate = artifact();
    const service = serviceFixture({
      group,
      loseRelease: true,
      tags: {
        [`ota-artifact/${candidate.tag}/${sha}`]: {
          commit: sha,
          message: JSON.stringify(candidate),
        },
      },
    });
    expect(service.run('promote').status).not.toBe(0);
    expect(service.state().calls.some((call) => call.includes('channel:edit'))).toBe(true);
    const retry = service.run('promote');
    expect(retry.stderr).toBe('');
    expect(retry.status).toBe(0);
    expect(service.state().released).toBe(candidate.tag);
    expect(
      service.state().calls.some((call) => call.startsWith('npx --yes eas-cli@21.0.1 update ')),
    ).toBe(false);
  });

  it('rejects an older promotion before touching the external channel', () => {
    const candidate = artifact();
    const service = serviceFixture({
      group,
      released: 'mobile-v1.33.4',
      tags: {
        [`ota-artifact/${candidate.tag}/${sha}`]: {
          commit: sha,
          message: JSON.stringify(candidate),
        },
      },
    });
    const result = service.run('promote');
    expect(result.stderr).toContain('Candidate is stale');
    expect(service.state().calls.some((call) => call.includes('channel:edit'))).toBe(false);
  });
  it('dismisses stale approvals before CI while preserving exact-head approval', () => {
    const service = serviceFixture({
      reviews: [
        { id: 1, state: 'APPROVED', commit_id: 'b'.repeat(40) },
        { id: 2, state: 'APPROVED', commit_id: sha },
      ],
    });
    const result = service.run('stage');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const state = service.state();
    expect(state.reviews?.map((review) => review.state)).toEqual(['DISMISSED', 'APPROVED']);
    const dismissal = state.calls.findIndex((call) => call.includes('/reviews/1/dismissals'));
    const dispatch = state.calls.findIndex((call) => call.startsWith('gh workflow run'));
    expect(dismissal).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(dismissal);
  });

  it('does not make the new candidate mergeable if stale approval cannot be cleared', () => {
    const service = serviceFixture({
      loseDismiss: true,
      reviews: [{ id: 1, state: 'APPROVED', commit_id: 'b'.repeat(40) }],
    });
    expect(service.run('stage').status).not.toBe(0);
    expect(service.state().calls.some((call) => call.startsWith('gh workflow run'))).toBe(false);
  });

  it('refuses promotion if an administrative merge left a prior approval active', () => {
    const candidate = artifact();
    const service = serviceFixture({
      group,
      reviews: [{ id: 1, state: 'APPROVED', commit_id: 'b'.repeat(40) }],
      tags: {
        [`ota-artifact/${candidate.tag}/${sha}`]: {
          commit: sha,
          message: JSON.stringify(candidate),
        },
      },
    });
    const result = service.run('promote');
    expect(result.stderr).toContain('prior candidate approval');
    expect(service.state().calls.some((call) => call.includes('channel:edit'))).toBe(false);
  });
  it('recovers an interrupted rolling reset whose source has no promotion manifest', () => {
    const service = serviceFixture({
      rollingHead: 'c'.repeat(40),
      sourceManifestMissing: true,
      loseMetadata: true,
    });
    const first = service.run('stage');
    expect(first.status).not.toBe(0);
    expect(service.state().rollingHead).toBe(sha);
    expect(service.state().calls.some((call) => call.includes('graphql'))).toBe(true);
    const retry = service.run('stage');
    expect(retry.stderr).toBe('');
    expect(retry.status).toBe(0);
    expect(
      service.state().calls.filter((call) => call.startsWith('npx --yes eas-cli@21.0.1 update ')),
    ).toHaveLength(1);
    expect(service.state().calls.some((call) => call.startsWith('gh workflow run'))).toBe(true);
  });
});
