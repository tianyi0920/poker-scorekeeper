import { describe, expect, it } from 'vitest';
import {
  buyHandsSchema,
  canonicalPublicIdSchema,
  idempotencyKeySchema
} from './buyins.js';

describe('buy-in request contracts', () => {
  it.each(['a', 'request-123', 'request-123/a', 'key.with_symbols:1_2']) (
    'accepts canonical idempotency key %s',
    (value) => expect(idempotencyKeySchema.safeParse(value).success).toBe(true)
  );

  it.each(['ABC', 'key ', ' key', 'two keys', '\tkey', '中文', '']) (
    'rejects non-canonical idempotency key %j',
    (value) => expect(idempotencyKeySchema.safeParse(value).success).toBe(false)
  );

  it('keeps the idempotency key column length limit in the HTTP contract', () => {
    expect(buyHandsSchema.safeParse({ hands: 1, idempotencyKey: 'a'.repeat(128) }).success)
      .toBe(true);
    expect(buyHandsSchema.safeParse({ hands: 1, idempotencyKey: 'a'.repeat(129) }).success)
      .toBe(false);
  });

  it.each(['clyabc123def456', 'missing-clyabc123']) (
    'accepts canonical public id %s',
    (value) => expect(canonicalPublicIdSchema.safeParse(value).success).toBe(true)
  );

  it.each(['CLYABC123DEF456', 'clyabc123 ', 'cly_abc', '', 'a'.repeat(31)]) (
    'rejects non-canonical public id %j',
    (value) => expect(canonicalPublicIdSchema.safeParse(value).success).toBe(false)
  );
});
