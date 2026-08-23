import { Module } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { static as serveStatic } from 'express';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const UPLOAD_PATH_PREFIX = '/avatars/uploads/';
const UPLOAD_FILENAME = /^[a-z0-9]{3,30}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;
const PRESET_AVATAR_PATH = /^\/avatars\/preset-(?:0[1-9]|1[0-9]|2[0-4])\.webp$/;
const MAX_SERVED_AVATAR_BYTES = 5 * 1024 * 1024;

function isReservedPath(path: string): boolean {
  if (/%(?![0-9a-fA-F]{2})/.test(path)) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  const normalized = decoded.toLowerCase();
  return normalized === '/api' || normalized.startsWith('/api/') ||
    normalized === '/socket.io' || normalized.startsWith('/socket.io/') ||
    normalized === '/avatars' || normalized.startsWith('/avatars/');
}

export interface AvatarFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
}

export type AvatarFileOpener = (path: string, flags: number) => Promise<AvatarFileHandle>;

export async function readControlledUploadedAvatar(
  avatarRoot: string,
  filename: string,
  opener: AvatarFileOpener = open as unknown as AvatarFileOpener
): Promise<Buffer | undefined> {
  if (!UPLOAD_FILENAME.test(filename)) return undefined;
  let handle: AvatarFileHandle | undefined;
  try {
    handle = await opener(
      join(avatarRoot, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SERVED_AVATAR_BYTES) {
      return undefined;
    }
    const contents = await handle.readFile();
    return contents.byteLength <= MAX_SERVED_AVATAR_BYTES ? contents : undefined;
  } finally {
    await handle?.close();
  }
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return accept === undefined || accept === '*/*' || accept.includes('text/html');
}

export class StaticAssetsMiddleware {
  private readonly webRoot: string;
  private readonly avatarRoot: string;
  private readonly webAssets: RequestHandler;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.webRoot = resolve(
      environment.WEB_DIST_ROOT ?? join(process.cwd(), 'apps', 'web', 'dist')
    );
    this.avatarRoot = resolve(
      environment.AVATAR_ROOT ?? join(process.cwd(), 'data', 'avatars')
    );
    this.webAssets = serveStatic(this.webRoot, {
      dotfiles: 'deny',
      fallthrough: true,
      index: false,
      immutable: true,
      maxAge: '1y',
      redirect: false,
      setHeaders: (response, filePath) => {
        const relativePath = relative(this.webRoot, filePath);
        if (relativePath !== 'assets' && !relativePath.startsWith(`assets${sep}`)) {
          response.setHeader('Cache-Control', 'no-cache');
        }
      }
    });
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    if (req.path.startsWith(UPLOAD_PATH_PREFIX)) {
      void this.serveUploadedAvatar(req, res, next);
      return;
    }

    if (isReservedPath(req.path) && !PRESET_AVATAR_PATH.test(req.path)) {
      next();
      return;
    }

    this.webAssets(req, res, () => {
      if (isReservedPath(req.path) || extname(req.path) !== '' || !wantsHtml(req)) {
        next();
        return;
      }
      void this.serveIndex(res, next);
    });
  }

  private async serveUploadedAvatar(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    let filename: string;
    try {
      filename = decodeURIComponent(req.path.slice(UPLOAD_PATH_PREFIX.length));
    } catch {
      next();
      return;
    }
    if (!UPLOAD_FILENAME.test(filename)) {
      next();
      return;
    }

    try {
      const contents = await readControlledUploadedAvatar(this.avatarRoot, filename);
      if (contents === undefined) {
        next();
        return;
      }
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(contents);
    } catch {
      next();
    }
  }

  private async serveIndex(res: Response, next: NextFunction): Promise<void> {
    try {
      const contents = await readFile(join(this.webRoot, 'index.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(contents);
    } catch {
      next();
    }
  }
}

export function createStaticAssetsHandler(
  environment: NodeJS.ProcessEnv = process.env
): RequestHandler {
  const middleware = new StaticAssetsMiddleware(environment);
  return middleware.use.bind(middleware);
}

@Module({})
export class StaticModule {}
