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
const MIN_BEARER_TOKEN_LENGTH = 12;
const MIN_BASIC_CREDENTIAL_LENGTH = 8;

const DATABASE_URL_SCHEMES = [
  'jdbc:postgresql://',
  'jdbc:mariadb://',
  'jdbc:mysql://',
  'jdbc:postgres://',
  'mongodb+srv://',
  'postgresql://',
  'mariadb://',
  'mongodb://',
  'postgres://',
  'mysql://',
  'redis://'
] as const;

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

function isAsciiAlphaNumeric(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function isAsciiWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' ||
    character === '\n' || character === '\f';
}

function isBase64Character(character: string): boolean {
  return isAsciiAlphaNumeric(character) || character === '+' || character === '/' || character === '=';
}

function isBasicCredentialSyntax(token: string): boolean {
  if (token.length === 0 || token.length % 4 === 1) return false;
  let padding = 0;
  for (let index = token.length - 1; index >= 0 && token[index] === '='; index -= 1) padding += 1;
  if (padding > 2 || padding > 0 && token.length % 4 !== 0) return false;
  const contentLength = token.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Character(token[index] ?? '') || token[index] === '=') return false;
  }
  for (let index = contentLength; index < token.length; index += 1) {
    if (token[index] !== '=') return false;
  }

  try {
    return Buffer.from(token, 'base64').includes(58);
  } catch {
    return false;
  }
}

function isUnlabelledBasicCredential(token: string): boolean {
  return token.length >= MIN_BASIC_CREDENTIAL_LENGTH && isBasicCredentialSyntax(token);
}

function isBearerCharacter(character: string): boolean {
  return isAsciiAlphaNumeric(character) || '-._~+/='.includes(character);
}

function isBearerTokenSyntax(token: string): boolean {
  if (token.length === 0) return false;
  for (const character of token) {
    if (!isBearerCharacter(character)) return false;
  }
  return true;
}

function isUnlabelledBearerToken(token: string): boolean {
  if (token.length < MIN_BEARER_TOKEN_LENGTH || !isBearerTokenSyntax(token)) return false;
  let hasLower = false;
  let hasUpper = false;
  let hasDigit = false;
  let hasSymbol = false;
  for (const character of token) {
    const code = character.charCodeAt(0);
    if (code >= 97 && code <= 122) hasLower = true;
    else if (code >= 65 && code <= 90) hasUpper = true;
    else if (code >= 48 && code <= 57) hasDigit = true;
    else hasSymbol = true;
  }
  return hasDigit || hasSymbol || hasLower && hasUpper;
}

function asciiCharactersEqual(left: string, lowerAsciiRight: string): boolean {
  let leftCode = left.charCodeAt(0);
  if (leftCode >= 65 && leftCode <= 90) leftCode += 32;
  return leftCode === lowerAsciiRight.charCodeAt(0);
}

function matchesAsciiCaseInsensitive(value: string, start: number, lowerAsciiNeedle: string): boolean {
  if (start < 0 || start + lowerAsciiNeedle.length > value.length) return false;
  for (let offset = 0; offset < lowerAsciiNeedle.length; offset += 1) {
    if (!asciiCharactersEqual(value[start + offset] ?? '', lowerAsciiNeedle[offset] ?? '')) return false;
  }
  return true;
}

function indexOfAsciiCaseInsensitive(
  value: string,
  lowerAsciiNeedle: string,
  searchFrom: number
): number {
  const lastStart = value.length - lowerAsciiNeedle.length;
  for (let start = Math.max(0, searchFrom); start <= lastStart; start += 1) {
    if (matchesAsciiCaseInsensitive(value, start, lowerAsciiNeedle)) return start;
  }
  return -1;
}

function skipAsciiWhitespace(value: string, start: number): number {
  let cursor = start;
  while (isAsciiWhitespace(value[cursor])) cursor += 1;
  return cursor;
}

function readCredentialToken(
  value: string,
  start: number,
  isTokenCharacter: (character: string) => boolean
): string {
  let end = start;
  while (end < value.length && isTokenCharacter(value[end] ?? '')) end += 1;
  return value.slice(start, end);
}

function explicitAuthorizationCredentialAt(value: string, start: number): boolean {
  let cursor = skipAsciiWhitespace(value, start + 'authorization'.length);
  if (value[cursor] !== ':' && value[cursor] !== '=') return false;
  cursor = skipAsciiWhitespace(value, cursor + 1);

  if (matchesAsciiCaseInsensitive(value, cursor, 'basic')) {
    cursor += 'basic'.length;
    if (!isAsciiWhitespace(value[cursor])) return false;
    cursor = skipAsciiWhitespace(value, cursor);
    return isBasicCredentialSyntax(readCredentialToken(value, cursor, isBase64Character));
  }
  if (matchesAsciiCaseInsensitive(value, cursor, 'bearer')) {
    cursor += 'bearer'.length;
    if (!isAsciiWhitespace(value[cursor])) return false;
    cursor = skipAsciiWhitespace(value, cursor);
    return isBearerTokenSyntax(readCredentialToken(value, cursor, isBearerCharacter));
  }
  return false;
}

function containsExplicitAuthorizationCredential(value: string): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = indexOfAsciiCaseInsensitive(value, 'authorization', searchFrom);
    if (start === -1) return false;
    if (!isAsciiAlphaNumeric(value[start - 1]) && explicitAuthorizationCredentialAt(value, start)) {
      return true;
    }
    searchFrom = start + 'authorization'.length;
  }
  return false;
}

function containsCredentialToken(
  value: string,
  scheme: 'basic' | 'bearer',
  isValidToken: (token: string) => boolean
): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = indexOfAsciiCaseInsensitive(value, scheme, searchFrom);
    if (start === -1) return false;
    const before = value[start - 1];
    let tokenStart = start + scheme.length;
    if (!isAsciiAlphaNumeric(before) && isAsciiWhitespace(value[tokenStart])) {
      while (isAsciiWhitespace(value[tokenStart])) tokenStart += 1;
      let tokenEnd = tokenStart;
      const isTokenCharacter = scheme === 'basic' ? isBase64Character : isBearerCharacter;
      while (tokenEnd < value.length && isTokenCharacter(value[tokenEnd] ?? '')) tokenEnd += 1;
      if (isValidToken(value.slice(tokenStart, tokenEnd))) return true;
    }
    searchFrom = start + scheme.length;
  }
  return false;
}

function containsDatabaseUrl(value: string): boolean {
  for (const scheme of DATABASE_URL_SCHEMES) {
    let searchFrom = 0;
    while (searchFrom < value.length) {
      const start = indexOfAsciiCaseInsensitive(value, scheme, searchFrom);
      if (start === -1) break;
      const firstValueCharacter = value[start + scheme.length];
      if (firstValueCharacter !== undefined && !isAsciiWhitespace(firstValueCharacter)) return true;
      searchFrom = start + scheme.length;
    }
  }
  return false;
}

function isSensitiveString(value: string): boolean {
  const trimmed = value.trim();
  return containsDatabaseUrl(trimmed) ||
    containsExplicitAuthorizationCredential(trimmed) ||
    containsCredentialToken(trimmed, 'basic', isUnlabelledBasicCredential) ||
    containsCredentialToken(trimmed, 'bearer', isUnlabelledBearerToken) ||
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
