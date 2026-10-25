import { readFileSync } from 'node:fs';
import { setGestureDiagnosticsEnabled } from './gestureDiagnostics';
import { reportRecordedScrollDiagnostic } from './scrollDiagnostics';

let clock = 10000;
beforeEach(() => {
  clock += 10000;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  setGestureDiagnosticsEnabled(false);
});
afterEach(() => {
  setGestureDiagnosticsEnabled(false);
  jest.restoreAllMocks();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it('never invokes the request or builds its payload outside recording', async () => {
  const send = jest.fn().mockResolvedValue(undefined);
  reportRecordedScrollDiagnostic(send);
  expect(send).not.toHaveBeenCalled();
  setGestureDiagnosticsEnabled(true);
  reportRecordedScrollDiagnostic(send);
  await flush();
  setGestureDiagnosticsEnabled(false);
  clock += 2000;
  reportRecordedScrollDiagnostic(send);
  expect(send).toHaveBeenCalledTimes(1);
});

it('drops bursts and concurrent requests without queueing, including across recording changes', async () => {
  let resolve!: () => void;
  const send = jest.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  setGestureDiagnosticsEnabled(true);
  reportRecordedScrollDiagnostic(send);
  clock += 2000;
  setGestureDiagnosticsEnabled(false);
  setGestureDiagnosticsEnabled(true);
  for (let i = 0; i < 100; i++) reportRecordedScrollDiagnostic(send);
  expect(send).toHaveBeenCalledTimes(1);
  resolve();
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  reportRecordedScrollDiagnostic(send);
  resolve();
  await flush();
  reportRecordedScrollDiagnostic(send);
  expect(send).toHaveBeenCalledTimes(2);
});

it('recovers from rejected and synchronously throwing senders without retrying', async () => {
  setGestureDiagnosticsEnabled(true);
  const send = jest.fn().mockRejectedValue(new Error('offline'));
  reportRecordedScrollDiagnostic(send);
  await flush();
  clock += 1000;
  reportRecordedScrollDiagnostic(() => {
    throw new Error('sync');
  });
  clock += 1000;
  reportRecordedScrollDiagnostic(send);
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
});

it('routes the production screen request through the recording gate', () => {
  const source = readFileSync(__dirname + '/../app/session/[id].tsx', 'utf8');
  const callback = source.slice(
    source.indexOf('const reportScrollDebug ='),
    source.indexOf('// Measured height of the input bar'),
  );
  expect(callback).toContain('reportRecordedScrollDiagnostic(() => {');
  expect(callback.indexOf('reportRecordedScrollDiagnostic')).toBeLessThan(
    callback.indexOf('client.reportScrollDiagnostic'),
  );
  expect(source.match(/\.reportScrollDiagnostic\(/g)).toHaveLength(1);
});
