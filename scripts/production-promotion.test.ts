import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertPromotionOrder } from './production-promotion.js';

function fixture(change: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-production-'));
  const candidate = {
    schema: 1,
    product: 'server',
    version: '2.0.0',
    source: 'a'.repeat(40),
    releasePr: 42,
    images: Object.fromEntries(
      [
        'verity-server',
        'verity-sandbox',
        'verity-project-relay',
        'verity-preview-edge',
        'verity-preview-connector',
        'verity-matrix-connector',
        'verity-sandbox-toolkit',
      ].map((name) => [name, `ghcr.io/heey-global/verity/${name}@sha256:${'b'.repeat(64)}`]),
    ),
    envelopes: {
      amd64: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
      arm64: `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`,
    },
  };
  mkdirSync(join(root, 'releases'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'releases/server-production.json'), JSON.stringify(candidate));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ candidate, calls: [], ...change }));
  writeFileSync(join(root, 'scripts/finalize-server-production.sh'), 'exit 0\n');
  const mock = `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const file=process.env.PROMOTION_STATE;const s=JSON.parse(fs.readFileSync(file,'utf8'));const args=process.argv.slice(2);const tool=path.basename(process.argv[1]);s.calls.push(tool+' '+args.join(' '));fs.writeFileSync(file,JSON.stringify(s));
const out=value=>{process.stdout.write(JSON.stringify(value));process.exit(0);};
if(tool==='git') {if(args[0]==='log') process.stdout.write('a'.repeat(40));process.exit(0);}
if(tool==='gh') {
 if(args[0]==='workflow') process.exit(0);
 if(args[0]==='release' && args[1]==='download') out(s.candidate);
 const endpoint=args.find(v=>v.startsWith('repos/'));
 if(endpoint.endsWith('/pulls')) out([{number:9,merged_at:'2026-01-01',head:{ref:'automation/promote-server-production',sha:'d'.repeat(40)},base:{ref:'main'}}]);
 if(endpoint.includes('/reviews?')) out([s.stale?[{state:'APPROVED',commit_id:'e'.repeat(40)}]:[]]);
 if(endpoint.includes('/check-runs?')) out([{check_runs:[{id:1,name:'ci-checks',conclusion:'success',app:{slug:'github-actions'}}]}]);
 if(endpoint.includes('/pulls/42')) out({merged_at:'2026-01-01',head:{ref:'release-please--branches--main--components--server'},base:{ref:'main'},merge_commit_sha:'a'.repeat(40)});
 if(endpoint.includes('/contents/.release-please')) out({content:Buffer.from(JSON.stringify({'.':'2.0.0'})).toString('base64')});
 if(endpoint.includes('/contents/')) out({content:Buffer.from(JSON.stringify(s.candidate)).toString('base64')});
}
if(tool==='oras') {
 if(args[0]==='cp') process.exit(0);
 const dir=args[args.indexOf('-o')+1];const stable=args[1].includes('channel-stable');const arch=args[1].includes('arm64')||args[1].includes('c'.repeat(64))?'arm64':'amd64';
 const metadata={serverImage:s.candidate.images['verity-server'],channel:s.wrongChannel?'staging':'stable',architecture:arch,version:stable?(s.newer?'3.0.0':'1.0.0'):'2.0.0',revision:stable?'f'.repeat(40):s.candidate.source};
 fs.writeFileSync(path.join(dir,'channel.json'),JSON.stringify({payload:Buffer.from(JSON.stringify(metadata)).toString('base64'),signature:{bundle:Buffer.from('{}').toString('base64')}}));process.exit(0);
}
if(tool==='cosign') process.exit(s.badSignature&&args.some(v=>v.includes('arm64'))?1:0);
process.stderr.write('Unexpected tool '+tool+' '+args.join(' '));process.exit(2);
`;
  for (const tool of ['gh', 'git', 'oras', 'cosign']) {
    const file = join(root, 'bin', tool);
    writeFileSync(file, mock);
    chmodSync(file, 0o755);
  }
  return {
    root,
    run: () =>
      spawnSync(
        process.execPath,
        [process.env.PROMOTION_SCRIPT ?? resolve('scripts/production-promotion.ts'), 'promote'],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            PROMOTION_STATE: join(root, 'state.json'),
            RUNNER_TEMP: root,
            GITHUB_REPOSITORY: 'example/repo',
          },
        },
      ),
    calls: () =>
      (JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { calls: string[] }).calls,
  };
}

describe('production promotion', () => {
  it.each([{ stale: true }, { badSignature: true }, { wrongChannel: true }, { newer: true }])(
    'rejects invalid approval or evidence before moving either stable channel (%j)',
    (change) => {
      const f = fixture(change);
      try {
        const result = f.run();
        expect(result.status).not.toBe(0);
        expect(f.calls().filter((call) => call.startsWith('oras cp'))).toEqual([]);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
  it('verifies both signed architectures before publication and replans only after finalization', () => {
    const f = fixture();
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const calls = f.calls();
      const firstCopy = calls.findIndex((call) => call.startsWith('oras cp'));
      expect(
        calls.slice(0, firstCopy).filter((call) => call.startsWith('cosign verify-blob')),
      ).toHaveLength(2);
      expect(
        calls.filter((call) => call.startsWith('oras cp') && call.includes(':channel-stable-')),
      ).toHaveLength(2);
      expect(calls.at(-1)).toContain('backend-replan=true');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it('permits only a matching retry at the existing production version', () => {
    expect(() =>
      assertPromotionOrder({ version: '2.0.0', revision: 'a' }, { version: '2.0.0', source: 'a' }),
    ).not.toThrow();
    expect(() =>
      assertPromotionOrder({ version: '2.0.0', revision: 'a' }, { version: '2.0.0', source: 'b' }),
    ).toThrow();
  });
});
