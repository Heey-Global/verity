import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('network protection deployment', () => {
  it('preserves the bind-mounted socket directory across host-service restarts', async () => {
    const unit = await readFile('deploy/egress/verity-egress-host.service', 'utf8');
    expect(unit).toMatch(/^RuntimeDirectory=verity-egress$/m);
    expect(unit).toMatch(/^RuntimeDirectoryPreserve=yes$/m);
  });

  it('automatically wires read-only host controls only into the trusted server', async () => {
    const compose = parse(await readFile('deploy/docker-compose.yml', 'utf8')) as {
      services: Record<
        string,
        { environment?: Record<string, string>; volumes?: string[]; group_add?: string[] }
      >;
    };
    const server = compose.services.verity!;
    expect(server.environment?.VERITY_PROJECT_EGRESS_SOCKET).toBe(
      '/run/verity-egress/control.sock',
    );
    expect(server.environment?.VERITY_PROJECT_EGRESS_KEY_PATH).toBe(
      '/run/verity-egress-key/control.key',
    );
    expect(server.volumes).toEqual(
      expect.arrayContaining([
        '/run/verity-egress:/run/verity-egress:ro',
        '/etc/verity-egress-server:/run/verity-egress-key:ro',
      ]),
    );
    expect(server.group_add).toContain('65531');
    for (const [name, service] of Object.entries(compose.services)) {
      if (name === 'verity') continue;
      expect(service.volumes?.some((volume) => /verity-egress/u.test(volume))).not.toBe(true);
    }
  });

  it('keeps the legacy overlay usable without manual variables or duplicate mounts', async () => {
    const overlay = parse(await readFile('deploy/docker-compose.egress.yml', 'utf8')) as unknown;
    expect(overlay).toEqual({ services: {} });
  });
});
