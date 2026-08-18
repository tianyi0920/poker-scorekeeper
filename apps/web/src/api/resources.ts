import type {
  AdjustLatestBuyinRequest,
  BuyHandsRequest,
  BuyinEventResponse,
  CreateGameRequest,
  CreateUserRequest,
  CurrentGamesResponse,
  GameSnapshotDto,
  RakeSettingsDto,
  AllPlayerAggregationDto,
  FinalizeSettlementRequest,
  HistoryResponseDto,
  SaveSettlementDraftRequest,
  SettlementDetailDto,
  SettlementDraftDto,
  SettlementDraftPayload,
  SettlementPreviewDto,
  SelectPresetAvatarRequest,
  UpdateRakeSettingsRequest,
  UpdateUserRequest,
  UserResponse
} from '@poker/contracts';
import { ApiError, apiFetch, csrfTokenStore } from './http-client.js';

export interface HistoryGameSummary {
  id: string;
  name: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  playerCount: number;
  myFinalAmount: string | null;
}

export interface HistoryListResponse {
  games: HistoryGameSummary[];
  nextCursor: string | null;
}

export interface PresetAvatarDto {
  id: string;
  path: string;
}

export interface AvatarMutationResponse {
  avatarKind: 'PRESET' | 'UPLOAD';
  avatarValue: string;
}

export const scorekeeperApi = {
  currentGames: () => apiFetch<CurrentGamesResponse>('/games/current'),
  gameSnapshot: (id: string) => apiFetch<GameSnapshotDto>(`/games/${encodeURIComponent(id)}/snapshot`),
  buyIn: (gameId: string, body: BuyHandsRequest) => apiFetch<BuyinEventResponse>(`/games/${encodeURIComponent(gameId)}/buyins`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  adjustLatestBuyIn: (gameId: string, playerId: string, body: AdjustLatestBuyinRequest) => apiFetch<BuyinEventResponse>(`/games/${encodeURIComponent(gameId)}/players/${encodeURIComponent(playerId)}/buyins/latest/adjust`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  recentHistory: (limit = 10) => apiFetch<HistoryListResponse>(`/history?limit=${limit}`),
  settlementDraft: (gameId: string) => apiFetch<SettlementDraftDto>(`/games/${encodeURIComponent(gameId)}/settlement-draft`),
  saveSettlementDraft: (gameId: string, body: SaveSettlementDraftRequest) => apiFetch<SettlementDraftDto>(`/games/${encodeURIComponent(gameId)}/settlement-draft`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  takeOverSettlementDraft: (gameId: string) => apiFetch<SettlementDraftDto>(`/games/${encodeURIComponent(gameId)}/settlement-draft/takeover`, { method: 'POST' }),
  previewSettlement: (gameId: string, body: SettlementDraftPayload) => apiFetch<SettlementPreviewDto>(`/games/${encodeURIComponent(gameId)}/settlement-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  finalizeSettlement: (gameId: string, body: FinalizeSettlementRequest) => apiFetch<SettlementDetailDto>(`/games/${encodeURIComponent(gameId)}/settlement-finalize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  history: (limit = 10, cursor?: string) => apiFetch<HistoryResponseDto>(`/history?limit=${limit}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`),
  historyDetail: (gameId: string) => apiFetch<SettlementDetailDto>(`/history/${encodeURIComponent(gameId)}`),
  aggregateHistory: (body: { gameIds: string[] } | { filter: { kind: 'RECENT_10' | 'RECENT_30' | 'LAST_30_DAYS' | 'LAST_90_DAYS' } | { kind: 'CUSTOM_DATE_RANGE'; startAt: string; endAt: string } }) => apiFetch<AllPlayerAggregationDto>('/history/aggregate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  createGame: (body: CreateGameRequest) => apiFetch<GameSnapshotDto>('/games', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  startGame: (id: string) => apiFetch<GameSnapshotDto>(`/games/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  beginSettlement: (id: string) => apiFetch<GameSnapshotDto>(`/games/${encodeURIComponent(id)}/begin-settlement`, { method: 'POST' }),
  listUsers: () => apiFetch<{ users: UserResponse[] }>('/users'),
  createUser: (body: CreateUserRequest) => apiFetch<UserResponse>('/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  updateUser: (id: string, body: UpdateUserRequest) => apiFetch<UserResponse>(`/users/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  deleteUser: (id: string) => apiFetch<UserResponse>(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restoreUser: (id: string, nickname?: string) => apiFetch<UserResponse>(`/users/${encodeURIComponent(id)}/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nickname ? { nickname } : {})
  }),
  resetPassword: (id: string, newPassword: string) => apiFetch<UserResponse>(`/users/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword })
  }),
  resetAvatar: (id: string) => apiFetch<AvatarMutationResponse>(`/users/${encodeURIComponent(id)}/avatar/reset`, { method: 'POST' }),
  getRakeSettings: () => apiFetch<RakeSettingsDto>('/settings/rake'),
  updateRakeSettings: (body: UpdateRakeSettingsRequest) => apiFetch<RakeSettingsDto>('/settings/rake', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  getPresetAvatars: () => apiFetch<{ presets: PresetAvatarDto[] }>('/avatars/presets'),
  selectPresetAvatar: (body: SelectPresetAvatarRequest) => apiFetch<AvatarMutationResponse>('/me/avatar/preset', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
};

export function uploadAvatar(blob: Blob, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<AvatarMutationResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Avatar upload aborted', 'AbortError'));
      return;
    }
    const request = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', abortUpload);
      request.onload = null;
      request.onerror = null;
      request.onabort = null;
    };
    const resolveOnce = (response: AvatarMutationResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const rejectOnce = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const abortUpload = () => request.abort();
    request.open('POST', '/api/me/avatar/upload');
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    if (csrfTokenStore.value) request.setRequestHeader('X-CSRF-Token', csrfTokenStore.value);
    request.upload.addEventListener('progress', (event) => {
      if (!settled && event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.onerror = () => rejectOnce(new ApiError(0, 'HTTP_ERROR', '上传失败，请检查网络后重试'));
    request.onabort = () => rejectOnce(new DOMException('Avatar upload aborted', 'AbortError'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolveOnce(JSON.parse(request.responseText) as AvatarMutationResponse);
        } catch {
          rejectOnce(new ApiError(request.status, 'HTTP_ERROR', '服务器返回了无效结果'));
        }
        return;
      }
      void ApiError.fromResponse(new Response(request.responseText, {
        status: request.status,
        headers: { 'Content-Type': 'application/json' }
      })).then(rejectOnce);
    };
    signal?.addEventListener('abort', abortUpload, { once: true });
    const form = new FormData();
    form.append('file', blob, 'avatar.webp');
    request.send(form);
  });
}

export function mutationMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
