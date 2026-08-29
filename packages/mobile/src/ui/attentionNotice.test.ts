import { describe, expect, it } from 'vitest';

import {
  attentionAction,
  attentionActionLabel,
  attentionNotice,
  attentionNoticeText,
} from './attentionNotice.js';

describe('attentionNotice', () => {
  it('says nothing when the server sent nothing', () => {
    expect(attentionNotice(undefined)).toBeNull();
    expect(attentionNotice([])).toBeNull();
  });

  it('surfaces the first signal, verbatim', () => {
    expect(
      attentionNotice([{ code: 'secret_sealed', message: 'Server is sealed — unlock it' }]),
    ).toEqual({ code: 'secret_sealed', message: 'Server is sealed — unlock it', count: 1 });
  });

  it('counts the rest without rendering them', () => {
    const notice = attentionNotice([
      { code: 'secret_sealed', message: 'Server is sealed' },
      { code: 'updater_unhealthy', message: 'Updater is not answering' },
    ]);
    expect(notice).toEqual({ code: 'secret_sealed', message: 'Server is sealed', count: 2 });
    expect(attentionNoticeText(notice!)).toBe('Server is sealed (+1 more)');
  });

  it('renders a lone signal without a tail', () => {
    expect(attentionNoticeText({ code: 'x', message: 'Something is wrong', count: 1 })).toBe(
      'Something is wrong',
    );
  });

  // A server newer than this app may send a code this build has never heard of.
  // The banner keys on it and prints the message; it must not need to know it.
  it('renders an unknown code as long as it carries a message', () => {
    const notice = attentionNotice([{ code: 'future_condition', message: 'Something new' }]);
    expect(attentionNoticeText(notice!)).toBe('Something new');
  });

  it('carries the remedy the shown signal offers', () => {
    expect(
      attentionNotice([
        {
          code: 'usage_probe_unhealthy',
          message: 'Codex sign-in was refused',
          action: 'codex-login',
        },
      ]),
    ).toEqual({
      code: 'usage_probe_unhealthy',
      message: 'Codex sign-in was refused',
      count: 1,
      action: 'codex-login',
    });
    expect(attentionActionLabel('codex-login')).toBe('Sign in to Codex');
  });

  // The banner renders one line and one button, and they have to be about the same
  // thing: a "Sign in to Codex" tap under the sealed-server sentence acts on a
  // condition nobody is reading.
  it('does not borrow a remedy from a signal it is not showing', () => {
    const notice = attentionNotice([
      { code: 'secret_sealed', message: 'Server is sealed' },
      {
        code: 'usage_probe_unhealthy',
        message: 'Codex sign-in was refused',
        action: 'codex-login',
      },
    ]);
    expect(notice?.action).toBeUndefined();
  });

  // Same contract as an unknown `code`, one step stricter: an action this build
  // cannot open must cost the button and nothing else — never a dead tap, and
  // never the sentence, which stands on its own.
  it('drops an action it does not know how to open', () => {
    const notice = attentionNotice([
      { code: 'future_condition', message: 'Something new', action: 'rotate-quantum-key' },
    ]);
    expect(notice?.action).toBeUndefined();
    expect(attentionNoticeText(notice!)).toBe('Something new');
    expect(attentionAction('rotate-quantum-key')).toBeNull();
    expect(attentionAction(undefined)).toBeNull();
    // Not a property of Object.prototype either: `'toString' in KNOWN_ACTIONS`
    // would be true on a plain object literal and would hand back a bogus action.
    expect(attentionAction('toString')).toBeNull();
  });
});
