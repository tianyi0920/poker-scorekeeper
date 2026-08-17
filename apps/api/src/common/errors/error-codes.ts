export const ERROR_CODES = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  CSRF_INVALID: 'CSRF_INVALID',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  NICKNAME_TAKEN: 'NICKNAME_TAKEN',
  USER_IN_ACTIVE_GAME: 'USER_IN_ACTIVE_GAME',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  AVATAR_UNSUPPORTED: 'AVATAR_UNSUPPORTED',
  AVATAR_TOO_LARGE: 'AVATAR_TOO_LARGE',
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
  USERNAME_TAKEN: 'Username is already in use',
  NICKNAME_TAKEN: 'Nickname is already in use',
  USER_IN_ACTIVE_GAME: 'User is in an active game',
  LAST_SUPER_ADMIN: 'Cannot remove the last active super admin',
  AVATAR_UNSUPPORTED: 'Unsupported avatar image',
  AVATAR_TOO_LARGE: 'Avatar image is too large',
  NOT_FOUND: 'Not found',
  INTERNAL_ERROR: 'Internal server error'
};
