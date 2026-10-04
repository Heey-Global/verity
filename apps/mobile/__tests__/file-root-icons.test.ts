import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Project and Global Knowledge must look the same wherever they appear (Explorer
// tabs, breadcrumb, the message "…" sheet). A literal icon name added next to the
// FILE_ROOT_ICON map would let one spot drift to a different symbol while every
// screen still renders fine — so the session screen may name these icons only there.
const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
const map = /const FILE_ROOT_ICON[^=]*=\s*\{([^}]*)\}/.exec(source);

describe('file root icons', () => {
  it('declares one icon per file root', () => {
    expect(map).not.toBeNull();
    expect(map?.[1]).toMatch(/knowledge:\s*'[\w-]+'/);
    expect(map?.[1]).toMatch(/shared:\s*'[\w-]+'/);
  });

  it.each(['knowledge', 'shared'])('uses the %s icon only through FILE_ROOT_ICON', (root) => {
    const icon = new RegExp(`${root}:\\s*'([\\w-]+)'`).exec(map?.[1] ?? '')?.[1];
    expect(icon).toBeDefined();
    const literals = source.match(new RegExp(`'${String(icon)}'`, 'g')) ?? [];
    expect(literals).toHaveLength(1);
  });
});
