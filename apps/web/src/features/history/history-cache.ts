import { canonicalPublicIdSchema, historyResponseSchema, settlementDetailSchema, type HistoryResponseDto, type SettlementDetailDto } from '@poker/contracts';

const prefix = 'poker-scorekeeper:history-cache:v1';
const maxListItems = 100;
const maxDetails = 30;

interface CacheRecord<T> { version: 1; cachedAt: number; value: T; }
interface DetailIndex { version: 1; ids: string[]; }

function key(userId: string, suffix: string): string { return `${prefix}:${encodeURIComponent(userId)}:${suffix}`; }
function readEnvelope(storageKey: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || !('cachedAt' in parsed) || !('value' in parsed) || parsed.version !== 1 || typeof parsed.cachedAt !== 'number' || !Number.isFinite(parsed.cachedAt)) return null;
    return parsed.value;
  } catch { return null; }
}
function write<T>(storageKey: string, value: T): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, cachedAt: Date.now(), value } satisfies CacheRecord<T>));
    return true;
  } catch { return false; }
}
function readIndex(userId: string): DetailIndex | null {
  const value = readEnvelope(key(userId, 'detail-index'));
  if (typeof value !== 'object' || value === null || !('version' in value) || !('ids' in value) || value.version !== 1 || !Array.isArray(value.ids) || value.ids.length > maxDetails || value.ids.some((id) => !canonicalPublicIdSchema.safeParse(id).success) || new Set(value.ids).size !== value.ids.length) return null;
  return { version: 1, ids: [...value.ids] };
}

export function readCachedHistory(userId: string): HistoryResponseDto | null {
  if (userId === '') return null; const parsed = historyResponseSchema.safeParse(readEnvelope(key(userId, 'list')));
  return parsed.success && parsed.data.items.length <= maxListItems ? parsed.data : null;
}
export function writeCachedHistory(userId: string, response: unknown): boolean {
  if (userId === '') return false;
  const parsed = historyResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.items.length > maxListItems) return false;
  return write(key(userId, 'list'), parsed.data);
}
export function readCachedSettlementDetail(userId: string, gameId: string): SettlementDetailDto | null {
  if (userId === '' || gameId === '') return null; const parsed = settlementDetailSchema.safeParse(readEnvelope(key(userId, `detail:${encodeURIComponent(gameId)}`)));
  return parsed.success && parsed.data.game.id === gameId ? parsed.data : null;
}
export function writeCachedSettlementDetail(userId: string, detail: unknown): boolean {
  if (userId === '') return false;
  const parsed = settlementDetailSchema.safeParse(detail);
  if (!parsed.success) return false;
  const value = parsed.data;
  const indexKey = key(userId, 'detail-index'); const old = readIndex(userId); const ids = [value.game.id, ...(old?.ids ?? []).filter((id) => id !== value.game.id)].slice(0, maxDetails);
  if (!write(key(userId, `detail:${encodeURIComponent(value.game.id)}`), value)) return false;
  try { for (const id of (old?.ids ?? []).filter((id) => !ids.includes(id))) localStorage.removeItem(key(userId, `detail:${encodeURIComponent(id)}`)); } catch { /* cache is optional */ }
  return write(indexKey, { version: 1, ids });
}
