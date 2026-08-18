import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { redactAuditValue } from '../../audit/audit-redaction.js';
import type { RequestWithId } from '../security/application-security.js';
import { StructuredLogger } from '../security/structured-logger.js';
import { AppError } from './app-error.js';
import { ERROR_MESSAGES, type ErrorCode } from './error-codes.js';

interface JsonResponse {
  status(statusCode: number): JsonResponse;
  json(body: { code: string; message: string; requestId: string; details?: unknown }): void;
}

interface ErrorShape {
  code?: unknown;
  errno?: unknown;
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

interface MappedError {
  status: number;
  code: ErrorCode;
  details?: unknown;
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'RESOURCE_CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'REQUEST_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.URI_TOO_LONG]: 'URI_TOO_LONG',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS'
};

const DATABASE_UNAVAILABLE_CODES = new Set([
  'P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024'
]);
const DATABASE_BUSY_CODES = new Set([
  'P2028', 'P2034', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'
]);
const DATABASE_BUSY_NUMBERS = new Set([1_205, 1_213]);

function shapeOf(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? error as ErrorShape : {};
}

function controlledIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function appErrorDetails(exception: AppError): unknown {
  const body = exception.getResponse();
  if (typeof body !== 'object' || body === null || !('details' in body)) return undefined;
  return redactAuditValue((body as { details?: unknown }).details);
}

function mapException(exception: unknown): MappedError {
  if (exception instanceof AppError) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      details: appErrorDetails(exception)
    };
  }

  const shape = shapeOf(exception);
  if (shape.code === 'LIMIT_FILE_SIZE') {
    return { status: HttpStatus.PAYLOAD_TOO_LARGE, code: 'AVATAR_TOO_LARGE' };
  }
  if (shape.type === 'entity.parse.failed' || shape.type === 'request.size.invalid') {
    return { status: HttpStatus.BAD_REQUEST, code: 'VALIDATION_ERROR' };
  }
  if (shape.type === 'entity.too.large' || shape.type === 'parameters.too.many') {
    return { status: HttpStatus.PAYLOAD_TOO_LARGE, code: 'REQUEST_TOO_LARGE' };
  }
  if (
    shape.type === 'charset.unsupported' ||
    shape.type === 'encoding.unsupported' ||
    shape.type === 'media.unsupported'
  ) {
    return { status: HttpStatus.UNSUPPORTED_MEDIA_TYPE, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  if (shape.code === 'P2002') {
    return { status: HttpStatus.CONFLICT, code: 'RESOURCE_CONFLICT' };
  }
  if (
    DATABASE_BUSY_CODES.has(String(shape.code ?? '')) ||
    DATABASE_BUSY_NUMBERS.has(Number(shape.errno))
  ) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, code: 'DATABASE_BUSY' };
  }
  if (DATABASE_UNAVAILABLE_CODES.has(String(shape.code ?? ''))) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, code: 'DATABASE_UNAVAILABLE' };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, code: STATUS_CODES[status] ?? 'INTERNAL_ERROR' };
  }

  return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR' };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger = new StructuredLogger()) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<JsonResponse>();
    const request = http.getRequest<RequestWithId>();
    const mapped = mapException(exception);
    const requestId = request.requestId ?? randomUUID();
    const body: { code: ErrorCode; message: string; requestId: string; details?: unknown } = {
      code: mapped.code,
      message: ERROR_MESSAGES[mapped.code],
      requestId
    };
    if (mapped.details !== undefined) body.details = mapped.details;

    if (mapped.status >= HttpStatus.INTERNAL_SERVER_ERROR || mapped.code === 'RESOURCE_CONFLICT') {
      const shape = shapeOf(exception);
      this.logger.error({
        event: 'http.request.failed',
        requestId,
        method: request.method,
        path: request.path,
        sourceIp: request.ip,
        status: mapped.status,
        code: mapped.code,
        error: {
          name: controlledIdentifier(shape.name) ?? 'Error',
          code: controlledIdentifier(shape.code),
          errno: typeof shape.errno === 'number' ? shape.errno : undefined
        }
      });
    }
    response.status(mapped.status).json(body);
  }
}
