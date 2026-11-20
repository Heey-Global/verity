import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KNOWLEDGE_ICON } from '../components/files/knowledgeIcon';

// Knowledge must look the same wherever it appears — Project and Global alike, in
// the Explorer tabs, its breadcrumb and the message "…" sheet. A literal icon name
// dropped in anywhere else would let one spot drift to a different symbol while
// every screen still renders fine, so the icon is named once and imported.
const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
const session = read('app/session/[id].tsx');
const sheet = read('components/files/session/SessionFilesSheet.tsx');
const rootMap = /const FILE_ROOT_ICON[^=]*=\s*\{([^}]*)\}/.exec(sheet)?.[1] ?? '';

describe('knowledge icon', () => {
  it('is never spelled out where Files or the session use it', () => {
    for (const source of [session, sheet]) {
      expect(source).toContain('KNOWLEDGE_ICON');
      expect(source).not.toContain(`'${KNOWLEDGE_ICON}'`);
    }
  });

  it.each(['knowledge', 'shared'])('is the icon of the %s file root', (root) => {
    expect(rootMap).toMatch(new RegExp(`${root}:\\s*KNOWLEDGE_ICON\\b`));
  });
});
