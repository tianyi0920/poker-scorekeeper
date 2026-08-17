import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from '../common/auth/csrf.guard.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { SessionGuard } from '../common/auth/session.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BootstrapAdminService } from './bootstrap-admin.service.js';
import { CsrfService } from './csrf.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    BootstrapAdminService,
    CsrfService,
    PasswordService,
    SessionService,
    SessionGuard,
    CsrfGuard,
    RolesGuard,
    { provide: APP_GUARD, useExisting: CsrfGuard }
  ],
  exports: [SessionService, SessionGuard, CsrfGuard, RolesGuard]
})
export class AuthModule {}
