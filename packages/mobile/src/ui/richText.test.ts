import { describe, expect, it } from 'vitest';
import {
  isSessionImageFilePath,
  markdownSectionTitle,
  parseInline,
  sessionFilePathFromLocalLink,
  splitRichText,
} from './richText.js';

describe('splitRichText', () => {
  it('returns a single text block for plain prose', () => {
    expect(splitRichText('hello world')).toEqual([{ type: 'text', content: 'hello world' }]);
  });

  it('splits a fenced code block out of surrounding prose, capturing the language', () => {
    const input = 'before\n```ts\nconst x = 1;\n```\nafter';
    expect(splitRichText(input)).toEqual([
      { type: 'text', content: 'before' },
      { type: 'code', lang: 'ts', content: 'const x = 1;' },
      { type: 'text', content: 'after' },
    ]);
  });

  it('treats a fence with no language tag as lang null', () => {
    expect(splitRichText('```\nplain\n```')).toEqual([
      { type: 'code', lang: null, content: 'plain' },
    ]);
  });

  it('drops the empty text segments a fence leaves behind', () => {
    // The newlines around the fence must not yield empty text bubbles.
    const blocks = splitRichText('```js\na\n```');
    expect(blocks).toEqual([{ type: 'code', lang: 'js', content: 'a' }]);
  });

  it('preserves interior blank lines and indentation inside code', () => {
    const input = '```py\ndef f():\n\n    return 1\n```';
    expect(splitRichText(input)).toEqual([
      { type: 'code', lang: 'py', content: 'def f():\n\n    return 1' },
    ]);
  });

  it('renders an unterminated opening fence as code (live mid-stream block)', () => {
    expect(splitRichText('intro\n```ts\nconst y =')).toEqual([
      { type: 'text', content: 'intro' },
      { type: 'code', lang: 'ts', content: 'const y =' },
    ]);
  });

  it('handles multiple code blocks interleaved with prose', () => {
    const input = 'a\n```\none\n```\nb\n```\ntwo\n```';
    expect(splitRichText(input).map((b) => b.type)).toEqual(['text', 'code', 'text', 'code']);
  });

  it('returns no blocks for an empty or whitespace-only string', () => {
    expect(splitRichText('')).toEqual([]);
    expect(splitRichText('\n\n')).toEqual([]);
  });

  it('keeps a fence-like line with a trailing tag as code content (no bare close)', () => {
    // Only a bare ``` closes; a ```tail line must not silently drop `tail`.
    expect(splitRichText('```\ncode\n```tail')).toEqual([
      { type: 'code', lang: null, content: 'code\n```tail' },
    ]);
  });

  it('does not treat a run of more than three backticks as a fence', () => {
    // ````ts is not a 3-backtick fence; the extra backtick must not leak into a lang tag.
    expect(splitRichText('````ts')).toEqual([{ type: 'text', content: '````ts' }]);
  });

  it('does not recognize an indented fence (anchored to column 0) — renders as prose', () => {
    // Documents the v1 choice: indented fences are prose, so adding indentation
    // support later is a deliberate, test-visible change.
    expect(splitRichText('  ```ts\n  code\n  ```')).toEqual([
      { type: 'text', content: '  ```ts\n  code\n  ```' },
    ]);
  });
});

