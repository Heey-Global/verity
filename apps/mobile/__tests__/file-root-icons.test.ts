import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Knowledge must look the same wherever it appears — Project and Global alike, in
// the Explorer tabs, its breadcrumb and the message "…" sheet. A literal icon name
// dropped in anywhere else would let one spot drift to a different symbol while
// every screen still renders fine, so the session screen names the icon once.
const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
const icon = /const KNOWLEDGE_ICON: IconName = '([\w-]+)'/.exec(source)?.[1];
const rootMap = /const FILE_ROOT_ICON[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';

describe('knowledge icon', () => {
  it('is named exactly once in the session screen', () => {
    expect(icon).toBeDefined();
    expect(source.match(new RegExp(`'${String(icon)}'`, 'g'))).toHaveLength(1);
  });

  it.each(['knowledge', 'shared'])('is the icon of the %s file root', (root) => {
    expect(rootMap).toMatch(new RegExp(`${root}:\\s*KNOWLEDGE_ICON\\b`));
  });
});
