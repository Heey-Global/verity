import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { shouldContinueUserJump } from '../lib/scrollPosition';

const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
const start = source.indexOf('    if (pendingJumpId === null) return;');
const end = source.indexOf('\n  }, [', start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const continueJump = new Function(
  'props',
  'shouldContinueUserJump',
  `const { pendingJumpId, rowIndexOfMessage, loadingOlder, hasOlder,
    olderLoadStalled, oldestHistorySeq, bookmarkCursorRef, setPendingJumpId,
    pendingJumpQueryRef, pageTowardMessage, data, jumpRowsRef } = props;
  ${compiled}`,
);
function fixture() {
  return {
    pendingJumpId: 'message-42',
    rowIndexOfMessage: () => -1,
    loadingOlder: false,
    hasOlder: true,
    olderLoadStalled: false,
    oldestHistorySeq: 400,
    bookmarkCursorRef: { current: undefined as number | undefined },
    setPendingJumpId: jest.fn(),
    pendingJumpQueryRef: { current: null },
    pageTowardMessage: jest.fn(),
    data: [{}],
    jumpRowsRef: { current: -1 },
  };
}
it('continues a bookmark jump across pages that add no rendered rows', () => {
  const state = fixture();
  // Metadata-only pages and coalesced deltas can leave the row count unchanged.
  for (const cursor of [400, 250, 100]) {
    state.oldestHistorySeq = cursor;
    continueJump(state, shouldContinueUserJump);
  }
  expect(state.pageTowardMessage).toHaveBeenCalledTimes(3);
  expect(state.pageTowardMessage).toHaveBeenLastCalledWith('message-42');
  expect(state.setPendingJumpId).not.toHaveBeenCalled();
});
it.each(['unchanged cursor', 'failed page', 'history exhausted', 'in flight'])(
  'does not request another page after %s',
  (reason) => {
    const state = fixture();
    continueJump(state, shouldContinueUserJump);
    if (reason !== 'unchanged cursor') state.oldestHistorySeq = 250;
    if (reason === 'failed page') state.olderLoadStalled = true;
    if (reason === 'history exhausted') state.hasOlder = false;
    if (reason === 'in flight') state.loadingOlder = true;
    continueJump(state, shouldContinueUserJump);
    expect(state.pageTowardMessage).toHaveBeenCalledTimes(1);
  },
);
