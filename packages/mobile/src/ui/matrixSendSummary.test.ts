import { expect, it } from 'vitest';
import { matrixSendSummary } from './matrixSendSummary.js';
import { secretGrantScopes } from './secretGrantScopes.js';
const snapshot = {
  action: 'send',
  accountId: '@verity:example.test',
  endpoint: 'https://example.test',
  roomId: '!room:example.test',
  roomName: 'Same name',
  bindingVersion: 3,
  body: 'First\nSecond\u202e',
};
it('retains the stable destination and complete text for approval, and never offers reusable scopes', () => {
  const summary = matrixSendSummary(snapshot);
  expect(summary).toMatchObject({
    roomId: snapshot.roomId,
    body: snapshot.body,
    accountId: snapshot.accountId,
    bindingVersion: 3,
  });
  expect(secretGrantScopes('verity_matrix', snapshot)).toEqual([]);
  expect(matrixSendSummary({ ...snapshot, action: 'prepare_send' })).toBeNull();
  expect(matrixSendSummary({ ...snapshot, roomId: undefined })).toBeNull();
});
