import { describe, expect, it } from 'vitest';
import { StderrTail } from './stderr-tail.js';

describe('StderrTail', () => {
  it('retains the newest bytes across wraparound and oversized chunks', () => {
    const tail = new StderrTail(8);
    let output = '';
    for (const chunk of ['abc', 'def', 'ghij', '0123456789', 'xy']) {
      output += chunk;
      tail.push(Buffer.from(chunk));
      expect(tail.text()).toBe(output.slice(-8));
    }
  });

  it('caps UTF-8 bytes and reassembles split characters', () => {
    const tail = new StderrTail(7);
    const bytes = Buffer.from('a😀😀');
    tail.push(bytes.subarray(0, 4));
    tail.push(bytes.subarray(4));
    expect(tail.text()).toBe('😀');
    expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(7);
  });

  it('keeps exactly the default capacity and can reset diagnostics', () => {
    const tail = new StderrTail();
    tail.push('x'.repeat(70 * 1024));
    expect(Buffer.byteLength(tail.text())).toBe(64 * 1024);
    tail.clear();
    tail.push('fresh');
    expect(tail.text()).toBe('fresh');
  });
});
