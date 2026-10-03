import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from './canonical-json.js';
import { hashPayload } from './hash-payload.js';

describe('canonical JSON payload hashing', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(
      canonicalizeJson({
        z: 1,
        nested: { b: true, a: 'value' },
        list: [2, 1],
      }),
    ).toBe('{"list":[2,1],"nested":{"a":"value","b":true},"z":1}');
  });

  it('produces the same SHA-256 hash regardless of object key order', () => {
    expect(hashPayload({ providerId: 'provider-a', amount: '25.00' })).toBe(
      hashPayload({ amount: '25.00', providerId: 'provider-a' }),
    );
  });
});
