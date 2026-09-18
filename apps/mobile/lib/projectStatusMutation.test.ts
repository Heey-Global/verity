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
});
