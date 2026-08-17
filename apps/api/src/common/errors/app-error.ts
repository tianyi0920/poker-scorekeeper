import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES, type ErrorCode } from './error-codes.js';

export class AppError extends HttpException {
  readonly code: ErrorCode;

  constructor(status: HttpStatus, code: ErrorCode, message = ERROR_MESSAGES[code]) {
    super({ code, message }, status);
    this.code = code;
  }
}

export function badRequest(code: ErrorCode): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, code);
}

export function unauthorized(code: ErrorCode): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, code);
}

export function forbidden(code: ErrorCode): AppError {
  return new AppError(HttpStatus.FORBIDDEN, code);
}

export function tooManyRequests(code: ErrorCode): AppError {
  return new AppError(HttpStatus.TOO_MANY_REQUESTS, code);
}
