import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { CsrfService } from '../../auth/csrf.service.js';
import { SessionService } from '../../auth/session.service.js';
import { forbidden, unauthorized } from '../errors/app-error.js';
import type { RequestWithAuth } from './auth-user.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(CsrfService) private readonly csrf: CsrfService,
    @Inject(SessionService) private readonly sessions: SessionService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithAuth>();
    if (SAFE_METHODS.has(request.method.toUpperCase()) || request.path === '/api/auth/login') {
      return true;
    }

    const authSession = request.authSession ??
      await this.sessions.authenticateCookie(request.headers.cookie);
    if (authSession === null) throw unauthorized('UNAUTHENTICATED');
    request.authSession = authSession;
    request.user = authSession.user;

    const csrfHeader = request.headers['x-csrf-token'];
    const provided = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (!this.csrf.matches(provided, authSession.csrfToken)) {
      throw forbidden('CSRF_INVALID');
    }
    if (request.path !== '/api/auth/logout') {
      this.sessions.renewBrowserCookie(authSession, http.getResponse<unknown>());
    }
    return true;
  }
}
