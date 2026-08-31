import { describe, expect, it } from 'vitest';
import { buildVisibleMediaRepairEvent } from './visible-media-repair.js';

describe('buildVisibleMediaRepairEvent', () => {
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

  it('emits a clear notice when media was promised but no image path exists', () => {
    const event = buildVisibleMediaRepairEvent('Zeig mir die Icons', [
      { t: 'text', delta: 'Ich sende die Bilder direkt als Bildanhänge.' },
    ]);

    expect(event?.delta).toMatch(/keine Bildlinks oder Bildanhänge/i);
  });
});
