import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser, RequestWithAuth } from './auth-user.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | undefined =>
    context.switchToHttp().getRequest<RequestWithAuth>().user
);
