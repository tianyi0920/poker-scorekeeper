import type { Role } from '../../generated/prisma/client.js';

export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
  role: Role;
  mustChangePassword: boolean;
  avatarKind: 'PRESET' | 'UPLOAD';
  avatarValue: string;
}

export interface AuthenticatedSession {
  id: string;
  user: AuthUser;
  csrfToken: string;
}

export interface RequestWithAuth {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: AuthUser;
  authSession?: AuthenticatedSession;
}
