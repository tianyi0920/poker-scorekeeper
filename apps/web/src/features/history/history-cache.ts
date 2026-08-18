import type { HistoryResponseDto, SettlementDetailDto } from '@poker/contracts';

const prefix = 'poker-scorekeeper:history-cache:v1';
const maxListItems = 100;
const maxDetails = 30;

interface CacheRecord<T> { version: 1; cachedAt: number; value: T; }
interface DetailIndex { version: 1; ids: string[]; }

function key(userId: string, suffix: string): string { return `${prefix}:${encodeURIComponent(userId)}:${suffix}`; }
function read<T>(storageKey: string): T | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1 || !('value' in parsed)) return null;
    return (parsed as CacheRecord<T>).value;
  } catch { return null; }
}
function write<T>(storageKey: string, value: T): void {
  try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, cachedAt: Date.now(), value } satisfies CacheRecord<T>)); } catch { /* cache is optional */ }
}

export function readCachedHistory(userId: string): HistoryResponseDto | null { return userId === '' ? null : read<HistoryResponseDto>(key(userId, 'list')); }
export function writeCachedHistory(userId: string, response: HistoryResponseDto): void {
  if (userId === '') return;
  write(key(userId, 'list'), { ...response, items: response.items.slice(0, maxListItems) });
}
export function readCachedSettlementDetail(userId: string, gameId: string): SettlementDetailDto | null { return userId === '' || gameId === '' ? null : read<SettlementDetailDto>(key(userId, `detail:${encodeURIComponent(gameId)}`)); }
export function writeCachedSettlementDetail(userId: string, detail: SettlementDetailDto): void {
  if (userId === '') return;
  const indexKey = key(userId, 'detail-index'); const old = read<DetailIndex>(indexKey); const ids = [detail.game.id, ...(old?.ids ?? []).filter((id) => id !== detail.game.id)].slice(0, maxDetails);
  write(key(userId, `detail:${encodeURIComponent(detail.game.id)}`), detail);
  try { for (const id of (old?.ids ?? []).filter((id) => !ids.includes(id))) localStorage.removeItem(key(userId, `detail:${encodeURIComponent(id)}`)); } catch { /* cache is optional */ }
  write(indexKey, { version: 1, ids });
}
