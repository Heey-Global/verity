import { safeReturnTo } from './safeReturnTo';

describe('safeReturnTo', () => {
  it('accepts app-internal paths including query strings', () => {
    expect(safeReturnTo('/session/s1?focus=latest', null)).toBe('/session/s1?focus=latest');
  });

  it.each(['https://evil.test', '//evil.test/path', '/\\evil', '/ok\nnext'])(
    'rejects unsafe return target %s',
    (target) => expect(safeReturnTo(target, '/')).toBe('/'),
  );

  it.each(['/session%2f..%2fsettings', '/session%5c..%5csettings', '/session%252f..%252fsettings'])(
    'rejects encoded path separators in %s',
    (target) => expect(safeReturnTo(target, '/')).toBe('/'),
  );
});
