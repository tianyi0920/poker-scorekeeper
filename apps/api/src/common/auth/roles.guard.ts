import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../generated/prisma/client.js';
import { forbidden } from '../errors/app-error.js';
import type { RequestWithAuth } from './auth-user.js';
import { ROLES_KEY } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]) ?? [];
    const actor = context.switchToHttp().getRequest<RequestWithAuth>().user;
    if (allowed.length > 0 && (actor === undefined || !allowed.includes(actor.role))) {
      throw forbidden('FORBIDDEN');
    }
    return true;
  }
}
