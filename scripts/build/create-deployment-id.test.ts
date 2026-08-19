import { describe, expect, it, vi } from 'vitest';
import { writeDeploymentId } from './create-deployment-id.mjs';

describe('container deployment identity asset', () => {
  it('writes a validated non-secret ID only to the fixed image path', async () => {
    // Break caught: a build argument can redirect the write or inject multiline image content.
    const writeFile = vi.fn(async () => undefined);

    await writeDeploymentId('deploy-20260819-abc123', writeFile);

    expect(writeFile).toHaveBeenCalledWith(
      '/app/deployment-id',
      'deploy-20260819-abc123\n',
      { encoding: 'utf8', mode: 0o444, flag: 'wx' }
    );
  });

  it.each(['short', 'bad value', 'UPPERCASE', 'x'.repeat(65)])(
    'rejects invalid build identity %j without writing',
    async (value) => {
      const writeFile = vi.fn(async () => undefined);
      await expect(writeDeploymentId(value, writeFile)).rejects.toThrow('DEPLOYMENT_ID_INVALID');
      expect(writeFile).not.toHaveBeenCalled();
    }
  );
});
