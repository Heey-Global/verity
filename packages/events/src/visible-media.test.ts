import { describe, expect, it } from 'vitest';
import { VISIBLE_MEDIA_SYSTEM_PROMPT } from './visible-media.js';

describe('VISIBLE_MEDIA_SYSTEM_PROMPT', () => {
  it('requires visual variants to include renderable image links', () => {
    expect(VISIBLE_MEDIA_SYSTEM_PROMPT).toContain('Markdown image link');
    expect(VISIBLE_MEDIA_SYSTEM_PROMPT).toContain('![Option label]');
    expect(VISIBLE_MEDIA_SYSTEM_PROMPT).toMatch(/actual workspace file/i);
  });

  it('forbids claiming images are visible without emitted media', () => {
    expect(VISIBLE_MEDIA_SYSTEM_PROMPT).toMatch(/Do not claim/i);
    expect(VISIBLE_MEDIA_SYSTEM_PROMPT).toMatch(/attached, visible, sent, or shown/i);
    expect(VISIBLE_MEDIA_SYSTEM_PROMPT).toMatch(/actual image attachments\/tool images/i);
  });
});
