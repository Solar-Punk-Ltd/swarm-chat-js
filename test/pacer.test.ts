import { describe, expect, it } from 'vitest';

import { MissingReadPacer } from '../src/pacer.js';

describe('MissingReadPacer', () => {
  it('holds a missed slot back for the spacing, then lets it be read', () => {
    let now = 1_000;
    const pacer = new MissingReadPacer(20_000, () => now);
    pacer.missed(5);
    expect(pacer.mayRead(5)).toBe(false);
    now += 19_999;
    expect(pacer.mayRead(5)).toBe(false);
    now += 1;
    expect(pacer.mayRead(5)).toBe(true);
  });

  it('lets a slot be read at once after the clock is set back past its miss', () => {
    let now = 3_600_000;
    const pacer = new MissingReadPacer(20_000, () => now);
    pacer.missed(5);
    now = 0;
    expect(pacer.mayRead(5)).toBe(true);
    expect(pacer.readableAt(5)).toBeLessThanOrEqual(now);
  });

  it('forgets a miss the clock was set back past when another slot misses', () => {
    let now = 3_600_000;
    const pacer = new MissingReadPacer(20_000, () => now);
    pacer.missed(5);
    now = 0;
    pacer.missed(6);
    expect(pacer.mayRead(5)).toBe(true);
    expect(pacer.mayRead(6)).toBe(false);
  });
});
