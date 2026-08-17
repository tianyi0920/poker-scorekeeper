import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/auth/current-user.decorator.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import type { AuthUser, RequestWithAuth } from '../common/auth/auth-user.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE_NAME, SessionService } from './session.service.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024)
});

type LoginRequest = z.infer<typeof loginSchema>;
type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

interface CookieResponse {
  cookie(name: string, value: string, options: ReturnType<SessionService['cookieOptions']>): void;
  clearCookie(name: string, options: {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
  }): void;
}

function requestMetadata(request: RequestWithAuth): { ipAddress: string; userAgent: string } {
  const header = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? request.socket?.remoteAddress ?? '',
    userAgent: Array.isArray(header) ? (header[0] ?? '') : (header ?? '')
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService
  ) {}

  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginRequest,
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: CookieResponse
  ): Promise<{ user: AuthUser; csrfToken: string }> {
    const created = await this.auth.login(body.username, body.password, requestMetadata(request));
    response.cookie(SESSION_COOKIE_NAME, created.rawToken, this.sessions.cookieOptions());
    return {
      user: created.authSession.user,
      csrfToken: created.authSession.csrfToken
    };
  }

  @Get('session')
  @UseGuards(SessionGuard)
  session(
    @CurrentUser() user: AuthUser,
    @Req() request: RequestWithAuth
  ): { user: AuthUser; csrfToken: string } {
    return { user, csrfToken: request.authSession!.csrfToken };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async logout(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: CookieResponse
  ): Promise<{ success: true }> {
    await this.sessions.revoke(request.authSession!.id);
    const cookie = this.sessions.cookieOptions();
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      path: cookie.path
    });
    return { success: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordRequest,
    @Req() request: RequestWithAuth
  ): Promise<{ user: AuthUser; csrfToken: string }> {
    const user = await this.auth.changePassword(
      request.authSession!,
      body.currentPassword,
      body.newPassword
    );
    return { user, csrfToken: request.authSession!.csrfToken };
  }
}
