import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { fixture, env as fixtureEnvironment } from './dependency-fixture.js';

const storage = resolve('agent-seed/bin/verity-dependency-storage.mjs');
const preload = resolve('agent-seed/bin/verity-dependency-storage-preload.mjs');
const wrapperSource = resolve('features/verity-sandbox-toolkit/bin/verity-package-install.mjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'verity-storage-lease-'));
  roots.push(root);
  return root;
}
async function probe(code: string) {
  return (
    await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as s from ${JSON.stringify('file://' + storage)};\n${code}`,
      ],
      { env: { ...process.env, VERITY_SESSION_ID: '' }, timeout: 15_000 },
    )
  ).stdout.trim();
}
const pause = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('fixture did not converge');
    await pause(20);
  }
}

it('requires current broker admission before work and settles only after closing the holder', async () => {
  expect(
    await probe(`
    const calls=[];let locked=false;let id;
    const lease=await s.beginCapacityLease('dependency-copy',{bytes:8192,inodes:3},{
      environment:{VERITY_SESSION_ID:'session'},
      request:async body=>{
        calls.push(body.action); id??=body.id;
        if(body.id!==id) throw Error('changed identity');
        if(body.action==='start'&&!locked) throw Error('holder not acquired');
        if(body.action==='settle'&&locked) throw Error('holder still open');
        return {version:1,id,state:body.action==='reserve'?'reserved':body.action==='start'?'started':'settled',
          admitted:true,lockPath:'/run/verity-capacity-leases/'+id+'.lock'};
      },hold:async()=>{locked=true;calls.push('hold');return {fd:7,close(){locked=false;calls.push('close')}}}
    });
    await lease.release();await lease.release();console.log(calls.join(','));
  `),
  ).toBe('reserve,hold,start,close,settle');
});

it('keeps standalone checks local and never starts work after a missing or stale grant', async () => {
  expect(
    await probe(`
    let calls=0; await s.beginCapacityLease('dependency-copy',{bytes:1,inodes:1},{environment:{},request:()=>{calls++}});
    console.log(calls);
    for(const reply of [undefined,{version:1,admitted:false},{version:1,state:'settled',admitted:true}]){
      let held=false;const actions=[];
      try {await s.beginCapacityLease('dependency-copy',{bytes:1,inodes:1},{environment:{VERITY_SESSION_ID:'session'},
        request:async body=>{actions.push(body.action);if(!reply)throw Error('private token should not escape');return {...reply,id:body.id,lockPath:'/run/verity-capacity-leases/'+body.id+'.lock'}},
        hold:async()=>{held=true;throw Error('unexpected holder')}
      });console.log('unexpected success')} catch(error){console.log(held+':'+error.message)}
    }
  `),
  ).toBe(
    [
      '0',
      // An injected failure may carry anything, so its text never escapes.
      'false:Dependency capacity admission failed; no additional dependency work started.',
      ...Array(2).fill(
        'false:Dependency capacity admission failed (Dependency capacity lease was not admitted by the current broker); no additional dependency work started.',
      ),
    ].join('\n'),
  );
});

it('recovers a lost reply through the same id and rejects uncertain start acknowledgements', async () => {
  expect(
    await probe(`
    const actions=[];let id;let closed=false;
    try{await s.beginCapacityLease('dependency-prepare',{bytes:0,inodes:0},{environment:{VERITY_SESSION_ID:'session'},
      request:async body=>{id??=body.id;if(body.id!==id)throw Error('new identity');actions.push(body.action);
        if(body.action==='reserve')throw Error('lost response');
        return {version:1,id,lockPath:'/run/verity-capacity-leases/'+id+'.lock',admitted:true,state:body.action==='status'?'reserved':'uncertain'}},
      hold:async()=>({fd:7,close(){closed=true}})});}catch{}
    console.log(actions.join(',')+':'+closed);
  `),
  ).toBe('reserve,status,start,settle:true');
});

it('uses the project capability and redacts failed broker responses', async () => {
  const root = temporary();
  const capability = join(root, 'capability');
  writeFileSync(capability, 'fixture-capability');
  const calls: unknown[] = [];
  const server = createServer((request, response) => {
    expect(request.url).toBe('/internal/dependency-storage');
    expect(request.headers.authorization).toBe('Bearer fixture-capability');
    let data = '';
    request.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    request.on('end', () => {
      calls.push(JSON.parse(data));
      response.writeHead(403);
      response.end('{"error":"private-response-secret"}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address unavailable');
    const result = await probe(`
      try{await s.dependencyStorageRequest({action:'reserve',id:'fixture'},
        {VERITY_SESSION_ID:'session',VERITY_PROJECT_MEMORY_URL:${JSON.stringify(`http://127.0.0.1:${address.port}/internal/project/memory`)},
         VERITY_GH_BROKER_CAPABILITY_FILE:${JSON.stringify(capability)}})}catch(error){console.log(error.message)}
    `);
    expect(result).toBe('Dependency capacity broker refused admission (HTTP 403).');
    expect(calls).toEqual([{ action: 'reserve', id: 'fixture', version: 1, sessionId: 'session' }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('surfaces only the reasons the Server composes for refused requests', async () => {
  const root = temporary();
  const capability = join(root, 'capability');
  writeFileSync(capability, 'fixture-capability');
  const bodies = [
    '{"error":"Dependency capacity inventory is loading."}',
    '{"error":"Build storage admission rejected: earlier build admission remains unconfirmed."}',
    '{"error":"session not found in this project"}',
    '{"error":"Dependency capacity\\u0007 x"}',
    'not json',
  ];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(409);
      response.end(bodies.shift());
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address unavailable');
    const result = await probe(`
      for (let i=0;i<5;i++) try{await s.dependencyStorageRequest({action:'reserve',id:'fixture'},
        {VERITY_SESSION_ID:'session',VERITY_PROJECT_MEMORY_URL:${JSON.stringify(`http://127.0.0.1:${address.port}/internal/project/memory`)},
         VERITY_GH_BROKER_CAPABILITY_FILE:${JSON.stringify(capability)}})}catch(error){console.log(error.message)}
    `);
    expect(result.split('\n')).toEqual([
      'Dependency capacity broker refused admission (HTTP 409): Dependency capacity inventory is loading.',
      'Dependency capacity broker refused admission (HTTP 409): Build storage admission rejected: earlier build admission remains unconfirmed.',
      'Dependency capacity broker refused admission (HTTP 409): session not found in this project',
      // Control characters cannot forge terminal output.
      'Dependency capacity broker refused admission (HTTP 409): Dependency capacity x',
      'Dependency capacity broker refused admission (HTTP 409).',
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('reports the original refusal when the status follow-up cannot prove admission', async () => {
  expect(
    await probe(`
    const actions=[];
    try{await s.beginCapacityLease('dependency-prepare',{bytes:1,inodes:1},{environment:{VERITY_SESSION_ID:'session'},
      request:async body=>{actions.push(body.action);
        if(body.action==='reserve')throw Error('Dependency capacity broker refused admission (HTTP 409): Dependency capacity inventory is loading.');
        if(body.action==='status')throw Error('Dependency capacity broker refused admission (HTTP 409).');
        return {}},
      hold:async()=>{throw Error('unexpected holder')}})}catch(error){console.log(actions.join(',')+':'+error.message)}
  `),
  ).toBe(
    'reserve,status,settle:Dependency capacity admission failed (Dependency capacity broker refused admission (HTTP 409): Dependency capacity inventory is loading); no additional dependency work started.',
  );
});

it('names a lease directory the session cannot see instead of a generic refusal', async () => {
  // The broker creates its directory outside the agent's confinement. When the
  // launch omits it, the lstat fails with ENOENT, which used to surface only as
  // "admission failed" and blocked every managed install.
  const root = join(temporary(), 'missing');
  expect(
    await probe(`
    let id;
    try{await s.beginCapacityLease('dependency-prepare',{bytes:1,inodes:1},{environment:{VERITY_SESSION_ID:'session'},
      request:async body=>{id??=body.id;return {version:1,id,admitted:true,state:'reserved',lockPath:'/run/verity-capacity-leases/'+id+'.lock'}},
      hold:path=>s.holdCapacityLock(${JSON.stringify(root)}+path.slice('/run/verity-capacity-leases'.length),{root:${JSON.stringify(root)}})})}
    catch(error){console.log(error.message)}
  `),
  ).toBe(
    'Dependency capacity admission failed (Dependency capacity lock directory is not visible to this session (ENOENT)); no additional dependency work started.',
  );
});

it('holds a shared lock on a trusted broker lease and refuses agent-owned ones', async () => {
  const root = temporary();
  const id = '3f7f388a-6f7f-4746-a60e-ed2ac5b1e3a0';
  const lock = join(root, `${id}.lock`);
  writeFileSync(lock, '', { mode: 0o644 });
  spawnSync('chmod', ['755', root]);
  const result = await probe(`
    const held=await s.holdCapacityLock(${JSON.stringify(lock)},{root:${JSON.stringify(root)},rootOwned:()=>true});
    const {spawnSync}=await import('node:child_process');
    console.log(spawnSync('flock',['--exclusive','--nonblock',${JSON.stringify(lock)},'true']).status);
    held.close();
    console.log(spawnSync('flock',['--exclusive','--nonblock',${JSON.stringify(lock)},'true']).status);
    try{await s.holdCapacityLock(${JSON.stringify(lock)},{root:${JSON.stringify(root)}})}catch(error){console.log(error.message)}
  `);
  const uid = process.getuid!();
  expect(result.split('\n')).toEqual([
    '1',
    '0',
    uid === 0
      ? 'Dependency capacity lock directory is untrusted (owner 0, mode 755).'
      : `Dependency capacity lock directory is untrusted (owner ${uid}, mode 755).`,
  ]);
});

it('trusts the overflow owner only where root is unmapped and the overflow id is no one', async () => {
  // gVisor hosts confine agents in a user namespace mapping only their own id:
  // the broker's root-owned lease directory appears as the overflow id there.
  expect(
    await probe(`
    const cases=[
      [0,'0 0 4294967295'],[65534,'0 0 4294967295'],
      [65534,'1000 1000 1'],[1000,'1000 1000 1'],[0,'1000 1000 1'],
      [65534,'0 1000 1\\n1 100000 65536'],[65534,'1 100000 70000'],[65534,''],[65534,'garbage'],
    ];
    console.log(cases.map(([uid,uidMap])=>s.rootOwned(uid,{uidMap,overflowUid:'65534'})).join(','));
  `),
  ).toBe('true,false,true,false,true,false,false,false,false');
});

it('enforces a 30-second wall deadline even when the broker never sends headers', async () => {
  const root = temporary();
  const capability = join(root, 'capability');
  writeFileSync(capability, 'fixture');
  const server = createServer(() => {
    /* Deliberately never answer. */
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address unavailable');
    expect(
      await probe(`
      const timer=globalThis.setTimeout;
      globalThis.setTimeout=(callback,milliseconds)=>{
        if(milliseconds!==30000) throw Error('wrong wall deadline');
        return timer(callback,25);
      };
      try {await s.dependencyStorageRequest({action:'reserve'},{VERITY_SESSION_ID:'session',
        VERITY_PROJECT_MEMORY_URL:${JSON.stringify(`http://127.0.0.1:${address.port}/internal/project/memory`)},
        VERITY_GH_BROKER_CAPABILITY_FILE:${JSON.stringify(capability)}})}catch(error){console.log(error.message)}
    `),
    ).toBe('Dependency capacity broker request timed out after 30 seconds.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('rejects conflicting child descriptors rather than losing the holder', async () => {
  const root = temporary();
  const lock = join(root, 'holder');
  writeFileSync(lock, '');
  const fd = openSync(lock, 'r');
  try {
    const result = await new Promise<string>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          `
        import {spawn,spawnSync} from 'node:child_process';
        for(const start of [spawn,spawnSync]){
          try{start(process.execPath,['-e',''],{stdio:['ignore','ignore','ignore','ignore','pipe']});console.log('lost holder')}
          catch(error){console.log(error.message)}
        }
      `,
        ],
        {
          env: {
            ...process.env,
            VERITY_DEPENDENCY_STORAGE_FD: '4',
            VERITY_DEPENDENCY_STORAGE_LEASE_ID: '11111111-1111-4111-8111-111111111111',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ignore', fd],
        },
      );
      let output = '';
      child.stdout.on('data', (part: Buffer) => {
        output += part.toString();
      });
      child.on('error', reject);
      child.on('close', () => done(output.trim()));
    });
    expect(result.split('\n')).toEqual(
      Array(2).fill('Child descriptor 4 conflicts with the dependency capacity holder.'),
    );
  } finally {
    closeSync(fd);
  }
});

it.each(['prepare', 'copy', 'private'] as const)(
  'refuses managed %s work before growing dependency data when capacity authorization is unavailable',
  async (kind) => {
    const f = fixture();
    const lock = (version: string) =>
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/private': { version } } });
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    expect(f.run('install').status).toBe(0);
    rmSync(f.called, { force: true });
    const runtime = join(f.root, 'runtime');
    mkdirSync(runtime);
    writeFileSync(join(runtime, 'verity-package-install.mjs'), 'process.exit(0)');
    writeFileSync(join(runtime, 'verity-dependency-storage-preload.mjs'), '');
    writeFileSync(
      join(runtime, 'verity-npm-preflight.mjs'),
      "import {join} from 'node:path';export const npmStateDirectory=root=>join(root,'.cache');",
    );
    const helper = join(runtime, 'verity-dependencies');
    // The synthetic session belongs only to this broker fixture. Its temporary Git
    // repository retains the fixture's standalone identity, not a live session id.
    writeFileSync(
      helper,
      readFileSync(resolve('agent-seed/bin/verity-dependencies'), 'utf8')
        .replace(
          "const directory = '/usr/local/lib/verity';",
          `const directory = ${JSON.stringify(runtime)};`,
        )
        .replace(
          "return execFileSync('git', args, {",
          "return execFileSync('git', args, {env:{...process.env,VERITY_SESSION_ID:''},",
        ),
    );
    writeFileSync(join(runtime, 'verity-dependency-storage.mjs'), readFileSync(storage));
    writeFileSync(join(runtime, 'verity-dependency-storage-preload.mjs'), readFileSync(preload));
    const capability = join(runtime, 'capability');
    writeFileSync(capability, 'fixture-capability');
    let cwd = f.worktree;
    if (kind === 'copy') cwd = f.sibling();
    writeFileSync(join(cwd, 'package-lock.json'), lock(kind === 'prepare' ? '3.0.0' : '2.0.0'));
    const calls: { action: string; kind?: string; id: string }[] = [];
    const server = createServer((request, response) => {
      if (request.url !== '/internal/dependency-storage') {
        response.writeHead(404);
        response.end('{}');
        return;
      }
      let data = '';
      request.on('data', (part: Buffer) => {
        data += part.toString();
      });
      request.on('end', () => {
        calls.push(JSON.parse(data) as (typeof calls)[number]);
        response.writeHead(503);
        response.end('{"error":"private-server-detail"}');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('address unavailable');
      const result = await promisify(execFile)(
        process.execPath,
        [helper, 'install', ...(kind === 'private' ? ['--private'] : [])],
        {
          cwd,
          timeout: 15_000,
          env: {
            ...fixtureEnvironment,
            PATH: `${join(f.root, 'bin')}:${process.env.PATH ?? ''}`,
            VERITY_SESSION_ID: 'session',
            VERITY_PROJECT_MEMORY_URL: `http://127.0.0.1:${address.port}/internal/project/memory`,
            VERITY_GH_BROKER_CAPABILITY_FILE: capability,
          },
        },
      ).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => error,
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Dependency capacity admission failed');
      expect(result.stderr).not.toContain('private-server-detail');
      expect(calls.find((entry) => entry.action === 'reserve')?.kind).toBe(`dependency-${kind}`);
      expect(new Set(calls.map((entry) => entry.id)).size).toBe(1);
      expect(existsSync(f.called)).toBe(false);
      expect(existsSync(join(cwd, 'node_modules', '.verity-private'))).toBe(false);
      if (kind === 'copy') expect(existsSync(join(cwd, 'node_modules'))).toBe(false);
      else
        expect(readFileSync(join(cwd, 'node_modules/private/package.json'), 'utf8')).toContain(
          '2.0.0',
        );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

