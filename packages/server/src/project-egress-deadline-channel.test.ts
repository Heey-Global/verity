import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeadlineChannel } from './project-egress-deadline-channel.js';

const channels: ReturnType<typeof createDeadlineChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});
function fixture(body: string, timeout = 5000) {
  const launch = vi.fn(() =>
    spawn(
      process.execPath,
      [
        '-e',
        `
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const frame=JSON.parse(line); ${body}
    });`,
      ],
      { stdio: 'pipe' },
    ),
  );
  const channel = createDeadlineChannel(launch, timeout);
  channels.push(channel);
  return { channel, launch };
}
it('serializes concurrent calls over one child with monotonic sequence IDs', async () => {
  const { channel, launch } = fixture(
    'setTimeout(()=>console.log(JSON.stringify({id:frame.id,result:frame.id})),10);',
  );
  expect(
    await Promise.all([
      channel.request({ operation: 'clock' }),
      channel.request({ operation: 'clock' }),
    ]),
  ).toEqual([1, 2]);
  expect(launch).toHaveBeenCalledOnce();
});
it('can revoke after an operation error without replaying the failed operation', async () => {
  const { channel, launch } = fixture(
    'console.log(JSON.stringify(frame.id===1?{id:frame.id,error:"refused"}:{id:frame.id,result:"denied"}));',
  );
  await expect(channel.request({ operation: 'arm' })).rejects.toThrow('refused');
  expect(await channel.request({ operation: 'revoke' })).toBe('denied');
  expect(launch).toHaveBeenCalledOnce();
});
it.each([
  'process.exit(1);',
  'console.log(JSON.stringify({id:frame.id+1,result:{}}));',
  'console.log("x".repeat(16385));',
  'console.log("{}\\n{}");',
])('makes a broken transport terminal rather than relaunching or replaying', async (body) => {
  const { channel, launch } = fixture(body);
  await expect(channel.request({ operation: 'clock' })).rejects.toThrow();
  await expect(channel.request({ operation: 'clock' })).rejects.toThrow();
  expect(launch).toHaveBeenCalledOnce();
});
it('kills a timed-out child and rejects queued operations without replay', async () => {
  const { channel, launch } = fixture('', 100);
  await expect(
    Promise.all([channel.request({ operation: 'clock' }), channel.request({ operation: 'clock' })]),
  ).rejects.toThrow('timed out');
  await expect(channel.request({ operation: 'clock' })).rejects.toThrow('timed out');
  expect(launch).toHaveBeenCalledOnce();
});
it('rejects oversized requests before launching a helper', async () => {
  const { channel, launch } = fixture(
    'console.log(JSON.stringify({id:frame.id,result:frame.id}));',
  );
  await expect(channel.request({ payload: 'x'.repeat(65536) })).rejects.toThrow('Oversized');
  expect(launch).not.toHaveBeenCalled();
  expect(await channel.request({ operation: 'clock' })).toBe(1);
});
