import { describe, expect, it } from 'vitest';
import { ObservedSet } from './observed-set.js';

describe('ObservedSet', () => {
  // Its writers treat it as a plain Set; a change that reached no observer
  // leaves whatever follows the set showing the old state.
  it('tells its observers each value that entered or left, and only those', () => {
    const set = new ObservedSet<string>();
    const seen: string[] = [];
    const stop = set.observe((value) => seen.push(value));
    set.add('a');
    set.add('a');
    set.delete('b');
    set.add('b');
    set.delete('a');
    set.clear();
    expect(seen).toEqual(['a', 'b', 'a', 'b']);
    expect([...set]).toEqual([]);
    stop();
    set.add('c');
    expect(seen).toHaveLength(4);
  });

  it('keeps changing when an observer fails, and takes initial values', () => {
    const set = new ObservedSet(['x']);
    const seen: string[] = [];
    set.observe(() => {
      throw new Error('observer failed');
    });
    set.observe((value) => seen.push(value));
    expect(set.has('x')).toBe(true);
    set.add('y');
    expect(set.has('y')).toBe(true);
    expect(seen).toEqual(['y']);
  });
});
