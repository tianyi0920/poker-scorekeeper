import type { PrismaService } from '../prisma/prisma.service.js';
import type { CsrfService } from './csrf.service.js';
import { SessionService } from './session.service.js';

describe('session cookie transport security', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  const originalPublicOrigin = process.env.PUBLIC_ORIGIN;
  const service = new SessionService(
    {} as PrismaService,
    {} as CsrfService
  );

  afterEach(() => {
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;

    if (originalPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = originalPublicOrigin;
  });

  it('allows the browser to return the session cookie to an HTTP public origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_ORIGIN = 'http://pk.tianyi.wiki';

    expect(service.cookieOptions().secure).toBe(false);
  });

  it('keeps Secure cookies for an HTTPS public origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_ORIGIN = 'https://pk.tianyi.wiki';

    expect(service.cookieOptions().secure).toBe(true);
  });

  it('fails closed when production has no valid public origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_ORIGIN = 'not-a-url';

    expect(service.cookieOptions().secure).toBe(true);
  });
});