describe('parseInline', () => {
  it('returns a single plain span for text with no markers', () => {
    expect(parseInline('hello world')).toEqual([{ t: 'plain', text: 'hello world' }]);
  });

  it('splits out bold and inline code, keeping surrounding plain text', () => {
    expect(parseInline('use **bold** and `code` here')).toEqual([
      { t: 'plain', text: 'use ' },
      { t: 'bold', text: 'bold' },
      { t: 'plain', text: ' and ' },
      { t: 'code', text: 'code' },
      { t: 'plain', text: ' here' },
    ]);
  });

  it('leaves an unbalanced marker as literal text', () => {
    expect(parseInline('a ** b')).toEqual([{ t: 'plain', text: 'a ** b' }]);
  });

  it('handles a leading bold span', () => {
    expect(parseInline('**Done** — ok')).toEqual([
      { t: 'bold', text: 'Done' },
      { t: 'plain', text: ' — ok' },
    ]);
  });

  it('recognizes a markdown [label](url) link', () => {
    expect(parseInline('see [the PR](https://github.com/x/y/pull/1) now')).toEqual([
      { t: 'plain', text: 'see ' },
      { t: 'link', text: 'the PR', url: 'https://github.com/x/y/pull/1', external: true },
      { t: 'plain', text: ' now' },
    ]);
  });

  it('recognizes a local markdown file reference without exposing the target as text', () => {
    expect(parseInline('changed [server.ts](/work/packages/server/src/server.ts:44)')).toEqual([
      { t: 'plain', text: 'changed ' },
      {
        t: 'link',
        text: 'server.ts',
        url: '/work/packages/server/src/server.ts:44',
        external: false,
      },
    ]);
  });

  it('recognizes a bare URL and keeps trailing punctuation as plain text', () => {
    expect(parseInline('open https://verity.dev/docs.')).toEqual([
      { t: 'plain', text: 'open ' },
      {
        t: 'link',
        text: 'https://verity.dev/docs',
        url: 'https://verity.dev/docs',
        external: true,
      },
      { t: 'plain', text: '.' },
    ]);
  });

  it('does not linkify a URL inside inline code', () => {
    expect(parseInline('run `curl https://x.com`')).toEqual([
      { t: 'plain', text: 'run ' },
      { t: 'code', text: 'curl https://x.com' },
    ]);
  });
});

describe('sessionFilePathFromLocalLink', () => {
  it('normalizes safe session file links and strips anchors or line suffixes', () => {
    expect(sessionFilePathFromLocalLink('docs/meetings/planning.md')).toBe(
      'docs/meetings/planning.md',
    );
    expect(sessionFilePathFromLocalLink('./docs/meetings/planning.md:12')).toBe(
      'docs/meetings/planning.md',
    );
    expect(sessionFilePathFromLocalLink('docs/meetings/planning.md:12:3#section')).toBe(
      'docs/meetings/planning.md',
    );
    expect(
      sessionFilePathFromLocalLink('/work/.verity-sessions/agent-abc123/assets/icon.png'),
    ).toBe('assets/icon.png');
    expect(
      sessionFilePathFromLocalLink('file:///work/.verity-sessions/agent-abc123/assets/icon.png:1'),
    ).toBe('assets/icon.png');
  });

  it('rejects non-session local links', () => {
    expect(sessionFilePathFromLocalLink('/work/docs/meetings/planning.md')).toBeNull();
    expect(sessionFilePathFromLocalLink('file:///work/docs/meetings/planning.md')).toBeNull();
    expect(sessionFilePathFromLocalLink('/etc/passwd')).toBeNull();
    expect(sessionFilePathFromLocalLink('docs/../secret.txt')).toBeNull();
    expect(sessionFilePathFromLocalLink('docs/.git/config')).toBeNull();
    expect(sessionFilePathFromLocalLink('#heading')).toBeNull();
  });
});

describe('isSessionImageFilePath', () => {
  it('recognizes previewable image files by extension', () => {
    expect(isSessionImageFilePath('assets/icon.png')).toBe(true);
    expect(isSessionImageFilePath('assets/mockup.JPG')).toBe(true);
    expect(isSessionImageFilePath('assets/wave.webp')).toBe(true);
    expect(isSessionImageFilePath('assets/anim.gif')).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isSessionImageFilePath('assets/icon.svg')).toBe(false);
    expect(isSessionImageFilePath('README.md')).toBe(false);
  });
});

describe('markdownSectionTitle', () => {
  it('recognizes colon-terminated prose section labels', () => {
    expect(markdownSectionTitle('Änderung:')).toBe('Änderung');
    expect(markdownSectionTitle('Verification:')).toBe('Verification');
  });

  it('recognizes standalone bold section labels', () => {
    expect(markdownSectionTitle('**Summary**')).toBe('Summary');
    expect(markdownSectionTitle('**Checks:**')).toBe('Checks');
  });

  it('does not promote ordinary prose', () => {
    expect(markdownSectionTitle('This is just a sentence: with detail')).toBeNull();
    expect(markdownSectionTitle('lowercase:')).toBeNull();
  });
});
