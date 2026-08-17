import type {
  CreateGameRequest,
  CreateUserRequest,
  CurrentGamesResponse,
  GameSnapshotDto,
  RakeSettingsDto,
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
  recentHistory: (limit = 10) => apiFetch<HistoryListResponse>(`/history?limit=${limit}`),
  createGame: (body: CreateGameRequest) => apiFetch<GameSnapshotDto>('/games', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }),
  startGame: (id: string) => apiFetch<GameSnapshotDto>(`/games/${encodeURIComponent(id)}/start`, { method: 'POST' }),
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

export function uploadAvatar(blob: Blob, onProgress: (percent: number) => void): Promise<AvatarMutationResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/me/avatar/upload');
    request.withCredentials = true;
    request.setRequestHeader('Accept', 'application/json');
    if (csrfTokenStore.value) request.setRequestHeader('X-CSRF-Token', csrfTokenStore.value);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.onerror = () => reject(new ApiError(0, 'HTTP_ERROR', '上传失败，请检查网络后重试'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as AvatarMutationResponse);
        } catch {
          reject(new ApiError(request.status, 'HTTP_ERROR', '服务器返回了无效结果'));
        }
        return;
      }
      void ApiError.fromResponse(new Response(request.responseText, {
        status: request.status,
        headers: { 'Content-Type': 'application/json' }
      })).then(reject);
    };
    const form = new FormData();
    form.append('file', blob, 'avatar.webp');
    request.send(form);
  });
}

export function mutationMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
