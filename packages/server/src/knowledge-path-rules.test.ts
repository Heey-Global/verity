import { describe, expect, it } from 'vitest';

import { EXTRACTED_TEXT_DIR } from './knowledge-folder.js';
import {
  knowledgeChild,
  knowledgeContainer,
  knowledgeEntry,
  knowledgeMoveTarget,
  KnowledgePathRefusedError,
  SOURCE_IMPORT_FOLDERS,
} from './knowledge-path-rules.js';
import { FILE_HISTORY_DIR } from './session-file-history.js';

const refused = (check: () => unknown) => expect(check).toThrow(KnowledgePathRefusedError);

describe('knowledge path rules', () => {
  it('addresses ordinary entries by area and remainder', () => {
    expect(knowledgeEntry('insights/topic/page.md')).toEqual({
      area: 'insights',
      rel: 'topic/page.md',
      path: 'insights/topic/page.md',
    });
    expect(knowledgeEntry('sources\\notes\\call.md')).toMatchObject({
      area: 'sources',
      path: 'sources/notes/call.md',
    });
    expect(knowledgeContainer('insights')).toEqual({ area: 'insights', rel: '', path: 'insights' });
  });

  it('refuses everything outside the two areas and every unplain segment', () => {
    for (const path of [
      '',
      'overview.md',
      'shared/insights/page.md',
      'AGENTS.md',
      'insights/',
      'insights//page.md',
      'insights/./page.md',
      'insights/../sources/a.md',
      'sources\\..\\insights\\page.md',
      'insights/:id/page.md',
      `insights/topic/${EXTRACTED_TEXT_DIR}/page.md`,
      `${EXTRACTED_TEXT_DIR}/insights/page.md`,
      `sources/${FILE_HISTORY_DIR}/old.md`,
    ]) {
      refused(() => knowledgeEntry(path));
      refused(() => knowledgeContainer(path));
    }
  });

  it('keeps recorded decisions out of every change', () => {
    for (const path of ['insights/decisions', 'insights/decisions/record.md'])
      for (const check of [knowledgeEntry, knowledgeContainer]) refused(() => check(path));
    // A folder of that name elsewhere is ordinary.
    expect(knowledgeEntry('insights/topic/decisions').rel).toBe('topic/decisions');
    refused(() => knowledgeChild(knowledgeContainer('insights'), 'decisions'));
  });

  it('keeps library roots and Sources import folders in place, but not what they hold', () => {
    refused(() => knowledgeEntry('insights'));
    refused(() => knowledgeEntry('sources'));
    expect(SOURCE_IMPORT_FOLDERS.size).toBeGreaterThan(0);
    for (const folder of SOURCE_IMPORT_FOLDERS) {
      refused(() => knowledgeEntry(`sources/${folder}`));
      expect(knowledgeContainer(`sources/${folder}`).rel).toBe(folder);
      expect(knowledgeEntry(`sources/${folder}/file.pdf`).rel).toBe(`${folder}/file.pdf`);
      // Only Sources reserve them; a Wiki folder may carry the same name.
      expect(knowledgeEntry(`insights/${folder}`).rel).toBe(folder);
    }
  });

  it('checks a new name as the entry it creates', () => {
    const wiki = knowledgeContainer('insights');
    expect(knowledgeChild(wiki, 'page.md').path).toBe('insights/page.md');
    refused(() => knowledgeChild(wiki, ':new'));
    refused(() => knowledgeChild(wiki, EXTRACTED_TEXT_DIR));
  });

  it('moves within one area and never into the moved folder itself', () => {
    const page = knowledgeEntry('insights/topic/page.md');
    expect(knowledgeMoveTarget(page, 'insights').path).toBe('insights/page.md');
    expect(knowledgeMoveTarget(page, 'insights/other').path).toBe('insights/other/page.md');
    refused(() => knowledgeMoveTarget(page, 'sources'));
    refused(() => knowledgeMoveTarget(page, 'insights/decisions'));
    const folder = knowledgeEntry('insights/topic');
    refused(() => knowledgeMoveTarget(folder, 'insights/topic'));
    refused(() => knowledgeMoveTarget(folder, 'insights/topic/sub'));
    expect(knowledgeMoveTarget(folder, 'insights/topical').path).toBe('insights/topical/topic');
  });
});
