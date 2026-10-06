import { describe, expect, it } from 'vitest';
import { buildVisibleMediaRepairEvent } from './visible-media-repair.js';

describe('buildVisibleMediaRepairEvent', () => {
  it('does not duplicate Markdown images split across streamed text deltas', () => {
    expect(
      buildVisibleMediaRepairEvent('Show images', [
        { t: 'text', delta: 'Here are the visible ' },
        { t: 'text', delta: 'images.\n![Example](assets/' },
        { t: 'text', delta: 'example.png)' },
        { t: 'tool_result', id: 'tool-1', isError: false, output: 'assets/example.png' },
      ]),
    ).toBeUndefined();
  });

  it('detects image claims split across streamed text deltas', () => {
    expect(
      buildVisibleMediaRepairEvent('Show images', [
        { t: 'text', delta: 'Here are the visible ' },
        { t: 'text', delta: 'images.' },
        { t: 'tool_result', id: 'tool-1', isError: false, output: 'assets/example.png' },
      ])?.delta,
    ).toContain('![Bild 1](assets/example.png)');
  });

  it.each([
    [
      'Move the session status icons',
      'Die Icons bleiben sichtbar. Sichtbar wird das erst mit dem nächsten App-Release.',
    ],
    ['Zeig mir Varianten', 'Ich verlinke den PR. Die Änderungen sind sichtbar.'],
    ['Update the icons', 'The status icons are shown next to the model name.'],
    ['Zeig Bilder', 'Die Bilder werden später erstellt. Der PR ist sichtbar.'],
  ])('does not mistake UI visibility for delivered images: %s', (prompt, delta) => {
    expect(
      buildVisibleMediaRepairEvent(prompt, [
        { t: 'text', delta },
        { t: 'tool_result', id: 'tool-1', isError: false, output: 'assets/example.png' },
      ]),
    ).toBeUndefined();
  });

  it('builds visible markdown images from image paths found in tool output', () => {
    const event = buildVisibleMediaRepairEvent('Ich konnte die Bilder nicht sehen', [
      { t: 'text', delta: 'Ich verlinke die Varianten direkt als sichtbare Markdown-Bilder.' },
      {
        t: 'tool_result',
        id: 'tool-1',
        isError: false,
        output:
          '1784105139.1174473170 assets/icon-proposal-3-config-prism.png\n' +
          '1784105139.1157373840 assets/icon-proposal-2-encrypted-wave.png\n',
      },
    ]);

    expect(event?.delta).toContain('![Bild 1](assets/icon-proposal-3-config-prism.png)');
    expect(event?.delta).toContain('![Bild 2](assets/icon-proposal-2-encrypted-wave.png)');
  });

  it('does not repair a response that already includes markdown images', () => {
    const event = buildVisibleMediaRepairEvent('Zeig Bilder', [
      { t: 'text', delta: '![Option](assets/icon.png)' },
    ]);

    expect(event).toBeUndefined();
  });

  it('does not repair unrelated turns', () => {
    const event = buildVisibleMediaRepairEvent('Bitte fasse das zusammen', [
      { t: 'text', delta: 'Ich verlinke die Datei.' },
      { t: 'tool_result', id: 'tool-1', isError: false, output: 'assets/icon.png' },
    ]);

    expect(event).toBeUndefined();
  });

  it('stays silent when media was promised but no image path exists', () => {
    const event = buildVisibleMediaRepairEvent('Zeig mir die Icons', [
      { t: 'text', delta: 'Ich sende die Bilder direkt als Bildanhänge.' },
    ]);

    expect(event).toBeUndefined();
  });

  it.each([
    'Here are the visible images.',
    'The images are attached.',
    'The images are now attached.',
    'Die Bilder sind jetzt sichtbar.',
    'I have attached the images.',
    'Ich zeige die Bilder direkt.',
    'Ich zeige das Bild direkt.',
    'Die Bilder sind sichtbar.',
    'Das Bild ist sichtbar.',
    'Hier ist das sichtbare Bild.',
    'Hier ist das sichtbare Markdown-Bild.',
  ])('still detects explicit image claims: %s', (delta) => {
    expect(
      buildVisibleMediaRepairEvent('Show images', [
        { t: 'text', delta },
        { t: 'tool_result', id: 'tool-1', isError: false, output: 'assets/example.png' },
      ])?.delta,
    ).toContain('![Bild 1](assets/example.png)');
  });
});
