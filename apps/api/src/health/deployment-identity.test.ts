import { describe, expect, it } from 'vitest';
import {
  DeploymentIdentityController,
  readDeploymentId
} from './deployment-identity.controller.js';

describe('deployment identity endpoint', () => {
  it('returns the immutable deployment ID read from the image asset', () => {
    // Break caught: the public endpoint trusts a mutable environment variable instead of image content.
    const reads: string[] = [];
    const deploymentId = readDeploymentId('/app/deployment-id', (path) => {
      reads.push(String(path));
      return 'deploy-20260819-abc123\n';
    });

    expect(deploymentId).toBe('deploy-20260819-abc123');
    expect(reads).toEqual(['/app/deployment-id']);
    expect(new DeploymentIdentityController(() => deploymentId).deployment()).toEqual({
      deploymentId: 'deploy-20260819-abc123'
    });
  });

  it.each(['', 'short', 'contains whitespace', 'UPPERCASE-ID', 'a'.repeat(65)])(
    'rejects invalid image deployment identity %j',
    (value) => {
      expect(() => readDeploymentId('/app/deployment-id', () => value)).toThrow(
        'DEPLOYMENT_ID_INVALID'
      );
    }
  );
});
