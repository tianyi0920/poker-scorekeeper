import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedSession, AuthUser } from '../common/auth/auth-user.js';
import { CsrfService } from './csrf.service.js';

export const SESSION_COOKIE_NAME = 'poker_session';
export const SESSION_IDLE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

interface RenewalCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  expires: Date;
}

interface CookieResponse {
  cookie(
    name: string,
    value: string,
    options: SessionCookieOptions | RenewalCookieOptions
  ): void;
}

export type SessionInvalidation =
  | { kind: 'session'; sessionId: string }
  | { kind: 'user'; userId: string; exceptSessionId?: string };

type SessionInvalidationListener = (invalidation: SessionInvalidation) => void;

function toAuthUser(user: {
  id: string;
  username: string;
  nickname: string;
  role: AuthUser['role'];
  mustChangePassword: boolean;
}): AuthUser {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    mustChangePassword: user.mustChangePassword
  };
}

function readCookie(header: string | string[] | undefined, name: string): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  for (const cookie of value.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function shouldUseSecureCookies(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    const protocol = new URL(environment.PUBLIC_ORIGIN ?? '').protocol;
    if (protocol === 'http:') return false;
    if (protocol === 'https:') return true;
  } catch {
    // A missing or malformed production origin must not weaken cookies.
  }
  return environment.NODE_ENV === 'production';
}

@Injectable()
export class SessionService {
  private readonly browserRenewals = new WeakMap<
    AuthenticatedSession,
    { rawToken: string; expiresAt: Date }
  >();
  private readonly invalidationListeners = new Set<SessionInvalidationListener>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CsrfService) private readonly csrf: CsrfService
  ) {}

  cookieOptions(): SessionCookieOptions {
    return {
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_IDLE_MILLISECONDS
    };
  }

  async create(user: AuthUser, ipAddress: string, userAgent: string): Promise<{
    rawToken: string;
    authSession: AuthenticatedSession;
  }> {
    const rawToken = randomBytes(32).toString('hex');
    const now = new Date();
    const session = await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(now.getTime() + SESSION_IDLE_MILLISECONDS),
        absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MILLISECONDS),
        lastSeenAt: now,
        ipAddress: ipAddress.slice(0, 45),
        userAgent: userAgent.slice(0, 512)
      }
    });
    return {
      rawToken,
      authSession: {
        id: session.id,
        user,
        csrfToken: this.csrf.createToken(session.id, user.id)
      }
    };
  }

  async authenticateCookie(
    cookieHeader: string | string[] | undefined
  ): Promise<AuthenticatedSession | null> {
    const rawToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (rawToken === null || !/^[a-f0-9]{64}$/.test(rawToken)) return null;

    return this.authenticateToken(rawToken, true);
  }

  async authenticateRawToken(rawToken: string): Promise<AuthenticatedSession | null> {
    if (!/^[a-f0-9]{64}$/.test(rawToken)) return null;
    return this.authenticateToken(rawToken, false);
  }

  private async authenticateToken(
    rawToken: string,
    renewBrowser: boolean
  ): Promise<AuthenticatedSession | null> {

    const now = new Date();
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true }
    });
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      !session.user.isActive ||
      session.user.deletedAt !== null
    ) {
      return null;
    }

    const user = toAuthUser(session.user);
    const authSession: AuthenticatedSession = {
      id: session.id,
      user,
      csrfToken: this.csrf.createToken(session.id, user.id)
    };
    if (renewBrowser) {
      const refreshedExpiry = new Date(Math.min(
        now.getTime() + SESSION_IDLE_MILLISECONDS,
        session.absoluteExpiresAt.getTime()
      ));
      const refresh = await this.prisma.authSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now }
        },
        data: { lastSeenAt: now, expiresAt: refreshedExpiry }
      });
      if (refresh.count !== 1) return null;
      this.browserRenewals.set(authSession, { rawToken, expiresAt: refreshedExpiry });
    }
    return authSession;
  }

  renewBrowserCookie(authSession: AuthenticatedSession, response: unknown): void {
    const renewal = this.browserRenewals.get(authSession);
    if (renewal === undefined) return;
    this.browserRenewals.delete(authSession);
    if (!this.isCookieResponse(response)) return;
    const cookie = this.cookieOptions();
    response.cookie(
      SESSION_COOKIE_NAME,
      renewal.rawToken,
      {
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        path: cookie.path,
        expires: renewal.expiresAt
      }
    );
  }

  async revoke(sessionId: string): Promise<void> {
    const revoked = await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    if (revoked.count > 0) this.notifyInvalidation({ kind: 'session', sessionId });
  }

  onInvalidated(listener: SessionInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  notifyUserSessionsInvalidated(userId: string, exceptSessionId?: string): void {
    this.notifyInvalidation({ kind: 'user', userId, ...(exceptSessionId ? { exceptSessionId } : {}) });
  }

  private notifyInvalidation(invalidation: SessionInvalidation): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener(invalidation);
      } catch {
        // Database revocation remains authoritative even if a socket listener fails.
      }
    }
  }

  private isCookieResponse(response: unknown): response is CookieResponse {
    return typeof response === 'object' &&
      response !== null &&
      'cookie' in response &&
      typeof response.cookie === 'function';
  }
}
