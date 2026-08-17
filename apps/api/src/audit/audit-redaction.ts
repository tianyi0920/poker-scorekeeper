const REDACTED = '[REDACTED]';

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('cookie') ||
    normalized.includes('databaseurl') ||
    normalized === 'dburl' ||
    normalized.endsWith('connectionstring') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('hash') ||
    normalized === 'authorization' ||
    normalized === 'secret' ||
    normalized.endsWith('secret');
}

function isDatabaseUrl(value: string): boolean {
  return /^(?:mysql|mariadb|postgres(?:ql)?):\/\//i.test(value.trim());
}

export function redactAuditValue(value: unknown): unknown {
  if (typeof value === 'string') return isDatabaseUrl(value) ? REDACTED : value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((child) => redactAuditValue(child));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactAuditValue(child)
    ]));
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}