it('propagates the same holder through async and sync Node child APIs with custom environments', async () => {
  const root = temporary();
  const lock = join(root, 'holder');
  writeFileSync(lock, '');
  const childFile = join(root, 'fork.cjs');
  const inspect =
    "console.log(require('node:fs').fstatSync(3).isFile()&&require('node:fs').fstatSync(4).isFile())";
  writeFileSync(childFile, inspect);
  const fd = openSync(lock, 'r');
  try {
    const result = await new Promise<string>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          `
        import {spawn,execFile,exec,fork,spawnSync,execFileSync,execSync} from 'node:child_process';
        import {promisify} from 'node:util';
        const check=${JSON.stringify(inspect)};const env={};
        const spawned=spawn(process.execPath,['-e',check],{env});let output='';spawned.stdout.on('data',part=>output+=part);
        await new Promise(resolve=>spawned.on('close',resolve));console.log(output.trim());
        console.log((await promisify(execFile)(process.execPath,['-e',check],{env})).stdout.trim());
        console.log((await promisify(exec)(JSON.stringify(process.execPath)+' -e '+JSON.stringify(check),{env})).stdout.trim());
        const forked=fork(${JSON.stringify(childFile)},[],{env,stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});let result='';forked.stdout.on('data',part=>result+=part);
        await new Promise(resolve=>forked.on('close',resolve));console.log(result.trim());
        console.log(spawnSync(process.execPath,['-e',check],{env,encoding:'utf8'}).stdout.trim());
        console.log(execFileSync(process.execPath,['-e',check],{env,encoding:'utf8'}).trim());
        console.log(execSync(JSON.stringify(process.execPath)+' -e '+JSON.stringify(check),{env,encoding:'utf8'}).trim());
      `,
        ],
        {
          env: {
            ...process.env,
            VERITY_DEPENDENCY_PREPARATION_FD: '3',
            VERITY_DEPENDENCY_STORAGE_FD: '4',
            VERITY_DEPENDENCY_STORAGE_LEASE_ID: '11111111-1111-4111-8111-111111111111',
          },
          stdio: ['ignore', 'pipe', 'pipe', fd, fd],
        },
      );
      let output = '';
      let errors = '';
      child.stdout.on('data', (part: Buffer) => {
        output += part.toString();
      });
      child.stderr.on('data', (part: Buffer) => {
        errors += part.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? done(output.trim()) : reject(new Error(errors))));
    });
    expect(result.split('\n')).toEqual(Array(7).fill('true'));
  } finally {
    closeSync(fd);
  }
});

