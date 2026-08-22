import { getHealthcheckUrl } from '../../../scripts/docker/healthcheck-url.mjs';

describe('container healthcheck URL', () => {
  it('checks the default HTTP port 80 when PORT is absent', () => {
    expect(getHealthcheckUrl({})).toBe(
      'http://127.0.0.1:80/api/health/ready'
    );
  });

  it('uses an explicit test port without changing the production default', () => {
    expect(getHealthcheckUrl({ PORT: '3000' })).toBe(
      'http://127.0.0.1:3000/api/health/ready'
    );
  });
});
