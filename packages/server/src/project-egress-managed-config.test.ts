import { expect, it } from 'vitest';
import {
  managedEgressConfiguration,
  managedEgressDatabaseAddress,
  managedEgressRoleSql,
} from './project-egress-managed-config.js';

const inspection = (address = '172.30.2.3') => [
  {
    Id: 'a'.repeat(64),
    Config: { Labels: { 'com.docker.compose.service': 'postgres' } },
    State: { Running: true },
    NetworkSettings: { Networks: { 'verity-net': { IPAddress: address } } },
  },
];
const input = () => ({
  env: {
    DATABASE_URL: 'postgres://verity:private@postgres:5432/verity',
    VERITY_EGRESS_DEPLOYMENT_NETWORK: 'verity-net',
    VERITY_PROJECT_RELAY_IMAGE: `ghcr.io/example/relay@sha256:${'b'.repeat(64)}`,
    VERITY_DATA_VOLUME: 'verity-data',
  },
  databaseInspection: inspection(),
  dnsServers: ['127.0.0.53', '2001:4860:4860::8888'],
});

it('derives a private inspected endpoint and a separate bounded database role', () => {
  const configuration = managedEgressConfiguration(input());
  const url = new URL(configuration.authority.databaseUrl);
  expect(url.hostname).toBe('172.30.2.3');
  expect(url.username).toBe('verity_egress_host');
  expect(url.password).toMatch(/^[a-f0-9]{64}$/u);
  expect(configuration.roleSql).not.toContain('private');
  expect(configuration.roleSql).toContain(
    'GRANT SELECT, INSERT, UPDATE ON TABLE public.project_egress_policy',
  );
  expect(configuration.roleSql).not.toMatch(/GRANT .* (?:users|secrets)|GRANT ALL/u);
  expect(configuration.relay.packetEnforcement).toBe(true);
  expect(configuration.relay.codexSubpath).toBe('relay/codex');
  expect(configuration.locator).toEqual({
    version: 1,
    network: 'verity-net',
    service: 'postgres',
    database: 'verity',
  });
});

it('preserves the host credential while rediscovering a changed database IP', () => {
  const first = managedEgressConfiguration(input());
  const next = managedEgressConfiguration({
    ...input(),
    previousAuthority: first.authority,
    databaseInspection: inspection('172.30.2.4'),
  });
  expect(new URL(next.authority.databaseUrl).password).toBe(
    new URL(first.authority.databaseUrl).password,
  );
  expect(new URL(next.authority.databaseUrl).hostname).toBe('172.30.2.4');
});

it('rejects stopped, ambiguous, foreign-network and non-database containers', () => {
  const stopped = inspection();
  stopped[0]!.State.Running = false;
  const foreign = inspection();
  foreign[0]!.Config.Labels['com.docker.compose.service'] = 'server';
  for (const value of [stopped, foreign, [], [...inspection(), ...inspection()]])
    expect(() => managedEgressDatabaseAddress(value, 'verity-net')).toThrow();
  expect(() => managedEgressDatabaseAddress(inspection(), 'other-network')).toThrow();
  expect(() => managedEgressDatabaseAddress(inspection('127.0.0.1'), 'verity-net')).toThrow();
});

it('does not accept mutable relay images, SQL fragments or unusable DNS', () => {
  const mutable = input();
  mutable.env.VERITY_PROJECT_RELAY_IMAGE = 'example/relay:latest';
  expect(() => managedEgressConfiguration(mutable)).toThrow();
  expect(() => managedEgressRoleSql('x', 'verity')).toThrow();
  expect(() => managedEgressRoleSql('a'.repeat(64), 'verity;DROP DATABASE verity')).toThrow();
  expect(() => managedEgressConfiguration({ ...input(), dnsServers: [] })).toThrow();
});

it('formats inspected IPv6 addresses as database URL authorities', () => {
  const result = managedEgressConfiguration({
    ...input(),
    databaseInspection: inspection('fd42::3'),
  });
  expect(new URL(result.authority.databaseUrl).hostname).toBe('[fd42::3]');
});

it('retains only the installed immutable relay still needed by protected generations', () => {
  const first = managedEgressConfiguration(input());
  const nextInput = input();
  nextInput.env.VERITY_PROJECT_RELAY_IMAGE = `ghcr.io/example/relay@sha256:${'c'.repeat(64)}`;
  const next = managedEgressConfiguration({
    ...nextInput,
    previousRelay: first.relay,
    activeRelayImages: [first.relay.image],
  });
  expect(next.relay.previousImage).toBe(first.relay.image);
  expect(next.relay.image).toBe(nextInput.env.VERITY_PROJECT_RELAY_IMAGE);
  const repeated = managedEgressConfiguration({
    ...nextInput,
    previousRelay: next.relay,
    activeRelayImages: [first.relay.image, next.relay.image],
  });
  expect(repeated.relay).toEqual(next.relay);
  const retired = managedEgressConfiguration({
    ...nextInput,
    previousRelay: next.relay,
    activeRelayImages: [next.relay.image],
  });
  expect(retired.relay.previousImage).toBeUndefined();
  const thirdInput = input();
  thirdInput.env.VERITY_PROJECT_RELAY_IMAGE = `ghcr.io/example/relay@sha256:${'d'.repeat(64)}`;
  expect(() =>
    managedEgressConfiguration({
      ...thirdInput,
      previousRelay: next.relay,
      activeRelayImages: [first.relay.image, next.relay.image],
    }),
  ).toThrow('more than one retained');
  expect(() =>
    managedEgressConfiguration({
      ...nextInput,
      previousRelay: first.relay,
      activeRelayImages: ['untrusted:latest'],
    }),
  ).toThrow('outside installed');
  const changed = { ...first.relay, dataVolume: 'other-data' };
  expect(() =>
    managedEgressConfiguration({
      ...nextInput,
      previousRelay: changed,
      activeRelayImages: [first.relay.image],
    }),
  ).toThrow('execution contract');
});
