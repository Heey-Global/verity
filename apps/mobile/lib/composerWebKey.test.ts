import { shouldSendWebKey } from './composerWebKey';

it('sends on plain Enter', () => {
  expect(shouldSendWebKey({ key: 'Enter' })).toBe(true);
});
it.each(['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'isComposing'])(
  'preserves input with %s',
  (modifier) => {
    expect(shouldSendWebKey({ key: 'Enter', [modifier]: true })).toBe(false);
  },
);
it('preserves IME confirmation and other keys', () => {
  expect(shouldSendWebKey({ key: 'Enter', keyCode: 229 })).toBe(false);
  expect(shouldSendWebKey({ key: 'a' })).toBe(false);
});
