import {
  Injectable,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { payloadTooLarge } from '../common/errors/app-error.js';
import { MAX_AVATAR_BYTES } from './avatar.service.js';

const MulterAvatarInterceptor = FileInterceptor('file', {
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 }
});

@Injectable()
export class AvatarUploadInterceptor
  extends MulterAvatarInterceptor
  implements NestInterceptor {
  override async intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw payloadTooLarge('AVATAR_TOO_LARGE');
      }
      throw error;
    }
  }
}
