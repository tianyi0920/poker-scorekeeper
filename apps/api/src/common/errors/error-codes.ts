export const ERROR_CODES = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  CSRF_INVALID: 'CSRF_INVALID',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_CREDENTIALS: 'Invalid username or password',
  UNAUTHENTICATED: 'Authentication required',
  CSRF_INVALID: 'Invalid CSRF token',
  PASSWORD_CHANGE_REQUIRED: 'Password change required',
  FORBIDDEN: 'Forbidden',
  VALIDATION_ERROR: 'Invalid request',
  TOO_MANY_REQUESTS: 'Too many login attempts',
  NOT_FOUND: 'Not found',
  INTERNAL_ERROR: 'Internal server error'
};
