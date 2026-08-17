import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { SessionService } from '../../auth/session.service.js';
import { forbidden, unauthorized } from '../errors/app-error.js';
import type { RequestWithAuth } from './auth-user.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithAuth>();
    const authSession = request.authSession ??
      await this.sessions.authenticateCookie(request.headers.cookie);
    if (authSession === null) throw unauthorized('UNAUTHENTICATED');
    if (
      authSession.user.mustChangePassword &&
      !request.path.startsWith('/api/auth/')
    ) {
      throw forbidden('PASSWORD_CHANGE_REQUIRED');
    }
    request.authSession = authSession;
    request.user = authSession.user;
    if (request.path !== '/api/auth/logout') {
      this.sessions.renewBrowserCookie(authSession, http.getResponse<unknown>());
    }
    return true;
  }
}
