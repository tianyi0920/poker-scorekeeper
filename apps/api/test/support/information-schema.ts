export function normalizeInformationSchemaRows<Row extends object>(
  rows: readonly Record<string, unknown>[],
  expectedKeys: readonly (keyof Row & string)[]
): Row[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};

    for (const expectedKey of expectedKeys) {
      const matches = Object.keys(row).filter(
        (actualKey) => actualKey.toLowerCase() === expectedKey.toLowerCase()
      );

      if (matches.length === 0) {
        throw new Error(`Missing information schema column: ${expectedKey}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous information schema column: ${expectedKey}`);
      }

      normalized[expectedKey] = row[matches[0]!];
    }

    return normalized as Row;
  });
}
