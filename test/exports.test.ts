import { describe, expect, it } from 'vitest';

import { HeadLookupTimeoutError, UnreadableGatewayError, UnreadableSlotError } from '../src';

describe('the package root', () => {
  it('exports the errors the ERROR event carries, so a viewer can tell them apart', () => {
    expect(new HeadLookupTimeoutError({ cause: null })).toBeInstanceOf(Error);
    expect(new UnreadableGatewayError(3).index).toBe(3);
    expect(new UnreadableSlotError(4, { cause: null }).index).toBe(4);
  });
});
