import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createDeadlineChannel,
  type DeadlineChannelTiming,
} from './project-egress-deadline-channel.js';

const channels: ReturnType<typeof createDeadlineChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});
function fixture(body: string, timeout = 5000) {
  let launches = 0;
  let child: ChildProcessWithoutNullStreams | undefined;
  const channel = createDeadlineChannel(() => {
    launches++;
    child = spawn('/usr/bin/python3', ['-u', '-c', body], { detached: true });
    return child;
  }, timeout);
  channels.push(channel);
  return { channel, launches: () => launches, child: () => child! };
}
const echo = `import sys,json,os
for line in sys.stdin.buffer:
 f=json.loads(line)
 print(json.dumps({'id':f['id'],'result':{'input':f['input'],'pid':os.getpid()}}),flush=True)
`;
it('serializes concurrent operations through one process and reuses only the interpreter', async () => {
  const f = fixture(echo);
  const results = await Promise.all([f.channel.request('first'), f.channel.request('second')]);
  expect(results).toEqual([
    { input: 'first', pid: f.child().pid },
    { input: 'second', pid: f.child().pid },
  ]);
  expect(f.launches()).toBe(1);
});
it.each([
  ['wrong-id', "print(json.dumps({'id':f['id']+1,'result':None}),flush=True)"],
  ['malformed', "print('not json',flush=True)"],
  ['extra-frame', "print(json.dumps({'id':f['id'],'result':None})+'\\n{}',flush=True)"],
  ['oversized', "print(json.dumps({'id':f['id'],'result':'x'*16385}),flush=True)"],
  ['EOF', 'sys.exit(0)'],
])(
  'closes permanently after %s and rejects queued work without replay',
  async (_name, response) => {
    const f = fixture('import sys,json\nf=json.loads(sys.stdin.buffer.readline())\n' + response);
    const results = await Promise.allSettled([f.channel.request(1), f.channel.request(2)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    await expect(f.channel.request(3)).rejects.toThrow();
    expect(f.launches()).toBe(1);
  },
);
it('kills a hung helper at the operation budget and rejects queued work', async () => {
  const f = fixture('import time\ntime.sleep(10)', 100);
  const results = await Promise.allSettled([f.channel.request(1), f.channel.request(2)]);
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  await expect.poll(() => f.child().signalCode).toBe('SIGKILL');
  await expect(f.channel.request(3)).rejects.toThrow('timed out');
  expect(f.launches()).toBe(1);
});
it('rejects abrupt process death and never launches a replacement', async () => {
  const f = fixture('import sys,os\nsys.stdin.buffer.readline()\nos.kill(os.getpid(),9)');
  await expect(f.channel.request(1)).rejects.toThrow();
  await expect(f.channel.request(2)).rejects.toThrow();
  expect(f.launches()).toBe(1);
});
it('bounds request size before launch and queued work before execution', async () => {
  const f = fixture(echo);
  await expect(f.channel.request('x'.repeat(65536))).rejects.toThrow('Oversized');
  expect(f.launches()).toBe(0);
  const results = await Promise.allSettled(
    Array.from({ length: 65 }, (_, i) => f.channel.request(i)),
  );
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(f.launches()).toBe(0);
});
it('allows containment after a well-formed operation refusal', async () => {
  const f = fixture(`import sys,json
for line in sys.stdin.buffer:
 f=json.loads(line)
 print(json.dumps({'id':f['id'],**({'error':'denied'} if f['input']=='renew' else {'result':'revoked'})}),flush=True)
`);
  await expect(f.channel.request('renew')).rejects.toThrow('denied');
  await expect(f.channel.request('revoke')).resolves.toBe('revoked');
  expect(f.launches()).toBe(1);
});
it('explicit close terminates the helper and rejects all future operations', async () => {
  const f = fixture(echo);
  await f.channel.request(1);
  f.channel.close();
  await expect.poll(() => f.child().signalCode).toBe('SIGKILL');
  await expect(f.channel.request(2)).rejects.toThrow('closed');
});

it('speaks the production Python protocol and takes a fresh clock sample on every request', async () => {
  const path = resolve(import.meta.dirname, '../../../deploy/egress/project-egress-deadline.py');
  const f = fixture(`import importlib.util,sys,tempfile,os
s=importlib.util.spec_from_file_location('h',${JSON.stringify(path)})
h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
h.bind_parent(os.getppid())
with tempfile.TemporaryFile() as held:
 h.serve(sys.stdin.buffer,sys.stdout.buffer,held)
`);
  const timings: DeadlineChannelTiming[] = [];
  const first = (await f.channel.request({ operation: 'clock' }, (timing) =>
    timings.push(timing),
  )) as {
    bootBeforeNs: string;
    bootAfterNs: string;
  };
  expect(timings).toHaveLength(1);
  expect(BigInt(timings[0]!.startedBootNs)).toBeLessThanOrEqual(BigInt(first.bootBeforeNs));
  expect(BigInt(timings[0]!.finishedBootNs)).toBeGreaterThanOrEqual(BigInt(first.bootAfterNs));
  const second = (await f.channel.request({ operation: 'clock' })) as typeof first;
  expect(BigInt(second.bootBeforeNs)).toBeGreaterThan(BigInt(first.bootAfterNs));
  expect(f.launches()).toBe(1);
});

it('rejects missing timing when required by the native evidence observer', async () => {
  const f = fixture(echo);
  await expect(f.channel.request('clock', () => undefined)).rejects.toThrow(
    'Missing host deadline timing',
  );
  await expect(f.channel.request('clock')).rejects.toThrow('Missing host deadline timing');
});

it('terminates the process group during a blocked mutating subprocess', async () => {
  const f = fixture(`import sys,subprocess,json,os
f=json.loads(sys.stdin.readline())
p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
print(json.dumps({'id':f['id'],'result':p.pid}),flush=True)
for line in sys.stdin: p.wait()
`);
  const pid = (await f.channel.request(1)) as number;
  f.channel.close();
  const { readFile } = await import('node:fs/promises');
  await expect
    .poll(async () => {
      try {
        return (await readFile('/proc/' + pid + '/stat', 'utf8')).split(' ')[2];
      } catch {
        return 'gone';
      }
    })
    .toMatch(/^(Z|gone)$/u);
});
it('bounds time from enqueue even when earlier operations finish within their own budget', async () => {
  const f = fixture(
    `import sys,json,time
for line in sys.stdin:
 f=json.loads(line);time.sleep(.6);print(json.dumps({'id':f['id'],'result':True}),flush=True)
`,
    1800,
  );
  const values = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => f.channel.request(i)),
  );
  expect(values[0]!.status).toBe('fulfilled');
  expect(values[4]!.status).toBe('rejected');
  await expect(f.channel.request(6)).rejects.toThrow('timed out');
});
it('poisons the channel before queued operations on result validation failure', async () => {
  const f = fixture(echo);
  const first = f.channel.request('bad', undefined, () => {
    throw new Error('immutable deadline changed');
  });
  const next = f.channel.request('queued');
  await expect(first).rejects.toThrow('immutable deadline changed');
  await expect(next).rejects.toThrow('immutable deadline changed');
  await expect(f.channel.request('later')).rejects.toThrow('immutable deadline changed');
});
