const apiErrorMessages = {
  INVALID_CREDENTIALS: '用户名或密码错误',
  UNAUTHENTICATED: '请先登录后再继续',
  CSRF_INVALID: '安全校验已失效，请重新登录',
  PASSWORD_CHANGE_REQUIRED: '请先修改初始密码',
  FORBIDDEN: '你没有执行此操作的权限',
  VALIDATION_ERROR: '提交的信息有误，请检查后重试',
  TOO_MANY_REQUESTS: '请求过于频繁，请稍后再试',
  NOT_FOUND: '请求的内容不存在',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  HTTP_ERROR: '请求失败，请稍后重试'
} as const;

type ApiErrorCode = keyof typeof apiErrorMessages;

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && value in apiErrorMessages;
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
