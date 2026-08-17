const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const INVALID_DATE = '[INVALID_DATE]';
const UNREADABLE = '[UNREADABLE]';

function keyTokens(key: string): string[] {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
  const tokens = keyTokens(key);
  const normalized = tokens.join('');
  const hasPair = (first: string, second: string) => tokens.some(
    (token, index) => token === first && tokens[index + 1] === second
  );
  const hasTransportPartner = (term: string) => {
    const index = tokens.indexOf(term);
    if (index === -1) return false;
    const partners = new Set(['header', 'value', 'key', 'token', 'credential', 'client']);
    return tokens.length === 1 || partners.has(tokens[index - 1] ?? '') ||
      partners.has(tokens[index + 1] ?? '');
  };

  return tokens.includes('password') ||
    tokens.includes('token') ||
    tokens.includes('cookie') ||
    tokens.at(-1) === 'hash' ||
    hasPair('database', 'url') ||
    hasPair('db', 'url') ||
    hasPair('connection', 'string') ||
    hasPair('api', 'key') ||
    hasTransportPartner('authorization') ||
    hasTransportPartner('secret') ||
    /^(?:authorization(?:header|value|token)|(?:header|value|token)authorization)$/.test(normalized) ||
    /^(?:apikey(?:header|value)?|(?:header|value)apikey)$/.test(normalized) ||
    /^(?:secret(?:header|value|key)|(?:header|value|client)secret)$/.test(normalized) ||
    /^(?:(?:database|db)url(?:value)?|value(?:database|db)url)$/.test(normalized);
}

function isSensitiveString(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\//i.test(trimmed) ||
    /^(?:authorization\s*:\s*)?bearer\s+\S+/i.test(trimmed) ||
    /^(?:set-)?cookie\s*:\s*\S+/i.test(trimmed) ||
    /^(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key)\s*[:=]\s*\S+/i.test(trimmed) ||
    /^(?:server|host)\s*=.+;(?:.*;)?(?:password|pwd)\s*=/i.test(trimmed);
}

function redactObject(value: object, active: WeakSet<object>): unknown {
  if (active.has(value)) return CIRCULAR;
  active.add(value);
  try {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isNaN(timestamp) ? INVALID_DATE : value.toISOString();
    }

    if (Array.isArray(value)) {
      const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number') return UNREADABLE;
      const result = new Array<unknown>(length);
      for (const key of Object.keys(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index >= length) continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        result[index] = descriptor !== undefined && 'value' in descriptor
          ? redactValue(descriptor.value, active)
          : UNREADABLE;
      }
      return result;
    }

    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(value)) {
      if (isSensitiveKey(key)) {
        entries.push([key, REDACTED]);
        continue;
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      entries.push([
        key,
        descriptor !== undefined && 'value' in descriptor
          ? redactValue(descriptor.value, active)
          : UNREADABLE
      ]);
    }
    return Object.fromEntries(entries);
  } catch {
    return UNREADABLE;
  } finally {
    active.delete(value);
  }
}

function redactValue(value: unknown, active: WeakSet<object>): unknown {
  if (typeof value === 'string') return isSensitiveString(value) ? REDACTED : value;
  if (typeof value === 'bigint') return value.toString();
  if (value !== null && typeof value === 'object') return redactObject(value, active);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

export function redactAuditValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
