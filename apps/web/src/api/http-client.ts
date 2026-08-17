const apiErrorMessages = {
  INVALID_CREDENTIALS: '用户名或密码错误',
  UNAUTHENTICATED: '请先登录后再继续',
  CSRF_INVALID: '安全校验已失效，请重新登录',
  PASSWORD_CHANGE_REQUIRED: '请先修改初始密码',
  FORBIDDEN: '你没有执行此操作的权限',
  VALIDATION_ERROR: '提交的信息有误，请检查后重试',
  TOO_MANY_REQUESTS: '请求过于频繁，请稍后再试',
  NOT_FOUND: '请求的内容不存在',
  SETTINGS_VERSION_CONFLICT: '规则已被其他管理员更新，请核对后再次提交',
  USERNAME_TAKEN: '用户名已被使用，请换一个',
  NICKNAME_TAKEN: '昵称已被使用，请换一个',
  USER_IN_ACTIVE_GAME: '用户仍在未完成牌局中，请先完成牌局',
  LAST_SUPER_ADMIN: '系统必须保留至少一位启用的超级管理员',
  ACTIVE_GAME_LIMIT: '最多同时开启两场对局，请先完成现有对局',
  ACTIVE_GAME_NAME_TAKEN: '已有进行中对局使用该名称，请更换名称',
  GAME_STATE_CONFLICT: '对局状态已变化，请刷新后重试',
  GAME_PLAYER_LIMIT: '本桌已满 12 人，无法继续加入',
  BUYIN_NOT_LATEST: '购买记录已变化，请刷新后再更正',
  BUYIN_AMOUNT_OVERFLOW: '购买金额超出系统范围，请减少手数',
  BUYIN_IDEMPOTENCY_CONFLICT: '该请求已用于其他购买，请刷新后重试',
  GAME_HAS_BUYINS: '对局已有购买记录，必须完成结算',
  GAME_HAS_RELATIONS: '草稿已关联业务记录，无法删除',
  AVATAR_UNSUPPORTED: '仅支持 JPG、PNG 或 WebP 图片',
  AVATAR_TOO_LARGE: '图片不能超过 5 MiB',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  HTTP_ERROR: '请求失败，请稍后重试'
} as const;

export type ApiErrorCode = keyof typeof apiErrorMessages;

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(apiErrorMessages, value);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'code' in body) {
        const { code } = body as { code: unknown };
        if (isApiErrorCode(code)) {
          return new ApiError(response.status, code, apiErrorMessages[code]);
        }
      }
    } catch {
      // Stable fallbacks make malformed server responses safe to display.
    }
    return new ApiError(response.status, 'HTTP_ERROR', apiErrorMessages.HTTP_ERROR);
  }
}

export function isDefinitiveMutationRejection(reason: unknown): reason is ApiError {
  return reason instanceof ApiError
    && reason.status >= 400
    && reason.status < 500
    && reason.code !== 'HTTP_ERROR'
    && reason.code !== 'INTERNAL_ERROR';
}

export const csrfTokenStore = {
  value: '',
  set(value: string): void {
    this.value = value;
  },
  clear(): void {
    this.value = '';
  }
};

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!safeMethods.has(method) && csrfTokenStore.value) {
    headers.set('X-CSRF-Token', csrfTokenStore.value);
  }

  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'same-origin'
  });
  if (!response.ok) throw await ApiError.fromResponse(response);
  return response.json() as Promise<T>;
}
