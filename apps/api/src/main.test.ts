import { getListenOptions, getPort } from './main.js';

describe('HTTP listener defaults', () => {
  it('uses port 80 on an IPv4-compatible IPv6 socket when PORT is empty', () => {
    const originalPort = process.env.PORT;
    process.env.PORT = '';

    try {
      expect(getPort()).toBe(80);
      expect(getListenOptions()).toEqual({
        port: 80,
        host: '::'
      });
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  it('keeps an explicit non-production test port', () => {
    const originalPort = process.env.PORT;
    process.env.PORT = '3000';

    try {
      expect(getListenOptions()).toEqual({
        port: '3000',
        host: '::'
      });
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });
});
