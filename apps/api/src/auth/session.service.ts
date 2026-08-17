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

@Injectable()
export class SessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CsrfService) private readonly csrf: CsrfService
  ) {}

  cookieOptions(): SessionCookieOptions {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
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

  async authenticateCookie(cookieHeader: string | string[] | undefined): Promise<AuthenticatedSession | null> {
    const rawToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (rawToken === null || !/^[a-f0-9]{64}$/.test(rawToken)) return null;

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

    const user = toAuthUser(session.user);
    return {
      id: session.id,
      user,
      csrfToken: this.csrf.createToken(session.id, user.id)
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
}
