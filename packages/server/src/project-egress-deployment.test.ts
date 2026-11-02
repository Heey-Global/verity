import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('network protection deployment', () => {
  it('preserves the bind-mounted socket directory across host-service restarts', async () => {
    const unit = await readFile('deploy/egress/verity-egress-host.service', 'utf8');
    expect(unit).toMatch(/^RuntimeDirectory=verity-egress$/m);
    expect(unit).toMatch(/^RuntimeDirectoryPreserve=yes$/m);
  });

  it('keeps the base stack free of the host egress service', async () => {
    const compose = await readFile('deploy/docker-compose.yml', 'utf8');
    expect(compose).not.toContain('VERITY_PROJECT_EGRESS_SOCKET');
    expect(compose).not.toContain('/run/verity-egress');
  });

  it('mounts only the control socket and key in the optional overlay', async () => {
    const overlay = parse(await readFile('deploy/docker-compose.egress.yml', 'utf8')) as {
      services: Record<
        string,
        { environment: Record<string, string>; volumes: string[]; group_add: string[] }
      >;
    };
    expect(Object.keys(overlay.services)).toEqual(['verity']);
    const verity = overlay.services.verity!;
    expect(verity.environment).toEqual({
      VERITY_PROJECT_EGRESS_SOCKET: '/run/verity-egress/control.sock',
      VERITY_PROJECT_EGRESS_KEY_PATH: '/run/verity-egress-key/control.key',
    });
    expect(verity.volumes).toEqual([
      '/run/verity-egress:/run/verity-egress',
      '/etc/verity-egress/control.key:/run/verity-egress-key/control.key:ro',
    ]);
    // The group must be explicit: an unset id would silently drop the Server's access.
    expect(verity.group_add).toEqual([
      '${VERITY_EGRESS_CONTROL_GID:?set to the verity-egress-control group id}',
    ]);
  });
});
