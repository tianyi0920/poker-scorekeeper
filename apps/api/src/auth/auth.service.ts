import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedSession, AuthUser } from '../common/auth/auth-user.js';
import { tooManyRequests, unauthorized } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { LoginAttemptLimiter } from './login-attempt-limiter.js';

const LOGIN_WINDOW_MILLISECONDS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_CAPACITY = 10_000;

interface LoginMetadata {
  ipAddress: string;
  userAgent: string;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
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

@Injectable()
export class AuthService {
  private readonly failures = new LoginAttemptLimiter({
    limit: LOGIN_FAILURE_LIMIT,
    ttlMilliseconds: LOGIN_WINDOW_MILLISECONDS,
    capacity: LOGIN_FAILURE_CAPACITY
  });
  private readonly dummyHash: Promise<string>;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService
  ) {
    this.dummyHash = this.passwords.hash(randomBytes(32).toString('hex'));
  }

  async login(
    username: string,
    password: string,
    metadata: LoginMetadata
  ): Promise<{ rawToken: string; authSession: AuthenticatedSession }> {
    const normalizedUsername = normalizeUsername(username);
    const throttleKey = `${metadata.ipAddress}:${normalizedUsername}`;
    if (!this.failures.isAllowed(throttleKey)) {
      throw tooManyRequests('TOO_MANY_REQUESTS');
    }

    const user = await this.prisma.user.findUnique({ where: { normalizedUsername } });
    const passwordMatches = await this.passwords.verify(
      user?.passwordHash ?? await this.dummyHash,
      password
    );
    if (
      user === null ||
      !passwordMatches ||
      !user.isActive ||
      user.deletedAt !== null
    ) {
      this.failures.recordFailure(throttleKey);
      throw unauthorized('INVALID_CREDENTIALS');
    }

    this.failures.reset(throttleKey);
    return this.sessions.create(toAuthUser(user), metadata.ipAddress, metadata.userAgent);
  }

  async changePassword(
    authSession: AuthenticatedSession,
    currentPassword: string,
    newPassword: string
  ): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: authSession.user.id } });
    if (
      user === null ||
      !user.isActive ||
      user.deletedAt !== null ||
      !await this.passwords.verify(user.passwordHash, currentPassword)
    ) {
      throw unauthorized('INVALID_CREDENTIALS');
    }

    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (transaction) => {
      const changedUser = await transaction.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false }
      });
      await transaction.authSession.updateMany({
        where: {
          userId: user.id,
          id: { not: authSession.id },
          revokedAt: null
        },
        data: { revokedAt: now }
      });
      return changedUser;
    });
    this.sessions.notifyUserSessionsInvalidated(user.id, authSession.id);
    return toAuthUser(updated);
  }

}
