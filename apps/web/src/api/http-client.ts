export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'code' in body && 'message' in body) {
        const { code, message } = body as { code: unknown; message: unknown };
        if (typeof code === 'string' && typeof message === 'string') {
          return new ApiError(response.status, code, message);
        }
      }
    } catch {
      // Stable fallbacks make malformed server responses safe to display.
    }
    return new ApiError(response.status, 'HTTP_ERROR', '请求失败，请稍后重试');
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
