const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const INVALID_DATE = '[INVALID_DATE]';
const UNREADABLE = '[UNREADABLE]';
const MAX_DEPTH_EXCEEDED = '[MAX_DEPTH_EXCEEDED]';
const MAX_NODES_EXCEEDED = '[MAX_NODES_EXCEEDED]';
const MAX_ARRAY_LENGTH_EXCEEDED = '[MAX_ARRAY_LENGTH_EXCEEDED]';
const MAX_STRING_LENGTH_EXCEEDED = '[MAX_STRING_LENGTH_EXCEEDED]';
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_STRING_LENGTH = 16_384;

interface RedactionContext {
  active: WeakSet<object>;
  nodes: number;
}

const COMPACT_SENSITIVE_KEY_FAMILIES = [
  /^(?:session|auth|authorization|access|refresh|csrf|reset|id)?token(?:hash|value|header)?$/,
  /^(?:session|http|request|response|set)?cookie(?:header|value|name)?$/,
  /^(?:(?:http|request|response)?auth(?:header|value|token)?|(?:header|value|token)auth)$/,
  /^(?:(?:http|request|response)?authorization(?:header|value|token)?|(?:header|value|token)authorization)$/,
  /^(?:x|client)?apikey(?:header|value)?$/,
  /^(?:(?:database|db)url(?:value)?|value(?:database|db)url)$/,
  /^(?:db|database)?connectionstring(?:value)?$/,
  /^(?:(?:client|api)?secret(?:header|value|key)?|(?:header|value|client)secret)$/,
  /^(?:credential|password|token|session)hash$/
] as const;

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

  return normalized.includes('password') ||
    tokens.includes('token') ||
    tokens.includes('cookie') ||
    tokens.at(-1) === 'hash' ||
    hasPair('database', 'url') ||
    hasPair('db', 'url') ||
    hasPair('connection', 'string') ||
    hasPair('api', 'key') ||
    hasTransportPartner('auth') ||
    hasTransportPartner('authorization') ||
    hasTransportPartner('secret') ||
    COMPACT_SENSITIVE_KEY_FAMILIES.some((pattern) => pattern.test(normalized));
}

function shouldRedactKey(key: string, descriptor: PropertyDescriptor | undefined): boolean {
  const normalized = keyTokens(key).join('');
  if (normalized === 'mustchangepassword' && descriptor !== undefined &&
    'value' in descriptor && typeof descriptor.value === 'boolean') return false;
  return isSensitiveKey(key);
}

function isSensitiveString(value: string): boolean {
  const trimmed = value.trim();
  return /(?:^|\s)(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/\S+/i.test(trimmed) ||
    /^(?:basic|bearer)\s+\S+/i.test(trimmed) ||
    /\bauthorization\s*[:=]\s*(?:basic|bearer)\s+\S+/i.test(trimmed) ||
    /(?:^|[\s;,])(?:set-)?cookie\s*[:=]\s*\S+/i.test(trimmed) ||
    /(?:^|[\s;,])(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key)\s*[:=]\s*\S+/i.test(trimmed) ||
    /\b(?:password|pwd)\s*=\s*[^;\s]+/i.test(trimmed);
}

function redactObject(value: object, context: RedactionContext, depth: number): unknown {
  if (context.active.has(value)) return CIRCULAR;
  context.active.add(value);
  try {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isNaN(timestamp) ? INVALID_DATE : value.toISOString();
    }

    if (Array.isArray(value)) {
      const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number') return UNREADABLE;
      if (length > MAX_ARRAY_LENGTH) return MAX_ARRAY_LENGTH_EXCEEDED;
      const keys = Object.keys(value);
      if (keys.length > MAX_NODES - context.nodes) return MAX_NODES_EXCEEDED;
      const result = new Array<unknown>(length);
      for (const key of keys) {
        if (!/^(0|[1-9]\d*)$/.test(key)) continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index >= length) continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        result[index] = descriptor !== undefined && 'value' in descriptor
          ? redactValue(descriptor.value, context, depth + 1)
          : UNREADABLE;
      }
      return result;
    }

    const keys = Object.keys(value);
    if (keys.length > MAX_NODES - context.nodes) return MAX_NODES_EXCEEDED;
    if (keys.some((key) => key.length > MAX_STRING_LENGTH)) return MAX_STRING_LENGTH_EXCEEDED;
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (shouldRedactKey(key, descriptor)) {
        entries.push([key, REDACTED]);
        continue;
      }
      entries.push([
        key,
        descriptor !== undefined && 'value' in descriptor
          ? redactValue(descriptor.value, context, depth + 1)
          : UNREADABLE
      ]);
    }
    return Object.fromEntries(entries);
  } catch {
    return UNREADABLE;
  } finally {
    context.active.delete(value);
  }
}

function redactValue(value: unknown, context: RedactionContext, depth: number): unknown {
  if (depth > MAX_DEPTH) return MAX_DEPTH_EXCEEDED;
  context.nodes += 1;
  if (context.nodes > MAX_NODES) return MAX_NODES_EXCEEDED;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) return MAX_STRING_LENGTH_EXCEEDED;
    return isSensitiveString(value) ? REDACTED : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value !== null && typeof value === 'object') return redactObject(value, context, depth);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

export function redactAuditValue(value: unknown): unknown {
  return redactValue(value, { active: new WeakSet<object>(), nodes: 0 }, 0);
}
