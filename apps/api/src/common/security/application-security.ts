import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type { Application, NextFunction, Request, Response } from 'express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { ApiExceptionFilter } from '../errors/api-exception.filter.js';
import { AppError } from '../errors/app-error.js';
import { ERROR_MESSAGES } from '../errors/error-codes.js';
import { StructuredLogger } from './structured-logger.js';
import { createStaticAssetsHandler } from '../../static/static.module.js';

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_REQUEST_URI_BYTES = 2_048;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

export interface RequestWithId extends Request {
  requestId?: string;
}

export function trustProxySetting(environment: string | undefined): 1 | false {
  return environment === 'production' ? 1 : false;
}

function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === 'string' &&
    header.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(header)
    ? header
    : randomUUID();
}

function requestContext(req: RequestWithId, res: Response, next: NextFunction): void {
  const requestId = requestIdFrom(req.headers['x-request-id']);
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}

function requestTargetLimit(req: RequestWithId, _res: Response, next: NextFunction): void {
  if (Buffer.byteLength(req.originalUrl, 'utf8') <= MAX_REQUEST_URI_BYTES) {
    next();
    return;
  }
  next(new AppError(
    HttpStatus.URI_TOO_LONG,
    'URI_TOO_LONG',
    ERROR_MESSAGES.URI_TOO_LONG
  ));
}

function websocketCspSources(environment: NodeJS.ProcessEnv): string[] {
  const candidates = [
    environment.PUBLIC_ORIGIN,
    ...(environment.WS_ALLOWED_ORIGINS?.split(',') ?? [])
  ];
  const sources = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === '') continue;
    let url: URL;
    try {
      url = new URL(candidate.trim());
    } catch {
      throw new Error('Invalid public origin configuration');
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.origin === 'null'
    ) {
      throw new Error('Invalid public origin configuration');
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    sources.add(url.origin);
  }
  return [...sources];
}

function permissionsPolicy(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  next();
}

export function configureApplication(
  app: INestApplication,
  logger: StructuredLogger = new StructuredLogger()
): void {
  const environment = process.env.NODE_ENV;
  const connectSources = ["'self'", ...websocketCspSources(process.env)];
  const express = app.getHttpAdapter().getInstance() as Application;
  express.set('trust proxy', trustProxySetting(environment));
  express.disable('x-powered-by');

  app.use(requestContext);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: connectSources,
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: environment === 'production' ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: environment === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(permissionsPolicy);
  app.use(requestTargetLimit);
  app.use(json({ limit: '256kb', strict: true }));
  app.use(urlencoded({ limit: '64kb', extended: false, parameterLimit: 100 }));
  app.use(createStaticAssetsHandler());
  app.useGlobalFilters(new ApiExceptionFilter(logger));
}