it('keeps the kernel holder alive in a writer descendant after its helper is killed', async () => {
  const root = temporary();
  const lock = join(root, 'holder');
  writeFileSync(lock, '');
  const marker = join(root, 'writer');
  const ready = join(root, 'ready');
  const writer = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const helper = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {openSync,writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
    import {flockCapacityDescriptor} from ${JSON.stringify('file://' + storage)};
    const fd=openSync(${JSON.stringify(lock)},'r');await flockCapacityDescriptor(fd);
    const leader=spawn(process.execPath,['--import',${JSON.stringify(preload)},'-e',${JSON.stringify(`require('node:child_process').spawn('sh',['-c','exec "$NODE" -e '+${JSON.stringify(JSON.stringify(writer))}],{env:{NODE:process.execPath},stdio:'ignore'}).unref()`)}],{
      env:{...process.env,VERITY_DEPENDENCY_STORAGE_FD:'4',VERITY_DEPENDENCY_STORAGE_LEASE_ID:'11111111-1111-4111-8111-111111111111'},stdio:['ignore','ignore','ignore','ignore',fd]});
    leader.on('close',()=>writeFileSync(${JSON.stringify(ready)},''));setInterval(()=>{},1000);
  `,
    ],
    { stdio: 'ignore' },
  );
  let pid: number | undefined;
  try {
    await until(() => existsSync(marker) && existsSync(ready));
    pid = Number(readFileSync(marker, 'utf8'));
    const exited = new Promise<void>((done) => helper.on('close', () => done()));
    helper.kill('SIGKILL');
    await exited;
    expect(spawnSync('flock', ['--exclusive', '--nonblock', lock, 'true']).status).toBe(1);
    process.kill(pid, 'SIGTERM');
    pid = undefined;
    await until(() => spawnSync('flock', ['--exclusive', '--nonblock', lock, 'true']).status === 0);
  } finally {
    helper.kill('SIGKILL');
    if (pid)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
  }
});

it('forwards the holder through the actual package wrapper into native npm descendants', async () => {
  const root = temporary();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Keep the fake native npm CommonJS even below a type:module checkout cache.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const marker = join(root, 'native');
  const lock = join(root, 'holder');
  writeFileSync(lock, '');
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}\nrequire('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(require('node:fs').fstatSync(4).isFile()))`)}],{env:{}});\n`,
    { mode: 0o755 },
  );
  const wrapper = join(root, 'wrapper.mjs');
  writeFileSync(
    wrapper,
    readFileSync(wrapperSource, 'utf8')
      .replaceAll(
        "from './",
        "from '" + 'file://' + resolve('features/verity-sandbox-toolkit/bin') + '/',
      )
      .replace(
        "new URL('./verity-dependency-storage-preload.mjs', import.meta.url)",
        'new URL(' + JSON.stringify('file://' + preload) + ')',
      ),
  );
  const fd = openSync(lock, 'r');
  let errors = '';
  try {
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, [wrapper, 'npm', '--version'], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          VERITY_SESSION_ID: '',
          VERITY_DEPENDENCY_STORAGE_FD: '4',
          VERITY_DEPENDENCY_STORAGE_LEASE_ID: '11111111-1111-4111-8111-111111111111',
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ignore', fd],
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', done);
    });
    expect(code, errors).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('true');
  } finally {
    closeSync(fd);
  }
});
