import { describe, expect, it } from 'vitest';
import { actionTitle } from './action-title.js';
describe('action titles', () => {
  it('separates routing identifiers from readable titles', () => {
    expect(actionTitle('verity_knowledge_record_decision')).toBe(
      'Verity · Knowledge · Record Decision',
    );
    expect(actionTitle('create_pull_request', undefined, 'GitHub')).toBe(
      'GitHub · Create Pull Request',
    );
    expect(actionTitle('opaque', 'GitHub · Pull Request · Create')).toBe(
      'GitHub · Pull Request · Create',
    );
  });
  it('does not resolve inherited object properties as acronyms', () => {
    expect(actionTitle('constructor')).toBe('Constructor');
    expect(actionTitle('verity_tasks_constructor')).toBe('Verity · Tasks · Constructor');
  });
  it('removes directional and control characters from untrusted titles', () => {
    expect(actionTitle('read', '\u202eFake\u0000 Title')).toBe('Fake Title');
    expect(actionTitle('read', '  ', 'GitHub')).toBe('GitHub · Read');
    expect(actionTitle('read', 'Pull_Request')).toBe('Pull Request');
    expect(actionTitle('read', '___', 'GitHub')).toBe('GitHub · Read');
  });
});
