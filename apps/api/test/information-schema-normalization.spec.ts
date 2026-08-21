import { describe, expect, it } from 'vitest';

import { normalizeInformationSchemaRows } from './support/information-schema.js';

describe('information schema row normalization', () => {
  it('normalizes MySQL uppercase metadata labels to the requested keys', () => {
    expect(
      normalizeInformationSchemaRows<{
        table_name: string;
        table_rows: bigint;
      }>(
        [{ TABLE_NAME: 'users', TABLE_ROWS: 12n }],
        ['table_name', 'table_rows']
      )
    ).toEqual([{ table_name: 'users', table_rows: 12n }]);
  });

  it('preserves MariaDB lowercase metadata labels', () => {
    expect(
      normalizeInformationSchemaRows<{ column_name: string }>(
        [{ column_name: 'game_id' }],
        ['column_name']
      )
    ).toEqual([{ column_name: 'game_id' }]);
  });

  it('fails closed when an expected metadata label is missing', () => {
    expect(() =>
      normalizeInformationSchemaRows<{ table_name: string }>(
        [{ TABLE_SCHEMA: 'poker_scorekeeper_test' }],
        ['table_name']
      )
    ).toThrow('Missing information schema column: table_name');
  });

  it('fails closed when metadata labels differ only by case', () => {
    expect(() =>
      normalizeInformationSchemaRows<{ table_name: string }>(
        [{ TABLE_NAME: 'users', table_name: 'games' }],
        ['table_name']
      )
    ).toThrow('Ambiguous information schema column: table_name');
  });
});
