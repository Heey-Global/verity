import type { ProjectRecord } from '@verity/mobile';

import { mergeProjectStatusMutation } from './projectStatusMutation';

describe('project status mutations', () => {
  it('cannot reopen a project with a stale full-record snapshot', () => {
    const current = { id: 'project-1', collapsed: true } as ProjectRecord;
    const staleStatus = { id: 'project-1', collapsed: false, state: 'active' } as ProjectRecord;

    expect(mergeProjectStatusMutation(current, staleStatus)).toMatchObject({
      collapsed: true,
      state: 'active',
    });
  });

  it('keeps the dismissed Home items a status record does not carry', () => {
    // Detail and status responses omit the field; adopting that absence would
    // read as "this server cannot dismiss" and drop the X from Home's cards.
    const current = { id: 'project-1', inboxDismissed: ['health:project-1:x'] } as ProjectRecord;
    const status = { id: 'project-1', state: 'active' } as ProjectRecord;
    expect(mergeProjectStatusMutation(current, status).inboxDismissed).toEqual([
      'health:project-1:x',
    ]);
  });
});
