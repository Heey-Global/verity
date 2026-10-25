import { PreviewReadScheduler } from './previewReadScheduler';

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

it('bounds queued work and coalesces invalidations into one follow-up', async () => {
  const publish = jest.fn();
  const scheduler = new PreviewReadScheduler(publish);
  const finishes: (() => void)[] = [];
  const read = jest.fn(() => new Promise<void>((resolve) => finishes.push(resolve)));
  scheduler.setActive(true);
  for (let i = 0; i < 10; i++) scheduler.add(String(i), read);
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  scheduler.invalidate('0');
  scheduler.invalidate('0');
  finishes[0]!();
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
  scheduler.setActive(false);
  for (const [signal] of read.mock.calls.slice(1) as unknown as [AbortSignal][])
    expect(signal.aborted).toBe(true);
  finishes.forEach((finish) => finish());
  await flush();
  expect(read).toHaveBeenCalledTimes(3);
  scheduler.stop();
});

it('batches completions and does not spin on failure or publish while hidden', async () => {
  jest.useFakeTimers();
  const publish = jest.fn();
  const scheduler = new PreviewReadScheduler(publish);
  const read = jest.fn(async () => {});
  scheduler.setActive(true);
  scheduler.add('a', read);
  scheduler.add('b', read);
  await flush();
  jest.runOnlyPendingTimers();
  expect(publish).toHaveBeenCalledTimes(1);
  scheduler.add('failure', async () => {
    throw new Error('offline');
  });
  await flush();
  expect(jest.getTimerCount()).toBe(0);
  scheduler.setActive(false);
  scheduler.invalidate('a');
  await flush();
  jest.runOnlyPendingTimers();
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledTimes(1);
  scheduler.setActive(true);
  await flush();
  jest.runOnlyPendingTimers();
  expect(read).toHaveBeenCalledTimes(3);
  scheduler.stop();
  jest.useRealTimers();
});
