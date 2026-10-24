import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

it('keeps stall recorder dependencies outside the shipping tunnel compilation', () => {
  const source = read('apps/mobile/native/RemoteAppTunnel.swift');
  const flag = 'VERITY_STALL_DIAGNOSTICS';
  const blocks = [...source.matchAll(new RegExp(`^#if ${flag}\\n([\\s\\S]*?)^#endif\\n`, 'gmu'))];
  expect(blocks.length).toBeGreaterThan(0);
  const shipping = blocks.reduce((remaining, [block]) => remaining.replace(block, ''), source);
  expect(shipping).not.toMatch(/StallDiagnostics|stallDiagnostics|diagnostics\?\./u);
  // A hook removed from the conditional is a shipping dependency, even if the
  // diagnostic runner still compiles and its tests continue to pass.
  for (const script of [
    'scripts/remote-control-staging/run.sh',
    'scripts/remote-control-tunnel/run-apple.sh',
  ]) {
    const text = read(script);
    for (const command of text.matchAll(/xcrun swiftc[^\n]*/gu)) {
      expect(command[0]).toContain(`-D ${flag}`);
    }
    expect(text).toContain('scripts/remote-control-staging/StallWriterDiagnostics.swift');
    expect(text).toContain('scripts/remote-control-staging/StallDiagnostics.swift');
  }
});

it('forwards the pin delegate redirect policy through the data observer', () => {
  const delegate = read('apps/mobile/native/CertificatePinDelegate.swift');
  const observer = read('scripts/remote-control-staging/StallDiagnostics.swift');
  const callback = /\b(willPerformHTTPRedirection) response:/u.exec(delegate)?.[1];
  expect(callback).toBeDefined();
  expect(observer).toMatch(
    new RegExp(`pin\\.urlSession\\(session, task: task, ${callback}: response,`, 'u'),
  );
});

it('observes each warmup request and emits its snapshot before legacy cleanup output', () => {
  const source = read('scripts/remote-control-staging/StagingProbe.swift');
  const warmup = source.slice(
    source.indexOf('for attempt in 0..<3'),
    source.indexOf('// Unparsable'),
  );
  expect(warmup).toContain('let observer = StallHTTPObserver(');
  expect(warmup).toContain('response = try await observer.request(coreURL, session: client)');
  expect(warmup).not.toContain('client.data(');
  expect(warmup.match(/diagnostic: observer.snapshot, warmup: true/gu)).toHaveLength(2);
  expect(warmup.match(/own: attempt, total: attempt/gu)).toHaveLength(2);
  expect(warmup.indexOf('emitStallFailure(')).toBeLessThan(warmup.indexOf('print("probe-error:'));
  const observer = read('scripts/remote-control-staging/StallDiagnostics.swift');
  expect(observer.indexOf('task.delegate = self')).toBeGreaterThan(-1);
  expect(observer.indexOf('task.delegate = self')).toBeLessThan(observer.indexOf('task.resume()'));
});
