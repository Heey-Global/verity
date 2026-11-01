import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createProjectDeadlineWorker } from './project-egress-deadline-worker.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const source = `
const {createInterface} = require('node:readline');
const {appendFileSync} = require('node:fs');
let pending = 0;
let sequence = 0;
createInterface({input:process.stdin}).on('line', line => {
 const {id,request:r} = JSON.parse(line);
 if (id !== ++sequence) process.exit(12);
 if (process.env.MARKER) appendFileSync(process.env.MARKER, JSON.stringify(r)+'\\n');
 if (++pending > 1) process.exit(11);
 const response = {id,result:{pid:process.pid,value:r.value},startedBootNs:'100',finishedBootNs:'200'};
 if (r.mode === 'descendant') {
  require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.env.MARKER+'.late','late'),500)"],{stdio:'inherit'});
  return;
 }
 if (r.mode === 'exit') process.exit(7);
 if (r.mode === 'hang') return;
 if (r.mode === 'oversize') { process.stdout.write('x'.repeat(16385)); return; }
 if (r.mode === 'malformed') { process.stdout.write('{\\n'); return; }
 if (r.mode === 'utf8') { process.stdout.write(Buffer.from([255,10])); return; }
 if (r.mode === 'mismatch') response.id++;
 if (r.mode === 'error') { delete response.result; response.error=true; }
 const send = () => { pending--; const frame=JSON.stringify(response)+'\\n'; process.stdout.write(r.mode==='double' ? frame+frame : frame); };
 if (r.delay) setTimeout(send,r.delay); else send();
});`;
function fixture(timeout = 1000, marker?: string) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const worker = createProjectDeadlineWorker(() => {
    const child = spawn(process.execPath, ['-e', source], {
      env: { ...process.env, ...(marker ? { MARKER: marker } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    children.push(child);
    return child;
  }, timeout);
  cleanups.push(async () => {
    const exits = children
      .filter((c) => c.exitCode === null && c.signalCode === null)
      .map((c) => once(c, 'close'));
    worker.close();
    await Promise.all(exits);
  });
  return { worker, children };
}
it('reuses one process and serializes concurrent requests through one pipe frame', async () => {
  const { worker, children } = fixture();
  const results = await Promise.all([
    worker.request({ value: 1, delay: 30 }),
    worker.request({ value: 2 }),
  ]);
  expect(results).toEqual([
    { pid: children[0]!.pid, value: 1 },
    { pid: children[0]!.pid, value: 2 },
  ]);
  expect(children).toHaveLength(1);
});
it.each(['mismatch', 'double', 'malformed', 'oversize', 'utf8', 'exit'])(
  'kills a failed %s worker and rejects queued requests without replay',
  async (mode) => {
    const { worker, children } = fixture();
    const results = await Promise.allSettled([
      worker.request({ mode }),
      worker.request({ value: 'queued' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    if (children[0]!.exitCode === null && children[0]!.signalCode === null)
      await once(children[0]!, 'close');
    expect(children).toHaveLength(1);
    await expect(worker.request({ value: 'fresh' })).rejects.toThrow('unavailable');
    expect(children).toHaveLength(1);
  },
);
it('rejects invalid operation results and terminates the worker', async () => {
  const { worker, children } = fixture();
  const exited = new Promise((resolve) => {
    setImmediate(() => children[0]!.once('close', resolve));
  });
  await expect(
    worker.request({}, () => {
      throw new Error('Invalid immutable deadline');
    }),
  ).rejects.toThrow('Invalid immutable');
  await exited;
  expect(children[0]!.signalCode).toBe('SIGKILL');
});
it('operation refusal does not replay a mutation or corrupt the following reply', async () => {
  const { worker, children } = fixture();
  await expect(worker.request({ mode: 'error' })).rejects.toThrow('operation failed');
  await expect(worker.request({ value: 3 })).resolves.toMatchObject({ value: 3 });
  expect(children).toHaveLength(1);
});
it('applies deadlines from enqueue time, including time behind another operation', async () => {
  const { worker } = fixture(500);
  const results = await Promise.allSettled([
    worker.request({ delay: 300 }),
    worker.request({ delay: 300 }),
  ]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1].status).toBe('rejected');
  if (results[1].status === 'rejected') expect(String(results[1].reason)).toContain('timed out');
});
it('allocates contiguous wire IDs only after a frame passes validation', async () => {
  const { worker, children } = fixture();
  await expect(worker.request({ value: 'x'.repeat(65536) })).rejects.toThrow('Oversized');
  await expect(worker.request({ value: 'valid' })).resolves.toMatchObject({ value: 'valid' });
  expect(children).toHaveLength(1);
});
it('bounds requests and the queue even when pipe output never completes', async () => {
  const { worker } = fixture(150);
  await expect(worker.request({ value: 'x'.repeat(65536) })).rejects.toThrow('Oversized');
  const pending = Array.from({ length: 16 }, () => worker.request({ mode: 'hang' }));
  const settled = Promise.allSettled(pending);
  await expect(worker.request({})).rejects.toThrow('queue is full');
  expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
});
it('never replays a partially applied mutation after worker death', async () => {
  const directory = await mkdtemp('/tmp/deadline-worker-');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const marker = directory + '/mutations';
  const { worker, children } = fixture(1000, marker);
  const exited = new Promise((resolve) => {
    setImmediate(() => children[0]!.once('close', resolve));
  });
  await expect(worker.request({ mode: 'exit', value: 'mutation' })).rejects.toThrow();
  await exited;
  await expect(worker.request({ value: 'fresh' })).rejects.toThrow('unavailable');
  const lines = (await readFile(marker, 'utf8'))
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));
  expect(lines).toEqual([{ mode: 'exit', value: 'mutation' }]);
});
it('explicit shutdown rejects active and queued work and prevents restart', async () => {
  const { worker } = fixture();
  const active = worker.request({ mode: 'hang' });
  const queued = worker.request({});
  const settled = Promise.allSettled([active, queued]);
  worker.close();
  expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
  await expect(worker.request({})).rejects.toThrow('unavailable');
});

it('kills subprocess mutations with the worker on timeout', async () => {
  const directory = await mkdtemp('/tmp/deadline-descendant-');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const marker = directory + '/mutation';
  const { worker, children } = fixture(250, marker);
  await expect(worker.request({ mode: 'descendant' })).rejects.toThrow('timed out');
  if (children[0]!.exitCode === null && children[0]!.signalCode === null)
    await once(children[0]!, 'close');
  await new Promise((resolve) => setTimeout(resolve, 550));
  await expect(readFile(marker + '.late')).rejects.toThrow();
});

it('times out a stopped executor and rejects queued work', async () => {
  const { worker, children } = fixture(300);
  await worker.request({ value: 'ready' });
  process.kill(children[0]!.pid!, 'SIGSTOP');
  const results = await Promise.allSettled([
    worker.request({ value: 'stopped' }),
    worker.request({}),
  ]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  if (children[0]!.exitCode === null && children[0]!.signalCode === null)
    await once(children[0]!, 'close');
  expect(children[0]!.signalCode).toBe('SIGKILL');
});
it('bounds an input pipe whose worker never reads requests', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const worker = createProjectDeadlineWorker(() => child, 150);
  cleanups.push(async () => {
    worker.close();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
  });
  await expect(worker.request({ value: 'x'.repeat(65000) })).rejects.toThrow('timed out');
});

it('requires explicit reconstruction after worker failure, including for containment', async () => {
  const { worker, children } = fixture();
  await expect(worker.request({ mode: 'malformed' })).rejects.toThrow();
  await expect(worker.request({ value: 'deny' })).rejects.toThrow('unavailable');
  expect(children).toHaveLength(1);
  const fresh = fixture();
  await expect(fresh.worker.request({ value: 'deny' })).resolves.toMatchObject({ value: 'deny' });
});
