import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Apple frameworks are unavailable in the Linux check; guard the adapter's
// isolation and capability check here and compile it on the Apple build.
it('keeps join teardown separate from the active server transport', () => {
  const module = readFileSync(
    new URL('../apps/mobile/native/VerityRemoteControlTunnel.swift', import.meta.url),
    'utf8',
  );
  const joining = module.slice(
    module.indexOf('AsyncFunction("startJoin")'),
    module.indexOf('AsyncFunction("lastStopReason")'),
  );
  expect(joining).toContain('self.joinTunnel');
  expect(joining).toContain('self.joinSessionId == sessionId');
  expect(joining).not.toContain('self.tunnel');
  expect(joining).not.toContain('self.stopTunnels');
});
it('accepts only the capability requested for this attachment', () => {
  const source = readFileSync(
    new URL('../apps/mobile/native/RemoteAppTunnel.swift', import.meta.url),
    'utf8',
  );
  const start = source.slice(
    source.indexOf('func start(ticket:'),
    source.indexOf('private func startLocalListener'),
  );
  expect(start).toContain('frame["capability"] as? String == expectedCapability');
  expect(start).toContain('expectedCapability: String = "remote-control-v1"');
});
