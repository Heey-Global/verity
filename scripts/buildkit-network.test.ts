import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('deploy/buildkit/network.sh');
const toml = readFileSync('deploy/buildkit/buildkitd.toml', 'utf8');
const unit = readFileSync('deploy/buildkit/verity-buildkit.service', 'utf8');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Host {
  routes?: string[];
  dockerSubnets?: string[];
  daemonPools?: string[];
  networkEnv?: string;
  bridgeAddress?: string;
}

function host(options: Host = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-buildkit-network-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const config = join(root, 'etc');
  mkdirSync(bin);
  mkdirSync(config);
  const log = join(root, 'ip.log');
  writeFileSync(
    join(bin, 'ip'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  "-4 -o route show table all") printf '%s\\n' ${(options.routes ?? []).map((r) => JSON.stringify(r)).join(' ')} ;;
  "-4 -o addr show dev verity-bk0") ${options.bridgeAddress === undefined ? 'exit 1' : `printf '5: verity-bk0    inet %s brd + scope global verity-bk0\\n' ${JSON.stringify(options.bridgeAddress)}`} ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "network ls") printf 'n1\\n' ;;
  "network inspect") printf '%s ' ${(options.dockerSubnets ?? []).map((s) => JSON.stringify(s)).join(' ')} ;;
esac
`,
    { mode: 0o755 },
  );
  const daemon = join(root, 'daemon.json');
  if (options.daemonPools !== undefined)
    writeFileSync(
      daemon,
      JSON.stringify({
        'default-address-pools': options.daemonPools.map((base) => ({ base, size: 24 })),
      }),
    );
  if (options.networkEnv !== undefined)
    writeFileSync(join(config, 'network.env'), options.networkEnv);
  const run = (command: string) =>
    spawnSync('bash', [script, command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        VERITY_BUILDKIT_CONFIG_DIR: config,
        VERITY_BUILDKIT_STATE_DIR: join(root, 'state'),
        VERITY_DOCKER_DAEMON_JSON: daemon,
      },
    });
  return {
    run,
    config,
    ipCalls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    conflist: () =>
      JSON.parse(readFileSync(join(config, 'cni.conflist'), 'utf8')) as {
        plugins: { type: string; bridge?: string; ipam?: { ranges: { subnet: string }[][] } }[];
      },
    networkEnv: () => readFileSync(join(config, 'network.env'), 'utf8'),
  };
}

const hasJq = spawnSync('sh', ['-c', 'command -v jq']).status === 0;

describe('builder CNI configuration', () => {
  // The CNI config is generated, so nothing else ties BuildKit to it. A worker
  // left on its host-network default fails every RUN step that needs DNS.
  it('points the worker and its start-up at the generated CNI network', () => {
    expect(toml).toMatch(/^\s*networkMode = "cni"$/m);
    expect(toml).toContain('cniConfigPath = "/etc/verity-buildkit/cni.conflist"');
    expect(unit).toContain('ExecStartPre=+/usr/local/libexec/verity-buildkit/network.sh apply');
  });
});

describe('build subnet selection', () => {
  it('takes the first candidate on a host that routes nothing near it', () => {
    const h = host({ routes: ['default via 10.0.0.1 dev eth0', '10.0.0.0/24 dev eth0'] });
    const result = h.run('apply');
    expect(result.status, result.stderr).toBe(0);
    expect(h.networkEnv()).toContain('SUBNET=10.213.0.0/24');
    const bridge = h.conflist().plugins[0]!;
    expect(bridge.bridge).toBe('verity-bk0');
    expect(bridge.ipam!.ranges[0]![0]!.subnet).toBe('10.213.0.0/24');
    expect(h.conflist().plugins.map((plugin) => plugin.type)).toEqual(['bridge', 'firewall']);
  });

  // A broad host or VPN route that swallows the first candidate is exactly the
  // overlap that would send build traffic, or the host's own, the wrong way.
  it.each([
    ['a host route', { routes: ['10.213.0.0/16 dev wg0'] }],
    ['a Docker network', { dockerSubnets: ['10.213.0.0/20'] }],
    ['a route in another table', { routes: ['10.213.0.0/16 dev tailscale0 table 52'] }],
  ] satisfies [string, Host][])('skips a range covered by %s', (_, options) => {
    const h = host(options);
    expect(h.run('apply').status).toBe(0);
    expect(h.networkEnv()).not.toContain('SUBNET=10.213.0.0/24');
  });

  it('reports a host where every candidate is taken instead of guessing', () => {
    const h = host({ routes: ['10.0.0.0/8 dev wg0'] });
    const result = h.run('apply');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no free build subnet');
  });

  it.skipIf(!hasJq)('honours pools configured in daemon.json', () => {
    const h = host({ daemonPools: ['10.213.0.0/16'] });
    expect(h.run('apply').status).toBe(0);
    expect(h.networkEnv()).toContain('SUBNET=10.247.0.0/24');
  });

  it('keeps a stored subnet while it stays free and moves off it once taken', () => {
    const kept = host({ networkEnv: 'SUBNET=10.213.7.0/24\n' });
    expect(kept.run('select').stdout.trim()).toBe('10.213.7.0/24');
    const moved = host({ networkEnv: 'SUBNET=10.213.7.0/24\n', routes: ['10.213.7.0/24 dev wg0'] });
    const result = moved.run('select');
    expect(result.stdout.trim()).toBe('10.213.0.0/24');
    expect(result.stderr).toContain('now overlaps 10.213.7.0/24');
  });

  it('ignores the route of its own bridge when revalidating', () => {
    const h = host({
      networkEnv: 'SUBNET=10.213.7.0/24\n',
      routes: ['10.213.7.0/24 dev verity-bk0 proto kernel scope link src 10.213.7.1'],
    });
    expect(h.run('select').stdout.trim()).toBe('10.213.7.0/24');
  });

  // A pinned subnet is an administrator's decision. Moving off it silently would
  // hide the conflict they need to resolve.
  it('refuses a pinned subnet that conflicts instead of replacing it', () => {
    const h = host({
      networkEnv: 'PINNED_SUBNET=192.168.50.0/24\n',
      dockerSubnets: ['192.168.48.0/20'],
    });
    const result = h.run('apply');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pinned build subnet 192.168.50.0/24 overlaps');
    expect(existsSync(join(h.config, 'cni.conflist'))).toBe(false);
  });

  it('keeps a free pinned subnet across applies', () => {
    const h = host({ networkEnv: 'PINNED_SUBNET=10.99.0.0/24\n' });
    expect(h.run('apply').status).toBe(0);
    expect(h.networkEnv()).toContain('PINNED_SUBNET=10.99.0.0/24');
    expect(h.networkEnv()).toContain('SUBNET=10.99.0.0/24');
  });

  it('reserves the carrier-grade NAT range VPNs claim and Docker defaults', () => {
    const h = host({ networkEnv: 'PINNED_SUBNET=100.100.0.0/24\n' });
    expect(h.run('apply').stderr).toContain('overlaps 100.64.0.0/10');
    const docker = host({ networkEnv: 'PINNED_SUBNET=172.20.1.0/24\n' });
    expect(docker.run('apply').status).not.toBe(0);
  });

  it('removes a bridge still addressed on a previous subnet', () => {
    const stale = host({ bridgeAddress: '10.213.5.1/24' });
    expect(stale.run('apply').status).toBe(0);
    expect(stale.ipCalls()).toContain('link delete verity-bk0');
    const current = host({ bridgeAddress: '10.213.0.1/24' });
    expect(current.run('apply').status).toBe(0);
    expect(current.ipCalls()).not.toContain('link delete');
  });
});
