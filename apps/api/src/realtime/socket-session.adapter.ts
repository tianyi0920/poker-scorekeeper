import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { AuthenticatedSession } from '../common/auth/auth-user.js';
import {
  SESSION_COOKIE_NAME,
  SessionService,
  type SessionInvalidation
} from '../auth/session.service.js';

export interface GameSocketData {
  authSession?: AuthenticatedSession;
  rawSessionToken?: string;
  gameId?: string;
}

export type GameSocket = Socket & { data: GameSocketData };

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const cookie of header.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

@Injectable()
export class SocketSessionAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly sockets = new Map<string, GameSocket>();
  private unsubscribe?: () => void;

  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  onModuleInit(): void {
    this.unsubscribe = this.sessions.onInvalidated((event) => this.disconnectInvalidated(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.sockets.clear();
  }

  async authenticateHandshake(socket: GameSocket): Promise<boolean> {
    const rawToken = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE_NAME);
    if (rawToken === null) return false;
    const authSession = await this.sessions.authenticateRawToken(rawToken);
    if (authSession === null || authSession.user.mustChangePassword) return false;
    socket.data.rawSessionToken = rawToken;
    socket.data.authSession = authSession;
    return true;
  }

  register(socket: GameSocket): void {
    this.sockets.set(socket.id, socket);
  }

  unregister(socket: GameSocket): void {
    this.sockets.delete(socket.id);
  }

  async revalidate(socket: GameSocket): Promise<AuthenticatedSession | null> {
    const rawToken = socket.data.rawSessionToken;
    if (rawToken === undefined) return null;
    const authSession = await this.sessions.authenticateRawToken(rawToken);
    if (authSession === null || authSession.user.mustChangePassword) {
      return null;
    }
    socket.data.authSession = authSession;
    return authSession;
  }

  disconnectUser(userId: string, exceptSessionId?: string): void {
    for (const socket of this.sockets.values()) {
      const authSession = socket.data.authSession;
      if (
        authSession?.user.id === userId &&
        (exceptSessionId === undefined || authSession.id !== exceptSessionId)
      ) {
        socket.disconnect(true);
      }
    }
  }

  disconnectSession(sessionId: string): void {
    for (const socket of this.sockets.values()) {
      if (socket.data.authSession?.id === sessionId) socket.disconnect(true);
    }
  }

  private disconnectInvalidated(event: SessionInvalidation): void {
    if (event.kind === 'session') this.disconnectSession(event.sessionId);
    else this.disconnectUser(event.userId, event.exceptSessionId);
  }
}
